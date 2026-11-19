import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { clearToken, isAgentToken, readToken, redact, TOKEN_FILE, writeToken } from "../src/token.ts";

const windows = process.platform === "win32";
const ORIGIN = new URL("http://127.0.0.1:4173");
const OTHER = new URL("https://motionmockups.com");
const TOKEN = `mma_${"A".repeat(20)}_-${"b".repeat(21)}`;

function temp(t: TestContext, prefix: string): string {
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

test("a token is mma_ and 43 base64url characters", () => {
  assert.equal(isAgentToken(TOKEN), true);
  assert.equal(isAgentToken(`${TOKEN}x`), false);
  assert.equal(isAgentToken(TOKEN.slice(0, -1)), false);
  assert.equal(isAgentToken(`mmx_${TOKEN.slice(4)}`), false);
  assert.equal(isAgentToken(`${TOKEN.slice(0, -1)}=`), false);
  assert.equal(isAgentToken(undefined), false);
});

test("no file: no token", async (t) => {
  const data = temp(t, "mm-token-");
  assert.deepEqual(await readToken(data, ORIGIN), { ok: true, value: null });
  // A data folder that is not there yet is no token either.
  assert.deepEqual(await readToken(path.join(data, "not-yet"), ORIGIN), { ok: true, value: null });
});

test("a written token is read back for its own origin, from <data>/agent-token", async (t) => {
  const data = path.join(temp(t, "mm-token-"), "data");
  await writeToken(data, ORIGIN, TOKEN);
  assert.equal(TOKEN_FILE, "agent-token");
  assert.ok(fs.statSync(path.join(data, TOKEN_FILE)).isFile());
  assert.deepEqual(await readToken(data, ORIGIN), { ok: true, value: TOKEN });
  // Nothing else is left in the folder: the temporary file was renamed into place.
  assert.deepEqual(fs.readdirSync(data), [TOKEN_FILE]);
});

test("a second write replaces the first whole", async (t) => {
  const data = temp(t, "mm-token-");
  await writeToken(data, ORIGIN, TOKEN);
  const next = `mma_${"z".repeat(43)}`;
  await writeToken(data, ORIGIN, next);
  assert.deepEqual(await readToken(data, ORIGIN), { ok: true, value: next });
  assert.deepEqual(fs.readdirSync(data), [TOKEN_FILE]);
});

test("a token saved for another origin is never handed out for this one", async (t) => {
  const data = temp(t, "mm-token-");
  await writeToken(data, OTHER, TOKEN);
  const read = await readToken(data, ORIGIN);
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.equal(read.problems[0]!.code, "sign-in");
  assert.match(read.problems[0]!.message, /https:\/\/motionmockups\.com/);
  assert.match(read.problems[0]!.message, /127\.0\.0\.1:4173/);
  assert.match(read.problems[0]!.fix, /connect_account/);
  assert.ok(!JSON.stringify(read).includes(TOKEN));
  // The file is kept: switching MOTIONMOCKUPS_ORIGIN back finds it again.
  assert.deepEqual(await readToken(data, OTHER), { ok: true, value: TOKEN });
});

test("a malformed token file is refused with how to reconnect, and never quoted", async (t) => {
  const data = temp(t, "mm-token-");
  const file = path.join(data, TOKEN_FILE);
  const cases = [
    TOKEN, // the bare token, no origin
    "{",
    "[]",
    JSON.stringify({ origin: ORIGIN.origin }),
    JSON.stringify({ origin: ORIGIN.origin, token: `${TOKEN}x` }),
    JSON.stringify({ origin: "not a url", token: TOKEN }),
    JSON.stringify({ origin: `${ORIGIN.origin}/path`, token: TOKEN }),
    JSON.stringify({ origin: ORIGIN.origin, token: TOKEN, extra: 1 }),
    "x".repeat(5000),
  ];
  for (const content of cases) {
    fs.writeFileSync(file, content);
    const read = await readToken(data, ORIGIN);
    assert.equal(read.ok, false, content.slice(0, 80));
    if (read.ok) continue;
    assert.equal(read.problems[0]!.code, "sign-in");
    assert.match(read.problems[0]!.message, /agent-token/);
    assert.match(read.problems[0]!.fix, /connect_account/);
    assert.ok(!JSON.stringify(read).includes(TOKEN), "the token is not quoted");
    assert.ok(!JSON.stringify(read).includes("xxxxxxxxxx"), "the content is not quoted");
  }
});

test("a link at the token path is refused, for reading and for writing", async (t) => {
  const data = temp(t, "mm-token-");
  const elsewhere = path.join(temp(t, "mm-token-elsewhere-"), "target");
  fs.writeFileSync(elsewhere, JSON.stringify({ origin: ORIGIN.origin, token: TOKEN }));
  try {
    fs.symlinkSync(elsewhere, path.join(data, TOKEN_FILE), "file");
  } catch {
    t.skip("this account cannot make symlinks (Windows without Developer Mode)");
    return;
  }
  const read = await readToken(data, ORIGIN);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.problems[0]!.code, "sign-in");
  await assert.rejects(writeToken(data, ORIGIN, `mma_${"q".repeat(43)}`), (error: any) => error?.code === "sign-in");
  // The link's target is untouched.
  assert.equal(JSON.parse(fs.readFileSync(elsewhere, "utf8")).token, TOKEN);
});

test("a folder at the token path is refused for writing (any platform)", async (t) => {
  const data = temp(t, "mm-token-");
  fs.mkdirSync(path.join(data, TOKEN_FILE));
  await assert.rejects(writeToken(data, ORIGIN, TOKEN), (error: any) => error?.code === "sign-in");
  const read = await readToken(data, ORIGIN);
  assert.equal(read.ok, false);
  // No temporary file is left behind.
  assert.deepEqual(fs.readdirSync(data), [TOKEN_FILE]);
});

test("the token file is mode 0o600 in a 0o700 folder", { skip: windows ? "file modes are POSIX" : false }, async (t) => {
  const data = path.join(temp(t, "mm-token-"), "data");
  const old = process.umask(0);
  try {
    await writeToken(data, ORIGIN, TOKEN);
  } finally {
    process.umask(old);
  }
  assert.equal(fs.statSync(path.join(data, TOKEN_FILE)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(data).mode & 0o777, 0o700);
});

test("clearToken removes the file and is fine when there is none", async (t) => {
  const data = temp(t, "mm-token-");
  assert.equal(await clearToken(data), false);
  await writeToken(data, ORIGIN, TOKEN);
  assert.equal(await clearToken(data), true);
  assert.deepEqual(await readToken(data, ORIGIN), { ok: true, value: null });
});

test("clearToken with an expected token deletes only that token, never one saved since", async (t) => {
  const data = temp(t, "mm-token-");
  const next = `mma_${"n".repeat(43)}`;
  await writeToken(data, ORIGIN, next);
  // The refused token was replaced by a new connection: the new one stays.
  assert.equal(await clearToken(data, TOKEN), false);
  assert.deepEqual(await readToken(data, ORIGIN), { ok: true, value: next });
  assert.equal(await clearToken(data, next), true);
  assert.deepEqual(await readToken(data, ORIGIN), { ok: true, value: null });
  // A damaged file is not the expected token either.
  fs.writeFileSync(path.join(data, TOKEN_FILE), "{ damaged");
  assert.equal(await clearToken(data, TOKEN), false);
  assert.ok(fs.existsSync(path.join(data, TOKEN_FILE)));
});

test("redact replaces every agent token in a text", () => {
  assert.equal(redact(`a ${TOKEN} b ${TOKEN}`), "a [agent token] b [agent token]");
  assert.equal(redact("nothing here"), "nothing here");
});
