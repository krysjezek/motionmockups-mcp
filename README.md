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

## Tools

| Tool | What it does |
|---|---|
| `list_scenes` | The scenes you can render, by device or collection: id, title, length and poster. |
| `recording_spec` | What to record for a device: screen size, frame rate, file types. |
| `render` | Renders a plan into a video, with the recording on the device screen. |
| `still` | Renders one frame of a plan as a PNG or JPEG. |
| `account` | Whether the adapter is signed in, and which plan its renders use. |

## Settings

| Variable | What it does |
|---|---|
| `MOTIONMOCKUPS_FOLDERS` | More folders the adapter may use, besides the project folders your MCP client shares. Absolute paths, separated by `;` on Windows and `:` elsewhere. |
| `MOTIONMOCKUPS_CHROME` | The Chrome to use, when it is not installed in the usual place. A path that is wrong is refused, never passed over. |
| `MOTIONMOCKUPS_CHROME_MODE` | `headless` (the default) or `window`. See [Chrome mode](#chrome-mode). |
| `MOTIONMOCKUPS_TIMEOUT_MINUTES` | How long one render may run, 1 minute or more. By default 20. |
| `MOTIONMOCKUPS_DATA` | Where the adapter keeps its Chrome profile, its staging folder and the render lock. By default `%LOCALAPPDATA%\motionmockups` on Windows, `~/Library/Application Support/motionmockups` on macOS and `$XDG_DATA_HOME/motionmockups` or `~/.local/share/motionmockups` on Linux. |
| `MOTIONMOCKUPS_ORIGIN` | For testing the site only: a local preview (`http://localhost:<port>`, `http://127.0.0.1:<port>`) or one of its Vercel previews. Anything else stops the server at start, so it never falls back to the public site by mistake. |

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
  on. Names are cleaned so they stay inside that folder on every system (a
  name such as `../../film` is saved as `film` there). A `motion-mockups`
  that is a link to somewhere else is refused. A file is written under a
  hidden partial name first and appears under its own name only once it is
  whole.
- Every refusal says what went wrong and how to fix it.
- The adapter sends nothing about what it renders: no analytics, no
  telemetry.

## One render at a time, and cancelling

- Every agent starts its own adapter, and all of them share one Chrome
  profile, which Chrome opens only once. So a render first takes the render
  lock in the data folder. A second render, from the same agent or another,
  waits its turn and reports who it is waiting for. The render timeout starts
  once the lock is held.
- A lock left by an adapter that was killed is taken over at once when its
  process is gone, and after a minute without a heartbeat otherwise.
- Cancelling a request (`notifications/cancelled`), the render timeout, or
  the MCP client closing the adapter stops the render: the page is told to
  cancel, Chrome is closed, staged files are removed and the lock is
  released. Files already saved stay and are listed in the refusal.
- When the adapter is killed outright, Chrome loses its control pipe and
  closes too. Measured on Windows: no Chrome of the adapter's was left 0.6 s
  after `taskkill /F`, and 1.2 s after the client closed it mid-render.

## Chrome mode

Renders run in headless Chrome by default: no window opens and nothing takes
focus. `window` mode opens a normal Chrome window off-screen, for a machine
where headless Chrome renders differently.

Measured on Windows 11 with Chrome 156 (`scripts/e2e.mjs`, the free
two-clip iPhone film, 75 frames at 720 × 404):

| | headless | window |
|---|---|---|
| Frames | 75 | 75 |
| Bitrate | 2,564 kb/s, both runs | 2,539 and 2,532 kb/s |
| File size | 801,128 bytes, both runs | 793,322 and 791,345 bytes |
| SSIM against the page's own render, either side of the cut | 0.9939 / 0.9962 | 0.9939 / 0.9962 |
| SSIM over all frames, lowest / mean | 0.9932 / 0.9946 | 0.9931 / 0.9946 |
| Render time: the whole `render` call, from request to answer (Chrome start, page load, render and save) | 2.3 s, 2.3 s | 2.4 s, 2.4 s |
| Window in front kept focus | yes | yes |

Both modes give the same frames at the same quality in the same time, so
headless stays the default. Headless wrote 801,128 bytes in every run so
far; window mode did too in the earlier runs, and 791–793 kB in this one,
with the same SSIM. The page's own render is the site's verification script driving
the same page in Playwright. For the focus check the foreground window was
logged every 30 ms from before Chrome started until a second after it
closed; it never changed. The window in front was another app in use at the
time (Windows did not let the test bring its own window forward), and the
run was started from a process in the background, not from the app in front.
Not measured: an MCP client that is itself in front starting the adapter,
which may let a window-mode Chrome take focus.

## Watermarked results

Free renders carry a watermark, and every free result says:

> Watermarked preview for evaluation only. Publishing it needs Motion Mockups Pro (https://motionmockups.com/pricing).

## Development

```sh
npm ci
npm test            # unit and Chrome launch tests; Node 22.6 or later
npm run build       # dist/motionmockups.js, the one file that is published
node scripts/smoke.mjs
```

The render session tests need a site with the agent page:
`MOTIONMOCKUPS_TEST_ORIGIN=http://127.0.0.1:4173 npm test`. The end-to-end
run drives the built adapter as a real MCP server over stdio, through the MCP
SDK's client, against such a site:

```sh
MOTIONMOCKUPS_ORIGIN=http://127.0.0.1:4173 \
MOTIONMOCKUPS_E2E_REFERENCE=<the app's artifacts/agent-render/build/free-film.mp4> \
node scripts/e2e.mjs
```

It checks the film, stills, scenes delivery, refusals of paths outside the
project, two adapters at once, cancel, a killed adapter, Chrome problems and
equality with the page's own render, then measures both Chrome modes. It
writes `e2e-results.json`. It needs ffmpeg and ffprobe, and uses temporary
folders only. The site's own repository says how to build and serve the
preview (port 4173, with `AGENT_PAGE=1`) and how to make the reference film.

https://motionmockups.com
