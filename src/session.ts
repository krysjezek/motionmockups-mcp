// One render, start to finish: the person's Chrome on `<origin>/agent`, driven over the
// pipe. The page renders with the editor's own export code and hands back blob links;
// each is saved by Chrome into `<data>/staging` and streamed from there into
// `motion-mockups/`, never over an existing file.
//
// Steps, in order: check the recording and the output folder; take the render lock;
// launch Chrome on `<data>/chrome-profile`; bridge the page's progress; open the page and
// check its contract; set the recording; render; save each file; release the page; and,
// always, close Chrome, remove this session's staged files and release the lock.
//
// Everything awaited is bounded: every CDP command has its own time limit, and the render
// stops on the caller's signal, the render timeout or a lost lock, whichever comes first.

import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { Cdp } from "./chrome/cdp.ts";
import { problemError, type ProblemError } from "./chrome/cdp.ts";
import { findChrome } from "./chrome/find.ts";
import { launchChrome, openPage, type Chrome, type ChromeStartError } from "./chrome/launch.ts";
import { createOutput, outputFolder, readableRecording, safeName, type Checked, type Problem } from "./folders.ts";
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
}

export const FREE_NOTICE =
  "Watermarked preview for evaluation only. Publishing it needs Motion Mockups Pro (https://motionmockups.com/pricing).";

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
const PROGRESS_MS = 250;
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

const busyProblem = (profile: string): ProblemError =>
  problemError(
    "busy",
    `Another Chrome is using the adapter's profile (${profile}).`,
    "Another render is running on this computer. Wait for it to finish, then try the render again.",
  );

const hasProblemShape = (value: unknown): value is Problem =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Problem).code === "string" &&
  typeof (value as Problem).message === "string" &&
  typeof (value as Problem).fix === "string";

const asProblem = (error: unknown): Problem =>
  hasProblemShape(error)
    ? { code: error.code, message: error.message, fix: error.fix }
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

/** A file name the page handed back, as stem and extension; null when it is not one the page makes. */
export function deliveredName(name: unknown): { stem: string; ext: string } | null {
  if (typeof name !== "string") return null;
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
function checkResult(value: unknown, origin: URL): AgentResult {
  const v = value as Record<string, unknown> | null;
  if (typeof v !== "object" || v === null) throw contractProblem("render() answered with no result.");
  if (v.ok === false) {
    if (!Array.isArray(v.problems) || v.problems.length === 0 || !v.problems.every(hasProblemShape))
      throw contractProblem("a refusal without { code, message, fix }.");
    return { ok: false, problems: (v.problems as Problem[]).map(({ code, message, fix }) => ({ code, message, fix })) };
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
    return { name: file.name, bytes: file.bytes, url: file.url };
  });
  const warnings = Array.isArray(v.warnings) ? v.warnings.filter((w): w is string => typeof w === "string") : [];
  return { ok: true, files, warnings };
}

/** What the page reports, forwarded at most every PROGRESS_MS except on a change of phase or the end of one. */
function progressForwarder(onProgress: (p: Progress) => void) {
  let last = 0;
  let phase = "";
  return (p: Progress, force = false) => {
    const now = performance.now();
    if (!force && p.phase === phase && p.completed < p.total && now - last < PROGRESS_MS) return;
    last = now;
    phase = p.phase;
    try {
      onProgress(p);
    } catch {
      // The listener's errors are its own.
    }
  };
}

export async function renderOnce(request: RenderRequest, context: SessionContext): Promise<Checked<Delivered>> {
  const report = progressForwarder(context.onProgress);
  if (context.signal.aborted) return refusal(cancelledProblem());

  // 1. The recording, the output folder and Chrome, before anything waits.
  let recording: string | undefined;
  if (request.recording !== undefined) {
    const checked = await readableRecording(request.recording, context.allowed);
    if (!checked.ok) return checked;
    recording = checked.value.path;
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
          true,
        );
      },
    });
  } catch (error) {
    return refusal(asProblem(error));
  }

  const stop = stopSignal({ signal: context.signal, timeoutMs: context.timeoutMs, lost: held.lost });
  const signal = stop.signal;
  const profile = path.join(context.data, "chrome-profile");
  const staging = path.join(context.data, "staging");
  const stagedHere = new Set<string>();
  const unsubscribe: (() => void)[] = [];
  let launching: Promise<Chrome> | undefined;
  let chrome: Chrome | undefined;
  let cdp: Cdp | undefined;
  let sessionId = "";
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
  const sendAfter = <T = any>(method: string, params: object, ms: number): Promise<T> =>
    until(cdp!.send<T>(method, params, sessionId), new AbortController().signal, ms, limited(method, ms), [gone]);
  /** Runs an expression in the page; its exception becomes a problem. */
  const evaluate = async (expression: string, ms = SEND_MS, after = false): Promise<unknown> => {
    const params = { expression, awaitPromise: true, returnByValue: true, userGesture: true };
    const result: any = after ? await sendAfter("Runtime.evaluate", params, ms) : await send("Runtime.evaluate", params, ms);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "an exception";
      throw problemError("page", `The agent page threw: ${String(detail).split("\n")[0]}`, "Try the render again.");
    }
    return result.result?.value;
  };

  try {
    // 3. Chrome on the adapter's own profile.
    report({ phase: "starting", completed: 0, total: 1, message: "Opening Chrome." }, true);
    await mkdir(staging, { recursive: true });
    launching = launchChrome({ executable: executable.value, profile, origin: context.origin, mode: context.chromeMode });
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
    ({ sessionId } = await until(openPage(cdp), signal, SEND_MS * 2, limited("Target.createTarget", SEND_MS * 2), [gone]));

    // 4. The progress bridge, before the page loads.
    unsubscribe.push(
      cdp.on("Runtime.bindingCalled", (params, from) => {
        if (from !== sessionId || params?.name !== BINDING || typeof params.payload !== "string") return;
        let p: any;
        try {
          p = JSON.parse(params.payload);
        } catch {
          return;
        }
        if (typeof p?.phase !== "string" || !Number.isFinite(p.completed) || !Number.isFinite(p.total)) return;
        report({ phase: p.phase, completed: p.completed, total: p.total, ...(typeof p.file === "string" ? { message: p.file } : {}) });
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
        if (seen.version !== CONTRACT) throw contractProblem(`the page speaks contract ${JSON.stringify(seen.version)}, the adapter ${CONTRACT}.`);
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

    // 6. The recording, by its real path; Chrome reads it from disk.
    if (recording) {
      const field = (await send("Runtime.evaluate", { expression: `document.getElementById("agent-recording")` })) as any;
      const objectId = field?.result?.objectId;
      if (!objectId) throw contractProblem("the page has no #agent-recording.");
      await send("DOM.setFileInputFiles", { files: [recording], objectId });
    }

    // 7. The render, as a free preview.
    const call = {
      plan: request.plan,
      recording: !!recording,
      tier: "free",
      baseName,
      ...(request.still ? { seconds: request.still.seconds, format: request.still.format } : {}),
    };
    let json: string;
    try {
      json = JSON.stringify(call);
    } catch {
      throw problemError("plan", "The plan could not be sent: it is not plain JSON.", "Send the plan as a JSON object.");
    }
    // Parsed in the page, never pasted in as code: a plan is data.
    const expression = `motionMockupsAgent.${request.still ? "still" : "render"}(JSON.parse(${JSON.stringify(json)}))`;
    rendering = cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    rendering.then(
      () => (renderSettled = true),
      () => (renderSettled = true),
    );
    const answer: any = await until(rendering, signal, Infinity, () => new Error("unreachable"), [gone]);
    if (answer.exceptionDetails)
      throw problemError(
        "page",
        `The agent page threw: ${String(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text).split("\n")[0]}`,
        "Try the render again.",
      );
    const result = checkResult(answer.result?.value, context.origin);
    if (!result.ok) return { ok: false, problems: result.problems };

    // 8. Each file: saved by Chrome into staging, streamed into motion-mockups/, staging removed.
    const delivered: Delivered["files"] = [];
    const begun = new Map<string, string>(); // url -> guid
    const states = new Map<string, { state: string; received: number; total: number }>();
    let changed: () => void = () => {};
    unsubscribe.push(
      cdp.on("Browser.downloadWillBegin", (params) => {
        if (typeof params?.guid !== "string" || typeof params.url !== "string") return;
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
      report({ phase: "saving", completed: index, total: result.files.length, message: file.name }, true);
      await send(
        "Browser.setDownloadBehavior",
        { behavior: "allowAndName", downloadPath: staging, eventsEnabled: true },
        SEND_MS,
        false,
      );
      await evaluate(
        `(() => { const a = document.createElement("a"); a.href = ${JSON.stringify(file.url)}; a.download = ${JSON.stringify(file.name)};` +
          ` document.body.append(a); a.click(); a.remove(); })()`,
      );
      const guid = await waitFor(
        () => begun.get(file.url),
        DOWNLOAD_START_MS,
        () => problemError("download", `Chrome did not start saving ${file.name}.`, "Try the render again."),
      );
      stagedHere.add(guid);
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

      let created;
      try {
        created = await createOutput(output.value, name.stem, name.ext);
      } catch (error) {
        throw problemError(
          "output",
          `${file.name} could not be created in ${output.value}: ${(error as Error).message}`,
          `Check that ${output.value} can be written to.`,
        );
      }
      try {
        await pipeline(createReadStream(from), created.handle.createWriteStream(), { signal });
      } catch (error) {
        await created.handle.close().catch(() => {});
        await rm(created.path, { force: true }).catch(() => {});
        if (signal.aborted) throw signal.reason;
        throw problemError(
          "output",
          `${file.name} could not be written to ${created.path}: ${(error as Error).message}`,
          `Check that ${output.value} can be written to and has room.`,
        );
      }
      await rm(from, { force: true });
      stagedHere.delete(guid);
      delivered.push({ path: created.path, bytes: size });
    }
    report({ phase: "saving", completed: result.files.length, total: result.files.length }, true);

    // 9. The page lets go of its links, its staged files and the recording.
    pageReady = false;
    await sendAfter("Runtime.evaluate", { expression: "motionMockupsAgent.release()", awaitPromise: true }, RELEASE_MS).catch(() => {});

    return { ok: true, value: { files: delivered, warnings: result.warnings, notice: FREE_NOTICE } };
  } catch (error) {
    // A stop wins over whatever it interrupted: say why the render stopped.
    return refusal(asProblem(signal.aborted ? signal.reason : error));
  } finally {
    stop.dispose();
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
