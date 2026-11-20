// Builds motionmockups.mcpb, the Claude Desktop extension: a zip of manifest.json (mcpb
// manifest 0.3, github.com/anthropics/mcpb MANIFEST.md) and the one published bundle,
// dist/motionmockups.js, at the path the manifest names. Nothing else goes in: no install
// scripts, no node_modules, no icon. Run after `npm run build`:
// `node scripts/mcpb.mjs [out.mcpb]` (motionmockups.mcpb at the repository root by default).
//
// The zip is written here with node:zlib, with fixed timestamps, so the same bundle always
// gives the same file.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import { transform } from "esbuild";

const root = new URL("../", import.meta.url);
export const BUNDLE = "dist/motionmockups.js";

/** The tools' own descriptions (src/tools.ts), the text the server gives without the site. */
async function builtInTools() {
  const { code } = await transform(readFileSync(new URL("src/tools.ts", root), "utf8"), { loader: "ts", format: "esm" });
  const { TOOL_NAMES, BUILT_IN_TEXT } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return TOOL_NAMES.map((name) => ({ name, description: BUILT_IN_TEXT[name] }));
}

export async function manifest() {
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  return {
    manifest_version: "0.3",
    name: pkg.name,
    display_name: "Motion Mockups",
    version: pkg.version,
    description: "Art-directed device mockup videos of your screen recordings, rendered by your agent in your own Google Chrome.",
    long_description:
      "Your agent places your screen recording in art-directed device scenes and renders the mockup video in your own Google Chrome. " +
      "Making and previewing is free, with a watermark; clean output needs Motion Mockups Pro. Needs Google Chrome.",
    author: { name: "Motion Mockups" },
    homepage: pkg.homepage,
    repository: { type: "git", url: "https://github.com/krysjezek/motionmockups-mcp" },
    support: "https://motionmockups.com/contact",
    privacy_policies: ["https://motionmockups.com/privacy"],
    license: pkg.license,
    keywords: pkg.keywords,
    server: {
      type: "node",
      entry_point: BUNDLE,
      mcp_config: {
        command: "node",
        // A folder list expands only into arguments, one per folder (an array in an env
        // string is left unreplaced by the host); the adapter adds the folders given after
        // `mcp` to MOTIONMOCKUPS_FOLDERS (src/cli.ts).
        args: [`\${__dirname}/${BUNDLE}`, "mcp", "${user_config.allowed_folders}"],
        env: { MOTIONMOCKUPS_ORIGIN: "${user_config.origin}" },
      },
    },
    tools: await builtInTools(),
    compatibility: {
      platforms: ["darwin", "win32", "linux"],
      runtimes: { node: pkg.engines.node },
    },
    user_config: {
      allowed_folders: {
        type: "directory",
        title: "Allowed folders",
        description:
          "The folders Motion Mockups may use: it reads your recordings from them and saves renders in a motion-mockups folder inside. " +
          "Nothing outside them is read.",
        multiple: true,
        required: true,
      },
      origin: {
        type: "string",
        title: "Site origin (testing only)",
        description:
          "Leave empty to use https://motionmockups.com. For testing the site only: a local preview (http://localhost:<port>) " +
          "or one of its Vercel previews. Anything else stops the extension at start.",
        required: false,
        // An empty default, so an unset origin is replaced by "" (the public site), never left as
        // the literal placeholder.
        default: "",
      },
    },
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of deflated entries, all dated 1980-01-01 00:00 with mode 644. */
export function zip(entries) {
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const UTF8 = 0x0800;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made on Unix, so the mode below is read
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const bundle = new URL(BUNDLE, root);
  if (!existsSync(bundle)) {
    console.error(`${BUNDLE} is missing: run npm run build first.`);
    process.exit(1);
  }
  const out = process.argv[2] ?? fileURLToPath(new URL("motionmockups.mcpb", root));
  const json = `${JSON.stringify(await manifest(), null, 2)}\n`;
  writeFileSync(out, zip([
    { name: "manifest.json", data: Buffer.from(json, "utf8") },
    { name: BUNDLE, data: readFileSync(bundle) },
  ]));
  console.log(`wrote ${out}`);
}
