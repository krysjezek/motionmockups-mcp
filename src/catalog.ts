// The site's catalog at `<origin>/agent/catalog.json`: the scenes, what each device wants
// recorded and the briefing the agent reads. It belongs to the site, so the owner changes
// it by deploying; the adapter only checks that it is what it says it is.
//
// Kept for the life of the process once a good one arrives (a server lives as long as the
// agent's session). A failed fetch is tried again on the next call that needs it.

import { DEFAULT_ORIGIN } from "./origin.ts";
import type { Checked, Problem } from "./folders.ts";

/** The app's `src/agent/catalog.ts` shape, contract 1. */
export interface AgentCatalog {
  contract: 1;
  briefing: string;
  devices: { device: string; fps: number; screen: { width: number; height: number }; tips: string[] }[];
  scenes: { id: string; device: string; collection: string; title: string; seconds: number; poster: string }[];
  rules: {
    aspects: string[];
    sizes: number[];
    minClipSeconds: number;
    maxImageSeconds: number;
    videoTypes: string[];
    imageTypes: string[];
    delivery: string[];
  };
}

export const CATALOG_PATH = "/agent/catalog.json";
export const CATALOG_TIMEOUT_MS = 5_000;
/** Far above the real catalog (about 40 kB); a body past this is not the catalog. */
const MAX_BYTES = 4 * 1024 * 1024;

/** The server's instructions when the catalog could not be read at start. */
export const FALLBACK_BRIEFING = [
  "Motion Mockups puts a screen recording or screenshot into an art-directed device scene and renders the video in the person's own Chrome.",
  "The scene list could not be loaded when this server started. list_scenes and recording_spec try again when called.",
  "Free output is a watermarked preview, for evaluation only. Say so when you hand it over. A clean file needs Motion Mockups Pro.",
  "Finished files land in the motion-mockups folder.",
].join("\n");

/** The longest briefing used as the server's instructions (the real one is under 1,000). */
export const MAX_BRIEFING_CHARS = 8_000;

/**
 * The server's instructions: the catalog's briefing, or the fallback when the catalog could not
 * be read or its briefing is longer than MAX_BRIEFING_CHARS. Each fallback is logged.
 */
export function serverInstructions(first: Checked<AgentCatalog>, log: (line: string) => void): string {
  if (!first.ok) {
    log(`motionmockups: ${first.problems[0]!.message} Starting with the built-in briefing.`);
    return FALLBACK_BRIEFING;
  }
  const { briefing } = first.value;
  if (briefing.length > MAX_BRIEFING_CHARS) {
    log(
      `motionmockups: the site's briefing is ${briefing.length} characters, more than the ${MAX_BRIEFING_CHARS} the adapter passes on. Starting with the built-in briefing.`,
    );
    return FALLBACK_BRIEFING;
  }
  return briefing;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strings = (v: unknown) => Array.isArray(v) && v.every(isString);
const numbers = (v: unknown) => Array.isArray(v) && v.every(isNumber);

/** The catalog when `value` has its shape, else what is wrong with it. */
export function checkCatalog(value: unknown): AgentCatalog | string {
  if (!isObject(value)) return "it is not a JSON object";
  if (value.contract !== 1) return `its contract is ${JSON.stringify(value.contract)}, not 1`;
  if (!isString(value.briefing) || !value.briefing.trim()) return "it has no briefing";
  if (!Array.isArray(value.devices) || value.devices.length === 0) return "it has no devices";
  for (const d of value.devices)
    if (!isObject(d) || !isString(d.device) || !isNumber(d.fps) || !isObject(d.screen) || !isNumber(d.screen.width) || !isNumber(d.screen.height) || !strings(d.tips))
      return "a device lacks its name, fps, screen size or tips";
  if (!Array.isArray(value.scenes)) return "it has no scenes";
  for (const s of value.scenes)
    if (!isObject(s) || !isString(s.id) || !isString(s.device) || !isString(s.collection) || !isString(s.title) || !isNumber(s.seconds) || !isString(s.poster))
      return "a scene lacks its id, device, collection, title, length or poster";
  const r = value.rules;
  if (
    !isObject(r) ||
    !strings(r.aspects) ||
    !numbers(r.sizes) ||
    !isNumber(r.minClipSeconds) ||
    !isNumber(r.maxImageSeconds) ||
    !strings(r.videoTypes) ||
    !strings(r.imageTypes) ||
    !strings(r.delivery)
  )
    return "its rules are incomplete";
  return value as unknown as AgentCatalog;
}

function siteProblem(url: URL, detail: string): Problem {
  const fix =
    url.origin === DEFAULT_ORIGIN
      ? "Check the internet connection, then try again in a minute."
      : "Check that the site at MOTIONMOCKUPS_ORIGIN is running and was built with the agent page (AGENT_PAGE=1), then try again.";
  return { code: "site", message: `The scene list at ${url.href} could not be loaded: ${detail}.`, fix };
}

/** The body as text, refusing past `MAX_BYTES`. */
async function boundedText(response: Response): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One fetch of the catalog, bounded by `timeoutMs` from the request to the last byte. */
export async function fetchCatalog(origin: URL, fetchImpl: typeof fetch, timeoutMs = CATALOG_TIMEOUT_MS): Promise<Checked<AgentCatalog>> {
  const url = new URL(CATALOG_PATH, origin);
  const fail = (detail: string): Checked<AgentCatalog> => ({ ok: false, problems: [siteProblem(url, detail)] });
  let text: string | null;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
      redirect: "error",
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return fail(`the site answered ${response.status}`);
    }
    // A dev server without AGENT_PAGE=1 answers every path with the app's HTML page.
    const type = response.headers.get("content-type") ?? "";
    if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(type.trim())) {
      await response.body?.cancel().catch(() => {});
      return fail(`the answer is not JSON (${type || "no content type"})`);
    }
    text = await boundedText(response);
  } catch (error) {
    const name = (error as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") return fail(`no answer within ${timeoutMs / 1000} s`);
    return fail(`the site could not be reached (${(error as Error)?.message ?? String(error)})`);
  }
  if (text === null) return fail("the answer is far larger than a catalog");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("the answer is not JSON");
  }
  const checked = checkCatalog(value);
  if (typeof checked === "string") return fail(checked);
  return { ok: true, value: checked };
}

/**
 * The catalog for a server: `get()` gives the one kept, or fetches again. Calls made while
 * a fetch runs share it.
 */
export function catalogSource(origin: URL, fetchImpl: typeof fetch, timeoutMs = CATALOG_TIMEOUT_MS) {
  let good: AgentCatalog | undefined;
  let running: Promise<Checked<AgentCatalog>> | undefined;
  return {
    get(): Promise<Checked<AgentCatalog>> {
      if (good) return Promise.resolve({ ok: true, value: good });
      running ??= fetchCatalog(origin, fetchImpl, timeoutMs)
        .then((result) => {
          if (result.ok) good = result.value;
          return result;
        })
        .finally(() => (running = undefined));
      return running;
    },
  };
}
