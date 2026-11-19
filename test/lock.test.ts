import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireRenderLock, BEAT_MS, isAlive, LOCK_NAME, STALE_MS, Watch, type Held } from "../src/lock.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/hold-lock.ts", import.meta.url));

function tempFolder(t: { after: (fn: () => void) => void }): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "mm-lock-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

const lockOf = (folder: string) => path.join(folder, LOCK_NAME);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The pid of a process that has already exited. */
function deadPid(): number {
  const done = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(done.pid);
  return done.pid!;
}

function writeLock(folder: string, content: string, ageMs = 0): void {
  const file = lockOf(folder);
  fs.writeFileSync(file, content);
  if (ageMs) {
    const then = new Date(Date.now() - ageMs);
    fs.utimesSync(file, then, then);
  }
}

const foreign = (pid: number) => JSON.stringify({ pid, since: "2026-11-19T10:00:00.000Z", token: "someone-else" });

interface Event {
  event: string;
  at: number;
  pid?: number;
  since?: string;
}

/** Starts the fixture holder; `next(name)` resolves with the first event of that name. */
function holder(folder: string, holdMs: number, mode = "release") {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", FIXTURE, folder, String(holdMs), "30", mode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events: Event[] = [];
  const waiting: { name: string; resolve: (e: Event) => void }[] = [];
  let stderr = "";
  let buffered = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (d) => {
    buffered += d;
    let nl: number;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const event = JSON.parse(buffered.slice(0, nl)) as Event;
      buffered = buffered.slice(nl + 1);
      events.push(event);
      for (const w of waiting.filter((w) => w.name === event.event)) w.resolve(event);
    }
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    events,
    exited,
    stderr: () => stderr,
    next: (name: string) =>
      new Promise<Event>((resolve) => {
        const seen = events.find((e) => e.event === name);
        if (seen) resolve(seen);
        else waiting.push({ name, resolve });
      }),
  };
}

const at = (events: Event[], name: string) => {
  const e = events.find((x) => x.event === name);
  assert.ok(e, `no ${name} event in ${JSON.stringify(events)}`);
  return e!.at;
};

// ---- the brief ----

test("a second holder waits", async (t) => {
  const folder = tempFolder(t);
  const first = holder(folder, 1500);
  await first.next("acquired");
  const second = holder(folder, 0);
  const [firstCode, secondCode] = await Promise.all([first.exited, second.exited]);
  assert.equal(firstCode, 0, first.stderr());
  assert.equal(secondCode, 0, second.stderr());

  const wait = second.events.find((e) => e.event === "wait");
  assert.ok(wait, "the second holder's onWait did not fire");
  assert.equal(typeof wait!.pid, "number");
  assert.match(wait!.since ?? "", /^\d{4}-\d\d-\d\dT/);
  // The second holds only after the first let go: the windows do not overlap.
  assert.ok(at(second.events, "acquired") >= at(first.events, "releasing"), JSON.stringify({ first: first.events, second: second.events }));
  assert.equal(fs.existsSync(lockOf(folder)), false);
});

test("a dead holder's lock is taken over", async (t) => {
  const folder = tempFolder(t);
  writeLock(folder, foreign(deadPid()));
  let waited = false;
  const held = await acquireRenderLock(folder, { pollMs: 20, onWait: () => (waited = true) });
  const now = JSON.parse(fs.readFileSync(lockOf(folder), "utf8"));
  assert.equal(now.pid, process.pid);
  assert.notEqual(now.token, "someone-else");
  assert.equal(waited, false);
  await held.release();
  assert.equal(fs.existsSync(lockOf(folder)), false);
});

test("abort while waiting rejects with code cancelled and leaves the holder's lock alone", async (t) => {
  const folder = tempFolder(t);
  const first = await acquireRenderLock(folder, {});
  const before = fs.readFileSync(lockOf(folder), "utf8");
  const controller = new AbortController();
  const waits: { pid: number; since: string }[] = [];
  const second = acquireRenderLock(folder, { signal: controller.signal, pollMs: 20, onWait: (h) => waits.push(h) });
  await sleep(150);
  controller.abort();
  await assert.rejects(second, (error: unknown) => {
    assert.ok(error instanceof Error);
    const problem = error as Error & { code: string; fix: string };
    assert.equal(problem.code, "cancelled");
    assert.equal(typeof problem.message, "string");
    assert.equal(typeof problem.fix, "string");
    return true;
  });
  assert.ok(waits.length > 0);
  assert.equal(waits[0]!.pid, process.pid);
  assert.equal(waits[0]!.since, JSON.parse(before).since);
  assert.equal(fs.readFileSync(lockOf(folder), "utf8"), before);
  await first.release();
});

// ---- edge cases ----

test("an already aborted signal rejects at once and creates nothing", async (t) => {
  const folder = tempFolder(t);
  await assert.rejects(acquireRenderLock(folder, { signal: AbortSignal.abort() }), { code: "cancelled" });
  assert.equal(fs.existsSync(lockOf(folder)), false);
});

test("a missing data folder is created", async (t) => {
  const folder = path.join(tempFolder(t), "a", "b");
  const held = await acquireRenderLock(folder, {});
  assert.equal(fs.existsSync(lockOf(folder)), true);
  await held.release();
});

test("PID reuse: a live pid's lock is taken over only after this waiter watched it unchanged for staleMs", async (t) => {
  const folder = tempFolder(t);
  // process.ppid is alive and is not a lock holder: a crashed holder's pid now in use by something else.
  // Its time looks hours old, which alone proves nothing (sleep, clock jump, skewed network folder).
  writeLock(folder, foreign(process.ppid), 5 * 3_600_000);
  const started = performance.now();
  let acquiredAt = 0;
  const pending = acquireRenderLock(folder, { pollMs: 20, staleMs: 400 }).then((held) => {
    acquiredAt = performance.now();
    return held;
  });
  await sleep(200);
  assert.equal(fs.readFileSync(lockOf(folder), "utf8"), foreign(process.ppid), "taken over before staleMs of watching");
  const held = await pending;
  assert.ok(acquiredAt - started >= 400, `taken over after ${acquiredAt - started} ms`);
  assert.equal(JSON.parse(fs.readFileSync(lockOf(folder), "utf8")).pid, process.pid);
  await held.release();
});

test("a lock that looks hours old at first sight but then beats is never taken over", async (t) => {
  const folder = tempFolder(t);
  writeLock(folder, foreign(process.ppid), 5 * 3_600_000);
  const beats = setInterval(() => {
    const now = new Date();
    fs.utimesSync(lockOf(folder), now, now);
  }, 80);
  t.after(() => clearInterval(beats));
  const controller = new AbortController();
  const waits: number[] = [];
  const pending = acquireRenderLock(folder, { signal: controller.signal, pollMs: 20, staleMs: 300, onWait: (h) => waits.push(h.pid) });
  await sleep(1_200);
  controller.abort();
  await assert.rejects(pending, { code: "cancelled" });
  clearInterval(beats);
  assert.ok(waits.length > 0);
  assert.equal(fs.readFileSync(lockOf(folder), "utf8"), foreign(process.ppid));
});

test("a live pid with a recent heartbeat is waited for", async (t) => {
  const folder = tempFolder(t);
  writeLock(folder, foreign(process.ppid), 2 * STALE_MS); // the time alone never makes it stale
  const controller = new AbortController();
  const waits: number[] = [];
  const pending = acquireRenderLock(folder, { signal: controller.signal, pollMs: 20, onWait: (h) => waits.push(h.pid) });
  await sleep(150);
  controller.abort();
  await assert.rejects(pending, { code: "cancelled" });
  assert.ok(waits.length > 0 && waits.every((pid) => pid === process.ppid));
  assert.equal(fs.readFileSync(lockOf(folder), "utf8"), foreign(process.ppid));
});

test("the holder beats: the lock's modified time keeps moving while it is held", async (t) => {
  const folder = tempFolder(t);
  const held = await acquireRenderLock(folder, { beatMs: 30 });
  const then = new Date(Date.now() - 120_000);
  fs.utimesSync(lockOf(folder), then, then);
  await sleep(250);
  const age = Date.now() - fs.statSync(lockOf(folder)).mtimeMs;
  assert.ok(age < 5_000, `the lock is ${age} ms old`);
  assert.equal(held.lost.aborted, false);
  await held.release();
});

test("an empty or unfinished lock is waited for briefly, then taken over", async (t) => {
  const folder = tempFolder(t);
  // Fresh and empty: a holder between its exclusive create and its write. Waited for, without onWait.
  writeLock(folder, "");
  const controller = new AbortController();
  let waited = false;
  const pending = acquireRenderLock(folder, { signal: controller.signal, pollMs: 20, onWait: () => (waited = true) });
  await sleep(150);
  controller.abort();
  await assert.rejects(pending, { code: "cancelled" });
  assert.equal(waited, false);
  assert.equal(fs.readFileSync(lockOf(folder), "utf8"), "");

  // Watched unchanged for unwrittenMs: a crash mid-write. Taken over.
  for (const content of ["", '{"pid": 12', "not json", JSON.stringify({ pid: -1, since: 3 })]) {
    writeLock(folder, content);
    const started = performance.now();
    const held = await acquireRenderLock(folder, { pollMs: 20, unwrittenMs: 100 });
    assert.ok(performance.now() - started >= 100, content);
    assert.equal(JSON.parse(fs.readFileSync(lockOf(folder), "utf8")).pid, process.pid, content);
    await held.release();
  }
});

test("waiters racing for the same stale lock take it one at a time", async (t) => {
  const folder = tempFolder(t);
  writeLock(folder, foreign(deadPid()));
  const windows: { from: number; to: number }[] = [];
  let holding = 0;
  let most = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      const held = await acquireRenderLock(folder, { pollMs: 10 });
      holding++;
      most = Math.max(most, holding);
      const from = performance.now();
      await sleep(40);
      holding--;
      windows.push({ from, to: performance.now() });
      await held.release();
    }),
  );
  assert.equal(most, 1, `${most} waiters held the lock at once`);
  assert.equal(windows.length, 6);
});

test("separate processes racing for a stale lock never overlap", async (t) => {
  const folder = tempFolder(t);
  writeLock(folder, foreign(deadPid()));
  const holders = Array.from({ length: 4 }, () => holder(folder, 250));
  const codes = await Promise.all(holders.map((h) => h.exited));
  holders.forEach((h, i) => assert.equal(codes[i], 0, h.stderr()));
  const spans = holders.map((h) => ({ from: at(h.events, "acquired"), to: at(h.events, "releasing") })).sort((a, b) => a.from - b.from);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i]!.from >= spans[i - 1]!.to, JSON.stringify(spans));
});

test("releasing leaves another process's lock in place, and twice is harmless", async (t) => {
  const folder = tempFolder(t);
  const held = await acquireRenderLock(folder, {});
  // Someone else took the lock over (this holder was judged stale) and now holds it.
  writeLock(folder, foreign(process.ppid));
  await held.release();
  await held.release();
  assert.equal(fs.readFileSync(lockOf(folder), "utf8"), foreign(process.ppid));
});

/** Resolves with the lost reason, or rejects after `ms`. */
function lostWithin(held: Held, ms: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`lost did not fire within ${ms} ms`)), ms);
    held.lost.addEventListener("abort", () => (clearTimeout(timer), resolve(held.lost.reason)), { once: true });
  });
}

test("lost fires when another token replaces the lock, and release then leaves it", async (t) => {
  const folder = tempFolder(t);
  const held = await acquireRenderLock(folder, { beatMs: 30 });
  writeLock(folder, foreign(process.ppid));
  const reason = await lostWithin(held, 2_000);
  assert.equal(reason.code, "lock-lost");
  assert.equal(typeof reason.fix, "string");
  await held.release();
  assert.equal(fs.readFileSync(lockOf(folder), "utf8"), foreign(process.ppid));
});

test("lost fires when the lock is deleted, and not after a release", async (t) => {
  const folder = tempFolder(t);
  const held = await acquireRenderLock(folder, { beatMs: 30 });
  fs.unlinkSync(lockOf(folder));
  assert.equal((await lostWithin(held, 2_000)).code, "lock-lost");
  await held.release();

  const second = await acquireRenderLock(folder, { beatMs: 30 });
  await second.release();
  await sleep(150);
  assert.equal(second.lost.aborted, false);
});

test("the exit handler releases a lock left held", async (t) => {
  const folder = tempFolder(t);
  const child = holder(folder, 0, "exit");
  assert.equal(await child.exited, 0, child.stderr());
  assert.ok(child.events.some((e) => e.event === "acquired"));
  assert.equal(fs.existsSync(lockOf(folder)), false);
});

test("the exit handler does not throw when the lock is already gone", async (t) => {
  const folder = path.join(tempFolder(t), "data");
  const child = holder(folder, 0, "exit-gone");
  assert.equal(await child.exited, 0);
  assert.equal(child.stderr(), "");
});

test("isAlive: ESRCH is dead; EPERM (another user's process) and success are alive", () => {
  const throwing = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  assert.equal(isAlive(1234, throwing("ESRCH")), false);
  assert.equal(isAlive(1234, throwing("EPERM")), true);
  assert.equal(isAlive(1234, () => true), true);
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(deadPid()), false);
});

// ---- the waiter's watch, on an injected clock ----

test("Watch: unchanged time builds up only from sightings close together", () => {
  let now = 0;
  const watch = new Watch(BEAT_MS, () => now);
  // Polled every 500 ms for 70 s: watched unchanged for 70 s, longer than STALE_MS.
  for (; now <= 70_000; now += 500) watch.unchangedFor("a");
  assert.equal(watch.unchangedFor("a"), 70_500);
  assert.ok(watch.unchangedFor("a") > STALE_MS);
  // A new key starts again.
  assert.equal(watch.unchangedFor("b"), 0);
});

test("Watch: a laptop asleep while watching does not count as watched", () => {
  let now = 0;
  const watch = new Watch(BEAT_MS, () => now);
  for (; now <= 20_000; now += 500) watch.unchangedFor("a");
  // Asleep for 3 h; the monotonic clock counted it. The first sighting on wake starts again.
  now += 3 * 3_600_000;
  assert.equal(watch.unchangedFor("a"), 0);
  // Then it builds up again only while the waiter keeps watching.
  now += 500;
  assert.equal(watch.unchangedFor("a"), 500);
  // A gap of exactly gapMs still counts; one beyond it does not.
  now += BEAT_MS;
  assert.equal(watch.unchangedFor("a"), 500 + BEAT_MS);
  now += BEAT_MS + 1;
  assert.equal(watch.unchangedFor("a"), 0);
});
