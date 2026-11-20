// The release checks (spec "Verification"), run in CI on Windows, macOS and Linux: the adapter
// as published, built from these sources into a bundle of its own and driven over stdio by
// the MCP SDK's client, with the reduced environment MCP clients give it, against a stand-in
// site on loopback (its catalog and an /agent page).
//
// - a missing Chrome is a clear refusal naming Chrome and where the adapter looked;
// - a cancelled render leaves the adapter able to render again: the lock released, nothing
//   left in staging (needs Chrome; in CI it never skips);
// - a version the site blocks refuses every tool but account and disconnect;
// - the file-system rules hold for the published bundle (test/folders.test.ts has them all).
//
// The built bundle carries package.json's version; run from its sources the adapter is "dev",
// which the kill switch lets through, so the blocked version is checked on the bundle.

import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { findChrome } from "../src/chrome/find.ts";
import { LOCK_NAME } from "../src/lock.ts";
import { assertBlocked, blocking, CATALOG, PLAN, REFUSED, withAdapters } from "./fixtures/killswitch.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };
const NOTICE = "Watermarked preview for evaluation only. Publishing it needs Motion Mockups Pro (https://motionmockups.com/pricing).";
const windows = process.platform === "win32";
const found = findChrome();
// A runner without Chrome fails the check rather than skipping it.
const withChrome = { skip: found.ok || process.env.CI ? false : "no Google Chrome on this machine", timeout: 180_000 };

let build = "";
let bundle = "";

before(() => {
  build = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mm-release-")));
  // An .mjs alone in its folder: a module whatever Node, resolving no package beside it.
  bundle = path.join(build, "motionmockups.mjs");
  execFileSync(process.execPath, ["scripts/build.mjs", bundle], { cwd: ROOT, stdio: "pipe" });
});

after(() => fs.rmSync(build, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

function temp(t: TestContext, prefix: string): string {
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  return folder;
}

/**
 * The page's agent: `render` hangs, reporting progress, until the page is told to cancel when
 * the name asked is "hang"; otherwise it hands back one small film.
 */
const AGENT_SCRIPT = `
  let stop;
  globalThis.motionMockupsAgent = {
    version: 1,
    async render(call) {
      if (call.baseName === "hang") {
        const report = () => globalThis.motionMockupsAgentProgress?.({ phase: "rendering", completed: 1, total: 10 });
        report();
        const timer = setInterval(report, 100);
        return new Promise((_, reject) => (stop = () => { clearInterval(timer); reject(new Error("cancelled")); }));
      }
      const blob = new Blob(["a film"]);
      return { ok: true, files: [{ name: call.baseName + ".mp4", bytes: blob.size, url: URL.createObjectURL(blob) }], warnings: [] };
    },
    async still(call) { return this.render(call); },
    cancel() { stop?.(); },
    release() {},
  };`;

/** A stand-in site on loopback: `catalog()` at /agent/catalog.json and the agent page at /agent. */
async function site(t: TestContext, catalog: () => unknown): Promise<string> {
  const server = http.createServer((req, res) => {
    if (req.url === "/agent/catalog.json") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(catalog()));
    } else if (req.url === "/agent") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(`<!doctype html><meta charset="utf-8"><title>agent</title><input id="agent-recording" type="file"><script>${AGENT_SCRIPT}</script>`);
    } else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

/** The built adapter on `origin`, as `motionmockups mcp <folders>`, with the client's reduced environment. */
async function adapter(t: TestContext, options: { origin: string; data: string; folders?: string[]; env?: Record<string, string> }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle, "mcp", ...(options.folders ?? [])],
    cwd: build,
    env: { ...getDefaultEnvironment(), MOTIONMOCKUPS_ORIGIN: options.origin, MOTIONMOCKUPS_DATA: options.data, ...options.env },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "release", version: "1" });
  await client.connect(transport);
  t.after(() => client.close().catch(() => {}));
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { client, call, stderr: () => stderr.join("") };
}

const structured = (result: any) => result.structuredContent as any;

/** Resolves once `check()` holds, polled for up to `ms`. */
async function eventually(check: () => boolean, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) assert.fail(`${what} within ${ms / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const staged = (data: string) => {
  try {
    return fs.readdirSync(path.join(data, "staging"));
  } catch {
    return [];
  }
};

test("the bundle under test is the published build, at package.json's version", async (t) => {
  const { client } = await adapter(t, { origin: await site(t, () => CATALOG), data: temp(t, "mm-release-data-") });
  assert.equal(client.getServerVersion()?.version, pkg.version);
  assert.notEqual(pkg.version, "dev");
});

test("release: a missing Chrome is a clear refusal naming Chrome and where it looked; nothing starts, and the adapter keeps answering", async (t) => {
  const project = temp(t, "mm-release-project-");
  const data = temp(t, "mm-release-data-");
  const nowhere = path.join(temp(t, "mm-release-nochrome-"), "Google Chrome", windows ? "chrome.exe" : "chrome");
  const { call } = await adapter(t, { origin: await site(t, () => CATALOG), data, folders: [project], env: { MOTIONMOCKUPS_CHROME: nowhere } });
  for (const [name, args] of [
    ["render", { plan: PLAN }],
    ["still", { plan: PLAN, seconds: 1, format: "png" }],
  ] as const) {
    const result = await call(name, args);
    assert.equal(result.isError, true, name);
    const [problem, ...rest] = structured(result).problems;
    assert.equal(rest.length, 0, name);
    assert.equal(problem.code, "chrome", name);
    assert.ok(problem.message.includes(nowhere), `${name}: the place it looked, in: ${problem.message}`);
    assert.match(problem.message, /MOTIONMOCKUPS_CHROME/);
    assert.match(problem.fix, /Install Google Chrome from https:\/\/www\.google\.com\/chrome\//);
  }
  assert.equal(fs.existsSync(path.join(data, LOCK_NAME)), false, "no lock taken");
  assert.equal(fs.existsSync(path.join(data, "chrome-profile")), false, "no Chrome started");
  assert.notEqual((await call("list_scenes")).isError, true, "the adapter keeps answering");
});

test("release: a version the site blocks refuses every tool but account and disconnect, and never starts Chrome", async (t) => {
  const project = temp(t, "mm-release-project-");
  const data = temp(t, "mm-release-data-");
  const block = blocking(pkg.version);
  const { call, stderr } = await adapter(t, { origin: await site(t, () => withAdapters(block)), data, folders: [project] });
  for (const [name, args] of REFUSED) assertBlocked(await call(name, args), `${name} ${JSON.stringify(args)}`, block.message);
  const account = await call("account");
  assert.notEqual(account.isError, true);
  assert.equal(structured(account).tier, "free");
  assert.notEqual((await call("connect_account", { disconnect: true })).isError, true);
  assert.equal(fs.existsSync(path.join(data, "chrome-profile")), false, "no Chrome started");
  assert.equal(fs.existsSync(path.join(project, "motion-mockups")), false, "nothing written in the project");
  // Said once on stderr, however many calls were refused.
  await eventually(() => /is blocked by the site/.test(stderr()), 5_000, "the stderr line");
  assert.equal(stderr().match(/is blocked by the site/g)!.length, 1, stderr());
});

test("release: the file-system rules hold for the bundle: a recording outside the allowed folders is refused, nothing is written", async (t) => {
  const project = temp(t, "mm-release-project-");
  const outside = temp(t, "mm-release-outside-");
  const data = temp(t, "mm-release-data-");
  // A real MP4 start, outside the project.
  const secret = path.join(outside, "secret.mp4");
  fs.writeFileSync(secret, Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"));
  const { call } = await adapter(t, { origin: await site(t, () => CATALOG), data, folders: [project] });
  for (const recording of [secret, path.relative(project, secret)]) {
    const result = await call("render", { plan: PLAN, recording, name: "leak" });
    assert.equal(result.isError, true, recording);
    assert.equal(structured(result).problems[0].code, "folder", `${recording}: ${JSON.stringify(structured(result))}`);
  }
  // No folder allowed at all: no project folder to write in.
  const none = await adapter(t, { origin: await site(t, () => CATALOG), data: temp(t, "mm-release-data-") });
  assert.equal(structured(await none.call("render", { plan: PLAN })).problems[0].code, "no-folder");
  assert.deepEqual(fs.readdirSync(outside), ["secret.mp4"], "nothing written outside");
  assert.equal(fs.existsSync(path.join(data, LOCK_NAME)), false, "no lock taken");
});

test("release: a cancelled render leaves the adapter able to render again: the lock released, nothing left in staging", withChrome, async (t) => {
  const project = temp(t, "mm-release-project-");
  const data = temp(t, "mm-release-data-");
  const { client, call } = await adapter(t, { origin: await site(t, () => CATALOG), data, folders: [project] });

  // The page is rendering (its own progress reached the client): the client cancels.
  const controller = new AbortController();
  const progress: string[] = [];
  const cancelled = client.callTool({ name: "render", arguments: { plan: PLAN, name: "hang" } }, undefined, {
    signal: controller.signal,
    timeout: 120_000,
    onprogress: (p) => {
      progress.push(p.message ?? "");
      if (p.message?.startsWith("rendering")) controller.abort("the person cancelled");
    },
  });
  await assert.rejects(cancelled, (error: Error) => /cancelled/.test(String(error?.message ?? error)) || error?.name === "AbortError");
  assert.ok(progress.some((m) => m.startsWith("rendering")), `the page was rendering: ${JSON.stringify(progress)}`);

  // The adapter closes Chrome, removes what it staged and releases the lock.
  await eventually(() => !fs.existsSync(path.join(data, LOCK_NAME)), 60_000, "the render lock released");
  assert.deepEqual(staged(data), [], "nothing left in staging");
  assert.deepEqual(fs.readdirSync(path.join(project, "motion-mockups")).filter((f) => !f.startsWith(".")), [], "no file delivered");

  // And the next render goes through.
  const again = await call("render", { plan: PLAN, name: "again" });
  assert.notEqual(again.isError, true, JSON.stringify(structured(again)));
  const { files, notice } = structured(again);
  assert.equal(notice, NOTICE);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, path.join(project, "motion-mockups", "again.mp4"));
  assert.equal(fs.readFileSync(files[0].path, "utf8"), "a film");
  assert.equal(fs.existsSync(path.join(data, LOCK_NAME)), false, "the lock released after it too");
  assert.deepEqual(staged(data), [], "nothing left in staging after it");
});
