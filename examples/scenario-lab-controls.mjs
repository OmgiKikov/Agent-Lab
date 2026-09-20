/** Run after a snapshot build: node examples/scenario-lab-controls.mjs
 * Actual runner/controller/sandbox/checkpoints; no model-quality claim.
 * Pass --model to additionally calibrate the configured Pi judge on independent labeled traces.
 */
import { runGeneratorControls } from '../dist/generator-evaluation.js';
import { createPiRuntime } from '../dist/pi.js';
import { emptyUsage, settingsSchema } from '../dist/contracts.js';
const settings = settingsSchema.parse({
  ...(process.env.AGENT_LAB_PROVIDER ? { provider: process.env.AGENT_LAB_PROVIDER } : {}),
  ...(process.env.AGENT_LAB_MODEL ? { model: process.env.AGENT_LAB_MODEL } : {}),
  maxCalls: 12, maxDurationMs: 120000, timeoutMs: 20000,
});
const usage = emptyUsage();
const signal = AbortSignal.timeout(settings.maxDurationMs);
const ctx = { signal, timeoutMs: settings.timeoutMs,
  beforeCall() { signal.throwIfAborted(); if (usage.calls >= settings.maxCalls) throw new Error('Лимит вызовов исчерпан'); usage.calls++; },
  addUsage(value) { usage.inputTokens += value.inputTokens; usage.outputTokens += value.outputTokens; usage.costUsd = usage.costUsd === null || value.costUsd === null ? null : usage.costUsd + value.costUsd; },
};
const judge = process.argv.includes('--model') ? await createPiRuntime(settings) : undefined;
const result = await runGeneratorControls(judge, ctx);
process.stdout.write(JSON.stringify({ ...result, usage }, null, 2) + '\n');
