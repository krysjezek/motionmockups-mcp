import { mock, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  allowedFolders,
  createOutput,
  createPartial,
  insideAllowed,
  outputFolder,
  publishOutput,
  readableRecording,
  safeName,
} from "../src/folders.ts";
import { dataFolder } from "../src/paths.ts";

const windows = process.platform === "win32";

// A real MP4 start: a 32-byte ftyp box (isom; compatible isom iso2 avc1 mp41), then a free box.
const MP4_HEADER = Buffer.concat([
  Buffer.from([0, 0, 0, 0x20]),
  Buffer.from("ftypisom", "latin1"),
  Buffer.from([0, 0, 2, 0]),
  Buffer.from("isomiso2avc1mp41", "latin1"),
  Buffer.from([0, 0, 0, 8]),
  Buffer.from("free", "latin1"),
]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
const AVIF = Buffer.concat([
  Buffer.from([0, 0, 0, 0x1c]),
  Buffer.from("ftypavif", "latin1"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("avifmif1miaf", "latin1"),
]);
const HEIC = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypheic", "latin1"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("mif1heic", "latin1"),
]);

/** A fresh temp directory (its real path), removed after the test; links are removed first, never recursed through. */
function sandbox(t: TestContext): { dir: string; link: (kind: "file" | "dir" | "junction", target: string, at: string) => boolean } {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mm-folders-")));
  const links: { at: string; kind: "file" | "dir" | "junction" }[] = [];
  t.after(() => {
    for (const { at, kind } of links.reverse()) {
      try {
        if (kind === "file") fs.unlinkSync(at);
        else fs.rmdirSync(at); // removes a junction or a directory symlink, never what it points to
      } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const link = (kind: "file" | "dir" | "junction", target: string, at: string): boolean => {
    try {
      if (kind === "junction") {
        execFileSync("cmd", ["/c", "mklink", "/J", at, target], { stdio: "ignore" });
      } else {
        fs.symlinkSync(target, at, kind);
      }
    } catch {
      return false;
    }
    links.push({ at, kind });
    return true;
  };
  return { dir, link };
}

function write(file: string, bytes: Buffer | string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

test("a recording inside a root is readable", async (t) => {
  const { dir } = sandbox(t);
  const root = path.join(dir, "project");
  const clip = write(path.join(root, "clip.mp4"), Buffer.concat([MP4_HEADER, Buffer.alloc(100)]));
  const allowed = await allowedFolders([root], {});
  const result = await readableRecording(clip, allowed);
  assert.deepEqual(result, { ok: true, value: { path: clip, kind: "video", bytes: MP4_HEADER.length + 100 } });
});

test("folders given on the command line: each is one folder; a placeholder, a relative path or an empty one is not allowed", async (t) => {
  const { dir } = sandbox(t);
  const picked = path.join(dir, `2026${path.delimiter}launch`);
  fs.mkdirSync(picked);
  assert.deepEqual(await allowedFolders([], {}, [picked]), [picked]);
  for (const entry of ["${user_config.allowed_folders}", "relative/folder", "", "  "])
    assert.deepEqual(await allowedFolders([], {}, [entry]), [], JSON.stringify(entry));
  // Through MOTIONMOCKUPS_FOLDERS the same name is split in two, neither of which exists.
  assert.deepEqual(await allowedFolders([], { MOTIONMOCKUPS_FOLDERS: picked }), []);
});

test("a path with a space and a non-ASCII letter is readable", async (t) => {
  const { dir } = sandbox(t);
  const root = path.join(dir, "My Recordings č");
  const clip = write(path.join(root, "nahrávka č 1.mp4"), MP4_HEADER);
  const allowed = await allowedFolders([root], {});
  const result = await readableRecording(clip, allowed);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.equal(result.value.path, clip);
});

test("a relative path resolves inside the first allowed folder", async (t) => {
  const { dir } = sandbox(t);
  const root = path.join(dir, "project");
  const clip = write(path.join(root, "rec", "clip.mp4"), MP4_HEADER);
  const result = await readableRecording(path.join("rec", "clip.mp4"), await allowedFolders([root], {}));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.equal(result.value.path, clip);
});

test("every accepted type is recognised by its bytes", async (t) => {
  const { dir } = sandbox(t);
  const allowed = await allowedFolders([dir], {});
  const cases: [string, Buffer, "video" | "image"][] = [
    ["a.mp4", MP4_HEADER, "video"],
    ["a.mov", MP4_HEADER, "video"],
    ["a.webm", WEBM, "video"],
    ["a.mkv", WEBM, "video"], // Matroska shares WebM's EBML header
    ["a.MKV", WEBM, "video"],
    ["a.png", PNG, "image"],
    ["a.JPG", JPEG, "image"],
    ["a.jpeg", JPEG, "image"],
    ["a.webp", WEBP, "image"],
    ["a.avif", AVIF, "image"],
  ];
  for (const [name, bytes, kind] of cases) {
    const result = await readableRecording(write(path.join(dir, name), bytes), allowed);
    assert.equal(result.ok && result.value.kind, kind, `${name}: ${JSON.stringify(result)}`);
  }
});

test(".. and absolute escapes are refused", async (t) => {
  const { dir } = sandbox(t);
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  const outside = write(path.join(dir, "secret.mp4"), MP4_HEADER);
  const allowed = await allowedFolders([root], {});

  for (const attempt of [path.join(root, "..", "secret.mp4"), outside, path.join("..", "secret.mp4")]) {
    const result = await readableRecording(attempt, allowed);
    assert.equal(result.ok, false, attempt);
    if (!result.ok) {
      assert.equal(result.problems[0]!.code, "folder");
      assert.ok(result.problems[0]!.message.includes(outside), result.problems[0]!.message);
      assert.ok(result.problems[0]!.fix.length > 0);
    }
  }
});

test("a sibling folder sharing the root's prefix is outside", async (t) => {
  const { dir } = sandbox(t);
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  const sibling = write(path.join(dir, "project-secrets", "clip.mp4"), MP4_HEADER);
  const result = await readableRecording(sibling, await allowedFolders([root], {}));
  assert.equal(!result.ok && result.problems[0]!.code, "folder");
});

test("a symlink out is refused", async (t) => {
  const { dir, link } = sandbox(t);
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  const outside = write(path.join(dir, "outside", "secret.mp4"), MP4_HEADER);
  const allowed = await allowedFolders([root], {});

  const fileLink = path.join(root, "clip.mp4");
  if (!link("file", outside, fileLink)) {
    t.skip("this system cannot create file symlinks");
    return;
  }
  const viaFile = await readableRecording(fileLink, allowed);
  assert.equal(!viaFile.ok && viaFile.problems[0]!.code, "folder", JSON.stringify(viaFile));

  const dirLink = path.join(root, "linked");
  if (link("dir", path.dirname(outside), dirLink)) {
    const viaDir = await readableRecording(path.join(dirLink, "secret.mp4"), allowed);
    assert.equal(!viaDir.ok && viaDir.problems[0]!.code, "folder", JSON.stringify(viaDir));
  }
});

test("a symlink that stays inside the root is followed", async (t) => {
  const { dir, link } = sandbox(t);
  const root = path.join(dir, "project");
  const real = write(path.join(root, "takes", "clip.mp4"), MP4_HEADER);
  const at = path.join(root, "latest.mp4");
  if (!link("file", real, at)) {
    t.skip("this system cannot create file symlinks");
    return;
  }
  const result = await readableRecording(at, await allowedFolders([root], {}));
  assert.equal(result.ok && result.value.path, real, JSON.stringify(result));
});

test("a Windows junction out is refused", { skip: !windows && "junctions exist only on Windows" }, async (t) => {
  const { dir, link } = sandbox(t);
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  const outside = write(path.join(dir, "outside", "secret.mp4"), MP4_HEADER);
  const junction = path.join(root, "junction");
  if (!link("junction", path.dirname(outside), junction)) {
    t.skip("mklink /J failed here");
    return;
  }
  const result = await readableRecording(path.join(junction, "secret.mp4"), await allowedFolders([root], {}));
  assert.equal(!result.ok && result.problems[0]!.code, "folder", JSON.stringify(result));
});

test("an allowed folder that is itself a link is used by its real path", async (t) => {
  const { dir, link } = sandbox(t);
  const real = path.join(dir, "real");
  const clip = write(path.join(real, "clip.mp4"), MP4_HEADER);
  const alias = path.join(dir, "alias");
  if (!link(windows ? "junction" : "dir", real, alias)) {
    t.skip("cannot link a folder here");
    return;
  }
  const allowed = await allowedFolders([alias], {});
  assert.deepEqual(allowed, [real]);
  const result = await readableRecording(path.join(alias, "clip.mp4"), allowed);
  assert.equal(result.ok && result.value.path, clip, JSON.stringify(result));
});

test("a renamed text file is refused", async (t) => {
  const { dir } = sandbox(t);
  const fake = write(path.join(dir, "id_rsa.mp4"), "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n");
  const result = await readableRecording(fake, await allowedFolders([dir], {}));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.problems[0]!.code, "recording");
    assert.ok(!result.problems[0]!.message.includes("OPENSSH"), "never echo file contents");
  }
});

test("other files that are not recordings are refused", async (t) => {
  const { dir } = sandbox(t);
  const allowed = await allowedFolders([dir], {});
  fs.mkdirSync(path.join(dir, "folder.mp4"));
  const cases = [
    path.join(dir, "folder.mp4"), // a directory
    write(path.join(dir, "empty.mp4"), Buffer.alloc(0)),
    write(path.join(dir, "photo.heic"), HEIC),
    write(path.join(dir, "photo.mp4"), HEIC), // HEIF is an ftyp file too, but not a video
    write(path.join(dir, "clip.exe"), MP4_HEADER), // right bytes, wrong kind of file
    write(path.join(dir, "still.mp4"), PNG), // an image dressed as a video
    path.join(dir, "missing.mp4"),
  ];
  for (const file of cases) {
    const result = await readableRecording(file, allowed);
    assert.equal(!result.ok && result.problems[0]!.code, "recording", `${file}: ${JSON.stringify(result)}`);
  }
});

test("no allowed folder", async (t) => {
  const { dir } = sandbox(t);
  const clip = write(path.join(dir, "clip.mp4"), MP4_HEADER);
  for (const result of [await readableRecording(clip, []), await outputFolder([])]) {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problems[0]!.code, "no-folder");
      assert.match(result.problems[0]!.fix, /MOTIONMOCKUPS_FOLDERS/);
    }
  }
});

test("allowed folders: roots first, then MOTIONMOCKUPS_FOLDERS, real, existing and once each", async (t) => {
  const { dir } = sandbox(t);
  const a = path.join(dir, "a");
  const b = path.join(dir, "b");
  const c = path.join(dir, "c");
  for (const f of [a, b, c]) fs.mkdirSync(f);
  const file = write(path.join(dir, "file.txt"), "x");
  const env = {
    MOTIONMOCKUPS_FOLDERS: [c, "", "relative/folder", path.join(dir, "missing"), file, a + path.sep, ` ${b} `].join(path.delimiter),
  };
  const roots = [pathToFileURL(b).href, a, windows ? a.toUpperCase() : a];
  assert.deepEqual(await allowedFolders(roots, env), [b, a, c]);
  assert.deepEqual(await allowedFolders([], {}), []);
});

test("output lives in motion-mockups of the first root", async (t) => {
  const { dir } = sandbox(t);
  const first = path.join(dir, "first");
  const second = path.join(dir, "second");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const allowed = await allowedFolders([first, second], {});
  const result = await outputFolder(allowed);
  assert.deepEqual(result, { ok: true, value: path.join(first, "motion-mockups") });
  assert.ok(fs.statSync(path.join(first, "motion-mockups")).isDirectory());
  // A second call finds the folder it made.
  assert.deepEqual(await outputFolder(allowed), result);
});

test("a motion-mockups that leads out is refused", async (t) => {
  const { dir, link } = sandbox(t);
  const root = path.join(dir, "project");
  const elsewhere = path.join(dir, "Startup");
  fs.mkdirSync(root);
  fs.mkdirSync(elsewhere);
  const made = link("dir", elsewhere, path.join(root, "motion-mockups")) ||
    (windows && link("junction", elsewhere, path.join(root, "motion-mockups")));
  if (!made) {
    t.skip("cannot link a folder here");
    return;
  }
  const result = await outputFolder(await allowedFolders([root], {}));
  assert.equal(!result.ok && result.problems[0]!.code, "folder", JSON.stringify(result));
});

test("a motion-mockups junction that leads out is refused", { skip: !windows && "junctions exist only on Windows" }, async (t) => {
  const { dir, link } = sandbox(t);
  const root = path.join(dir, "project");
  const elsewhere = path.join(dir, "Startup");
  fs.mkdirSync(root);
  fs.mkdirSync(elsewhere);
  if (!link("junction", elsewhere, path.join(root, "motion-mockups"))) {
    t.skip("mklink /J failed here");
    return;
  }
  const result = await outputFolder(await allowedFolders([root], {}));
  assert.equal(!result.ok && result.problems[0]!.code, "folder", JSON.stringify(result));
});

test("a file called motion-mockups is refused", async (t) => {
  const { dir } = sandbox(t);
  write(path.join(dir, "motion-mockups"), "not a folder");
  const result = await outputFolder(await allowedFolders([dir], {}));
  assert.equal(!result.ok && result.problems[0]!.code, "output", JSON.stringify(result));
});

test("safeName", () => {
  assert.equal(safeName("../x", "fallback"), "x");
  assert.equal(safeName("..\\..\\Windows\\x", "fallback"), "Windows-x");
  assert.equal(safeName("CON", "fallback"), "CON_");
  assert.equal(safeName("con.backup", "fallback"), "con_.backup");
  assert.equal(safeName("LPT1", "fallback"), "LPT1_");
  assert.equal(safeName("a:b.", "fallback"), "a-b");
  assert.equal(safeName("a".repeat(300), "fallback"), "a".repeat(120));
  assert.equal(safeName("", "fallback"), "fallback");
  assert.equal(safeName(undefined, "fallback"), "fallback");
  assert.equal(safeName(" .. ", "fallback"), "fallback");
  assert.equal(safeName("Launch film č", "fallback"), "Launch film č");
  assert.equal(safeName("a\u0000b\u202ec", "fallback"), "abc");
  assert.equal(safeName('wh<at>"|?*', "fallback"), "wh-at");
  // Long multi-byte names stay within file-system name limits.
  const wide = safeName("😀".repeat(200), "fallback");
  assert.ok(Buffer.byteLength(wide) <= 200 && wide.length > 0 && !wide.includes("\ufffd"));
  // Idempotent.
  for (const n of ["../x", "CON", "a:b.", "a".repeat(300)]) assert.equal(safeName(safeName(n, "f"), "f"), safeName(n, "f"));
});

test("never overwrites", async (t) => {
  const { dir } = sandbox(t);
  const first = await createOutput(dir, "name", "mp4");
  await first.handle.close();
  const second = await createOutput(dir, "name", ".mp4");
  await second.handle.write(Buffer.from("second"));
  await second.handle.close();
  assert.equal(first.path, path.join(dir, "name.mp4"));
  assert.equal(second.path, path.join(dir, "name (2).mp4"));

  write(path.join(dir, "kept.mp4"), "existing bytes");
  write(path.join(dir, "kept (2).mp4"), "existing bytes 2");
  const third = await createOutput(dir, "kept", "mp4");
  await third.handle.close();
  assert.equal(third.path, path.join(dir, "kept (3).mp4"));
  assert.equal(fs.readFileSync(path.join(dir, "kept.mp4"), "utf8"), "existing bytes");
  assert.equal(fs.readFileSync(path.join(dir, "kept (2).mp4"), "utf8"), "existing bytes 2");
  assert.equal(fs.readFileSync(second.path, "utf8"), "second");
});

test("a dangling link at the name is taken, and nothing is created where it points", async (t) => {
  const { dir, link } = sandbox(t);
  const out = path.join(dir, "motion-mockups");
  fs.mkdirSync(out);
  const target = path.join(dir, "elsewhere", "planted.txt");
  fs.mkdirSync(path.dirname(target));
  if (!link("file", target, path.join(out, "name.mp4"))) {
    t.skip("this system cannot create file symlinks");
    return;
  }
  const made = await createOutput(out, "name", "mp4");
  await made.handle.write(Buffer.from("result"));
  await made.handle.close();
  assert.equal(made.path, path.join(out, "name (2).mp4"));
  assert.equal(fs.existsSync(target), false, "the link target must not be created");
  assert.ok(fs.lstatSync(path.join(out, "name.mp4")).isSymbolicLink(), "the planted link is left alone");
});

/**
 * Replaces the fs/promises calls the rules use with ones that record their paths and never
 * reach the file system for anything outside `dir` (so a test can never contact a network host).
 */
function spyOnFiles(t: TestContext, dir: string): string[] {
  const touched: string[] = [];
  for (const name of ["realpath", "stat", "lstat", "open", "access", "readFile"] as const) {
    const original = fs.promises[name] as (...args: unknown[]) => Promise<unknown>;
    mock.method(fs.promises, name, async (...args: unknown[]) => {
      const target = String(args[0]);
      touched.push(target);
      if (!target.startsWith(dir)) throw Object.assign(new Error(`test spy refused ${target}`), { code: "EACCES" });
      return original.apply(fs.promises, args);
    });
  }
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  return touched;
}

test("a network or device path is refused without touching the file system", async (t) => {
  const { dir } = sandbox(t);
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  const allowed = await allowedFolders([root], {});
  const touched = spyOnFiles(t, dir);
  const attempts = windows
    ? [
        String.raw`\\192.0.2.1\share\clip.mp4`,
        "//192.0.2.1/share/clip.mp4",
        String.raw`\\?\UNC\192.0.2.1\share\clip.mp4`,
        "\\\\?\\" + path.join(root, "clip.mp4"),
        "\\\\.\\" + path.join(root, "clip.mp4"),
        "//?/" + path.join(root, "clip.mp4"),
        "file://192.0.2.1/share/clip.mp4",
        "file://attacker.example/share/clip.mp4",
      ]
    : ["//192.0.2.1/share/clip.mp4", "/net/192.0.2.1/clip.mp4", "file://192.0.2.1/share/clip.mp4", "file://attacker.example/share/clip.mp4"];
  for (const attempt of attempts) {
    const result = await readableRecording(attempt, allowed);
    assert.equal(!result.ok && result.problems[0]!.code, "folder", `${attempt}: ${JSON.stringify(result)}`);
  }
  // Only the allowed folder itself is looked at (to confirm it is still there); never the agent's path.
  assert.deepEqual([...new Set(touched)], [root], JSON.stringify(touched));
});

test("createOutput makes the name safe and refuses an odd extension", async (t) => {
  const { dir } = sandbox(t);
  const made = await createOutput(dir, "../../escape", "mp4");
  await made.handle.close();
  assert.equal(made.path, path.join(dir, "escape.mp4"));
  await assert.rejects(createOutput(dir, "x", "mp4/../../y"));
  await assert.rejects(createOutput(dir, "x", ""));
});

test("dataFolder per platform, with MOTIONMOCKUPS_DATA winning", () => {
  const folder = (...args: Parameters<typeof dataFolder>) => {
    const r = dataFolder(...args);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  assert.equal(
    folder({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", USERPROFILE: "C:\\Users\\a" }, "win32"),
    "C:\\Users\\a\\AppData\\Local\\motionmockups",
  );
  assert.equal(folder({ USERPROFILE: "C:\\Users\\a" }, "win32"), "C:\\Users\\a\\AppData\\Local\\motionmockups");
  assert.equal(folder({ HOME: "/Users/a" }, "darwin"), "/Users/a/Library/Application Support/motionmockups");
  assert.equal(folder({ HOME: "/home/a", XDG_DATA_HOME: "/data/xdg" }, "linux"), "/data/xdg/motionmockups");
  assert.equal(folder({ HOME: "/home/a" }, "linux"), "/home/a/.local/share/motionmockups");
  // A relative XDG_DATA_HOME is invalid by the spec and ignored.
  assert.equal(folder({ HOME: "/home/a", XDG_DATA_HOME: "xdg" }, "linux"), "/home/a/.local/share/motionmockups");
  assert.equal(folder({ HOME: "/home/a", MOTIONMOCKUPS_DATA: "/tmp/mm" }, "linux"), "/tmp/mm");
  assert.equal(folder({ LOCALAPPDATA: "C:\\L", MOTIONMOCKUPS_DATA: "D:\\mm" }, "win32"), "D:\\mm");
  assert.equal(typeof folder(), "string");
});

test("a relative MOTIONMOCKUPS_DATA is refused, never resolved against wherever the client started the adapter", () => {
  for (const [value, platform] of [
    ["mm-data", "linux"],
    ["./mm", "darwin"],
    ["mm-data", "win32"],
    ["\\mm", "win32"], // relative to the current drive
    ["C:mm", "win32"], // relative to drive C's current folder
  ] as const) {
    const r = dataFolder({ HOME: "/home/a", LOCALAPPDATA: "C:\\L", MOTIONMOCKUPS_DATA: value }, platform);
    assert.equal(r.ok, false, `${platform} ${value}`);
    if (r.ok) continue;
    assert.equal(r.problems[0]!.code, "data");
    assert.match(r.problems[0]!.message, /MOTIONMOCKUPS_DATA/);
    assert.match(r.problems[0]!.fix, /absolute/);
  }
});

test("safeName is linear: a 1,000,000-character run of dots, spaces or dashes takes well under 100 ms", () => {
  for (const run of [".", " ", "-", ". -"]) {
    const name = `a${run.repeat(Math.ceil(1_000_000 / run.length))}a`;
    const started = performance.now();
    const safe = safeName(name, "fallback");
    const took = performance.now() - started;
    assert.ok(took < 100, `${JSON.stringify(run)}: ${took.toFixed(1)} ms`);
    assert.equal(safe, "a", JSON.stringify(run));
  }
  // A long name is cut before it is cleaned, and never ends on half a character.
  const emoji = safeName(`${"😀".repeat(500_000)}.`, "fallback");
  assert.ok(emoji.length > 0 && Buffer.byteLength(emoji) <= 200 && !emoji.includes("\ufffd"));
  assert.equal(safeName(`${"a".repeat(1_000_000)}`, "fallback"), "a".repeat(120));
});

// ---- containment by identity, not by name ----

test("the identity walk: inside only when an ancestor of the real path is an allowed folder by dev:ino", async () => {
  const ids: Record<string, [bigint, bigint]> = {
    [path.resolve("/work/Proj")]: [1n, 10n],
    [path.resolve("/work/proj")]: [1n, 11n], // a case-only sibling, its own directory
    [path.resolve("/work/proj/clip.mp4")]: [1n, 12n],
    [path.resolve("/work/Proj/takes")]: [1n, 13n],
    [path.resolve("/work/Proj/takes/clip.mp4")]: [1n, 14n],
    [path.resolve("/work/LONGNA~1")]: [1n, 10n], // a short name of Proj: the same directory
    [path.resolve("/work/LONGNA~1/clip.mp4")]: [1n, 15n],
    [path.resolve("/work")]: [1n, 2n],
    [path.resolve("/")]: [1n, 1n],
    [path.resolve("/fat/Allowed")]: [2n, 0n], // no file ids here: only the exact real path counts
    [path.resolve("/fat/Allowed/clip.mp4")]: [2n, 0n],
    [path.resolve("/fat/allowed/clip.mp4")]: [2n, 0n],
    [path.resolve("/fat")]: [2n, 0n],
  };
  const statted: string[] = [];
  const statId = async (p: string) => {
    statted.push(p);
    const id = ids[path.resolve(p)];
    if (!id) throw Object.assign(new Error(`no ${p}`), { code: "ENOENT" });
    return { dev: id[0], ino: id[1] };
  };
  const inside = (p: string, allowed: string[]) => insideAllowed(path.resolve(p), allowed.map((a) => path.resolve(a)), statId);
  assert.equal(await inside("/work/Proj/takes/clip.mp4", ["/work/Proj"]), true);
  assert.equal(await inside("/work/proj/clip.mp4", ["/work/Proj"]), false);
  assert.equal(await inside("/work/LONGNA~1/clip.mp4", ["/work/Proj"]), true);
  assert.equal(await inside("/work/proj/clip.mp4", ["/work/Proj", "/nowhere"]), false, "a missing allowed folder grants nothing");
  assert.equal(await inside("/fat/Allowed/clip.mp4", ["/fat/Allowed"]), true);
  assert.equal(await inside("/fat/allowed/clip.mp4", ["/fat/Allowed"]), false);
  assert.equal(await inside("/work/Proj/takes/clip.mp4", []), false);
  // Each allowed folder is looked at once per call.
  statted.length = 0;
  await inside("/work/proj/clip.mp4", ["/work/Proj"]);
  assert.equal(statted.filter((p) => path.resolve(p) === path.resolve("/work/Proj")).length, 1, JSON.stringify(statted));
});

/** Runs `fsutil` and says whether it worked. */
function fsutil(...args: string[]): boolean {
  try {
    execFileSync("fsutil", args, { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

test("a case-only sibling folder on a case-sensitive volume is outside", { skip: !windows && "per-directory case sensitivity is Windows' (Linux compares exactly already)" }, async (t) => {
  const { dir } = sandbox(t);
  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  if (!fsutil("file", "setCaseSensitiveInfo", work, "enable")) {
    t.skip("fsutil file setCaseSensitiveInfo is not permitted here");
    return;
  }
  const allowedDir = path.join(work, "Proj");
  fs.mkdirSync(allowedDir);
  const clip = write(path.join(work, "proj", "clip.mp4"), MP4_HEADER);
  assert.equal(fs.readdirSync(work).length, 2, "Proj and proj are two folders");
  const allowed = await allowedFolders([allowedDir], {});
  const result = await readableRecording(clip, allowed);
  assert.equal(!result.ok && result.problems[0]!.code, "folder", JSON.stringify(result));
  // Inside the allowed one is still read.
  const own = write(path.join(allowedDir, "clip.mp4"), MP4_HEADER);
  const ok = await readableRecording(own, allowed);
  assert.equal(ok.ok && ok.value.path, own, JSON.stringify(ok));
});

test("a Kelvin-sign sibling (\u212Ait beside kit) is outside", async (t) => {
  const { dir } = sandbox(t);
  const allowedDir = path.join(dir, "kit");
  fs.mkdirSync(allowedDir);
  const twin = path.join(dir, "Kit");
  try {
    fs.mkdirSync(twin);
  } catch {
    t.skip("this volume treats \u212Ait and kit as one name");
    return;
  }
  if (fs.readdirSync(dir).length !== 2) {
    t.skip("this volume treats \u212Ait and kit as one name");
    return;
  }
  const clip = write(path.join(twin, "clip.mp4"), MP4_HEADER);
  const result = await readableRecording(clip, await allowedFolders([allowedDir], {}));
  assert.equal(!result.ok && result.problems[0]!.code, "folder", JSON.stringify(result));
});

/** The 8.3 short name of `p`, or null when there is none (8.3 names disabled, or not Windows). */
function shortName(p: string): string | null {
  if (!windows) return null;
  try {
    const run = spawnSync("cmd", ["/d", "/s", "/c", `"for %I in ("${p}") do @echo %~sI"`], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
    const out = run.status === 0 ? run.stdout.trim() : "";
    return out && out.toLowerCase() !== p.toLowerCase() && fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

test("a folder reached by its 8.3 short name is a real folder, not a link", { skip: !windows && "8.3 short names are Windows'" }, async (t) => {
  const { dir } = sandbox(t);
  const long = path.join(dir, "a project with a long name");
  fs.mkdirSync(long);
  const short = shortName(long);
  if (!short) {
    t.skip("8.3 short names are disabled on this volume");
    return;
  }
  t.diagnostic(`${long} -> ${short}`);
  // Writing: the partial, the published file and the output folder all work through the short name.
  const partial = await createPartial(short, "film", "mp4");
  await partial.handle.writeFile("film");
  await partial.handle.close();
  const published = await publishOutput(partial.path, "film", "mp4");
  assert.equal(fs.readFileSync(published, "utf8"), "film");
  const made = await createOutput(short, "other", "mp4");
  await made.handle.close();
  const out = await outputFolder([short]);
  assert.equal(out.ok, true, JSON.stringify(out));
  // Reading: a root declared by its short name accepts a recording written that way.
  const clip = write(path.join(long, "clip.mp4"), MP4_HEADER);
  const allowed = await allowedFolders([short], {});
  const read = await readableRecording(path.join(short, "clip.mp4"), allowed);
  assert.equal(read.ok && read.value.path, clip, JSON.stringify(read));
});

test("outputFolder: a motion-mockups whose real path comes back under its 8.3 short name is no link", { skip: !windows && "8.3 short names are Windows'" }, async (t) => {
  // outputFolder realpaths the allowed folder first, so a short name never reaches its link check
  // on its own; here realpath answers for motion-mockups with the folder's other, short spelling,
  // as a volume may. Only an identity check tells that this is the same folder, not a link.
  const { dir } = sandbox(t);
  const root = path.join(dir, "a project with a long name");
  const out = path.join(root, "motion-mockups");
  fs.mkdirSync(out, { recursive: true });
  const short = shortName(out);
  if (!short) {
    t.skip("8.3 short names are disabled on this volume");
    return;
  }
  const allowed = await allowedFolders([root], {});
  const original = fs.promises.realpath;
  mock.method(fs.promises, "realpath", async (p: fs.PathLike, ...rest: unknown[]) =>
    path.resolve(String(p)) === out ? short : (original as (...a: unknown[]) => Promise<string>).call(fs.promises, p, ...rest),
  );
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const result = await outputFolder(allowed);
  assert.deepEqual(result, { ok: true, value: short }, JSON.stringify(result));
});
