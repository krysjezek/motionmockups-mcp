import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { FALLBACK_BRIEFING, MAX_BRIEFING_CHARS, checkCatalog, type AgentCatalog } from "../src/catalog.ts";
import type { Launcher } from "../src/connect.ts";
import { createServer, sdkProblem, settingsFromEnv, type ServerDeps } from "../src/server.ts";
import type { Rendered, RenderRequest, SessionContext } from "../src/session.ts";
import { TOKEN_FILE, writeToken } from "../src/token.ts";
import { agentSite, approved, denied, pending, statusFor, TOKEN, unavailable, USER_CODE, type SiteOptions } from "./fixtures/agent-site.ts";

const ORIGIN = new URL("http://127.0.0.1:4173");
const NOTICE = "Watermarked preview for evaluation only. Publishing it needs Motion Mockups Pro (https://motionmockups.com/pricing).";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const CATALOG: AgentCatalog = {
  contract: 1,
  briefing: "The test briefing.\nSecond line.",
  devices: [
    { device: "iPhone", fps: 30, screen: { width: 1179, height: 2556 }, tips: ["Record portrait."] },
    { device: "Display", fps: 30, screen: { width: 3840, height: 2160 }, tips: ["Record 16:9.", "Hide the cursor."] },
  ],
  scenes: [
    { id: "blanc-iphone-shot-1", device: "iPhone", collection: "Gallery", title: "Orbit", seconds: 8, poster: "https://assets.example/p1.webp" },
    { id: "maison-iphone-shot-1", device: "iPhone", collection: "Parlor", title: "Push In", seconds: 8, poster: "https://assets.example/p2.webp" },
    { id: "blanc-xdr-shot-1", device: "Display", collection: "Gallery", title: "Drift", seconds: 8, poster: "https://assets.example/p3.webp" },
  ],
  rules: {
    aspects: ["1:1", "4:3", "16:9", "4:5", "9:16"],
    sizes: [1080, 2160],
    minClipSeconds: 1,
    maxImageSeconds: 60,
    videoTypes: ["video/mp4", "video/quicktime"],
    imageTypes: ["image/png", "image/jpeg"],
    delivery: ["film", "scenes"],
  },
};

const PLAN = { contract: 1, device: "iPhone", aspect: "9:16", clips: [{ scene: "blanc-iphone-shot-1" }] };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

/** A fetch that serves the catalog, counting calls. */
function catalogFetch(body: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return body();
  }) as typeof fetch;
  return { fn, calls };
}

const failingFetch = (async () => {
  throw new TypeError("fetch failed");
}) as typeof fetch;

type Call = { request: RenderRequest; context: SessionContext };

interface Started {
  client: Client;
  calls: Call[];
  sent: JSONRPCMessage[];
  received: JSONRPCMessage[];
  stop: () => Promise<void>;
}

async function start(
  t: TestContext,
  options: {
    fetch?: typeof fetch;
    renderOnce?: (request: RenderRequest, context: SessionContext) => Promise<Rendered>;
    env?: NodeJS.ProcessEnv;
    roots?: string[];
    /** The client declares roots, but answering roots/list fails while this returns true. */
    rootsFail?: () => boolean;
    log?: (line: string) => void;
    origin?: URL;
    data?: string;
    openBrowser?: Launcher;
  } = {},
): Promise<Started> {
  const calls: Call[] = [];
  const delivered: Rendered = { ok: true, value: { files: [{ path: "/p/motion-mockups/a.mp4", bytes: 10 }], warnings: [], notice: NOTICE } };
  const deps: ServerDeps = {
    origin: options.origin ?? ORIGIN,
    env: options.env ?? {},
    fetch: options.fetch ?? catalogFetch(() => jsonResponse(CATALOG)).fn,
    renderOnce: async (request, context) => {
      calls.push({ request, context });
      return options.renderOnce ? options.renderOnce(request, context) : delivered;
    },
    data: options.data ?? temp(t, "mm-server-data-"),
    chromeMode: "headless",
    timeoutMs: 20 * 60_000,
    version: "0.0.0-test",
    log: options.log ?? (() => {}),
    // 5 s of the site's poll interval is 25 ms here.
    connectTimeScale: 0.005,
    openBrowser: options.openBrowser ?? (() => assert.fail("a test opened a browser")),
  };
  const adapter = await createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // What the server sends and what the client sends, as seen on the wire.
  const sent: JSONRPCMessage[] = [];
  const received: JSONRPCMessage[] = [];
  const serverSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (message, opts) => {
    sent.push(message);
    return serverSend(message, opts);
  };
  const clientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, opts) => {
    received.push(message);
    return clientSend(message, opts);
  };
  const client = new Client({ name: "test", version: "1" }, { capabilities: options.roots ? { roots: { listChanged: true } } : {} });
  if (options.roots) {
    const roots = options.roots;
    client.setRequestHandler(ListRootsRequestSchema, () => {
      if (options.rootsFail?.()) throw new Error("the client could not list its roots");
      return { roots: roots.map((uri) => ({ uri })) };
    });
  }
  await adapter.server.connect(serverTransport);
  await client.connect(clientTransport);
  const stop = async () => {
    await client.close().catch(() => {});
    await adapter.stop();
  };
  t.after(stop);
  return { client, calls, sent, received, stop };
}

function temp(t: TestContext, prefix: string): string {
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

const structured = (result: any) => result.structuredContent as any;

test("the briefing is the server's instructions", async (t) => {
  const { client } = await start(t);
  assert.equal(client.getInstructions(), CATALOG.briefing);
});

test("a briefing longer than 8,000 characters is not passed on: the fallback is used, with a warning", async (t) => {
  assert.equal(MAX_BRIEFING_CHARS, 8_000);
  const logged: string[] = [];
  const at = "x".repeat(MAX_BRIEFING_CHARS);
  // Exactly at the cap it is used.
  const { client: atCap } = await start(t, { fetch: catalogFetch(() => jsonResponse({ ...CATALOG, briefing: at })).fn, log: (l) => logged.push(l) });
  assert.equal(atCap.getInstructions(), at);
  assert.equal(logged.length, 0);
  // One past it, the fallback, and one line on stderr saying why.
  const { client } = await start(t, { fetch: catalogFetch(() => jsonResponse({ ...CATALOG, briefing: `${at}y` })).fn, log: (l) => logged.push(l) });
  assert.equal(client.getInstructions(), FALLBACK_BRIEFING);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /briefing is 8001 characters, more than the 8000/);
  // The tools still work from that catalog.
  const scenes = structured(await client.callTool({ name: "list_scenes", arguments: {} }));
  assert.equal(scenes.scenes.length, 3);
});

test("the tools are the six documented ones", async (t) => {
  const { client } = await start(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["account", "connect_account", "list_scenes", "recording_spec", "render", "still"]);
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length < 400, `${tool.name} has a short description`);
    assert.equal((tool.inputSchema as any).additionalProperties, false, `${tool.name} accepts only its own fields`);
  }
  const render = tools.find((tool) => tool.name === "render")!;
  const plan = (render.inputSchema as any).properties.plan;
  assert.equal(plan.additionalProperties, false);
  assert.deepEqual(plan.required.sort(), ["aspect", "clips", "contract", "device"]);
  assert.equal(plan.properties.clips.items.additionalProperties, false);
  for (const tool of tools) {
    assert.doesNotMatch(tool.description!, /cinematic|stunning|studio-grade|in seconds|AI-powered|super easy/i);
  }
  // disconnect deletes the saved connection.
  const connect = tools.find((tool) => tool.name === "connect_account")!;
  assert.equal(connect.annotations?.destructiveHint, true);
  // A link the adapter opens itself is certainly its own; never opened without being asked.
  assert.match(connect.description!, /open: true/);
  assert.match((connect.inputSchema as any).properties.open.description, /[Rr]ecommended/);
  assert.match((connect.inputSchema as any).properties.open.description, /[Nn]ever automatic/);
  // account deletes the saved token when the site says it is no longer connected.
  assert.equal(tools.find((tool) => tool.name === "account")!.annotations?.readOnlyHint, false);
});

test("list_scenes filters by device", async (t) => {
  const { client } = await start(t);
  const all = structured(await client.callTool({ name: "list_scenes", arguments: {} }));
  assert.equal(all.scenes.length, 3);
  const iphone = await client.callTool({ name: "list_scenes", arguments: { device: "iPhone" } });
  assert.notEqual(iphone.isError, true);
  assert.deepEqual(
    structured(iphone).scenes.map((s: any) => s.id),
    ["blanc-iphone-shot-1", "maison-iphone-shot-1"],
  );
  // The text content is the same JSON, for clients that read only text.
  assert.deepEqual(JSON.parse((iphone.content as any)[0].text), structured(iphone));
  const gallery = structured(await client.callTool({ name: "list_scenes", arguments: { device: "iPhone", collection: "gallery" } }));
  assert.deepEqual(
    gallery.scenes.map((s: any) => s.id),
    ["blanc-iphone-shot-1"],
  );
});

test("list_scenes refuses an unknown device or collection with the ones there are", async (t) => {
  const { client } = await start(t);
  const device = await client.callTool({ name: "list_scenes", arguments: { device: "Watch" } });
  assert.equal(device.isError, true);
  assert.equal(structured(device).problems[0].code, "device");
  assert.match(structured(device).problems[0].fix, /iPhone, Display/);
  const collection = await client.callTool({ name: "list_scenes", arguments: { collection: "Attic" } });
  assert.equal(collection.isError, true);
  assert.equal(structured(collection).problems[0].code, "collection");
  assert.match(structured(collection).problems[0].fix, /Gallery, Parlor/);
});

test("recording_spec gives every value from the catalog", async (t) => {
  const { client } = await start(t);
  const result = await client.callTool({ name: "recording_spec", arguments: { device: "Display" } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(structured(result), {
    device: "Display",
    screen: { width: 3840, height: 2160 },
    fps: 30,
    accepted: ["video/mp4", "video/quicktime", "image/png", "image/jpeg"],
    maxImageSeconds: 60,
    tips: ["Record 16:9.", "Hide the cursor."],
  });
  const unknown = await client.callTool({ name: "recording_spec", arguments: { device: "Watch" } });
  assert.equal(unknown.isError, true);
  assert.equal(structured(unknown).problems[0].code, "device");
});

test("account, not connected: free renders are watermarked previews, and connect_account is the way to Pro", async (t) => {
  const { client } = await start(t);
  const result = structured(await client.callTool({ name: "account", arguments: {} }));
  assert.equal(result.signedIn, false);
  assert.equal(result.tier, "free");
  assert.match(result.note, /watermarked preview/i);
  assert.match(result.note, /evaluation only/i);
  assert.match(result.note, /Pro/);
  assert.match(result.note, /connect_account/);
  assert.doesNotMatch(result.note, /20\d\d|soon as|tomorrow|next week|coming/i);
});

test("render passes roots and env folders as allowed", async (t) => {
  const project = temp(t, "mm-proj-");
  const extra = temp(t, "mm-extra-");
  const { client, calls } = await start(t, {
    roots: [pathToFileURL(project).href],
    env: { MOTIONMOCKUPS_FOLDERS: extra },
  });
  const result = await client.callTool({ name: "render", arguments: { plan: PLAN, recording: "rec.mp4", name: "Launch" } });
  assert.notEqual(result.isError, true);
  assert.equal(calls.length, 1);
  const [{ request, context }] = calls;
  assert.deepEqual(context.allowed, [project, extra]);
  assert.equal(context.allowed[0], project);
  // The plan reaches the page unchanged.
  assert.deepEqual(request, { plan: PLAN, recording: "rec.mp4", name: "Launch" });
  assert.equal(context.origin.href, ORIGIN.href);
  assert.equal(context.chromeMode, "headless");
  assert.equal(context.timeoutMs, 20 * 60_000);
  assert.deepEqual(structured(result), { files: [{ path: "/p/motion-mockups/a.mp4", bytes: 10 }], warnings: [], notice: NOTICE });
});

test("roots are read again after roots/list_changed", async (t) => {
  const first = temp(t, "mm-first-");
  const second = temp(t, "mm-second-");
  const roots = [pathToFileURL(first).href];
  const { client, calls } = await start(t, { roots });
  await client.callTool({ name: "render", arguments: { plan: PLAN } });
  assert.deepEqual(calls[0]!.context.allowed, [first]);
  roots.splice(0, 1, pathToFileURL(second).href);
  await client.sendRootsListChanged();
  // The refresh is asynchronous; the next call waits for it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await client.callTool({ name: "render", arguments: { plan: PLAN } });
  assert.deepEqual(calls[1]!.context.allowed, [second]);
});

test("roots that cannot be read refuse the render, never fall back to MOTIONMOCKUPS_FOLDERS alone", async (t) => {
  const project = temp(t, "mm-proj-");
  const extra = temp(t, "mm-extra-");
  let failing = true;
  const { client, calls } = await start(t, {
    roots: [pathToFileURL(project).href],
    rootsFail: () => failing,
    env: { MOTIONMOCKUPS_FOLDERS: extra },
  });
  const result = await client.callTool({ name: "render", arguments: { plan: PLAN } });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0, "nothing was rendered");
  const [problem] = structured(result).problems;
  assert.equal(problem.code, "roots");
  assert.match(problem.message, /could not be read/);
  assert.match(problem.fix, /Try the render again/);
  assert.match(problem.fix, /MOTIONMOCKUPS_FOLDERS/);
  // The still refuses the same way.
  const still = await client.callTool({ name: "still", arguments: { plan: PLAN, seconds: 1, format: "png" } });
  assert.equal(structured(still).problems[0].code, "roots");
  assert.equal(calls.length, 0);
  // Asked again on the next render: once the client answers, the project comes first.
  failing = false;
  const again = await client.callTool({ name: "render", arguments: { plan: PLAN } });
  assert.notEqual(again.isError, true, JSON.stringify(structured(again)));
  assert.deepEqual(calls[0]!.context.allowed, [project, extra]);
});

test("still passes seconds and format", async (t) => {
  const project = temp(t, "mm-proj-");
  const { client, calls } = await start(t, { env: { MOTIONMOCKUPS_FOLDERS: project } });
  const result = await client.callTool({ name: "still", arguments: { plan: PLAN, seconds: 2.5, format: "png" } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls[0]!.request, { plan: PLAN, still: { seconds: 2.5, format: "png" } });
  assert.deepEqual(calls[0]!.context.allowed, [project]);
});

test("a refusal is an error result, not a thrown error", async (t) => {
  const problems = [{ code: "scene", message: '"x" is not a scene.', fix: "Take scene ids from the catalog." }];
  const saved = [{ path: "/p/motion-mockups/a.mp4", bytes: 10 }];
  const { client } = await start(t, { renderOnce: async () => ({ ok: false, problems, saved }) });
  const result = await client.callTool({ name: "render", arguments: { plan: PLAN } });
  assert.equal(result.isError, true);
  assert.deepEqual(structured(result), { problems, saved });
  assert.deepEqual(JSON.parse((result.content as any)[0].text), { problems, saved });
  // Without saved files there is no `saved`.
  const { client: other } = await start(t, { renderOnce: async () => ({ ok: false, problems }) });
  const plain = await other.callTool({ name: "render", arguments: { plan: PLAN } });
  assert.equal(plain.isError, true);
  assert.deepEqual(structured(plain), { problems });
});

test("an unexpected throw in a render is a refusal too", async (t) => {
  const { client } = await start(t, {
    renderOnce: async () => {
      throw new Error("boom");
    },
  });
  const result = await client.callTool({ name: "render", arguments: { plan: PLAN } });
  assert.equal(result.isError, true);
  assert.equal(structured(result).problems[0].code, "adapter");
  assert.match(structured(result).problems[0].message, /boom/);
});

test("tools accept only their documented fields", async (t) => {
  const { client, calls } = await start(t);
  for (const args of [
    { plan: PLAN, ops: { link: "x" } },
    { plan: { ...PLAN, ops: {} } },
    { plan: { ...PLAN, clips: [{ scene: "a", extra: 1 }] } },
    { plan: { ...PLAN, clips: [{ scene: "a", crop: { x: 0.5, w: 1 } }] } },
    { plan: PLAN, still: { seconds: 1, format: "png" } },
    { plan: PLAN, name: "n".repeat(201) },
  ]) {
    const result = await client.callTool({ name: "render", arguments: args as any });
    assert.equal(result.isError, true, JSON.stringify(args));
    const [problem] = structured(result).problems;
    assert.equal(problem.code, "input");
    assert.match(problem.message, /render/);
    assert.ok(problem.fix);
  }
  // A 200-character name is still a name.
  assert.notEqual((await client.callTool({ name: "render", arguments: { plan: PLAN, name: "n".repeat(200) } })).isError, true);
  assert.equal(calls.length, 1);
  calls.length = 0;
  const listed = await client.callTool({ name: "list_scenes", arguments: { device: "iPhone", limit: 3 } });
  assert.equal(listed.isError, true);
  const account = await client.callTool({ name: "account", arguments: { tier: "pro" } });
  assert.equal(account.isError, true);
  assert.equal(calls.length, 0);
});

test("cancellation reaches renderOnce's signal", async (t) => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  let aborted!: () => void;
  const sawAbort = new Promise<void>((resolve) => (aborted = resolve));
  const { client } = await start(t, {
    renderOnce: (_request, context) =>
      new Promise<Rendered>((resolve) => {
        started();
        context.signal.addEventListener("abort", () => {
          aborted();
          resolve({ ok: false, problems: [{ code: "cancelled", message: "The render was cancelled.", fix: "Nothing to undo." }] });
        });
      }),
  });
  const controller = new AbortController();
  const call = client.callTool({ name: "render", arguments: { plan: PLAN } }, undefined, { signal: controller.signal });
  call.catch(() => {});
  await running;
  controller.abort("the person stopped it");
  await sawAbort;
  await assert.rejects(call);
});

test("stopping the server cancels a running render", async (t) => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  let signal: AbortSignal | undefined;
  const { client, stop } = await start(t, {
    renderOnce: (_request, context) =>
      new Promise<Rendered>((resolve) => {
        signal = context.signal;
        started();
        context.signal.addEventListener("abort", () => resolve({ ok: false, problems: [{ code: "cancelled", message: "c", fix: "f" }] }));
      }),
  });
  client.callTool({ name: "render", arguments: { plan: PLAN } }).catch(() => {});
  await running;
  await stop();
  assert.equal(signal?.aborted, true);
});

test("progress notifications carry the token", async (t) => {
  const { client, sent, received } = await start(t, {
    renderOnce: async (_request, context) => {
      context.onProgress({ phase: "starting", completed: 0, total: 1, message: "Opening Chrome." });
      context.onProgress({ phase: "rendering", completed: 30, total: 120 });
      context.onProgress({ phase: "saving", completed: 0, total: 1, message: "a.mp4" });
      return { ok: true, value: { files: [], warnings: [], notice: NOTICE } };
    },
  });
  const seen: any[] = [];
  await client.callTool({ name: "render", arguments: { plan: PLAN } }, undefined, { onprogress: (p) => seen.push(p) });
  const request = received.find((m: any) => m.method === "tools/call") as any;
  const token = request.params._meta.progressToken;
  assert.notEqual(token, undefined);
  const progress = sent.filter((m: any) => m.method === "notifications/progress") as any[];
  assert.equal(progress.length, 3);
  for (const p of progress) assert.equal(p.params.progressToken, token);
  // Strictly increasing, as the protocol requires, with a message for each.
  const values = progress.map((p) => p.params.progress);
  for (let i = 1; i < values.length; i++) assert.ok(values[i] > values[i - 1], `progress ${values}`);
  assert.match(progress[1].params.message, /rendering/);
  assert.match(progress[1].params.message, /30\/120/);
  assert.equal(seen.length, 3);
});

test("no progress notifications without a token", async (t) => {
  const { client, sent } = await start(t, {
    renderOnce: async (_request, context) => {
      context.onProgress({ phase: "starting", completed: 0, total: 1 });
      return { ok: true, value: { files: [], warnings: [], notice: NOTICE } };
    },
  });
  await client.callTool({ name: "render", arguments: { plan: PLAN } });
  assert.equal(sent.filter((m: any) => m.method === "notifications/progress").length, 0);
});

test("no catalog: the server starts with the fallback, and list_scenes says the site is unreachable", async (t) => {
  const { client } = await start(t, { fetch: failingFetch });
  assert.equal(client.getInstructions(), FALLBACK_BRIEFING);
  assert.match(FALLBACK_BRIEFING, /evaluation only/);
  assert.match(FALLBACK_BRIEFING, /Pro/);
  for (const [name, args] of [
    ["list_scenes", {}],
    ["recording_spec", { device: "iPhone" }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    const [problem] = structured(result).problems;
    assert.equal(problem.code, "site");
    assert.match(problem.fix, /try again/i);
  }
  // A render does not need the catalog.
  const render = await client.callTool({ name: "render", arguments: { plan: PLAN } });
  assert.notEqual(render.isError, true);
});

test("a dev server's SPA page is not a catalog", async (t) => {
  const html = catalogFetch(() => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } }));
  const { client } = await start(t, { fetch: html.fn });
  assert.equal(client.getInstructions(), FALLBACK_BRIEFING);
  const result = await client.callTool({ name: "list_scenes", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(structured(result).problems[0].code, "site");
  assert.match(structured(result).problems[0].message, /not JSON|text\/html/);
  assert.equal(html.calls[0], "http://127.0.0.1:4173/agent/catalog.json");
});

test("a failed catalog is fetched again on the next call, and a good one is kept", async (t) => {
  let answer: () => Response = () => new Response("nope", { status: 503, headers: { "content-type": "text/plain" } });
  const served = catalogFetch(() => answer());
  const { client } = await start(t, { fetch: served.fn });
  assert.equal(served.calls.length, 1);
  const first = await client.callTool({ name: "list_scenes", arguments: {} });
  assert.equal(first.isError, true);
  assert.match(structured(first).problems[0].message, /503/);
  assert.equal(served.calls.length, 2);
  answer = () => jsonResponse(CATALOG);
  const second = await client.callTool({ name: "list_scenes", arguments: {} });
  assert.notEqual(second.isError, true);
  assert.equal(structured(second).scenes.length, 3);
  assert.equal(served.calls.length, 3);
  await client.callTool({ name: "list_scenes", arguments: {} });
  await client.callTool({ name: "recording_spec", arguments: { device: "iPhone" } });
  assert.equal(served.calls.length, 3);
});

test("checkCatalog refuses a wrong shape", () => {
  assert.equal(typeof checkCatalog(CATALOG), "object");
  assert.equal(typeof checkCatalog({ ...CATALOG, contract: 2 }), "string");
  assert.equal(typeof checkCatalog({ ...CATALOG, briefing: 3 }), "string");
  assert.equal(typeof checkCatalog({ ...CATALOG, scenes: [{ id: "x" }] }), "string");
  assert.equal(typeof checkCatalog({ ...CATALOG, devices: [{ device: "iPhone", fps: 30, screen: {}, tips: [] }] }), "string");
  assert.equal(typeof checkCatalog({ ...CATALOG, rules: { ...CATALOG.rules, imageTypes: undefined } }), "string");
  assert.equal(typeof checkCatalog([]), "string");
  assert.equal(typeof checkCatalog(null), "string");
});

test("a catalog with the wrong contract is a site problem", async (t) => {
  const { client } = await start(t, { fetch: catalogFetch(() => jsonResponse({ ...CATALOG, contract: 2 })).fn });
  assert.equal(client.getInstructions(), FALLBACK_BRIEFING);
  const result = await client.callTool({ name: "list_scenes", arguments: {} });
  assert.equal(structured(result).problems[0].code, "site");
});

test("settings: timeout minutes and chrome mode, read strictly", () => {
  const ok = (env: NodeJS.ProcessEnv) => {
    const s = settingsFromEnv(env);
    assert.ok(s.ok, JSON.stringify(s));
    return s.value;
  };
  assert.deepEqual(ok({}), { timeoutMs: 20 * 60_000, chromeMode: "headless", warnings: [] });
  assert.equal(ok({ MOTIONMOCKUPS_TIMEOUT_MINUTES: "45" }).timeoutMs, 45 * 60_000);
  assert.equal(ok({ MOTIONMOCKUPS_TIMEOUT_MINUTES: " 2.5 " }).timeoutMs, 150_000);
  assert.equal(ok({ MOTIONMOCKUPS_TIMEOUT_MINUTES: "1" }).timeoutMs, 60_000);
  // Below a minute: a tiny value would round to 0 ms, which renderOnce reads as no limit.
  for (const bad of ["0", "-3", "abc", "10m", "Infinity", "NaN", "1e3x", "0x10", "0.000001", "0.0000083", "0.5", "0.99"]) {
    const s = ok({ MOTIONMOCKUPS_TIMEOUT_MINUTES: bad });
    assert.equal(s.timeoutMs, 20 * 60_000, bad);
    assert.equal(s.warnings.length, 1, bad);
    assert.match(s.warnings[0]!, /MOTIONMOCKUPS_TIMEOUT_MINUTES/);
  }
  assert.equal(ok({ MOTIONMOCKUPS_TIMEOUT_MINUTES: "" }).warnings.length, 0);
  assert.equal(ok({ MOTIONMOCKUPS_CHROME_MODE: "window" }).chromeMode, "window");
  assert.equal(ok({ MOTIONMOCKUPS_CHROME_MODE: " Headless " }).chromeMode, "headless");
  const bad = settingsFromEnv({ MOTIONMOCKUPS_CHROME_MODE: "kiosk" });
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.problems[0]!.code === "chrome-mode");
});

test("the command refuses to start on a bad MOTIONMOCKUPS_ORIGIN, saying why on stderr", () => {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", path.join(ROOT, "src", "cli.ts"), "mcp"], {
    env: { ...process.env, MOTIONMOCKUPS_ORIGIN: "https://example.com" },
    input: "",
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.notEqual(run.status, 0);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /MOTIONMOCKUPS_ORIGIN/);
  assert.match(run.stderr, /not the Motion Mockups site/);
  assert.match(run.stderr, /Remove MOTIONMOCKUPS_ORIGIN/);
});

test("the command refuses to start on a relative MOTIONMOCKUPS_DATA, saying why on stderr", () => {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", path.join(ROOT, "src", "cli.ts"), "mcp"], {
    env: { ...process.env, MOTIONMOCKUPS_DATA: "relative-data" },
    input: "",
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.notEqual(run.status, 0);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /MOTIONMOCKUPS_DATA/);
  assert.match(run.stderr, /absolute/);
});

test("an unknown tool names the tools there are; other SDK errors are the adapter's", async (t) => {
  const { client } = await start(t);
  const result = await client.callTool({ name: "make_video", arguments: {} });
  assert.equal(result.isError, true);
  const [problem] = structured(result).problems;
  assert.equal(problem.code, "tool");
  assert.match(problem.message, /make_video/);
  assert.equal(problem.fix, "Use one of: list_scenes, recording_spec, render, still, account, connect_account.");

  assert.equal(sdkProblem("MCP error -32602: Tool render disabled").code, "tool");
  assert.equal(sdkProblem("MCP error -32602: Input validation error: Invalid arguments for tool render: x").code, "input");
  assert.equal(
    sdkProblem("MCP error -32602: Invalid arguments for tool render: arguments contain more than the maximum of 10 elements").code,
    "input",
  );
  const other = sdkProblem("Cannot read properties of undefined");
  assert.equal(other.code, "adapter");
  assert.match(other.message, /Cannot read properties/);
  assert.doesNotMatch(other.fix, /schema/);
});

test("the command shuts down cleanly when the client stops reading stdout", async () => {
  // A closed port: the catalog fails fast and the server starts with the fallback.
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", path.join(ROOT, "src", "cli.ts"), "mcp"], {
    env: { ...process.env, MOTIONMOCKUPS_ORIGIN: "http://127.0.0.1:9" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
  // The first answer arrives, then the client's end of stdout goes away.
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  child.stdout.destroy();
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  // Each answer now writes into a closed pipe.
  for (let id = 2; id < 40; id++) send({ jsonrpc: "2.0", id, method: "tools/list" });
  const timer = setTimeout(() => child.kill(), 15_000);
  const code = await exited;
  clearTimeout(timer);
  child.stdin.destroy();
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /Unhandled|EPIPE|Error:/);
});

test("the command prints usage for anything but mcp and --version", () => {
  const cli = path.join(ROOT, "src", "cli.ts");
  const version = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), "dev");
  const other = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "serve"], { encoding: "utf8" });
  assert.equal(other.status, 1);
  assert.match(other.stderr, /Usage: motionmockups mcp/);
  const help = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stderr, /Usage: motionmockups mcp/);
});

// ---- connect_account and account, against a stand-in site on loopback ----

async function onSite(t: TestContext, site: SiteOptions = {}, options: Parameters<typeof start>[1] = {}) {
  const fake = await agentSite(t, { catalog: CATALOG, ...site });
  const data = options.data ?? temp(t, "mm-server-data-");
  const logged: string[] = [];
  const started = await start(t, { fetch: globalThis.fetch, origin: fake.origin, data, log: (l) => logged.push(l), ...options });
  return { ...started, site: fake, data, logged };
}

const PRO_ACCOUNT = { signedIn: true, tier: "pro", label: "Agent on 20 November 2026" };

test("connect_account gives the link and code at once; wait returns once approved, and account says Pro", async (t) => {
  const { client, site, data } = await onSite(t, { polls: [pending, pending, approved()], status: statusFor(true) });
  const begun = await client.callTool({ name: "connect_account", arguments: {} });
  assert.notEqual(begun.isError, true, JSON.stringify(structured(begun)));
  const first = structured(begun);
  assert.equal(first.userCode, USER_CODE);
  assert.equal(first.url, `${site.origin.origin}/connect?code=${USER_CODE}`);
  assert.equal(first.waiting, true);
  assert.equal(first.opened, undefined, "no browser unless asked");
  assert.match(first.note, /Render with your Pro plates\. It cannot change your account, billing, projects or saved recordings\./);
  assert.match(first.note, /wait: true/);
  assert.equal(fs.existsSync(path.join(data, TOKEN_FILE)), false, "nothing saved before approval");

  const waited = await client.callTool({ name: "connect_account", arguments: { wait: true } });
  assert.notEqual(waited.isError, true, JSON.stringify(structured(waited)));
  assert.deepEqual({ ...structured(waited), note: undefined }, { connected: true, ...PRO_ACCOUNT, note: undefined });
  assert.ok(fs.existsSync(path.join(data, TOKEN_FILE)));

  const account = structured(await client.callTool({ name: "account", arguments: {} }));
  assert.deepEqual({ ...account, note: undefined }, { ...PRO_ACCOUNT, note: undefined });
  assert.match(account.note, /clean/);
  // A second connect while connected says so, and starts nothing.
  const again = structured(await client.callTool({ name: "connect_account", arguments: {} }));
  assert.equal(again.connected, true);
  assert.match(again.note, /disconnect: true/);
  assert.equal(site.seen.filter((s) => s.path === "/api/agent/connect/start").length, 1);
});

test("connect_account with open: true opens the link once, with fixed arguments", async (t) => {
  const runs: { command: string; args: string[] }[] = [];
  const { client, site } = await onSite(t, {}, { openBrowser: (command, args) => runs.push({ command, args }) });
  const result = structured(await client.callTool({ name: "connect_account", arguments: { open: true } }));
  assert.equal(result.opened, true);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.args.at(-1), `${site.origin.origin}/connect?code=${USER_CODE}`);
});

test("connect_account: a second wait at the same time is refused as busy; a second start gives the same code", async (t) => {
  const { client, site } = await onSite(t, { polls: [pending, pending, pending, pending, approved()] });
  const a = structured(await client.callTool({ name: "connect_account", arguments: {} }));
  const b = structured(await client.callTool({ name: "connect_account", arguments: {} }));
  assert.equal(a.userCode, b.userCode);
  assert.equal(site.seen.filter((s) => s.path === "/api/agent/connect/start").length, 1);
  const first = client.callTool({ name: "connect_account", arguments: { wait: true } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await client.callTool({ name: "connect_account", arguments: { wait: true } });
  assert.equal(second.isError, true);
  assert.equal(structured(second).problems[0].code, "busy");
  assert.notEqual((await first).isError, true);
});

test("connect_account: a declined sign-in is a sign-in refusal naming connect_account", async (t) => {
  const { client, data } = await onSite(t, { polls: [pending, denied] });
  await client.callTool({ name: "connect_account", arguments: {} });
  const result = await client.callTool({ name: "connect_account", arguments: { wait: true } });
  assert.equal(result.isError, true);
  assert.equal(structured(result).problems[0].code, "sign-in");
  assert.match(structured(result).problems[0].fix, /connect_account/);
  assert.equal(fs.existsSync(path.join(data, TOKEN_FILE)), false);
});

test("connect_account: a cancelled wait (a client's request timeout) leaves the sign-in polling; disconnect ends it", async (t) => {
  const { client, site, data } = await onSite(t, { polls: [pending] });
  await client.callTool({ name: "connect_account", arguments: {} });
  const controller = new AbortController();
  const waiting = client.callTool({ name: "connect_account", arguments: { wait: true } }, undefined, { signal: controller.signal });
  waiting.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 60));
  controller.abort("the client's request timed out");
  await assert.rejects(waiting);
  // Still polled: the person can approve after the client gave up waiting.
  const polls = site.polls().length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(site.polls().length > polls, "polling goes on after the cancel");
  // The same code is still the one to approve.
  const again = structured(await client.callTool({ name: "connect_account", arguments: {} }));
  assert.equal(again.userCode, USER_CODE);
  assert.equal(site.seen.filter((s) => s.path === "/api/agent/connect/start").length, 1);
  // Disconnect ends it.
  await client.callTool({ name: "connect_account", arguments: { disconnect: true } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const stopped = site.polls().length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(site.polls().length, stopped, "no poll after disconnect");
  const after = await client.callTool({ name: "connect_account", arguments: { wait: true } });
  assert.equal(after.isError, true);
  assert.match(structured(after).problems[0].message, /No sign-in is waiting/);
  assert.equal(fs.existsSync(path.join(data, TOKEN_FILE)), false);
});

test("connect_account: after a cancelled wait, a later approval is saved and a new wait reports it", async (t) => {
  const { client, data } = await onSite(t, { polls: [pending, pending, pending, pending, pending, pending, approved()], status: statusFor(true) });
  await client.callTool({ name: "connect_account", arguments: {} });
  const controller = new AbortController();
  const waiting = client.callTool({ name: "connect_account", arguments: { wait: true } }, undefined, { signal: controller.signal });
  waiting.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();
  await assert.rejects(waiting);
  const waited = await client.callTool({ name: "connect_account", arguments: { wait: true } });
  assert.notEqual(waited.isError, true, JSON.stringify(structured(waited)));
  assert.equal(structured(waited).tier, "pro");
  assert.ok(fs.existsSync(path.join(data, TOKEN_FILE)));
});

test("connect_account: wait reports progress with the code, and stopping the server ends the sign-in", async (t) => {
  const { client, site, stop } = await onSite(t, { polls: [pending] });
  await client.callTool({ name: "connect_account", arguments: {} });
  const seen: any[] = [];
  const waiting = client.callTool({ name: "connect_account", arguments: { wait: true } }, undefined, { onprogress: (p) => seen.push(p) });
  waiting.catch(() => {});
  for (let i = 0; i < 100 && seen.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(seen.length >= 3, `${seen.length} progress reports`);
  assert.ok(seen.every((p) => p.message.includes(USER_CODE)));
  await stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const polls = site.polls().length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(site.polls().length, polls);
});

test("connect_account disconnect revokes the token on the site, then deletes the saved file", async (t) => {
  const { client, site, data } = await onSite(t);
  await writeToken(data, site.origin, TOKEN);
  const result = structured(await client.callTool({ name: "connect_account", arguments: { disconnect: true } }));
  assert.equal(result.removed, true);
  assert.equal(result.revoked, true);
  assert.equal(result.tier, "free");
  assert.match(result.note, /revoked/);
  const sent = site.seen.filter((s) => s.path === "/api/agent/disconnect");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.method, "POST");
  assert.equal(sent[0]!.authorization, `Bearer ${TOKEN}`);
  assert.equal(fs.existsSync(path.join(data, TOKEN_FILE)), false);
  assert.doesNotMatch(JSON.stringify(result), /mma_/);
  const none = structured(await client.callTool({ name: "connect_account", arguments: { disconnect: true } }));
  assert.equal(none.removed, false);
  assert.equal(none.revoked, false);
  assert.equal(site.seen.filter((s) => s.path === "/api/agent/disconnect").length, 1, "nothing to send without a token");
  const mixed = await client.callTool({ name: "connect_account", arguments: { disconnect: true, wait: true } });
  assert.equal(mixed.isError, true);
  assert.equal(structured(mixed).problems[0].code, "input");
  const unknown = await client.callTool({ name: "connect_account", arguments: { token: TOKEN } });
  assert.equal(unknown.isError, true);
});

test("account: the site's 401 deletes the saved token and says to connect again", async (t) => {
  const { client, site, data } = await onSite(t, {
    status: () => ({ status: 401, body: { error: "This agent is no longer connected. Connect it again." } }),
  });
  await writeToken(data, site.origin, TOKEN);
  const result = await client.callTool({ name: "account", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(structured(result).problems[0].code, "sign-in");
  assert.match(structured(result).problems[0].fix, /connect_account/);
  assert.equal(fs.existsSync(path.join(data, TOKEN_FILE)), false);
  // Signed out from then on.
  assert.equal(structured(await client.callTool({ name: "account", arguments: {} })).signedIn, false);
});

test("account: a damaged token file or one for another origin is refused, and nothing is sent", async (t) => {
  const { client, site, data } = await onSite(t);
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, TOKEN_FILE), "{ damaged");
  const damaged = await client.callTool({ name: "account", arguments: {} });
  assert.equal(damaged.isError, true);
  assert.equal(structured(damaged).problems[0].code, "sign-in");
  assert.match(structured(damaged).problems[0].fix, /connect_account/);
  await writeToken(data, new URL("https://motionmockups.com"), TOKEN);
  const other = await client.callTool({ name: "account", arguments: {} });
  assert.equal(other.isError, true);
  assert.match(structured(other).problems[0].message, /https:\/\/motionmockups\.com/);
  // A render refuses too, rather than sending it elsewhere or quietly rendering free.
  const project = temp(t, "mm-proj-");
  const { client: renderer, calls, data: renderData, site: renderSite } = await onSite(t, {}, { env: { MOTIONMOCKUPS_FOLDERS: project } });
  await writeToken(renderData, new URL("https://motionmockups.com"), TOKEN);
  const render = await renderer.callTool({ name: "render", arguments: { plan: PLAN } });
  assert.equal(render.isError, true);
  assert.equal(structured(render).problems[0].code, "sign-in");
  assert.equal(calls.length, 0);
  for (const s of [site, renderSite]) assert.equal(s.seen.filter((x) => x.path.startsWith("/api/")).length, 0, "the token went nowhere");
});

test("render picks the tier by the account's status, once per render", async (t) => {
  const project = temp(t, "mm-proj-");
  const env = { MOTIONMOCKUPS_FOLDERS: project };
  {
    // No saved token: free, and the site is not asked.
    const { client, calls, site } = await onSite(t, {}, { env });
    assert.notEqual((await client.callTool({ name: "render", arguments: { plan: PLAN } })).isError, true);
    assert.equal(calls[0]!.context.pro, undefined);
    assert.equal(site.seen.filter((s) => s.path === "/api/agent/status").length, 0);
  }
  {
    // Pro: the token goes to the session.
    const { client, calls, site, data } = await onSite(t, { status: statusFor(true) }, { env });
    await writeToken(data, site.origin, TOKEN);
    assert.notEqual((await client.callTool({ name: "still", arguments: { plan: PLAN, seconds: 1, format: "png" } })).isError, true);
    assert.deepEqual(calls[0]!.context.pro, { accessToken: TOKEN });
    assert.equal(site.seen.filter((s) => s.path === "/api/agent/status").length, 1);
  }
  {
    // Connected without Pro: free.
    const { client, calls, site, data } = await onSite(t, { status: statusFor(false) }, { env });
    await writeToken(data, site.origin, TOKEN);
    assert.notEqual((await client.callTool({ name: "render", arguments: { plan: PLAN } })).isError, true);
    assert.equal(calls[0]!.context.pro, undefined);
  }
  {
    // The site cannot say: refused, nothing rendered, the token kept.
    const { client, calls, site, data } = await onSite(t, { status: () => unavailable }, { env });
    await writeToken(data, site.origin, TOKEN);
    const result = await client.callTool({ name: "render", arguments: { plan: PLAN } });
    assert.equal(result.isError, true);
    assert.equal(structured(result).problems[0].code, "site");
    assert.equal(calls.length, 0);
    assert.ok(fs.existsSync(path.join(data, TOKEN_FILE)));
  }
});

test("a Pro render refused with sign-in while a new connection was saved keeps the new connection", async (t) => {
  const project = temp(t, "mm-proj-");
  const next = `mma_${"n".repeat(43)}`;
  let data = "";
  let origin: URL | undefined;
  const fixture = await onSite(
    t,
    { status: statusFor(true) },
    {
      env: { MOTIONMOCKUPS_FOLDERS: project },
      renderOnce: async () => {
        // The person connected again while this render ran with the old token.
        await writeToken(data, origin!, next);
        return {
          ok: false,
          problems: [{ code: "sign-in", message: "This agent is no longer connected. Connect it again.", fix: "Connect the account again.", source: "site" }],
        };
      },
    },
  );
  data = fixture.data;
  origin = fixture.site.origin;
  await writeToken(data, origin, TOKEN);
  const result = await fixture.client.callTool({ name: "render", arguments: { plan: PLAN } });
  assert.equal(result.isError, true);
  assert.equal(structured(result).problems[0].code, "sign-in");
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, TOKEN_FILE), "utf8")).token, next, "the new connection stays");
});

test("a Pro render the page refuses with pro says how renders go on, with no tier the agent cannot set", async (t) => {
  const project = temp(t, "mm-proj-");
  const { client, site, data } = await onSite(
    t,
    { status: statusFor(true) },
    {
      env: { MOTIONMOCKUPS_FOLDERS: project },
      renderOnce: async () => ({
        ok: false,
        problems: [{ code: "pro", message: "Pro has ended for this account.", fix: 'Subscribe to Pro, or set tier to "free" for a watermarked preview.', source: "site" }],
      }),
    },
  );
  await writeToken(data, site.origin, TOKEN);
  const result = await client.callTool({ name: "render", arguments: { plan: PLAN } });
  assert.equal(result.isError, true);
  const [problem] = structured(result).problems;
  assert.equal(problem.code, "pro");
  assert.doesNotMatch(problem.fix, /tier/);
  assert.match(problem.fix, /pricing/);
  assert.match(problem.fix, /free watermarked preview/);
  assert.ok(fs.existsSync(path.join(data, TOKEN_FILE)), "the connection stays");
});

test("a Pro render the page refuses with sign-in deletes the saved token and names connect_account", async (t) => {
  const project = temp(t, "mm-proj-");
  const { client, site, data } = await onSite(
    t,
    { status: statusFor(true) },
    {
      env: { MOTIONMOCKUPS_FOLDERS: project },
      renderOnce: async () => ({
        ok: false,
        problems: [{ code: "sign-in", message: "This agent is no longer connected. Connect it again.", fix: "Connect the account again.", source: "site" }],
      }),
    },
  );
  await writeToken(data, site.origin, TOKEN);
  const result = await client.callTool({ name: "render", arguments: { plan: PLAN } });
  assert.equal(result.isError, true);
  const [problem] = structured(result).problems;
  assert.equal(problem.code, "sign-in");
  assert.match(problem.fix, /connect_account/);
  assert.equal(fs.existsSync(path.join(data, TOKEN_FILE)), false);
});

test("the token never appears in a tool result, a progress report, an error or stderr", async (t) => {
  const project = temp(t, "mm-proj-");
  const { client, sent, logged, data, site } = await onSite(
    t,
    { polls: [pending, approved()], status: statusFor(true) },
    {
      env: { MOTIONMOCKUPS_FOLDERS: project },
      // A session that misbehaves: the token in its progress, its problem and a thrown error.
      renderOnce: async (request, context) => {
        const token = context.pro?.accessToken ?? "";
        context.onProgress({ phase: "rendering", completed: 1, total: 2, message: `with ${token}` });
        if (request.still) throw new Error(`thrown with ${token}`);
        return { ok: false, problems: [{ code: "render", message: `failed with ${token}`, fix: `fix ${token}` }] };
      },
    },
  );
  await client.callTool({ name: "connect_account", arguments: {} });
  await client.callTool({ name: "connect_account", arguments: { wait: true } }, undefined, { onprogress: () => {} });
  assert.ok(fs.existsSync(path.join(data, TOKEN_FILE)), "connected");
  await client.callTool({ name: "account", arguments: {} });
  await client.callTool({ name: "render", arguments: { plan: PLAN } }, undefined, { onprogress: () => {} });
  await client.callTool({ name: "still", arguments: { plan: PLAN, seconds: 1, format: "png" } });
  await client.callTool({ name: "connect_account", arguments: {} });
  // The token was used: the status was asked with it.
  assert.ok(site.seen.some((s) => s.authorization === `Bearer ${TOKEN}`));
  const everything = JSON.stringify(sent) + logged.join("\n");
  assert.ok(sent.length > 6);
  assert.ok(everything.includes("[agent token]"), "the misbehaving session's text was redacted");
  assert.ok(!everything.includes(TOKEN), "the token is nowhere in what the server sent or logged");
  assert.ok(!everything.includes(TOKEN.slice(4)), "nor its body");
  assert.ok(!/mmd_/.test(everything), "nor the device code");
});

test("connect_account disconnect: a network failure still deletes the file and says to revoke it in the account", async (t) => {
  const { client, site, data } = await onSite(t, { disconnect: () => ({ status: 0, body: null, cut: true }) });
  await writeToken(data, site.origin, TOKEN);
  const call = await client.callTool({ name: "connect_account", arguments: { disconnect: true } });
  assert.notEqual(call.isError, true);
  const result = structured(call);
  assert.equal(result.removed, true);
  assert.equal(result.revoked, false);
  assert.match(result.note, /did not confirm/);
  assert.match(result.note, /Connected agents/);
  assert.match(result.note, /Revoke/);
  assert.equal(site.seen.filter((s) => s.path === "/api/agent/disconnect").length, 1);
  assert.equal(fs.existsSync(path.join(data, TOKEN_FILE)), false);
  assert.doesNotMatch(JSON.stringify(result), /mma_/);
});
