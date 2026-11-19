import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { describeWindow, parseForeground } from "../scripts/foreground.mjs";

const E2E = fs.readFileSync(new URL("../scripts/e2e.mjs", import.meta.url), "utf8");

test("e2e foreground log: ownership by this run's Chrome pids or the test window's handle, never by a name", () => {
  const own = { pids: [4242, 4243], hwnd: "777" };
  // This run's Chrome, by pid.
  assert.deepEqual(parseForeground("10\t101\t4242\tchrome", own), { at: "10", hwnd: "101", pid: 4242, name: "chrome", ours: true });
  // The test window, by its handle.
  assert.equal(parseForeground("ready\t777\t9000\tpowershell", own).ours, true);
  // The person's own Chrome is another app, whatever it is called.
  const theirs = parseForeground("20\t102\t5000\tchrome", own);
  assert.deepEqual(theirs, { at: "20", hwnd: "102", name: "<another app>", ours: false });
  assert.equal(describeWindow(theirs), "<another app>");
  assert.equal(describeWindow(parseForeground("10\t101\t4242\tchrome", own)), "chrome/4242");
});

test("e2e foreground log: no window title is ever kept", () => {
  const own = { pids: [4242], hwnd: "777" };
  for (const line of ["30\t103\t5000\tchrome\tMy bank - Google Chrome", "40\t101\t4242\tchrome\tsecret tab"]) {
    const w = parseForeground(line, own);
    assert.ok(!JSON.stringify(w).includes("bank") && !JSON.stringify(w).includes("secret"), JSON.stringify(w));
    assert.ok(!("title" in w));
  }
  // The watcher never reads titles, and the summary prints none.
  assert.doesNotMatch(E2E, /GetWindowText/);
  assert.doesNotMatch(E2E, /\.title\b/);
  assert.match(E2E, /from "\.\/foreground\.mjs"/);
});
