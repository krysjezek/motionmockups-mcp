# motionmockups

> **Preview, not yet released.** This package is being built. The page it
> drives, motionmockups.com/agent, is not live yet, so the commands below do
> not work today. They show how it will be set up.

Motion Mockups for AI agents. Your agent places your screen recording in
art-directed device scenes and renders the mockup video in your own Google
Chrome. Making and previewing is free, with a watermark; clean output needs
Motion Mockups Pro.

## Set up

Claude Code:

```sh
claude mcp add motionmockups -- npx -y motionmockups mcp
```

Cursor, in `.cursor/mcp.json`:

```json
{ "mcpServers": { "motionmockups": { "command": "npx", "args": ["-y", "motionmockups", "mcp"] } } }
```

Any other MCP client: run `npx -y motionmockups mcp` as a stdio server.

It needs Node.js 20 or later and Google Chrome (Chromium on Linux).

## Settings

| Variable | What it does |
|---|---|
| `MOTIONMOCKUPS_FOLDERS` | More folders the adapter may use, besides the project folders your MCP client shares. Absolute paths, separated by `;` on Windows and `:` elsewhere. |
| `MOTIONMOCKUPS_CHROME` | The Chrome to use, when it is not installed in the usual place. |
| `MOTIONMOCKUPS_DATA` | Where the adapter keeps its Chrome profile and render lock. By default `%LOCALAPPDATA%\motionmockups` on Windows, `~/Library/Application Support/motionmockups` on macOS and `$XDG_DATA_HOME/motionmockups` or `~/.local/share/motionmockups` on Linux. |

## What it reads and writes

- **Allowed folders** are the project folders your MCP client shares (its
  roots) and the folders in `MOTIONMOCKUPS_FOLDERS`. The agent cannot add a
  folder by naming it. A whole drive (`C:\`, `/`) is never an allowed folder.
- **Recordings** are read only from inside an allowed folder, after every
  symlink and Windows junction is followed to where it really leads. Only
  regular files are read, and only when their first bytes show an MP4 or MOV,
  WebM, PNG, JPEG, WebP or AVIF file under a matching name. Anything else is
  refused, and its contents are never read beyond those first bytes. A path
  that is not written inside an allowed folder is refused before the adapter
  looks it up, so a network path (`\\server\share`, `file://server/`) never
  makes your computer contact that server.
- **Results** go only into `motion-mockups/` inside the first allowed folder.
  An existing file is never replaced: a taken name gets ` (2)`, ` (3)` and so
  on. Names are cleaned so they stay inside that folder on every system. A
  `motion-mockups` that is a link to somewhere else is refused.
- Every refusal says what went wrong and how to fix it.
- The adapter sends nothing about what it renders: no analytics, no
  telemetry.

## Watermarked results

Free renders carry a watermark, and every free result says:

> Watermarked preview for evaluation only. Publishing it needs Motion Mockups Pro (https://motionmockups.com/pricing).

https://motionmockups.com
