// A separate process that takes the render lock, holds it and reports each step as one JSON line.
// Usage: node --experimental-strip-types hold-lock.ts <folder> <holdMs> <pollMs> [release | exit | exit-gone]
import { rmSync } from "node:fs";

import { acquireRenderLock } from "../../src/lock.ts";

const [folder = "", holdMs = "0", pollMs = "50", mode = "release"] = process.argv.slice(2);
const say = (event: string, extra: object = {}) => process.stdout.write(`${JSON.stringify({ event, at: Date.now(), ...extra })}\n`);

let waited = false;
const held = await acquireRenderLock(folder, {
  pollMs: Number(pollMs),
  onWait: (holder) => {
    if (waited) return;
    waited = true;
    say("wait", holder);
  },
});
say("acquired");
await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
if (mode === "exit") process.exit(0); // the exit handler releases
if (mode === "exit-gone") {
  rmSync(folder, { recursive: true, force: true }); // nothing left for the exit handler to read
  process.exit(0);
}
say("releasing");
await held.release();
say("released");
