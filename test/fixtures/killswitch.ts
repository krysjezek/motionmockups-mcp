// The kill switch's fixture: a small catalog, the adapters block that blocks a version, and the
// tools a blocked adapter refuses with the arguments they would otherwise take. Used by
// test/killswitch.test.ts (in process) and test/release.test.ts (the built adapter over stdio).

import assert from "node:assert/strict";

import { UPGRADE_FIX } from "../../src/killswitch.ts";

export const CATALOG = {
  contract: 1,
  briefing: "The test briefing.",
  devices: [{ device: "iPhone", fps: 60, screen: { width: 1179, height: 2556 }, tips: ["Record portrait."] }],
  scenes: [{ id: "blanc-iphone-shot-1", device: "iPhone", collection: "Gallery", title: "Orbit", seconds: 8, poster: "https://assets.example/p1.webp" }],
  rules: {
    aspects: ["9:16"],
    sizes: [1080],
    minClipSeconds: 1,
    maxImageSeconds: 60,
    videoTypes: ["video/mp4"],
    imageTypes: ["image/png"],
    delivery: ["film", "scenes"],
  },
};

export const PLAN = { contract: 1, device: "iPhone", aspect: "9:16", clips: [{ scene: "blanc-iphone-shot-1" }] };

/** The catalog with this adapters block. */
export const withAdapters = (adapters: unknown) => ({ ...CATALOG, adapters });

/** Blocks `version` (0.1.0 unless given), with the site's message. */
export const blocking = (version = "0.1.0") => ({ allowed: ">=0.1.0", blocked: [version], message: `${version} loses renders; update the adapter.` });

/** Every tool a blocked adapter refuses, with arguments it would otherwise take. */
export const REFUSED: [string, Record<string, unknown>][] = [
  ["list_scenes", {}],
  ["recording_spec", { device: "iPhone" }],
  ["suggest_sequence", { goal: "launch", device: "iPhone" }],
  ["check_plan", { plan: PLAN }],
  ["render", { plan: PLAN }],
  ["still", { plan: PLAN, seconds: 1, format: "png" }],
  ["connect_account", {}],
  ["connect_account", { wait: true }],
];

/** `result` is the `blocked` refusal with the site's `message` and the upgrade fix. */
export const assertBlocked = (result: any, what: string, message: string) => {
  assert.equal(result.isError, true, `${what} is refused`);
  assert.deepEqual(result.structuredContent?.problems, [{ code: "blocked", message, fix: UPGRADE_FIX }], what);
};
