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
| `list_scenes` | The scenes you can render, by device or collection: id, title, length, poster and the designer's notes. |
| `recording_spec` | What to record for a device: screen size, frame rate, file types. |
| `suggest_sequence` | Plans for a goal (`launch`, `app-demo`, `case-study` or `portfolio`) on one device, from the designer's sequences, each with its reason. |
| `check_plan` | Checks a plan before a render: the problems the render would refuse, and the designer's taste as warnings. |
| `render` | Renders a plan into a video, with the recording on the device screen. Lists any taste warning it went past under `overrides`. |
| `still` | Renders one frame of a plan as a PNG or JPEG, with `overrides` as `render`. |
| `account` | Whether the adapter is connected to a Motion Mockups account, and whether its renders are Pro (clean) or free (watermarked previews). |
| `connect_account` | Connects your account, so renders are clean with Pro. See [Connect your account](#connect-your-account). |

The tool descriptions, the scene notes, the sequences and the taste rules'
values come from the site, so they change when the site does. A site that
serves none of them still works: the tools use their own descriptions and
give no notes, suggestions or warnings.

## The designer's guidance

One designer directs every scene. The site serves that guidance with the
scene list, and the adapter passes it on as data in tool results:

- **Notes.** `list_scenes` gives each scene's notes (its move, framing, pace,
  how much of the screen reads and what it is good as: opener, detail or
  close), and once for all the scenes listed, each move's notes (what it cuts
  well with and what to keep apart) and each collection's (its light and
  setting).
- **Sequences.** `suggest_sequence` takes a goal and a device, and optionally
  an aspect, a length in seconds and a collection. It answers with up to six
  plans, each from one collection's real scenes, with a title and why. A
  sequence the designer framed for another aspect than the one asked keeps
  its own, after those in the asked aspect, with a note on changing it.
- **Checks.** `check_plan` returns `{ ok, problems, warnings }`. Problems
  preview what the render page refuses: a scene that does not exist or is
  another device's, an aspect or size it does not offer, or a clip shorter
  than a second or longer than its scene (shorter still under a speed ramp).
  Fix those; the page stays the judge. Warnings are taste: a film outside the
  designer's length (6 to 20 seconds today), more clips than the designer's
  limit (six today), two collections, the same move twice in a
  row, a pair of moves the designer keeps apart, an opening or closing scene
  the designer does not use for that, or a scene the designer keeps out of
  films. Each has a `code` and a `fix`.
- **Overrides.** Taste never stops a render. When a plan goes past a warning,
  the `render` or `still` result lists it, as `overrides: ["<code>: <what>"]`.

The notes are suggestions, and those marked `reviewed: false` are drafts.
Only the site's briefing becomes the agent's instructions (at most 8,000
characters); every note, sequence and description is capped in length, and a
taste rule this adapter does not know is ignored with one line on stderr.

## Settings

| Variable | What it does |
|---|---|
| `MOTIONMOCKUPS_FOLDERS` | More folders the adapter may use, besides the project folders your MCP client shares. Absolute paths, separated by `;` on Windows and `:` elsewhere. |
| `MOTIONMOCKUPS_CHROME` | The Chrome to use, when it is not installed in the usual place. A path that is wrong is refused, never passed over. |
| `MOTIONMOCKUPS_CHROME_MODE` | `headless` (the default) or `window`. See [Chrome mode](#chrome-mode). |
| `MOTIONMOCKUPS_TIMEOUT_MINUTES` | How long one render may run, 1 minute or more. By default 20. |
| `MOTIONMOCKUPS_DATA` | Where the adapter keeps its Chrome profile, its staging folder, the render lock and the [saved connection](#connect-your-account). By default `%LOCALAPPDATA%\motionmockups` on Windows, `~/Library/Application Support/motionmockups` on macOS and `$XDG_DATA_HOME/motionmockups` or `~/.local/share/motionmockups` on Linux. An absolute folder; a relative one stops the server at start. The adapter creates these folders for you alone (mode 700 on macOS and Linux). |
| `MOTIONMOCKUPS_ORIGIN` | For testing the site only: a local preview on its own port (`http://localhost:<port>`, `http://127.0.0.1:<port>`; port 80 or no port is refused) or one of the site's Vercel previews in the owner's team (`https://motion-mockups-<9-character id>-krystofjezeks-projects.vercel.app` or `https://motion-mockups-app-git-<branch>-krystofjezeks-projects.vercel.app`). Anything else stops the server at start, so it never falls back to the public site by mistake. |

## Connect your account

Without an account, renders are free watermarked previews. To make clean,
full-quality renders with Motion Mockups Pro, connect your account once per
computer:

1. Ask your agent to connect your Motion Mockups account. It calls
   `connect_account`, which gives a link and a code such as `BCDF-2345`, and
   shows them to you. The adapter opens nothing on its own. With
   `open: true`, which is recommended, it opens the link in your default
   browser: a link the adapter opens itself is certainly its own, while a
   link an agent shows you could have come from instructions it read
   elsewhere.
2. Open the link in your usual browser and sign in to Motion Mockups. The
   page, "Connect an agent", shows the code and what the agent can do:
   "Render with your Pro plates. It cannot change your account, billing,
   projects or saved recordings." Approve it if the code matches the one your
   agent shows. If you didn't start this yourself, choose Deny.
3. Your agent calls `connect_account` with `wait: true`, which returns once
   you approve or decline, or after 10 minutes, when the code expires. It
   reports progress while it waits. Cancelling it, or the MCP client giving
   up on it after its own request timeout, only stops that wait: the adapter
   keeps checking for your approval until the code expires, and saves the
   connection when you approve. The agent can wait again, or call `account`
   once you say you approved. `disconnect: true` ends a pending sign-in.

Only one sign-in runs at a time: asking again while one is pending gives the
same code. Once connected, `account` says whether the account has Pro, and
every `render` and `still` checks that once before it starts: Pro renders
are clean, anything else is a free watermarked preview. When a saved
connection cannot be used (damaged, for another site, no longer accepted, or
the site cannot be reached to check it), the render is refused with the way
out rather than quietly made as a watermarked preview.

**The saved connection.** The adapter keeps a render-only agent token in one
file, `agent-token` in its data folder (see `MOTIONMOCKUPS_DATA`), with the
site it came from. It is written whole and then moved into place, readable by
you alone: mode 600 on macOS and Linux. On Windows the file takes the
permissions of its folder: the default data folder, in your own profile
(`%LOCALAPPDATA%`), is yours alone, but when `MOTIONMOCKUPS_DATA` points
elsewhere the file is as private as that folder, so choose one only you can
read. The token is sent only to that site: a file saved for another
site, after `MOTIONMOCKUPS_ORIGIN` changed, is refused, never sent. It never
appears in a tool result, a progress report, an error or the adapter's log,
and it reaches the site's agent page only inside Chrome's control pipe,
never on Chrome's command line, in its environment or in a URL. A damaged
file is refused, with how to connect again. A keychain is a later
improvement.

**Disconnecting.** `connect_account` with `disconnect: true` sends the saved
token once to the site, which revokes it on the account, and then deletes
the saved connection from this computer, whatever the site answered;
renders are free previews again. The result says whether the site confirmed
the revoke. If it did not (the site could not be reached, for one), the
token may still be live: revoke it on motionmockups.com, under Account, then
Connected agents, Revoke. If the file itself cannot be deleted, the result
says so and gives its path (`notDeleted`), to delete by hand. A token saved
for another site is deleted, never sent. A token also stops working after 90 days without use, or when the
account is deleted. Once the
site no longer accepts it, the adapter deletes the file itself and says to
connect again. When Pro ends, the connection stays and renders become free
watermarked previews; renew Pro for clean renders again.

## What it reads and writes

- **Allowed folders** are the project folders your MCP client shares (its
  roots) and the folders in `MOTIONMOCKUPS_FOLDERS`. The agent cannot add a
  folder by naming it. A whole drive (`C:\`, `/`) is never an allowed folder.
  When the client says it shares its folders but they cannot be read, the
  render is refused (code `roots`) rather than saved in
  `MOTIONMOCKUPS_FOLDERS` alone; the next render asks the client again.
- **Recordings** are read only from inside an allowed folder, after every
  symlink and Windows junction is followed to where it really leads. Where
  it leads counts as inside only when it is, on disk, an allowed folder or
  inside one (the same volume and file id), never by how its name is
  spelled, so a folder whose name differs only in case or by a look-alike
  letter is outside. Only
  regular files are read, and only when their first bytes show an MP4 or MOV,
  WebM or MKV, PNG, JPEG, WebP or AVIF file under a matching name. Anything else is
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
- Every refusal says what went wrong and how to fix it. A refusal in the
  site's own words (its agent page refused the plan) carries `source: "site"`;
  the page's words reach the agent capped (20 problems and 20 warnings at
  most, each cut short), and its progress at most four times a second.
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
  A file it was saving stays in the data folder's `staging` until the next
  render starts, which removes every download Chrome left there.
- Chrome is told to refuse downloads from the moment it starts, and to save
  only into `staging` while a result is being saved, so nothing lands in
  your Downloads folder.

## Chrome mode

Renders run in headless Chrome by default: no window opens and nothing takes
focus. `window` mode opens a normal Chrome window off-screen, for a machine
where headless Chrome renders differently.

Measured on Windows 11 with Chrome 156 (`scripts/e2e.mjs`, the free
two-clip iPhone film, 75 frames at 720 × 404):

| | headless | window |
|---|---|---|
| Frames | 75 | 75 |
| Bitrate | 2,554 and 2,553 kb/s | 2,553 and 2,564 kb/s |
| File size | 798,032 and 797,874 bytes | 797,874 and 801,128 bytes |
| SSIM against the page's own render, either side of the cut | 0.9940 / 0.9962 | 0.9939 / 0.9962 |
| SSIM over all frames, lowest / mean | 0.9932 / 0.9946 | 0.9932 / 0.9946 |
| Render time: the whole `render` call, from request to answer (Chrome start, page load, render and save) | 3.0 s, 2.2 s | 2.2 s, 2.4 s |
| Window in front kept focus | yes | yes |

Both modes give the same frames at the same quality in the same time, so
headless stays the default. The encoded size varies a little from run to
run in both modes (791–801 kB so far; both modes wrote 797,874 bytes in
this run), with the same SSIM. The page's own render is the site's verification script driving
the same page in Playwright. For the focus check the foreground window was
logged every 30 ms from before Chrome started until a second after it
closed; it never changed. The window in front was another app in use at the
time (Windows did not let the test bring its own window forward), and the
run was started from a process in the background, not from the app in front.
Not measured: an MCP client that is itself in front starting the adapter,
which may let a window-mode Chrome take focus.

## Watermarked results

Free renders carry a watermark, whether or not an account is connected, and
every free result says:

> Watermarked preview for evaluation only. Publishing it needs Motion Mockups Pro (https://motionmockups.com/pricing).

A render with a connected Pro account says:

> Clean, full-quality render with Motion Mockups Pro.

## Kill switch

The site can stop an adapter version that must not be used, for instance one
with a bug that loses renders. Its scene list may carry:

```json
"adapters": { "allowed": ">=0.1.0", "blocked": ["0.1.3"], "message": "0.1.3 loses renders. Update the adapter." }
```

A version outside `allowed`, or listed in `blocked`, answers every tool with
a refusal of code `blocked`: the site's message (at most 500 characters) and
a fix that names the update, `npx motionmockups@latest` or a newer Claude
Desktop extension. `account` and `connect_account` with `disconnect: true`
keep working, so a connection can still be removed. The tools and their
descriptions stay as they were; only the results refuse.

The adapter reads the scene list at start and again on the first call after
it is 10 minutes old, so a block takes effect within minutes. A render that
had already started finishes; the next call is refused, and so is a render
still waiting for another render to finish, once its turn comes. If the list cannot
be read again, the last one read stays in force, and it is tried again a
minute later.

The block can never shut everyone out by mistake: a site without an
`adapters` block allows every version, and a block the adapter cannot read
(a range outside the subset below, or a field of the wrong type) is treated
as absent, with one note on stderr. An adapter run from its sources, not
built, has the version `dev` and is never checked.

`allowed` is a small subset of npm's ranges:

- comparators separated by spaces, all of which must hold: `>=`, `>`, `<`,
  `<=` or `=` directly followed by `MAJOR.MINOR.PATCH`, as in
  `>=0.1.0 <0.3.0`; a bare version means `=`;
- `^MAJOR.MINOR.PATCH`, up to the next change of the first non-zero part:
  `^1.2.3` is `>=1.2.3 <2.0.0-0`, `^0.2.3` is `>=0.2.3 <0.3.0-0`;
- a version may carry a prerelease (`0.2.0-beta.1`), which is lower than
  its release, and build metadata (`+…`), which is not compared.
  Prereleases are compared as npm does with `includePrerelease`, unlike
  npm's default: `>=0.1.0` admits `0.2.0-beta.1`.

Not read: `~`, `x` and `*`, `||`, hyphen ranges and a space between an
operator and its version. Each entry in `blocked` is one exact version.

## Known limits

- **A network that needs an HTTP proxy cannot render.** The adapter's Chrome
  sends every request outside the site to a proxy that is not there, and
  connects to the site and its media directly, so it does not use your
  system or corporate proxy.
- **Managed Chrome.** Enterprise policies can override what the adapter
  sets: `ProxySettings` (the proxy rule above), `HeadlessMode` (headless
  Chrome turned off) and `DownloadRestrictions` (results are saved through
  Chrome's downloads) can each stop a render or break the setup.

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
project, two adapters at once, cancel, a killed adapter (also while saving,
and what it leaves in staging), Chrome problems and equality with the page's
own render, then measures both Chrome modes. It writes `e2e-results.json`,
with local folders replaced by `<temp>`, `<reference>`, `<repo>`, `<tmp>` and
`~`. It needs ffmpeg and ffprobe, and uses temporary
folders only. The site's own repository says how to build and serve the
preview (port 4173, with `AGENT_PAGE=1`) and how to make the reference film.

https://motionmockups.com
