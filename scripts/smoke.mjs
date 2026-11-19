// A smoke test of the built bundle as a real MCP server over stdio: copied alone into a
// temporary folder (so it can resolve no package), pointed at a closed local port, it must
// start with the built-in briefing, list its five tools, answer list_scenes with
// code "site", write nothing but MCP messages to stdout and exit on its own when the client
// closes stdin. Run after `npm run build`: `node scripts/smoke.mjs`.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bundle = new URL("../dist/motionmockups.js", import.meta.url);
const folder = mkdtempSync(path.join(os.tmpdir(), "mm-smoke-"));
const copy = path.join(folder, "motionmockups.js");
copyFileSync(bundle, copy);

const port = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [copy, "mcp"],
  cwd: folder,
  env: { ...getDefaultEnvironment(), MOTIONMOCKUPS_ORIGIN: `http://127.0.0.1:${port}`, MOTIONMOCKUPS_DATA: path.join(folder, "data") },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => (stderr += chunk));
const errors = [];
const client = new Client({ name: "smoke", version: "1" });
client.onerror = (error) => errors.push(error);

const results = {};
try {
  const started = performance.now();
  await client.connect(transport);
  results.startMs = Math.round(performance.now() - started);
  const pid = transport.pid;
  assert.match(client.getInstructions() ?? "", /could not be loaded/);
  const { tools } = await client.listTools();
  results.tools = tools.map((t) => t.name).sort();
  assert.deepEqual(results.tools, ["account", "list_scenes", "recording_spec", "render", "still"]);
  const listed = await client.callTool({ name: "list_scenes", arguments: {} });
  assert.equal(listed.isError, true);
  results.listScenes = listed.structuredContent.problems[0];
  assert.equal(results.listScenes.code, "site");
  const account = await client.callTool({ name: "account", arguments: {} });
  assert.equal(account.structuredContent.tier, "free");

  const closing = performance.now();
  await client.close();
  results.closeMs = Math.round(performance.now() - closing);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "the server exited");
  // Within the client's 2 s grace before SIGTERM: it left on its own when stdin closed.
  assert.ok(results.closeMs < 2000, `closed in ${results.closeMs} ms`);
  assert.deepEqual(errors, [], "stdout carried only MCP messages");
  results.stderr = stderr.trim();
  console.log(JSON.stringify({ pass: true, ...results }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ pass: false, error: String(error?.stack ?? error), stderr, errors: errors.map(String), ...results }, null, 2));
  process.exitCode = 1;
  await client.close().catch(() => {});
} finally {
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
