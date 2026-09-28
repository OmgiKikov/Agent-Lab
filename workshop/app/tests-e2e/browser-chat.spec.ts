import { expect, test } from "./fixtures";
import { pickPort, pollOutline, outlineMatches, requireEnvOrThrow, TEST_PROMPT_RX, runStandardChatTurn, spawnTsExample, verifyRunInWorkshopUi } from "./helpers";

test.beforeAll(() => requireEnvOrThrow("OPENAI_API_KEY"));


test("browser-chat: SDK ships → workshop UI renders + DB matches", async ({ page, workshop }, testInfo) => {
  const example = await spawnTsExample({
    name: "browser-chat",
    port: pickPort(testInfo.workerIndex, 5),
    workshopUrl: workshop.url,
    extraEnv: { OPENAI_API_KEY: process.env.OPENAI_API_KEY! },
  });
  try {
    const { workshopUrl, runId } = await runStandardChatTurn(page, example.url);
    // Browser SDK emits partial events only — no OTLP spans, so assert on
    // the run row + run.input/output presence rather than spans.count.
    const outline = await pollOutline(workshop.url, runId, outlineMatches("browser_chat", TEST_PROMPT_RX));
    expect(outline.run).toBeTruthy();
    await verifyRunInWorkshopUi(page, workshopUrl, { textRegex: TEST_PROMPT_RX });
  } finally {
    await example.stop();
  }
});
