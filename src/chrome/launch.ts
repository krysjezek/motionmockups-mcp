// Launching the person's Chrome with the adapter's own empty profile, driven over
// `--remote-debugging-pipe` (never a TCP debugging port, which any local process
// could reach). Every request outside the allowed hosts goes to a proxy that is
// not there (127.0.0.1:9, the discard port), so it fails.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { Cdp, problemError } from "./cdp.ts";

export interface ChromeOptions {
  executable: string;
  profile: string;
  origin: URL;
  mode: "headless" | "window";
}

export interface Chrome {
  cdp: Cdp;
  /** The browser process; its children are the renderers, GPU and utility processes. */
  pid: number;
  /** Closes Chrome: `Browser.close`, then after 5 s the whole process tree is killed. Safe to call twice. */
  close(): Promise<void>;
  /** Chrome's exit code, or null when it was ended by a signal or never started. */
  exited: Promise<number | null>;
}

const START_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 5_000;
const KILL_WAIT_MS = 5_000;
const ALLOWED_HOSTS = ["assets.motionmockups.com:443", "*.r2.cloudflarestorage.com:443"];

/** `host:port`, with the scheme's default port spelled out: a rule without a port matches every port. */
const hostAndPort = (url: URL) => `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;

/**
 * The host rules. `<-loopback>` comes first and always: without it Chrome sends every
 * loopback request around the proxy, so a page could reach any local service. Rules
 * after it win, so a loopback origin is still reached (its own host and port only).
 * Every rule names its port, so none of them re-opens a host's other ports.
 */
function bypassList(origin: URL): string {
  return ["<-loopback>", hostAndPort(origin), ...ALLOWED_HOSTS].join(";");
}

export function chromeArgs(options: ChromeOptions): string[] {
  return [
    "--remote-debugging-pipe",
    `--user-data-dir=${options.profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--proxy-server=http://127.0.0.1:9",
    `--proxy-bypass-list=${bypassList(options.origin)}`,
    // WebRTC sends UDP around the HTTP proxy (STUN reaches any host). This policy gathers no
    // UDP candidate at all; the `--force-webrtc-ip-handling-policy` spelling does not, on Chrome 156.
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    // A fresh profile asks the system keyring (Linux) or keychain (macOS) to store its secrets,
    // which can show the person a dialog mid-render. These keep them in the profile instead.
    "--password-store=basic",
    "--use-mock-keychain",
    // No crash report leaves the machine (Chrome 156 has no --disable-crash-reporter switch).
    "--disable-breakpad",
    ...(options.mode === "headless" ? ["--headless"] : ["--window-position=-32000,-32000", "--window-size=1280,800"]),
    "about:blank",
  ];
}

/** taskkill by its full path: the adapter's PATH is whatever the MCP client passed, maybe nothing. */
function taskkillPath(): string {
  const root = process.env.SYSTEMROOT?.trim() || process.env.windir?.trim() || "C:\\Windows";
  return path.win32.join(path.win32.isAbsolute(root) ? root : "C:\\Windows", "System32", "taskkill.exe");
}

/** Kills Chrome and every process it started; falls back to killing Chrome alone. Always settles. */
function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  const alone = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  };
  if (pid === undefined) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile(taskkillPath(), ["/T", "/F", "/PID", String(pid)], { windowsHide: true, timeout: KILL_WAIT_MS }, (error) => {
        if (error) alone();
        resolve();
      });
    });
  }
  try {
    process.kill(-pid, "SIGKILL"); // The process group: spawned with `detached: true`.
  } catch {
    alone();
  }
  return Promise.resolve();
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const PROFILE_IN_USE = 21; // Chrome's RESULT_CODE_PROFILE_IN_USE.

const exitDetail = (code: number | null, stderr: string) =>
  code === PROFILE_IN_USE
    ? "the profile is in use by another Chrome (exit code 21)."
    : `it exited with code ${code}. ${stderr.trim()}`.trim();

/** A `chrome-start` refusal; `exitCode` is set when Chrome ended on its own (0: it handed off to a running Chrome, 21: profile in use). */
export type ChromeStartError = ReturnType<typeof problemError> & { exitCode?: number | null };

const startProblem = (detail: string, exitCode?: number | null): ChromeStartError =>
  Object.assign(
    problemError(
      "chrome-start",
      `Chrome did not start: ${detail}`,
      "Make sure Google Chrome is installed and up to date (https://www.google.com/chrome/), or ask the person to set " +
        "MOTIONMOCKUPS_CHROME in this MCP server's settings to the full path of their Chrome executable.",
    ),
    exitCode === undefined ? {} : { exitCode },
  );

export async function launchChrome(options: ChromeOptions): Promise<Chrome> {
  // The profile holds the page's storage: the person's alone.
  fs.mkdirSync(options.profile, { recursive: true, mode: 0o700 });
  const child = spawn(options.executable, chromeArgs(options), {
    // fd 3 is Chrome's input, fd 4 its output.
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  // Chrome writes to stderr freely; read it so it never blocks, keep the end for errors.
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (text: string) => (stderr = (stderr + text).slice(-2000)));
  child.stderr?.on("error", () => {}); // A broken stderr pipe is not worth crashing the adapter for.

  let spawnError: Error | undefined;
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", (error) => {
      spawnError = error;
      resolve(null);
    });
  });
  let gone = false;
  void exited.then(() => (gone = true));

  const cdp = new Cdp(child.stdio[3] as NodeJS.WritableStream, child.stdio[4] as NodeJS.ReadableStream);
  void exited.then(() => cdp.close());

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      if (!gone) {
        cdp.send("Browser.close").catch(() => {});
        let timer: NodeJS.Timeout | undefined;
        const graceful = await Promise.race([
          exited.then(() => true),
          new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), CLOSE_GRACE_MS))),
        ]);
        clearTimeout(timer);
        if (!graceful) {
          await killTree(child);
          // Bounded: close() must settle even if nothing could end Chrome.
          await Promise.race([exited, delay(KILL_WAIT_MS)]);
        }
      }
      cdp.close();
    })());

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      cdp.send("Browser.getVersion"),
      exited.then((code) => {
        throw spawnError ? startProblem(spawnError.message) : startProblem(exitDetail(code, stderr), code);
      }),
      new Promise((_, reject) => (timer = setTimeout(() => reject(startProblem(`no answer within ${START_TIMEOUT_MS / 1000} s.`)), START_TIMEOUT_MS))),
    ]);
  } catch (error) {
    await close();
    if ((error as { code?: string }).code === "chrome-start") throw error;
    // The pipe closed because Chrome ended: say how it ended rather than "closed".
    const code = await Promise.race([exited, delay(KILL_WAIT_MS).then(() => null)]);
    throw spawnError ? startProblem(spawnError.message) : startProblem(exitDetail(code, stderr), code);
  } finally {
    clearTimeout(timer);
  }

  return { cdp, pid: child.pid!, close, exited };
}

/** Opens a new page and attaches a flat session to it, for session-scoped sends and events. */
export async function openPage(cdp: Cdp, url = "about:blank"): Promise<{ targetId: string; sessionId: string }> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  return { targetId, sessionId };
}
