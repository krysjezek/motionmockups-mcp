// Launching the person's Chrome with the adapter's own empty profile, driven over
// `--remote-debugging-pipe` (never a TCP debugging port, which any local process
// could reach). Every request outside the allowed hosts goes to a proxy that is
// not there (127.0.0.1:9, the discard port), so it fails.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";

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
const ALLOWED_HOSTS = ["assets.motionmockups.com", "*.r2.cloudflarestorage.com"];

/**
 * The host rules. `<-loopback>` comes first and always: without it Chrome sends every
 * loopback request around the proxy, so a page could reach any local service. Rules
 * after it win, so a loopback origin is still reached (its own host and port only).
 */
function bypassList(origin: URL): string {
  return ["<-loopback>", origin.host, ...ALLOWED_HOSTS].join(";");
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
    ...(options.mode === "headless" ? ["--headless"] : ["--window-position=-32000,-32000", "--window-size=1280,800"]),
    "about:blank",
  ];
}

/** Kills Chrome and every process it started. */
function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, () => resolve());
    });
  }
  try {
    process.kill(-pid, "SIGKILL"); // The process group: spawned with `detached: true`.
  } catch {
    // Already gone.
  }
  return Promise.resolve();
}

const startProblem = (detail: string) =>
  problemError(
    "chrome-start",
    `Chrome did not start: ${detail}`,
    "Make sure Google Chrome is installed and up to date (https://www.google.com/chrome/), or ask the person to set " +
      "MOTIONMOCKUPS_CHROME in this MCP server's settings to the full path of their Chrome executable.",
  );

export async function launchChrome(options: ChromeOptions): Promise<Chrome> {
  fs.mkdirSync(options.profile, { recursive: true });
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
        if (!graceful && child.pid !== undefined) {
          await killTree(child.pid);
          await exited;
        }
      }
      cdp.close();
    })());

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      cdp.send("Browser.getVersion"),
      exited.then((code) => {
        throw startProblem(spawnError ? spawnError.message : `it exited with code ${code}. ${stderr.trim()}`.trim());
      }),
      new Promise((_, reject) => (timer = setTimeout(() => reject(startProblem(`no answer within ${START_TIMEOUT_MS / 1000} s.`)), START_TIMEOUT_MS))),
    ]);
  } catch (error) {
    await close();
    if ((error as { code?: string }).code === "chrome-start") throw error;
    // The pipe closed because Chrome ended: say how it ended rather than "closed".
    const code = await exited;
    throw startProblem(spawnError ? spawnError.message : `it exited with code ${code}. ${stderr.trim()}`.trim());
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
