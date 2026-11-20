// The kill switch: the site's catalog may carry an `adapters` block naming the adapter
// versions it serves, `{ allowed: range, blocked: [versions], message }`. An adapter outside
// `allowed` or listed in `blocked` refuses its tools with code `blocked` (src/server.ts), so a
// broken release can be stopped by deploying the site.
//
// It must never lock people out by accident: a block the adapter cannot read is treated as
// absent (src/catalog.ts notes it once on stderr), a missing one allows every version, and an
// unbuilt adapter ("dev") is never checked.
//
// Ranges are a small subset of npm's, written here rather than taken as a dependency:
// space-separated comparators that must all hold, each `>=`, `>`, `<`, `<=` or `=` followed
// directly by MAJOR.MINOR.PATCH (a bare version means `=`), or `^MAJOR.MINOR.PATCH`. A version
// may carry a prerelease (`-beta.1`), lower than its release, and build metadata (`+…`), which
// is not compared. Anything else (`~`, `x`, `*`, `||`, hyphen ranges, a space after the
// operator) is not read. README "Kill switch".

import type { Problem } from "./folders.ts";

/** The longest site message passed on in a refusal. */
export const MESSAGE_CHARS = 500;
export const UPGRADE_FIX =
  "Ask the person to update the adapter: run it as `npx motionmockups@latest`, or update the Claude Desktop extension, then restart the MCP client.";

/** The `adapters` block as the adapter keeps it; `allowed` absent allows every version. */
export interface Adapters {
  allowed?: string;
  blocked: string[];
  message: string;
}

type Version = { core: [number, number, number]; pre: string[] };
type Comparator = { op: "<" | "<=" | ">" | ">=" | "="; version: Version };

const NUMBER = "(?:0|[1-9]\\d*)";
const IDENTIFIER = "(?:[0-9A-Za-z-]+)";
const VERSION = new RegExp(`^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+${IDENTIFIER}(?:\\.${IDENTIFIER})*)?$`);

function parseVersion(text: string): Version | undefined {
  const m = VERSION.exec(text);
  if (!m) return undefined;
  const pre = m[4] ? m[4].split(".") : [];
  // A numeric identifier has no leading zero.
  if (pre.some((id) => /^0\d+$/.test(id))) return undefined;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i]! < b.core[i]! ? -1 : 1;
  // A release is higher than any of its prereleases.
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** -1, 0 or 1; undefined when either is not MAJOR.MINOR.PATCH. */
export function compareVersions(a: string, b: string): number | undefined {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return x && y ? compare(x, y) : undefined;
}

/** The range's comparators, or undefined when it is outside the subset. */
export function parseRange(text: string): Comparator[] | undefined {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return undefined;
  const out: Comparator[] = [];
  for (const part of parts) {
    const m = /^(\^|>=|<=|>|<|=)?(.*)$/.exec(part)!;
    const version = parseVersion(m[2]!);
    if (!version) return undefined;
    if (m[1] !== "^") {
      out.push({ op: (m[1] ?? "=") as Comparator["op"], version });
      continue;
    }
    // ^1.2.3 is >=1.2.3 <2.0.0-0; ^0.2.3 is <0.3.0-0; ^0.0.3 is <0.0.4-0: the first non-zero part.
    const [major, minor, patch] = version.core;
    const upper: Version["core"] = major ? [major + 1, 0, 0] : minor ? [0, minor + 1, 0] : [0, 0, patch + 1];
    out.push({ op: ">=", version }, { op: "<", version: { core: upper, pre: ["0"] } });
  }
  return out;
}

/** Whether `version` meets every comparator; false when it is not a version. */
export function satisfies(version: string, range: Comparator[]): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  return range.every(({ op, version: r }) => {
    const c = compare(v, r);
    return op === "=" ? c === 0 : op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : c >= 0;
  });
}

/** The block when it can be read, else why not (it is then treated as absent). */
export function checkAdapters(value: unknown): Adapters | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "is not an object";
  const { allowed, blocked = [], message = "" } = value as Record<string, unknown>;
  if (allowed !== undefined && (typeof allowed !== "string" || !parseRange(allowed)))
    return `has an allowed range this adapter cannot read (${JSON.stringify(allowed)?.slice(0, 100)})`;
  if (!Array.isArray(blocked) || !blocked.every((v) => typeof v === "string" && parseVersion(v))) return "has a blocked list that is not a list of versions";
  if (typeof message !== "string") return "has a message that is not text";
  return {
    ...(allowed !== undefined ? { allowed: allowed as string } : {}),
    blocked: blocked as string[],
    message: capMessage(message),
  };
}

/** At most MESSAGE_CHARS, ending in an ellipsis when cut, never half of a surrogate pair. */
function capMessage(message: string): string {
  if (message.length <= MESSAGE_CHARS) return message;
  let kept = message.slice(0, MESSAGE_CHARS - 1);
  if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
  return `${kept}…`;
}

/** The refusal for this adapter's `version`, or undefined when it may serve. */
export function blockedProblem(adapters: Adapters | undefined, version: string): Problem | undefined {
  // An unbuilt adapter (tests, a checkout) has no version to judge.
  if (!adapters || version === "dev" || !parseVersion(version)) return undefined;
  const listed = adapters.blocked.some((b) => compareVersions(b, version) === 0);
  const range = adapters.allowed === undefined ? undefined : parseRange(adapters.allowed);
  if (!listed && (!range || satisfies(version, range))) return undefined;
  return {
    code: "blocked",
    message: adapters.message.trim() || `This version of the Motion Mockups adapter (${version}) no longer works with the site; it must be updated before it can be used.`,
    fix: UPGRADE_FIX,
  };
}
