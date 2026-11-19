// The site the adapter renders on. Chrome is let reach this origin, so it is never
// anything an agent or a stray setting could point elsewhere: the public site, a local
// preview of it, or one of its Vercel previews.

import type { Checked } from "./folders.ts";

export const DEFAULT_ORIGIN = "https://motionmockups.com";

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);
// A Vercel preview of the site's project in the owner's team, in the two shapes Vercel gives
// them: a deployment URL, motion-mockups-<9-character id>-krystofjezeks-projects.vercel.app (as
// the app's docs/deployment.md records every one), and a branch URL,
// motion-mockups-app-git-<branch>-krystofjezeks-projects.vercel.app. Hostnames under vercel.app
// are issued to every account by its own project and team names, so this still rests on
// Vercel's naming: on the team scope suffix staying the owner's, and on these shapes. If Vercel
// changes them, or the owner sets a Preview Deployment Suffix (a domain of the owner's own),
// this pattern is what to change.
const VERCEL_PREVIEW = /^motion-mockups-(?:[a-z0-9]{9}|app-git-[a-z0-9-]+)-krystofjezeks-projects\.vercel\.app$/;

function refuse(value: string, why: string): Checked<URL> {
  return {
    ok: false,
    problems: [
      {
        code: "origin",
        message: `MOTIONMOCKUPS_ORIGIN is "${value}", which ${why}`,
        fix:
          `Remove MOTIONMOCKUPS_ORIGIN from this MCP server's settings to render on ${DEFAULT_ORIGIN}, or set it to ` +
          "http://localhost:<port>, http://127.0.0.1:<port> or a Vercel preview, https://motion-mockups-<9-character id>-krystofjezeks-projects.vercel.app or https://motion-mockups-app-git-<branch>-krystofjezeks-projects.vercel.app.",
      },
    ],
  };
}

/** `MOTIONMOCKUPS_ORIGIN` when it is one of the site's own places, else the public site. */
export function siteOrigin(env: NodeJS.ProcessEnv = process.env): Checked<URL> {
  const value = env.MOTIONMOCKUPS_ORIGIN?.trim();
  if (!value) return { ok: true, value: new URL(DEFAULT_ORIGIN) };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse(value, "is not a URL.");
  }
  if (url.username || url.password) return refuse(value, "carries a user name or password.");
  if (url.pathname !== "/" || url.search || url.hash) return refuse(value, "is not an origin alone (it has a path, query or fragment).");
  const host = url.hostname.toLowerCase();
  if (url.protocol === "http:" && LOOPBACK.has(host)) {
    // A local preview is let through on its own port only, so it names one (URL drops :80).
    if (!url.port) return refuse(value, "names no port of its own; a local preview is reached on the port it runs on.");
    return { ok: true, value: new URL(url.origin) };
  }
  const allowed = url.protocol === "https:" && !url.port && (VERCEL_PREVIEW.test(host) || url.origin === DEFAULT_ORIGIN);
  if (!allowed) return refuse(value, "is not the Motion Mockups site, a local preview of it or one of its Vercel previews.");
  return { ok: true, value: new URL(url.origin) };
}
