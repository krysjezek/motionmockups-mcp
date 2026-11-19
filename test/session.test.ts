import { after, before, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { findChrome } from "../src/chrome/find.ts";
import { launchChrome } from "../src/chrome/launch.ts";
import { allowedFolders } from "../src/folders.ts";
import { acquireRenderLock, LOCK_NAME } from "../src/lock.ts";
import { FREE_NOTICE, pageProgress, renderOnce, stopSignal, sweepStaging, type RenderRequest } from "../src/session.ts";

const NOTICE = "Watermarked preview for evaluation only. Publishing it needs Motion Mockups Pro (https://motionmockups.com/pricing).";
const TEST_ORIGIN = process.env.MOTIONMOCKUPS_TEST_ORIGIN?.trim();
const found = findChrome();
const PUBLIC = new URL("https://motionmockups.com");
const windows = process.platform === "win32";

type Progress = { phase: string; completed: number; total: number; message?: string };

function temp(t: { after: (fn: () => void) => void }, prefix: string): string {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  return folder;
}

function context(overrides: Partial<Parameters<typeof renderOnce>[1]> & { allowed: string[]; data: string }) {
  return {
    origin: PUBLIC,
    chromeMode: "headless" as const,
    signal: new AbortController().signal,
    timeoutMs: 10 * 60_000,
    onProgress: () => {},
    ...overrides,
  };
}

const PLAN = { contract: 1, device: "iPhone", aspect: "9:16", clips: [{ scene: "blanc-iphone-shot-1" }] };

/** Command lines of every running Chrome. */
function chromeCommandLines(): string[] {
  if (windows) {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object { $_.CommandLine }",
      ],
      { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    );
    return out.split(/\r?\n/).filter(Boolean);
  }
  return execFileSync("ps", ["-A", "-o", "args="], { encoding: "utf8" }).split("\n").filter(Boolean);
}

/** True once no Chrome runs on the profile, polled for up to 10 s (renderers end a moment after the browser). */
async function chromeGone(profile: string): Promise<boolean> {
  const needle = profile.toLowerCase();
  for (let i = 0; i < 40; i++) {
    if (!chromeCommandLines().some((line) => line.toLowerCase().includes(needle))) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

// ---- the signal a render stops on (no Chrome needed) ----

test("stop signal: the caller's cancel, the timeout and a lost lock each stop it, with their own reason", async () => {
  {
    const caller = new AbortController();
    const lost = new AbortController();
    const stop = stopSignal({ signal: caller.signal, timeoutMs: 60_000, lost: lost.signal });
    assert.equal(stop.signal.aborted, false);
    caller.abort(new Error("the client's own reason"));
    assert.equal(stop.signal.aborted, true);
    assert.equal((stop.signal.reason as { code: string }).code, "cancelled");
    stop.dispose();
  }
  {
    const lost = new AbortController();
    const stop = stopSignal({ signal: new AbortController().signal, timeoutMs: 60_000, lost: lost.signal });
    lost.abort(Object.assign(new Error("Another render took the lock."), { code: "lock-lost", fix: "Try again." }));
    assert.equal((stop.signal.reason as { code: string }).code, "lock-lost");
    assert.equal((stop.signal.reason as { message: string }).message, "Another render took the lock.");
    stop.dispose();
  }
  {
    const stop = stopSignal({ signal: new AbortController().signal, timeoutMs: 30, lost: new AbortController().signal });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal((stop.signal.reason as { code: string }).code, "timeout");
    assert.match((stop.signal.reason as { fix: string }).fix, /MOTIONMOCKUPS_TIMEOUT_MINUTES/);
    stop.dispose();
  }
  {
    // Already aborted sources stop it at once; dispose stops the timer.
    const caller = new AbortController();
    caller.abort();
    const stop = stopSignal({ signal: caller.signal, timeoutMs: 30, lost: new AbortController().signal });
    assert.equal((stop.signal.reason as { code: string }).code, "cancelled");
    stop.dispose();
    const quiet = stopSignal({ signal: new AbortController().signal, timeoutMs: 30, lost: new AbortController().signal });
    quiet.dispose();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(quiet.signal.aborted, false);
  }
});

test("page progress is checked: texts capped at 200 characters, 0 <= completed <= total", () => {
  const long = "x".repeat(2000);
  assert.deepEqual(pageProgress(JSON.stringify({ phase: "rendering", completed: 3, total: 10, file: "film.mp4" })), {
    phase: "rendering",
    completed: 3,
    total: 10,
    message: "film.mp4",
  });
  const capped = pageProgress(JSON.stringify({ phase: long, completed: 1, total: 2, file: long }))!;
  assert.equal(capped.phase.length, 200);
  assert.equal(capped.message!.length, 200);
  assert.deepEqual(pageProgress(JSON.stringify({ phase: "rendering", completed: 50, total: 10 })), { phase: "rendering", completed: 10, total: 10 });
  assert.deepEqual(pageProgress(JSON.stringify({ phase: "rendering", completed: -5, total: -1 })), { phase: "rendering", completed: 0, total: 0 });
  for (const bad of [
    "not json",
    JSON.stringify({ phase: "", completed: 0, total: 1 }),
    JSON.stringify({ phase: "x", completed: "1", total: 1 }),
    JSON.stringify({ phase: "x", completed: 1 }),
    JSON.stringify({ phase: 3, completed: 1, total: 1 }),
    JSON.stringify({ phase: "x", completed: 1, total: 2, file: "y".repeat(20_000) }),
    42,
  ])
    assert.equal(pageProgress(bad), null, String(bad).slice(0, 60));
});

test("the notice is the exact copy", () => {
  assert.equal(FREE_NOTICE, NOTICE);
});

// ---- refusals before Chrome (no Chrome or site needed) ----

test("a recording outside the allowed folders is refused before the lock and Chrome", async (t) => {
  const project = temp(t, "mm-session-project-");
  const outside = temp(t, "mm-session-outside-");
  const data = temp(t, "mm-session-data-");
  const recording = path.join(outside, "clip.mp4");
  fs.writeFileSync(recording, Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"));
  const allowed = await allowedFolders([project], {});
  const result = await renderOnce({ plan: PLAN, recording }, context({ allowed, data }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problems[0]!.code, "folder");
  assert.equal(fs.existsSync(path.join(data, LOCK_NAME)), false, "no lock taken");
  assert.equal(fs.existsSync(path.join(data, "chrome-profile")), false, "no Chrome started");
});

test("no allowed folder is refused", async (t) => {
  const data = temp(t, "mm-session-data-");
  const result = await renderOnce({ plan: PLAN }, context({ allowed: [], data }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problems[0]!.code, "no-folder");
});

test("a render cancelled before it starts is refused as cancelled", async (t) => {
  const project = temp(t, "mm-session-project-");
  const data = temp(t, "mm-session-data-");
  const caller = new AbortController();
  caller.abort();
  const result = await renderOnce({ plan: PLAN }, context({ allowed: [project], data, signal: caller.signal }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problems[0]!.code, "cancelled");
  assert.equal(fs.existsSync(path.join(data, LOCK_NAME)), false);
});

test("waiting for another render reports the wait, and cancelling the wait gives cancelled", async (t) => {
  const project = temp(t, "mm-session-project-");
  const data = temp(t, "mm-session-data-");
  const other = await acquireRenderLock(data);
  t.after(() => other.release());
  const caller = new AbortController();
  const seen: Progress[] = [];
  const result = await renderOnce(
    { plan: PLAN },
    context({
      allowed: [project],
      data,
      signal: caller.signal,
      onProgress: (p) => {
        seen.push(p);
        setTimeout(() => caller.abort(), 1200);
      },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problems[0]!.code, "cancelled");
  assert.ok(seen.length >= 1, "the wait was reported");
  assert.equal(seen[0]!.phase, "waiting");
  assert.match(seen[0]!.message ?? "", new RegExp(`pid ${process.pid}`));
  // Throttled: the lock polls every 500 ms, the wait is reported far less often.
  assert.ok(seen.length <= 2, `reported ${seen.length} times in ~1.2 s`);
  assert.equal(fs.existsSync(path.join(data, "chrome-profile")), false, "Chrome waited for the lock");
});

// ---- what a killed adapter left in staging ----

const GUID_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const GUID_B = "7C9E6679-7425-40DE-944B-E07FC1F90AE7";
const KEPT = ["notes.txt", `${GUID_A}.txt`, `x${GUID_A}`, `${GUID_A}.crdownload.bak`, "0f8fad5b-d9cb-469f-a165.crdownload"];

function plantStaging(data: string): string {
  const staging = path.join(data, "staging");
  fs.mkdirSync(staging, { recursive: true });
  for (const name of [GUID_A, `${GUID_B}.crdownload`, ...KEPT]) fs.writeFileSync(path.join(staging, name), "x");
  return staging;
}

test("staging sweep: only Chrome's GUID download names (whole or .crdownload) are removed", async (t) => {
  const data = temp(t, "mm-session-data-");
  const staging = plantStaging(data);
  fs.mkdirSync(path.join(staging, "f47ac10b-58cc-4372-a567-0e02b2c3d479")); // a folder by that name is not Chrome's
  const removed = await sweepStaging(staging);
  assert.deepEqual(removed.sort(), [GUID_A, `${GUID_B}.crdownload`].sort());
  assert.deepEqual(fs.readdirSync(staging).sort(), [...KEPT, "f47ac10b-58cc-4372-a567-0e02b2c3d479"].sort());
  assert.deepEqual(await sweepStaging(path.join(data, "no-such-folder")), [], "a missing staging folder is nothing to sweep");
});

test(
  "a render's start removes what a killed adapter left in staging, and keeps anything else",
  { skip: found.ok ? false : "no Google Chrome on this machine" },
  async (t: TestContext) => {
    const project = temp(t, "mm-session-project-");
    const data = temp(t, "mm-session-data-");
    const staging = plantStaging(data);
    // A loopback origin nothing listens on: the render stops at the page, after the lock and the sweep.
    const closed = await new Promise<number>((resolve) => {
      const server = net.createServer().listen(0, "127.0.0.1", () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
    });
    const result = await renderOnce({ plan: PLAN }, context({ allowed: [project], data, origin: new URL(`http://127.0.0.1:${closed}`) }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.problems[0]!.code, "site", JSON.stringify(result.problems));
    assert.deepEqual(fs.readdirSync(staging).sort(), [...KEPT].sort());
    assert.equal(fs.existsSync(path.join(data, LOCK_NAME)), false, "the lock was released");
  },
);

// ---- Chrome already on the shared profile (Chrome needed, no site) ----

// A Chrome window needs a display: on Linux without X or Wayland (a CI runner without
// xvfb-run) window mode cannot start at all.
const noDisplay = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

for (const mode of ["headless", "window"] as const) {
  test(
    `Chrome already running on the shared profile (${mode}) is refused as busy, never "install Chrome"`,
    {
      skip: !found.ok
        ? "no Google Chrome on this machine"
        : mode === "window" && noDisplay
          ? "window mode needs a display: no DISPLAY or WAYLAND_DISPLAY (run under xvfb-run)"
          : false,
    },
    async (t: TestContext) => {
      const project = temp(t, "mm-session-project-");
      const data = temp(t, "mm-session-data-");
      const profile = path.join(data, "chrome-profile");
      const holder = await launchChrome({ executable: found.ok ? found.value : "", profile, origin: PUBLIC, mode });
      let result;
      try {
        result = await renderOnce({ plan: PLAN }, context({ allowed: [project], data, chromeMode: mode }));
      } finally {
        // Before the folders are removed: Chrome holds its profile files open.
        await holder.close();
      }
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.problems[0]!.code, "busy", JSON.stringify(result.problems));
      // This session holds the lock: the Chrome on the profile is a leftover or the person's own.
      assert.ok(result.problems[0]!.fix.includes(`close the Chrome that uses ${profile}`), result.problems[0]!.fix);
      assert.ok(result.problems[0]!.message.includes(profile));
      assert.doesNotMatch(result.problems[0]!.fix, /install/i);
      assert.equal(fs.existsSync(path.join(data, LOCK_NAME)), false, "the lock was released");
    },
  );
}

// ---- against the agent page ----

describe("a render session on the agent page", { skip: TEST_ORIGIN ? false : "MOTIONMOCKUPS_TEST_ORIGIN is not set" }, () => {
  const origin = new URL(TEST_ORIGIN || "http://127.0.0.1:4173");
  let root = "";
  let project = "";
  let data = "";
  let recording = "";
  let allowed: string[] = [];
  let fps = 0;
  const CLIPS = [
    { scene: "blanc-iphone-shot-1", seconds: 3 },
    { scene: "blanc-iphone-shot-2", seconds: 3 },
  ];
  const film: RenderRequest = {
    plan: { contract: 1, device: "iPhone", aspect: "9:16", clips: CLIPS },
    recording: "recording.mp4",
    name: "film",
  };

  const ctx = (overrides: Partial<Parameters<typeof renderOnce>[1]> = {}) => context({ origin, allowed, data, ...overrides });

  before(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mm-session-live-")));
    project = path.join(root, "project with spaces");
    data = path.join(root, "data");
    fs.mkdirSync(project);
    recording = path.join(project, "recording.mp4");
    const catalog = (await (await fetch(new URL("/agent/catalog.json", origin))).json()) as {
      devices: { device: string; fps: number }[];
    };
    fps = catalog.devices.find((d) => d.device === "iPhone")!.fps;
    assert.ok(fps > 0);
    // Half an iPhone screen recording, portrait, H.264.
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner", "-v", "error", "-y",
        "-f", "lavfi", "-i", `testsrc2=size=660x1434:rate=${fps}:duration=6`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        recording,
      ],
      { windowsHide: true },
    );
    allowed = await allowedFolders([project], {});
  });

  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  const probe = (file: string) => {
    const [width, height, frames] = execFileSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=width,height,nb_read_frames", "-of", "csv=p=0", file],
      { encoding: "utf8", windowsHide: true },
    )
      .trim()
      .split(",")
      .map(Number);
    return { width: width!, height: height!, frames: frames! };
  };

  const partials = () => fs.readdirSync(path.join(project, "motion-mockups")).filter((f) => f.includes(".partial-"));

  /**
   * Starts a render while the lock is held, so it checks the recording and then waits; runs
   * `swap` during the wait, then lets it go on to Chrome and the hand-off.
   */
  async function swapWhileWaiting(request: RenderRequest, swap: () => void) {
    const other = await acquireRenderLock(data);
    let waiting!: () => void;
    const waited = new Promise<void>((resolve) => (waiting = resolve));
    const running = renderOnce(request, ctx({ onProgress: (p) => p.phase === "waiting" && waiting() }));
    try {
      await waited;
      swap();
    } finally {
      await other.release();
    }
    return running;
  }

  test("a folder on the recording's path swapped for a link to outside, between the check and the hand-off, is refused", async (t) => {
    const clips = path.join(project, "clips");
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mm-session-outside-")));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.mkdirSync(clips);
    fs.copyFileSync(recording, path.join(clips, "take.mp4"));
    fs.copyFileSync(recording, path.join(outside, "take.mp4"));
    const result = await swapWhileWaiting({ ...film, recording: "clips/take.mp4", name: "swapped" }, () => {
      fs.renameSync(clips, path.join(project, "clips-before"));
      // A junction needs no privilege on Windows; elsewhere a directory symlink.
      fs.symlinkSync(outside, clips, windows ? "junction" : "dir");
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.problems[0]!.code, "folder", JSON.stringify(result.problems));
    assert.ok(!fs.readdirSync(path.join(project, "motion-mockups")).some((f) => f.startsWith("swapped")));
    assert.ok(await chromeGone(path.join(data, "chrome-profile")));
    fs.rmSync(clips, { recursive: false, force: true });
  });

  test("a recording replaced by another file between the check and the hand-off is refused", async () => {
    const take = path.join(project, "replaced.mp4");
    fs.copyFileSync(recording, take);
    const result = await swapWhileWaiting({ ...film, recording: "replaced.mp4", name: "replaced" }, () => {
      fs.rmSync(take);
      fs.copyFileSync(recording, take);
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problems[0]!.code, "recording", JSON.stringify(result.problems));
      assert.match(result.problems[0]!.message, /changed while the render waited/);
    }
    assert.ok(!fs.readdirSync(path.join(project, "motion-mockups")).some((f) => f.startsWith("replaced")));
  });

  test("cancelled while saving file 2 of 2: the refusal names the file already saved, which stays", async () => {
    const caller = new AbortController();
    const result = await renderOnce(
      { ...film, name: "half", plan: { ...(film.plan as object), delivery: "scenes" } },
      ctx({
        signal: caller.signal,
        onProgress: (p) => {
          if (p.phase === "saving" && p.completed === 1) caller.abort();
        },
      }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.problems[0]!.code, "cancelled", JSON.stringify(result.problems));
    assert.equal(result.saved?.length, 1, JSON.stringify(result));
    const kept = result.saved![0]!;
    assert.equal(path.dirname(kept.path), path.join(project, "motion-mockups"));
    assert.equal(fs.statSync(kept.path).size, kept.bytes);
    assert.equal(fs.readdirSync(path.join(project, "motion-mockups")).filter((f) => f.startsWith("half")).length, 1);
    assert.deepEqual(staged(), []);
    assert.deepEqual(partials(), []);
    assert.ok(await chromeGone(path.join(data, "chrome-profile")));
  });

  const staged = () => {
    const folder = path.join(data, "staging");
    return fs.existsSync(folder) ? fs.readdirSync(folder) : [];
  };

  test("a free 2-clip iPhone film lands in motion-mockups/ with the catalog's frame count, at most 720, with the notice", async (t) => {
    const seen: Progress[] = [];
    const result = await renderOnce(film, ctx({ onProgress: (p) => seen.push(p) }));
    assert.ok(result.ok, JSON.stringify(result));
    const { files, notice, warnings } = result.value;
    assert.equal(notice, NOTICE);
    assert.equal(files.length, 1);
    const file = files[0]!;
    assert.equal(file.path, path.join(project, "motion-mockups", "film.mp4"));
    assert.equal(fs.statSync(file.path).size, file.bytes);
    const { width, height, frames } = probe(file.path);
    assert.equal(frames, CLIPS.reduce((sum, c) => sum + c.seconds, 0) * fps);
    assert.ok(Math.max(width, height) <= 720, `${width}x${height}`);
    t.diagnostic(`film: ${frames} frames at ${fps} fps, ${width}x${height}, ${file.bytes} bytes`);
    assert.ok(warnings.some((w) => /preview/i.test(w)), "the page's warnings pass through");
    const phases = new Set(seen.map((p) => p.phase));
    for (const phase of ["starting", "rendering", "saving"]) assert.ok(phases.has(phase), `progress ${phase}: ${[...phases]}`);
    assert.deepEqual(staged(), []);
    assert.deepEqual(partials(), []);
    assert.ok(await chromeGone(path.join(data, "chrome-profile")));
    assert.equal(fs.existsSync(path.join(data, LOCK_NAME)), false);
  });

  test('a second render with the same name gives " (2)"; it removes partials a killed render left a day ago, and only those', async () => {
    const out = path.join(project, "motion-mockups");
    const old = path.join(out, ".film.mp4.partial-00112233445566aa");
    const fresh = path.join(out, ".film.mp4.partial-00112233445566bb");
    for (const file of [old, fresh]) fs.writeFileSync(file, "half a film");
    const then = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, then, then);
    const result = await renderOnce(film, ctx());
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.value.files[0]!.path, path.join(out, "film (2).mp4"));
    assert.ok(fs.existsSync(path.join(out, "film.mp4")), "the first is still there");
    assert.equal(fs.existsSync(old), false, "the day-old partial is removed");
    assert.ok(fs.existsSync(fresh), "a fresh partial is kept");
    fs.rmSync(fresh);
  });

  test("aborting mid-render gives cancelled; staging is empty, Chrome is gone, and a new render works", async (t) => {
    const caller = new AbortController();
    let abortedAt = "";
    const result = await renderOnce(
      { ...film, name: "cancelled" },
      ctx({
        signal: caller.signal,
        onProgress: (p) => {
          if (!abortedAt && p.phase === "rendering" && p.completed >= 1) {
            abortedAt = `${p.completed}/${p.total}`;
            caller.abort();
          }
        },
      }),
    );
    assert.ok(abortedAt, "aborted while rendering");
    t.diagnostic(`aborted at frame ${abortedAt}`);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.problems[0]!.code, "cancelled", JSON.stringify(result.problems));
    assert.deepEqual(staged(), []);
    assert.ok(await chromeGone(path.join(data, "chrome-profile")), "Chrome is gone");
    assert.equal(fs.existsSync(path.join(data, LOCK_NAME)), false, "the lock is released");
    assert.ok(!fs.readdirSync(path.join(project, "motion-mockups")).some((f) => f.startsWith("cancelled")), "nothing delivered");

    const next = await renderOnce({ ...film, name: "after-cancel" }, ctx());
    assert.ok(next.ok, JSON.stringify(next));
    assert.equal(probe(next.value.files[0]!.path).frames, 6 * fps);
  });

  test("a still gives a PNG, and a JPEG", async () => {
    for (const [format, magic, ext] of [
      ["png", "89504e470d0a1a0a", ".png"],
      ["jpeg", "ffd8ff", ".jpg"],
    ] as const) {
      const result = await renderOnce({ ...film, name: "frame", still: { seconds: 1, format } }, ctx());
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(result.value.notice, NOTICE);
      const file = result.value.files[0]!;
      assert.equal(path.dirname(file.path), path.join(project, "motion-mockups"));
      assert.equal(path.extname(file.path), ext);
      const head = fs.readFileSync(file.path).subarray(0, magic.length / 2).toString("hex");
      assert.equal(head, magic, format);
      const { width, height } = probe(file.path);
      assert.ok(Math.max(width, height) <= 720, `${width}x${height}`);
    }
    assert.deepEqual(staged(), []);
  });

  test("scenes delivery saves one file per clip", async () => {
    const result = await renderOnce(
      { ...film, name: "scenes", plan: { ...(film.plan as object), delivery: "scenes" } },
      ctx(),
    );
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.value.files.length, CLIPS.length);
    for (const file of result.value.files) {
      assert.equal(path.dirname(file.path), path.join(project, "motion-mockups"));
      assert.equal(probe(file.path).frames, 3 * fps);
    }
    assert.equal(new Set(result.value.files.map((f) => f.path)).size, CLIPS.length);
    assert.deepEqual(staged(), []);
  });

  test("the page's refusals pass through unchanged", async () => {
    const result = await renderOnce({ plan: { ...film.plan as object, clips: [{ scene: "no-such-scene" }] }, name: "x" }, ctx());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.problems, [{ code: "scene", message: '"no-such-scene" is not a scene.', fix: "Take scene ids from the catalog." }]);
    assert.ok(await chromeGone(path.join(data, "chrome-profile")));
  });

  test("the timeout stops the render with code timeout and cleans up, during launch and mid-render", async (t) => {
    // During Chrome's launch: the launch is waited for and closed.
    const early = await renderOnce({ ...film, name: "slow" }, ctx({ timeoutMs: 50 }));
    assert.equal(early.ok, false);
    if (!early.ok) assert.equal(early.problems[0]!.code, "timeout", JSON.stringify(early.problems));
    assert.ok(await chromeGone(path.join(data, "chrome-profile")));
    assert.equal(fs.existsSync(path.join(data, LOCK_NAME)), false);

    // Mid-render: a 16 s film, timed once warm, then stopped halfway through its rendering phase.
    const long: RenderRequest = {
      ...film,
      name: "slow",
      plan: { contract: 1, device: "iPhone", aspect: "9:16", clips: [{ scene: CLIPS[0]!.scene, seconds: 8 }, { scene: CLIPS[1]!.scene, seconds: 8 }] },
    };
    let renderingAt = 0;
    let finalizingAt = 0;
    const started = performance.now();
    const timed = await renderOnce(
      { ...long, name: "timed" },
      ctx({
        onProgress: (p) => {
          if (p.phase === "rendering") renderingAt ||= performance.now() - started;
          if (p.phase === "finalizing") finalizingAt ||= performance.now() - started;
        },
      }),
    );
    assert.ok(timed.ok && renderingAt > 0 && finalizingAt > renderingAt, JSON.stringify({ timed, renderingAt, finalizingAt }));
    const timeoutMs = Math.round((renderingAt + finalizingAt) / 2);
    let last: Progress | undefined;
    const result = await renderOnce(long, ctx({ timeoutMs, onProgress: (p) => (last = p) }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.problems[0]!.code, "timeout", JSON.stringify(result.problems));
    t.diagnostic(`timeout ${timeoutMs} ms (rendering ${Math.round(renderingAt)}–${Math.round(finalizingAt)} ms), stopped at ${JSON.stringify(last)}`);
    assert.equal(last?.phase, "rendering", `stopped at ${timeoutMs} ms while ${JSON.stringify(last)}`);
    assert.deepEqual(staged(), []);
    assert.ok(await chromeGone(path.join(data, "chrome-profile")));
    assert.equal(fs.existsSync(path.join(data, LOCK_NAME)), false);
    assert.ok(!fs.readdirSync(path.join(project, "motion-mockups")).some((f) => f.startsWith("slow")), "nothing delivered");
  });
});
