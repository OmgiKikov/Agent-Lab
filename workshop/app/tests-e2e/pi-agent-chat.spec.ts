import { expect, test } from "./fixtures";
import { assertLlmSpanShape, pickPort, pollOutline, outlineMatches, requireEnvOrThrow, TEST_PROMPT_RX, runStandardChatTurn, spawnTsExample, verifyRunInWorkshopUi } from "./helpers";

test.beforeAll(() => requireEnvOrThrow("OPENAI_API_KEY"));

// pi-agent fans out to 4 synthetic tools per turn; budget for a single
// 120s send + DB poll + workshop UI render exceeds the 90s file default.
test.setTimeout(180_000);

test("pi-agent-chat: SDK ships → workshop UI renders + DB matches", async ({ page, workshop }, testInfo) => {
  const example = await spawnTsExample({
    name: "pi-agent-chat",
    port: pickPort(testInfo.workerIndex, 6),
    workshopUrl: workshop.url,
    extraEnv: { OPENAI_API_KEY: process.env.OPENAI_API_KEY! },
  });
  try {
    const { workshopUrl, runId } = await runStandardChatTurn(page, example.url, { sendTimeoutMs: 120_000 });
    const outline = await pollOutline(workshop.url, runId, outlineMatches("pi_agent_chat", TEST_PROMPT_RX));
    expect(outline.spans.length).toBeGreaterThan(0);
    // pi-agent-chat hardcodes gpt-4o-mini; the pi SDK stamps the model as
    // `openai/gpt-4o-mini` (provider-prefixed), so match `gpt` anywhere.
    await assertLlmSpanShape(workshop.url, runId, { modelRegex: /gpt/i });
    await verifyRunInWorkshopUi(page, workshopUrl, { textRegex: TEST_PROMPT_RX });
  } finally {
    await example.stop();
  }
});
