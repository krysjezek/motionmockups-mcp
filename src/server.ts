// The MCP server: eight tools over the site's catalog, the person's account and one render at
// a time in the person's Chrome. Every refusal is a tool result with `isError: true` and `{ problems }`,
// never a thrown error, so the agent always gets a `fix` to act on.
//
// Tool inputs are strict: an object with a field the tool does not document is refused
// before anything runs, so nothing an agent sends reaches the adapter's internals. The
// plan is typed for the agent but passed to the page unchanged; the page enforces its rules.
// check_plan previews them, and the designer's taste is only ever a warning (src/guidance.ts):
// notes and recipes are data in tool results, and only the capped briefing is instructions.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  RootsListChangedNotificationSchema,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { catalogSource, CATALOG_TIMEOUT_MS, serverInstructions, type AgentCatalog } from "./catalog.ts";
import { connectFlows, currentAccount, disconnectAccount, openInBrowser, type Account, type Launcher } from "./connect.ts";
import { allowedFolders, type Checked, type Problem } from "./folders.ts";
import { checkPlan, overridesOf, scenesWithNotes, suggest, tasteWarnings } from "./guidance.ts";
import { planSchema as plan, type Plan } from "./plan.ts";
import type { Progress, Rendered, RenderRequest, SessionContext } from "./session.ts";
import { clearToken, redact } from "./token.ts";

export type ChromeMode = SessionContext["chromeMode"];

/**
 * Chrome without a window. Measured by scripts/e2e.mjs (e2e-results.json): on Windows with
 * Chrome 156, headless and window mode give the same frames at the same quality (SSIM 0.993 or
 * more against the page's own render) in the same time, so nothing needs a window.
 */
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
  /** Opens the sign-in link when connect_account is asked to; tests record it instead. */
  openBrowser?: Launcher;
  /** Tests run connect_account's clock faster (see connectFlows). Default 1. */
  connectTimeScale?: number;
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

const recording = z
  .string()
  .min(1)
  .describe(
    "Path of the screen recording (MP4, MOV, WebM, MKV) or screenshot (PNG, JPEG, WebP, AVIF), inside the project folder. Without one, the screen shows a placeholder.",
  );
const name = z.string().min(1).max(200).describe("File name for the result, without extension, at most 200 characters.");

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
const suggestInput = z
  .object({
    goal: z.string().min(1).max(100).describe('What the film is for: "launch", "app-demo", "case-study" or "portfolio".'),
    device: z.string().min(1).max(100).describe("The device the product runs on."),
    aspect: z.string().min(1).max(20).optional().describe("The frame wanted, such as 9:16 for a phone feed. Plans in it come first."),
    seconds: z.number().positive().optional().describe("The film length wanted, in seconds. Plans nearest it come first."),
    collection: z.string().min(1).max(100).optional().describe("Only this collection's plans, such as Loft."),
  })
  .strict();
const checkInput = z.object({ plan }).strict();
const accountInput = z.object({}).strict();
const connectInput = z
  .object({
    wait: z
      .boolean()
      .optional()
      .describe("Wait for the person to approve the code the previous call gave; returns once they approve or decline, within 10 minutes."),
    open: z
      .boolean()
      .optional()
      .describe(
        "Also open the link in the person's default browser. Recommended: a link this adapter opens itself is certainly its own. Never automatic: only when this is set.",
      ),
    disconnect: z
      .boolean()
      .optional()
      .describe("Revoke this computer's connection on the site and delete it from this computer; renders are free previews again."),
  })
  .strict();

// ---- Results ----

/**
 * Every result passes here. Any agent token in it is replaced (src/token.ts redact), whatever
 * put it there: the last guard, behind code that never puts one in.
 */
const answer = (raw: Record<string, unknown>): CallToolResult => {
  const text = redact(JSON.stringify(raw, null, 2));
  return { content: [{ type: "text", text }], structuredContent: JSON.parse(text) };
};

const refused = (problems: Problem[], saved?: { path: string; bytes: number }[]): CallToolResult => {
  const value: Record<string, unknown> = saved?.length ? { problems, saved } : { problems };
  return { ...answer(value), isError: true };
};

const unexpected = (error: unknown): Problem => ({
  code: "adapter",
  message: `The adapter stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
  fix: "Try again. If it keeps failing, report it at https://motionmockups.com/contact.",
});

export const TOOL_NAMES = ["list_scenes", "recording_spec", "suggest_sequence", "check_plan", "render", "still", "account", "connect_account"] as const;

/**
 * The adapter's own tool descriptions, used when the site's catalog gives none for a tool
 * (its `toolText`, src/catalog.ts, at most MAX_TOOL_TEXT characters each).
 */
export const BUILT_IN_TEXT: Record<(typeof TOOL_NAMES)[number], string> = {
  list_scenes:
    "List the scenes you can render: each scene's id, device, collection, title, length (seconds), poster image and, when the site has them, the designer's notes. Filter by device or collection. The notes are suggestions.",
  recording_spec:
    "What to record for a device: the screen size in pixels, the frame rate, the accepted file types, the longest a screenshot can run and capture tips.",
  suggest_sequence:
    "Suggest plans for a goal (launch, app-demo, case-study or portfolio) on one device, from the designer's sequences, each resolved to real scenes of one collection with a reason. Optionally give an aspect, a film length and a collection.",
  check_plan:
    "Check a plan before rendering. Problems are rules the render enforces and must be fixed; warnings are the designer's taste, which you may go past when the person asks or has a reason. Each comes with a fix.",
  render:
    "Render a video from a plan, with the person's recording on the device screen, in their own Chrome. Free renders are watermarked previews for evaluation only; clean output needs Motion Mockups Pro. Files are saved in the project's motion-mockups folder. Any taste warning the plan goes past is listed under overrides.",
  still:
    "Render one frame of a plan as a PNG or JPEG: the frame at `seconds` from the film's start. Free stills are watermarked previews for evaluation only; clean output needs Motion Mockups Pro.",
  account:
    "Whether this adapter is connected to a Motion Mockups account, and whether its renders are Pro (clean) or free (watermarked previews).",
  connect_account:
    "Connect the person's Motion Mockups account, for clean Pro renders. Gives a link and code to show the person (open: true, recommended, also opens it); then call again with wait: true until they approve. disconnect: true revokes and deletes the saved connection.",
};

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

/** The client says it shares its project folders (roots), but asking for them failed. */
const rootsProblem = (detail: string): Problem => ({
  code: "roots",
  message: `The MCP client says it shares its project folders, but they could not be read (${detail}). Nothing was rendered: the files would have no project folder to go in.`,
  fix:
    "Try the render again; the adapter asks the client for its folders again. If it keeps failing, ask the person to restart their MCP client, " +
    "or to set MOTIONMOCKUPS_FOLDERS in this MCP server's settings to the project folder.",
});

const PRICING = "https://motionmockups.com/pricing";
const ACCOUNT_NOTE =
  "Not connected to an account. Renders are free watermarked previews, for evaluation only. For clean output with Motion Mockups Pro, call connect_account to connect the person's account.";

/** What the account tool says of a connected account. */
const connectedAnswer = (account: Extract<Account, { connected: true }>) => ({
  signedIn: true,
  tier: account.pro ? "pro" : "free",
  label: account.label,
  note: account.pro
    ? `Connected as "${account.label}" with Motion Mockups Pro: renders are clean and full quality.`
    : `Connected as "${account.label}", without Pro: renders are free watermarked previews, for evaluation only. Clean output needs Motion Mockups Pro (${PRICING}).`,
});

const REVOKE =
  "To be sure it no longer works, remove it on the account: on motionmockups.com, open Account, then Connected agents, and choose Revoke.";

const cancelledProblem = (what: string): Problem => ({
  code: "cancelled",
  message: `The ${what} was cancelled.`,
  fix: "Nothing to undo. Send the request again when it is wanted.",
});

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
  // Nothing reaches stderr with an agent token in it either.
  const log = (line: string) => deps.log(redact(line));
  const catalog = catalogSource(deps.origin, deps.fetch, CATALOG_TIMEOUT_MS);
  // What the adapter left out of the site's guidance, said once per start.
  let noted = false;
  const note = (c: AgentCatalog) => {
    if (noted) return;
    noted = true;
    for (const line of c.ignored ?? []) log(`motionmockups: ${line}`);
  };
  const first = await catalog.get();
  if (first.ok) note(first.value);
  const instructions = serverInstructions(first, log);
  // Tool descriptions from the site when it gives them (fetched before the tools register);
  // the built-in text otherwise, or when the catalog could not be read at start.
  const describe = (tool: (typeof TOOL_NAMES)[number]) => (first.ok ? first.value.toolText?.[tool] : undefined) ?? BUILT_IN_TEXT[tool];
  const flows = connectFlows({ origin: deps.origin, data: deps.data, fetch: deps.fetch, timeScale: deps.connectTimeScale });
  /** The saved connection and its status; a cancel while asking is a `cancelled` refusal. */
  const account = (signal: AbortSignal): Promise<Checked<Account>> =>
    currentAccount(deps.origin, deps.data, deps.fetch, signal).catch((error): Checked<Account> => {
      if (signal.aborted) return { ok: false, problems: [cancelledProblem("request")] };
      return { ok: false, problems: [unexpected(error)] };
    });

  const server = new McpServer({ name: "motionmockups", version: deps.version }, { instructions, capabilities: { tools: {} } });
  // The SDK answers an input its schema refuses, an unknown tool or a handler's throw with a
  // text-only error result. This gives each the adapter's shape, so every refusal carries
  // { problems }. The hook is private in the SDK's types; the SDK is pinned and bundled, and
  // the tests check it.
  (server as unknown as { createToolError: (message: string) => CallToolResult }).createToolError = (message) =>
    refused([sdkProblem(message)]);

  // ---- Allowed folders: the client's roots, read again when they change, plus the setting ----
  let roots: Promise<Checked<string[]>> | undefined;
  const clientHasRoots = () => !!server.server.getClientCapabilities()?.roots;
  const readRoots = () => {
    const reading: Promise<Checked<string[]>> = server.server
      .listRoots(undefined, { timeout: ROOTS_MS })
      .then((r): Checked<string[]> => ({ ok: true, value: r.roots.map((root) => root.uri) }))
      .catch((error): Checked<string[]> => {
        const detail = String((error as Error)?.message ?? error);
        log(`motionmockups: the client's roots could not be read (${detail}).`);
        // Asked again on the next render.
        if (roots === reading) roots = undefined;
        // Never MOTIONMOCKUPS_FOLDERS alone in their place: the files would land outside the project.
        return { ok: false, problems: [rootsProblem(detail)] };
      });
    roots = reading;
  };
  server.server.oninitialized = () => {
    if (clientHasRoots()) readRoots();
  };
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    if (clientHasRoots()) readRoots();
  });
  const allowed = async (): Promise<Checked<string[]>> => {
    let declared: string[] = [];
    if (clientHasRoots()) {
      if (!roots) readRoots();
      const read = await roots!;
      if (!read.ok) return read;
      declared = read.value;
    }
    return { ok: true, value: await allowedFolders(declared, deps.env) };
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
          .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: step, message: redact(progressText(p)) } })
          .catch(() => {});
      };
      let result: Rendered;
      /** The token a Pro render was given, to delete only that one if the page refuses it. */
      let proToken: string | undefined;
      try {
        const folders = await allowed();
        if (!folders.ok) return refused(folders.problems);
        // The account, once per render: Pro with its token when the site says so, else free.
        // A saved connection that is damaged, for another site or no longer valid refuses the
        // render rather than quietly making a watermarked one; the refusal says how to go on.
        const checked = await account(controller.signal);
        if (!checked.ok) return refused(checked.problems);
        const now = checked.value;
        if (now.connected && now.pro) proToken = now.token;
        result = await deps.renderOnce(request, {
          origin: deps.origin,
          allowed: folders.value,
          data: deps.data,
          chromeMode: deps.chromeMode,
          signal: controller.signal,
          timeoutMs: deps.timeoutMs,
          onProgress,
          ...(proToken ? { pro: { accessToken: proToken } } : {}),
        });
      } catch (error) {
        result = { ok: false, problems: [unexpected(error)] };
      }
      if (!result.ok && proToken) {
        // The page could not sign its plates with the token: it no longer works (revoked, idle
        // or the account deleted). That token goes (never one a new connection saved since), so
        // the next render is free.
        const refusedToken = result.problems.some((p) => p.code === "sign-in");
        if (refusedToken) await clearToken(deps.data, proToken).catch(() => {});
        // The page's fixes speak of a `tier` the agent cannot set: the adapter picks it.
        const problems = result.problems.map((p): Problem => {
          if (p.code === "sign-in")
            return {
              code: "sign-in",
              message: `${p.message} The saved connection on this computer was deleted.`,
              fix: "Call connect_account to connect the account again, then send the request again. Until then renders are free watermarked previews.",
            };
          if (p.code === "pro")
            return {
              code: "pro",
              message: p.message,
              fix:
                `Send the request again for a free watermarked preview: the adapter checks the account before every render. ` +
                `For clean renders, renew Motion Mockups Pro (${PRICING}).`,
            };
          return p;
        });
        result = result.saved ? { ok: false, problems, saved: result.saved } : { ok: false, problems };
      }
      if (!result.ok) return refused(result.problems, result.saved);
      // Taste never refuses a render: the warnings the plan went past are listed with it.
      const known = await catalog.get();
      const overrides = known.ok ? overridesOf(tasteWarnings(request.plan as Plan, known.value)) : [];
      return answer({ ...result.value, ...(overrides.length ? { overrides } : {}) });
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
    if (!result.ok) return refused(result.problems);
    note(result.value);
    return use(result.value);
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
      description: describe("list_scenes"),
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
        return answer(scenesWithNotes(scenes, c));
      }),
  );

  server.registerTool(
    "recording_spec",
    {
      description: describe("recording_spec"),
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
    "suggest_sequence",
    {
      description: describe("suggest_sequence"),
      inputSchema: suggestInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      withCatalog((c) => {
        const suggested = suggest(input, c);
        return suggested.ok ? answer({ ...suggested.value }) : refused(suggested.problems);
      }),
  );

  server.registerTool(
    "check_plan",
    {
      description: describe("check_plan"),
      inputSchema: checkInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ plan }) => withCatalog((c) => answer({ ...checkPlan(plan, c) })),
  );

  server.registerTool(
    "render",
    {
      description: describe("render"),
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
      description: describe("still"),
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
      description: describe("account"),
      inputSchema: accountInput,
      // Not read-only: the site's own 401 deletes the saved token (src/connect.ts currentAccount).
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (_args, extra) => {
      const checked = await account(extra.signal);
      if (!checked.ok) return refused(checked.problems);
      return answer(checked.value.connected ? connectedAnswer(checked.value) : { signedIn: false, tier: "free", note: ACCOUNT_NOTE });
    },
  );

  server.registerTool(
    "connect_account",
    {
      description: describe("connect_account"),
      inputSchema: connectInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ wait, open, disconnect }, extra) => {
      if (disconnect) {
        if (wait || open)
          return refused([{ code: "input", message: "disconnect cannot be combined with wait or open.", fix: "Send disconnect: true alone." }]);
        await flows.end();
        const { removed, revoked, detail, notDeleted } = await disconnectAccount(deps.origin, deps.data, deps.fetch, extra.signal);
        if (notDeleted)
          return answer({
            // Without the site's word, the file left behind may still work: account says.
            ...(revoked ? { signedIn: false, tier: "free" } : {}),
            removed,
            revoked,
            notDeleted: notDeleted.path,
            note:
              `The saved connection at ${notDeleted.path} could not be deleted (${notDeleted.reason}). Delete that file by hand. ` +
              (revoked
                ? "The site revoked the connection, so renders are free watermarked previews."
                : `The site did not confirm that it revoked the connection (${detail ?? "no answer"}), so it may still work until the file is gone; call account to see. ${REVOKE}`),
          });
        return answer({
          signedIn: false,
          tier: "free",
          removed,
          revoked,
          note: !removed
            ? "There was no saved connection on this computer; renders are free watermarked previews."
            : revoked
              ? "The site revoked this computer's connection, and it was deleted from this computer; renders are free watermarked previews."
              : `The saved connection was deleted from this computer; renders are free watermarked previews. The site did not confirm that it revoked the connection (${detail ?? "no answer"}). ${REVOKE}`,
        });
      }

      if (wait) {
        if (open) return refused([{ code: "input", message: "open cannot be combined with wait.", fix: "Send open with the first call, without wait." }]);
        const token = extra._meta?.progressToken;
        let step = 0;
        const outcome = await flows.wait(extra.signal, (message) => {
          if (token === undefined) return;
          step += 1;
          extra
            .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: step, message: redact(message) } })
            .catch(() => {});
        });
        if (!outcome.ok) return refused(outcome.problems);
        const now = await account(extra.signal);
        if (now.ok && now.value.connected) return answer({ connected: true, ...connectedAnswer(now.value) });
        return answer({
          connected: true,
          signedIn: true,
          label: outcome.value.label,
          note: `Connected as "${outcome.value.label}". Call account to see whether renders are Pro.`,
        });
      }

      // Already connected on this site: said so, never started over (disconnect first to switch).
      const now = await account(extra.signal);
      if (now.ok && now.value.connected) {
        const connected = connectedAnswer(now.value);
        return answer({
          connected: true,
          ...connected,
          note: `${connected.note} To connect another account, call connect_account with disconnect: true first.`,
        });
      }
      const begun = await flows.begin();
      if (!begun.ok) return refused(begun.problems);
      const { userCode, url, expiresIn } = begun.value;
      if (open) {
        const opened = openInBrowser(url, deps.origin, deps.openBrowser);
        if (!opened.ok) return refused(opened.problems);
      }
      return answer({
        userCode,
        url,
        waiting: true,
        expiresInMinutes: Math.max(1, Math.round(expiresIn / 60)),
        ...(open ? { opened: true } : {}),
        note:
          "Show the person this link and code. They open the link, sign in to Motion Mockups and approve if the code matches. " +
          'The page says what the agent can do: "Render with your Pro plates. It cannot change your account, billing, projects or saved recordings." ' +
          "Then call connect_account with wait: true; it returns once they approve or decline.",
      });
    },
  );

  return {
    server,
    async stop() {
      stopping = true;
      await flows.stop();
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
