import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { connectFlows, currentAccount, disconnectAccount, openInBrowser, startConnect, type Launcher } from "../src/connect.ts";
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

test("a 307 to another site is never followed: start, poll (the device code) and status (the bearer) reach only the configured origin", async (t) => {
  const elsewhere = await agentSite(t, { polls: [approved()] });
  const to = (route: string) => ({ status: 307, body: {}, headers: { location: `${elsewhere.origin.origin}${route}` } });

  const startSite = await agentSite(t, { start: () => to("/api/agent/connect/start") });
  const started = await startConnect(startSite.origin, globalThis.fetch);
  assert.equal(started.ok, false);
  if (!started.ok) assert.equal(started.problems[0]!.code, "site");

  const data = temp(t, "mm-connect-");
  const pollSite = await agentSite(t, { start: goodStart({ expires_in: 20 }), polls: [to("/api/agent/connect/poll")] });
  const f = flows(t, pollSite.origin, data);
  assert.ok((await f.begin()).ok);
  const outcome = await f.wait(new AbortController().signal, () => {});
  assert.equal(outcome.ok, false, "a redirected poll never approves");
  assert.ok(pollSite.polls().length >= 2, "polled the configured origin");
  assert.equal(fs.existsSync(path.join(data, TOKEN_FILE)), false);

  const statusSite = await agentSite(t, { status: () => to("/api/agent/status") });
  await writeToken(data, statusSite.origin, TOKEN);
  const account = await currentAccount(statusSite.origin, data, globalThis.fetch);
  assert.equal(account.ok, false);
  if (!account.ok) assert.equal(account.problems[0]!.code, "site");
  assert.ok(fs.existsSync(path.join(data, TOKEN_FILE)), "a redirect is not a 401");

  assert.deepEqual(elsewhere.seen, [], "the other site received nothing");
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

test("cancelling the wait only stops waiting: polling goes on, a later approval is saved, and the next wait reports it", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { polls: [pending, pending, pending, pending, pending, pending, approved()] });
  const f = flows(t, site.origin, data);
  assert.ok((await f.begin()).ok);
  const controller = new AbortController();
  const ticks: string[] = [];
  const waiting = f.wait(controller.signal, (m) => ticks.push(m));
  await new Promise((resolve) => setTimeout(resolve, 40));
  controller.abort();
  const outcome = await waiting;
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.problems[0]!.code, "cancelled");
    assert.match(outcome.problems[0]!.fix, /wait: true/);
  }
  const reported = ticks.length;
  // The sign-in goes on: it is polled until approved, and the token saved.
  for (let i = 0; i < 100 && !fs.existsSync(path.join(data, TOKEN_FILE)); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(site.polls().length, 7);
  assert.deepEqual(await readToken(data, site.origin), { ok: true, value: TOKEN });
  assert.equal(ticks.length, reported, "the cancelled wait's listener was detached");
  const again = await f.wait(new AbortController().signal, () => {});
  assert.ok(again.ok, JSON.stringify(again));
});

test("a wait cancelled before it starts returns cancelled and leaves the sign-in pending", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { polls: [pending] });
  const f = flows(t, site.origin, data);
  const begun = await f.begin();
  assert.ok(begun.ok);
  const controller = new AbortController();
  controller.abort();
  const outcome = await f.wait(controller.signal, () => {});
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.problems[0]!.code, "cancelled");
  const again = await f.begin();
  assert.ok(again.ok && again.value.reused, "the same sign-in is still pending");
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

test("end() stops a pending flow, including after a cancelled wait", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { polls: [pending] });
  const f = flows(t, site.origin, data);
  assert.ok((await f.begin()).ok);
  const controller = new AbortController();
  const waiting = f.wait(controller.signal, () => {});
  await new Promise((resolve) => setTimeout(resolve, 40));
  controller.abort();
  await waiting;
  await f.end();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const polls = site.polls().length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(site.polls().length, polls);
  const after = await f.wait(new AbortController().signal, () => {});
  assert.equal(after.ok, false);
  if (!after.ok) assert.match(after.problems[0]!.message, /No sign-in is waiting/);
});

test("end() while a sign-in is still starting: the start is dropped, never polled, nothing saved", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t, { start: (origin) => ({ ...goodStart()(origin), delay: 100 }), polls: [approved()] });
  const f = flows(t, site.origin, data);
  const begun = f.begin();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.end();
  const result = await begun;
  assert.equal(result.ok, false, "a start that end() overtook is not a sign-in");
  if (!result.ok) assert.equal(result.problems[0]!.code, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(site.polls().length, 0, "never polled");
  assert.equal(fs.existsSync(path.join(data, TOKEN_FILE)), false);
  const after = await f.wait(new AbortController().signal, () => {});
  assert.equal(after.ok, false);
  if (!after.ok) assert.match(after.problems[0]!.message, /No sign-in is waiting/);
  // A new begin afterwards starts a fresh sign-in.
  const again = await f.begin();
  assert.ok(again.ok && !again.value.reused, JSON.stringify(again));
});

test("end() during an approving poll: once it returns, no token is ever written", async (t) => {
  const data = temp(t, "mm-connect-");
  // The approval is on its way when end() is called.
  const site = await agentSite(t, { polls: [{ ...approved(), delay: 60 }] });
  const f = flows(t, site.origin, data);
  assert.ok((await f.begin()).ok);
  for (let i = 0; i < 100 && site.polls().length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(site.polls().length, 1, "the poll is on the wire");
  await f.end();
  assert.equal(fs.existsSync(path.join(data, TOKEN_FILE)), false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fs.existsSync(path.join(data, TOKEN_FILE)), false, "nothing renamed into place after end()");
  assert.deepEqual(fs.readdirSync(data), []);
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

test("currentAccount: a 401 without the site's JSON error (a preview's own protection) keeps the token", async (t) => {
  for (const answer of [
    { status: 401, body: null, text: "<!doctype html><title>Authentication Required</title>" },
    { status: 401, body: { message: "not ours" } },
  ]) {
    const data = temp(t, "mm-connect-");
    const site = await agentSite(t, { status: () => answer });
    await writeToken(data, site.origin, TOKEN);
    const account = await currentAccount(site.origin, data, globalThis.fetch);
    assert.equal(account.ok, false);
    if (!account.ok) assert.equal(account.problems[0]!.code, "site");
    assert.ok(fs.existsSync(path.join(data, TOKEN_FILE)), JSON.stringify(answer));
  }
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

test("disconnectAccount: the site revokes the saved token with it as the bearer, then the file is deleted", async (t) => {
  const data = temp(t, "mm-connect-");
  const site = await agentSite(t);
  await writeToken(data, site.origin, TOKEN);
  const result = await disconnectAccount(site.origin, data, globalThis.fetch);
  assert.deepEqual(result, { removed: true, revoked: true });
  assert.equal(site.seen.length, 1);
  assert.equal(site.seen[0]!.method, "POST");
  assert.equal(site.seen[0]!.path, "/api/agent/disconnect");
  assert.equal(site.seen[0]!.authorization, `Bearer ${TOKEN}`);
  assert.equal(fs.existsSync(path.join(data, TOKEN_FILE)), false);
});

test("disconnectAccount: a network failure, a refusal or a redirect still deletes the file and says the site did not confirm", async (t) => {
  const elsewhere = await agentSite(t);
  const answers = [
    { status: 0, body: null, cut: true },
    unavailable,
    { status: 200, body: { status: "something else" } },
    { status: 307, body: {}, headers: { location: `${elsewhere.origin.origin}/api/agent/disconnect` } },
  ];
  for (const answer of answers) {
    const data = temp(t, "mm-connect-");
    const site = await agentSite(t, { disconnect: () => answer });
    await writeToken(data, site.origin, TOKEN);
    const result = await disconnectAccount(site.origin, data, globalThis.fetch);
    assert.equal(result.removed, true, JSON.stringify(answer));
    assert.equal(result.revoked, false, JSON.stringify(answer));
    assert.ok(result.detail, JSON.stringify(answer));
    assert.doesNotMatch(result.detail!, /mma_/);
    assert.equal(fs.existsSync(path.join(data, TOKEN_FILE)), false, JSON.stringify(answer));
  }
  assert.deepEqual(elsewhere.seen, [], "the redirect was not followed");
  // A site that cannot be reached at all.
  const data = temp(t, "mm-connect-");
  const origin = new URL("http://127.0.0.1:9");
  await writeToken(data, origin, TOKEN);
  const refused = (async () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  }) as unknown as typeof fetch;
  const result = await disconnectAccount(origin, data, refused);
  assert.deepEqual(result, { removed: true, revoked: false, detail: "the site could not be reached (ECONNREFUSED)" });
  assert.equal(fs.existsSync(path.join(data, TOKEN_FILE)), false);
});

test("disconnectAccount: no saved token sends nothing; one for another origin is deleted, never sent", async (t) => {
  const site = await agentSite(t);
  const none = temp(t, "mm-connect-");
  assert.deepEqual(await disconnectAccount(site.origin, none, globalThis.fetch), { removed: false, revoked: false });
  const other = temp(t, "mm-connect-");
  await writeToken(other, new URL("https://motionmockups.com"), TOKEN);
  const result = await disconnectAccount(site.origin, other, globalThis.fetch);
  assert.equal(result.removed, true);
  assert.equal(result.revoked, false);
  assert.ok(result.detail);
  assert.equal(fs.existsSync(path.join(other, TOKEN_FILE)), false);
  assert.equal(site.seen.length, 0, "nothing was sent");
});
