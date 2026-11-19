import os from "node:os";
import path from "node:path";

/**
 * The adapter's own folder (Chrome profile, render lock). `MOTIONMOCKUPS_DATA` wins;
 * otherwise the platform's usual place for per-user application data.
 */
export function dataFolder(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  const override = env.MOTIONMOCKUPS_DATA?.trim();
  if (override) return p.isAbsolute(override) ? p.normalize(override) : path.resolve(override);

  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    if (local && p.isAbsolute(local)) return p.join(local, "motionmockups");
    return p.join(env.USERPROFILE?.trim() || os.homedir(), "AppData", "Local", "motionmockups");
  }
  const home = env.HOME?.trim() || os.homedir();
  if (platform === "darwin") return p.join(home, "Library", "Application Support", "motionmockups");
  // XDG: a relative XDG_DATA_HOME is invalid and must be ignored.
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg && p.isAbsolute(xdg)) return p.join(xdg, "motionmockups");
  return p.join(home, ".local", "share", "motionmockups");
}
