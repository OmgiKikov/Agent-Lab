import { expect, test } from "./fixtures";
import { outlineMatches, pickPort, pollOutline, requireBinaryOrThrow, requireEnvOrThrow, runStandardChatTurn, spawnTsExample, TEST_PROMPT_RX, verifyRunInWorkshopUi } from "./helpers";

// opencode spawns a sub-process that may take a while to boot + answer.
test.setTimeout(240_000);

test.beforeAll(() => {
  requireEnvOrThrow("ANTHROPIC_API_KEY");
  requireBinaryOrThrow("opencode", "bun add -g opencode-ai");
});

test("opencode-plugin-chat: SDK ships → workshop UI renders + DB matches", async ({ page, workshop }, testInfo) => {
  const example = await spawnTsExample({
    name: "opencode-plugin-chat",
    port: pickPort(testInfo.workerIndex, 7),
    workshopUrl: workshop.url,
    extraEnv: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
  });
  try {
    const { workshopUrl, runId } = await runStandardChatTurn(page, example.url, { sendTimeoutMs: 180_000 });
    const outline = await pollOutline(workshop.url, runId, outlineMatches("opencode_session", TEST_PROMPT_RX));
    expect(outline.spans.length).toBeGreaterThan(0);
    await verifyRunInWorkshopUi(page, workshopUrl, { textRegex: TEST_PROMPT_RX });
  } finally {
    await example.stop();
  }
});
