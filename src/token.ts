// The agent token: what connect_account receives once the person approves, kept in one file,
// `<data>/agent-token`, readable by the person alone (mode 0o600 on macOS and Linux, inside the
// 0o700 data folder; on Windows the per-user data folder is the person's own).
//
// The file holds the token and the origin it was issued by, as JSON. A token is only ever sent
// to the origin it came from: one saved for another origin (MOTIONMOCKUPS_ORIGIN changed) is
// refused, never sent. The token itself never appears in a tool result, a progress report, a
// problem or stderr; it travels only in the Authorization header to its own origin and over
// Chrome's control pipe into the /agent page. A keychain is a later improvement.

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

import { problemError } from "./chrome/cdp.ts";
import type { Checked, Problem } from "./folders.ts";

export const TOKEN_FILE = "agent-token";
const TOKEN_PATTERN = /^mma_[A-Za-z0-9_-]{43}$/;
const TOKEN_ANYWHERE = /mma_[A-Za-z0-9_-]{43}/g;
/** Far above the real file (about 120 bytes); a larger one is not the adapter's. */
const MAX_BYTES = 1024;
const posix = process.platform !== "win32";

export const isAgentToken = (value: unknown): value is string => typeof value === "string" && TOKEN_PATTERN.test(value);

/** `text` with every agent token in it replaced: the last guard before anything leaves the adapter. */
export const redact = (text: string): string => text.replace(TOKEN_ANYWHERE, "[agent token]");

const tokenPath = (data: string) => path.join(data, TOKEN_FILE);

const damaged = (file: string, why: string): Problem => ({
  code: "sign-in",
  message: `The saved connection at ${file} ${why}, so it is not used. Renders are free watermarked previews until the account is connected again.`,
  fix: "Call connect_account to connect the account again (it replaces the file), or connect_account with disconnect: true to delete it.",
});

/**
 * The saved token for `origin`: null when there is none, a `sign-in` problem when the file is
 * damaged, is not a plain file, or was saved for another origin.
 */
export async function readToken(data: string, origin: URL): Promise<Checked<string | null>> {
  const file = tokenPath(data);
  const bad = (why: string): Checked<string | null> => ({ ok: false, problems: [damaged(file, why)] });
  let text: string;
  try {
    const st = await lstat(file);
    if (!st.isFile()) return bad("is not a plain file");
    if (st.size > MAX_BYTES) return bad("is not one the adapter wrote");
    // Not through a link swapped in since the check, where the platform can say so.
    const handle = await open(file, constants.O_RDONLY | (posix ? constants.O_NOFOLLOW : 0));
    try {
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: true, value: null };
    if (code === "ELOOP") return bad("is a link");
    return bad(`cannot be read (${code ?? "unknown error"})`);
  }
  if (text.length > MAX_BYTES) return bad("is not one the adapter wrote");
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch {
    return bad("is damaged");
  }
  const value = saved as Record<string, unknown> | null;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "origin,token" ||
    !isAgentToken(value.token) ||
    typeof value.origin !== "string"
  )
    return bad("is damaged");
  let savedOrigin: string;
  try {
    savedOrigin = new URL(value.origin).origin;
  } catch {
    return bad("is damaged");
  }
  if (savedOrigin !== value.origin) return bad("is damaged");
  if (savedOrigin !== origin.origin)
    return {
      ok: false,
      problems: [
        {
          code: "sign-in",
          message: `The saved connection at ${file} is for ${savedOrigin}, not ${origin.origin}, the site this adapter uses now; it is never sent to another site. Renders are free watermarked previews until this site is connected.`,
          fix: `Call connect_account to connect the account on ${origin.origin} (it replaces the saved connection), or set MOTIONMOCKUPS_ORIGIN back to use the saved one.`,
        },
      ],
    };
  return { ok: true, value: value.token };
}

const refusedPath = (file: string, why: string) =>
  problemError(
    "sign-in",
    `The connection could not be saved: ${file} ${why}.`,
    `Remove ${file}, then call connect_account again.`,
  );

/**
 * Saves `token` for `origin` as `<data>/agent-token`: written whole to a new file of its own
 * (exclusive create, mode 0o600) and renamed into place, so a reader sees the old file or the new
 * one, never part of one. A link or anything but a plain file at the path is refused. Throws a
 * ProblemError (code `sign-in`) that never quotes the token.
 */
export async function writeToken(data: string, origin: URL, token: string): Promise<void> {
  if (!isAgentToken(token)) throw problemError("sign-in", "The site sent a token the adapter does not recognise.", "Call connect_account again.");
  await mkdir(data, { recursive: true, mode: 0o700 });
  if (posix) await chmod(data, 0o700);
  const file = tokenPath(data);
  const check = async () => {
    try {
      const st = await lstat(file);
      if (st.isSymbolicLink()) throw refusedPath(file, "is a link");
      if (!st.isFile()) throw refusedPath(file, "is not a plain file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  };
  await check();
  const temp = path.join(data, `${TOKEN_FILE}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (posix ? constants.O_NOFOLLOW : 0), 0o600);
  try {
    try {
      if (posix) await handle.chmod(0o600); // whatever the umask
      await handle.writeFile(`${JSON.stringify({ origin: origin.origin, token })}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Checked again just before the rename, which replaces a plain file and never follows a link.
    await check();
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    if ((error as { fix?: unknown })?.fix) throw error;
    throw refusedPath(file, `could not be written (${(error as NodeJS.ErrnoException)?.code ?? "unknown error"})`);
  }
}

/**
 * Deletes the saved token (a link is removed, never followed). True when there was one. With
 * `expected`, only when the saved token is that one: a token the site refused is deleted, never
 * one a new connection saved since.
 */
export async function clearToken(data: string, expected?: string): Promise<boolean> {
  const file = tokenPath(data);
  try {
    const st = await lstat(file);
    if (expected !== undefined) {
      if (!st.isFile() || st.size > MAX_BYTES) return false;
      const handle = await open(file, constants.O_RDONLY | (posix ? constants.O_NOFOLLOW : 0));
      let saved: unknown;
      try {
        saved = JSON.parse(await handle.readFile("utf8"));
      } catch {
        return false;
      } finally {
        await handle.close();
      }
      if ((saved as { token?: unknown } | null)?.token !== expected) return false;
    }
  } catch {
    return false;
  }
  await rm(file, { force: true, recursive: false });
  return true;
}
