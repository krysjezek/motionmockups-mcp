import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_ORIGIN, siteOrigin } from "../src/origin.ts";

const origin = (value?: string) => siteOrigin(value === undefined ? {} : { MOTIONMOCKUPS_ORIGIN: value });

test("origin: the default is the public site", () => {
  const result = siteOrigin({});
  assert.ok(result.ok);
  assert.equal(result.value.href, "https://motionmockups.com/");
  assert.equal(DEFAULT_ORIGIN, "https://motionmockups.com");
  // An empty or blank setting is no setting.
  for (const blank of ["", "  "]) {
    const r = origin(blank);
    assert.ok(r.ok);
    assert.equal(r.value.href, "https://motionmockups.com/");
  }
});

test("origin: a local preview or a Vercel preview of the site is accepted", () => {
  for (const [given, expected] of [
    ["http://127.0.0.1:4173", "http://127.0.0.1:4173"],
    ["http://localhost:5173", "http://localhost:5173"],
    ["http://localhost:5173/", "http://localhost:5173"],
    ["https://motion-mockups-k7te7knkw-krystofjezeks-projects.vercel.app", "https://motion-mockups-k7te7knkw-krystofjezeks-projects.vercel.app"],
    ["https://motionmockups.com", "https://motionmockups.com"],
  ] as const) {
    const r = origin(given);
    assert.ok(r.ok, given);
    assert.equal(r.value.origin, expected, given);
  }
});

test("origin: anything else is refused with code origin", () => {
  for (const given of [
    "https://evil.com",
    "http://motionmockups.com",
    "https://motion-mockups.vercel.app.evil.com",
    "file:///x",
    "https://motion-mockups.vercel.app",
    "https://evil-motion-mockups-abc.vercel.app",
    "http://motion-mockups-abc.vercel.app",
    "https://motion-mockups-abc.vercel.app:8443",
    "https://127.0.0.1:4173",
    "http://127.0.0.2:4173",
    "http://user:pass@127.0.0.1:4173",
    "http://127.0.0.1:4173/agent",
    "http://127.0.0.1:4173/?x=1",
    "https://www.motionmockups.com",
    "not a url",
    "127.0.0.1:4173",
  ]) {
    const r = origin(given);
    assert.equal(r.ok, false, given);
    if (r.ok) continue;
    assert.equal(r.problems.length, 1);
    assert.equal(r.problems[0]!.code, "origin", given);
    assert.match(r.problems[0]!.fix, /MOTIONMOCKUPS_ORIGIN/);
  }
});

test("origin: a Vercel host is accepted only with the owner's team suffix", () => {
  for (const given of [
    // Deployment URLs as app docs/deployment.md records them: a 9-character id.
    "https://motion-mockups-k7te7knkw-krystofjezeks-projects.vercel.app",
    "https://motion-mockups-5uc208zjc-krystofjezeks-projects.vercel.app",
    "https://motion-mockups-5r4lpz2ip-krystofjezeks-projects.vercel.app",
    // Branch URLs: <project>-git-<branch>-<scope>.
    "https://motion-mockups-app-git-main-krystofjezeks-projects.vercel.app",
    "https://motion-mockups-app-git-fix-wave-2-krystofjezeks-projects.vercel.app",
  ]) {
    const r = origin(given);
    assert.ok(r.ok, given);
  }
  for (const given of [
    "https://motion-mockups-evil.vercel.app",
    "https://motion-mockups-abc-otherteam.vercel.app",
    "https://motion-mockups-app.vercel.app",
    "https://motion-mockups-krystofjezeks-projects.vercel.app",
    "https://motion-mockups-abc-krystofjezeks-projects-x.vercel.app",
    "https://motion-mockups-abc-xkrystofjezeks-projects.vercel.app",
    // Only the two shapes Vercel gives the owner's previews.
    "https://motion-mockups-abc-krystofjezeks-projects.vercel.app",
    "https://motion-mockups-k7te7knkw0-krystofjezeks-projects.vercel.app",
    "https://motion-mockups-evil-preview-krystofjezeks-projects.vercel.app",
    "https://motion-mockups-git-main-krystofjezeks-projects.vercel.app",
    "https://motion-mockups-app-krystofjezeks-projects.vercel.app",
  ]) {
    const r = origin(given);
    assert.equal(r.ok, false, given);
    if (!r.ok) assert.equal(r.problems[0]!.code, "origin", given);
  }
});

test("origin: a loopback origin needs its own port, never the default one", () => {
  for (const given of ["http://localhost", "http://127.0.0.1", "http://localhost:80", "http://127.0.0.1:80/"]) {
    const r = origin(given);
    assert.equal(r.ok, false, given);
    if (r.ok) continue;
    assert.equal(r.problems[0]!.code, "origin", given);
    assert.match(r.problems[0]!.message, /port/, given);
    assert.match(r.problems[0]!.fix, /:<port>/, given);
  }
});
