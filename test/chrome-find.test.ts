import { test } from "node:test";
import assert from "node:assert/strict";

import { findChrome } from "../src/chrome/find.ts";

const only = (...paths: string[]) => (p: string) => paths.includes(p);

const WIN_ENV = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
};
const WIN = {
  programFiles: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  x86: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  local: "C:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
};
const MAC = {
  system: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  user: "/Users/ada/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
};

test("Windows: the first existing standard path, in order", () => {
  assert.deepEqual(findChrome(WIN_ENV, "win32", only(WIN.programFiles, WIN.x86, WIN.local)), { ok: true, value: WIN.programFiles });
  assert.deepEqual(findChrome(WIN_ENV, "win32", only(WIN.x86, WIN.local)), { ok: true, value: WIN.x86 });
  assert.deepEqual(findChrome(WIN_ENV, "win32", only(WIN.local)), { ok: true, value: WIN.local });
});

test("Windows: environment names are looked up without regard to case", () => {
  const env = { PROGRAMFILES: "C:\\Program Files" };
  assert.deepEqual(findChrome(env, "win32", only(WIN.programFiles)), { ok: true, value: WIN.programFiles });
});

test("Windows: the MCP SDK's reduced environment still finds Program Files (x86)", () => {
  // What @modelcontextprotocol/sdk's stdio client passes by default on Windows: no ProgramFiles(x86).
  const sdkEnv = {
    APPDATA: "C:\\Users\\ada\\AppData\\Roaming",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\ada",
    LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
    PATH: "C:\\Windows\\system32",
    PROCESSOR_ARCHITECTURE: "AMD64",
    SYSTEMDRIVE: "C:",
    SYSTEMROOT: "C:\\Windows",
    TEMP: "C:\\Users\\ada\\AppData\\Local\\Temp",
    USERNAME: "ada",
    USERPROFILE: "C:\\Users\\ada",
    PROGRAMFILES: "C:\\Program Files",
  };
  assert.deepEqual(findChrome(sdkEnv, "win32", only(WIN.x86)), { ok: true, value: WIN.x86 });
  assert.deepEqual(findChrome(sdkEnv, "win32", only(WIN.x86, WIN.local)), { ok: true, value: WIN.x86 });
  // Another system drive.
  const d = "D:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
  assert.deepEqual(findChrome({ ...sdkEnv, SYSTEMDRIVE: "D:" }, "win32", only(d)), { ok: true, value: d });
});

test("Windows: with no Program Files variables at all, the C: defaults are tried", () => {
  assert.deepEqual(findChrome({}, "win32", only(WIN.programFiles)), { ok: true, value: WIN.programFiles });
  assert.deepEqual(findChrome({}, "win32", only(WIN.x86)), { ok: true, value: WIN.x86 });
});

test("Windows: Chromium is not accepted", () => {
  const chromium = "C:\\Users\\ada\\AppData\\Local\\Chromium\\Application\\chrome.exe";
  assert.equal(findChrome({ ...WIN_ENV, PATH: "C:\\bin" }, "win32", only(chromium, "C:\\bin\\chromium.exe", "C:\\bin\\chromium")).ok, false);
});

test("macOS: /Applications, then ~/Applications", () => {
  const env = { HOME: "/Users/ada" };
  assert.deepEqual(findChrome(env, "darwin", only(MAC.system, MAC.user)), { ok: true, value: MAC.system });
  assert.deepEqual(findChrome(env, "darwin", only(MAC.user)), { ok: true, value: MAC.user });
  assert.equal(findChrome(env, "darwin", only("/usr/local/bin/chromium")).ok, false);
});

test("Linux: google-chrome, google-chrome-stable, chromium, chromium-browser on PATH", () => {
  const env = { PATH: "/usr/local/bin:/usr/bin" };
  assert.deepEqual(findChrome(env, "linux", only("/usr/bin/google-chrome", "/usr/local/bin/chromium")), {
    ok: true,
    value: "/usr/bin/google-chrome",
  });
  assert.deepEqual(findChrome(env, "linux", only("/usr/bin/google-chrome-stable")), { ok: true, value: "/usr/bin/google-chrome-stable" });
  assert.deepEqual(findChrome(env, "linux", only("/usr/bin/chromium", "/usr/bin/chromium-browser")), { ok: true, value: "/usr/bin/chromium" });
  assert.deepEqual(findChrome(env, "linux", only("/usr/local/bin/chromium-browser")), { ok: true, value: "/usr/local/bin/chromium-browser" });
  // The same name earlier on PATH wins.
  assert.deepEqual(findChrome(env, "linux", only("/usr/bin/chromium", "/usr/local/bin/chromium")), { ok: true, value: "/usr/local/bin/chromium" });
});

test("Linux: relative PATH entries are ignored", () => {
  assert.equal(findChrome({ PATH: "bin:/usr/bin" }, "linux", only("bin/google-chrome")).ok, false);
});

test("MOTIONMOCKUPS_CHROME wins over the standard places", () => {
  const custom = "D:\\Portable\\chrome.exe";
  assert.deepEqual(findChrome({ ...WIN_ENV, MOTIONMOCKUPS_CHROME: custom }, "win32", only(custom, WIN.programFiles)), {
    ok: true,
    value: custom,
  });
  assert.deepEqual(findChrome({ MOTIONMOCKUPS_CHROME: "/opt/chrome/chrome", PATH: "/usr/bin" }, "linux", only("/opt/chrome/chrome", "/usr/bin/google-chrome")), {
    ok: true,
    value: "/opt/chrome/chrome",
  });
});

function assertRefusal(result: ReturnType<typeof findChrome>) {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.problems.length, 1);
  const [problem] = result.problems;
  assert.equal(problem.code, "chrome");
  assert.ok(problem.message.length > 0);
  assert.match(problem.fix, /MOTIONMOCKUPS_CHROME/);
  assert.match(problem.fix, /https:\/\/www\.google\.com\/chrome\//);
}

test("a MOTIONMOCKUPS_CHROME that does not exist is refused, not passed over", () => {
  const result = findChrome({ ...WIN_ENV, MOTIONMOCKUPS_CHROME: "D:\\gone\\chrome.exe" }, "win32", only(WIN.programFiles));
  assertRefusal(result);
  if (!result.ok) assert.match(result.problems[0].message, /D:\\gone\\chrome\.exe/);
});

test("a relative MOTIONMOCKUPS_CHROME is refused", () => {
  assertRefusal(findChrome({ MOTIONMOCKUPS_CHROME: "chrome/chrome", PATH: "/usr/bin" }, "linux", () => true));
});

test("no Chrome anywhere gives code chrome naming MOTIONMOCKUPS_CHROME and the download page", () => {
  assertRefusal(findChrome(WIN_ENV, "win32", () => false));
  assertRefusal(findChrome({ HOME: "/Users/ada" }, "darwin", () => false));
  assertRefusal(findChrome({ PATH: "/usr/bin" }, "linux", () => false));
  assertRefusal(findChrome({}, "linux", () => false));
});

// ---- Missing Chrome: the refusal names Chrome and every place it looked (release check) ----

test("missing Chrome: the refusal names Chrome and each place it looked, on every system", () => {
  const message = (result: ReturnType<typeof findChrome>) => {
    assertRefusal(result);
    return result.ok ? "" : result.problems[0]!.message;
  };
  const win = message(findChrome(WIN_ENV, "win32", () => false));
  assert.match(win, /^Google Chrome was not found\./);
  for (const place of Object.values(WIN)) assert.ok(win.includes(place), `${place} in: ${win}`);

  const mac = message(findChrome({ HOME: "/Users/ada" }, "darwin", () => false));
  assert.match(mac, /^Google Chrome was not found\./);
  for (const place of Object.values(MAC)) assert.ok(mac.includes(place), `${place} in: ${mac}`);

  const linux = message(findChrome({ PATH: "/usr/local/bin:/usr/bin" }, "linux", () => false));
  assert.match(linux, /^Google Chrome or Chromium was not found on PATH\./);
  for (const word of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "/usr/local/bin", "/usr/bin"])
    assert.ok(linux.includes(word), `${word} in: ${linux}`);
  // No folder at all to look in is said so, not an empty list.
  assert.match(message(findChrome({ PATH: "" }, "linux", () => false)), /PATH names no folder to look in/);
  // A long PATH is named up to ten folders, then counted.
  const long = message(findChrome({ PATH: Array.from({ length: 14 }, (_, i) => `/d${i}`).join(":") }, "linux", () => false));
  assert.match(long, /\/d9 and 4 more\.$/);
  assert.doesNotMatch(long, /\/d10/);
});

test("missing Chrome: MOTIONMOCKUPS_CHROME pointing nowhere is named, and the standard places are not searched instead", () => {
  const gone = "D:\\gone\\chrome.exe";
  const searched: string[] = [];
  const result = findChrome({ ...WIN_ENV, MOTIONMOCKUPS_CHROME: gone }, "win32", (p) => {
    searched.push(p);
    return p !== gone;
  });
  assertRefusal(result);
  if (!result.ok) {
    assert.ok(result.problems[0]!.message.includes(gone));
    assert.match(result.problems[0]!.fix, /Install Google Chrome/);
  }
  assert.deepEqual(searched, [gone], "only the path the person chose");
});
