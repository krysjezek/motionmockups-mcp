import { test } from "node:test";
import assert from "node:assert/strict";

import { checkCatalog, LIST_ITEMS, MAX_TOOL_TEXT, NAME_CHARS, NOTE_CHARS, TIP_CHARS, TIPS_MAX, TITLE_CHARS, type AgentCatalog } from "../src/catalog.ts";
import { checkPlan, MAX_SUGGESTIONS, maxClipSeconds, planProblems, scenesWithNotes, suggest, tasteWarnings } from "../src/guidance.ts";
import { planSchema, type Plan } from "../src/plan.ts";
import { GUIDED, oldCatalog } from "./fixtures/guided-catalog.ts";

const catalog = (value: unknown = GUIDED): AgentCatalog => {
  const checked = checkCatalog(structuredClone(value));
  assert.equal(typeof checked, "object", String(checked));
  return checked as AgentCatalog;
};
const C = catalog();
const plan = (clips: (string | Plan["clips"][number])[], extra: Partial<Plan> = {}): Plan => ({
  contract: 1,
  device: "Display",
  aspect: "16:9",
  clips: clips.map((c) => (typeof c === "string" ? { scene: c } : c)),
  ...extra,
});
const codes = (warnings: { code: string }[]) => warnings.map((w) => w.code);
const LOFT = (n: number) => `showroom-xdr-shot-${n}`;

// ---- Taste rules: each warns, and stays quiet, as expected ----

test("a plan the designer would make has no warnings", () => {
  // Low Arc opens (listed), Push In closes (listed), 4 s + 4 s.
  assert.deepEqual(tasteWarnings(plan([{ scene: "home-xdr-shot-4", seconds: 4 }, { scene: "home-xdr-shot-2", seconds: 4 }]), C), []);
});

test("openers: a listed move or the scene's own goodAs opens; anything else warns", () => {
  // Orbit is not listed and the scene is not good as an opener.
  const orbit = tasteWarnings(plan([{ scene: LOFT(3), seconds: 4 }, { scene: LOFT(2), seconds: 4 }]), C);
  assert.deepEqual(codes(orbit), ["openers"]);
  assert.match(orbit[0]!.message, /opens on Orbit/);
  assert.match(orbit[0]!.fix, /Low Arc/);
  // Push In is not listed, but this scene's goodAs has "opener" (ruling R6).
  assert.deepEqual(tasteWarnings(plan([{ scene: LOFT(1), seconds: 4 }, { scene: LOFT(2), seconds: 4 }]), C), []);
  // Low Arc is listed.
  assert.deepEqual(tasteWarnings(plan([{ scene: LOFT(2), seconds: 4 }, { scene: LOFT(4), seconds: 4 }]), C), []);
});

test("closers: a listed move or the scene's own goodAs closes; anything else warns; one clip is only an opener", () => {
  const ends = tasteWarnings(plan([{ scene: LOFT(2), seconds: 4 }, { scene: LOFT(3), seconds: 4 }]), C);
  assert.deepEqual(codes(ends), ["closers"]);
  assert.match(ends[0]!.message, /ends on Orbit/);
  // Rise is not listed, but this scene's goodAs has "close".
  assert.deepEqual(tasteWarnings(plan([{ scene: LOFT(2), seconds: 4 }, { scene: LOFT(4), seconds: 4 }]), C), []);
  // Push In is listed.
  assert.deepEqual(tasteWarnings(plan([{ scene: "home-xdr-shot-4", seconds: 4 }, { scene: "home-xdr-shot-2", seconds: 4 }]), C), []);
  // One clip: opens, and is not held to the closers.
  assert.deepEqual(tasteWarnings(plan([LOFT(1)]), C), []);
});

test("filmSeconds: outside 6 to 20 s warns, counting a clip without seconds at its ramped length", () => {
  const short = tasteWarnings(plan([{ scene: LOFT(2), seconds: 2 }, { scene: LOFT(4), seconds: 2 }]), C);
  assert.deepEqual(codes(short), ["filmSeconds"]);
  assert.match(short[0]!.message, /runs 4 s; the designer's guidance is 6 to 20 s/);
  // Three whole scenes: 24 s.
  assert.deepEqual(codes(tasteWarnings(plan([LOFT(2), LOFT(1), LOFT(4)]), C)), ["filmSeconds"]);
  // The same under ramp 100: 4 s each, 12 s.
  assert.deepEqual(tasteWarnings(plan([LOFT(2), LOFT(1), LOFT(4)], { speedRamp: 100 }), C), []);
  // At the limits.
  assert.deepEqual(tasteWarnings(plan([{ scene: LOFT(2), seconds: 3 }, { scene: LOFT(4), seconds: 3 }]), C), []);
});

test("maxClips: more clips than the guidance warns", () => {
  const five = plan([LOFT(2), LOFT(3), LOFT(1), LOFT(6), LOFT(4)].map((scene) => ({ scene, seconds: 2 })));
  assert.deepEqual(codes(tasteWarnings(five, C)), ["maxClips"]);
  assert.deepEqual(codes(tasteWarnings({ ...five, clips: five.clips.slice(1) }, C)), ["openers"]);
});

test("oneCollection: mixing collections warns", () => {
  const mixed = tasteWarnings(plan([{ scene: LOFT(2), seconds: 4 }, { scene: "home-xdr-shot-2", seconds: 4 }]), C);
  assert.deepEqual(codes(mixed), ["oneCollection"]);
  assert.match(mixed[0]!.message, /Loft and Home/);
});

test("noRepeatMoveBackToBack: the same move twice in a row warns, apart it does not", () => {
  const twice = tasteWarnings(plan([LOFT(2), LOFT(3), LOFT(6), LOFT(4)].map((scene) => ({ scene, seconds: 3 }))), C);
  assert.deepEqual(codes(twice), ["noRepeatMoveBackToBack"]);
  assert.match(twice[0]!.message, /Clips 2 and 3 are both Orbit/);
  // Orbit, Push In, Orbit: apart, so only the clip count (five) warns.
  assert.deepEqual(codes(tasteWarnings(plan([LOFT(2), LOFT(3), LOFT(1), LOFT(6), LOFT(4)].map((scene) => ({ scene, seconds: 3 }))), C)), ["maxClips"]);
});

test("avoidPairs: an avoided pair in that order warns", () => {
  const pair = tasteWarnings(plan([LOFT(2), LOFT(3), LOFT(5), LOFT(4)].map((scene) => ({ scene, seconds: 3 }))), C);
  assert.deepEqual(codes(pair), ["avoidPairs"]);
  assert.match(pair[0]!.message, /Clip 2 \(Orbit\) cuts into clip 3 \(Wide Orbit\)/);
  // Rise into Low Arc is not in the served pairs: no warning.
  assert.deepEqual(tasteWarnings(plan([LOFT(2), LOFT(3), LOFT(1), LOFT(4)].map((scene) => ({ scene, seconds: 3 }))), C), []);
});

test("goodAs: a scene the designer keeps out of films warns with its note, also for one video per scene", () => {
  const phone = (clips: string[], extra: Partial<Plan> = {}) => plan(clips.map((scene) => ({ scene, seconds: 4 })), { device: "iPhone", aspect: "9:16", ...extra });
  const kept = tasteWarnings(phone(["grass-field-iphone-shot-1", "grass-field-iphone-shot-3", "grass-field-iphone-shot-2"]), C);
  assert.deepEqual(codes(kept), ["goodAs"]);
  assert.match(kept[0]!.message, /Clip 2 \(grass-field-iphone-shot-3\) is a scene the designer keeps out of films: The designer keeps this overhead/);
  assert.deepEqual(tasteWarnings(phone(["grass-field-iphone-shot-1", "grass-field-iphone-shot-2"]), C), []);
  // delivery "scenes" is one video per clip: the film rules do not apply, the scene rule does.
  assert.deepEqual(codes(tasteWarnings(phone(["grass-field-iphone-shot-3", "grass-field-iphone-shot-3"], { delivery: "scenes" }), C)), ["goodAs", "goodAs"]);
  assert.deepEqual(tasteWarnings(plan([LOFT(3), LOFT(6)], { delivery: "scenes" }), C), []);
});

test("unknown scenes are the problems' business, not taste's", () => {
  assert.deepEqual(tasteWarnings(plan(["nope", { scene: LOFT(2), seconds: 4 }, { scene: LOFT(4), seconds: 4 }]), C), []);
});

// ---- Old and new sites ----

test("an unknown rule type is ignored, with one line saying so", () => {
  const value = structuredClone(GUIDED) as any;
  value.taste.noBlueScreens = true;
  value.taste.maxClips = "six";
  const c = catalog(value);
  assert.equal(c.taste!.maxClips, undefined);
  assert.equal(c.taste!.oneCollection, true);
  assert.deepEqual(c.ignored, [
    'the site\'s taste rule "maxClips" has a value this adapter cannot read; it is ignored.',
    'the site\'s taste rule "noBlueScreens" is not one this adapter knows; it is ignored.',
  ]);
  // The other rules still apply, and the unknown one changes nothing.
  assert.deepEqual(codes(tasteWarnings(plan([{ scene: LOFT(3), seconds: 4 }, { scene: LOFT(2), seconds: 4 }]), c)), ["openers"]);
});

test("an older site's catalog, without guidance, still works: no warnings, no notes, no suggestions", () => {
  const c = catalog(oldCatalog());
  for (const key of ["moves", "collectionNotes", "taste", "recipes", "toolText", "ignored"]) assert.equal(key in c, false, key);
  assert.equal(c.scenes[0]!.notes, undefined);
  // Every rule needs its value: a plan that warns on the new site is quiet here.
  const p = plan([LOFT(3), LOFT(6), "home-xdr-shot-2"]);
  assert.ok(tasteWarnings(p, C).length >= 3);
  assert.deepEqual(tasteWarnings(p, c), []);
  // The enforced previews need only the rules every catalog has.
  assert.deepEqual(codes(checkPlan(plan([{ scene: LOFT(1), seconds: 9 }]), c).problems), ["seconds"]);
  const s = suggest({ goal: "launch", device: "Display" }, c);
  assert.ok(s.ok);
  assert.deepEqual(s.value.suggestions, []);
  assert.match(s.value.note!, /no suggestions/);
  const listed = scenesWithNotes(c.scenes, c);
  assert.deepEqual(Object.keys(listed), ["scenes"]);
});

test("a newer site's extra fields are ignored and never reach a result", () => {
  const value = structuredClone(GUIDED) as any;
  value.mood = "new top-level field";
  value.scenes[0].mood = "warm";
  value.scenes[0].notes.lens = "35mm";
  value.moves["Push In"].lens = "35mm";
  value.collectionNotes.Loft.season = "winter";
  value.recipes[0].music = "soft";
  value.recipes[0].clips[0].transition = "cut";
  value.toolText.future_tool = "Text for a tool this adapter does not have.";
  const c = catalog(value);
  const text = JSON.stringify([c.scenes, c.moves, c.collectionNotes, c.recipes]);
  for (const word of ["mood", "warm", "lens", "35mm", "season", "music", "transition"]) assert.doesNotMatch(text, new RegExp(word));
  assert.equal("mood" in c, false);
  assert.equal(c.ignored, undefined, "extra fields are not worth a line on stderr");
  assert.equal(c.recipes!.length, GUIDED.recipes.length);
  assert.deepEqual(c.scenes[0]!.notes, GUIDED.scenes[0]!.notes);
});

test("guidance of the wrong type is dropped piece by piece; the catalog stays good", () => {
  const value = structuredClone(GUIDED) as any;
  value.scenes[0].notes = "not notes";
  value.scenes[1].notes.goodAs = "opener";
  value.moves = [1, 2];
  value.taste = "strict";
  value.recipes[1] = { id: "broken" };
  value.toolText.render = 42;
  value.toolText.still = "x".repeat(MAX_TOOL_TEXT + 1);
  value.toolText.account = "  ";
  const c = catalog(value);
  assert.equal(c.scenes[0]!.notes, undefined);
  assert.equal(c.scenes[1]!.notes!.goodAs, undefined);
  assert.equal(c.scenes[1]!.notes!.move, "Low Arc");
  assert.equal(c.moves, undefined);
  assert.equal(c.taste, undefined);
  assert.deepEqual(
    c.recipes!.map((r) => r.id),
    GUIDED.recipes.filter((_, i) => i !== 1).map((r) => r.id),
  );
  assert.deepEqual(Object.keys(c.toolText!), ["list_scenes", "check_plan"]);
  assert.equal(c.ignored!.length, 5);
  assert.match(c.ignored!.join("\n"), /taste rules are not an object/);
  assert.match(c.ignored!.join("\n"), /1 of the site's recipes could not be read/);
  assert.match(c.ignored!.join("\n"), /description of render is not text/);
  assert.match(c.ignored!.join("\n"), /description of still is 2001 characters, more than 2000/);
  assert.match(c.ignored!.join("\n"), /description of account is empty/);
});

test("catalog text is capped: notes at 500 characters, recipe titles and whys at 300", () => {
  const value = structuredClone(GUIDED) as any;
  value.scenes[0].notes.note = "n".repeat(5_000);
  value.moves["Push In"].framing = "f".repeat(5_000);
  value.collectionNotes.Loft.light = "l".repeat(5_000);
  value.recipes[0].title = "t".repeat(5_000);
  value.recipes[0].why = "w".repeat(5_000);
  const c = catalog(value);
  assert.equal(c.scenes[0]!.notes!.note!.length, NOTE_CHARS);
  assert.ok(c.scenes[0]!.notes!.note!.endsWith("…"));
  assert.equal(c.moves!["Push In"]!.framing!.length, NOTE_CHARS);
  assert.equal(c.collectionNotes!.Loft!.light!.length, NOTE_CHARS);
  assert.equal(c.recipes![0]!.title.length, TITLE_CHARS);
  assert.equal(c.recipes![0]!.why.length, TITLE_CHARS);
});

test("catalog names are capped at 100 characters: a scene's id, title and collection, a device, moves, goals and roles", () => {
  const long = (c: string) => c.repeat(5_000);
  const value = structuredClone(GUIDED) as any;
  Object.assign(value.scenes[0], { id: long("i"), title: long("t"), collection: long("c"), device: long("d") });
  value.devices[0].device = long("D");
  value.scenes[1].notes.move = long("m");
  value.scenes[1].notes.pace = long("p");
  value.scenes[1].notes.screenDetail = long("s");
  value.scenes[1].notes.goodAs = [long("g")];
  value.moves[long("M")] = { framing: "Long name." };
  value.moves.Orbit.pairsAfter = [long("a")];
  value.collectionNotes[long("C")] = { light: "Long place." };
  value.taste.openers = [long("o")];
  value.taste.closers = [long("x")];
  value.taste.avoidPairs = [[long("y"), long("z")]];
  Object.assign(value.recipes[0], { id: long("r"), goal: long("G") });
  value.recipes[0].clips[0].move = long("v");
  const c = catalog(value);
  const capped = (text: string | undefined, what: string) => {
    assert.equal(text?.length, NAME_CHARS, what);
    assert.ok(text!.endsWith("…"), what);
  };
  assert.equal(NAME_CHARS, 100);
  const [scene] = c.scenes;
  for (const field of ["id", "title", "collection", "device"] as const) capped(scene![field], `scene ${field}`);
  capped(c.devices[0]!.device, "device");
  for (const field of ["move", "pace", "screenDetail"] as const) capped(c.scenes[1]!.notes![field], `notes ${field}`);
  capped(c.scenes[1]!.notes!.goodAs![0], "a goodAs role");
  capped(Object.keys(c.moves!).find((m) => m.startsWith("MMM")), "a move's name");
  capped(c.moves!.Orbit!.pairsAfter![0], "a move named in pairsAfter");
  capped(Object.keys(c.collectionNotes!).find((m) => m.startsWith("CCC")), "a collection's name");
  capped(c.taste!.openers![0], "an opener");
  capped(c.taste!.closers![0], "a closer");
  for (const name of c.taste!.avoidPairs![0]!) capped(name, "an avoided pair");
  capped(c.recipes![0]!.id, "a recipe id");
  capped(c.recipes![0]!.goal, "a recipe goal");
  capped(c.recipes![0]!.clips[0]!.move, "a recipe move");
});

test("catalog lists are capped: device tips at 20 of 300 characters, roles and pairs at 50, a recipe of more than 50 clips dropped", () => {
  const value = structuredClone(GUIDED) as any;
  value.devices[0].tips = Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(1_000, "t"));
  value.scenes[0].notes.goodAs = Array.from({ length: 80 }, (_, i) => `role ${i}`);
  value.moves.Orbit.avoidWith = Array.from({ length: 80 }, (_, i) => `move ${i}`);
  value.recipes[0].clips = Array.from({ length: LIST_ITEMS + 1 }, () => ({ move: "Low Arc", seconds: 1 }));
  const c = catalog(value);
  assert.equal(TIP_CHARS, 300);
  assert.equal(TIPS_MAX, 20);
  const { tips } = c.devices[0]!;
  assert.equal(tips.length, TIPS_MAX);
  for (const tip of tips) assert.equal(tip.length, TIP_CHARS);
  assert.ok(tips[0]!.startsWith("0") && tips[0]!.endsWith("…"));
  assert.ok(tips[19]!.startsWith("19"), "the first 20, in order");
  assert.equal(LIST_ITEMS, 50);
  assert.equal(c.scenes[0]!.notes!.goodAs!.length, LIST_ITEMS);
  assert.equal(c.moves!.Orbit!.avoidWith!.length, LIST_ITEMS);
  assert.equal(c.recipes!.length, GUIDED.recipes.length - 1, "the recipe of 51 clips is not suggested");
  assert.match(c.ignored!.join("\n"), /1 of the site's recipes could not be read/);
  // A device keeps only the fields the adapter knows.
  const extra = structuredClone(GUIDED) as any;
  extra.devices[0].secret = "never passed on";
  assert.doesNotMatch(JSON.stringify(catalog(extra).devices), /secret/);
});

test("taste values that make no sense are dropped, each with one line saying so", () => {
  const unreadable = (key: string) => `the site's taste rule "${key}" has a value this adapter cannot read; it is ignored.`;
  const bad: [string, unknown][] = [
    ["filmSeconds", [20, 6]],
    ["filmSeconds", [0, 20]],
    ["filmSeconds", [-5, 20]],
    ["filmSeconds", [6]],
    ["maxClips", 0],
    ["maxClips", -2],
    ["maxClips", 2.5],
    ["openers", []],
    ["closers", []],
  ];
  for (const [key, v] of bad) {
    const value = structuredClone(GUIDED) as any;
    value.taste[key] = v;
    const c = catalog(value);
    assert.equal((c.taste as any)[key], undefined, `${key} ${JSON.stringify(v)}`);
    assert.deepEqual(c.ignored, [unreadable(key)], `${key} ${JSON.stringify(v)}`);
    // The other rules still apply.
    assert.equal(c.taste!.oneCollection, true);
  }
  // At the edges they are good: one length for the whole film, a single clip.
  const edge = structuredClone(GUIDED) as any;
  Object.assign(edge.taste, { filmSeconds: [8, 8], maxClips: 1 });
  const c = catalog(edge);
  assert.deepEqual(c.taste!.filmSeconds, [8, 8]);
  assert.equal(c.taste!.maxClips, 1);
  assert.equal(c.ignored, undefined);
  // No opener list: no opener warning (an empty one would have warned on every film).
  const open = structuredClone(GUIDED) as any;
  open.taste.openers = [];
  assert.deepEqual(codes(tasteWarnings(plan([{ scene: LOFT(3), seconds: 4 }, { scene: LOFT(2), seconds: 4 }]), catalog(open))), []);
});

test("a warning names at most 12 moves or collections, then how many more", () => {
  const value = structuredClone(GUIDED) as any;
  value.taste.openers = Array.from({ length: 15 }, (_, i) => `Move ${i + 1}`);
  const [w] = tasteWarnings(plan([{ scene: LOFT(3), seconds: 4 }, { scene: LOFT(2), seconds: 4 }]), catalog(value));
  assert.equal(w!.code, "openers");
  assert.match(w!.fix, /Move 12 or 3 more,/);
  assert.doesNotMatch(w!.fix, /Move 13/);
});

test("check_plan: a device off only in its case is named as it is spelt", () => {
  const base: Plan = { contract: 1, device: "Display", aspect: "16:9", clips: [{ scene: LOFT(1) }] };
  const [wrongCase] = planProblems({ ...base, device: "display" }, C);
  assert.equal(wrongCase!.code, "device");
  assert.match(wrongCase!.fix, /Write it as "Display"/);
  assert.match(planProblems({ ...base, device: "IPHONE" }, C)[0]!.fix, /"iPhone"/);
  // A device that is not one at all gets the list.
  assert.equal(planProblems({ ...base, device: "Watch" }, C)[0]!.fix, "Use one of: Display, iPhone.");
});

// ---- Enforced rules: check_plan's problems are the page's refusals ----

/**
 * The sample table with the codes the page gives (the app's parsePlan, then planToMockup), as
 * run against motion-mockups-app 73834f6. Codes from the shape are the tools' input schema's to
 * refuse (`schema`); the rest are check_plan's problems.
 */
const base: Plan = { contract: 1, device: "Display", aspect: "16:9", clips: [{ scene: LOFT(1) }] };
const one = (clip: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ ...base, clips: [{ scene: LOFT(1), ...clip }], ...extra });
const TABLE: { name: string; plan: unknown; page: string[]; schema?: true }[] = [
  { name: "a good plan", plan: base, page: [] },
  {
    name: "every option",
    plan: { ...base, size: 2160, delivery: "scenes", speedRamp: 50, reflections: 50, hideNotch: true, keepStatusBar: true, background: { top: "#f4efe6", bottom: "#101010" } },
    page: [],
  },
  { name: "unknown device", plan: { ...base, device: "Watch" }, page: ["device"] },
  { name: "device in the wrong case", plan: { ...base, device: "display" }, page: ["device"] },
  { name: "unknown aspect", plan: { ...base, aspect: "21:9" }, page: ["aspect"] },
  { name: "unknown size", plan: { ...base, size: 720 }, page: ["size"] },
  { name: "unknown scene", plan: { ...base, clips: [{ scene: "showroom-xdr-shot-99" }] }, page: ["scene"] },
  { name: "another device's scene", plan: { ...base, clips: [{ scene: LOFT(1) }, { scene: "showroom-iphone-shot-1" }] }, page: ["scene"] },
  { name: "too short", plan: one({ seconds: 0.5 }), page: ["seconds"] },
  { name: "just under a second rounds to a short frame count", plan: one({ seconds: 0.99 }), page: ["seconds"] },
  { name: "a hair under a second rounds up to it", plan: one({ seconds: 0.995 }), page: [] },
  { name: "the whole scene", plan: one({ seconds: 8 }), page: [] },
  { name: "longer than the scene", plan: one({ seconds: 8.5 }), page: ["seconds"] },
  { name: "the whole scene under ramp 100", plan: one({ seconds: 8 }, { speedRamp: 100 }), page: ["seconds"] },
  { name: "the ramped length under ramp 100", plan: one({ seconds: 4 }, { speedRamp: 100 }), page: [] },
  { name: "the ramped length under ramp 50", plan: one({ seconds: 6 }, { speedRamp: 50 }), page: [] },
  { name: "past the ramped length under ramp 50", plan: one({ seconds: 6.5 }, { speedRamp: 50 }), page: ["seconds"] },
  { name: "a colour that is not #rrggbb", plan: { ...base, background: { top: "red", bottom: "#000000" } }, page: ["background"] },
  { name: "a bad device stops before the scenes", plan: { ...base, device: "Watch", clips: [{ scene: "nope" }] }, page: ["device"] },
  { name: "reversed and cropped", plan: one({ seconds: 3, reversed: true, crop: { x: 0.5, y: 0.5, zoom: 2 } }), page: [] },
  { name: "an unknown field", plan: { ...base, fps: 30 }, page: ["unknown-field"], schema: true },
  { name: "another contract", plan: { ...base, contract: 2 }, page: ["contract"], schema: true },
  { name: "an unknown delivery", plan: { ...base, delivery: "gif" }, page: ["delivery"], schema: true },
  { name: "an unknown ramp", plan: { ...base, speedRamp: 75 }, page: ["speedRamp"], schema: true },
  { name: "seconds as text", plan: one({ seconds: "3" }), page: ["seconds"], schema: true },
];

test("check_plan's problems match the page's refusals for the sample table", () => {
  for (const { name, plan: value, page, schema } of TABLE) {
    const parsed = planSchema.safeParse(value);
    if (schema) {
      assert.equal(parsed.success, false, `${name}: the input schema refuses it, as the page does`);
      continue;
    }
    assert.ok(parsed.success, `${name}: the input schema takes it`);
    const result = checkPlan(parsed.data, C);
    assert.deepEqual(codes(result.problems), page, name);
    assert.equal(result.ok, page.length === 0, name);
    for (const p of result.problems) assert.ok(p.message && p.fix, `${name}: ${p.code} says how to fix it`);
  }
});

test("seconds problems name the longest the scene can run, under the ramp in force", () => {
  assert.equal(maxClipSeconds({ seconds: 8 } as any, 60, undefined), 8);
  assert.equal(maxClipSeconds({ seconds: 8 } as any, 60, 100), 4);
  assert.equal(maxClipSeconds({ seconds: 8 } as any, 60, 50), 6);
  // A short scene under the ramp is all speed-up (app src/sequence.ts outputFrames).
  assert.equal(maxClipSeconds({ seconds: 2 } as any, 60, 100), Math.ceil((120 * 72) / 192) / 60);
  const [p] = planProblems(one({ seconds: 5 }, { speedRamp: 100 }) as Plan, C);
  assert.match(p!.message, /showroom-xdr-shot-1: This scene can run to 4\.0 s with speedRamp 100/);
  assert.match(p!.fix, /between 1 s and 4\.0 s/);
});

test("check_plan gives problems and warnings together; ok only without problems", () => {
  const both = checkPlan(plan([{ scene: LOFT(3), seconds: 9 }, { scene: LOFT(2), seconds: 4 }]), C);
  assert.equal(both.ok, false);
  assert.deepEqual(codes(both.problems), ["seconds"]);
  assert.deepEqual(codes(both.warnings), ["openers"]);
  const taste = checkPlan(plan([{ scene: LOFT(3), seconds: 4 }, { scene: LOFT(2), seconds: 4 }]), C);
  assert.equal(taste.ok, true, "a warning is not a problem");
  assert.deepEqual(codes(taste.warnings), ["openers"]);
});

// ---- suggest_sequence ----

test("suggest_sequence filters by goal, device and collection, from the site's resolved scenes", () => {
  const all = suggest({ goal: "launch", device: "display" }, C);
  assert.ok(all.ok);
  assert.deepEqual(
    all.value.suggestions.map((s) => [s.recipe, s.collection]),
    [
      ["launch-display-low-arc-push-in", "Home"],
      ["launch-display-push-in-orbit-low-arc", "Loft"],
    ],
  );
  const [home] = all.value.suggestions;
  assert.equal(home!.title, "Low open, push to finish");
  assert.match(home!.why, /designer's films/);
  assert.equal(home!.seconds, 10);
  // The plan: the recipe's aspect, the site's scene ids and the recipe's seconds, clip by clip.
  assert.deepEqual(home!.plan, {
    contract: 1,
    device: "Display",
    aspect: "4:5",
    clips: [
      { scene: "home-xdr-shot-4", seconds: 5 },
      { scene: "home-xdr-shot-2", seconds: 5 },
    ],
  });
  // Every suggestion is a plan the page takes, with no taste warning.
  for (const s of all.value.suggestions) assert.deepEqual(checkPlan(s.plan, C), { ok: true, problems: [], warnings: [] });

  const loft = suggest({ goal: "Launch", device: "Display", collection: "loft" }, C);
  assert.ok(loft.ok);
  assert.deepEqual(
    loft.value.suggestions.map((s) => s.recipe),
    ["launch-display-push-in-orbit-low-arc"],
  );
  const portfolio = suggest({ goal: "portfolio", device: "Display" }, C);
  assert.ok(portfolio.ok);
  assert.deepEqual(
    portfolio.value.suggestions.map((s) => s.recipe),
    ["portfolio-display-push-in-low-arc"],
  );
  const phone = suggest({ goal: "launch", device: "iPhone" }, C);
  assert.ok(phone.ok);
  assert.deepEqual(
    phone.value.suggestions.map((s) => s.collection),
    ["Meadow"],
  );
  // A collection the recipe has no resolution for gets none of it.
  const none = suggest({ goal: "portfolio", device: "Display", collection: "Home" }, C);
  assert.ok(none.ok);
  assert.deepEqual(none.value.suggestions, []);
  assert.match(none.value.note!, /No portfolio sequence for Display in Home/);
});

test("suggest_sequence: another aspect keeps the recipe's, with a note, after those in it; seconds rank by nearness", () => {
  const square = suggest({ goal: "launch", device: "Display", aspect: "16:9" }, C);
  assert.ok(square.ok);
  const [first, second] = square.value.suggestions;
  assert.equal(first!.recipe, "launch-display-push-in-orbit-low-arc");
  assert.equal(first!.note, undefined);
  assert.equal(second!.plan.aspect, "4:5", "the designer's aspect is kept");
  assert.match(second!.note!, /framed this sequence for 4:5\. For 16:9, set the plan's aspect to 16:9/);
  const near = suggest({ goal: "launch", device: "Display", seconds: 10 }, C);
  assert.ok(near.ok);
  assert.deepEqual(
    near.value.suggestions.map((s) => s.seconds),
    [10, 10],
  );
  const recipes = Array.from({ length: 9 }, (_, i) => ({ ...GUIDED.recipes[0], id: `r${i}`, clips: GUIDED.recipes[0]!.clips.map((c) => ({ ...c, seconds: 3 + i / 2 })) }));
  const many = catalog({ ...GUIDED, recipes });
  const ranked = suggest({ goal: "launch", device: "Display", seconds: 12 }, many);
  assert.ok(ranked.ok);
  assert.equal(ranked.value.suggestions.length, MAX_SUGGESTIONS);
  assert.deepEqual(
    ranked.value.suggestions.map((s) => s.seconds),
    [12, 11, 13, 10, 14, 9],
  );
  assert.match(ranked.value.note!, /3 more fit/);
});

test("suggest_sequence never offers a wrong scene: a resolution that does not fit the catalog is skipped", () => {
  const value = structuredClone(GUIDED) as any;
  // A scene of another move, a missing scene, the wrong count.
  value.recipes[0].resolved = { Home: ["home-xdr-shot-2", "home-xdr-shot-4"] };
  value.recipes[1].resolved = { Loft: ["showroom-xdr-shot-1", "gone", "showroom-xdr-shot-2"] };
  value.recipes[2].resolved = { Loft: ["showroom-xdr-shot-1"] };
  const c = catalog(value);
  for (const goal of ["launch", "portfolio"]) {
    const s = suggest({ goal, device: "Display" }, c);
    assert.ok(s.ok);
    assert.deepEqual(s.value.suggestions, [], goal);
  }
});

test("suggest_sequence reads a goal with spaces or hyphens and in any case", () => {
  const value = structuredClone(GUIDED) as any;
  value.recipes[0].goal = "case-study";
  const c = catalog(value);
  const ids = (goal: string) => {
    const s = suggest({ goal, device: "Display" }, c);
    assert.ok(s.ok, `${goal}: ${JSON.stringify(s)}`);
    return s.value.suggestions.map((x) => x.recipe);
  };
  for (const goal of ["case-study", "case study", "Case Study", " CASE-study "])
    assert.deepEqual(ids(goal), ["launch-display-low-arc-push-in"], goal);
});

test("suggest_sequence refuses an unknown device, goal, aspect or collection with the ones there are", () => {
  const refusal = (input: Parameters<typeof suggest>[0]) => {
    const s = suggest(input, C);
    assert.equal(s.ok, false);
    return (s as { problems: { code: string; fix: string }[] }).problems[0]!;
  };
  assert.equal(refusal({ goal: "launch", device: "Watch" }).code, "device");
  const goal = refusal({ goal: "wedding", device: "Display" });
  assert.equal(goal.code, "goal");
  assert.match(goal.fix, /launch, portfolio/);
  assert.equal(refusal({ goal: "launch", device: "Display", aspect: "21:9" }).code, "aspect");
  const place = refusal({ goal: "launch", device: "Display", collection: "Meadow" });
  assert.equal(place.code, "collection");
  assert.match(place.fix, /Loft, Home/);
});

// ---- list_scenes ----

test("list_scenes' notes: each listed move and collection once, only those listed", () => {
  const phone = C.scenes.filter((s) => s.device === "iPhone");
  const listed = scenesWithNotes(phone, C);
  assert.deepEqual(Object.keys(listed.moves!).sort(), ["Orbit", "Overhead", "Push In", "Square Up"]);
  assert.deepEqual(Object.keys(listed.collectionNotes!).sort(), ["Loft", "Meadow"]);
  assert.deepEqual(listed.moves!.Orbit, GUIDED.moves.Orbit);
  assert.equal(listed.scenes[0]!.notes!.move, "Push In");
  // Display has two Orbit scenes: one copy of Orbit's notes.
  const display = scenesWithNotes(C.scenes.filter((s) => s.device === "Display"), C);
  assert.equal(JSON.stringify(display).split('"Circles."').length - 1, 1);
});
