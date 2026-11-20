// The kill switch: the site's catalog names the adapter versions it allows and blocks, and a
// blocked adapter answers every tool but account and disconnect with a `blocked` refusal.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { CATALOG_MAX_AGE_MS, CATALOG_RETRY_MS, checkCatalog } from "../src/catalog.ts";
import { blockedProblem, checkAdapters, compareVersions, MESSAGE_CHARS, parseRange, satisfies, UPGRADE_FIX } from "../src/killswitch.ts";
import { createServer, type ServerDeps } from "../src/server.ts";
import type { Rendered } from "../src/session.ts";
import { assertBlocked as assertBlockedWith, blocking, CATALOG, PLAN, REFUSED, withAdapters } from "./fixtures/killswitch.ts";

const DELIVERED: Rendered = { ok: true, value: { files: [{ path: "/p/motion-mockups/a.mp4", bytes: 10 }], warnings: [], notice: "n" } };
const with_ = withAdapters;
const structured = (result: any) => result.structuredContent as any;

// ---- Versions and ranges ----

test("versions compare by number, and a prerelease is lower than its release", () => {
  const order = ["0.0.9", "0.1.0-0", "0.1.0-alpha", "0.1.0-alpha.1", "0.1.0-alpha.beta", "0.1.0-beta.2", "0.1.0-beta.11", "0.1.0-rc.1", "0.1.0", "0.1.1", "0.2.0", "0.10.0", "1.0.0"];
  for (let i = 0; i < order.length - 1; i++) {
    assert.equal(compareVersions(order[i]!, order[i + 1]!), -1, `${order[i]} < ${order[i + 1]}`);
    assert.equal(compareVersions(order[i + 1]!, order[i]!), 1, `${order[i + 1]} > ${order[i]}`);
  }
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.3+build.5", "1.2.3"), 0, "build metadata is not compared");
  assert.equal(compareVersions("1.2", "1.2.3"), undefined);
});

test("ranges: the comparators, ^ and a bare version", () => {
  const cases: [string, string, boolean][] = [
    [">=0.1.0", "0.1.0", true],
    [">=0.1.0", "0.0.9", false],
    [">=0.1.0", "0.1.0-beta.1", false],
    [">=0.1.0", "0.2.0-beta.1", true],
    [">0.1.0", "0.1.0", false],
    [">0.1.0", "0.1.1", true],
    ["<0.2.0", "0.1.9", true],
    ["<0.2.0", "0.2.0", false],
    ["<0.2.0", "0.2.0-rc.1", true],
    ["<=0.2.0", "0.2.0", true],
    ["=0.2.0", "0.2.0", true],
    ["=0.2.0", "0.2.1", false],
    ["0.2.0", "0.2.0", true],
    [">=0.1.0 <0.3.0", "0.2.5", true],
    [">=0.1.0  <0.3.0", "0.3.0", false],
    ["^1.2.3", "1.9.0", true],
    ["^1.2.3", "1.2.2", false],
    ["^1.2.3", "2.0.0", false],
    ["^1.2.3", "2.0.0-beta.1", false],
    ["^0.2.3", "0.2.9", true],
    ["^0.2.3", "0.3.0", false],
    ["^0.0.3", "0.0.3", true],
    ["^0.0.3", "0.0.4", false],
  ];
  for (const [range, version, expected] of cases) assert.equal(satisfies(version, parseRange(range)!), expected, `${version} in "${range}"`);
});

test("ranges outside the subset are not read", () => {
  for (const range of ["", " ", "*", "x", "1.2", ">= 1.0.0", "~1.2.3", "1.0.0 - 2.0.0", ">=1.0.0 || <0.5.0", "v1.0.0", "^1.x", "≥1.0.0", "01.0.0", ">=1.0.0-"])
    assert.equal(parseRange(range), undefined, JSON.stringify(range));
});

// ---- The adapters block ----

test("the adapters block: well formed, it is kept with the message capped", () => {
  assert.deepEqual(checkAdapters({ allowed: ">=0.1.0", blocked: ["0.1.3"], message: "" }), { allowed: ">=0.1.0", blocked: ["0.1.3"], message: "" });
  assert.deepEqual(checkAdapters({ blocked: [] }), { blocked: [], message: "" }, "allowed and message may be left out");
  const long = checkAdapters({ allowed: ">=0.1.0", blocked: [], message: "m".repeat(2_000) });
  assert.equal(typeof long, "object");
  assert.equal((long as any).message.length, MESSAGE_CHARS);
  assert.equal(MESSAGE_CHARS, 500);
  // A cut never leaves half of a two-unit (UTF-16 surrogate pair) character before the ellipsis.
  const emoji = (checkAdapters({ message: `${"a".repeat(MESSAGE_CHARS - 2)}\u{1F6AB}${"b".repeat(10)}` }) as any).message as string;
  assert.ok(emoji.length <= MESSAGE_CHARS);
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, "no lone high surrogate");
  assert.equal(emoji, `${"a".repeat(MESSAGE_CHARS - 2)}…`);
});

test("the adapters block: a malformed one is a reason, never a block", () => {
  const malformed: unknown[] = [
    null,
    "block everything",
    [">=0.1.0"],
    { allowed: 1 },
    { allowed: "≥1.0.0" },
    { allowed: ">= 1.0.0" },
    { allowed: "" },
    { blocked: "0.1.0" },
    { blocked: [1] },
    { blocked: ["0.1"] },
    { message: 5 },
  ];
  for (const value of malformed) assert.equal(typeof checkAdapters(value), "string", JSON.stringify(value));
});

test("verdict: allowed, blocked by the list, outside the range, a missing block, an unbuilt adapter", () => {
  const allowed = { allowed: ">=0.1.0", blocked: [], message: "" };
  assert.equal(blockedProblem(allowed, "0.1.0"), undefined, "allowed");
  assert.equal(blockedProblem(undefined, "0.0.1"), undefined, "a missing block allows every version");

  const listed = blockedProblem({ allowed: ">=0.1.0", blocked: ["0.1.2"], message: "0.1.2 loses renders. Update." }, "0.1.2")!;
  assert.equal(listed.code, "blocked");
  assert.equal(listed.message, "0.1.2 loses renders. Update.");
  assert.equal(listed.fix, UPGRADE_FIX);
  assert.match(UPGRADE_FIX, /npx motionmockups@latest/);
  assert.match(UPGRADE_FIX, /Claude Desktop extension/);
  assert.equal(blockedProblem({ blocked: ["0.1.2"], message: "" }, "0.1.3"), undefined, "only the listed version");
  assert.equal(blockedProblem({ blocked: ["0.1.2"], message: "" }, "0.1.2+build.7")?.code, "blocked", "the list compares versions, not text");

  const outside = blockedProblem({ allowed: ">=0.2.0", blocked: [], message: "" }, "0.1.9")!;
  assert.equal(outside.code, "blocked");
  assert.match(outside.message, /0\.1\.9/, "the default message names the version");
  assert.equal(outside.fix, UPGRADE_FIX);
  assert.equal(blockedProblem({ allowed: ">=0.2.0", blocked: [], message: "  " }, "0.1.9")!.message, outside.message, "a blank message is the default");

  assert.equal(blockedProblem({ allowed: ">=9.0.0", blocked: ["dev"], message: "" }, "dev"), undefined, "an unbuilt adapter skips the check");
});

test("checkCatalog: a malformed adapters block is left out with one note; a good one is kept; none is none", () => {
  const good = checkCatalog(with_({ allowed: ">=0.1.0", blocked: [], message: "" })) as any;
  assert.deepEqual(good.adapters, { allowed: ">=0.1.0", blocked: [], message: "" });
  assert.equal(good.ignored, undefined);
  const none = checkCatalog(CATALOG) as any;
  assert.equal(none.adapters, undefined);
  assert.equal(none.ignored, undefined);
  const bad = checkCatalog(with_({ allowed: "≥0.1.0", blocked: [], message: "" })) as any;
  assert.equal(typeof bad, "object", "the catalog itself is still read");
  assert.equal(bad.adapters, undefined);
  assert.equal(bad.ignored.length, 1);
  assert.match(bad.ignored[0], /adapters/);
  assert.match(bad.ignored[0], /every version/);
});

// ---- The server ----

function temp(t: TestContext, prefix: string): string {
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

/** A server on a site whose catalog `serve()` gives, at version `version`, on an injected clock. */
async function start(
  t: TestContext,
  options: { serve: () => unknown; version?: string; renderOnce?: ServerDeps["renderOnce"]; log?: (line: string) => void },
) {
  const clock = { now: 1_000_000 };
  const fetches: string[] = [];
  const renders: unknown[] = [];
  const deps: ServerDeps = {
    origin: new URL("http://127.0.0.1:4173"),
    env: {},
    fetch: (async (input: string | URL) => {
      fetches.push(String(input));
      return new Response(JSON.stringify(options.serve()), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    renderOnce: async (request, context) => {
      renders.push(request);
      return options.renderOnce ? options.renderOnce(request, context) : DELIVERED;
    },
    data: temp(t, "mm-kill-data-"),
    chromeMode: "headless",
    timeoutMs: 20 * 60_000,
    version: options.version ?? "0.1.0",
    log: options.log ?? (() => {}),
    now: () => clock.now,
  };
  const adapter = await createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await adapter.server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => {});
    await adapter.stop();
  });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { client, call, clock, fetches, renders };
}

const BLOCKING = blocking("0.1.0");

const assertBlocked = (result: any, what: string, message = BLOCKING.message) => assertBlockedWith(result, what, message);

test("blocked at start: every tool refuses but account and disconnect; nothing renders; the descriptions stay", async (t) => {
  const open = await start(t, { serve: () => CATALOG });
  const logged: string[] = [];
  const { call, client, renders } = await start(t, { serve: () => with_(BLOCKING), log: (l) => logged.push(l) });
  for (const [name, args] of REFUSED) assertBlocked(await call(name, args), `${name} ${JSON.stringify(args)}`);
  assert.equal(renders.length, 0, "nothing rendered");
  const account = await call("account");
  assert.notEqual(account.isError, true);
  assert.equal(structured(account).tier, "free");
  const disconnect = await call("connect_account", { disconnect: true });
  assert.notEqual(disconnect.isError, true);
  assert.equal(structured(disconnect).removed, false);
  // Only the results refuse: the tools and their descriptions are the same as an open adapter's.
  assert.deepEqual((await client.listTools()).tools, (await open.client.listTools()).tools);
  // Said once on stderr, however many calls are refused.
  assert.equal(logged.filter((l) => /blocked/.test(l)).length, 1);
});

test("outside the allowed range refuses with the site's message, or the default naming the version", async (t) => {
  const { call } = await start(t, { serve: () => with_({ allowed: ">=0.2.0", blocked: [], message: "" }), version: "0.1.5" });
  const result = await call("render", { plan: PLAN });
  assert.equal(result.isError, true);
  assert.equal(structured(result).problems[0].code, "blocked");
  assert.match(structured(result).problems[0].message, /0\.1\.5/);
});

test("the site's message is capped at 500 characters in the refusal", async (t) => {
  const { call } = await start(t, { serve: () => with_({ ...BLOCKING, message: "x".repeat(5_000) }) });
  const result = await call("list_scenes");
  assert.equal(structured(result).problems[0].code, "blocked");
  assert.equal(structured(result).problems[0].message.length, 500);
});

test("allowed, and an unbuilt adapter, serve every tool", async (t) => {
  const allowed = await start(t, { serve: () => with_({ allowed: ">=0.1.0", blocked: [], message: "" }) });
  assert.notEqual((await allowed.call("list_scenes")).isError, true);
  assert.notEqual((await allowed.call("render", { plan: PLAN })).isError, true);
  const dev = await start(t, { serve: () => with_({ allowed: ">=9.0.0", blocked: [], message: "" }), version: "dev" });
  assert.notEqual((await dev.call("list_scenes")).isError, true);
  assert.notEqual((await dev.call("render", { plan: PLAN })).isError, true);
});

test("the catalog is read again once it is 10 minutes old, and a block it brings refuses from then on", async (t) => {
  let served: unknown = CATALOG;
  const { call, clock, fetches } = await start(t, { serve: () => served });
  assert.equal(CATALOG_MAX_AGE_MS, 10 * 60_000);
  assert.equal(fetches.length, 1);
  served = with_(BLOCKING);
  clock.now += CATALOG_MAX_AGE_MS - 1;
  assert.notEqual((await call("list_scenes")).isError, true, "a 9-minute-old catalog is still used");
  assert.equal(fetches.length, 1);
  clock.now += 1;
  assertBlocked(await call("list_scenes"), "the call after 10 minutes");
  assert.equal(fetches.length, 2);
  assertBlocked(await call("render", { plan: PLAN }), "render");
  assert.equal(fetches.length, 2, "the new catalog is kept for another 10 minutes");
  // Lifted on the site: the next re-read serves again.
  served = CATALOG;
  clock.now += CATALOG_MAX_AGE_MS;
  assert.notEqual((await call("render", { plan: PLAN })).isError, true);
});

test("a re-read that fails keeps the last good catalog and its verdict", async (t) => {
  let up = true;
  const { call, clock } = await start(t, {
    serve: () => {
      if (!up) throw new TypeError("fetch failed");
      return with_(BLOCKING);
    },
  });
  up = false;
  clock.now += CATALOG_MAX_AGE_MS;
  assertBlocked(await call("list_scenes"), "offline, the last verdict holds");
});

test("a block arriving mid-render: the running render finishes, the next call is refused", async (t) => {
  let served: unknown = CATALOG;
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  let finish!: (r: Rendered) => void;
  const { call, clock, renders } = await start(t, {
    serve: () => served,
    renderOnce: () =>
      new Promise<Rendered>((resolve) => {
        finish = resolve;
        started();
      }),
  });
  const first = call("render", { plan: PLAN });
  await running;
  served = with_(BLOCKING);
  clock.now += CATALOG_MAX_AGE_MS;
  assertBlocked(await call("list_scenes"), "the call during the render");
  finish(DELIVERED);
  const delivered = await first;
  assert.notEqual(delivered.isError, true, "the render that had started is delivered");
  assert.deepEqual(structured(delivered).files, [{ path: "/p/motion-mockups/a.mp4", bytes: 10 }]);
  assertBlocked(await call("render", { plan: PLAN }), "the next render");
  assertBlocked(await call("still", { plan: PLAN, seconds: 1, format: "png" }), "the next still");
  assert.equal(renders.length, 1);
});

test("a render waiting its turn when a block arrives is refused when its turn comes", async (t) => {
  let served: unknown = CATALOG;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => (started = resolve));
  let turn!: () => void;
  const lockFree = new Promise<void>((resolve) => (turn = resolve));
  const { call, clock } = await start(t, {
    serve: () => served,
    // As the session does: wait for the lock, then ask whether the render may still run.
    renderOnce: async (_request, context) => {
      started();
      await lockFree;
      const blocked = await context.stillAllowed?.();
      return blocked ? { ok: false, problems: [blocked] } : DELIVERED;
    },
  });
  const waited = call("render", { plan: PLAN });
  await waiting;
  served = with_(BLOCKING);
  clock.now += CATALOG_MAX_AGE_MS;
  turn();
  assertBlocked(await waited, "the render that waited");
});

test("a failed re-read is tried again after a minute, not on every call", async (t) => {
  let up = true;
  const { call, clock, fetches } = await start(t, {
    serve: () => {
      if (!up) throw new TypeError("fetch failed");
      return CATALOG;
    },
  });
  up = false;
  clock.now += CATALOG_MAX_AGE_MS;
  for (let i = 0; i < 20; i++) assert.notEqual((await call("list_scenes")).isError, true, "the last good catalog serves");
  assert.equal(fetches.length, 2, "one failed re-read for 20 calls");
  clock.now += CATALOG_RETRY_MS - 1;
  await call("list_scenes");
  assert.equal(fetches.length, 2);
  clock.now += 1;
  await call("list_scenes");
  assert.equal(fetches.length, 3, "tried again a minute later");
  assert.equal(CATALOG_RETRY_MS, 60_000);
});

test("a malformed adapters block never locks anyone out, and is noted once on stderr", async (t) => {
  const logged: string[] = [];
  const { call, clock } = await start(t, {
    serve: () => with_({ allowed: "<0.0.0 ||| nonsense", blocked: ["0.1.0"], message: "blocked" }),
    log: (l) => logged.push(l),
  });
  for (const [name, args] of REFUSED.filter(([n]) => n !== "connect_account")) {
    const result = await call(name, args);
    assert.notEqual(structured(result).problems?.[0]?.code, "blocked", name);
  }
  assert.notEqual((await call("render", { plan: PLAN })).isError, true, "render serves");
  clock.now += CATALOG_MAX_AGE_MS;
  await call("list_scenes");
  clock.now += CATALOG_MAX_AGE_MS;
  await call("list_scenes");
  const notes = logged.filter((l) => /adapters/.test(l));
  assert.equal(notes.length, 1, logged.join("\n"));
  assert.match(notes[0]!, /every version/);
});
