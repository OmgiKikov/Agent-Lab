// Inlined at compile time via `bun build --define __RAINDROP_VERSION__=...`
// (see scripts/build-bun.ts). Source-mode runs fall back to "0.0.0-dev".
declare const __RAINDROP_VERSION__: string | undefined;

export const VERSION: string =
  typeof __RAINDROP_VERSION__ === "string" && __RAINDROP_VERSION__.length > 0
    ? __RAINDROP_VERSION__
    : "0.0.0-dev";
