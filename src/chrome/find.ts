// Finding the person's installed Google Chrome. Chromium counts on Linux only, where
// it is what distributions ship; elsewhere the adapter drives Google Chrome alone.

import fs from "node:fs";
import path from "node:path";

import type { Checked, Problem } from "../folders.ts";

const DOWNLOAD = "https://www.google.com/chrome/";
const LINUX_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
const MAC_APP = ["Google Chrome.app", "Contents", "MacOS", "Google Chrome"];
const WIN_APP = ["Google", "Chrome", "Application", "chrome.exe"];

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** An environment variable; on Windows names are compared without regard to case. */
function variable(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name]?.trim() || undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === lower && value?.trim()) return value.trim();
  return undefined;
}

function refuse(message: string): Checked<string> {
  const problem: Problem = {
    code: "chrome",
    message,
    fix:
      `Install Google Chrome from ${DOWNLOAD}, or ask the person to set MOTIONMOCKUPS_CHROME in this MCP server's settings ` +
      `to the full path of their Chrome executable.`,
  };
  return { ok: false, problems: [problem] };
}

/** The standard places, most preferred first. */
function candidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const p = path.win32;
    // The MCP SDK's stdio client passes PROGRAMFILES but not ProgramFiles(x86) by default,
    // so a missing variable falls back to its usual place on the system drive.
    const drive = variable(env, "SYSTEMDRIVE", platform) ?? "C:";
    const bases = [
      variable(env, "ProgramFiles", platform) ?? `${drive}\\Program Files`,
      variable(env, "ProgramFiles(x86)", platform) ?? `${drive}\\Program Files (x86)`,
      variable(env, "LOCALAPPDATA", platform),
    ];
    const paths = bases.filter((base): base is string => !!base && p.isAbsolute(base)).map((base) => p.join(base, ...WIN_APP));
    return [...new Set(paths)];
  }
  const p = path.posix;
  if (platform === "darwin") {
    const home = variable(env, "HOME", platform);
    return [p.join("/Applications", ...MAC_APP), ...(home && p.isAbsolute(home) ? [p.join(home, "Applications", ...MAC_APP)] : [])];
  }
  const dirs = (variable(env, "PATH", platform) ?? "").split(":").filter((d) => d && p.isAbsolute(d));
  return LINUX_NAMES.flatMap((name) => dirs.map((dir) => p.join(dir, name)));
}

/**
 * The Chrome executable to drive. `MOTIONMOCKUPS_CHROME` wins and is never passed over:
 * when it is set but wrong, the person meant a particular Chrome and is told so.
 */
export function findChrome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = isFile,
): Checked<string> {
  const chosen = variable(env, "MOTIONMOCKUPS_CHROME", platform);
  if (chosen) {
    const p = platform === "win32" ? path.win32 : path.posix;
    if (!p.isAbsolute(chosen)) return refuse(`MOTIONMOCKUPS_CHROME is "${chosen}", which is not an absolute path.`);
    if (!exists(chosen)) return refuse(`MOTIONMOCKUPS_CHROME is "${chosen}", but there is no file there.`);
    return { ok: true, value: chosen };
  }
  const found = candidates(env, platform).find((c) => exists(c));
  if (found) return { ok: true, value: found };
  return refuse(
    platform === "linux"
      ? "Google Chrome or Chromium was not found on PATH."
      : "Google Chrome was not found in the places it installs to.",
  );
}
