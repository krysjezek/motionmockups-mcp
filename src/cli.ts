// The command line: `motionmockups mcp` runs the MCP server on stdio; `--version` prints
// the version; anything else prints the usage.
//
// The server's stdout carries only MCP messages, so everything else goes to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { siteOrigin } from "./origin.ts";
import { dataFolder } from "./paths.ts";
import { createServer, settingsFromEnv, type AdapterServer } from "./server.ts";
import { renderOnce } from "./session.ts";
import type { Problem } from "./folders.ts";
import { VERSION as version } from "./version.ts";

const USAGE = `motionmockups ${version}

Usage: motionmockups mcp

Runs the Motion Mockups MCP server on stdio, for an MCP client such as Claude Code, Cursor or Claude Desktop.`;

const log = (line: string) => {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // stderr went with the client; there is no one left to tell.
  }
};

const refuse = (problems: Problem[]) => {
  for (const p of problems) log(`motionmockups: ${p.message}\n  ${p.fix}`);
  process.exitCode = 1;
};

async function mcp(): Promise<void> {
  // Nothing may write to stdout but the transport.
  console.log = console.info = console.debug = console.error;

  // The client closing stdin, closing its end of stdout (EPIPE on a late progress message or
  // answer), or a signal, cancels running renders: Chrome is closed and the lock released
  // before the process ends. A write error is never left uncaught in the middle of that.
  let adapter: AdapterServer | undefined;
  let stopping: Promise<void> | undefined;
  const shutdown = (code: number) => {
    stopping ??= (adapter ? adapter.stop() : Promise.resolve()).finally(() => process.exit(code));
  };
  process.stderr.on("error", () => {});
  process.stdout.on("error", () => shutdown(0));

  // A bad override stops here: never a silent fall back to the public site.
  const origin = siteOrigin(process.env);
  if (!origin.ok) return refuse(origin.problems);
  const settings = settingsFromEnv(process.env);
  if (!settings.ok) return refuse(settings.problems);
  for (const warning of settings.value.warnings) log(`motionmockups: ${warning}`);
  const data = dataFolder(process.env);
  if (!data.ok) return refuse(data.problems);

  adapter = await createServer({
    origin: origin.value,
    env: process.env,
    fetch: globalThis.fetch,
    renderOnce,
    data: data.value,
    chromeMode: settings.value.chromeMode,
    timeoutMs: settings.value.timeoutMs,
    version,
    log,
  });
  // stdout failed during the catalog fetch: the process is already on its way out.
  if (stopping) return;
  process.stdin.once("end", () => shutdown(0));
  process.stdin.once("close", () => shutdown(0));
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));
  if (process.platform !== "win32") process.once("SIGHUP", () => shutdown(129));

  const transport = new StdioServerTransport();
  adapter.server.server.onclose = () => shutdown(0);
  await adapter.server.connect(transport);
}

const [command, ...rest] = process.argv.slice(2);

if (command === "--version" || command === "-v") {
  console.log(version);
} else if (command === "mcp" && rest.length === 0) {
  mcp().catch((error) => {
    log(`motionmockups: the server could not start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
} else {
  log(USAGE);
  process.exitCode = command === undefined || command === "--help" || command === "-h" ? 0 : 1;
}
