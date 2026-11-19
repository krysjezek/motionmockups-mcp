import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { connectFlows, currentAccount, openInBrowser, startConnect, type Launcher } from "../src/connect.ts";
import { readToken, TOKEN_FILE, writeToken } from "../src/token.ts";
import {
  agentSite,
  approved,
  consumed,
  denied,
  DEVICE_CODE,
  expired,
  goodStart,
  pending,
  slowDown,
  statusFor,
  TOKEN,
  unavailable,
  USER_CODE,
} from "./fixtures/agent-site.ts";

/** 5 s of the site's interval is 25 ms here; 600 s of expiry is 3 s. */
const SCALE = 0.005;

function temp(t: TestContext, prefix: string): string {
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

const flows = (t: TestContext, origin: URL, data: string, timeScale = SCALE) => {
  const f = connectFlows({ origin, data, fetch: globalThis.fetch, timeScale });
  t.after(() => f.stop());
  return f;
};

test("start: the code, the link on the configured origin, the interval and the expiry", async (t) => {
  const site = await agentSite(t);
  const started = await startConnect(site.origin, globalThis.fetch);
  assert.ok(started.ok, JSON.stringify(started));
  assert.deepEqual(started.value, {
    userCode: USER_CODE,
    url: `${site.origin.origin}/connect?code=${USER_CODE}`,
    deviceCode: DEVICE_CODE,
    interval: 5,
    expiresIn: 600,
  });
  const request = site.seen[0]!;
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/api/agent/connect/start");
  assert.equal(request.authorization, undefined);
});

test("start: a link outside the configured origin, or a malformed answer, is refused as site", async (t) => {
  const cases = [
    goodStart({ verification_uri_complete: `https://evil.example/connect?code=${USER_CODE}` }),
    goodStart({ verification_uri_complete: "javascript:alert(1)" }),
    goodStart({ device_code: "mmd_short" }),
    goodStart({ user_code: "<b>hi</b>" }),
    goodStart({ interval: "5" }),
    goodStart({ expires_in: -1 }),
    () => ({ status: 503, body: { error: "Accounts are unavailable." } }),
    () => ({ status: 200, body: null, text: "<!doctype html><title>app</title>" }),
  ];
  for (const start of cases) {
    const site = await agentSite(t, { start });
    const started = await startConnect(site.origin, globalThis.fetch);
    assert.equal(started.ok, false);
    if (!started.ok) assert.equal(started.problems[0]!.code, "site", JSON.stringify(started.problems));
  }
});

test("start: a redirect is never followed", async (t) => {
  const site = await agentSite(t, {
    start: () => ({ status: 302, body: {}, headers: { location: "https://evil.example/api/agent/connect/start" } }),
  });
  const started = await startConnect(site.origin, globalThis.fetch);
  assert.equal(started.ok, false);
  if (!started.ok) assert.equal(started.problems[0]!.code, "site");
});

test("pending, then approved: the token is saved for the origin, and the outcome names the label", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { polls: [pending, pending, approved()] });
  const f = flows(t, site.origin, data);
  const begun = await f.begin();
  assert.ok(begun.ok);
  assert.equal(begun.value.userCode, USER_CODE);
  const ticks: string[] = [];
  const outcome = await f.wait(new AbortController().signal, (message) => ticks.push(message));
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.equal(outcome.value.label, "Agent on 20 November 2026");
  assert.deepEqual(await readToken(data, site.origin), { ok: true, value: TOKEN });
  assert.equal(site.polls().length, 3);
  for (const poll of site.polls()) assert.deepEqual(JSON.parse(poll.body), { device_code: DEVICE_CODE });
  assert.ok(ticks.length >= 1, "progress while waiting");
  assert.ok(ticks.every((m) => m.includes(USER_CODE)));
  assert.ok(!JSON.stringify(outcome).includes(TOKEN));
  assert.ok(!ticks.join("").includes(DEVICE_CODE), "the device code stays inside");
});

test("slow_down adds 5 s to the interval, from then on", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { polls: [pending, slowDown, pending, approved()] });
  // 5 s is 50 ms here, 10 s is 100 ms.
  const f = flows(t, site.origin, data, 0.01);
  assert.ok((await f.begin()).ok);
  const outcome = await f.wait(new AbortController().signal, () => {});
  assert.ok(outcome.ok, JSON.stringify(outcome));
  const at = site.polls().map((p) => p.at);
  const gaps = at.slice(1).map((x, i) => x - at[i]!);
  // A poll is sent a whole interval after the previous answer (timers may round down by 1 ms).
  assert.ok(gaps[0]! >= 49, `before the slow_down: ${gaps}`);
  assert.ok(gaps[1]! >= 99, `after it: ${gaps}`);
  assert.ok(gaps[2]! >= 99, `and after that: ${gaps}`);
});

test("a firewall's 429 without a body counts as slow_down", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { polls: [{ status: 429, body: null, text: "Too Many Requests" }, approved()] });
  const f = flows(t, site.origin, data);
  assert.ok((await f.begin()).ok);
  const outcome = await f.wait(new AbortController().signal, () => {});
  assert.ok(outcome.ok, JSON.stringify(outcome));
});

test("a transient 503 keeps polling", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { polls: [unavailable, pending, approved()] });
  const f = flows(t, site.origin, data);
  assert.ok((await f.begin()).ok);
  const outcome = await f.wait(new AbortController().signal, () => {});
  assert.ok(outcome.ok, JSON.stringify(outcome));
});

for (const [name, answer, word] of [
  ["denied", denied, /declined/],
  ["expired", expired, /expired/],
  ["consumed", consumed, /already used/],
] as const) {
  test(`${name} ends the flow with sign-in, saves nothing and stops polling`, async (t) => {
    const data = temp(t, "mm-connect-");
    const site = await agentSite(t, { polls: [pending, answer] });
    const f = flows(t, site.origin, data);
    assert.ok((await f.begin()).ok);
    const outcome = await f.wait(new AbortController().signal, () => {});
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.problems[0]!.code, "sign-in");
    assert.match(outcome.problems[0]!.message, word);
    assert.match(outcome.problems[0]!.fix, /connect_account/);
    assert.equal(fs.existsSync(path.join(data, TOKEN_FILE)), false);
    const polls = site.polls().length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(site.polls().length, polls, "no poll after the end");
  });
}

test("a failed sign-in leaves an existing token in place", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { polls: [denied] });
  const old = `mma_${"o".repeat(43)}`;
  await writeToken(data, site.origin, old);
  const f = flows(t, site.origin, data);
  assert.ok((await f.begin()).ok);
  assert.equal((await f.wait(new AbortController().signal, () => {})).ok, false);
  assert.deepEqual(await readToken(data, site.origin), { ok: true, value: old });
});

test("no answer within the expiry is a timeout", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { start: goodStart({ expires_in: 10 }), polls: [pending] });
  const f = flows(t, site.origin, data);
  assert.ok((await f.begin()).ok);
  const outcome = await f.wait(new AbortController().signal, () => {});
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.problems[0]!.code, "timeout");
});

test("cancelling the wait ends the flow: polling stops and nothing is saved", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { polls: [pending] });
  const f = flows(t, site.origin, data);
  assert.ok((await f.begin()).ok);
  const controller = new AbortController();
  const waiting = f.wait(controller.signal, () => {});
  await new Promise((resolve) => setTimeout(resolve, 80));
  controller.abort();
  const outcome = await waiting;
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.problems[0]!.code, "cancelled");
  // A poll already on the wire when the cancel came may still land; none is sent after it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const polls = site.polls().length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(site.polls().length, polls, "no poll after the cancel");
  // Nothing waits any more.
  const again = await f.wait(new AbortController().signal, () => {});
  assert.equal(again.ok, false);
  if (!again.ok) assert.match(again.problems[0]!.fix, /connect_account/);
});

test("one flow at a time: begin while pending gives the same code; a second wait is refused as busy", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { polls: [pending, pending, pending, approved()] });
  const f = flows(t, site.origin, data);
  const [a, b] = await Promise.all([f.begin(), f.begin()]);
  assert.ok(a.ok && b.ok);
  assert.equal(a.value.userCode, b.value.userCode);
  assert.equal(site.seen.filter((s) => s.path === "/api/agent/connect/start").length, 1);
  const first = f.wait(new AbortController().signal, () => {});
  const second = await f.wait(new AbortController().signal, () => {});
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.problems[0]!.code, "busy");
  assert.ok((await first).ok);
});

test("an approval with nobody waiting is still saved, and the next wait reports it", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { polls: [approved()] });
  const f = flows(t, site.origin, data);
  assert.ok((await f.begin()).ok);
  for (let i = 0; i < 100 && !fs.existsSync(path.join(data, TOKEN_FILE)); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await readToken(data, site.origin), { ok: true, value: TOKEN });
  const outcome = await f.wait(new AbortController().signal, () => {});
  assert.ok(outcome.ok);
});

test("end() stops a pending flow", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { polls: [pending] });
  const f = flows(t, site.origin, data);
  assert.ok((await f.begin()).ok);
  await f.end();
  const polls = site.polls().length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(site.polls().length, polls);
});

test("openInBrowser opens only a link on the configured origin, with fixed arguments and no shell", () => {
  const origin = new URL("https://motionmockups.com");
  const runs: { command: string; args: string[] }[] = [];
  const launch: Launcher = (command, args) => runs.push({ command, args });
  const good = `https://motionmockups.com/connect?code=${USER_CODE}`;
  for (const [platform, command, args] of [
    ["win32", /rundll32\.exe$/i, ["url.dll,FileProtocolHandler", good]],
    ["darwin", /^\/usr\/bin\/open$/, [good]],
    ["linux", /^xdg-open$/, [good]],
  ] as const) {
    runs.length = 0;
    assert.ok(openInBrowser(good, origin, launch, platform).ok);
    assert.equal(runs.length, 1);
    assert.match(runs[0]!.command, command);
    assert.deepEqual(runs[0]!.args, args);
  }
  runs.length = 0;
  for (const bad of [
    "https://evil.example/connect",
    "https://motionmockups.com.evil.example/connect",
    "http://motionmockups.com/connect",
    "https://user:pass@motionmockups.com/connect",
    "file:///C:/Windows/System32/calc.exe",
    "javascript:alert(1)",
    "not a url",
  ]) {
    const opened = openInBrowser(bad, origin, launch, "win32");
    assert.equal(opened.ok, false, bad);
    if (!opened.ok) assert.equal(opened.problems[0]!.code, "site");
  }
  assert.equal(runs.length, 0, "nothing outside the origin is opened");
  // A local preview over http is the configured origin, so it may open.
  const local = new URL("http://127.0.0.1:4173");
  assert.ok(openInBrowser("http://127.0.0.1:4173/connect?code=X", local, launch, "linux").ok);
  assert.equal(openInBrowser("http://127.0.0.1:4174/connect", local, launch, "linux").ok, false);
});

test("currentAccount: no token is not connected, and makes no request", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t);
  assert.deepEqual(await currentAccount(site.origin, data, globalThis.fetch), { ok: true, value: { connected: false } });
  assert.equal(site.seen.length, 0);
});

test("currentAccount: the site's status, asked with the token as a bearer", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { status: statusFor(false, "Laptop") });
  await writeToken(data, site.origin, TOKEN);
  const account = await currentAccount(site.origin, data, globalThis.fetch);
  assert.deepEqual(account, { ok: true, value: { connected: true, pro: false, label: "Laptop", token: TOKEN } });
  assert.equal(site.seen[0]!.authorization, `Bearer ${TOKEN}`);
  assert.equal(site.seen[0]!.path, "/api/agent/status");
});

test("currentAccount: a 401 deletes the saved token and says to connect again", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { status: () => ({ status: 401, body: { error: "This agent is no longer connected. Connect it again." } }) });
  await writeToken(data, site.origin, TOKEN);
  const account = await currentAccount(site.origin, data, globalThis.fetch);
  assert.equal(account.ok, false);
  if (account.ok) return;
  assert.equal(account.problems[0]!.code, "sign-in");
  assert.match(account.problems[0]!.fix, /connect_account/);
  assert.equal(fs.existsSync(path.join(data, TOKEN_FILE)), false);
});

test("currentAccount: a site that cannot answer keeps the token and refuses as site", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { status: () => unavailable });
  await writeToken(data, site.origin, TOKEN);
  const account = await currentAccount(site.origin, data, globalThis.fetch);
  assert.equal(account.ok, false);
  if (!account.ok) assert.equal(account.problems[0]!.code, "site");
  assert.ok(fs.existsSync(path.join(data, TOKEN_FILE)));
});

test("currentAccount: a token saved for another origin is never sent", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t);
  await writeToken(data, new URL("https://motionmockups.com"), TOKEN);
  const account = await currentAccount(site.origin, data, globalThis.fetch);
  assert.equal(account.ok, false);
  if (!account.ok) assert.equal(account.problems[0]!.code, "sign-in");
  assert.equal(site.seen.length, 0, "nothing was sent to this origin");
});
