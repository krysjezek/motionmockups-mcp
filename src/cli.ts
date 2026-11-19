// The command line: `motionmockups mcp` runs the MCP server on stdio; `--version` prints
// the version; anything else prints the usage.
//
// The server's stdout carries only MCP messages, so everything else goes to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { siteOrigin } from "./origin.ts";
import { dataFolder } from "./paths.ts";
import { createServer, settingsFromEnv } from "./server.ts";
import { renderOnce } from "./session.ts";
import type { Problem } from "./folders.ts";

declare const MOTIONMOCKUPS_VERSION: string;

const version = typeof MOTIONMOCKUPS_VERSION === "string" ? MOTIONMOCKUPS_VERSION : "dev";

const USAGE = `motionmockups ${version}

Usage: motionmockups mcp

Runs the Motion Mockups MCP server on stdio, for an MCP client such as Claude Code, Cursor or Claude Desktop.`;

const log = (line: string) => {
  process.stderr.write(`${line}\n`);
};

const refuse = (problems: Problem[]) => {
  for (const p of problems) log(`motionmockups: ${p.message}\n  ${p.fix}`);
  process.exitCode = 1;
};

async function mcp(): Promise<void> {
  // Nothing may write to stdout but the transport.
  console.log = console.info = console.debug = console.error;

  // A bad override stops here: never a silent fall back to the public site.
  const origin = siteOrigin(process.env);
  if (!origin.ok) return refuse(origin.problems);
  const settings = settingsFromEnv(process.env);
  if (!settings.ok) return refuse(settings.problems);
  for (const warning of settings.value.warnings) log(`motionmockups: ${warning}`);

  const adapter = await createServer({
    origin: origin.value,
    env: process.env,
    fetch: globalThis.fetch,
    renderOnce,
    data: dataFolder(process.env),
    chromeMode: settings.value.chromeMode,
    timeoutMs: settings.value.timeoutMs,
    version,
    log,
  });

  // The client closing stdin, or a signal, cancels running renders: Chrome is closed and the
  // lock released before the process ends.
  let stopping: Promise<void> | undefined;
  const shutdown = (code: number) => {
    stopping ??= adapter.stop().finally(() => process.exit(code));
  };
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
