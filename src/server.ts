// The MCP server: five tools over the site's catalog and one render at a time in the
// person's Chrome. Every refusal is a tool result with `isError: true` and `{ problems }`,
// never a thrown error, so the agent always gets a `fix` to act on.
//
// Tool inputs are strict: an object with a field the tool does not document is refused
// before anything runs, so nothing an agent sends reaches the adapter's internals. The
// plan is typed for the agent but passed to the page unchanged; the page enforces its rules.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  RootsListChangedNotificationSchema,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { catalogSource, CATALOG_TIMEOUT_MS, FALLBACK_BRIEFING, type AgentCatalog } from "./catalog.ts";
import { allowedFolders, type Checked, type Problem } from "./folders.ts";
import type { Progress, Rendered, RenderRequest, SessionContext } from "./session.ts";

export type ChromeMode = SessionContext["chromeMode"];

/** Chrome without a window. Task 7 of the adapter plan measures whether `window` is needed. */
export const DEFAULT_CHROME_MODE: ChromeMode = "headless";
export const DEFAULT_TIMEOUT_MINUTES = 20;
/** The shortest render timeout accepted from the setting. */
const MIN_TIMEOUT_MS = 60_000;
/** For the client's answer to `roots/list`. */
const ROOTS_MS = 10_000;
/** How long `stop()` waits for running renders to close Chrome and release the lock. */
const STOP_MS = 30_000;

export interface ServerDeps {
  origin: URL;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  renderOnce: (request: RenderRequest, context: SessionContext) => Promise<Rendered>;
  data: string;
  chromeMode: ChromeMode;
  timeoutMs: number;
  version: string;
  /** One line for stderr; stdout carries only the protocol. */
  log: (line: string) => void;
}

/** `MOTIONMOCKUPS_TIMEOUT_MINUTES` and `MOTIONMOCKUPS_CHROME_MODE`, read strictly. */
export function settingsFromEnv(env: NodeJS.ProcessEnv): Checked<{ timeoutMs: number; chromeMode: ChromeMode; warnings: string[] }> {
  const warnings: string[] = [];
  let timeoutMs = DEFAULT_TIMEOUT_MINUTES * 60_000;
  const rawTimeout = env.MOTIONMOCKUPS_TIMEOUT_MINUTES?.trim();
  if (rawTimeout) {
    // Digits with an optional fraction only: no signs, exponents, hex or words. Checked as
    // milliseconds, at least one minute: renderOnce reads 0 as no limit, and a tiny value
    // would round to it.
    const ms = /^\d+(?:\.\d+)?$/.test(rawTimeout) ? Math.round(Number(rawTimeout) * 60_000) : NaN;
    if (Number.isFinite(ms) && ms >= MIN_TIMEOUT_MS) timeoutMs = ms;
    else
      warnings.push(
        `MOTIONMOCKUPS_TIMEOUT_MINUTES is "${rawTimeout}", which is not a number of minutes, 1 or more; renders stop after ${DEFAULT_TIMEOUT_MINUTES} minutes.`,
      );
  }
  const rawMode = env.MOTIONMOCKUPS_CHROME_MODE?.trim().toLowerCase();
  let chromeMode = DEFAULT_CHROME_MODE;
  if (rawMode) {
    if (rawMode !== "headless" && rawMode !== "window")
      return {
        ok: false,
        problems: [
          {
            code: "chrome-mode",
            message: `MOTIONMOCKUPS_CHROME_MODE is "${env.MOTIONMOCKUPS_CHROME_MODE}", which is not headless or window.`,
            fix: "Set MOTIONMOCKUPS_CHROME_MODE to headless or window in this MCP server's settings, or remove it.",
          },
        ],
      };
    chromeMode = rawMode;
  }
  return { ok: true, value: { timeoutMs, chromeMode, warnings } };
}

// ---- Tool inputs ----

const crop = z
  .object({
    x: z.number().optional().describe("Horizontal position of the crop, 0 (left) to 1 (right)."),
    y: z.number().optional().describe("Vertical position of the crop, 0 (top) to 1 (bottom)."),
    zoom: z.number().optional().describe("1 (the whole scene) to 3."),
  })
  .strict();

const clip = z
  .object({
    scene: z.string().min(1).describe("A scene id from list_scenes, of the plan's device."),
    seconds: z.number().optional().describe("How long the clip runs in the finished film. Without it, the scene's own length."),
    reversed: z.boolean().optional().describe("Play the scene's camera move backwards."),
    crop: crop.optional().describe("Frame part of the scene."),
  })
  .strict();

const plan = z
  .object({
    contract: z.literal(1).describe("Always 1."),
    device: z.string().min(1).describe("One device from the catalog (Display, iPhone, MacBook, iPad or TV). Every clip is a scene of it."),
    clips: z.array(clip).min(1).describe("The scenes in order. One clip is one scene."),
    aspect: z.string().min(1).describe('The frame: "1:1", "4:3", "16:9", "4:5" or "9:16".'),
    size: z.number().optional().describe("Short edge in pixels with Pro: 1080 or 2160. Free previews are smaller."),
    delivery: z.enum(["film", "scenes"]).optional().describe('"film" (default) joins the clips into one video; "scenes" gives one video per clip.'),
    speedRamp: z.union([z.literal("off"), z.literal(50), z.literal(100)]).optional().describe('Ease into and out of each move: "off", 50 or 100.'),
    reflections: z.union([z.literal(0), z.literal(50), z.literal(100)]).optional().describe("Screen reflections: 0, 50 or 100."),
    hideNotch: z.boolean().optional().describe("Remove the notch from iPhone and MacBook scenes."),
    keepStatusBar: z.boolean().optional().describe("Keep the recording's own iOS status bar instead of the cleaned one."),
    background: z
      .object({
        top: z.string().describe("#rrggbb"),
        bottom: z.string().describe("#rrggbb"),
      })
      .strict()
      .optional()
      .describe("The backdrop gradient, for scenes that have one."),
  })
  .strict()
  .describe("What to render. The site checks it and refuses with a fix when something does not fit.");

const recording = z
  .string()
  .min(1)
  .describe(
    "Path of the screen recording (MP4, MOV, WebM) or screenshot (PNG, JPEG, WebP, AVIF), inside the project folder. Without one, the screen shows a placeholder.",
  );
const name = z.string().min(1).describe("File name for the result, without extension.");

const listScenesInput = z
  .object({
    device: z.string().optional().describe("Only this device's scenes."),
    collection: z.string().optional().describe("Only this collection's scenes, such as Gallery or Loft."),
  })
  .strict();
const recordingSpecInput = z.object({ device: z.string().min(1).describe("The device to record for.") }).strict();
const renderInput = z.object({ plan, recording: recording.optional(), name: name.optional() }).strict();
const stillInput = z
  .object({
    plan,
    recording: recording.optional(),
    name: name.optional(),
    seconds: z.number().describe("The moment to show, as seconds from the film's start."),
    format: z.enum(["png", "jpeg"]).describe("png or jpeg."),
  })
  .strict();
const accountInput = z.object({}).strict();

// ---- Results ----

const answer = (value: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

const refused = (problems: Problem[], saved?: { path: string; bytes: number }[]): CallToolResult => {
  const value: Record<string, unknown> = saved?.length ? { problems, saved } : { problems };
  return { ...answer(value), isError: true };
};

const unexpected = (error: unknown): Problem => ({
  code: "adapter",
  message: `The adapter stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
  fix: "Try again. If it keeps failing, report it at https://motionmockups.com/contact.",
});

export const TOOL_NAMES = ["list_scenes", "recording_spec", "render", "still", "account"] as const;

/** An error the SDK gives as a tool result, as a problem with a way out. */
export function sdkProblem(message: string): Problem {
  // The SDK's own wording (mcp.js validateToolInput and the tools/call handler), after the
  // "MCP error -32602: " an McpError puts in front.
  if (/(?:Input validation error|Invalid arguments for tool) /.test(message))
    return { code: "input", message, fix: "Send the fields as the tool's input schema gives them, and no others." };
  const tool = /Tool (\S+) (?:not found|disabled)$/.exec(message);
  if (tool) return { code: "tool", message: `There is no tool ${tool[1]}.`, fix: `Use one of: ${TOOL_NAMES.join(", ")}.` };
  return unexpected(message);
}

const ACCOUNT_NOTE =
  "Not signed in. Renders are free watermarked previews, for evaluation only. Signing in for clean output with Motion Mockups Pro is coming to this adapter.";

/** A progress report as one line for the client. */
function progressText(p: Progress): string {
  const count = p.total > 0 ? ` ${p.completed}/${p.total}` : "";
  return `${p.phase}${count}${p.message ? `: ${p.message}` : ""}`;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface AdapterServer {
  server: McpServer;
  /** Cancels running renders and waits for them to clean up, then closes the server. */
  stop(): Promise<void>;
}

/** The server with its instructions from the catalog (fetched first, within 5 s). */
export async function createServer(deps: ServerDeps): Promise<AdapterServer> {
  const catalog = catalogSource(deps.origin, deps.fetch, CATALOG_TIMEOUT_MS);
  const first = await catalog.get();
  if (!first.ok) deps.log(`motionmockups: ${first.problems[0]!.message} Starting with the built-in briefing.`);
  const instructions = first.ok ? first.value.briefing : FALLBACK_BRIEFING;

  const server = new McpServer({ name: "motionmockups", version: deps.version }, { instructions, capabilities: { tools: {} } });
  // The SDK answers an input its schema refuses, an unknown tool or a handler's throw with a
  // text-only error result. This gives each the adapter's shape, so every refusal carries
  // { problems }. The hook is private in the SDK's types; the SDK is pinned and bundled, and
  // the tests check it.
  (server as unknown as { createToolError: (message: string) => CallToolResult }).createToolError = (message) =>
    refused([sdkProblem(message)]);

  // ---- Allowed folders: the client's roots, read again when they change, plus the setting ----
  let roots: Promise<string[]> | undefined;
  const clientHasRoots = () => !!server.server.getClientCapabilities()?.roots;
  const readRoots = () => {
    const reading: Promise<string[]> = server.server
      .listRoots(undefined, { timeout: ROOTS_MS })
      .then((r) => r.roots.map((root) => root.uri))
      .catch((error) => {
        deps.log(`motionmockups: the client's roots could not be read (${(error as Error)?.message ?? error}).`);
        // Asked again on the next render.
        if (roots === reading) roots = undefined;
        return [];
      });
    roots = reading;
  };
  server.server.oninitialized = () => {
    if (clientHasRoots()) readRoots();
  };
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    if (clientHasRoots()) readRoots();
  });
  const allowed = async () => {
    let declared: string[] = [];
    if (clientHasRoots()) {
      if (!roots) readRoots();
      declared = await roots!;
    }
    return allowedFolders(declared, deps.env);
  };

  // ---- Renders, each cancelled by its request or by stop() ----
  const running = new Set<{ controller: AbortController; done: Promise<unknown> }>();
  let stopping = false;

  const render = async (request: RenderRequest, extra: Extra): Promise<CallToolResult> => {
    const controller = new AbortController();
    const onAbort = () => controller.abort(extra.signal.reason);
    if (extra.signal.aborted || stopping) controller.abort(extra.signal.reason);
    else extra.signal.addEventListener("abort", onAbort, { once: true });
    const work = (async (): Promise<CallToolResult> => {
      const token = extra._meta?.progressToken;
      let step = 0;
      const onProgress = (p: Progress) => {
        if (token === undefined) return;
        step += 1;
        extra
          .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: step, message: progressText(p) } })
          .catch(() => {});
      };
      let result: Rendered;
      try {
        result = await deps.renderOnce(request, {
          origin: deps.origin,
          allowed: await allowed(),
          data: deps.data,
          chromeMode: deps.chromeMode,
          signal: controller.signal,
          timeoutMs: deps.timeoutMs,
          onProgress,
        });
      } catch (error) {
        result = { ok: false, problems: [unexpected(error)] };
      }
      return result.ok ? answer({ ...result.value }) : refused(result.problems, result.saved);
    })();
    const entry = { controller, done: work.catch(() => {}) };
    running.add(entry);
    try {
      return await work;
    } finally {
      running.delete(entry);
      extra.signal.removeEventListener("abort", onAbort);
    }
  };

  /** Runs `use` with the catalog, or refuses with the reason it could not be read. */
  const withCatalog = async (use: (c: AgentCatalog) => CallToolResult): Promise<CallToolResult> => {
    const result = await catalog.get();
    return result.ok ? use(result.value) : refused(result.problems);
  };

  const deviceProblem = (c: AgentCatalog, device: string): Problem => ({
    code: "device",
    message: `"${device}" is not a device.`,
    fix: `Use one of: ${c.devices.map((d) => d.device).join(", ")}.`,
  });
  const findDevice = (c: AgentCatalog, device: string) => c.devices.find((d) => d.device.toLowerCase() === device.trim().toLowerCase());

  // ---- Tools ----

  server.registerTool(
    "list_scenes",
    {
      description:
        "List the scenes you can render: each scene's id, device, collection, title, length (seconds) and poster image. Filter by device or collection.",
      inputSchema: listScenesInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ device, collection }) =>
      withCatalog((c) => {
        let scenes = c.scenes;
        if (device !== undefined) {
          const found = findDevice(c, device);
          if (!found) return refused([deviceProblem(c, device)]);
          scenes = scenes.filter((s) => s.device === found.device);
        }
        if (collection !== undefined) {
          const wanted = collection.trim().toLowerCase();
          const kept = scenes.filter((s) => s.collection.toLowerCase() === wanted);
          if (!kept.length) {
            const names = [...new Set(scenes.map((s) => s.collection))];
            return refused([
              {
                code: "collection",
                message: `"${collection}" is not a collection${device !== undefined ? ` for ${device}` : ""}.`,
                fix: `Use one of: ${names.join(", ")}.`,
              },
            ]);
          }
          scenes = kept;
        }
        return answer({ scenes });
      }),
  );

  server.registerTool(
    "recording_spec",
    {
      description:
        "What to record for a device: the screen size in pixels, the frame rate, the accepted file types, the longest a screenshot can run and capture tips.",
      inputSchema: recordingSpecInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ device }) =>
      withCatalog((c) => {
        const found = findDevice(c, device);
        if (!found) return refused([deviceProblem(c, device)]);
        return answer({
          device: found.device,
          screen: { width: found.screen.width, height: found.screen.height },
          fps: found.fps,
          accepted: [...c.rules.videoTypes, ...c.rules.imageTypes],
          maxImageSeconds: c.rules.maxImageSeconds,
          tips: found.tips,
        });
      }),
  );

  server.registerTool(
    "render",
    {
      description:
        "Render a video from a plan, with the person's recording on the device screen, in their own Chrome. Free renders are watermarked previews for evaluation only; clean output needs Motion Mockups Pro. Files are saved in the project's motion-mockups folder.",
      inputSchema: renderInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args, extra) =>
      render(
        { plan: args.plan, ...(args.recording !== undefined ? { recording: args.recording } : {}), ...(args.name !== undefined ? { name: args.name } : {}) },
        extra,
      ),
  );

  server.registerTool(
    "still",
    {
      description:
        "Render one frame of a plan as a PNG or JPEG: the frame at `seconds` from the film's start. Free stills are watermarked previews for evaluation only; clean output needs Motion Mockups Pro.",
      inputSchema: stillInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args, extra) =>
      render(
        {
          plan: args.plan,
          ...(args.recording !== undefined ? { recording: args.recording } : {}),
          ...(args.name !== undefined ? { name: args.name } : {}),
          still: { seconds: args.seconds, format: args.format },
        },
        extra,
      ),
  );

  server.registerTool(
    "account",
    {
      description: "Whether this adapter is signed in, and which plan its renders use.",
      inputSchema: accountInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => answer({ signedIn: false, tier: "free", note: ACCOUNT_NOTE }),
  );

  return {
    server,
    async stop() {
      stopping = true;
      const waits = [...running].map((entry) => {
        entry.controller.abort();
        return entry.done;
      });
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled(waits), new Promise((resolve) => (timer = setTimeout(resolve, STOP_MS)))]);
      clearTimeout(timer);
      await server.close().catch(() => {});
    },
  };
}
