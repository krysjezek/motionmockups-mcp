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
    ["https://motion-mockups-abc-krystofjezeks-projects.vercel.app", "https://motion-mockups-abc-krystofjezeks-projects.vercel.app"],
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
