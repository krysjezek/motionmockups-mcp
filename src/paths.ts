import os from "node:os";
import path from "node:path";

import type { Checked } from "./folders.ts";

/**
 * The adapter's own folder (Chrome profile, render lock). `MOTIONMOCKUPS_DATA` wins;
 * otherwise the platform's usual place for per-user application data. A relative
 * `MOTIONMOCKUPS_DATA` is refused: it would land wherever the MCP client happened to start
 * the adapter.
 */
export function dataFolder(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Checked<string> {
  const p = platform === "win32" ? path.win32 : path.posix;
  const override = env.MOTIONMOCKUPS_DATA?.trim();
  if (override) {
    // On Windows "\folder" and "C:folder" are relative to a drive's current folder: not absolute.
    const absolute = platform === "win32" ? /^([a-z]:[\\/]|\\\\)/i.test(override) : p.isAbsolute(override);
    if (!absolute)
      return {
        ok: false,
        problems: [
          {
            code: "data",
            message: `MOTIONMOCKUPS_DATA is "${override}", which is not an absolute folder.`,
            fix: "Set MOTIONMOCKUPS_DATA in this MCP server's settings to an absolute folder, or remove it to use the usual place.",
          },
        ],
      };
    return { ok: true, value: p.normalize(override) };
  }

  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    if (local && p.isAbsolute(local)) return { ok: true, value: p.join(local, "motionmockups") };
    return { ok: true, value: p.join(env.USERPROFILE?.trim() || os.homedir(), "AppData", "Local", "motionmockups") };
  }
  const home = env.HOME?.trim() || os.homedir();
  if (platform === "darwin") return { ok: true, value: p.join(home, "Library", "Application Support", "motionmockups") };
  // XDG: a relative XDG_DATA_HOME is invalid and must be ignored.
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg && p.isAbsolute(xdg)) return { ok: true, value: p.join(xdg, "motionmockups") };
  return { ok: true, value: p.join(home, ".local", "share", "motionmockups") };
}
