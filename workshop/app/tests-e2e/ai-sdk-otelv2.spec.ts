import { expect, test } from "./fixtures";
import { assertLlmSpanShape, pickPort, pollOutline, outlineMatches, requireEnvOrThrow, TEST_PROMPT_RX, runStandardChatTurn, spawnTsExample, verifyRunInWorkshopUi } from "./helpers";

test.beforeAll(() => requireEnvOrThrow("OPENAI_API_KEY"));


test("ai-sdk-otelv2: SDK ships → workshop UI renders + DB matches", async ({ page, workshop }, testInfo) => {
  const example = await spawnTsExample({
    name: "ai-sdk-otelv2",
    port: pickPort(testInfo.workerIndex, 3),
    workshopUrl: workshop.url,
    extraEnv: { OPENAI_API_KEY: process.env.OPENAI_API_KEY! },
  });
  try {
    const { workshopUrl, runId } = await runStandardChatTurn(page, example.url);
    const outline = await pollOutline(workshop.url, runId, outlineMatches("ai_sdk_otelv2_chat", TEST_PROMPT_RX));
    expect(outline.spans.length).toBeGreaterThan(0);
    // ai-sdk-otelv2 hardcodes gpt-4.1-mini; OTLP exporter must still emit
    // an LLM span with model populated.
    await assertLlmSpanShape(workshop.url, runId, { modelRegex: /^gpt/i });
    await verifyRunInWorkshopUi(page, workshopUrl, { textRegex: TEST_PROMPT_RX });
  } finally {
    await example.stop();
  }
});
