import { expect, test } from "./fixtures";
import { assertLlmSpanShape, pickPort, pollOutline, outlineMatches, requireEnvOrThrow, runStandardChatTurn, spawnTsExample, TEST_PROMPT_RX, verifyRunInWorkshopUi } from "./helpers";

test.beforeAll(() => requireEnvOrThrow("ANTHROPIC_API_KEY"));

// Claude Code SDK spawns sub-agents on Sonnet; bump per-test budget for
// network jitter even though the echo prompt usually finishes in <30s.
test.setTimeout(180_000);

test("claude-agent-sdk: SDK ships → workshop UI renders + DB matches", async ({ page, workshop }, testInfo) => {
  const example = await spawnTsExample({
    name: "claude-agent-sdk",
    port: pickPort(testInfo.workerIndex, 4),
    workshopUrl: workshop.url,
    extraEnv: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
  });
  try {
    const { workshopUrl, runId } = await runStandardChatTurn(page, example.url, { sendTimeoutMs: 120_000 });
    const outline = await pollOutline(workshop.url, runId, outlineMatches("claude_agent", TEST_PROMPT_RX));
    expect(outline.spans.length).toBeGreaterThan(0);
    // claude-agent-sdk hardcodes claude-haiku-4-5; SDK emits LLM_GENERATION
    // outer + LLM inner, both stamped with the claude model.
    await assertLlmSpanShape(workshop.url, runId, { modelRegex: /^claude/i });
    await verifyRunInWorkshopUi(page, workshopUrl, { textRegex: TEST_PROMPT_RX });
  } finally {
    await example.stop();
  }
});
