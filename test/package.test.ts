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
