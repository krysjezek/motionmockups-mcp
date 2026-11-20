// The designer's guidance, from the site's catalog: check_plan's previews of the rules the page
// enforces, the taste warnings render and still list as overrides, suggest_sequence's plans
// from the site's recipes and list_scenes' notes.
//
// Rule *types* live here; their values (pairs to avoid, openers, closers, film length) come
// from the catalog, so the owner changes taste by deploying the site. A rule the catalog does
// not give does not apply, so a catalog without guidance (an older site) gives no warnings.
// Recipes arrive resolved to scene ids per collection; the adapter never resolves one itself.
//
// Enforced rules are previews only: the page is the authority and refuses what does not fit.

import type { AgentCatalog, CollectionNote, MoveNote, Recipe, Scene } from "./catalog.ts";
import { cap, NOTE_CHARS } from "./catalog.ts";
import type { Problem } from "./folders.ts";
import type { Plan } from "./plan.ts";

/** A taste warning: the code is the rule's name. */
export type Warning = Problem;

export interface PlanCheck {
  ok: boolean;
  problems: Problem[];
  warnings: Warning[];
}

/** At most this many suggestions per call. */
export const MAX_SUGGESTIONS = 6;

/** "A, B and C" (or "A, B or C"), at most `max` names and then how many more. */
const listOf = (items: readonly string[], word = "and", max = 12) => {
  const shown = items.slice(0, max);
  if (items.length > max) return `${shown.join(", ")} ${word} ${items.length - max} more`;
  return shown.length < 2 ? shown.join("") : `${shown.slice(0, -1).join(", ")} ${word} ${shown.at(-1)}`;
};
const seconds1 = (n: number) => `${Number(n.toFixed(1))} s`;

/** A scene's move: its notes' move, else its title (titles name the camera move). */
export const moveOf = (scene: Scene) => scene.notes?.move ?? scene.title;

const fpsOf = (catalog: AgentCatalog, device: string) => catalog.devices.find((d) => d.device === device)?.fps ?? 60;

/**
 * The longest a clip of `scene` may run in the film, as the page's timeline counts it: the
 * scene's frames, shortened by the speed ramp (app src/sequence.ts outputFrames: a 1.2 s
 * speed-up out of and into each clip, getting through 2 s of extra source at 100 and 1 s at 50).
 */
export function maxClipSeconds(scene: Scene, fps: number, speedRamp: Plan["speedRamp"]): number {
  const source = Math.round(scene.seconds * fps);
  if (speedRamp === undefined || speedRamp === "off") return source / fps;
  const burst = Math.round(1.2 * fps);
  const extra = Math.round((speedRamp === 100 ? 2 : 1) * fps);
  const out = source >= 2 * (burst + extra) ? source - 2 * extra : Math.ceil((source * burst) / (burst + extra));
  return out / fps;
}

/**
 * Previews of the rules the page enforces (app src/agent/plan.ts parsePlan, then planToMockup),
 * with the page's codes. The shape (fields, types, contract, delivery, ramp, reflections) is
 * the tools' input schema's. As on the page, the scene checks run only once the device, aspect
 * and size are good.
 */
export function planProblems(plan: Plan, catalog: AgentCatalog): Problem[] {
  const problems: Problem[] = [];
  const devices = catalog.devices.map((d) => d.device);
  const { aspects, sizes, minClipSeconds } = catalog.rules;
  if (!devices.includes(plan.device))
    problems.push({ code: "device", message: `${JSON.stringify(plan.device)} is not a device.`, fix: `Use one of: ${devices.join(", ")}.` });
  if (!aspects.includes(plan.aspect))
    problems.push({ code: "aspect", message: `${JSON.stringify(plan.aspect)} is not an aspect.`, fix: `Use one of: ${aspects.join(", ")}.` });
  if (plan.size !== undefined && !sizes.includes(plan.size))
    problems.push({ code: "size", message: `${JSON.stringify(plan.size)} is not a size.`, fix: `Use one of: ${sizes.join(", ")}.` });
  if (problems.length) return problems;

  const fps = fpsOf(catalog, plan.device);
  const minFrames = Math.round(minClipSeconds * fps);
  for (const clip of plan.clips) {
    const scene = catalog.scenes.find((s) => s.id === clip.scene);
    const at = `${clip.scene}: `;
    if (!scene) {
      problems.push({ code: "scene", message: `"${clip.scene}" is not a scene.`, fix: "Take scene ids from list_scenes." });
      continue;
    }
    if (scene.device !== plan.device) {
      problems.push({
        code: "scene",
        message: `${at}This is a ${plan.device} plan, and the scene is a ${scene.device} scene.`,
        fix: `Use ${plan.device} scenes only (list_scenes with device "${plan.device}"), or make the plan for ${scene.device}.`,
      });
      continue;
    }
    if (clip.seconds === undefined) continue;
    const max = maxClipSeconds(scene, fps, plan.speedRamp);
    if (!Number.isFinite(clip.seconds) || Math.round(clip.seconds * fps) < minFrames)
      problems.push({
        code: "seconds",
        message: `${at}A scene has to be at least ${minClipSeconds} second long.`,
        fix: `Give it a length between ${minClipSeconds} s and ${max.toFixed(1)} s, or remove the clip.`,
      });
    else if (clip.seconds > max + 1e-6)
      problems.push({
        code: "seconds",
        message: `${at}This scene can run to ${max.toFixed(1)} s${plan.speedRamp === 50 || plan.speedRamp === 100 ? ` with speedRamp ${plan.speedRamp}` : ""}.`,
        fix: `Give it a length between ${minClipSeconds} s and ${max.toFixed(1)} s, or leave seconds out for the whole scene.`,
      });
  }
  const colour = /^#[0-9a-f]{6}$/i;
  if (plan.background && !(colour.test(plan.background.top) && colour.test(plan.background.bottom)))
    problems.push({
      code: "background",
      message: "The background colours are not both #rrggbb.",
      fix: 'Send { "top": "#rrggbb", "bottom": "#rrggbb" }, such as "#f4efe6".',
    });
  return problems;
}

/**
 * The taste rules the catalog gives, over the plan's known scenes. Never a reason to refuse: an
 * agent may go past a warning when the person asks or has a reason.
 *
 * The sequence rules (film length, collections, repeats, pairs, ends, clip count) are about a
 * film, so they are skipped when the plan asks for one video per scene (delivery "scenes").
 * A scene the designer keeps out of films (goodAs empty) is warned of either way.
 */
export function tasteWarnings(plan: Plan, catalog: AgentCatalog): Warning[] {
  const warnings: Warning[] = [];
  const taste = catalog.taste ?? {};
  const fps = fpsOf(catalog, plan.device);
  const clips = plan.clips.flatMap((clip, i) => {
    const scene = catalog.scenes.find((s) => s.id === clip.scene);
    return scene ? [{ clip, scene, move: moveOf(scene), n: i + 1 }] : [];
  });

  for (const { scene, n } of clips)
    if (scene.notes?.goodAs && scene.notes.goodAs.length === 0)
      warnings.push({
        code: "goodAs",
        message: `Clip ${n} (${scene.id}) is a scene the designer keeps out of films${scene.notes.note ? `: ${cap(scene.notes.note, NOTE_CHARS)}` : "."}`,
        fix: "Use another scene of this device and collection (list_scenes), unless the person asked for this one.",
      });
  if (plan.delivery === "scenes" || clips.length === 0) return warnings;

  if (taste.filmSeconds) {
    const [min, max] = taste.filmSeconds;
    const total = clips.reduce((sum, { clip, scene }) => sum + (clip.seconds ?? maxClipSeconds(scene, fps, plan.speedRamp)), 0);
    if (total < min - 1e-6 || total > max + 1e-6)
      warnings.push({
        code: "filmSeconds",
        message: `The film runs ${seconds1(total)}; the designer's guidance is ${min} to ${max} s.`,
        fix: `Change clip lengths, or add or remove a clip, to land between ${min} and ${max} s. Go past it when the person asks for that length.`,
      });
  }
  if (taste.maxClips !== undefined && plan.clips.length > taste.maxClips)
    warnings.push({
      code: "maxClips",
      message: `The film has ${plan.clips.length} clips; the designer's guidance is at most ${taste.maxClips}.`,
      fix: `Remove ${plan.clips.length - taste.maxClips} clip${plan.clips.length - taste.maxClips === 1 ? "" : "s"}, keeping the opener and the close.`,
    });
  if (taste.oneCollection) {
    const collections = [...new Set(clips.map(({ scene }) => scene.collection))];
    if (collections.length > 1)
      warnings.push({
        code: "oneCollection",
        message: `The film mixes ${collections.length} collections (${listOf(collections)}); the designer keeps a film in one place.`,
        fix: `Use scenes of one collection, unless the person asked for a mix.`,
      });
  }
  for (let i = 1; i < clips.length; i++) {
    const a = clips[i - 1]!;
    const b = clips[i]!;
    if (b.n !== a.n + 1) continue;
    if (taste.noRepeatMoveBackToBack && a.move === b.move)
      warnings.push({
        code: "noRepeatMoveBackToBack",
        message: `Clips ${a.n} and ${b.n} are both ${a.move}; the same move twice in a row reads as one long shot.`,
        fix: `Put a different move between them, or replace one.`,
      });
    if (taste.avoidPairs?.some(([x, y]) => x === a.move && y === b.move))
      warnings.push({
        code: "avoidPairs",
        message: `Clip ${a.n} (${a.move}) cuts into clip ${b.n} (${b.move}), a pair the designer avoids.`,
        fix: `Put another move between them, or replace one; list_scenes gives each move's pairsAfter.`,
      });
  }
  const first = clips[0]!;
  if (taste.openers && first.n === 1 && !taste.openers.includes(first.move) && !first.scene.notes?.goodAs?.includes("opener"))
    warnings.push({
      code: "openers",
      message: `The film opens on ${first.move} (${first.scene.id}), which the designer does not use to open.`,
      fix: `Open on a scene whose move is ${listOf(taste.openers, "or")}, or whose notes' goodAs has "opener".`,
    });
  const last = clips.at(-1)!;
  if (taste.closers && plan.clips.length > 1 && last.n === plan.clips.length && !taste.closers.includes(last.move) && !last.scene.notes?.goodAs?.includes("close"))
    warnings.push({
      code: "closers",
      message: `The film ends on ${last.move} (${last.scene.id}), which the designer does not use to close.`,
      fix: `End on a scene whose move is ${listOf(taste.closers, "or")}, or whose notes' goodAs has "close".`,
    });
  return warnings;
}

/** check_plan: the enforced previews, then the taste warnings. `ok` only without problems. */
export function checkPlan(plan: Plan, catalog: AgentCatalog): PlanCheck {
  const problems = planProblems(plan, catalog);
  return { ok: problems.length === 0, problems, warnings: tasteWarnings(plan, catalog) };
}

/** What render and still list when the plan goes past taste warnings. */
export const overridesOf = (warnings: Warning[]) => warnings.map((w) => `${w.code}: ${w.message}`);

// ---- list_scenes ----

/**
 * The scenes with their notes, and each listed move's and collection's notes once (not on every
 * scene). The two maps are there only when the site serves them.
 */
export function scenesWithNotes(scenes: Scene[], catalog: AgentCatalog) {
  const out: { scenes: Scene[]; moves?: Record<string, MoveNote>; collectionNotes?: Record<string, CollectionNote> } = { scenes };
  if (catalog.moves) {
    const moves = catalog.moves;
    const used = [...new Set(scenes.map(moveOf))].filter((m) => Object.hasOwn(moves, m));
    if (used.length) out.moves = Object.fromEntries(used.map((m) => [m, moves[m]!]));
  }
  if (catalog.collectionNotes) {
    const places = catalog.collectionNotes;
    const used = [...new Set(scenes.map((s) => s.collection))].filter((c) => Object.hasOwn(places, c));
    if (used.length) out.collectionNotes = Object.fromEntries(used.map((c) => [c, places[c]!]));
  }
  return out;
}

// ---- suggest_sequence ----

export interface SuggestInput {
  goal: string;
  device: string;
  aspect?: string;
  seconds?: number;
  collection?: string;
}

export interface Suggestion {
  recipe: string;
  title: string;
  why: string;
  collection: string;
  seconds: number;
  reviewed: boolean;
  plan: Plan;
  note?: string;
}

type Checked<T> = { ok: true; value: T } | { ok: false; problems: Problem[] };

/** Names match whatever their case, and spaces and hyphens count alike ("case study" is "case-study"). */
const key = (name: string) => name.trim().toLowerCase().replace(/[\s-]+/g, "-");
const same = (a: string, b: string) => key(a) === key(b);

/** A recipe's plan for one collection, from the site's resolved scene ids; null if they do not fit. */
function recipePlan(recipe: Recipe, collection: string, catalog: AgentCatalog): Plan | null {
  const ids = recipe.resolved[collection];
  if (!ids || ids.length !== recipe.clips.length) return null;
  const plan: Plan = {
    contract: 1,
    device: recipe.device,
    aspect: recipe.aspect,
    clips: ids.map((scene, i) => ({ scene, seconds: recipe.clips[i]!.seconds })),
  };
  // Never a wrong scene: each must be that collection's scene of the recipe's move and device,
  // and the plan must pass the enforced rules.
  const fits = ids.every((id, i) => {
    const scene = catalog.scenes.find((s) => s.id === id);
    return scene && scene.device === recipe.device && scene.collection === collection && moveOf(scene) === recipe.clips[i]!.move;
  });
  return fits && planProblems(plan, catalog).length === 0 ? plan : null;
}

/**
 * Plans for a goal on a device from the site's recipes, each resolved to one collection's
 * scenes. Those in the asked aspect come first, then those nearest the asked length.
 *
 * A recipe framed for another aspect than the one asked is still offered, with its own aspect
 * and a note: the designer chose each recipe's aspect so the closing screen stays in view, and
 * recipes have one aspect per goal and device, so leaving them out would leave nothing for
 * most aspects.
 */
export function suggest(input: SuggestInput, catalog: AgentCatalog): Checked<{ suggestions: Suggestion[]; note?: string }> {
  const device = catalog.devices.find((d) => same(d.device, input.device))?.device;
  if (!device)
    return {
      ok: false,
      problems: [{ code: "device", message: `"${input.device}" is not a device.`, fix: `Use one of: ${catalog.devices.map((d) => d.device).join(", ")}.` }],
    };
  if (input.aspect !== undefined && !catalog.rules.aspects.includes(input.aspect))
    return {
      ok: false,
      problems: [{ code: "aspect", message: `${JSON.stringify(input.aspect)} is not an aspect.`, fix: `Use one of: ${catalog.rules.aspects.join(", ")}.` }],
    };
  const recipes = catalog.recipes ?? [];
  if (!recipes.length)
    return { ok: true, value: { suggestions: [], note: "This site serves no suggestions. Build the plan from list_scenes and its notes." } };
  const goals = [...new Set(recipes.map((r) => r.goal))];
  if (!goals.some((g) => same(g, input.goal)))
    return { ok: false, problems: [{ code: "goal", message: `"${input.goal}" is not a goal.`, fix: `Use one of: ${goals.join(", ")}.` }] };
  let collection: string | undefined;
  if (input.collection !== undefined) {
    const names = [...new Set(catalog.scenes.filter((s) => s.device === device).map((s) => s.collection))];
    collection = names.find((n) => same(n, input.collection!));
    if (!collection)
      return {
        ok: false,
        problems: [{ code: "collection", message: `"${input.collection}" is not a collection for ${device}.`, fix: `Use one of: ${names.join(", ")}.` }],
      };
  }

  const all: Suggestion[] = [];
  for (const recipe of recipes) {
    if (!same(recipe.goal, input.goal) || recipe.device !== device) continue;
    for (const place of Object.keys(recipe.resolved)) {
      if (collection !== undefined && place !== collection) continue;
      const plan = recipePlan(recipe, place, catalog);
      if (!plan) continue;
      const suggestion: Suggestion = {
        recipe: recipe.id,
        title: recipe.title,
        why: recipe.why,
        collection: place,
        seconds: Number(recipe.clips.reduce((sum, c) => sum + c.seconds, 0).toFixed(3)),
        reviewed: recipe.reviewed,
        plan,
      };
      if (input.aspect !== undefined && input.aspect !== recipe.aspect)
        suggestion.note = `The designer framed this sequence for ${recipe.aspect}. For ${input.aspect}, set the plan's aspect to ${input.aspect} and render a still first to check that the screen stays in view.`;
      all.push(suggestion);
    }
  }
  const rank = (s: Suggestion) => [
    input.aspect !== undefined && s.plan.aspect !== input.aspect ? 1 : 0,
    input.seconds !== undefined ? Math.abs(s.seconds - input.seconds) : 0,
  ];
  const ranked = all
    .map((s, i) => ({ s, i, r: rank(s) }))
    .sort((a, b) => a.r[0]! - b.r[0]! || a.r[1]! - b.r[1]! || a.i - b.i)
    .map(({ s }) => s);
  const suggestions = ranked.slice(0, MAX_SUGGESTIONS);
  if (!suggestions.length)
    return {
      ok: true,
      value: {
        suggestions,
        note: `No ${input.goal} sequence for ${device}${collection ? ` in ${collection}` : ""}. Try another collection or goal, or build the plan from list_scenes and its notes.`,
      },
    };
  return {
    ok: true,
    value:
      ranked.length > suggestions.length
        ? { suggestions, note: `${ranked.length - suggestions.length} more fit; give a collection, an aspect or a length to narrow them.` }
        : { suggestions },
  };
}
