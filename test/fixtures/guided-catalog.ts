// A catalog with the site's guidance (notes, moves, collection notes, taste, recipes and tool
// text), in the shape the app serves at /agent/catalog.json, cut down to a few real scenes.

import type { AgentCatalog } from "../../src/catalog.ts";

const poster = (n: number) => `https://assets.example/p${n}.webp`;
const notes = (move: string, goodAs: string[], extra: Record<string, unknown> = {}) => ({
  move,
  framing: `The ${move} framing.`,
  pace: "slow",
  screenDetail: "full",
  goodAs,
  reviewed: false,
  ...extra,
});

export const GUIDED = {
  contract: 1,
  briefing: "The guided test briefing.",
  devices: [
    { device: "Display", fps: 60, screen: { width: 3840, height: 2160 }, tips: ["Record 16:9."] },
    { device: "iPhone", fps: 60, screen: { width: 1179, height: 2556 }, tips: ["Record portrait."] },
  ],
  scenes: [
    { id: "showroom-xdr-shot-1", device: "Display", collection: "Loft", title: "Push In", seconds: 8, poster: poster(1), notes: notes("Push In", ["opener"]) },
    { id: "showroom-xdr-shot-2", device: "Display", collection: "Loft", title: "Low Arc", seconds: 8, poster: poster(2), notes: notes("Low Arc", ["opener", "detail", "close"]) },
    { id: "showroom-xdr-shot-3", device: "Display", collection: "Loft", title: "Orbit", seconds: 8, poster: poster(3), notes: notes("Orbit", ["detail"]) },
    { id: "showroom-xdr-shot-4", device: "Display", collection: "Loft", title: "Rise", seconds: 8, poster: poster(4), notes: notes("Rise", ["close"]) },
    { id: "showroom-xdr-shot-5", device: "Display", collection: "Loft", title: "Wide Orbit", seconds: 8, poster: poster(5), notes: notes("Wide Orbit", ["detail"]) },
    { id: "showroom-xdr-shot-6", device: "Display", collection: "Loft", title: "Orbit", seconds: 8, poster: poster(6), notes: notes("Orbit", ["detail"]) },
    { id: "home-xdr-shot-2", device: "Display", collection: "Home", title: "Push In", seconds: 8, poster: poster(7), notes: notes("Push In", ["detail", "close"]) },
    { id: "home-xdr-shot-4", device: "Display", collection: "Home", title: "Low Arc", seconds: 8, poster: poster(8), notes: notes("Low Arc", ["opener", "detail"]) },
    { id: "showroom-iphone-shot-1", device: "iPhone", collection: "Loft", title: "Push In", seconds: 8, poster: poster(9), notes: notes("Push In", ["opener"]) },
    { id: "grass-field-iphone-shot-1", device: "iPhone", collection: "Meadow", title: "Orbit", seconds: 8, poster: poster(10), notes: notes("Orbit", ["opener"]) },
    { id: "grass-field-iphone-shot-2", device: "iPhone", collection: "Meadow", title: "Square Up", seconds: 8, poster: poster(11), notes: notes("Square Up", ["close"]) },
    {
      id: "grass-field-iphone-shot-3",
      device: "iPhone",
      collection: "Meadow",
      title: "Overhead",
      seconds: 8,
      poster: poster(12),
      notes: notes("Overhead", [], { note: "The designer keeps this overhead angle out of films, so use Orbit or Square Up for this phone." }),
    },
  ],
  rules: {
    aspects: ["1:1", "4:3", "16:9", "4:5", "9:16"],
    sizes: [1080, 2160],
    minClipSeconds: 1,
    maxImageSeconds: 900,
    videoTypes: ["video/mp4"],
    imageTypes: ["image/png"],
    delivery: ["film", "scenes"],
  },
  moves: {
    "Push In": { framing: "Straight in.", goodAs: ["opener", "detail", "close"], pairsBefore: ["Low Arc"], pairsAfter: ["Rise"], avoidWith: [], reviewed: false },
    "Low Arc": { framing: "Low and arcing.", goodAs: ["opener", "close"], pairsBefore: [], pairsAfter: ["Push In"], avoidWith: ["Rise"], reviewed: false },
    Orbit: { framing: "Circles.", goodAs: ["opener", "detail"], pairsBefore: [], pairsAfter: ["Push In"], avoidWith: ["Wide Orbit"], reviewed: false },
    "Wide Orbit": { framing: "Circles wide.", goodAs: ["detail"], pairsBefore: [], pairsAfter: [], avoidWith: ["Orbit"], reviewed: false },
    Rise: { framing: "Rises.", goodAs: ["close"], pairsBefore: ["Push In"], pairsAfter: [], avoidWith: ["Low Arc"], reviewed: false },
    "Square Up": { framing: "Squares up.", goodAs: ["close"], pairsBefore: ["Orbit"], pairsAfter: [], avoidWith: [], reviewed: false },
    Overhead: { framing: "From above.", goodAs: [], pairsBefore: [], pairsAfter: [], avoidWith: [], reviewed: false },
  },
  collectionNotes: {
    Loft: { light: "Cool daylight.", setting: "Concrete and oak.", reviewed: false },
    Home: { light: "A low amber sun.", setting: "Walnut and leather.", reviewed: false },
    Meadow: { light: "Open sky.", setting: "Grass.", reviewed: false },
  },
  taste: {
    filmSeconds: [6, 20],
    oneCollection: true,
    noRepeatMoveBackToBack: true,
    openers: ["Low Arc"],
    closers: ["Push In"],
    avoidPairs: [
      ["Orbit", "Wide Orbit"],
      ["Wide Orbit", "Orbit"],
    ],
    maxClips: 4,
  },
  recipes: [
    {
      id: "launch-display-low-arc-push-in",
      goal: "launch",
      device: "Display",
      aspect: "4:5",
      title: "Low open, push to finish",
      why: "Opens low and ends on Push In, as the designer's films do.",
      clips: [
        { move: "Low Arc", seconds: 5 },
        { move: "Push In", seconds: 5 },
      ],
      reviewed: false,
      resolved: { Home: ["home-xdr-shot-4", "home-xdr-shot-2"] },
    },
    {
      id: "launch-display-push-in-orbit-low-arc",
      goal: "launch",
      device: "Display",
      aspect: "16:9",
      title: "Push in, circle, low finish",
      why: "Push In opens and Low Arc closes, as in the designer's Loft film.",
      clips: [
        { move: "Push In", seconds: 4 },
        { move: "Orbit", seconds: 3 },
        { move: "Low Arc", seconds: 3 },
      ],
      reviewed: false,
      resolved: { Loft: ["showroom-xdr-shot-1", "showroom-xdr-shot-3", "showroom-xdr-shot-2"] },
    },
    {
      id: "portfolio-display-push-in-low-arc",
      goal: "portfolio",
      device: "Display",
      aspect: "1:1",
      title: "Push in, then low arc",
      why: "Time on each to show the screen.",
      clips: [
        { move: "Push In", seconds: 5 },
        { move: "Low Arc", seconds: 5 },
      ],
      reviewed: false,
      resolved: { Loft: ["showroom-xdr-shot-1", "showroom-xdr-shot-2"] },
    },
    {
      id: "launch-iphone-orbit-square-up",
      goal: "launch",
      device: "iPhone",
      aspect: "9:16",
      title: "Circle, then square up",
      why: "Orbit opens and Square Up closes.",
      clips: [
        { move: "Orbit", seconds: 5 },
        { move: "Square Up", seconds: 5 },
      ],
      reviewed: false,
      resolved: { Meadow: ["grass-field-iphone-shot-1", "grass-field-iphone-shot-2"] },
    },
  ],
  toolText: {
    list_scenes: "Site text for list_scenes.",
    check_plan: "Site text for check_plan.",
  },
} satisfies AgentCatalog & Record<string, unknown>;

/** The same catalog as an older site serves it: none of the guidance fields. */
export function oldCatalog() {
  const { moves: _m, collectionNotes: _c, taste: _t, recipes: _r, toolText: _x, ...rest } = structuredClone(GUIDED);
  return { ...rest, scenes: rest.scenes.map(({ notes: _n, ...scene }) => scene) };
}
