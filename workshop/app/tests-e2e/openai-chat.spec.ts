import { expect, test } from "./fixtures";
import { assertLlmSpanShape, pickPort, pollOutline, outlineMatches, requireEnvOrThrow, TEST_PROMPT_RX, runStandardChatTurn, spawnTsExample, verifyRunInWorkshopUi } from "./helpers";

test.beforeAll(() => requireEnvOrThrow("OPENAI_API_KEY"));


test("openai-chat: SDK ships → workshop UI renders + DB matches", async ({ page, workshop }, testInfo) => {
  const example = await spawnTsExample({
    name: "openai-chat",
    port: pickPort(testInfo.workerIndex, 1),
    workshopUrl: workshop.url,
    extraEnv: { OPENAI_API_KEY: process.env.OPENAI_API_KEY! },
  });
  try {
    const { workshopUrl, runId } = await runStandardChatTurn(page, example.url);
    const outline = await pollOutline(workshop.url, runId, outlineMatches("openai_chat", TEST_PROMPT_RX));
    expect(outline.spans.length).toBeGreaterThan(0);
    // openai-chat hardcodes gpt-5.4-mini; SDK must propagate model into LLM span.
    await assertLlmSpanShape(workshop.url, runId, { modelRegex: /^gpt/i });
    await verifyRunInWorkshopUi(page, workshopUrl, { textRegex: TEST_PROMPT_RX });
  } finally {
    await example.stop();
  }
});
