// Connecting the adapter to a Motion Mockups account, the device way (as `gh auth login` does):
// the adapter asks the site for a code (`POST /api/agent/connect/start`), the person opens the
// link in their own browser, signs in and approves the code, and the adapter, polling
// `POST /api/agent/connect/poll`, receives a render-only agent token and saves it
// (src/token.ts). `GET /api/agent/status` then says whether the account is Pro, and
// `POST /api/agent/disconnect` revokes the token when the adapter disconnects.
//
// Every request goes to the configured origin only, and no redirect is followed. The adapter
// never opens a browser unless asked to (`open: true`, which the tool recommends: a link the
// adapter opens itself is certainly its own); the link and code are in the tool result for the
// agent to show. The token and the device code never leave this module but in requests to the origin
// and, for the token, the file.

import { execFile } from "node:child_process";
import path from "node:path";

import type { Checked, Problem } from "./folders.ts";
import { clearToken, isAgentToken, readToken, TOKEN_FILE, writeToken } from "./token.ts";

/** Any one request to the site. */
const REQUEST_MS = 15_000;
/** Far above any real answer; a larger body is not the site's. */
const MAX_BYTES = 16 * 1024;
/** The longest a sign-in waits, whatever the site says: its requests last 10 minutes. */
const MAX_EXPIRES_S = 600;
const SLOW_DOWN_S = 5;
const LABEL_CHARS = 60;
const ERROR_CHARS = 200;

const DEVICE_CODE = /^mmd_[A-Za-z0-9_-]{43}$/;
const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
/** Control characters, bidirectional marks and overrides, line and paragraph separators. */
const UNSAFE = /[\p{Cc}\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;

export interface Started {
  userCode: string;
  url: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
}

export type Account = { connected: false } | { connected: true; pro: boolean; label: string; token: string };

const refuse = <T>(code: string, message: string, fix: string): Checked<T> => ({ ok: false, problems: [{ code, message, fix }] });

const siteFix = (origin: URL) =>
  origin.origin === "https://motionmockups.com"
    ? "Check the internet connection, then try again in a minute."
    : "Check that the site at MOTIONMOCKUPS_ORIGIN is running and has the agent API, then try again.";

const siteProblem = (origin: URL, what: string, detail: string): Problem => ({
  code: "site",
  message: `${what} at ${origin.origin} failed: ${detail}.`,
  fix: siteFix(origin),
});

/** A label or error text from the site, as plain text, capped. */
const clean = (text: string, max: number) => {
  const plain = text.replace(UNSAFE, " ").trim();
  return plain.length <= max ? plain : `${plain.slice(0, max - 1)}…`;
};

/** Resolves after `ms`, or rejects with the signal's reason. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface Reply {
  status: number;
  /** The JSON body, or undefined when it is not JSON. */
  body: unknown;
}

/**
 * One request to `<origin><route>`, bounded by REQUEST_MS and `signal`, never redirected, its
 * body read up to MAX_BYTES. Throws on a network failure, a timeout or the signal.
 */
async function call(
  origin: URL,
  fetchImpl: typeof fetch,
  route: string,
  init: { method: "GET" | "POST"; body?: unknown; bearer?: string },
  signal?: AbortSignal,
): Promise<Reply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`no answer within ${REQUEST_MS / 1000} s`)), REQUEST_MS);
  const onAbort = () => controller.abort(signal!.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    const response = await fetchImpl(new URL(route, origin), {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      redirect: "error",
      signal: controller.signal,
    });
    let text = "";
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel().catch(() => {});
          return { status: response.status, body: undefined };
        }
        chunks.push(value);
      }
      text = Buffer.concat(chunks).toString("utf8");
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The failure of a request, in words; never the request itself (it may carry the token). */
function failure(error: unknown): string {
  const e = error as Error & { cause?: { code?: string } };
  if (e?.name === "TimeoutError" || /no answer within/.test(e?.message ?? "")) return `no answer within ${REQUEST_MS / 1000} s`;
  const cause = e?.cause?.code ? ` (${e.cause.code})` : "";
  return `the site could not be reached${cause}`;
}

/** The site's own error words from a JSON answer, cleaned and capped. */
const siteWords = (body: unknown) => (isObject(body) && typeof body.error === "string" ? clean(body.error, ERROR_CHARS) : "");

/** `POST /api/agent/connect/start`: a code for the person and a device code for polling. */
export async function startConnect(origin: URL, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Checked<Started>> {
  const what = "Starting a sign-in";
  let reply: Reply;
  try {
    reply = await call(origin, fetchImpl, "/api/agent/connect/start", { method: "POST", body: {} }, signal);
  } catch (error) {
    if (signal?.aborted) return refuse("cancelled", "The sign-in was cancelled.", "Call connect_account again when it is wanted.");
    return { ok: false, problems: [siteProblem(origin, what, failure(error))] };
  }
  if (reply.status !== 200) {
    const words = siteWords(reply.body);
    return { ok: false, problems: [siteProblem(origin, what, `the site answered ${reply.status}${words ? ` (${words})` : ""}`)] };
  }
  const b = reply.body;
  if (!isObject(b)) return { ok: false, problems: [siteProblem(origin, what, "the answer is not JSON")] };
  if (typeof b.device_code !== "string" || !DEVICE_CODE.test(b.device_code) || typeof b.user_code !== "string" || !USER_CODE.test(b.user_code))
    return { ok: false, problems: [siteProblem(origin, what, "the answer has no valid codes")] };
  if (
    typeof b.interval !== "number" ||
    !Number.isFinite(b.interval) ||
    b.interval < 1 ||
    b.interval > 60 ||
    typeof b.expires_in !== "number" ||
    !Number.isFinite(b.expires_in) ||
    b.expires_in < 1
  )
    return { ok: false, problems: [siteProblem(origin, what, "the answer has no valid interval or expiry")] };
  let link: URL | undefined;
  try {
    link = typeof b.verification_uri_complete === "string" ? new URL(b.verification_uri_complete) : undefined;
  } catch {
    link = undefined;
  }
  if (!link || link.origin !== origin.origin || link.pathname !== "/connect" || link.username || link.password)
    return { ok: false, problems: [siteProblem(origin, what, `the sign-in link is not on ${origin.origin}/connect`)] };
  return {
    ok: true,
    value: {
      userCode: b.user_code,
      url: link.href,
      deviceCode: b.device_code,
      interval: b.interval,
      expiresIn: Math.min(b.expires_in, MAX_EXPIRES_S),
    },
  };
}

type Poll =
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "transient"; detail: string }
  | { kind: "approved"; token: string; label: string }
  | { kind: "end"; problem: Problem };

const againFix = "Call connect_account again for a new code, and approve it in the browser.";

/** One `POST /api/agent/connect/poll`, read by its `status`, not by the HTTP code alone. */
async function pollOnce(origin: URL, fetchImpl: typeof fetch, deviceCode: string, signal: AbortSignal): Promise<Poll> {
  let reply: Reply;
  try {
    reply = await call(origin, fetchImpl, "/api/agent/connect/poll", { method: "POST", body: { device_code: deviceCode } }, signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return { kind: "transient", detail: failure(error) };
  }
  const b = isObject(reply.body) ? reply.body : {};
  const state = b.status;
  if (state === "pending") return { kind: "pending" };
  if (state === "slow_down" || reply.status === 429) return { kind: "slow_down" };
  if (state === "approved") {
    if (!isAgentToken(b.token))
      return { kind: "end", problem: siteProblem(origin, "Signing in", "the site approved the sign-in but sent no valid token") };
    const label = typeof b.label === "string" && b.label.trim() ? clean(b.label, LABEL_CHARS) : "this agent";
    return { kind: "approved", token: b.token, label };
  }
  if (state === "denied")
    return { kind: "end", problem: { code: "sign-in", message: "The person declined the connection in the browser.", fix: againFix } };
  if (state === "expired")
    return { kind: "end", problem: { code: "sign-in", message: "The sign-in code expired before it was approved.", fix: againFix } };
  if (state === "consumed")
    return { kind: "end", problem: { code: "sign-in", message: "This sign-in code was already used.", fix: againFix } };
  if (reply.status >= 500 || reply.body === undefined) return { kind: "transient", detail: `the site answered ${reply.status}` };
  const words = siteWords(reply.body);
  return { kind: "end", problem: siteProblem(origin, "Signing in", `the site answered ${reply.status}${words ? ` (${words})` : ""}`) };
}

/**
 * The saved connection and what the site says of it. No token: not connected, and nothing is
 * sent. A 401 deletes the saved token (revoked, idle for 90 days or the account deleted).
 */
export async function currentAccount(origin: URL, data: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Checked<Account>> {
  const saved = await readToken(data, origin);
  if (!saved.ok) return saved;
  const token = saved.value;
  if (token === null) return { ok: true, value: { connected: false } };
  const what = "Checking the connected account";
  let reply: Reply;
  try {
    reply = await call(origin, fetchImpl, "/api/agent/status", { method: "GET", bearer: token }, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return { ok: false, problems: [siteProblem(origin, what, failure(error))] };
  }
  // Only the site's own 401, with its JSON error: a preview's deployment protection answers 401
  // too, and that says nothing about the token.
  if (reply.status === 401 && isObject(reply.body) && typeof reply.body.error === "string") {
    await clearToken(data, token).catch(() => {});
    return refuse(
      "sign-in",
      "The site says this agent is no longer connected: its access was revoked, went unused for 90 days, or the account was deleted. The saved connection on this computer was deleted.",
      "Call connect_account to connect the account again. Until then renders are free watermarked previews.",
    );
  }
  const b = reply.body;
  if (reply.status !== 200 || !isObject(b) || b.signedIn !== true || typeof b.pro !== "boolean" || typeof b.label !== "string") {
    const words = siteWords(b);
    return { ok: false, problems: [siteProblem(origin, what, `the site answered ${reply.status}${words ? ` (${words})` : ""}`)] };
  }
  return { ok: true, value: { connected: true, pro: b.pro, label: clean(b.label, LABEL_CHARS) || "this agent", token } };
}

export interface Disconnected {
  /** The saved file was deleted (false: there was none). */
  removed: boolean;
  /** The site confirmed it revoked the token. */
  revoked: boolean;
  /** Why the site did not confirm, in words; never the token. */
  detail?: string;
  /** The saved file that is there but could not be deleted, and why. */
  notDeleted?: { path: string; reason: string };
}

/**
 * Disconnects this computer: the saved token for `origin` is sent once to
 * `POST /api/agent/disconnect`, which revokes it on the account, and the file is then deleted
 * whatever the site answered. A token saved for another origin is never sent, only deleted.
 */
export async function disconnectAccount(origin: URL, data: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Disconnected> {
  const saved = await readToken(data, origin).catch((): Checked<string | null> => ({ ok: true, value: null }));
  let revoked = false;
  let detail: string | undefined;
  if (!saved.ok) detail = "the saved connection could not be used, so it was not sent";
  else if (saved.value !== null) {
    try {
      const reply = await call(origin, fetchImpl, "/api/agent/disconnect", { method: "POST", body: {}, bearer: saved.value }, signal);
      revoked = reply.status === 200 && isObject(reply.body) && reply.body.status === "disconnected";
      if (!revoked) {
        const words = siteWords(reply.body);
        detail = `the site answered ${reply.status}${words ? ` (${words})` : ""}`;
      }
    } catch (error) {
      detail = signal?.aborted ? "the call was cancelled" : failure(error);
    }
  }
  // clearToken says false when there is no file; a file it cannot delete is a throw.
  let removed = false;
  let notDeleted: Disconnected["notDeleted"];
  try {
    removed = await clearToken(data);
  } catch (error) {
    notDeleted = { path: path.join(data, TOKEN_FILE), reason: (error as NodeJS.ErrnoException)?.code ?? failure(error) };
  }
  return { removed, revoked, ...(detail ? { detail } : {}), ...(notDeleted ? { notDeleted } : {}) };
}

/** Runs a program with fixed arguments and no shell, without waiting for it. */
export type Launcher = (command: string, args: string[]) => void;

const defaultLauncher: Launcher = (command, args) => {
  const child = execFile(command, args, { windowsHide: true, shell: false, timeout: 30_000 }, () => {});
  child.on("error", () => {});
  child.unref();
};

/**
 * Opens `url` in the person's default browser: only a link on the configured origin, https (or
 * http on a loopback preview), with no user name or password. No shell: `rundll32
 * url.dll,FileProtocolHandler` on Windows (by its full path), `/usr/bin/open` on macOS,
 * `xdg-open` elsewhere.
 */
export function openInBrowser(url: string, origin: URL, launch: Launcher = defaultLauncher, platform: NodeJS.Platform = process.platform): Checked<null> {
  let link: URL | undefined;
  try {
    link = new URL(url);
  } catch {
    link = undefined;
  }
  const loopback = link?.protocol === "http:" && (link.hostname === "127.0.0.1" || link.hostname === "localhost");
  if (!link || link.origin !== origin.origin || link.username || link.password || !(link.protocol === "https:" || loopback))
    return refuse("site", `The sign-in link is not on ${origin.origin}, so it was not opened.`, "Call connect_account again.");
  if (platform === "win32") {
    const root = process.env.SystemRoot?.trim() || "C:\\Windows";
    launch(path.win32.join(root, "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", link.href]);
  } else if (platform === "darwin") launch("/usr/bin/open", [link.href]);
  else launch("xdg-open", [link.href]);
  return { ok: true, value: null };
}

export interface ConnectDeps {
  origin: URL;
  data: string;
  fetch: typeof fetch;
  /** Tests run the clock faster: every wait and the expiry are multiplied by this. Default 1. */
  timeScale?: number;
}

interface Flow {
  started: Started;
  controller: AbortController;
  done: Promise<Checked<{ label: string }>>;
  finished: boolean;
  waiting: boolean;
  listeners: Set<(message: string) => void>;
}

const ended = (): Problem => ({
  code: "cancelled",
  message: "The sign-in was ended; the code no longer works.",
  fix: "Call connect_account again when the person wants to connect.",
});

const stoppedWaiting = (f: Flow): Problem => ({
  code: "cancelled",
  message: `Stopped waiting. The sign-in goes on: code ${f.started.userCode} can still be approved at ${f.started.url} until it expires.`,
  fix: "Call connect_account with wait: true to wait again, or account once the person says they approved it.",
});

/**
 * One sign-in at a time per adapter. `begin()` starts one (or gives the pending one's code) and
 * polls in the background until it is approved, declined, expired or ended; an approval is saved
 * even with nobody waiting. `wait()` waits for its outcome, reporting each poll; cancelling a
 * wait only stops that wait (a client's own request timeout cancels too), never the sign-in.
 * A second wait at the same time is refused as busy. `end()` stops the sign-in and returns only
 * once every run it stopped has finished, so nothing is saved after it.
 */
export function connectFlows(deps: ConnectDeps) {
  const scale = deps.timeScale ?? 1;
  let flow: Flow | undefined;
  /** A begin() still asking the site for a code; calls meanwhile share its answer. */
  let starting: Promise<Checked<Started & { reused: boolean }>> | undefined;
  let startAbort: AbortController | undefined;
  /** Raised by every end(): a start that end() overtook is dropped, never polled. */
  let generation = 0;
  /** Every run not yet finished, the current one and any ended ones. */
  const runs = new Set<Promise<unknown>>();

  const run = async (f: Flow): Promise<Checked<{ label: string }>> => {
    const signal = f.controller.signal;
    const deadline = performance.now() + f.started.expiresIn * 1000 * scale;
    let interval = f.started.interval;
    let lastTransient = "";
    try {
      for (;;) {
        const left = deadline - performance.now();
        if (left <= 0)
          return refuse(
            "timeout",
            `The sign-in was not approved within ${f.started.expiresIn >= 60 ? `${Math.round(f.started.expiresIn / 60)} minutes` : `${f.started.expiresIn} s`}${lastTransient ? ` (last: ${lastTransient})` : ""}.`,
            againFix,
          );
        await sleep(Math.min(interval * 1000 * scale, left), signal);
        if (performance.now() >= deadline) continue;
        const remaining = Math.max(0, Math.round((deadline - performance.now()) / 1000 / scale));
        for (const listener of f.listeners) listener(`Waiting for the person to approve code ${f.started.userCode} at ${f.started.url} (${remaining} s left).`);
        const poll = await pollOnce(deps.origin, deps.fetch, f.started.deviceCode, signal);
        if (poll.kind === "pending") continue;
        if (poll.kind === "slow_down") {
          interval += SLOW_DOWN_S;
          continue;
        }
        if (poll.kind === "transient") {
          lastTransient = poll.detail;
          continue;
        }
        if (poll.kind === "end") return { ok: false, problems: [poll.problem] };
        // Approved: the new token replaces the saved one only now, unless the sign-in was ended.
        if (signal.aborted) return { ok: false, problems: [ended()] };
        try {
          await writeToken(deps.data, deps.origin, poll.token);
        } catch (error) {
          const e = error as Problem;
          return refuse("sign-in", e.message ?? "The connection could not be saved.", e.fix ?? againFix);
        }
        return { ok: true, value: { label: poll.label } };
      }
    } catch {
      if (signal.aborted) return { ok: false, problems: [ended()] };
      return { ok: false, problems: [siteProblem(deps.origin, "Signing in", "the adapter stopped unexpectedly")] };
    } finally {
      f.finished = true;
    }
  };

  const end = async () => {
    generation += 1;
    startAbort?.abort();
    const f = flow;
    flow = undefined;
    f?.controller.abort();
    await starting;
    await Promise.all([...runs]);
  };

  return {
    /** Starts a sign-in, or gives the code of the one pending. */
    async begin(): Promise<Checked<Started & { reused: boolean }>> {
      if (flow && !flow.finished) return { ok: true, value: { ...flow.started, reused: true } };
      if (starting) {
        const s = await starting;
        return s.ok ? { ok: true, value: { ...s.value, reused: true } } : s;
      }
      // A finished one's outcome is dropped: a new sign-in starts over.
      flow = undefined;
      const at = generation;
      const abort = new AbortController();
      startAbort = abort;
      const begun = (async (): Promise<Checked<Started & { reused: boolean }>> => {
        const s = await startConnect(deps.origin, deps.fetch, abort.signal);
        // end() came while the site was asked: this sign-in never starts.
        if (at !== generation) return { ok: false, problems: [ended()] };
        if (!s.ok) return s;
        const f: Flow = {
          started: s.value,
          controller: new AbortController(),
          done: Promise.resolve({ ok: true, value: { label: "" } }),
          finished: false,
          waiting: false,
          listeners: new Set(),
        };
        f.done = run(f);
        const tracked = f.done.finally(() => runs.delete(tracked));
        runs.add(tracked);
        flow = f;
        return { ok: true, value: { ...s.value, reused: false } };
      })();
      starting = begun;
      try {
        return await begun;
      } finally {
        if (starting === begun) starting = undefined;
        if (startAbort === abort) startAbort = undefined;
      }
    },

    /** The outcome of the sign-in begun, reporting each poll to `onWait`. */
    async wait(signal: AbortSignal, onWait: (message: string) => void): Promise<Checked<{ label: string }>> {
      const f = flow;
      if (!f)
        return refuse(
          "sign-in",
          "No sign-in is waiting for approval.",
          "Call connect_account (without wait) first, show the person the link and code, then call connect_account with wait: true.",
        );
      if (f.waiting)
        return refuse(
          "busy",
          "Another connect_account call is already waiting for this sign-in.",
          "Wait for that call to return, or cancel it first.",
        );
      if (signal.aborted) return { ok: false, problems: [stoppedWaiting(f)] };
      f.waiting = true;
      f.listeners.add(onWait);
      let onAbort = () => {};
      const aborted = new Promise<"aborted">((resolve) => {
        onAbort = () => resolve("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        if (!f.finished) onWait(`Waiting for the person to approve code ${f.started.userCode} at ${f.started.url}.`);
        const outcome = await Promise.race([f.done, aborted]);
        // Only this wait stops; the sign-in goes on and the next wait picks it up.
        if (outcome === "aborted") return { ok: false, problems: [stoppedWaiting(f)] };
        // Reported once: the next wait has nothing to wait for.
        if (flow === f) flow = undefined;
        return outcome;
      } finally {
        f.waiting = false;
        f.listeners.delete(onWait);
        signal.removeEventListener("abort", onAbort);
      }
    },

    /** Ends any sign-in: the code stops being polled. */
    end,
    /** For the server's stop(). */
    stop: end,
  };
}
