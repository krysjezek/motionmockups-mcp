// The adapter's eight tools and their own descriptions. Nothing else lives here, so
// scripts/mcpb.mjs can read the descriptions into the desktop extension's manifest without
// loading the server.

export const TOOL_NAMES = ["list_scenes", "recording_spec", "suggest_sequence", "check_plan", "render", "still", "account", "connect_account"] as const;

/**
 * The adapter's own tool descriptions, used when the site's catalog gives none for a tool
 * (its `toolText`, src/catalog.ts, at most MAX_TOOL_TEXT characters each).
 */
export const BUILT_IN_TEXT: Record<(typeof TOOL_NAMES)[number], string> = {
  list_scenes:
    "List the scenes you can render: each scene's id, device, collection, title, length (seconds), poster image and, when the site has them, the designer's notes. Filter by device or collection. The notes are suggestions.",
  recording_spec:
    "What to record for a device: the screen size in pixels, the frame rate, the accepted file types, the longest a screenshot can run and capture tips.",
  suggest_sequence:
    "Suggest plans for a goal (launch, app-demo, case-study or portfolio) on one device, from the designer's sequences, each resolved to real scenes of one collection with a reason. Optionally give an aspect, a film length and a collection.",
  check_plan:
    "Check a plan before rendering. Problems are rules the render enforces and must be fixed; warnings are the designer's taste, which you may go past when the person asks or has a reason. Each comes with a fix.",
  render:
    "Render a video from a plan, with the person's recording on the device screen, in their own Chrome. Free renders are watermarked previews for evaluation only; clean output needs Motion Mockups Pro. Files are saved in the project's motion-mockups folder. Any taste warning the plan goes past is listed under overrides.",
  still:
    "Render one frame of a plan as a PNG or JPEG: the frame at `seconds` from the film's start. Free stills are watermarked previews for evaluation only; clean output needs Motion Mockups Pro.",
  account:
    "Whether this adapter is connected to a Motion Mockups account, and whether its renders are Pro (clean) or free (watermarked previews).",
  connect_account:
    "Connect the person's Motion Mockups account, for clean Pro renders. Gives a link and code to show the person (open: true, recommended, also opens it); then call again with wait: true until they approve. disconnect: true revokes and deletes the saved connection.",
};
