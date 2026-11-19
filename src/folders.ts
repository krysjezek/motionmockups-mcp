// The file rules: which folders the adapter may read recordings from and write
// results into. A tricked agent may ask for any path; nothing outside the
// allowed folders is read, and nothing is written outside `motion-mockups/`.

import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Every refusal the adapter gives. `fix` says what the person or the agent can do about it. */
export interface Problem {
  code: string;
  message: string;
  fix: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; problems: Problem[] };

const OUTPUT = "motion-mockups";
const caseless = process.platform === "win32" || process.platform === "darwin";

const refuse = <T>(code: string, message: string, fix: string): Checked<T> => ({
  ok: false,
  problems: [{ code, message, fix }],
});

function noFolder<T>(): Checked<T> {
  return refuse(
    "no-folder",
    "There is no allowed folder: the MCP client declared no roots and MOTIONMOCKUPS_FOLDERS is not set.",
    `Start the agent in the project folder, or ask the person to set MOTIONMOCKUPS_FOLDERS in this MCP server's settings ` +
      `(absolute folders, separated by "${path.delimiter}").`,
  );
}

/** A comparison key: Windows and macOS compare paths without regard to case. */
const key = (p: string) => (caseless ? path.resolve(p).toLowerCase() : path.resolve(p));

/** True when `child` is `parent` or inside it. Both should be real paths. */
function within(child: string, parent: string): boolean {
  const rel = path.relative(key(parent), key(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

const withinAny = (child: string, folders: string[]) => folders.some((f) => within(child, f));

/** A root or setting entry as an absolute path, or null. Accepts `file://` URLs (MCP roots are URIs). */
function asAbsolute(entry: string): string | null {
  const s = entry.trim();
  if (!s) return null;
  let p = s;
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(s)) {
    if (!/^file:/i.test(s)) return null;
    try {
      p = fileURLToPath(s);
    } catch {
      return null;
    }
  }
  // On Windows, "\folder" is relative to the current drive: not a real absolute path.
  const absolute = process.platform === "win32" ? /^([a-z]:[\\/]|\\\\)/i.test(p) : path.isAbsolute(p);
  return absolute ? path.resolve(p) : null;
}

// Windows device and long-path forms (\\?\…, \\.\…, //?/…): never read.
const DEVICE_PATH = /^[\\/]{2}[?.][\\/]/;

/**
 * How each allowed folder was declared, by its real path's key. A recording path is judged
 * as written against these before the file system is touched, so a root declared through a
 * link or a mapped drive still accepts paths written the way it was declared.
 */
const spellings = new Map<string, string[]>();

async function realDirectory(p: string): Promise<string | null> {
  try {
    const real = await realpath(p);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * The folders the adapter may use: the MCP roots first, then `MOTIONMOCKUPS_FOLDERS`.
 * Real paths of existing folders only, each once. Relative entries and whole drives
 * (`C:\`, `/`) are never allowed.
 */
export async function allowedFolders(roots: string[], env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const entries = [...roots, ...(env.MOTIONMOCKUPS_FOLDERS ?? "").split(path.delimiter)];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const p = asAbsolute(entry);
    if (!p) continue;
    const real = await realDirectory(p);
    if (!real || path.parse(real).root === real) continue;
    const k = key(real);
    const known = spellings.get(k) ?? [];
    if (!known.some((s) => key(s) === key(p))) spellings.set(k, [...known, p]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(real);
  }
  return out;
}

function outsideFix(allowed: string[]): string {
  return (
    `Use a recording inside an allowed folder (${allowed.join(", ")}), copying it there if needed, ` +
    `or ask the person to add its folder to MOTIONMOCKUPS_FOLDERS.`
  );
}

const ACCEPTED = "MP4, MOV, WebM, PNG, JPEG, WebP or AVIF";

type Format = "mp4" | "webm" | "png" | "jpeg" | "webp" | "avif";
const KIND: Record<Format, "video" | "image"> = {
  mp4: "video",
  webm: "video",
  png: "image",
  jpeg: "image",
  webp: "image",
  avif: "image",
};
const EXTENSIONS: Record<string, Format> = {
  ".mp4": "mp4",
  ".m4v": "mp4",
  ".mov": "mp4",
  ".webm": "webm",
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".webp": "webp",
  ".avif": "avif",
};
const EXTENSION_FOR: Record<Format, string> = {
  mp4: ".mp4",
  webm: ".webm",
  png: ".png",
  jpeg: ".jpg",
  webp: ".webp",
  avif: ".avif",
};
// ISO base media brands that are still images, not video: HEIF/HEIC and Canon raw.
const STILL_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "mif2", "miaf", "crx "]);

/** What the first bytes of a file say it is, or null when it is none of the accepted types. */
function sniff(head: Buffer): Format | null {
  const ascii = (from: number, to: number) => head.subarray(from, to).toString("latin1");
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return "webm";
  if (head.length >= 12 && ascii(4, 8) === "ftyp") {
    const major = ascii(8, 12);
    const size = Math.min(head.readUInt32BE(0), head.length);
    const compatible: string[] = [];
    for (let at = 16; at + 4 <= size; at += 4) compatible.push(ascii(at, at + 4));
    if (major === "avif" || major === "avis") return "avif";
    if (STILL_BRANDS.has(major)) return compatible.includes("avif") ? "avif" : null;
    return "mp4";
  }
  return null;
}

/**
 * Checks that `file` is a recording the adapter may read: inside an allowed folder once
 * every link is resolved, a regular file, and an accepted type by its first bytes.
 * A relative path is taken inside the first allowed folder.
 */
export async function readableRecording(
  file: string,
  allowed: string[],
): Promise<Checked<{ path: string; kind: "video" | "image"; bytes: number }>> {
  if (allowed.length === 0) return noFolder();
  const realAllowed = (await Promise.all(allowed.map(realDirectory))).filter((f): f is string => f !== null);
  if (realAllowed.length === 0) return noFolder();

  // Nothing below touches the file system for the agent's path until it is known, as written,
  // to lie inside an allowed folder: a network path (\\host\share, file://host/, /net/host)
  // would otherwise make the system contact that host.
  let given = file.trim();
  if (/^file:/i.test(given)) {
    let url: URL;
    try {
      url = new URL(given);
    } catch {
      return refuse("recording", `${given} is not a file path.`, "Give the recording's path on this computer.");
    }
    if (url.hostname && url.hostname.toLowerCase() !== "localhost") {
      return refuse("folder", `${given} names another computer; only allowed folders on this one are read.`, outsideFix(realAllowed));
    }
    try {
      given = fileURLToPath(url);
    } catch {
      return refuse("recording", `${given} is not a file path.`, "Give the recording's path on this computer.");
    }
  }
  if (process.platform === "win32" && DEVICE_PATH.test(given)) {
    return refuse("folder", `${given} is a device path; only allowed folders are read.`, outsideFix(realAllowed));
  }
  const absolute = path.resolve(realAllowed[0]!, given);
  // Spellings of the allowed folders as they were declared (a root reached through a link or a mapped drive).
  const declared = realAllowed.flatMap((f) => spellings.get(key(f)) ?? []);
  if (!withinAny(absolute, [...realAllowed, ...allowed, ...declared])) {
    return refuse("folder", `${absolute} is outside the allowed folders.`, outsideFix(realAllowed));
  }

  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return refuse("recording", `${absolute} was not found.`, "Check the path, and that the recording has finished saving.");
  }
  if (!withinAny(real, realAllowed)) {
    return refuse("folder", `${absolute} leads outside the allowed folders through a link.`, outsideFix(realAllowed));
  }

  const notRecording = (why: string) =>
    refuse<{ path: string; kind: "video" | "image"; bytes: number }>(
      "recording",
      `${absolute} ${why}`,
      `Give a screen recording or image: ${ACCEPTED}.`,
    );

  let before;
  try {
    before = await stat(real, { bigint: true });
  } catch {
    return notRecording("cannot be read.");
  }
  if (!before.isFile()) return notRecording("is not a file.");
  if (before.size === 0n) return notRecording("is empty.");

  let handle: FileHandle;
  try {
    // O_NOFOLLOW and O_NONBLOCK where the platform has them: no last-moment link, no waiting on a pipe.
    handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return notRecording("cannot be opened.");
  }
  try {
    const opened = await handle.stat({ bigint: true });
    // The file opened must be the one checked, not something swapped in since.
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) {
      return notRecording("changed while it was being checked.");
    }
    const head = Buffer.alloc(64);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const format = sniff(head.subarray(0, bytesRead));
    if (!format) return notRecording(`is not a recording Motion Mockups accepts (${ACCEPTED}).`);
    const named = EXTENSIONS[path.extname(real).toLowerCase()];
    if (named !== format) {
      return refuse(
        "recording",
        `${absolute} holds ${format.toUpperCase()} data but is not named as such.`,
        `Rename it to end in ${EXTENSION_FOR[format]}.`,
      );
    }
    return { ok: true, value: { path: real, kind: KIND[format], bytes: Number(opened.size) } };
  } catch {
    return notRecording("cannot be read.");
  } finally {
    await handle.close();
  }
}

/** `motion-mockups/` inside the first allowed folder, created if needed; refused when it is a link or not a folder. */
export async function outputFolder(allowed: string[]): Promise<Checked<string>> {
  if (allowed.length === 0) return noFolder();
  const first = await realDirectory(allowed[0]!);
  if (!first) {
    return refuse("output", `The allowed folder ${allowed[0]} is no longer there.`, "Restart the agent in an existing project folder.");
  }
  const target = path.join(first, OUTPUT);
  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      return refuse("output", `${target} could not be created.`, `Check that ${first} can be written to.`);
    }
  }
  const linked = refuse<string>(
    "folder",
    `${target} is a link to another place; results are written only into a real ${OUTPUT} folder.`,
    `Remove the link ${target}, so the adapter can create the folder itself.`,
  );
  try {
    // lstat reports symlinks and Windows junctions alike as links.
    const st = await lstat(target);
    if (st.isSymbolicLink()) return linked;
    if (!st.isDirectory()) {
      return refuse("output", `${target} is a file, not a folder.`, `Rename or move ${target} so a ${OUTPUT} folder can be made.`);
    }
    const real = await realpath(target);
    if (key(real) !== key(target)) return linked;
    return { ok: true, value: real };
  } catch {
    return refuse("output", `${target} could not be read.`, `Check that ${first} can be written to.`);
  }
}

// Names Windows reserves for devices, with or without an extension.
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
const MAX_CHARS = 120;
const MAX_BYTES = 200; // file systems allow 255 bytes; this leaves room for " (n)" and the extension

function clean(raw: string | undefined): string {
  if (!raw) return "";
  let s = raw
    .normalize("NFC")
    // Control, zero-width and direction-override characters.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
    // Path separators and characters Windows forbids.
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-{2,}/g, "-")
    .replace(/^[\s.-]+/, "")
    .replace(/[\s.-]+$/, "");
  const stem = s.split(".")[0]!;
  if (RESERVED.test(stem)) s = `${stem}_${s.slice(stem.length)}`;
  let chars = Array.from(s).slice(0, MAX_CHARS);
  while (chars.length > 0 && Buffer.byteLength(chars.join("")) > MAX_BYTES) chars = chars.slice(0, -1);
  return chars.join("").replace(/[\s.-]+$/, "");
}

/** A file name (without extension) that is safe on every platform and cannot leave its folder. */
export function safeName(name: string | undefined, fallback: string): string {
  return clean(name) || clean(fallback) || OUTPUT;
}

/**
 * Creates `<folder>/<name>.<ext>` with exclusive create, never replacing a file:
 * a taken name becomes `<name> (2).<ext>`, `<name> (3).<ext>` and so on.
 */
export async function createOutput(folder: string, name: string, ext: string): Promise<{ path: string; handle: FileHandle }> {
  const extension = ext.replace(/^\./, "");
  if (!/^[a-z0-9]{1,10}$/i.test(extension)) throw new Error(`Not a file extension: ${JSON.stringify(ext)}`);
  const real = await realpath(folder);
  if (key(real) !== key(folder)) throw new Error(`${folder} is a link; results are written only into real folders.`);
  const base = safeName(name, OUTPUT);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  for (let n = 1; n <= 9999; n++) {
    const file = path.join(real, `${n === 1 ? base : `${base} (${n})`}.${extension}`);
    // Any entry already there is taken, a link (even a dangling one) included: Windows has no
    // O_NOFOLLOW, and its exclusive create follows a dangling link to wherever it points.
    try {
      await lstat(file);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let handle: FileHandle;
    try {
      handle = await open(file, flags, 0o644);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    // A link planted between the check and the create: the file opened is not the entry at the name.
    try {
      const [opened, entry] = await Promise.all([handle.stat({ bigint: true }), lstat(file, { bigint: true })]);
      if (entry.isSymbolicLink() || !entry.isFile() || opened.ino !== entry.ino || opened.dev !== entry.dev) {
        throw new Error(`${file} changed while it was being created; nothing was written.`);
      }
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
    return { path: file, handle };
  }
  throw new Error(`${folder} already holds 9999 files named ${base}.`);
}
