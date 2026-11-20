// The plan an agent sends to render, still and check_plan, as the tools' input schema. It is
// typed for the agent but passed to the page unchanged; the page enforces its rules, and
// check_plan only previews them (src/guidance.ts).

import { z } from "zod";

const crop = z
  .object({
    x: z.number().optional().describe("Horizontal position of the crop, 0 (left) to 1 (right)."),
    y: z.number().optional().describe("Vertical position of the crop, 0 (top) to 1 (bottom)."),
    zoom: z.number().optional().describe("1 (the whole scene) to 3."),
  })
  .strict();

const clip = z
  .object({
    scene: z.string().min(1).describe("A scene id from list_scenes, of the plan's device."),
    seconds: z.number().optional().describe("How long the clip runs in the finished film. Without it, the scene's own length."),
    reversed: z.boolean().optional().describe("Play the scene's camera move backwards."),
    crop: crop.optional().describe("Frame part of the scene."),
  })
  .strict();

export const planSchema = z
  .object({
    contract: z.literal(1).describe("Always 1."),
    device: z.string().min(1).describe("One device from the catalog (Display, iPhone, MacBook, iPad or TV). Every clip is a scene of it."),
    clips: z.array(clip).min(1).describe("The scenes in order. One clip is one scene."),
    aspect: z.string().min(1).describe('The frame: "1:1", "4:3", "16:9", "4:5" or "9:16".'),
    size: z.number().optional().describe("Short edge in pixels with Pro: 1080 or 2160. Free previews are smaller."),
    delivery: z.enum(["film", "scenes"]).optional().describe('"film" (default) joins the clips into one video; "scenes" gives one video per clip.'),
    speedRamp: z.union([z.literal("off"), z.literal(50), z.literal(100)]).optional().describe('Ease into and out of each move: "off", 50 or 100.'),
    reflections: z.union([z.literal(0), z.literal(50), z.literal(100)]).optional().describe("Screen reflections: 0, 50 or 100."),
    hideNotch: z.boolean().optional().describe("Remove the notch from iPhone and MacBook scenes."),
    keepStatusBar: z.boolean().optional().describe("Keep the recording's own iOS status bar instead of the cleaned one."),
    background: z
      .object({
        top: z.string().describe("#rrggbb"),
        bottom: z.string().describe("#rrggbb"),
      })
      .strict()
      .optional()
      .describe("The backdrop gradient, for scenes that have one."),
  })
  .strict()
  .describe("What to render. The site checks it and refuses with a fix when something does not fit.");

export type Plan = z.infer<typeof planSchema>;
