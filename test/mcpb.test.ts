// The Claude Desktop extension (scripts/mcpb.mjs): built from the same bundle npm publishes,
// it carries the manifest and that bundle only, at package.json's version, with the person's
// folders and the origin passed as the adapter reads them, and nothing personal. The built
// bundle itself also leaves cleanly when its client closes stdin.

import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync, spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const repo = new URL("..", import.meta.url);
const at = (file: string) => new URL(file, repo);
const pkg = JSON.parse(fs.readFileSync(at("package.json"), "utf8"));
const BUNDLE = "dist/motionmockups.js";
// In the extension the bundle is an .mjs, so Node runs it as a module with no package.json
// beside it (Node before 20.19 and 22.7 never detects that a .js is one).
const ENTRY = "motionmockups.mjs";

let folder: string;
let mcpb: string;
let entries: Map<string, Buffer>;
let manifest: any;

/** The entries of a zip, in central-directory order, inflated. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "end of central directory");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const packedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const packed = zip.subarray(dataAt, dataAt + packedSize);
    out.set(name, method === 8 ? inflateRawSync(packed) : Buffer.from(packed));
    assert.equal(out.get(name)!.length, size, name);
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

before(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "mm-mcpb-"));
  mcpb = path.join(folder, "motionmockups.mcpb");
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: repo, stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/mcpb.mjs", mcpb], { cwd: repo, stdio: "pipe" });
  entries = unzip(fs.readFileSync(mcpb));
  manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
});

after(() => fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

test("mcpb: exactly the manifest and the bundle, the bundle byte-equal to dist", () => {
  assert.deepEqual([...entries.keys()], ["manifest.json", ENTRY]);
  assert.ok(entries.get(ENTRY)!.equals(fs.readFileSync(at(BUNDLE))));
});

test("mcpb: the manifest's version is package.json's, and it runs the bundle it carries with node", () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.manifest_version, "0.3");
  assert.equal(manifest.name, "motionmockups");
  assert.equal(manifest.display_name, "Motion Mockups");
  assert.deepEqual(manifest.author, { name: "Motion Mockups" });
  assert.equal(manifest.homepage, "https://motionmockups.com");
  assert.equal(manifest.repository.url, "https://github.com/krysjezek/motionmockups-mcp");
  assert.ok(manifest.description);
  assert.equal(manifest.server.type, "node");
  assert.equal(manifest.server.entry_point, ENTRY);
  assert.equal(manifest.server.mcp_config.command, "node");
  assert.deepEqual(manifest.server.mcp_config.args.slice(0, 2), [`\${__dirname}/${ENTRY}`, "mcp"]);
  assert.deepEqual(manifest.compatibility, { platforms: ["darwin", "win32", "linux"], runtimes: { node: pkg.engines.node } });
  assert.deepEqual(
    manifest.tools.map((t: { name: string }) => t.name),
    ["list_scenes", "recording_spec", "suggest_sequence", "check_plan", "render", "still", "account", "connect_account"],
  );
  for (const tool of manifest.tools) assert.ok(tool.description.length > 20, tool.name);
});

/**
 * What the desktop host makes of mcp_config (@anthropic-ai/mcpb, src/shared/config.ts): a
 * user_config list fills arguments, one per value; strings are replaced in place; a default
 * stands in for a value the person left out.
 */
function hosted(values: Record<string, string | string[]>) {
  const vars: Record<string, string | string[]> = { __dirname: "/ext" };
  for (const [key, option] of Object.entries<any>(manifest.user_config)) {
    const value = values[key] ?? option.default;
    if (value !== undefined) vars[`user_config.${key}`] = value;
  }
  const replace = (s: string) => s.replace(/\$\{([^}]+)\}/g, (all, k) => (typeof vars[k] === "string" ? (vars[k] as string) : all));
  const args = (manifest.server.mcp_config.args as string[]).flatMap((a) => {
    const whole = /^\$\{(user_config\.[^}]+)\}$/.exec(a);
    return whole && Array.isArray(vars[whole[1]!]) ? (vars[whole[1]!] as string[]) : [replace(a)];
  });
  const env = Object.fromEntries(Object.entries<string>(manifest.server.mcp_config.env).map(([k, v]) => [k, replace(v)]));
  return { args, env };
}

test("mcpb: the allowed folders reach the adapter as arguments after mcp, one each, and the origin MOTIONMOCKUPS_ORIGIN", () => {
  const { allowed_folders: folders, origin } = manifest.user_config;
  assert.equal(folders.type, "directory");
  assert.equal(folders.multiple, true);
  assert.equal(folders.required, true);
  assert.equal(origin.type, "string");
  assert.equal(origin.required, false);
  assert.equal(origin.default, "");

  const a = path.resolve("/a b"), b = path.resolve("/c");
  const run = hosted({ allowed_folders: [a, b], origin: "http://localhost:4173" });
  // src/cli.ts allows each argument after `mcp` as one folder, never split, besides
  // MOTIONMOCKUPS_FOLDERS (test/server.test.ts, test/folders.test.ts).
  assert.deepEqual(run.args, [`/ext/${ENTRY}`, "mcp", a, b]);
  assert.deepEqual(run.env, { MOTIONMOCKUPS_ORIGIN: "http://localhost:4173" });
  // Left empty, the origin is "", which the adapter reads as the public site.
  assert.deepEqual(hosted({ allowed_folders: [a] }).env, { MOTIONMOCKUPS_ORIGIN: "" });
});

test("mcpb: no personal path, name or e-mail address in the manifest or the bundle", () => {
  for (const [name, data] of entries) {
    // The public identifiers the adapter needs: its repository and the site's Vercel team scope
    // (src/origin.ts).
    const text = data.toString("utf8").replaceAll("krysjezek/motionmockups-mcp", "").replaceAll("krystofjezeks-projects", "");
    assert.doesNotMatch(text, /[a-z]:[\\/]+users[\\/]+/i, name);
    assert.doesNotMatch(text, /\/(?:Users|home)\/[a-z0-9._-]+\//i, name);
    assert.doesNotMatch(text, /kry[sš]tof|je[zž]ek|\bkryst\b/i, name);
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, name);
  }
});

test("mcpb: the format's own tools, the locked devDependency, unpack it and pass its manifest", () => {
  // Exactly the version package-lock.json pins with its integrity hash, installed by npm ci
  // (it needs no install script), never fetched on the fly.
  assert.equal(pkg.devDependencies["@anthropic-ai/mcpb"], "2.1.2");
  const locked = JSON.parse(fs.readFileSync(at("package-lock.json"), "utf8")).packages["node_modules/@anthropic-ai/mcpb"];
  assert.equal(locked.version, "2.1.2");
  assert.match(locked.integrity, /^sha512-/);
  assert.ok(!locked.hasInstallScript);
  const out = path.join(folder, "unpacked");
  const bin = fileURLToPath(at(`node_modules/.bin/${process.platform === "win32" ? "mcpb.cmd" : "mcpb"}`));
  const mcpbCli = `"${bin}"`;
  execSync(`${mcpbCli} unpack "${mcpb}" "${out}"`, { stdio: "pipe", timeout: 180_000 });
  assert.deepEqual(fs.readdirSync(out, { recursive: true }).map((p) => String(p).replaceAll("\\", "/")).sort(), [ENTRY, "manifest.json"].sort());
  const result = execSync(`${mcpbCli} validate "${path.join(out, "manifest.json")}"`, { stdio: "pipe", timeout: 180_000 }).toString();
  assert.match(result, /passes/);
});

test("mcpb: the unpacked bundle runs as a module with no package.json beside it", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mm-mcpb-run-"));
  try {
    for (const [name, data] of entries) fs.writeFileSync(path.join(out, name), data);
    // As Node 20.0-20.18 and 22.0-22.6 load it: no detection of ES module syntax in a .js.
    const version = execFileSync(process.execPath, ["--no-experimental-detect-module", path.join(out, ENTRY), "--version"], { cwd: out, stdio: "pipe" });
    assert.equal(version.toString().trim(), pkg.version);
  } finally {
    fs.rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("bundle: the server leaves with code 0 when its client closes stdin, after reading the site (skips offline)", async (t: TestContext) => {
  try {
    await lookup("motionmockups.com");
  } catch {
    t.skip("motionmockups.com cannot be reached");
    return;
  }
  // The public site, as installed. On Windows, process.exit() right after the catalog fetch
  // aborted Node ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", src\win\async.c)
  // while V8 was still compiling undici's WebAssembly HTTP parser in the background.
  const env: NodeJS.ProcessEnv = { ...process.env, MOTIONMOCKUPS_DATA: path.join(folder, "data") };
  delete env.MOTIONMOCKUPS_ORIGIN;
  for (let i = 0; i < 3; i++) {
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [fileURLToPath(at(BUNDLE)), "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.stdout.resume();
      child.stdin.end();
      child.on("exit", (code) => resolve({ code, stderr }));
    });
    assert.doesNotMatch(stderr, /Assertion failed/);
    assert.equal(code, 0, stderr);
  }
});
