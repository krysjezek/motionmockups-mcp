// The command line. Task 6 of the adapter plan replaces this with the MCP server entry.

declare const MOTIONMOCKUPS_VERSION: string;

const version = typeof MOTIONMOCKUPS_VERSION === "string" ? MOTIONMOCKUPS_VERSION : "dev";
const [command] = process.argv.slice(2);

if (command === "--version" || command === "-v") {
  console.log(version);
} else {
  console.error(`motionmockups ${version}\n\nUsage: motionmockups mcp\n\nThe MCP server is not built yet in this preview.`);
  process.exitCode = command === undefined || command === "--help" || command === "-h" ? 0 : 1;
}
