import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInputSchema, DEFAULT_GOAL_OBSERVATION, DEFAULT_JUDGE, type Runtime } from '../src/contracts.js';
import { ExperimentLab } from '../src/experiment.js';
import { buildResultView } from '../src/result-view.js';
import { goalObservationDefault, scoreSettings, withDefaultGoalObservation } from '../src/normalize.js';

test('the default evidence channel fills only external cards that did not choose one', () => {
  const legacy = { id: 'card' };
  assert.equal(withDefaultGoalObservation({ id: 'card', goalObservation: 'tool' as const }, 'command').goalObservation, 'tool');
  for (const kind of ['command', 'http', 'module'] as const) assert.equal(withDefaultGoalObservation<{ goalObservation?: 'reply' | 'tool' | 'state' }>(legacy, kind).goalObservation, 'reply');
  assert.equal(withDefaultGoalObservation(legacy, 'sandbox'), legacy);
  assert.deepEqual(legacy, { id: 'card' }, 'the input is never mutated');
});

test('the sandbox has no default channel; external agents default to the one constant', () => {
  assert.equal(goalObservationDefault('sandbox'), undefined);
  assert.equal(goalObservationDefault('command'), DEFAULT_GOAL_OBSERVATION);
});

test('score settings scale the budget with the number of recorded dialogues and use the default judge live', () => {
  const fifteen = scoreSettings(15, {}, 'live');
  assert.equal(fifteen.maxCalls, 120);
  assert.equal(fifteen.maxDurationMs, 1_800_000);
  assert.equal(fifteen.timeoutMs, 600_000);
  assert.deepEqual(fifteen.judge, DEFAULT_JUDGE);
  assert.notEqual(fifteen.judge, DEFAULT_JUDGE, 'the constant is copied, never shared');
  assert.equal(fifteen.repeats, 1);
  assert.deepEqual(fifteen.userModes, ['scripted']);
  const one = scoreSettings(1, {}, 'live');
  assert.equal(one.maxCalls, 20);
  assert.equal(one.maxDurationMs, 180_000);
  const many = scoreSettings(500, {}, 'live');
  assert.equal(many.maxCalls, 3000);
  assert.equal(many.maxDurationMs, 14_400_000);
  assert.equal('judge' in scoreSettings(15, {}, 'demo'), false);
});

test('owner values win over score defaults, except how imported recordings were made', () => {
  const judge = { provider: 'openai', model: 'gpt-x' };
  const settings = scoreSettings(15, { maxCalls: 7, timeoutMs: 1000, judge, userModes: ['reactive'], repeats: 3 }, 'live');
  assert.equal(settings.maxCalls, 7);
  assert.equal(settings.timeoutMs, 1000);
  assert.deepEqual(settings.judge, judge);
  assert.equal(settings.maxDurationMs, 1_800_000);
  assert.equal(settings.repeats, 1);
  assert.deepEqual(settings.userModes, ['scripted']);
});

test('a judged score card counts as decided because score records are one scripted attempt each', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-score-settings-'));
  const runtime: Runtime = {
    async prepare({ sources }, ctx) {
      ctx.beforeCall();
      return { requirements: [{ id: 'owner_rule', text: 'Answer from the owner material.', sourceId: sources[0]!.id,
        quote: sources[0]!.content, critical: false }], questions: [], agent: { name: 'Recorded agent', instructions: 'Recorded only', tools: [] }, scenarios: [] };
    },
    async goals({ dialogues }, ctx) {
      ctx.beforeCall();
      const dialogue = dialogues[0]!;
      return [{ id: `goal_${dialogue.id}`, goal: `Answer ${dialogue.id}`, opening: dialogue.messages[0]!.content,
        evidenceDialogueIds: [dialogue.id], requirementIds: ['owner_rule'], successCriteria: 'Answer from the owner material.' }];
    },
    async assess({ scenario }, ctx) {
      ctx.beforeCall();
      return scenario.metrics!.map(metric => ({ metricId: metric.id, result: 'pass' as const, rationale: 'Ответ совпадает с материалом.', evidence: [1] }));
    },
    async improve() { throw new Error('score must not improve'); },
    async openTarget() { throw new Error('score must not open the target'); },
    async userTurn() { throw new Error('score must not run the simulator'); },
  };
  const lab = new ExperimentLab(join(directory, 'runs'), runtime);
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  await lab.init();
  const input = createInputSchema.parse({ task: 'Score recorded dialogues', mode: 'live', scenarioCount: 0,
    materials: [{ name: 'policy.md', content: 'Answer from the owner material.' }],
    dialogues: ['d1', 'd2'].map(id => ({ id, messages: [{ role: 'user' as const, content: `Question ${id}` }, { role: 'assistant' as const, content: `Answer ${id}` }] })),
    settings: scoreSettings(2, {}, 'live') });
  const seed = await lab.score(input); await lab.waitForIdle();
  const imported = await lab.get(seed.id);
  assert.equal(imported.phase, 'results_review', imported.error ?? '');
  const pending = await lab.reassess(seed.id, {}, { carryUsage: true }); await lab.waitForIdle();
  const reassessed = await lab.get(pending.id);
  assert.equal(reassessed.phase, 'results_review', reassessed.error ?? '');
  const { headline } = buildResultView(reassessed);
  assert.equal(headline.decided, 2);
  assert.equal(headline.passed, 2);
});
