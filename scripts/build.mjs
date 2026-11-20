// Bundles the adapter into the one file the package publishes; test/release.test.ts gives
// another output path, for a build of its own.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/cli.ts"],
  outfile: process.argv[2] ?? "dist/motionmockups.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  define: { MOTIONMOCKUPS_VERSION: JSON.stringify(version) },
  legalComments: "none",
  logLevel: "info",
});
