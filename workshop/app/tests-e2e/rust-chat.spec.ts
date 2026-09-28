import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, REPO_ROOT_PATH, test } from "./fixtures";
import { assertLlmSpanShape, outlineMatches, pickPort, pollOutline, requireBinaryOrThrow, requireEnvOrThrow, runStandardChatTurn, spawnRustExample, TEST_PROMPT_RX, verifyRunInWorkshopUi } from "./helpers";

const RUST_DIR = path.join(REPO_ROOT_PATH, "examples", "rust-chat");
const RUST_BIN = path.join(RUST_DIR, "target", "release", "rust-chat");

// rust-chat with 5 synthetic tools + reasoning model can take ~60-90s; the
// uncached cargo build adds another ~3min on cold cache. File-level
// `test.setTimeout` covers the per-test budget; the `beforeAll` hook has
// its OWN separate timeout (Playwright config default is 90s for hooks)
// which we extend from inside the hook body — a cold cargo build can
// easily blow past 90s.
test.setTimeout(300_000);

test.beforeAll(() => {
  test.setTimeout(300_000);
  requireEnvOrThrow("OPENAI_API_KEY");
  requireBinaryOrThrow("cargo", "https://rustup.rs");
  // Always invoke cargo. An `existsSync` gate skips rebuilds when source
  // changes, which masked the raindrop.flush() timeout fix locally — the
  // stale binary still hung waiting on a never-resolving flush and the
  // workshop URL footer never streamed back. Cargo's own incremental
  // change detection makes this a sub-second no-op when source is clean.
  const r = spawnSync("cargo", ["build", "--release"], { cwd: RUST_DIR, stdio: "inherit" });
  if (r.status !== 0) throw new Error("cargo build failed");
});


test("rust-chat: SDK ships → workshop UI renders + DB matches", async ({ page, workshop }, testInfo) => {
  const example = await spawnRustExample({
    port: pickPort(testInfo.workerIndex, 9),
    workshopUrl: workshop.url,
    binPath: RUST_BIN,
  });
  try {
    const { workshopUrl, runId } = await runStandardChatTurn(page, example.url, {
      sendTimeoutMs: 120_000,
      disableTools: true,
    });
    const outline = await pollOutline(workshop.url, runId, outlineMatches("rust_chat", TEST_PROMPT_RX));
    expect(outline.spans.length).toBeGreaterThan(0);
    // rust-chat hardcodes gpt-5.4-mini; Rust SDK must propagate model.
    await assertLlmSpanShape(workshop.url, runId, { modelRegex: /^gpt/i });
    await verifyRunInWorkshopUi(page, workshopUrl, { textRegex: TEST_PROMPT_RX });
  } finally {
    await example.stop();
  }
});
