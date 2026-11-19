import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import type { Cdp } from "../src/chrome/cdp.ts";
import { findChrome } from "../src/chrome/find.ts";
import { chromeArgs, launchChrome, openPage, type Chrome } from "../src/chrome/launch.ts";

const windows = process.platform === "win32";
const found = findChrome();
const skip = found.ok ? false : "no Google Chrome on this machine";
const executable = found.ok ? found.value : "";
const PUBLIC = new URL("https://motionmockups.com");

// ---- flags (no Chrome needed) ----

test("flags: the pipe, the profile, the proxy rule and the mode", () => {
  const profile = path.join(os.tmpdir(), "profile");
  const headless = chromeArgs({ executable: "chrome", profile, origin: PUBLIC, mode: "headless" });
  for (const flag of [
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--proxy-server=http://127.0.0.1:9",
    "--proxy-bypass-list=<-loopback>;motionmockups.com:443;assets.motionmockups.com:443;*.r2.cloudflarestorage.com:443",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-breakpad",
    "--headless",
  ])
    assert.ok(headless.includes(flag), flag);
  // Chrome 156 has no --disable-crash-reporter switch (not in its binaries); breakpad's is the one.
  assert.ok(!headless.includes("--disable-crash-reporter"));
  // No system keyring or keychain dialog in either mode.
  for (const mode of ["headless", "window"] as const) {
    const args = chromeArgs({ executable: "chrome", profile, origin: PUBLIC, mode });
    assert.ok(args.includes("--password-store=basic") && args.includes("--use-mock-keychain"), mode);
  }
  assert.equal(headless.at(-1), "about:blank");
  assert.ok(!headless.some((f) => f.startsWith("--window-")));
  assert.ok(!headless.some((f) => /^--remote-debugging-port/.test(f)), "never a TCP debugging port");

  const window = chromeArgs({ executable: "chrome", profile, origin: PUBLIC, mode: "window" });
  assert.ok(!window.includes("--headless"));
  assert.ok(window.includes("--window-position=-32000,-32000"));
  assert.ok(window.includes("--window-size=1280,800"));

  const loopback = chromeArgs({ executable: "chrome", profile, origin: new URL("http://127.0.0.1:5173"), mode: "headless" });
  assert.ok(loopback.includes("--proxy-bypass-list=<-loopback>;127.0.0.1:5173;assets.motionmockups.com:443;*.r2.cloudflarestorage.com:443"));
});

test("flags: every bypass rule names its port, so none opens every port of a host", () => {
  const profile = path.join(os.tmpdir(), "profile");
  for (const [origin, rule] of [
    ["http://127.0.0.1", "127.0.0.1:80"],
    ["http://localhost:80", "localhost:80"],
    ["http://localhost:4173", "localhost:4173"],
    ["https://motionmockups.com", "motionmockups.com:443"],
    ["https://motion-mockups-k7te7knkw-krystofjezeks-projects.vercel.app", "motion-mockups-k7te7knkw-krystofjezeks-projects.vercel.app:443"],
  ] as const) {
    const args = chromeArgs({ executable: "chrome", profile, origin: new URL(origin), mode: "headless" });
    const flag = args.find((f) => f.startsWith("--proxy-bypass-list="))!;
    const rules = flag.slice("--proxy-bypass-list=".length).split(";");
    assert.equal(rules[0], "<-loopback>", origin);
    assert.equal(rules[1], rule, origin);
    for (const r of rules.slice(1)) assert.match(r, /:\d+$/, `${origin}: ${r}`);
  }
});

// ---- the real Chrome ----

let profile = "";
let server: http.Server;
let port = 0;
let other: http.Server;
let otherPort = 0;
const running: Chrome[] = [];

function listen(): Promise<[http.Server, number]> {
  return new Promise((resolve) => {
    // The body comes a moment after the headers, as on a slow runner: Page.navigate answers
    // once the response is committed, before the page has loaded.
    const s = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.flushHeaders();
      setTimeout(() => res.end("<p>local</p>"), 300);
    });
    s.listen(0, "127.0.0.1", () => resolve([s, (s.address() as AddressInfo).port]));
  });
}

before(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "mm-chrome-test-"));
  [server, port] = await listen();
  [other, otherPort] = await listen();
});

after(async () => {
  for (const chrome of running) await chrome.close();
  server?.close();
  other?.close();
  // Chrome holds profile files open until it has exited; close() waited for that.
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

/** Launches on the shared profile; the test closes it when it ends, failed or not. */
async function launch(t: TestContext, origin = PUBLIC): Promise<Chrome> {
  const chrome = await launchChrome({ executable, profile, origin, mode: "headless" });
  running.push(chrome);
  t.after(() => chrome.close());
  return chrome;
}

async function evaluate(cdp: Cdp, sessionId: string, expression: string): Promise<unknown> {
  const result = await cdp.send<any>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) {
    const d = result.exceptionDetails;
    throw new Error(`${d.text} ${d.exception?.description ?? ""}`.trim());
  }
  return result.result.value;
}

const reach = (url: string) =>
  `fetch(${JSON.stringify(url)}, { mode: "no-cors", cache: "no-store" }).then(() => "reached", (e) => "blocked: " + e.message)`;

async function navigate(cdp: Cdp, sessionId: string, url: string): Promise<string> {
  const result = await cdp.send<any>("Page.navigate", { url }, sessionId);
  return result.errorText || "reached";
}

/** Page.navigate answers once the response is committed; this waits for the page to have loaded. */
async function loaded(cdp: Cdp, sessionId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const state = await evaluate(cdp, sessionId, "document.readyState").catch(() => "");
    if (state === "complete") return;
    if (Date.now() > deadline) throw new Error(`the page did not load (readyState ${JSON.stringify(state)})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Whether this machine reaches `url` at all (a runner may not): Chrome's reach is only meaningful then. */
async function online(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5_000) });
    return true;
  } catch {
    return false;
  }
}

const ASSET = "https://assets.motionmockups.com/robots.txt";

/** pid -> parent pid, name, for every process. */
function processes(): Map<number, { ppid: number; name: string }> {
  const table = new Map<number, { ppid: number; name: string }>();
  if (windows) {
    const json = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"],
      { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    );
    for (const p of JSON.parse(json)) table.set(p.ProcessId, { ppid: p.ParentProcessId, name: p.Name });
  } else {
    for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), name: m[3] });
    }
  }
  return table;
}

function tree(root: number, table = processes()): Map<number, string> {
  const found = new Map<number, string>();
  const walk = (pid: number) => {
    for (const [child, p] of table) if (p.ppid === pid && !found.has(child)) {
      found.set(child, p.name);
      walk(child);
    }
  };
  walk(root);
  return found;
}

test("a headless launch evaluates 1+1 to 2", { skip }, async (t) => {
  const chrome = await launch(t);
  const { sessionId } = await openPage(chrome.cdp);
  assert.equal(await evaluate(chrome.cdp, sessionId, "1+1"), 2);
  await chrome.close();
});

test("the proxy rule: other hosts and loopback blocked", { skip }, async (t) => {
  const chrome = await launch(t);
  const { sessionId } = await openPage(chrome.cdp);
  assert.match(String(await evaluate(chrome.cdp, sessionId, reach("https://example.com/"))), /^blocked/);
  // A public origin gets no loopback: Chrome would otherwise bypass the proxy for it implicitly.
  assert.equal(await navigate(chrome.cdp, sessionId, `http://127.0.0.1:${port}/`), "net::ERR_PROXY_CONNECTION_FAILED");
  assert.equal(await navigate(chrome.cdp, sessionId, "https://example.com/"), "net::ERR_PROXY_CONNECTION_FAILED");
  assert.equal(await navigate(chrome.cdp, sessionId, "https://www.motionmockups.com/"), "net::ERR_PROXY_CONNECTION_FAILED");
  await chrome.close();
});

test("a loopback origin is reached; other ports and hosts are not", { skip }, async (t) => {
  // Loopback fixtures only: nothing here depends on a host outside this machine.
  const chrome = await launch(t, new URL(`http://127.0.0.1:${port}`));
  const { sessionId } = await openPage(chrome.cdp);
  assert.equal(await navigate(chrome.cdp, sessionId, `http://127.0.0.1:${port}/`), "reached");
  await loaded(chrome.cdp, sessionId);
  assert.equal(await evaluate(chrome.cdp, sessionId, "document.body.textContent"), "local");
  assert.equal(await evaluate(chrome.cdp, sessionId, reach(`http://127.0.0.1:${port}/again`)), "reached");
  assert.match(String(await evaluate(chrome.cdp, sessionId, reach(`http://127.0.0.1:${otherPort}/`))), /^blocked/);
  assert.match(String(await evaluate(chrome.cdp, sessionId, reach("https://example.com/"))), /^blocked/);
  assert.equal(await navigate(chrome.cdp, sessionId, `http://127.0.0.1:${otherPort}/`), "net::ERR_PROXY_CONNECTION_FAILED");
  await chrome.close();
});

test("the allowed asset host is reached, from the public site and from a loopback origin", { skip }, async (t) => {
  if (!(await online(ASSET))) {
    t.skip(`${new URL(ASSET).host} is not reachable from this machine`);
    return;
  }
  for (const origin of [PUBLIC, new URL(`http://127.0.0.1:${port}`)]) {
    const chrome = await launch(t, origin);
    const { sessionId } = await openPage(chrome.cdp);
    assert.equal(await evaluate(chrome.cdp, sessionId, reach(ASSET)), "reached", origin.href);
    await chrome.close();
  }
});

test("a loopback origin on the default port does not open the other ports", { skip }, async (t) => {
  // siteOrigin refuses such an origin; the bypass rule must hold even if one got this far.
  const chrome = await launch(t, new URL("http://127.0.0.1"));
  const { sessionId } = await openPage(chrome.cdp);
  assert.equal(await navigate(chrome.cdp, sessionId, `http://127.0.0.1:${otherPort}/`), "net::ERR_PROXY_CONNECTION_FAILED");
  assert.equal(await navigate(chrome.cdp, sessionId, `http://localhost:${otherPort}/`), "net::ERR_PROXY_CONNECTION_FAILED");
  await chrome.close();
});

/** Waits up to 5 s for every watched Chrome process to be gone; returns those left. */
async function leftOver(watched: Set<number>): Promise<number[]> {
  let left: number[] = [];
  for (let waited = 0; waited <= 5000; waited += 250) {
    const table = processes();
    left = [...watched].filter((p) => table.has(p) && /chrom/i.test(table.get(p)!.name));
    if (left.length === 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return left;
}

test("after close() Chrome has exited and no child of it remains", { skip }, async (t) => {
  const chrome = await launch(t);
  await openPage(chrome.cdp);
  const children = tree(chrome.pid);
  assert.ok(children.size > 0, "Chrome should have started child processes");
  t.diagnostic(`browser ${chrome.pid}, children ${[...children].map(([p, n]) => `${p} ${n}`).join(", ")}`);
  await chrome.close();
  t.diagnostic(`exit code ${await chrome.exited}`);
  const left = await leftOver(new Set([chrome.pid, ...children.keys()]));
  assert.deepEqual(left, [], `still running: ${left.join(", ")}`);
  // close() twice is harmless.
  await chrome.close();
});

test("a Chrome that does not answer Browser.close is killed with its whole tree after 5 s", { skip }, async (t) => {
  const chrome = await launch(t);
  await openPage(chrome.cdp);
  const children = tree(chrome.pid);
  assert.ok(children.size > 0, "Chrome should have started child processes");
  // With the client closed, Browser.close never reaches Chrome: only the kill can end it.
  chrome.cdp.close();
  const started = Date.now();
  await chrome.close();
  const took = Date.now() - started;
  t.diagnostic(`killed after ${took} ms, exit code ${await chrome.exited}, children ${children.size}`);
  assert.ok(took >= 4900, `close() should have waited 5 s first, took ${took} ms`);
  const left = await leftOver(new Set([chrome.pid, ...children.keys()]));
  assert.deepEqual(left, [], `still running: ${left.join(", ")}`);
});

test("WebRTC gathers no UDP candidate around the proxy, even with a public STUN server", { skip }, async (t) => {
  const chrome = await launch(t);
  const { sessionId } = await openPage(chrome.cdp);
  // Offline this also gathers nothing; the assertion is the absence of candidates.
  const candidates = (await evaluate(
    chrome.cdp,
    sessionId,
    `new Promise((resolve) => {
      const found = [];
      const pc = new RTCPeerConnection({ iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" },
      ] });
      const done = () => { pc.close(); resolve(found); };
      pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) found.push(e.candidate.candidate); else if (!e.candidate) done(); };
      pc.createDataChannel("probe");
      pc.createOffer().then((offer) => pc.setLocalDescription(offer));
      setTimeout(done, 8000);
    })`,
  )) as string[];
  t.diagnostic(`candidates: ${JSON.stringify(candidates)}`);
  assert.deepEqual(candidates.filter((c) => / typ srflx| typ relay/.test(c)), [], "no server-reflexive or relay candidate");
  assert.deepEqual(candidates.filter((c) => / udp /i.test(c)), [], "no UDP candidate");
  await chrome.close();
});

test("close() of a hung Chrome settles and kills the tree even with PATH empty", { skip, timeout: 30_000 }, async (t) => {
  const chrome = await launch(t);
  await openPage(chrome.cdp);
  const children = tree(chrome.pid);
  assert.ok(children.size > 0, "Chrome should have started child processes");
  chrome.cdp.close(); // Browser.close never arrives: only the kill can end it.
  const saved = process.env.PATH;
  process.env.PATH = "";
  const started = Date.now();
  try {
    await chrome.close();
  } finally {
    process.env.PATH = saved;
  }
  t.diagnostic(`settled after ${Date.now() - started} ms, exit code ${await chrome.exited}`);
  const left = await leftOver(new Set([chrome.pid, ...children.keys()]));
  assert.deepEqual(left, [], `still running: ${left.join(", ")}`);
});

test("a second launch on the same profile works", { skip }, async (t) => {
  const first = await launch(t);
  await first.close();
  const second = await launch(t);
  const { sessionId } = await openPage(second.cdp);
  assert.equal(await evaluate(second.cdp, sessionId, "6*7"), 42);
  await second.close();
});

test("a launch on a profile another Chrome holds is refused with chrome-start", { skip }, async (t) => {
  await launch(t);
  await assert.rejects(launch(t), (e: any) => {
    t.diagnostic(e.message);
    return e.code === "chrome-start" && (!windows || /profile is in use/.test(e.message));
  });
});

test("a wrong executable is refused with code chrome-start", async () => {
  await assert.rejects(
    launchChrome({ executable: path.join(os.tmpdir(), "no-such-chrome.exe"), profile: path.join(profile, "never"), origin: PUBLIC, mode: "headless" }),
    (e: any) => e.code === "chrome-start" && typeof e.fix === "string" && /MOTIONMOCKUPS_CHROME/.test(e.fix),
  );
});
