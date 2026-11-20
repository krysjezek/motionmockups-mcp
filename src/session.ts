// One render, start to finish: the person's Chrome on `<origin>/agent`, driven over the
// pipe. The page renders with the editor's own export code and hands back blob links;
// each is saved by Chrome into `<data>/staging` and streamed from there into
// `motion-mockups/`, never over an existing file.
//
// Steps, in order: check the recording and the output folder; take the render lock; sweep
// what a killed adapter left in staging; launch Chrome on `<data>/chrome-profile`, refusing
// downloads until a file is saved; bridge the page's progress; open the page and
// check its contract; set the recording; render; save each file; release the page; and,
// always, close Chrome, remove this session's staged files and release the lock.
//
// Everything awaited is bounded: every CDP command has its own time limit, and the render
// stops on the caller's signal, the render timeout or a lost lock, whichever comes first.

import { once } from "node:events";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { Cdp } from "./chrome/cdp.ts";
import { problemError, type ProblemError } from "./chrome/cdp.ts";
import { findChrome } from "./chrome/find.ts";
import { launchChrome, openPage, type Chrome, type ChromeStartError } from "./chrome/launch.ts";
import {
  createPartial,
  outputFolder,
  publishOutput,
  readableRecording,
  removeStalePartials,
  safeName,
  type Checked,
  type Problem,
} from "./folders.ts";
import { acquireRenderLock, type Held } from "./lock.ts";

export interface RenderRequest {
  plan: unknown;
  recording?: string;
  name?: string;
  still?: { seconds: number; format: "png" | "jpeg" };
}

export interface Delivered {
  files: { path: string; bytes: number }[];
  warnings: string[];
  notice: string;
}

/**
 * A render's result. A refusal after some files were already saved (file 2 of 3 failed, or the
 * render was cancelled while saving) lists them in `saved`: they stay in motion-mockups/.
 */
export type Rendered = { ok: true; value: Delivered } | { ok: false; problems: Problem[]; saved?: Delivered["files"] };

export interface Progress {
  phase: string;
  completed: number;
  total: number;
  message?: string;
}

export interface SessionContext {
  origin: URL;
  allowed: string[];
  data: string;
  chromeMode: "headless" | "window";
  signal: AbortSignal;
  timeoutMs: number;
  onProgress: (p: Progress) => void;
  /** Starts Chrome; tests wrap it to watch what the session sends. Default launchChrome. */
  launch?: typeof launchChrome;
  /**
   * A Pro render: the agent token the page signs its plate links with. Handed to the page only
   * inside the render call, over Chrome's control pipe; never on Chrome's command line, in its
   * environment, in a URL or in a result. Without it, the render is a free preview.
   */
  pro?: { accessToken: string };
  /**
   * Asked once the render lock is held, before Chrome starts: the refusal when the render may
   * no longer run (the site blocked this adapter while it waited, src/killswitch.ts), else
   * undefined. A render that has started is never stopped by it.
   */
  stillAllowed?: () => Promise<Problem | undefined>;
}

export const FREE_NOTICE =
  "Watermarked preview for evaluation only. Publishing it needs Motion Mockups Pro (https://motionmockups.com/pricing).";
export const PRO_NOTICE = "Clean, full-quality render with Motion Mockups Pro.";

const CONTRACT = 1;
/** Any one CDP command. */
const SEND_MS = 15_000;
/** Page.navigate answers once the response is committed. */
const NAVIGATE_MS = 30_000;
/** For `motionMockupsAgent` to appear: in all, and after the page has finished loading. */
const READY_MS = 60_000;
const READY_AFTER_LOAD_MS = 10_000;
const READY_POLL_MS = 200;
/** The page's cancel(), and the render settling after it (the page removes its staged file on timers). */
const CANCEL_MS = 5_000;
const SETTLE_MS = 10_000;
const RELEASE_MS = 10_000;
/** A saved file starts within this of the click, and never stops moving for longer than the stall. */
const DOWNLOAD_START_MS = 15_000;
const DOWNLOAD_STALL_MS = 60_000;
const WAIT_REPORT_MS = 5_000;
/**
 * Progress pacing: one report per 250 ms for the first 1,000, then one per 2 s up to 1,500,
 * then one per 10 s, and 2,000 at most per render, the final one included. A long render keeps
 * reporting (a client may keep the request alive on them) and is never silent for more than
 * 10 s while the page reports, for at least 250 s + 500 x 2 s + 499 x 10 s = 104 minutes,
 * far past the default 20-minute timeout.
 */
const PROGRESS_STEPS = [
  { until: 1_000, ms: 250 },
  { until: 1_500, ms: 2_000 },
  { until: Infinity, ms: 10_000 },
];
const PROGRESS_CAP = 2_000;
/** What the page's words may take up: they reach the agent's context. */
const WARNINGS_MAX = 20;
const WARNING_CHARS = 500;
const PROBLEMS_MAX = 20;
const CODE_CHARS = 64;
const PROBLEM_CHARS = 1_000;
const EXCEPTION_CHARS = 500;
/** The extensions the page delivers. */
const EXTENSIONS = new Set(["mp4", "png", "jpg"]);
/** The page calls this global for progress; the injected script forwards it to the binding. */
const BINDING = "__motionMockupsAdapterProgress";

const refusal = <T>(problem: Problem): Checked<T> => ({ ok: false, problems: [problem] });

const cancelledProblem = (): ProblemError =>
  problemError("cancelled", "The render was cancelled.", "Nothing to undo. Send the request again when it is wanted.");

const timeoutProblem = (ms: number): ProblemError =>
  problemError(
    "timeout",
    `The render did not finish within ${ms >= 60_000 ? `${Number((ms / 60_000).toFixed(1))} minutes` : `${Math.round(ms / 1000)} s`}.`,
    "Try fewer or shorter clips, or ask the person to raise MOTIONMOCKUPS_TIMEOUT_MINUTES in this MCP server's settings.",
  );

const contractProblem = (detail: string): ProblemError =>
  problemError(
    "contract",
    `The site's agent page does not speak this adapter's contract: ${detail}`,
    "Restart the MCP server so it runs the current motionmockups version (npx -y motionmockups@latest mcp), then try again.",
  );

// This session already holds the render lock, so the Chrome on the profile is most likely
// one left over from a render that was killed, or a window the person opened on it.
const busyProblem = (profile: string): ProblemError =>
  problemError(
    "busy",
    `Another Chrome is already using the adapter's profile (${profile}), most likely one left over from an earlier render.`,
    `If no render is running, close the Chrome that uses ${profile} and try again. If another render is running, wait for it to finish.`,
  );

const hasProblemShape = (value: unknown): value is Problem =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Problem).code === "string" &&
  typeof (value as Problem).message === "string" &&
  typeof (value as Problem).fix === "string";

const asProblem = (error: unknown): Problem =>
  hasProblemShape(error)
    ? { code: error.code, message: error.message, fix: error.fix, ...(error.source === "site" ? { source: "site" as const } : {}) }
    : {
        code: "adapter",
        message: `The render stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
        fix: "Try the render again. If it keeps failing, report it at https://motionmockups.com/contact.",
      };

/**
 * One signal for the render: the caller's cancel, the render timeout and a lost lock. Its
 * reason is a ProblemError naming which: `cancelled`, `timeout`, or the lock's own reason.
 */
export function stopSignal(sources: { signal: AbortSignal; timeoutMs: number; lost: AbortSignal }): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const stop = (reason: ProblemError) => {
    if (!controller.signal.aborted) controller.abort(reason);
    dispose();
  };
  const onCancel = () => stop(cancelledProblem());
  const lostReason = () =>
    hasProblemShape(sources.lost.reason)
      ? (sources.lost.reason as ProblemError)
      : problemError("lock-lost", "The render lock was lost while this render was running.", "Try the render again; it waits its turn.");
  const onLost = () => stop(lostReason());
  let timer: NodeJS.Timeout | undefined;
  const dispose = () => {
    clearTimeout(timer);
    sources.signal.removeEventListener("abort", onCancel);
    sources.lost.removeEventListener("abort", onLost);
  };
  if (sources.signal.aborted) onCancel();
  else if (sources.lost.aborted) onLost();
  else {
    sources.signal.addEventListener("abort", onCancel, { once: true });
    sources.lost.addEventListener("abort", onLost, { once: true });
    const ms = sources.timeoutMs;
    if (Number.isFinite(ms) && ms > 0) timer = setTimeout(() => stop(timeoutProblem(ms)), Math.min(ms, 2 ** 31 - 1));
  }
  return { signal: controller.signal, dispose };
}

/** Rejects with the signal's reason when it aborts; the losing promise's rejection is handled. */
function until<T>(work: Promise<T>, signal: AbortSignal, ms: number, onTimeout: () => Error, also: Promise<never>[] = []): Promise<T> {
  work.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const timedOut = new Promise<never>((_, reject) => {
    if (Number.isFinite(ms)) timer = setTimeout(() => reject(onTimeout()), ms);
  });
  stopped.catch(() => {});
  timedOut.catch(() => {});
  return Promise.race([work, stopped, timedOut, ...also]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

const PROGRESS_TEXT = 200;
const PROGRESS_PAYLOAD = 10_000;
/** `text` cut to at most `max` characters, never through the middle of one. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

const progressText = (v: unknown) => (typeof v === "string" && v ? capText(v, PROGRESS_TEXT) : undefined);

/** An exception the page threw, by its first line only, capped. The page's own words: source site. */
function pageThrew(details: any): ProblemError {
  const detail = String(details?.exception?.description ?? details?.text ?? "an exception").split("\n")[0]!;
  return Object.assign(problemError("page", `The agent page threw: ${capText(detail, EXCEPTION_CHARS)}`, "Try the render again."), {
    source: "site" as const,
  });
}

/** The page's progress payload, checked: texts at most 200 characters, 0 <= completed <= total. Null when it is not progress. */
export function pageProgress(payload: unknown): Progress | null {
  if (typeof payload !== "string" || payload.length > PROGRESS_PAYLOAD) return null;
  let p: any;
  try {
    p = JSON.parse(payload);
  } catch {
    return null;
  }
  const phase = progressText(p?.phase);
  if (!phase || typeof p.completed !== "number" || typeof p.total !== "number" || !Number.isFinite(p.completed) || !Number.isFinite(p.total))
    return null;
  const total = Math.max(0, p.total);
  const completed = Math.min(Math.max(0, p.completed), total);
  const message = progressText(p.file);
  return { phase, completed, total, ...(message ? { message } : {}) };
}

/**
 * Writes `source` (a staged file, or a stream) into `folder` as `<stem>.<ext>`: first under a
 * hidden partial name, then published once whole. A failure removes the partial; a kill
 * leaves only the partial, which a later render removes once it is a day old.
 */
export async function deliverFile(source: string | Readable, folder: string, stem: string, ext: string, signal?: AbortSignal): Promise<string> {
  const partial = await createPartial(folder, stem, ext);
  try {
    const out = partial.handle.createWriteStream();
    const input = typeof source === "string" ? createReadStream(source) : source;
    if (signal) await pipeline(input, out, { signal });
    else await pipeline(input, out);
    if (!out.closed) await once(out, "close");
    return await publishOutput(partial.path, stem, ext);
  } catch (error) {
    await partial.handle.close().catch(() => {});
    await rm(partial.path, { force: true }).catch(() => {});
    throw error;
  }
}

/** A file's identity on its volume, to know it is still the file that was checked. */
async function identity(file: string): Promise<string> {
  const st = await stat(file, { bigint: true });
  return `${st.dev}:${st.ino}`;
}

/** Chrome's download ids are UUIDs; anything else is never joined to a path. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STAGED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.crdownload)?$/i;

/**
 * Removes what an adapter killed while saving left in `staging`: Chrome's download files,
 * named by their GUID (whole or still `.crdownload`). Called with the render lock held, so
 * no other render is using them. Anything not named that way is left alone. Never throws.
 */
export async function sweepStaging(staging: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(staging);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!STAGED.test(name)) continue;
    try {
      await rm(path.join(staging, name), { force: true, maxRetries: 5, retryDelay: 200 });
      removed.push(name);
    } catch {
      // Still held open somewhere; the next render tries again.
    }
  }
  return removed;
}

/** File systems allow 255 characters in a name; the page never makes a longer one. */
const NAME_MAX = 255;

/** A file name the page handed back, as stem and extension; null when it is not one the page makes. */
export function deliveredName(name: unknown): { stem: string; ext: string } | null {
  if (typeof name !== "string" || name.length > NAME_MAX) return null;
  const match = /^(.+)\.([a-z0-9]+)$/i.exec(name);
  if (!match) return null;
  const ext = match[2]!.toLowerCase();
  if (!EXTENSIONS.has(ext)) return null;
  return { stem: match[1]!, ext };
}

interface AgentFile {
  name: string;
  bytes: number;
  url: string;
}
type AgentResult = { ok: true; files: AgentFile[]; warnings: string[] } | { ok: false; problems: Problem[] };

/** The page's result, checked for shape: its refusals pass through unchanged, anything else is a contract problem. */
/**
 * A `site` problem unless `href` (the main frame's URL, as Chrome reports it) is the configured
 * origin's `/agent`. Checked before the recording is handed over and before the render starts:
 * the page may have navigated or rewritten its own URL since it was opened.
 */
export function agentPageProblem(href: string, origin: URL): Problem | null {
  let url: URL | undefined;
  try {
    url = new URL(href);
  } catch {
    url = undefined;
  }
  if (url && url.origin === origin.origin && url.pathname === "/agent") return null;
  return {
    code: "site",
    message: `The page the adapter drives is no longer ${new URL("/agent", origin).href} but ${capText(href, 200)}; nothing was handed to it.`,
    fix: "Try the render again. If it keeps happening, report it at https://motionmockups.com/contact.",
  };
}

export function checkResult(value: unknown, origin: URL): AgentResult {
  const v = value as Record<string, unknown> | null;
  if (typeof v !== "object" || v === null) throw contractProblem("render() answered with no result.");
  if (v.ok === false) {
    if (!Array.isArray(v.problems) || v.problems.length === 0 || !v.problems.every(hasProblemShape))
      throw contractProblem("a refusal without { code, message, fix }.");
    const problems = (v.problems as Problem[]).slice(0, PROBLEMS_MAX).map(({ code, message, fix }) => ({
      code: capText(code, CODE_CHARS),
      message: capText(message, PROBLEM_CHARS),
      fix: capText(fix, PROBLEM_CHARS),
      source: "site" as const,
    }));
    return { ok: false, problems };
  }
  if (v.ok !== true || !Array.isArray(v.files) || v.files.length === 0) throw contractProblem("a result with no files.");
  const prefix = `blob:${origin.origin}/`;
  const files = v.files.map((f: unknown) => {
    const file = f as Record<string, unknown>;
    if (
      typeof file?.name !== "string" ||
      typeof file.url !== "string" ||
      !file.url.startsWith(prefix) ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    )
      throw contractProblem("a file without a name, a size and a blob link on the site.");
    if (file.name.length > NAME_MAX)
      throw problemError(
        "site",
        `The site's agent page named a file with ${file.name.length} characters; a file name has at most ${NAME_MAX}.`,
        "Try the render again in a few minutes. If it keeps happening, report it at https://motionmockups.com/contact.",
      );
    return { name: file.name, bytes: file.bytes, url: file.url };
  });
  const warnings = Array.isArray(v.warnings)
    ? v.warnings
        .filter((w): w is string => typeof w === "string")
        .slice(0, WARNINGS_MAX)
        .map((w) => capText(w, WARNING_CHARS))
    : [];
  return { ok: true, files, warnings };
}

/**
 * Progress, forwarded at the pace PROGRESS_STEPS sets whatever it says (a page changing phase
 * or finishing one on every call is throttled too), and PROGRESS_CAP times per render at most.
 * The one `final` report always goes, once.
 */
export function progressForwarder(onProgress: (p: Progress) => void, now: () => number = () => performance.now()) {
  let last = -Infinity;
  let forwarded = 0;
  let finished = false;
  return (p: Progress, final = false) => {
    const at = now();
    if (final) {
      if (finished) return;
      finished = true;
    } else {
      const gap = PROGRESS_STEPS.find((step) => forwarded < step.until)!.ms;
      if (finished || forwarded >= PROGRESS_CAP - 1 || at - last < gap) return;
      forwarded++;
    }
    last = at;
    try {
      onProgress(p);
    } catch {
      // The listener's errors are its own.
    }
  };
}

export async function renderOnce(request: RenderRequest, context: SessionContext): Promise<Rendered> {
  const report = progressForwarder(context.onProgress);
  if (context.signal.aborted) return refusal(cancelledProblem());

  // 1. The recording, the output folder and Chrome, before anything waits.
  let recording: string | undefined;
  let recordingId = "";
  if (request.recording !== undefined) {
    const checked = await readableRecording(request.recording, context.allowed);
    if (!checked.ok) return checked;
    recording = checked.value.path;
    try {
      recordingId = await identity(recording);
    } catch {
      return refusal(problemError("recording", `${recording} cannot be read.`, "Check that the recording has finished saving, then try again."));
    }
  }
  const output = await outputFolder(context.allowed);
  if (!output.ok) return output;
  const executable = findChrome();
  if (!executable.ok) return executable;
  const baseName = safeName(request.name, request.still ? "motion-mockup-still" : "motion-mockup");

  // 2. The lock: one render at a time per computer.
  let lastWait = -Infinity;
  let held: Held;
  try {
    held = await acquireRenderLock(context.data, {
      signal: context.signal,
      onWait: (holder) => {
        const now = performance.now();
        if (now - lastWait < WAIT_REPORT_MS) return;
        lastWait = now;
        report(
          {
            phase: "waiting",
            completed: 0,
            total: 0,
            message: `Waiting for another render on this computer to finish (pid ${holder.pid}, since ${holder.since}).`,
          },
        );
      },
    });
  } catch (error) {
    return refusal(asProblem(error));
  }
  // The wait may have been long: a block the site set meanwhile refuses before anything starts.
  let blocked: Problem | undefined;
  try {
    blocked = await context.stillAllowed?.();
  } catch {
    // A check that fails blocks nothing, like a catalog that cannot be read.
  }
  if (blocked) {
    await held.release();
    return refusal(blocked);
  }

  const stop = stopSignal({ signal: context.signal, timeoutMs: context.timeoutMs, lost: held.lost });
  const signal = stop.signal;
  const profile = path.join(context.data, "chrome-profile");
  const staging = path.join(context.data, "staging");
  const stagedHere = new Set<string>();
  const delivered: Delivered["files"] = [];
  const unsubscribe: (() => void)[] = [];
  /** Each frame's current page context (the default world), by frame id: its system-unique id. */
  const pageContexts = new Map<string, { id: number; uniqueId: string }>();
  /** The /agent page's context, taken when it was checked; the hand-off and the render run only in it. */
  let agentContext: string | undefined;
  let launching: Promise<Chrome> | undefined;
  let chrome: Chrome | undefined;
  let cdp: Cdp | undefined;
  let sessionId = "";
  /** The page's target id, which is also its main frame's id. */
  let targetId = "";
  let pageReady = false;
  let rendering: Promise<unknown> | undefined;
  let renderSettled = false;

  /** Rejects once Chrome has gone, so nothing waits on a browser that is not there. */
  let gone: Promise<never> = new Promise<never>(() => {});
  const limited = (method: string, ms: number) => () =>
    problemError(
      "chrome",
      `Chrome did not answer ${method} within ${ms / 1000} s.`,
      "Try the render again. If it keeps happening, ask the person to update Google Chrome.",
    );
  /** One CDP command, bounded by its time limit, the render's signal and Chrome's exit. */
  const send = <T = any>(method: string, params: object = {}, ms = SEND_MS, scoped = true): Promise<T> =>
    until(cdp!.send<T>(method, params, scoped ? sessionId : undefined), signal, ms, limited(method, ms), [gone]);
  /** The same, for teardown: bounded by time and Chrome's exit only, not by the (aborted) signal. */
  const sendAfter = <T = any>(method: string, params: object, ms: number, scoped = true): Promise<T> =>
    until(cdp!.send<T>(method, params, scoped ? sessionId : undefined), new AbortController().signal, ms, limited(method, ms), [gone]);
  /**
   * Runs an expression in the page; its exception becomes a problem. No user gesture unless
   * `userGesture` says so: only the download click is given one, never a poll the page could
   * use to open windows, take the clipboard or go full screen.
   */
  const evaluate = async (expression: string, options: { userGesture?: boolean; inAgentPage?: boolean } = {}): Promise<unknown> => {
    const params = {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(options.userGesture ? { userGesture: true } : {}),
      ...(options.inAgentPage ? { uniqueContextId: agentContext } : {}),
    };
    const result: any = await (options.inAgentPage ? inAgentPage(send("Runtime.evaluate", params, SEND_MS)) : send("Runtime.evaluate", params, SEND_MS));
    if (result.exceptionDetails) throw pageThrew(result.exceptionDetails);
    return result.result?.value;
  };
  const leftPage = () =>
    problemError(
      "site",
      "The agent page was replaced by another page after the adapter checked it; nothing more was handed to it.",
      "Try the render again. If it keeps happening, report it at https://motionmockups.com/contact.",
    );
  /** A command bound to the checked page's context: the context being gone (a navigation since) is a `site` refusal. */
  const inAgentPage = <T>(work: Promise<T>): Promise<T> =>
    work.catch((error) => {
      const e = error as { code?: string; message?: string };
      if (e?.code === "cdp" && /context|object with given id/i.test(e.message ?? "")) throw leftPage();
      throw error;
    });
  /**
   * Refuses with `site` unless the main frame is still the origin's /agent (asked of Chrome, not
   * of the page), and takes that page's context: what follows runs only in it, so a navigation
   * after this check makes it fail rather than run in the new page. Checked again later, the
   * context must be the same one.
   */
  const onAgentPage = async () => {
    // The context before and after the URL is read must be one and the same: then the URL is
    // that context's document's, not a page that replaced it in between.
    const before = pageContexts.get(targetId)?.uniqueId;
    const { frameTree } = await send<{ frameTree: { frame: { id: string; url: string } } }>("Page.getFrameTree");
    const problem = agentPageProblem(frameTree.frame.url, context.origin);
    if (problem) throw problemError(problem.code, problem.message, problem.fix);
    const after = frameTree.frame.id === targetId ? pageContexts.get(targetId)?.uniqueId : undefined;
    if (!before || before !== after || (agentContext !== undefined && after !== agentContext)) throw leftPage();
    agentContext = after;
  };

  try {
    // What a render killed mid-copy left here a day or more ago (only the adapter's own partial names).
    await removeStalePartials(output.value);
    // What an adapter killed while saving left in staging (the lock says no render is using it).
    await sweepStaging(staging);

    // 3. Chrome on the adapter's own profile.
    report({ phase: "starting", completed: 0, total: 1, message: "Opening Chrome." });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(staging, 0o700); // an existing one too
    launching = (context.launch ?? launchChrome)({ executable: executable.value, profile, origin: context.origin, mode: context.chromeMode });
    try {
      chrome = await until(launching, signal, Infinity, () => new Error("unreachable"));
    } catch (error) {
      const start = error as ChromeStartError;
      // 21: the profile is in use; 0: a window-mode Chrome handed the request to a Chrome already on it.
      if (start?.code === "chrome-start" && (start.exitCode === 21 || start.exitCode === 0)) throw busyProblem(profile);
      throw error;
    }
    cdp = chrome.cdp;
    const closed = problemError(
      "chrome-closed",
      "The Chrome the adapter was driving closed during the render.",
      "Try the render again. If Chrome keeps closing, ask the person to update Google Chrome.",
    );
    gone = chrome.exited.then(() => {
      throw closed;
    });
    gone.catch(() => {});
    // No download goes anywhere until a file is saved (a window-mode Chrome would otherwise use ~/Downloads).
    await send("Browser.setDownloadBehavior", { behavior: "deny" }, SEND_MS, false);
    ({ sessionId, targetId } = await until(openPage(cdp), signal, SEND_MS * 2, limited("Target.createTarget", SEND_MS * 2), [gone]));

    // 4. The progress bridge, before the page loads.
    unsubscribe.push(
      cdp.on("Runtime.bindingCalled", (params, from) => {
        if (from !== sessionId || params?.name !== BINDING) return;
        const p = pageProgress(params.payload);
        if (p) report(p);
      }),
    );
    unsubscribe.push(
      cdp.on("Runtime.executionContextCreated", (params, from) => {
        const c = params?.context;
        if (from !== sessionId || !c?.auxData?.isDefault || typeof c.auxData.frameId !== "string" || typeof c.uniqueId !== "string") return;
        pageContexts.set(c.auxData.frameId, { id: c.id, uniqueId: c.uniqueId });
      }),
      cdp.on("Runtime.executionContextDestroyed", (params, from) => {
        if (from !== sessionId) return;
        for (const [frame, c] of pageContexts) if (c.id === params?.executionContextId) pageContexts.delete(frame);
      }),
      cdp.on("Runtime.executionContextsCleared", (_params, from) => {
        if (from === sessionId) pageContexts.clear();
      }),
    );
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Runtime.addBinding", { name: BINDING });
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source:
        `(() => { const send = globalThis[${JSON.stringify(BINDING)}]; if (typeof send !== "function") return;` +
        ` globalThis.motionMockupsAgentProgress = (p) => { try { send(JSON.stringify(p)); } catch {} }; })();`,
    });

    // 5. The page, and its contract.
    const page = new URL("/agent", context.origin).href;
    const navigated = await send<{ errorText?: string }>("Page.navigate", { url: page }, NAVIGATE_MS);
    if (navigated.errorText)
      throw problemError(
        "site",
        `${page} could not be opened (${navigated.errorText}).`,
        context.origin.href === "https://motionmockups.com/"
          ? "Check the internet connection, then try again."
          : "Check that the site at MOTIONMOCKUPS_ORIGIN is running, or remove MOTIONMOCKUPS_ORIGIN, then try again.",
      );
    const readySince = performance.now();
    let loadedAt = 0;
    for (;;) {
      const seen = (await evaluate(
        `(() => { const a = globalThis.motionMockupsAgent; return { state: document.readyState, version: a && typeof a === "object" ? a.version : undefined }; })()`,
      )) as { state?: string; version?: unknown } | undefined;
      if (seen?.version !== undefined) {
        if (seen.version !== CONTRACT)
          throw contractProblem(`the page speaks contract ${capText(JSON.stringify(seen.version) ?? "", 100)}, the adapter ${CONTRACT}.`);
        break;
      }
      const now = performance.now();
      if (seen?.state === "complete") loadedAt ||= now;
      if (now - readySince > READY_MS || (loadedAt && now - loadedAt > READY_AFTER_LOAD_MS))
        throw problemError(
          "site",
          `${page} loaded without the agent page on it.`,
          "Try again in a few minutes. If MOTIONMOCKUPS_ORIGIN is set, check that its site was built with the agent page.",
        );
      await until(new Promise((resolve) => setTimeout(resolve, READY_POLL_MS)), signal, Infinity, () => new Error("unreachable"), [gone]);
    }
    pageReady = true;

    // 6. The recording, by its real path; Chrome reads it from disk. Checked again first: the lock
    // wait, the launch and the page load came between, and a folder on the path may have been
    // swapped for a link since.
    if (recording) {
      await onAgentPage();
      const field = (await inAgentPage(
        send("Runtime.evaluate", { expression: `document.getElementById("agent-recording")`, uniqueContextId: agentContext }),
      )) as any;
      const objectId = field?.result?.objectId;
      if (!objectId) throw contractProblem("the page has no #agent-recording.");
      // The last step before the hand-off.
      const again = await readableRecording(request.recording!, context.allowed);
      if (!again.ok) return again;
      const same = again.value.path === recording && (await identity(again.value.path).catch(() => "")) === recordingId;
      if (!same)
        throw problemError(
          "recording",
          `${request.recording} changed while the render waited its turn: it is no longer the file that was checked.`,
          "Let the recording finish saving, then send the request again.",
        );
      await inAgentPage(send("DOM.setFileInputFiles", { files: [again.value.path], objectId }));
    }

    // 7. The render: Pro with the account's token, or a free preview.
    const call = {
      plan: request.plan,
      recording: !!recording,
      ...(context.pro ? { tier: "pro", accessToken: context.pro.accessToken } : { tier: "free" }),
      baseName,
      ...(request.still ? { seconds: request.still.seconds, format: request.still.format } : {}),
    };
    let json: string;
    try {
      json = JSON.stringify(call);
    } catch {
      throw problemError("plan", "The plan could not be sent: it is not plain JSON.", "Send the plan as a JSON object.");
    }
    await onAgentPage();
    // The call is a value handed to a fixed function, never script source: the plan is data, and
    // the token appears in no source text. Bound to the checked page's context, like every
    // command after the check: a page that replaced it never gets the call.
    const params = {
      functionDeclaration: `function (call) { return globalThis.motionMockupsAgent.${request.still ? "still" : "render"}(call); }`,
      arguments: [{ value: JSON.parse(json) }],
      awaitPromise: true,
      returnByValue: true,
      uniqueContextId: agentContext,
    };
    rendering = inAgentPage(cdp.send("Runtime.callFunctionOn", params, sessionId));
    rendering.then(
      () => (renderSettled = true),
      () => (renderSettled = true),
    );
    const answer: any = await until(rendering, signal, Infinity, () => new Error("unreachable"), [gone]);
    if (answer.exceptionDetails) throw pageThrew(answer.exceptionDetails);
    const result = checkResult(answer.result?.value, context.origin);
    if (!result.ok) return { ok: false, problems: result.problems };

    // 8. Each file: saved by Chrome into staging, streamed into motion-mockups/, staging removed.
    const begun = new Map<string, string>(); // url -> guid
    const states = new Map<string, { state: string; received: number; total: number }>();
    let changed: () => void = () => {};
    unsubscribe.push(
      cdp.on("Browser.downloadWillBegin", (params) => {
        if (typeof params?.guid !== "string" || !GUID.test(params.guid) || typeof params.url !== "string") return;
        // Removed in `finally` unless it was saved, whenever the render stops from here on.
        stagedHere.add(params.guid);
        begun.set(params.url, params.guid);
        changed();
      }),
      cdp.on("Browser.downloadProgress", (params) => {
        if (typeof params?.guid !== "string" || typeof params.state !== "string") return;
        states.set(params.guid, { state: params.state, received: Number(params.receivedBytes) || 0, total: Number(params.totalBytes) || 0 });
        changed();
      }),
    );
    /** Resolves when `ready()` gives a value; rejects after `ms` with no change. */
    const waitFor = <T>(ready: () => T | undefined, ms: number, onTimeout: () => Error): Promise<T> => {
      const now = ready();
      if (now !== undefined) return Promise.resolve(now);
      return until(
        new Promise<T>((resolve) => {
          changed = () => {
            const value = ready();
            if (value !== undefined) resolve(value);
          };
        }),
        signal,
        ms,
        onTimeout,
        [gone],
      ).finally(() => (changed = () => {}));
    };

    for (const [index, file] of result.files.entries()) {
      const name = deliveredName(file.name);
      if (!name) throw contractProblem(`${JSON.stringify(file.name)} is not a file name the page makes.`);
      report({ phase: "saving", completed: index, total: result.files.length, message: capText(file.name, PROGRESS_TEXT) });
      await send(
        "Browser.setDownloadBehavior",
        { behavior: "allowAndName", downloadPath: staging, eventsEnabled: true },
        SEND_MS,
        false,
      );
      await evaluate(
        `(() => { const a = document.createElement("a"); a.href = ${JSON.stringify(file.url)}; a.download = ${JSON.stringify(file.name)};` +
          ` document.body.append(a); a.click(); a.remove(); })()`,
        { userGesture: true, inAgentPage: true },
      );
      const guid = await waitFor(
        () => begun.get(file.url),
        DOWNLOAD_START_MS,
        () => problemError("download", `Chrome did not start saving ${file.name}.`, "Try the render again."),
      );
      // Each change of state restarts the stall limit.
      let lastReceived = -1;
      for (;;) {
        const s = await waitFor(
          () => {
            const s = states.get(guid);
            return s && (s.state !== "inProgress" || s.received !== lastReceived) ? s : undefined;
          },
          DOWNLOAD_STALL_MS,
          () => problemError("download", `Saving ${file.name} stalled.`, "Try the render again."),
        );
        if (s.state === "completed") break;
        if (s.state === "canceled") throw problemError("download", `Chrome stopped saving ${file.name}.`, "Try the render again.");
        lastReceived = s.received;
      }
      const from = path.join(staging, guid);
      const size = (await stat(from)).size;
      if (size !== file.bytes)
        throw problemError("download", `${file.name} was saved with ${size} bytes, not ${file.bytes}.`, "Try the render again.");

      let saved: string;
      try {
        saved = await deliverFile(from, output.value, name.stem, name.ext, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw problemError(
          "output",
          `${file.name} could not be written to ${output.value}: ${(error as Error).message}`,
          `Check that ${output.value} can be written to and has room.`,
        );
      }
      await rm(from, { force: true });
      stagedHere.delete(guid);
      delivered.push({ path: saved, bytes: size });
    }
    report({ phase: "saving", completed: result.files.length, total: result.files.length }, true); // the final report
    await send("Browser.setDownloadBehavior", { behavior: "deny" }, SEND_MS, false).catch(() => {});

    // 9. The page lets go of its links, its staged files and the recording.
    pageReady = false;
    await sendAfter("Runtime.evaluate", { expression: "motionMockupsAgent.release()", awaitPromise: true }, RELEASE_MS).catch(() => {});

    return { ok: true, value: { files: delivered, warnings: result.warnings, notice: context.pro ? PRO_NOTICE : FREE_NOTICE } };
  } catch (error) {
    // A stop wins over whatever it interrupted: say why the render stopped. Files already saved stay, and are named.
    const problems = [asProblem(signal.aborted ? signal.reason : error)];
    return delivered.length ? { ok: false, problems, saved: [...delivered] } : { ok: false, problems };
  } finally {
    stop.dispose();
    // Downloads denied first: nothing the page does while it is cancelled or released is saved.
    if (cdp) await sendAfter("Browser.setDownloadBehavior", { behavior: "deny" }, SEND_MS, false).catch(() => {});
    if (cdp && pageReady) {
      // The page's cancel(), then the render settling (the page removes its staged file), then release().
      if (rendering && !renderSettled) {
        await sendAfter("Runtime.evaluate", { expression: "motionMockupsAgent.cancel()" }, CANCEL_MS).catch(() => {});
        await until(rendering, new AbortController().signal, SETTLE_MS, () => new Error("settle"), [gone]).catch(() => {});
      }
      await sendAfter("Runtime.evaluate", { expression: "motionMockupsAgent.release()", awaitPromise: true }, RELEASE_MS).catch(() => {});
    }
    for (const off of unsubscribe) off();
    // 10. Chrome closed (a launch still under way is waited for and closed), staged files removed, lock released.
    if (!chrome && launching) chrome = await launching.catch(() => undefined);
    await chrome?.close().catch(() => {});
    for (const guid of stagedHere) {
      await rm(path.join(staging, guid), { force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
      await rm(path.join(staging, `${guid}.crdownload`), { force: true }).catch(() => {});
    }
    await held.release();
  }
}
