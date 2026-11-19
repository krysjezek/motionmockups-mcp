// One render at a time per computer. Every agent starts its own adapter, and every render
// drives Chrome on the one shared profile `<data>/chrome-profile`, which Chrome refuses to open
// twice. So a render first takes `<data>/render.lock`: created exclusively, holding
// `{ pid, since, token }`. Other adapters wait for it and report who they are waiting for.
//
// A lock is stale, and taken over, when
//   - its pid is gone (`process.kill(pid, 0)` throws ESRCH), or
//   - its holder has not beaten for STALE_MS. The holder touches the file's modified time
//     every BEAT_MS; a lock left by a crashed process whose pid now belongs to something else
//     (PID reuse) stops beating, so it cannot block forever. Touching the time, not rewriting
//     the content, means a reader never sees a half-written beat; and it costs one call where
//     asking Windows for a process's start time costs a PowerShell or WMI round trip.
//   - it is empty or unreadable as a lock for UNWRITTEN_MS (a crash between create and write).
// Taking over is serialised by a second exclusive file, `render.lock.claim`: the claimant
// re-checks the lock is still stale before deleting it, so two waiters that both judged it
// stale cannot delete each other's fresh lock. Then every waiter races the exclusive create again.

import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, open, readFile, stat, unlink, utimes } from "node:fs/promises";
import path from "node:path";

import { problemError, type ProblemError } from "./chrome/cdp.ts";

export interface Held {
  /** Deletes the lock if it is still this holder's. Never rejects; calling it again does nothing. */
  release(): Promise<void>;
}

export interface LockOptions {
  /** Aborting while waiting rejects with `code: "cancelled"`. */
  signal?: AbortSignal;
  /** Called on every poll while another live render holds the lock. */
  onWait?: (holder: { pid: number; since: string }) => void;
  /** How often a waiter looks again, in ms. Default 500. */
  pollMs?: number;
  /** How often the holder beats, in ms. Default BEAT_MS; tests shorten it. */
  beatMs?: number;
}

export const LOCK_NAME = "render.lock";
const CLAIM_NAME = "render.lock.claim";
export const BEAT_MS = 10_000;
export const STALE_MS = 60_000;
export const UNWRITTEN_MS = 5_000;
/** A claim is held for a few file operations; one this old was left by a crash. */
const CLAIM_STALE_MS = 10_000;

interface Holder {
  pid: number;
  since: string;
  token: string;
}

type Kill = (pid: number, signal: number) => unknown;

/** True unless the process is known to be gone. EPERM is a live process another user owns. */
export function isAlive(pid: number, kill: Kill = (p, s) => process.kill(p, s)): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parse(raw: string): Holder | null {
  try {
    const v = JSON.parse(raw) as Partial<Holder> | null;
    if (!v || !Number.isSafeInteger(v.pid) || v.pid! <= 0) return null;
    if (typeof v.since !== "string" || typeof v.token !== "string") return null;
    return { pid: v.pid!, since: v.since, token: v.token };
  } catch {
    return null;
  }
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;

const cancelled = (): ProblemError =>
  problemError(
    "cancelled",
    "The render was cancelled while it waited for another render on this computer to finish.",
    "Nothing to undo. Start the render again when it is wanted.",
  );

const lockProblem = (folder: string, detail: string): ProblemError =>
  problemError(
    "render-lock",
    `The render lock in ${folder} could not be used: ${detail}`,
    `Check that ${folder} can be written to, or ask the person to set MOTIONMOCKUPS_DATA in this MCP server's settings ` +
      "to a folder that can.",
  );

type Look =
  | { kind: "free" }
  | { kind: "held"; holder: Holder }
  | { kind: "stale" }
  | { kind: "unsure" }; // being written, being deleted, or unreadable for now: look again later

async function look(file: string): Promise<Look> {
  let raw: string;
  let mtime: number;
  try {
    mtime = (await stat(file)).mtimeMs;
    raw = await readFile(file, "utf8");
  } catch (error) {
    // Windows reports a file that is being deleted as EPERM until its last handle closes.
    return errno(error) === "ENOENT" ? { kind: "free" } : { kind: "unsure" };
  }
  // Absolute: a clock set back leaves a future time, which the next beat corrects.
  const age = Math.abs(Date.now() - mtime);
  const holder = parse(raw);
  if (!holder) return age > UNWRITTEN_MS ? { kind: "stale" } : { kind: "unsure" };
  if (!isAlive(holder.pid) || age > STALE_MS) return { kind: "stale" };
  return { kind: "held", holder };
}

/** Creates the lock exclusively. False when it exists (or, on Windows, is still being deleted). */
async function create(file: string, me: Holder): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, "wx");
  } catch (error) {
    const code = errno(error);
    if (code === "EEXIST" || code === "EBUSY" || (code === "EPERM" && process.platform === "win32")) return false;
    throw error;
  }
  me.since = new Date().toISOString();
  try {
    await handle.writeFile(JSON.stringify(me));
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(file).catch(() => {});
    throw error;
  }
  return true;
}

/** Deletes a stale lock under the claim. True when this call deleted it. */
async function takeOver(file: string): Promise<boolean> {
  const claim = path.join(path.dirname(file), CLAIM_NAME);
  let handle;
  try {
    handle = await open(claim, "wx");
  } catch {
    // Someone else is taking over. A claim left by a crash is cleared for the next poll.
    try {
      if (Math.abs(Date.now() - (await stat(claim)).mtimeMs) > CLAIM_STALE_MS) await unlink(claim);
    } catch {}
    return false;
  }
  try {
    await handle.close();
    // Looked at again under the claim: another waiter may have taken it over since.
    if ((await look(file)).kind !== "stale") return false;
    await unlink(file);
    return true;
  } catch {
    return false;
  } finally {
    await unlink(claim).catch(() => {});
  }
}

/** Reads the lock and deletes it only if it holds `token`. Never throws. */
async function removeIfMine(file: string, token: string): Promise<void> {
  try {
    if (parse(await readFile(file, "utf8"))?.token === token) await unlink(file);
  } catch {}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function hold(file: string, me: Holder, beatMs: number): Held {
  let released = false;
  const onExit = () => {
    // Synchronous, and never throws: an exception here would replace the exit code.
    try {
      if (released) return;
      released = true;
      if (parse(readFileSync(file, "utf8"))?.token === me.token) unlinkSync(file);
    } catch {}
  };
  process.on("exit", onExit);
  const beat = setInterval(async () => {
    try {
      if (parse(await readFile(file, "utf8"))?.token !== me.token) return;
      const now = new Date();
      await utimes(file, now, now);
    } catch {}
  }, beatMs);
  beat.unref();
  return {
    async release() {
      if (released) return;
      released = true;
      clearInterval(beat);
      process.off("exit", onExit);
      await removeIfMine(file, me.token);
    },
  };
}

/**
 * Waits until no other render on this computer holds `<folder>/render.lock`, then takes it.
 * Rejects only with a ProblemError (`Error & { code, message, fix }`): `cancelled` when the
 * signal aborts first, `render-lock` when the folder cannot be written.
 */
export async function acquireRenderLock(folder: string, options: LockOptions = {}): Promise<Held> {
  const { signal, onWait, pollMs = 500, beatMs = BEAT_MS } = options;
  if (signal?.aborted) throw cancelled();
  const file = path.join(folder, LOCK_NAME);
  const me: Holder = { pid: process.pid, since: "", token: randomUUID() };
  try {
    await mkdir(folder, { recursive: true });
  } catch (error) {
    throw lockProblem(folder, (error as Error).message);
  }

  let refusedSince = 0; // when creating first failed while nothing was there to wait for
  for (;;) {
    if (signal?.aborted) throw cancelled();
    let created: boolean;
    try {
      created = await create(file, me);
    } catch (error) {
      throw lockProblem(folder, (error as Error).message);
    }
    if (created) {
      if (signal?.aborted) {
        await removeIfMine(file, me.token);
        throw cancelled();
      }
      return hold(file, me, beatMs);
    }

    const seen = await look(file);
    if (seen.kind === "stale" && (await takeOver(file))) continue;
    if (seen.kind === "held") onWait?.({ pid: seen.holder.pid, since: seen.holder.since });
    if (seen.kind === "free") {
      // Windows refuses a create while a deleted lock's last handle is open; that passes in
      // moments. Refused for longer with nothing there means the folder cannot be written.
      refusedSince ||= Date.now();
      if (Date.now() - refusedSince > UNWRITTEN_MS) throw lockProblem(folder, "a new file could not be created there.");
    } else {
      refusedSince = 0;
    }
    await sleep(pollMs, signal);
  }
}
