import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, REPO_ROOT_PATH, test } from "./fixtures";
import { assertLlmSpanShape, pickPort, pollOutline, outlineMatches, requireEnvOrThrow, TEST_PROMPT_RX, runStandardChatTurn, spawnPythonExample, verifyRunInWorkshopUi } from "./helpers";

const VENV_PY = path.join(REPO_ROOT_PATH, "examples", "python-chat", ".venv", "bin", "python");

function pickPython3(): string {
  for (const exe of ["python3.12", "python3.11", "python3.10", "python3"]) {
    if (spawnSync(exe, ["--version"], { stdio: "ignore" }).status === 0) return exe;
  }
  throw new Error("no python3 on PATH");
}

// Cold venv create + pip upgrade + pip install can run well past the
// Playwright config's default 90s hook timeout. File-level
// `test.setTimeout` only sets the per-test budget, so we extend the
// hook timeout from inside the hook body.
test.beforeAll(() => {
  test.setTimeout(300_000);
  const cwd = path.join(REPO_ROOT_PATH, "examples", "python-chat");
  if (!existsSync(VENV_PY)) {
    const r = spawnSync(pickPython3(), ["-m", "venv", ".venv"], { cwd, stdio: "inherit" });
    if (r.status !== 0) throw new Error("venv create failed");
  }
  // raindrop-ai>=0.0.49 needs a newer pip metadata format than the stock
  // 3.9 venv ships, so bump pip first. Idempotent.
  if (spawnSync(VENV_PY, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"], { cwd, stdio: "inherit" }).status !== 0) {
    throw new Error("pip upgrade failed");
  }
  if (spawnSync(VENV_PY, ["-m", "pip", "install", "--quiet", "-r", "requirements.txt"], { cwd, stdio: "inherit" }).status !== 0) {
    throw new Error("pip install failed");
  }
});

test.beforeAll(() => requireEnvOrThrow("OPENAI_API_KEY"));


test("python-chat: SDK ships → workshop UI renders + DB matches", async ({ page, workshop }, testInfo) => {
  const example = await spawnPythonExample({
    port: pickPort(testInfo.workerIndex, 8),
    workshopUrl: workshop.url,
    venvPython: VENV_PY,
  });
  try {
    const { workshopUrl, runId } = await runStandardChatTurn(page, example.url);
    const outline = await pollOutline(workshop.url, runId, outlineMatches("python_chat", TEST_PROMPT_RX));
    expect(outline.spans.length).toBeGreaterThan(0);
    // python-chat uses auto_instrument=False + manual interaction.set_properties
    // — model lands in the attributes JSON, not the dedicated spans.model
    // column. We assert only the LLM-type span exists; the request_model is
    // already covered by outlineMatches + the public API check above.
    await assertLlmSpanShape(workshop.url, runId, { requireModelColumn: false });
    await verifyRunInWorkshopUi(page, workshopUrl, { textRegex: TEST_PROMPT_RX });
  } finally {
    await example.stop();
  }
});
