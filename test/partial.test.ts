import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { createPartial, publishOutput, removeStalePartials } from "../src/folders.ts";
import { deliverFile } from "../src/session.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/copy-then-hang.ts", import.meta.url));
const PARTIAL = /^\.film\.mp4\.partial-[0-9a-f]{16}$/;
const DAY = 24 * 60 * 60 * 1000;

function folder(t: { after: (fn: () => void) => void }): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mm-partial-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  return dir;
}

const age = (file: string, ms: number) => {
  const then = new Date(Date.now() - ms);
  fs.utimesSync(file, then, then);
};

test("a partial is hidden and named for its result; publishing gives the name, then (2), and never overwrites", async (t) => {
  const dir = folder(t);
  fs.writeFileSync(path.join(dir, "film.mp4"), "someone else's");
  const partial = await createPartial(dir, "film", "mp4");
  assert.match(path.basename(partial.path), PARTIAL);
  await partial.handle.writeFile("mine");
  await partial.handle.close();
  const published = await publishOutput(partial.path, "film", "mp4");
  assert.equal(published, path.join(dir, "film (2).mp4"));
  assert.equal(fs.readFileSync(published, "utf8"), "mine");
  assert.equal(fs.readFileSync(path.join(dir, "film.mp4"), "utf8"), "someone else's");
  assert.equal(fs.existsSync(partial.path), false, "the partial is gone");
  await assert.rejects(publishOutput(path.join(dir, "film.mp4"), "x", "mp4"), /not a partial/);
});

test("deliverFile removes its partial when the copy fails, and publishes only a whole file", async (t) => {
  const dir = folder(t);
  const failing = new Readable({
    read() {
      this.push(Buffer.alloc(1024));
      this.destroy(new Error("disk went away"));
    },
  });
  await assert.rejects(deliverFile(failing, dir, "film", "mp4"), /disk went away/);
  assert.deepEqual(fs.readdirSync(dir), []);

  const source = path.join(dir, "staged");
  fs.writeFileSync(source, Buffer.alloc(100_000, 3));
  const out = await deliverFile(source, dir, "film", "mp4");
  assert.equal(out, path.join(dir, "film.mp4"));
  assert.equal(fs.statSync(out).size, 100_000);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["film.mp4", "staged"]);
});

test("a kill mid-copy leaves only a partial, never a finished-looking file; a later start removes it once a day old", async (t) => {
  const dir = folder(t);
  const child = spawn(process.execPath, ["--experimental-strip-types", FIXTURE, dir], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (chunk: Buffer) => chunk.toString().includes("copying") && resolve());
    child.once("exit", (code) => reject(new Error(`the copier exited early (${code})`)));
  });
  child.kill("SIGKILL"); // TerminateProcess on Windows: no exit handlers run.
  await new Promise((resolve) => child.once("exit", resolve));
  const left = fs.readdirSync(dir);
  assert.equal(left.length, 1, JSON.stringify(left));
  assert.match(left[0]!, PARTIAL);
  assert.ok(fs.statSync(path.join(dir, left[0]!)).size > 0, "the copy had begun");

  // Fresh: kept (a render on another computer may still be writing it).
  assert.deepEqual(await removeStalePartials(dir), []);
  age(path.join(dir, left[0]!), 2 * DAY);
  assert.deepEqual(await removeStalePartials(dir), [path.join(dir, left[0]!)]);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("only the adapter's own partial names are ever removed", async (t) => {
  const dir = folder(t);
  const keep = [
    "film.mp4",
    "notes.txt",
    ".film.mp4.partial-xyz",
    ".film.mp4.partial-0123456789abcdef0",
    "film.mp4.partial-0123456789abcdef",
    ".film.mp4.partial-0123456789abcde",
  ];
  for (const name of keep) {
    fs.writeFileSync(path.join(dir, name), "x");
    age(path.join(dir, name), 3 * DAY);
  }
  // A folder with a partial's name is not a file.
  fs.mkdirSync(path.join(dir, ".dir.mp4.partial-0123456789abcdef"));
  const stale = path.join(dir, ".film (2).png.partial-0123456789abcdef");
  fs.writeFileSync(stale, "x");
  age(stale, 3 * DAY);
  assert.deepEqual(await removeStalePartials(dir), [stale]);
  assert.deepEqual(fs.readdirSync(dir).sort(), [...keep, ".dir.mp4.partial-0123456789abcdef"].sort());
  assert.deepEqual(await removeStalePartials(path.join(dir, "missing")), []);
});
