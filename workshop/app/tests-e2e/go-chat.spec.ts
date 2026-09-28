import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, REPO_ROOT_PATH, test } from "./fixtures";
import { assertLlmSpanShape, outlineMatches, pickPort, pollOutline, requireBinaryOrThrow, requireEnvOrThrow, runStandardChatTurn, spawnGoExample, TEST_PROMPT_RX, verifyRunInWorkshopUi } from "./helpers";

const GO_DIR = path.join(REPO_ROOT_PATH, "examples", "go-chat");
const GO_BIN = path.join(GO_DIR, "go-chat");

// Cold `go build` + 120s send + DB poll + UI render exceeds the 90s file
// default. File-level `test.setTimeout` only sets the per-test budget;
// hooks have their own (config-default 90s), so we also extend it from
// inside `beforeAll` below — a cold `go build` for go-chat is typically
// well under 90s but other paths in the hook (network-pulled go modules,
// large dep graphs) can push past it.
test.setTimeout(180_000);

test.beforeAll(() => {
  test.setTimeout(180_000);
  requireEnvOrThrow("OPENAI_API_KEY");
  requireBinaryOrThrow("go", "https://go.dev/dl/");
  // Always invoke `go build` — same rationale as rust-chat. Go's build
  // cache makes the no-op case sub-second; the alternative (existsSync
  // gate) silently keeps stale binaries around after example.go is edited.
  const r = spawnSync("go", ["build", "-o", "go-chat", "./..."], { cwd: GO_DIR, stdio: "inherit" });
  if (r.status !== 0) throw new Error("go build failed");
});

test("go-chat: SDK ships → workshop UI renders + DB matches", async ({ page, workshop }, testInfo) => {
  const example = await spawnGoExample({
    port: pickPort(testInfo.workerIndex, 10),
    workshopUrl: workshop.url,
    binPath: GO_BIN,
  });
  try {
    const { workshopUrl, runId } = await runStandardChatTurn(page, example.url, {
      sendTimeoutMs: 120_000,
      disableTools: true,
    });
    const outline = await pollOutline(workshop.url, runId, outlineMatches("go_chat", TEST_PROMPT_RX));
    expect(outline.spans.length).toBeGreaterThan(0);
    // go-chat hardcodes gpt-4o-mini; Go SDK must propagate model.
    await assertLlmSpanShape(workshop.url, runId, { modelRegex: /^gpt/i });
    await verifyRunInWorkshopUi(page, workshopUrl, { textRegex: TEST_PROMPT_RX });
  } finally {
    await example.stop();
  }
});
