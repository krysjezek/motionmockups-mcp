// End to end: the built adapter (dist/motionmockups.js) as a real MCP server over stdio,
// driven through the SDK's Client and StdioClientTransport against a running copy of the
// site with the agent page, the way an agent's MCP client drives it.
//
//   MOTIONMOCKUPS_ORIGIN=http://127.0.0.1:4173 node scripts/e2e.mjs
//
// MOTIONMOCKUPS_ORIGIN    The site to render on: a preview build made with AGENT_PAGE=1. Without
//                         it every check is skipped and nothing is written.
// MOTIONMOCKUPS_E2E_REFERENCE
//                         The free film the app's scripts/verify-agent-render.mjs saved for the
//                         same plan (artifacts/agent-render/build/free-film.mp4). Without it the
//                         equality check and the SSIM column of the Chrome-mode table are skipped.
// MOTIONMOCKUPS_E2E_MODES "off" skips the Chrome-mode measurement (headless and window).
// MOTIONMOCKUPS_E2E_KEEP  "1" keeps the temporary folder for a look afterwards.
//
// Everything happens in a temporary folder: the project (its root, declared through the
// client's roots), the adapter's data folder (MOTIONMOCKUPS_DATA: Chrome profile, staging,
// render lock) and a folder outside the project. Nothing is written to the person's own
// data folder. Needs ffmpeg and ffprobe. Writes e2e-results.json next to package.json.
// "No Chrome left" counts only chrome.exe processes on this run's profile (or children of
// the adapter), never anyone's own Chrome.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUNDLE = path.join(repo, "dist", "motionmockups.js");
const RESULTS = path.join(repo, "e2e-results.json");
const windows = process.platform === "win32";
const ORIGIN = process.env.MOTIONMOCKUPS_ORIGIN?.trim() || "";
const REFERENCE = process.env.MOTIONMOCKUPS_E2E_REFERENCE?.trim() || "";
const MODES = process.env.MOTIONMOCKUPS_E2E_MODES?.trim().toLowerCase() !== "off";
const KEEP = process.env.MOTIONMOCKUPS_E2E_KEEP === "1";
const FREE_NOTICE =
  "Watermarked preview for evaluation only. Publishing it needs Motion Mockups Pro (https://motionmockups.com/pricing).";
/** The Gallery iPhone, as in the app's verify-agent-render.mjs. */
const SCENES = ["blanc-iphone-shot-1", "blanc-iphone-shot-2"];

const checks = [];
const record = (name, result, detail) => {
  checks.push({ name, result, detail });
  console.log(`${result.toUpperCase().padEnd(4)}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const pass = (name, ok, detail) => record(name, ok ? "pass" : "fail", detail);
const skip = (name, why) => record(name, "skip", why);
/** A check that throws is a failure with its reason; the run goes on. */
const attempt = async (name, body) => {
  try {
    await body();
  } catch (error) {
    record(name, "fail", `threw: ${String(error?.message ?? error).split("\n")[0]}`);
  }
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n, digits = 4) => Number(n.toFixed(digits));

const CHECK_NAMES = [
  "free film and stills",
  "scenes delivery",
  "escapes",
  "two adapters at once",
  "cancel, then render",
  "adapter killed mid-render",
  "Chrome problems",
  "equality with the page",
];

if (!ORIGIN) {
  for (const name of CHECK_NAMES) skip(name, "MOTIONMOCKUPS_ORIGIN is not set");
  process.exit(0);
}
if (!fs.existsSync(BUNDLE)) {
  console.error(`${BUNDLE} is missing: run npm run build first.`);
  process.exit(1);
}

// ---- the temporary world ----

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mm-e2e-")));
const project = path.join(root, "project with spaces");
const outside = path.join(root, "outside");
const data = path.join(root, "data");
const profile = path.join(data, "chrome-profile");
const output = path.join(project, "motion-mockups");
const work = path.join(root, "work");
for (const dir of [project, outside, work]) fs.mkdirSync(dir, { recursive: true });

const ffmpeg = (args) => execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args], { windowsHide: true });
const ffprobe = (args) => execFileSync("ffprobe", ["-v", "error", ...args], { encoding: "utf8", windowsHide: true }).trim();

/** Frames, size, profile and bitrate of a video. */
function probe(file) {
  const info = JSON.parse(
    ffprobe([
      "-select_streams", "v:0", "-count_frames",
      "-show_entries", "stream=width,height,nb_read_frames,profile,level:format=duration,bit_rate",
      "-of", "json", file,
    ]),
  );
  const s = info.streams?.[0] ?? {};
  return {
    width: Number(s.width),
    height: Number(s.height),
    frames: Number(s.nb_read_frames),
    profile: s.profile,
    level: Number(s.level),
    duration: Number(info.format?.duration),
    bitRate: Number(info.format?.bit_rate),
  };
}

/** Every video frame's presentation time in seconds, in order. */
const frameTimes = (file) =>
  ffprobe(["-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file])
    .split(/\r?\n/)
    .map((line) => Number(line.replace(/,$/, "")))
    .filter((t) => Number.isFinite(t));

/** Per-frame SSIM (All) of two equal-sized videos, by ffmpeg's ssim filter. */
function ssimPerFrame(a, b) {
  const stats = `ssim-${createHash("sha1").update(a + b).digest("hex").slice(0, 8)}.log`;
  const out = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", a, "-i", b, "-lavfi", `[0:v]format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]ssim=stats_file=${stats}`, "-f", "null", "-"],
    { cwd: work, encoding: "utf8", windowsHide: true },
  );
  if (out.status !== 0) throw new Error(`ffmpeg ssim: ${out.stderr.split("\n").slice(-3).join(" ")}`);
  return fs
    .readFileSync(path.join(work, stats), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => Number(line.match(/All:([\d.]+)/)?.[1]));
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Every file under `dir` (relative path and size), leaving out the folders named. */
function tree(dir, leaveOut) {
  const found = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (leaveOut.some((d) => full.toLowerCase() === d.toLowerCase())) continue;
      if (entry.isDirectory()) walk(full);
      else found.push(`${path.relative(dir, full)} ${fs.lstatSync(full).size}`);
    }
  };
  walk(dir);
  return found.sort();
}

// ---- Chrome processes: only this run's ----

/** chrome.exe (or Chrome/Chromium elsewhere) processes: pid, parent and command line. */
function chromeProcesses() {
  if (windows) {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    ).trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: p.ProcessId, parent: p.ParentProcessId, line: p.CommandLine ?? "" }));
  }
  return execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" })
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m) => m && /chrom/i.test(m[3]))
    .map((m) => ({ pid: Number(m[1]), parent: Number(m[2]), line: m[3] }));
}
/** This run's Chrome: on its profile, or started by one of the given adapter pids. */
const ours = (adapterPids = []) =>
  chromeProcesses().filter((p) => p.line.toLowerCase().includes(profile.toLowerCase()) || adapterPids.includes(p.parent));

/** Polls until none of this run's Chrome is left, for up to `ms`. */
async function chromeGone(ms, adapterPids = []) {
  const start = performance.now();
  for (;;) {
    const left = ours(adapterPids);
    const elapsed = Math.round(performance.now() - start);
    if (!left.length) return { gone: true, ms: elapsed, left: 0 };
    if (elapsed > ms) return { gone: false, ms: elapsed, left: left.length };
    await delay(250);
  }
}
/** Ends whatever this run's Chrome a failed check left behind, so the next check starts clean. */
function killOurChrome() {
  for (const p of ours()) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

// ---- the adapter as an MCP server ----

async function startAdapter(extraEnv = {}) {
  const env = { MOTIONMOCKUPS_ORIGIN: ORIGIN, MOTIONMOCKUPS_DATA: data, ...extraEnv };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const transport = new StdioClientTransport({ command: process.execPath, args: [BUNDLE, "mcp"], cwd: root, env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => (stderr += chunk));
  const client = new Client({ name: "motionmockups-e2e", version: "1" }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(project).href, name: "e2e project" }] }));
  await client.connect(transport);
  return { client, transport, pid: transport.pid, stderr: () => stderr, close: () => client.close().catch(() => {}) };
}

/** One tool call, with its progress phases timed. */
async function call(adapter, name, args, { signal, onPhase } = {}) {
  const phases = [];
  const started = performance.now();
  const result = await adapter.client.callTool({ name, arguments: args }, undefined, {
    signal,
    timeout: 15 * 60_000,
    resetTimeoutOnProgress: true,
    onprogress: (p) => {
      const phase = String(p.message ?? "").split(/[ :]/)[0];
      phases.push({ ms: Math.round(performance.now() - started), phase });
      onPhase?.(phase);
    },
  });
  return { result, value: result.structuredContent ?? {}, phases, ms: Math.round(performance.now() - started) };
}
const codes = (value) => (value.problems ?? []).map((p) => p.code).join(",");

const twoClips = (extra = {}) => ({
  contract: 1,
  device: "iPhone",
  clips: [
    { scene: SCENES[0], seconds: 1 },
    { scene: SCENES[1], seconds: 1.5 },
  ],
  aspect: "16:9",
  ...extra,
});
/** A longer film, so a cancel or a kill lands while it renders. */
const longFilm = () => ({ ...twoClips(), clips: [{ scene: SCENES[0], seconds: 6 }, { scene: SCENES[1], seconds: 6 }] });

// ---- foreground window (Windows): does a render take focus from the app in front? ----

const encoded = (script) => Buffer.from(script, "utf16le").toString("base64");
const FOCUS_TITLE = "motionmockups e2e focus";
const USER32 = `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class MmFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
function Describe($h) {
  $p = 0; [void][MmFg]::GetWindowThreadProcessId($h, [ref]$p)
  $name = '?'; try { $name = (Get-Process -Id $p -ErrorAction Stop).ProcessName } catch {}
  $sb = New-Object System.Text.StringBuilder 256; [void][MmFg]::GetWindowText($h, $sb, 256)
  return "$([int64]$h)\`t$p\`t$name\`t$($sb.ToString())"
}`;

/** A plain window of our own, in front: the "other app" a render must not take focus from. */
function openFocusWindow() {
  const script = `Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = '${FOCUS_TITLE}'; $f.Width = 420; $f.Height = 160; $f.StartPosition = 'CenterScreen'
$f.Add_Shown({ $f.Activate() })
[System.Windows.Forms.Application]::Run($f)`;
  return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(script)], { stdio: "ignore", windowsHide: false });
}

/**
 * Brings the focus window to the front, then logs the foreground window every 30 ms until
 * stopped: `ready` (the window in front before the render), then every change.
 */
async function watchForeground() {
  const script = `${USER32}
$target = [MmFg]::FindWindow($null, '${FOCUS_TITLE}')
if ($target -ne [IntPtr]::Zero) { [void][MmFg]::SetForegroundWindow($target); Start-Sleep -Milliseconds 400 }
[Console]::Out.WriteLine("ready\`t" + (Describe ([MmFg]::GetForegroundWindow()))); [Console]::Out.Flush()
$last = [MmFg]::GetForegroundWindow()
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 300) {
  $h = [MmFg]::GetForegroundWindow()
  if ($h -ne $last) { $last = $h; [Console]::Out.WriteLine("$($sw.ElapsedMilliseconds)\`t" + (Describe $h)); [Console]::Out.Flush() }
  Start-Sleep -Milliseconds 30
}`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(script)], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let text = "";
  child.stdout.setEncoding("utf8");
  let readyResolve;
  const ready = new Promise((resolve) => (readyResolve = resolve));
  child.stdout.on("data", (chunk) => {
    text += chunk;
    if (text.includes("ready\t") && text.includes("\n")) readyResolve();
  });
  await Promise.race([ready, delay(15_000)]);
  const parse = (line) => {
    const [at, hwnd, pid, name, title] = line.split("\t");
    return { at, hwnd, pid: Number(pid), name, title: title?.trim() };
  };
  return {
    async stop() {
      await delay(1000); // what happens as Chrome closes counts too
      child.kill();
      const lines = text.trim().split(/\r?\n/).filter(Boolean).map(parse);
      const before = lines[0];
      const changes = lines.slice(1);
      const after = changes.at(-1) ?? before;
      return { before, changes, after };
    },
  };
}

// ---- the results file: no local paths in it ----

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Local folders, longest first, and what stands for each in e2e-results.json. */
const REDACTIONS = [
  [root, "<temp>"],
  ...(REFERENCE ? [[path.dirname(path.resolve(REFERENCE)), "<reference>"]] : []),
  [repo, "<repo>"],
  [os.tmpdir(), "<tmp>"],
  [os.homedir(), "~"],
]
  .filter(([folder]) => folder && folder.length > 3)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([folder, label]) => {
    // Either slash, as a path, a URL or a JSON-escaped message writes it.
    const pattern = folder.split(/[\\/]/).map(escapeRegExp).join("[\\\\/]+");
    return [new RegExp(pattern, windows ? "gi" : "g"), label];
  });
/** `value` with every local folder in its strings replaced by its label. */
function redact(value) {
  if (typeof value === "string") return REDACTIONS.reduce((text, [pattern, label]) => text.replace(pattern, label), value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  return value;
}

// ---- the run ----

const results = { when: new Date().toISOString(), origin: ORIGIN, platform: `${process.platform} ${os.release()}`, node: process.version };
const adapters = [];
const nameOf = (file) => path.basename(file);
let fps = 30;
let frames = 75;
let film; // the default mode's free film, for equality
let recording;

try {
  const chromeVersion = windows
    ? spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "(Get-Item \"$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe\").VersionInfo.ProductVersion"],
        { encoding: "utf8", windowsHide: true },
      ).stdout.trim()
    : "";
  if (chromeVersion) results.chrome = chromeVersion;

  const main = await startAdapter();
  adapters.push(main);

  // The recording: the app's verify-agent-render.mjs fixture, made the same way (half an
  // iPhone screen, portrait, four seconds of H.264 at the catalog's frame rate).
  const spec = await call(main, "recording_spec", { device: "iPhone" });
  fps = spec.value.fps ?? fps;
  frames = Math.round((1 + 1.5) * fps);
  recording = path.join(project, "recording.mp4");
  ffmpeg([
    "-f", "lavfi", "-i", `testsrc2=size=590x1278:rate=${fps}:duration=4`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart", recording,
  ]);
  fs.copyFileSync(recording, path.join(outside, "recording.mp4"));
  results.recording = { fps, sha256: sha256(recording) };

  // -------------------------------------------------------------- free film and stills
  await attempt("free film and stills", async () => {
    const listed = await call(main, "list_scenes", { device: "iPhone" });
    const ids = (listed.value.scenes ?? []).map((s) => s.id);
    const listedOk = !listed.result.isError && SCENES.every((id) => ids.includes(id));
    const r = await call(main, "render", { plan: twoClips(), recording: "recording.mp4", name: "free-film" });
    if (r.result.isError) throw new Error(`render refused: ${JSON.stringify(r.value.problems)}`);
    film = r.value.files[0].path;
    const p = probe(film);
    const stills = [];
    for (const format of ["png", "jpeg"]) {
      const s = await call(main, "still", { plan: twoClips(), recording: "recording.mp4", name: `still-${format}`, seconds: 1.2, format });
      if (s.result.isError) throw new Error(`still ${format} refused: ${JSON.stringify(s.value.problems)}`);
      const file = s.value.files[0].path;
      const head = fs.readFileSync(file).subarray(0, 4);
      const magic = format === "png" ? head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) : head[0] === 0xff && head[1] === 0xd8;
      const sp = probe(file);
      stills.push({
        format,
        ok: magic && path.dirname(file) === output && Math.max(sp.width, sp.height) <= 720 && s.value.notice === FREE_NOTICE,
        detail: `${nameOf(file)} ${sp.width}x${sp.height} ${magic ? "magic ok" : "wrong magic"}`,
      });
    }
    results.freeFilm = { file: nameOf(film), ms: r.ms, ...p, phases: r.phases.map((x) => x.phase).filter((x, i, a) => x !== a[i - 1]) };
    pass(
      "free film and stills",
      listedOk &&
        r.value.files.length === 1 &&
        path.dirname(film) === output &&
        p.frames === frames &&
        Math.max(p.width, p.height) <= 720 &&
        r.value.notice === FREE_NOTICE &&
        stills.every((s) => s.ok),
      `list_scenes ${ids.length} iPhone scenes (${listedOk ? "both plan scenes listed" : "plan scenes missing"}); ${nameOf(film)} ${p.frames} frames ` +
        `(expected ${frames}) at ${p.width}x${p.height} in ${r.ms} ms; notice ${r.value.notice === FREE_NOTICE ? "verbatim" : JSON.stringify(r.value.notice)}; ` +
        `warnings ${r.value.warnings?.length ?? 0}; stills: ${stills.map((s) => s.detail).join(", ")}`,
    );
  });

  // ------------------------------------------------------------------ scenes delivery
  await attempt("scenes delivery", async () => {
    const r = await call(main, "render", { plan: twoClips({ delivery: "scenes" }), recording: "recording.mp4", name: "scenes" });
    if (r.result.isError) throw new Error(`refused: ${JSON.stringify(r.value.problems)}`);
    const probes = r.value.files.map((f) => ({ name: nameOf(f.path), ...probe(f.path) }));
    const expected = [Math.round(1 * fps), Math.round(1.5 * fps)];
    pass(
      "scenes delivery",
      probes.length === 2 && probes.every((p, i) => p.frames === expected[i]) && r.value.files.every((f) => path.dirname(f.path) === output),
      probes.map((p, i) => `${p.name}: ${p.frames} frames (expected ${expected[i]})`).join("; "),
    );
  });

  // ------------------------------------------------------------------------- escapes
  await attempt("escapes", async () => {
    const leaveOut = [data, output, work];
    const before = tree(root, leaveOut);
    const outsideAbs = await call(main, "render", { plan: twoClips(), recording: path.join(outside, "recording.mp4"), name: "outside" });
    const outsideRel = await call(main, "render", { plan: twoClips(), recording: "../outside/recording.mp4", name: "outside-rel" });
    const escapingName = await call(main, "still", {
      plan: twoClips(),
      recording: "recording.mp4",
      name: "../../escaped",
      seconds: 0.5,
      format: "png",
    });
    const after = tree(root, leaveOut);
    const named = escapingName.result.isError ? null : escapingName.value.files[0].path;
    const nameStays = escapingName.result.isError || (named && path.dirname(named) === output);
    const strays = tree(root, [data, work]).filter((f) => /escaped|outside/i.test(f) && !f.startsWith(`outside${path.sep}recording.mp4`));
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    pass(
      "escapes",
      outsideAbs.result.isError && outsideRel.result.isError && nameStays && unchanged && strays.every((f) => f.startsWith(`project with spaces${path.sep}motion-mockups${path.sep}`)),
      `recording outside the root (absolute): refused ${codes(outsideAbs.value) || "NOT refused"}; "../outside/recording.mp4": refused ${codes(outsideRel.value) || "NOT refused"}; ` +
        `name "../../escaped": ${escapingName.result.isError ? `refused ${codes(escapingName.value)}` : `cleaned to motion-mockups/${nameOf(named)}`}; ` +
        `files outside motion-mockups/ ${unchanged ? "unchanged" : `changed: ${after.filter((f) => !before.includes(f)).join(", ")}`}`,
    );
  });

  // ----------------------------------------------------------- two adapters at once
  await attempt("two adapters at once", async () => {
    const a = main;
    const b = await startAdapter();
    adapters.push(b);
    // The lock file, watched: each holder's first and last sighting.
    const holders = new Map();
    const t0 = performance.now();
    const watch = setInterval(() => {
      try {
        const held = JSON.parse(fs.readFileSync(path.join(data, "render.lock"), "utf8"));
        const now = Math.round(performance.now() - t0);
        const h = holders.get(held.token) ?? { pid: held.pid, first: now, last: now };
        h.last = now;
        holders.set(held.token, h);
      } catch {
        // Not held, or being written.
      }
    }, 20);
    const waited = { a: false, b: false };
    const [ra, rb] = await Promise.all([
      call(a, "render", { plan: twoClips(), recording: "recording.mp4", name: "two-a" }, { onPhase: (p) => p === "waiting" && (waited.a = true) }),
      call(b, "render", { plan: twoClips(), recording: "recording.mp4", name: "two-b" }, { onPhase: (p) => p === "waiting" && (waited.b = true) }),
    ]);
    clearInterval(watch);
    const windowsHeld = [...holders.values()].sort((x, y) => x.first - y.first);
    const disjoint = windowsHeld.every((w, i) => i === 0 || w.first > windowsHeld[i - 1].last);
    const pids = windowsHeld.map((w) => w.pid);
    const both = !ra.result.isError && !rb.result.isError && probe(ra.value.files[0].path).frames === frames && probe(rb.value.files[0].path).frames === frames;
    results.twoAdapters = { holds: windowsHeld, waited, aMs: ra.ms, bMs: rb.ms };
    pass(
      "two adapters at once",
      both && windowsHeld.length === 2 && disjoint && pids.includes(a.pid) && pids.includes(b.pid) && (waited.a || waited.b),
      `both rendered ${frames} frames: ${both}; lock holds (ms from start) ${windowsHeld.map((w) => `pid ${w.pid} ${w.first}–${w.last}`).join(", ")}; ` +
        `${disjoint ? "no overlap" : "OVERLAP"}; waiting reported by ${waited.a ? "A" : ""}${waited.b ? "B" : ""}`,
    );
    await b.close();
  });

  // ------------------------------------------------------------- cancel, then render
  await attempt("cancel, then render", async () => {
    const controller = new AbortController();
    let cancelledAt = "";
    const started = call(main, "render", { plan: longFilm(), recording: "recording.mp4", name: "cancelled" }, {
      signal: controller.signal,
      onPhase: (phase) => {
        if (phase === "rendering" && !controller.signal.aborted) {
          cancelledAt = phase;
          controller.abort("e2e cancel"); // the SDK sends notifications/cancelled
        }
      },
    });
    const outcome = await started.then(
      () => "answered",
      (error) => `rejected (${String(error?.message ?? error).slice(0, 60)})`,
    );
    const gone = await chromeGone(10_000, [main.pid]);
    let lockGone = false;
    for (let i = 0; i < 40 && !(lockGone = !fs.existsSync(path.join(data, "render.lock"))); i++) await delay(250);
    const leftovers = fs.readdirSync(output).filter((f) => f.startsWith("cancelled") || f.includes(".partial-"));
    const staged = fs.existsSync(path.join(data, "staging")) ? fs.readdirSync(path.join(data, "staging")) : [];
    const next = await call(main, "render", { plan: twoClips(), recording: "recording.mp4", name: "after-cancel" });
    const nextFrames = next.result.isError ? 0 : probe(next.value.files[0].path).frames;
    pass(
      "cancel, then render",
      cancelledAt === "rendering" && gone.gone && lockGone && !leftovers.length && !staged.length && nextFrames === frames,
      `cancelled while ${cancelledAt || "never rendering"}, call ${outcome}; this run's Chrome ${gone.gone ? `gone after ${gone.ms} ms` : `${gone.left} left after ${gone.ms} ms`}; ` +
        `lock ${lockGone ? "released" : "still there"}; leftovers in motion-mockups/ ${leftovers.length}, in staging ${staged.length}; ` +
        `next render ${next.result.isError ? `refused ${codes(next.value)}` : `${nextFrames} frames`}`,
    );
    if (!gone.gone) killOurChrome();
  });

  // ------------------------------------------------------- adapter killed mid-render
  await attempt("adapter killed mid-render", async () => {
    const runs = [];
    const staging = path.join(data, "staging");
    const stagedNames = () => (fs.existsSync(staging) ? fs.readdirSync(staging) : []);
    const taskkill = (pid) =>
      execFileSync(path.join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
    // The last one is killed the moment it reports saving, before anything else runs (counting
    // Chrome takes PowerShell most of a second, longer than a save). Whether it lands before the
    // save ends is a race, so it is recorded, not required: the planted files below are the check.
    for (const how of ["taskkill /F", "client close", "taskkill /F while saving"]) {
      if (!windows && how.startsWith("taskkill /F")) continue;
      const saving = how.endsWith("while saving");
      const k = await startAdapter();
      let hit;
      let killedAt = 0;
      const killed = new Promise((resolve) => (hit = resolve));
      const rendering = call(k, "render", { plan: longFilm(), recording: "recording.mp4", name: `killed-${saving ? "saving" : how.split(" ")[0]}` }, {
        onPhase: (phase) => {
          if (phase !== (saving ? "saving" : "rendering")) return;
          if (saving && !killedAt) {
            killedAt = performance.now();
            taskkill(k.pid);
          }
          hit();
        },
      }).then(
        () => "answered before the kill",
        () => "killed before it answered",
      );
      await Promise.race([killed, delay(60_000)]);
      const whileRendering = saving ? null : ours([k.pid]).length;
      const at = killedAt || performance.now();
      let closing = Promise.resolve();
      if (saving) {
        // Killed above.
      } else if (how === "taskkill /F") {
        taskkill(k.pid);
      } else {
        // The SDK ends stdin, then sends SIGTERM 2 s later if the server is still there.
        closing = k.close();
      }
      const gone = await chromeGone(10_000, [k.pid]);
      await closing;
      const sinceKill = Math.round(performance.now() - at);
      const outcome = await rendering;
      await k.close();
      runs.push({
        how,
        chromeWhileRendering: whileRendering,
        gone: gone.gone,
        ms: gone.gone ? sinceKill : null,
        left: gone.left,
        ...(saving ? { killed: !!killedAt, call: outcome, stagedAfterKill: stagedNames() } : {}),
      });
      if (!gone.gone) killOurChrome();
    }
    // What a kill while saving leaves, whether or not this run's kill landed in time: Chrome's
    // download names (whole and .crdownload), and a file that is not one of them, which stays.
    const planted = ["3f2504e0-4f89-41d3-9a0c-0305e82c3301", "3F2504E0-4F89-41D3-9A0C-0305E82C3302.crdownload"];
    const keep = "not-a-download.txt";
    fs.mkdirSync(staging, { recursive: true });
    for (const name of [...planted, keep]) fs.writeFileSync(path.join(staging, name), "left by a killed adapter");
    const before = stagedNames();
    // The killed adapter's lock names a pid that is gone: the next render takes it over at once.
    const next = await call(main, "render", { plan: twoClips(), recording: "recording.mp4", name: "after-kill" });
    const nextFrames = next.result.isError ? 0 : probe(next.value.files[0].path).frames;
    const afterNext = stagedNames();
    fs.rmSync(path.join(staging, keep), { force: true });
    const swept = afterNext.length === 1 && afterNext[0] === keep;
    results.killed = { runs, nextMs: next.ms, staging: { before, afterNextRender: afterNext } };
    pass(
      "adapter killed mid-render",
      runs.length > 0 &&
        runs.every((r) => (r.chromeWhileRendering === null ? r.killed : r.chromeWhileRendering > 0) && r.gone) &&
        nextFrames === frames &&
        swept,
      runs
        .map((r) =>
          r.chromeWhileRendering === null
            ? `${r.how}: ${r.killed ? `killed as saving began, ${r.call}` : "never reached saving"}, ` +
              `${r.gone ? `no Chrome left after ${r.ms} ms` : `${r.left} Chrome still running after 10 s`}, ${r.stagedAfterKill.length} file(s) left in staging`
            : `${r.how}: ${r.chromeWhileRendering} Chrome processes while rendering, ${r.gone ? `none left after ${r.ms} ms` : `${r.left} still running after 10 s`}`,
        )
        .join("; ") +
        `; next render ${next.result.isError ? `refused ${codes(next.value)}` : `${nextFrames} frames in ${next.ms} ms`}` +
        `; staging before it [${before.join(", ")}], after it [${afterNext.join(", ")}] (only ${keep} may stay)`,
    );
  });

  // ------------------------------------------------------------------ Chrome problems
  await attempt("Chrome problems", async () => {
    const missing = path.join(root, "no-chrome-here", windows ? "chrome.exe" : "chrome");
    const c = await startAdapter({ MOTIONMOCKUPS_CHROME: missing });
    const r = await call(c, "render", { plan: twoClips(), recording: "recording.mp4", name: "no-chrome" });
    await c.close();
    const chromeCode = codes(r.value);
    // A foreign origin: the server refuses to start, before any MCP message.
    const child = spawnSync(process.execPath, [BUNDLE, "mcp"], {
      env: { ...process.env, MOTIONMOCKUPS_ORIGIN: "https://example.com", MOTIONMOCKUPS_DATA: data },
      input: "",
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    const originRefused = child.status === 1 && child.stdout === "" && /MOTIONMOCKUPS_ORIGIN is "https:\/\/example\.com", which is not the Motion Mockups site/.test(child.stderr);
    pass(
      "Chrome problems",
      r.result.isError && chromeCode === "chrome" && originRefused,
      `MOTIONMOCKUPS_CHROME=<missing>: ${r.result.isError ? `refused code ${chromeCode}` : "NOT refused"} ("${r.value.problems?.[0]?.message ?? ""}"); ` +
        `MOTIONMOCKUPS_ORIGIN=https://example.com: exit ${child.status}, stdout ${child.stdout ? "not empty" : "empty"}, ` +
        `stderr "${child.stderr.trim().split("\n")[0]}" (siteOrigin's code "origin" refusal; the command line prints its message and fix)`,
    );
  });

  // ---------------------------------------------------------- equality with the page
  const compare = (file) => {
    const ssim = ssimPerFrame(file, REFERENCE);
    const cuts = [];
    let at = 0;
    for (const clip of twoClips().clips.slice(0, -1)) {
      at += Math.round(clip.seconds * fps);
      cuts.push(at);
    }
    const sides = cuts.flatMap((c) => [c - 1, c]);
    return {
      ssim,
      sides: sides.map((n) => ({ frame: n, ssim: round(ssim[n]) })),
      min: round(Math.min(...ssim)),
      mean: round(ssim.reduce((s, x) => s + x, 0) / ssim.length),
    };
  };
  let reference;
  if (!REFERENCE) skip("equality with the page", "MOTIONMOCKUPS_E2E_REFERENCE is not set");
  else
    await attempt("equality with the page", async () => {
      if (!film) throw new Error("no free film to compare");
      reference = probe(REFERENCE);
      const p = probe(film);
      const c = compare(film);
      // Every frame's presentation time, equal within half a frame.
      const filmTimes = frameTimes(film);
      const pageTimes = frameTimes(REFERENCE);
      // One time per frame on each side: two empty lists (an ffprobe that read nothing) never pass.
      const counted = filmTimes.length === p.frames && pageTimes.length === reference.frames && filmTimes.length > 0;
      const worst = counted && filmTimes.length === pageTimes.length ? filmTimes.reduce((w, t, i) => Math.max(w, Math.abs(t - pageTimes[i])), 0) : Infinity;
      const timesMatch = counted && worst <= 0.5 / fps;
      results.equality = {
        reference: { file: REFERENCE, ...reference },
        film: p,
        timestamps: { film: filmTimes.length, page: pageTimes.length, worstDifference: worst, allowed: 0.5 / fps },
        sides: c.sides,
        min: c.min,
        mean: c.mean,
      };
      pass(
        "equality with the page",
        p.frames === reference.frames &&
          p.width === reference.width &&
          p.height === reference.height &&
          timesMatch &&
          c.sides.every((s) => s.ssim >= 0.97) &&
          c.min >= 0.97,
        `${p.frames} frames vs the page's ${reference.frames}, ${p.width}x${p.height} vs ${reference.width}x${reference.height}; ` +
          `frame times ${filmTimes.length} vs ${pageTimes.length} (frames ${p.frames} vs ${reference.frames}), worst difference ${Number.isFinite(worst) ? `${round(worst, 6)} s` : "counts differ"} (≤ ${round(0.5 / fps, 6)} s allowed); ` +
          `SSIM either side of the cut ${c.sides.map((s) => `f${s.frame} ${s.ssim}`).join(", ")}, all frames min ${c.min}, mean ${c.mean} (every frame needs ≥ 0.97)`,
      );
    });

  // -------------------------------------------------------------- Chrome mode, measured
  if (MODES) {
    const modes = {};
    let focusWindow;
    if (windows) {
      focusWindow = openFocusWindow();
      await delay(2500);
    }
    try {
      for (const mode of ["headless", "window"]) {
        const m = await startAdapter({ MOTIONMOCKUPS_CHROME_MODE: mode });
        const runs = [];
        let focus;
        let seen; // this run's Chrome while it renders: how it was started
        for (let i = 0; i < 2; i++) {
          const watching = windows && i === 0 ? await watchForeground() : null;
          const r = await call(m, "render", { plan: twoClips(), recording: "recording.mp4", name: `mode-${mode}` }, {
            onPhase: (phase) => {
              if (phase !== "rendering" || seen) return;
              const procs = ours([m.pid]);
              seen = {
                processes: procs.length,
                pids: procs.map((p) => p.pid),
                browser: procs.filter((p) => p.parent === m.pid).map((p) => p.pid),
                headlessFlag: procs.some((p) => / --headless\b/.test(p.line)),
              };
            },
          });
          if (watching) focus = await watching.stop();
          if (r.result.isError) {
            runs.push({ ms: r.ms, refused: r.value.problems });
            continue;
          }
          const file = r.value.files[0].path;
          const p = probe(file);
          const c = REFERENCE ? compare(file) : null;
          runs.push({
            ms: r.ms,
            frames: p.frames,
            size: `${p.width}x${p.height}`,
            bitRate: p.bitRate,
            bytes: fs.statSync(file).size,
            sha256: sha256(file),
            profile: p.profile,
            level: p.level,
            warnings: r.value.warnings,
            ...(c ? { ssimSides: c.sides, ssimMin: c.min, ssimMean: c.mean } : {}),
          });
        }
        await m.close();
        // Focus is taken when the foreground moves to a window of this run's Chrome. The window
        // in front is our own when Windows let us bring it forward, else whatever the person had
        // in front. Null when it could not be measured (not Windows).
        const toOurChrome = focus ? focus.changes.filter((c) => seen?.pids.includes(c.pid)) : [];
        const keptFocus = focus ? toOurChrome.length === 0 && focus.after?.hwnd === focus.before?.hwnd : null;
        modes[mode] = { runs, chrome: seen ?? null, focus: focus ? { ...focus, inFrontWasOurs: focus.before?.title === FOCUS_TITLE } : null, keptFocus };
        if (!(await chromeGone(10_000)).gone) killOurChrome();
      }
    } finally {
      if (focusWindow) {
        try {
          execFileSync(path.join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/PID", String(focusWindow.pid)], {
            windowsHide: true,
            stdio: "ignore",
          });
        } catch {
          // Already closed.
        }
      }
    }
    const quality = (mode) => {
      const r = modes[mode]?.runs[0];
      return !!r && !r.refused && r.frames === frames && (!REFERENCE || (r.ssimSides.every((s) => s.ssim >= 0.97) && r.ssimMin >= 0.97));
    };
    const headlessOk = quality("headless");
    const windowOk = quality("window");
    // The rule: headless unless it fails equality or quality where window passes.
    const chosen = !headlessOk && windowOk ? "window" : "headless";
    results.chromeModes = { modes, headlessPasses: headlessOk, windowPasses: windowOk, windowKeepsFocus: modes.window?.keptFocus ?? null, default: chosen };
    for (const [mode, m] of Object.entries(modes)) {
      const r = m.runs[0];
      console.log(
        `MODE  ${mode}: ${r?.refused ? `refused ${JSON.stringify(r.refused)}` : `${r.frames} frames ${r.size}, ${Math.round(r.bitRate / 1000)} kb/s, ${r.profile} ${r.level}` + (r.ssimSides ? `, SSIM cut sides ${r.ssimSides.map((s) => s.ssim).join("/")} min ${r.ssimMin} mean ${r.ssimMean}` : "")}; ` +
          `render ${m.runs.map((x) => `${x.ms} ms`).join(", ")}; Chrome ${m.chrome ? `${m.chrome.processes} processes, --headless ${m.chrome.headlessFlag}` : "not seen"}; ` +
          `focus ${m.keptFocus === null ? "not measured" : `${m.keptFocus ? "kept" : "TAKEN"}, in front ${m.focus.before?.name} "${m.focus.before?.title}"${m.focus.changes.length ? ` (changes: ${m.focus.changes.map((c) => `${c.name}/${c.pid} "${c.title}"`).join(" -> ")})` : ""}`}`,
      );
    }
    console.log(`MODE  default: ${chosen}`);
  }
} catch (error) {
  record("run", "fail", `threw: ${String(error?.stack ?? error).split("\n").slice(0, 3).join(" ")}`);
} finally {
  for (const a of adapters) await a.close();
  if (!(await chromeGone(10_000)).gone) killOurChrome();
  for (const name of CHECK_NAMES) if (!checks.some((c) => c.name === name)) skip(name, "not reached");
  results.checks = checks;
  results.tally = {
    pass: checks.filter((c) => c.result === "pass").length,
    fail: checks.filter((c) => c.result === "fail").length,
    skip: checks.filter((c) => c.result === "skip").length,
  };
  fs.writeFileSync(RESULTS, `${JSON.stringify(redact(results), null, 2)}\n`);
  console.log(`\n${results.tally.pass} pass, ${results.tally.fail} fail, ${results.tally.skip} skipped; ${path.relative(process.cwd(), RESULTS)}`);
  if (KEEP) console.log(`kept ${root}`);
  else fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  if (results.tally.fail) process.exitCode = 1;
}
