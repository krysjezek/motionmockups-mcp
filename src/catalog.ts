// The site's catalog at `<origin>/agent/catalog.json`: the scenes, what each device wants
// recorded and the briefing the agent reads. It belongs to the site, so the owner changes
// it by deploying; the adapter only checks that it is what it says it is.
//
// A good one is kept for 10 minutes, then read again by the next call that needs it, so a
// kill switch the site sets (its `adapters` block, src/killswitch.ts) takes effect within
// minutes. A failed fetch is tried again on the next call; a failed re-read keeps the last
// good catalog for another minute before trying again.

import { DEFAULT_ORIGIN } from "./origin.ts";
import type { Checked, Problem } from "./folders.ts";
import { checkAdapters, type Adapters } from "./killswitch.ts";
import { TOOL_NAMES } from "./tools.ts";

/**
 * A scene's director's notes. Every field is optional here: a site may drop or add one, and
 * the adapter reads only those it knows, each capped (`cleanGuidance`).
 */
export interface SceneNotes {
  move?: string;
  framing?: string;
  pace?: string;
  screenDetail?: string;
  /** What the scene is good as: "opener", "detail", "close". Empty: kept out of films. */
  goodAs?: string[];
  note?: string;
  reviewed?: boolean;
}

/** A camera move's notes, once for all its scenes. */
export interface MoveNote {
  framing?: string;
  goodAs?: string[];
  pairsBefore?: string[];
  pairsAfter?: string[];
  avoidWith?: string[];
  note?: string;
  reviewed?: boolean;
}

/** A collection's notes: the place. */
export interface CollectionNote {
  light?: string;
  setting?: string;
  note?: string;
  reviewed?: boolean;
}

/** The taste rules' values; each rule applies only when its value is here. */
export interface Taste {
  filmSeconds?: [number, number];
  oneCollection?: boolean;
  noRepeatMoveBackToBack?: boolean;
  openers?: string[];
  closers?: string[];
  avoidPairs?: [string, string][];
  maxClips?: number;
}

/** A named sequence, with the scene ids it resolves to per collection (computed by the site). */
export interface Recipe {
  id: string;
  goal: string;
  device: string;
  aspect: string;
  title: string;
  why: string;
  reviewed: boolean;
  clips: { move: string; seconds: number }[];
  resolved: Record<string, string[]>;
}

export interface Scene {
  id: string;
  device: string;
  collection: string;
  title: string;
  seconds: number;
  poster: string;
  notes?: SceneNotes;
}

/**
 * The app's `src/agent/catalog.ts` shape, contract 1, as the adapter keeps it: the fields it
 * knows, guidance fields only when the site serves them (an older site has none).
 */
export interface AgentCatalog {
  contract: 1;
  briefing: string;
  devices: { device: string; fps: number; screen: { width: number; height: number }; tips: string[] }[];
  scenes: Scene[];
  rules: {
    aspects: string[];
    sizes: number[];
    minClipSeconds: number;
    maxImageSeconds: number;
    videoTypes: string[];
    imageTypes: string[];
    delivery: string[];
  };
  moves?: Record<string, MoveNote>;
  collectionNotes?: Record<string, CollectionNote>;
  taste?: Taste;
  recipes?: Recipe[];
  /** Tool name to description, each a non-empty string of at most MAX_TOOL_TEXT characters. */
  toolText?: Record<string, string>;
  /** The adapter versions the site serves; absent (or unreadable) allows every version. */
  adapters?: Adapters;
  /** What the adapter left out of the site's guidance, one line each, for stderr once. */
  ignored?: string[];
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
  const ignored: string[] = [];
  const catalog: AgentCatalog = {
    contract: 1,
    briefing: value.briefing,
    // Rebuilt field by field, each name and list capped: a field the adapter does not know
    // never reaches a tool result.
    devices: (value.devices as Record<string, any>[]).map((d) => ({
      device: cap(d.device, NAME_CHARS),
      fps: d.fps,
      screen: { width: d.screen.width, height: d.screen.height },
      tips: (d.tips as string[]).slice(0, TIPS_MAX).map((tip) => cap(tip, TIP_CHARS)),
    })),
    rules: r as unknown as AgentCatalog["rules"],
    scenes: (value.scenes as Record<string, unknown>[]).map((s) => {
      const scene: Scene = {
        id: cap(s.id as string, NAME_CHARS),
        device: cap(s.device as string, NAME_CHARS),
        collection: cap(s.collection as string, NAME_CHARS),
        title: cap(s.title as string, NAME_CHARS),
        seconds: s.seconds as number,
        poster: s.poster as string,
      };
      const notes = pick(s.notes, SCENE_NOTE_FIELDS);
      if (notes) scene.notes = notes;
      return scene;
    }),
    ...cleanGuidance(value, ignored),
  };
  if (value.adapters !== undefined) {
    // Never a lock-out by accident: a block that cannot be read is as if it were not there.
    const adapters = checkAdapters(value.adapters);
    if (typeof adapters === "string") ignored.push(`the site's adapters block ${adapters}; it is ignored, and every version of this adapter is allowed.`);
    else catalog.adapters = adapters;
  }
  if (ignored.length) catalog.ignored = ignored;
  return catalog;
}

// ---- Guidance: optional, tolerant, capped ----
//
// Notes and recipes are data the site's designer wrote; they reach the agent only inside tool
// results, never as instructions. Each string is capped, each list bounded, and anything of
// the wrong type is dropped on its own, so a newer site's fields never break this adapter.

/** The longest note text passed on (framing, note, light, setting). */
export const NOTE_CHARS = 500;
/** The longest recipe title or why passed on. */
export const TITLE_CHARS = 300;
/** The longest name passed on (a scene's id, title and collection, a device, a move, a goal). */
export const NAME_CHARS = 100;
/** The longest list passed on (moves, roles, pairs, clips). */
export const LIST_ITEMS = 50;
/** The longest device tip passed on, and how many of a device's tips. */
export const TIP_CHARS = 300;
export const TIPS_MAX = 20;
/** The longest tool description taken from the site. */
export const MAX_TOOL_TEXT = 2_000;
/** The taste rule types this adapter knows. */
export const RULE_TYPES = ["filmSeconds", "oneCollection", "noRepeatMoveBackToBack", "openers", "closers", "avoidPairs", "maxClips"] as const;

/** `text` cut to `max` characters, ending in an ellipsis when cut. */
export const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

type Kind = "name" | "text" | "names" | "flag";
const SCENE_NOTE_FIELDS: Record<keyof SceneNotes, Kind> = {
  move: "name",
  framing: "text",
  pace: "name",
  screenDetail: "name",
  goodAs: "names",
  note: "text",
  reviewed: "flag",
};
const MOVE_NOTE_FIELDS: Record<keyof MoveNote, Kind> = {
  framing: "text",
  goodAs: "names",
  pairsBefore: "names",
  pairsAfter: "names",
  avoidWith: "names",
  note: "text",
  reviewed: "flag",
};
const COLLECTION_NOTE_FIELDS: Record<keyof CollectionNote, Kind> = { light: "text", setting: "text", note: "text", reviewed: "flag" };

/** The fields of `value` the adapter knows, each of the right type and capped; undefined when none is. */
function pick<T>(value: unknown, fields: Record<string, Kind>): T | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(fields)) {
    const v = value[key];
    if (kind === "flag" ? typeof v === "boolean" : kind === "names" ? strings(v) : isString(v))
      out[key] =
        kind === "name" ? cap(v as string, NAME_CHARS) : kind === "text" ? cap(v as string, NOTE_CHARS) : kind === "names" ? names(v) : v;
  }
  return Object.keys(out).length ? (out as T) : undefined;
}

const names = (v: unknown) => (v as string[]).slice(0, LIST_ITEMS).map((n) => cap(n, NAME_CHARS));

/** A map of name to notes, keeping the entries that have any known field. */
function notesMap<T>(value: unknown, fields: Record<string, Kind>): Record<string, T> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, T> = {};
  for (const [name, v] of Object.entries(value).slice(0, 500)) {
    const notes = pick<T>(v, fields);
    if (notes) out[cap(name, NAME_CHARS)] = notes;
  }
  return out;
}

function cleanTaste(value: unknown, ignored: string[]): Taste | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    ignored.push("the site's taste rules are not an object; no taste rule applies.");
    return undefined;
  }
  const taste: Taste = {};
  const pairs = (v: unknown) => Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && strings(p));
  for (const [key, v] of Object.entries(value)) {
    const known = (RULE_TYPES as readonly string[]).includes(key);
    if (!known) {
      ignored.push(`the site's taste rule "${cap(key, NAME_CHARS)}" is not one this adapter knows; it is ignored.`);
      continue;
    }
    // Values that make no sense are as unreadable as the wrong type: a film length runs from
    // more than 0 s to no less than it starts, a clip count is a whole number of at least
    // one, and an empty list of openers or closers would warn on every film.
    if (key === "filmSeconds" && numbers(v) && (v as number[]).length === 2 && 0 < (v as number[])[0]! && (v as number[])[0]! <= (v as number[])[1]!)
      taste.filmSeconds = [(v as number[])[0]!, (v as number[])[1]!];
    else if ((key === "oneCollection" || key === "noRepeatMoveBackToBack") && typeof v === "boolean") taste[key] = v;
    else if ((key === "openers" || key === "closers") && strings(v) && (v as string[]).length > 0)
      taste[key] = (v as string[]).slice(0, 500).map((n) => cap(n, NAME_CHARS));
    else if (key === "avoidPairs" && pairs(v))
      taste.avoidPairs = (v as string[][]).slice(0, 500).map(([a, b]): [string, string] => [cap(a!, NAME_CHARS), cap(b!, NAME_CHARS)]);
    else if (key === "maxClips" && Number.isSafeInteger(v) && (v as number) > 0) taste.maxClips = v as number;
    else ignored.push(`the site's taste rule "${key}" has a value this adapter cannot read; it is ignored.`);
  }
  return taste;
}

function cleanRecipe(v: unknown): Recipe | undefined {
  if (!isObject(v)) return undefined;
  const { id, goal, device, aspect, title, why, clips, resolved } = v;
  if (![id, goal, device, aspect, title, why].every(isString)) return undefined;
  if (!Array.isArray(clips) || clips.length === 0 || clips.length > LIST_ITEMS) return undefined;
  if (!clips.every((c) => isObject(c) && isString(c.move) && isNumber(c.seconds))) return undefined;
  if (!isObject(resolved)) return undefined;
  const ids: Record<string, string[]> = {};
  for (const [collection, list] of Object.entries(resolved)) if (strings(list)) ids[collection] = list as string[];
  return {
    id: cap(id as string, NAME_CHARS),
    goal: cap(goal as string, NAME_CHARS),
    device: device as string,
    aspect: aspect as string,
    title: cap(title as string, TITLE_CHARS),
    why: cap(why as string, TITLE_CHARS),
    reviewed: v.reviewed === true,
    clips: (clips as { move: string; seconds: number }[]).map((c) => ({ move: cap(c.move, NAME_CHARS), seconds: c.seconds })),
    resolved: ids,
  };
}

/** The guidance fields the site serves, cleaned; none of them when an older site has none. */
function cleanGuidance(value: Record<string, unknown>, ignored: string[]): Partial<AgentCatalog> {
  const out: Partial<AgentCatalog> = {};
  const moves = notesMap<MoveNote>(value.moves, MOVE_NOTE_FIELDS);
  if (moves) out.moves = moves;
  const places = notesMap<CollectionNote>(value.collectionNotes, COLLECTION_NOTE_FIELDS);
  if (places) out.collectionNotes = places;
  const taste = cleanTaste(value.taste, ignored);
  if (taste) out.taste = taste;
  if (Array.isArray(value.recipes)) {
    const recipes = value.recipes.slice(0, 1_000).map(cleanRecipe);
    const kept = recipes.filter((r): r is Recipe => r !== undefined);
    if (kept.length < recipes.length) ignored.push(`${recipes.length - kept.length} of the site's recipes could not be read; they are not suggested.`);
    out.recipes = kept;
  }
  if (isObject(value.toolText)) {
    const text: Record<string, string> = {};
    for (const [tool, v] of Object.entries(value.toolText)) {
      // A tool this adapter does not have: its text is never used, so it is not kept.
      if (!(TOOL_NAMES as readonly string[]).includes(tool)) continue;
      if (isString(v) && v.trim() && v.length <= MAX_TOOL_TEXT) text[tool] = v;
      else
        ignored.push(
          `the site's description of ${cap(tool, NAME_CHARS)} is ${!isString(v) ? "not text" : v.trim() ? `${v.length} characters, more than ${MAX_TOOL_TEXT}` : "empty"}; the built-in one is used.`,
        );
    }
    out.toolText = text;
  }
  return out;
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

/** How long a good catalog is used before the next call reads it again. */
export const CATALOG_MAX_AGE_MS = 10 * 60_000;
/** After a failed re-read, how long the last good catalog serves before the next try. */
export const CATALOG_RETRY_MS = 60_000;

/**
 * The catalog for a server: `get()` gives the one kept while it is younger than
 * CATALOG_MAX_AGE_MS on `now`, or fetches again. Calls made while a fetch runs share it. A
 * re-read that fails gives the last good catalog, and is tried again CATALOG_RETRY_MS later.
 */
export function catalogSource(origin: URL, fetchImpl: typeof fetch, timeoutMs = CATALOG_TIMEOUT_MS, now: () => number = Date.now) {
  let good: { value: AgentCatalog; at: number } | undefined;
  let running: Promise<Checked<AgentCatalog>> | undefined;
  return {
    get(): Promise<Checked<AgentCatalog>> {
      if (good && now() - good.at < CATALOG_MAX_AGE_MS) return Promise.resolve({ ok: true, value: good.value });
      running ??= fetchCatalog(origin, fetchImpl, timeoutMs)
        .then((result): Checked<AgentCatalog> => {
          if (result.ok) good = { value: result.value, at: now() };
          else if (good) {
            // Offline calls are not each held up by the fetch timeout: the next try is a minute on.
            good.at = now() - CATALOG_MAX_AGE_MS + CATALOG_RETRY_MS;
            return { ok: true, value: good.value };
          }
          return result;
        })
        .finally(() => (running = undefined));
      return running;
    },
  };
}
