import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("package: publishing builds and smoke-tests first; the repository is named; a semver version, the manifest's; a licence, with its file once chosen", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.prepublishOnly, "npm run build && node scripts/smoke.mjs");
  assert.deepEqual(pkg.repository, { type: "git", url: "git+https://github.com/krysjezek/motionmockups-mcp.git" });
  // semver.org's own pattern: MAJOR.MINOR.PATCH, an optional prerelease and build metadata.
  assert.match(
    pkg.version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
  );
  assert.equal(pkg.version, pkg.version.trim());
  // The lockfile's root and the Claude Desktop extension's manifest (scripts/mcpb.mjs, which
  // test/mcpb.test.ts builds) carry the same version.
  assert.equal(JSON.parse(read("package-lock.json")).version, pkg.version);
  const mcpbScript = read("scripts/mcpb.mjs");
  assert.match(mcpbScript, /version: pkg\.version/);
  assert.equal(typeof pkg.license, "string");
  assert.ok(pkg.license.trim().length > 0, "a licence");
  // Any licence but UNLICENSED ships its text: npm packs a LICENSE file whatever "files" says.
  if (pkg.license !== "UNLICENSED")
    assert.ok(fs.existsSync(new URL("../LICENSE", import.meta.url)), "LICENSE for " + pkg.license);
});

test(".gitignore keeps secrets out: .env*, .npmrc, *.pem, *.key", () => {
  const lines = read(".gitignore").split(/\r?\n/).map((l) => l.trim());
  for (const pattern of [".env*", ".npmrc", "*.pem", "*.key"]) assert.ok(lines.includes(pattern), pattern);
});

test("release.yml: a v* tag on the canonical repository only, no npm token, every action pinned by SHA", () => {
  const workflow = (file: string) => read(file).replaceAll("\r\n", "\n");
  const release = workflow(".github/workflows/release.yml");
  const on = /^on:\n([\s\S]*?)\n(?=\S)/m.exec(release)?.[1];
  assert.equal(on?.trim(), 'push:\n    tags: ["v*"]');
  for (const trigger of ["pull_request", "pull_request_target", "workflow_dispatch", "workflow_run", "workflow_call", "schedule"])
    assert.ok(!release.includes(trigger), trigger);
  const jobs = Object.fromEntries(
    release
      .slice(release.indexOf("\njobs:\n"))
      .split(/^ {2}(?=\w[\w-]*:\n)/m)
      .slice(1)
      .map((job) => [job.slice(0, job.indexOf(":")), job]),
  );
  assert.deepEqual(Object.keys(jobs), ["build", "attest", "publish", "release"]);
  for (const job of Object.values(jobs)) assert.match(job, /^ {4}if: github\.repository == 'krysjezek\/motionmockups-mcp'$/m);
  assert.doesNotMatch(release, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);

  // build runs the project and its dependencies, with no OIDC token and no write access, and
  // only from a commit on main.
  assert.match(jobs.build, /permissions:\n {6}contents: read\n {4}steps:/);
  assert.match(jobs.build, /fetch-depth: 0/);
  assert.match(jobs.build, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
  assert.match(jobs.build, /- run: npm ci --ignore-scripts\n/);
  // The tarball and the .mcpb are packed and uploaded before any third-party tool runs: the
  // tests (which run the mcpb CLI) and the extension check come after the upload.
  const at = (pattern: RegExp) => {
    const i = jobs.build.search(pattern);
    assert.ok(i >= 0, String(pattern));
    return i;
  };
  const upload = at(/uses: actions\/upload-artifact@/);
  assert.ok(at(/- run: npm pack\n/) < upload);
  assert.ok(at(/- run: node scripts\/mcpb\.mjs\n/) < upload);
  assert.ok(at(/- run: xvfb-run -a npm test\n/) > upload);
  assert.ok(at(/node_modules\/\.bin\/mcpb unpack /) > upload);
  assert.ok(at(/node_modules\/\.bin\/mcpb validate /) > upload);
  assert.equal(jobs.build.slice(0, upload).match(/mcpb (unpack|validate)|npm test/), null);
  // attest signs the .mcpb it downloads: the OIDC token and the attestation store, no write
  // access to the repository, no checkout and no project code.
  assert.match(jobs.attest, /needs: build\n/);
  assert.match(jobs.attest, /permissions:\n {6}contents: read\n {6}id-token: write\n {6}attestations: write\n {4}steps:/);
  assert.doesNotMatch(jobs.attest, /actions\/checkout|npm |npx|scripts\/|node /);
  assert.match(jobs.attest, /uses: actions\/attest-build-provenance@[0-9a-f]{40} # v\d+\.\d+\.\d+\n {8}with:\n {10}subject-path: motionmockups\.mcpb\n/);
  // publish holds the OIDC token and runs no project code: no checkout, no install, no script.
  assert.match(jobs.publish, /needs: build\n/);
  assert.match(jobs.publish, /permissions:\n {6}contents: read\n {6}id-token: write\n {4}steps:/);
  assert.doesNotMatch(jobs.publish, /actions\/checkout|npm ci|npm install|npm test|npm run|npx|scripts\/|attestations/);
  assert.match(jobs.publish, /npm publish "motionmockups-\$VERSION\.tgz" --provenance --access public --ignore-scripts \$tag\n/);
  assert.match(jobs.publish, /older than 11\.5\.1/);
  // release can write, only to attach the .mcpb, once it is attested; no OIDC token.
  assert.match(jobs.release, /needs: \[publish, attest\]\n/);
  assert.match(jobs.release, /permissions:\n {6}contents: write\n {4}steps:/);
  assert.doesNotMatch(jobs.release, /id-token|attestations|actions\/checkout|npm /);

  for (const file of [".github/workflows/release.yml", ".github/workflows/ci.yml"]) {
    const text = workflow(file);
    // Installs exactly what package-lock.json pins, with no install script, and runs no
    // package fetched on the fly: the mcpb CLI is the locked devDependency in node_modules.
    const installs = [...text.matchAll(/- run: (npm (?:ci|install)\b.*)\n/g)].map((m) => m[1]);
    assert.ok(installs.length > 0, file);
    for (const install of installs) assert.equal(install, "npm ci --ignore-scripts", file);
    assert.doesNotMatch(text, /npx |@anthropic-ai\/mcpb@/, file);
    for (const use of text.matchAll(/(\S*)mcpb (unpack|validate) /g)) assert.equal(use[1], "node_modules/.bin/", file);
    const uses = [...text.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
    assert.ok(uses.length > 0, file);
    for (const action of uses) assert.match(action, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/, `${file}: ${action}`);
  }
});

test("release.yml: a prerelease is published under the dist-tag next, never latest", (t) => {
  const release = read(".github/workflows/release.yml").replaceAll("\r\n", "\n");
  const step = /- name: Publish[^\n]*\n[\s\S]*?run: \|\n([\s\S]*?)\n(?! {10})/.exec(release)?.[1];
  assert.ok(step, "the publish step");
  const script = step!.replace(/^ {10}/gm, "");
  // The step's own lines up to the publish, then the dist-tag it chose.
  const choose = script.slice(0, script.indexOf("npm publish")) + 'printf %s "$tag"';
  const bash = spawnSync("bash", ["-c", choose], { env: { ...process.env, VERSION: "v0.0.0" }, encoding: "utf8" });
  if (bash.error) return t.skip("no bash here");
  const tagFor = (version: string) => spawnSync("bash", ["-c", choose], { env: { ...process.env, VERSION: version }, encoding: "utf8" }).stdout;
  assert.equal(tagFor("v0.1.0"), "");
  assert.equal(tagFor("v1.2.3"), "");
  assert.equal(tagFor("v1.0.0-beta.1"), "--tag next");
  assert.equal(tagFor("v0.2.0-rc.0"), "--tag next");
});
