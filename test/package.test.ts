import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("package: publishing builds and smoke-tests first; the repository is named; licence and version unchanged", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.prepublishOnly, "npm run build && node scripts/smoke.mjs");
  assert.deepEqual(pkg.repository, { type: "git", url: "git+https://github.com/krysjezek/motionmockups-mcp.git" });
  assert.equal(pkg.license, "UNLICENSED");
  assert.equal(pkg.version, "0.1.0");
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
  const jobs = release.slice(release.indexOf("\njobs:\n")).split(/^ {2}(?=\w[\w-]*:\n)/m).slice(1);
  assert.equal(jobs.length, 2);
  for (const job of jobs) assert.match(job, /^ {4}if: github\.repository == 'krysjezek\/motionmockups-mcp'$/m);
  assert.doesNotMatch(release, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
  assert.match(release, /^ {6}- run: npm publish --provenance --access public$/m);
  // The job that holds the OIDC token cannot write to the repository, and the one that can
  // write mints no OIDC token.
  assert.match(jobs[0]!, /permissions:\n {6}contents: read\n {6}id-token: write\n/);
  assert.match(jobs[1]!, /permissions:\n {6}contents: write\n {4}steps:/);
  for (const file of [".github/workflows/release.yml", ".github/workflows/ci.yml"]) {
    const uses = [...workflow(file).matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
    assert.ok(uses.length > 0, file);
    for (const action of uses) assert.match(action, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/, `${file}: ${action}`);
  }
});
