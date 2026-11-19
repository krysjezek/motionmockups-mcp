import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { Cdp } from "../src/chrome/cdp.ts";

/** A Cdp over in-memory streams: `sent` collects what it writes, `reply` feeds raw bytes back. */
function harness() {
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  const cdp = new Cdp(toChrome, fromChrome);
  let buffered = "";
  const sent: any[] = [];
  toChrome.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let end;
    while ((end = buffered.indexOf("\0")) !== -1) {
      sent.push(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
    }
  });
  const reply = (raw: string | Buffer) => fromChrome.write(raw);
  const frame = (message: object) => JSON.stringify(message) + "\0";
  return { cdp, sent, reply, frame, fromChrome, toChrome };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("each message is JSON terminated by a NUL, with increasing ids and the session", async () => {
  const { cdp, sent } = harness();
  cdp.send("Browser.getVersion").catch(() => {});
  cdp.send("Runtime.evaluate", { expression: "1+1" }, "S1").catch(() => {});
  await tick();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], { id: 1, method: "Browser.getVersion", params: {} });
  assert.deepEqual(sent[1], { id: 2, method: "Runtime.evaluate", params: { expression: "1+1" }, sessionId: "S1" });
  cdp.close();
});

test("responses match their sends by id, in any order", async () => {
  const { cdp, reply, frame } = harness();
  const a = cdp.send<{ n: string }>("A.a");
  const b = cdp.send<{ n: string }>("B.b");
  reply(frame({ id: 2, result: { n: "b" } }));
  reply(frame({ id: 1, result: { n: "a" } }));
  assert.deepEqual(await a, { n: "a" });
  assert.deepEqual(await b, { n: "b" });
  cdp.close();
});

test("a message split across chunks, and several messages in one chunk, parse", async () => {
  const { cdp, reply, frame } = harness();
  const one = cdp.send("One.one");
  const two = cdp.send("Two.two");
  const three = cdp.send("Three.three");
  const first = frame({ id: 1, result: { text: "héllo ✓" } });
  const bytes = Buffer.from(first, "utf8");
  // Split inside a multi-byte character.
  const cut = Buffer.from(first.slice(0, first.indexOf("✓")), "utf8").length + 1;
  reply(bytes.subarray(0, cut));
  await tick();
  reply(bytes.subarray(cut));
  reply(frame({ id: 2, result: { v: 2 } }) + frame({ id: 3, result: { v: 3 } }));
  assert.deepEqual(await one, { text: "héllo ✓" });
  assert.deepEqual(await two, { v: 2 });
  assert.deepEqual(await three, { v: 3 });
  cdp.close();
});

test("an error response rejects with code cdp and Chrome's message", async () => {
  const { cdp, reply, frame } = harness();
  const pending = cdp.send("Nope.nope");
  reply(frame({ id: 1, error: { code: -32601, message: "'Nope.nope' wasn't found" } }));
  await assert.rejects(pending, (e: any) => e.code === "cdp" && /Nope\.nope/.test(e.message) && typeof e.fix === "string");
  cdp.close();
});

test("events reach their listeners with the session, and unsubscribing stops them", async () => {
  const { cdp, reply, frame } = harness();
  const seen: unknown[] = [];
  const off = cdp.on("Browser.downloadProgress", (params, sessionId) => seen.push([params, sessionId]));
  cdp.on("Runtime.bindingCalled", (params, sessionId) => seen.push(["binding", params, sessionId]));
  reply(frame({ method: "Browser.downloadProgress", params: { state: "inProgress" } }));
  reply(frame({ method: "Runtime.bindingCalled", params: { name: "x" }, sessionId: "S9" }));
  await tick();
  off();
  reply(frame({ method: "Browser.downloadProgress", params: { state: "completed" } }));
  await tick();
  assert.deepEqual(seen, [
    [{ state: "inProgress" }, undefined],
    ["binding", { name: "x" }, "S9"],
  ]);
  cdp.close();
});

test("a listener that throws does not stop the others or the reader", async () => {
  const { cdp, reply, frame } = harness();
  let reached = false;
  cdp.on("E.e", () => {
    throw new Error("listener bug");
  });
  cdp.on("E.e", () => (reached = true));
  const pending = cdp.send("After.after");
  reply(frame({ method: "E.e", params: {} }) + frame({ id: 1, result: { ok: true } }));
  assert.deepEqual(await pending, { ok: true });
  assert.equal(reached, true);
  cdp.close();
});

test("close() rejects pending sends with chrome-closed, and later sends too", async () => {
  const { cdp } = harness();
  const pending = cdp.send("Slow.slow");
  cdp.close();
  await assert.rejects(pending, (e: any) => e.code === "chrome-closed" && typeof e.fix === "string");
  await assert.rejects(cdp.send("Late.late"), (e: any) => e.code === "chrome-closed");
});

test("the read side ending closes the connection", async () => {
  const { cdp, fromChrome } = harness();
  const pending = cdp.send("Slow.slow");
  fromChrome.end();
  await assert.rejects(pending, (e: any) => e.code === "chrome-closed");
});

test("a write error closes the connection instead of throwing", async () => {
  const { cdp, toChrome } = harness();
  const pending = cdp.send("Slow.slow");
  toChrome.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  await assert.rejects(pending, (e: any) => e.code === "chrome-closed");
});

test("params that cannot be serialised reject the send, write nothing and leave no pending entry", async () => {
  const { cdp, sent, reply, frame } = harness();
  const circular: any = {};
  circular.self = circular;
  await assert.rejects(cdp.send("Bad.circular", circular), (e: any) => e.code === "cdp" && typeof e.fix === "string");
  await assert.rejects(cdp.send("Bad.bigint", { n: 1n }), (e: any) => e.code === "cdp");
  await tick();
  assert.equal(sent.length, 0);
  assert.equal(cdp.pending, 0);
  const next = cdp.send("Good.good");
  await tick();
  reply(frame({ id: sent[0].id, result: { fine: true } }));
  assert.deepEqual(await next, { fine: true });
  assert.equal(cdp.pending, 0);
  cdp.close();
});

test("a malformed frame is skipped, not fatal", async () => {
  const { cdp, reply, frame } = harness();
  const pending = cdp.send("A.a");
  reply("{not json\0" + frame({ id: 1, result: {} }));
  assert.deepEqual(await pending, {});
  cdp.close();
});
