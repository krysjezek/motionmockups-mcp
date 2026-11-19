// One render at a time per computer. Every agent starts its own adapter, and every render
// drives Chrome on the one shared profile `<data>/chrome-profile`, which Chrome refuses to open
// twice. So a render first takes `<data>/render.lock`: created exclusively, holding
// `{ pid, since, token }`. Other adapters wait for it and report who they are waiting for.
//
// A lock is stale, and taken over, when
//   - its pid is gone (`process.kill(pid, 0)` throws ESRCH): at once; or
//   - the waiter has itself watched it unchanged for STALE_MS. The holder touches the file's
//     modified time every BEAT_MS, so a live holder changes it well within that; a lock left by a
//     crashed process whose pid now belongs to something else (PID reuse) stops changing, so it
//     cannot block forever. Asking Windows for a process's start time instead would cost a
//     PowerShell or WMI round trip on every poll.
//   - it is empty or not a lock, and the waiter has watched it so for UNWRITTEN_MS (a crash
//     between create and write).
// "Unchanged" is judged on the waiter's own monotonic clock, never by comparing the file's
// time with the wall clock: after a laptop sleeps, a clock jump or on a network folder whose
// server clock is skewed, an old-looking time is not a dead holder. Only sightings at most
// BEAT_MS apart add up, so a sleep during the watch (which the monotonic clock may count) or a
// stalled waiter starts the watch again rather than counting as time watched.
// Taking over is serialised by a second exclusive file, `render.lock.claim`: the claimant
// re-reads the lock and deletes it only if it is exactly the one judged stale, so two waiters
// cannot delete each other's fresh lock. Then every waiter races the exclusive create again.

import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { chmod, mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { problemError, type ProblemError } from "./chrome/cdp.ts";

export interface Held {
  /**
   * Aborts if the lock stops being this holder's while it is held: the file was deleted or
   * another render took it over. Its reason is a ProblemError (`lock-lost`). Stop rendering.
   */
  readonly lost: AbortSignal;
  /** Deletes the lock if it is still this holder's. Never rejects; calling it again does nothing. */
  release(): Promise<void>;
}

export interface LockOptions {
  /** Aborting while waiting rejects with `code: "cancelled"`. */
  signal?: AbortSignal;
  /** Called on every poll while another live render holds the lock. */
  onWait?: (holder: { pid: number; since: string }) => void;
  /** How often a waiter looks again, in ms. Default 500; at most BEAT_MS / 2, so its sightings stay close together. */
  pollMs?: number;
  /** How often the holder beats, in ms. Default BEAT_MS; tests shorten these three. */
  beatMs?: number;
  /** How long a waiter watches a live pid's lock unchanged before taking it over. Default STALE_MS. */
  staleMs?: number;
  /** How long a waiter watches an empty or invalid lock before taking it over. Default UNWRITTEN_MS. */
  unwrittenMs?: number;
}

export const LOCK_NAME = "render.lock";
const CLAIM_NAME = "render.lock.claim";
export const BEAT_MS = 10_000;
export const STALE_MS = 60_000;
export const UNWRITTEN_MS = 5_000;
/** A claim is held for a few file operations; one unchanged this long was left by a crash. */
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

const lostProblem = (): ProblemError =>
  problemError(
    "lock-lost",
    "Another render on this computer took over the render lock while this render was running.",
    "Try the render again; it waits its turn.",
  );

type Look =
  | { kind: "free" }
  | { kind: "unsure" } // being deleted or unreadable for now: look again later
  | { kind: "present"; key: string; holder: Holder | null };

/**
 * The lock as one consistent reading: its time and content come from the same open handle,
 * so a lock replaced mid-read is never paired with its predecessor's time. `key` changes
 * whenever the file is replaced, rewritten or beaten.
 */
async function look(file: string): Promise<Look> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    // Windows reports a file that is being deleted as EPERM until its last handle closes.
    return errno(error) === "ENOENT" ? { kind: "free" } : { kind: "unsure" };
  }
  try {
    const st = await handle.stat({ bigint: true });
    const raw = await handle.readFile("utf8");
    return { kind: "present", key: `${st.ino}:${st.mtimeNs}:${raw}`, holder: parse(raw) };
  } catch {
    return { kind: "unsure" };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * How long, on this process's monotonic clock, something has been watched with the same key.
 * Only sightings close together count: after a gap longer than `gapMs` (a laptop asleep, which
 * Windows' performance counter may count; this process stalled) the watch starts again, because
 * nothing was watched in that gap and the holder's own beat may simply not have run yet.
 */
export class Watch {
  private key = "";
  private since = 0;
  private last = 0;
  private readonly gapMs: number;
  private readonly now: () => number;
  constructor(gapMs: number = BEAT_MS, now: () => number = () => performance.now()) {
    this.gapMs = gapMs;
    this.now = now;
  }
  unchangedFor(key: string): number {
    const now = this.now();
    if (key !== this.key || now - this.last > this.gapMs) {
      this.key = key;
      this.since = now;
    }
    this.last = now;
    return now - this.since;
  }
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

/** Deletes the lock under the claim, only if it still reads exactly as `judged`. True when it did. */
async function takeOver(file: string, judged: string, claimWatch: Watch): Promise<boolean> {
  const claim = path.join(path.dirname(file), CLAIM_NAME);
  let handle;
  try {
    handle = await open(claim, "wx");
  } catch {
    // Someone else is taking over. A claim left unchanged by a crash is cleared for the next poll.
    try {
      const st = await stat(claim, { bigint: true });
      if (claimWatch.unchangedFor(`${st.ino}:${st.mtimeNs}`) > CLAIM_STALE_MS) await unlink(claim);
    } catch {}
    return false;
  }
  try {
    await handle.close();
    // Read again under the claim: it may have beaten, or been taken over and replaced, since.
    const now = await look(file);
    if (now.kind !== "present" || now.key !== judged) return false;
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
    const seen = await look(file);
    if (seen.kind === "present" && seen.holder?.token === token) await unlink(file);
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
  const lost = new AbortController();
  const onExit = () => {
    // Synchronous, and never throws: an exception here would replace the exit code.
    try {
      if (released) return;
      released = true;
      if (parse(readFileSync(file, "utf8"))?.token === me.token) unlinkSync(file);
    } catch {}
  };
  process.on("exit", onExit);
  const stop = () => {
    clearInterval(beat);
    process.off("exit", onExit);
  };
  const beat = setInterval(async () => {
    let handle;
    try {
      handle = await open(file, "r+");
    } catch (error) {
      if (errno(error) === "ENOENT" && !released) {
        stop();
        lost.abort(lostProblem());
      }
      return; // anything else (EPERM, EBUSY) passes; the next beat tries again
    }
    try {
      // The same handle is read and touched: a lock replaced in between is never touched.
      if (parse(await handle.readFile("utf8"))?.token !== me.token) {
        if (!released) {
          stop();
          lost.abort(lostProblem());
        }
        return;
      }
      const now = new Date();
      await handle.utimes(now, now);
    } catch {
    } finally {
      await handle.close().catch(() => {});
    }
  }, beatMs);
  beat.unref();
  return {
    lost: lost.signal,
    async release() {
      if (released) return;
      released = true;
      stop();
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
  const { signal, onWait, beatMs = BEAT_MS, staleMs = STALE_MS, unwrittenMs = UNWRITTEN_MS } = options;
  const pollMs = Math.min(Math.max(Number(options.pollMs ?? 500) || 500, 1), BEAT_MS / 2);
  if (signal?.aborted) throw cancelled();
  const file = path.join(folder, LOCK_NAME);
  const me: Holder = { pid: process.pid, since: "", token: randomUUID() };
  try {
    // The person's alone: the lock, staging and Chrome profile live here.
    await mkdir(folder, { recursive: true, mode: 0o700 });
    // An existing one too: the adapter owns it. (Windows has no such modes.)
    if (process.platform !== "win32") await chmod(folder, 0o700);
  } catch (error) {
    throw lockProblem(folder, (error as Error).message);
  }

  const lockWatch = new Watch();
  const claimWatch = new Watch();
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
    if (seen.kind === "present") {
      const unchanged = lockWatch.unchangedFor(seen.key);
      const stale = seen.holder ? !isAlive(seen.holder.pid) || unchanged > staleMs : unchanged > unwrittenMs;
      if (stale && (await takeOver(file, seen.key, claimWatch))) continue;
      if (!stale && seen.holder) onWait?.({ pid: seen.holder.pid, since: seen.holder.since });
    }
    if (seen.kind === "free") {
      // Windows refuses a create while a deleted lock's last handle is open; that passes in
      // moments. Refused for longer with nothing there means the folder cannot be written.
      refusedSince ||= performance.now();
      if (performance.now() - refusedSince > unwrittenMs) throw lockProblem(folder, "a new file could not be created there.");
    } else {
      refusedSince = 0;
    }
    await sleep(pollMs, signal);
  }
}
