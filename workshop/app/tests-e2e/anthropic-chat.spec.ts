import { expect, test } from "./fixtures";
import { assertLlmSpanShape, pickPort, pollOutline, outlineMatches, requireEnvOrThrow, TEST_PROMPT_RX, runStandardChatTurn, spawnTsExample, verifyRunInWorkshopUi } from "./helpers";

test.beforeAll(() => requireEnvOrThrow("ANTHROPIC_API_KEY"));


test("anthropic-chat: SDK ships → workshop UI renders + DB matches", async ({ page, workshop }, testInfo) => {
  const example = await spawnTsExample({
    name: "anthropic-chat",
    port: pickPort(testInfo.workerIndex, 2),
    workshopUrl: workshop.url,
    extraEnv: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
  });
  try {
    const { workshopUrl, runId } = await runStandardChatTurn(page, example.url);
    const outline = await pollOutline(workshop.url, runId, outlineMatches("anthropic_chat", TEST_PROMPT_RX));
    expect(outline.spans.length).toBeGreaterThan(0);
    // anthropic-chat hardcodes claude-sonnet-4-6; SDK must propagate model.
    await assertLlmSpanShape(workshop.url, runId, { modelRegex: /^claude/i });
    await verifyRunInWorkshopUi(page, workshopUrl, { textRegex: TEST_PROMPT_RX });
  } finally {
    await example.stop();
  }
});
