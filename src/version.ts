// The adapter's version: package.json's, written in by the build (scripts/build.mjs); "dev"
// when the sources run unbuilt, which the kill switch never judges (src/killswitch.ts).

declare const MOTIONMOCKUPS_VERSION: string;

export const VERSION = typeof MOTIONMOCKUPS_VERSION === "string" ? MOTIONMOCKUPS_VERSION : "dev";
