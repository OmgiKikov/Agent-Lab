import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileCard } from '../src/card/compile.js';
import { settingsSchema } from '../src/contracts.js';
import { evaluateTrial } from '../src/evaluation.js';
import { automaticTrialResult } from '../src/outcomes.js';
import type { Runtime } from '../src/runtime.js';
import { buildResultView } from '../src/result-view.js';
import { briefCard, requirements } from './helpers/cards.js';
import { calibrated, loggedRun } from './helpers/calibration.js';

async function conversation(card: ReturnType<typeof briefCard>, runtime: Runtime) {
  const directory = await mkdtemp(join(tmpdir(), 'lab-merged-customer-'));
  const path = join(directory, 'agent.mjs');
  await writeFile(path, `export function createSession() { return {
    async respond() { return { reply: 'Возврат оформлен.', records: { order: { status: 'done' } }, resetConfirmed: true, eventsComplete: true }; },
    async close() {}
  }; }`);
  const scenario = compileCard(card, { requirements, maxTurns: 2 });
  try {
    const trial = await evaluateTrial({
      runtime: { ...runtime, async assess({ scenario, trial }) {
        return (scenario.metrics ?? []).map(metric => ({ metricId: metric.id, result: 'pass' as const,
          rationale: 'Deterministic integration vote', evidence: [trial.events.findLast(event => event.state !== undefined)?.seq
            ?? trial.events.find(event => event.type === 'assistant')!.seq] }));
      } },
      scenario, revision: { id: 'r', parentId: null, spec: { name: 'Fixture', instructions: 'Fixture', tools: [] }, hypothesis: '', createdAt: '' },
      repeat: 0, manifestHash: 'h', sources: [], requirements, settings: settingsSchema.parse({ maxTurns: 2, repeats: 1 }),
      userMode: 'reactive', target: { kind: 'module', path, exportName: 'createSession' },
      ctx: { signal: new AbortController().signal, timeoutMs: 5000, beforeCall() {}, addUsage() {} },
    });
    return { scenario, trial };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('a free customer cannot pass a required turn that was never delivered before the limit', async () => {
  const { scenario, trial } = await conversation(briefCard(), {
    async speakAsCustomer() { return { move: 'clarify', message: 'Поясните, пожалуйста.' }; },
  });
  assert.equal(trial.outcome, 'invalid');
  assert.equal(trial.invalidCause, 'simulator');
  assert.equal(automaticTrialResult(scenario, trial), 'unknown');
  assert.deepEqual(trial.events.filter(event => event.type === 'user').map(event => event.text),
    [scenario.user.opening, 'Поясните, пожалуйста.']);
});

test('a required turn delivered in the last available message can be judged', async () => {
  const card = briefCard();
  const { scenario, trial } = await conversation(card, {
    async speakAsCustomer() { return { move: 'turn', message: 'Сменить запрос' }; },
  });
  assert.equal(trial.events.filter(event => event.type === 'user').at(-1)?.text, card.client.turn!.says);
  assert.equal(trial.turnLimit, true);
  assert.equal(automaticTrialResult(scenario, trial), 'pass');
});

test('both customer modes preserve the adapter state as evidence for state expectations', async () => {
  const card = briefCard({ turn: null, agentMust: [{ id: 'e1', text: 'Изменить заказ', requirementIds: ['refund_rule'], observation: 'state' }] });
  const modes: Runtime[] = [
    { async selectUserAction() { return { actionId: 'leave' }; } },
    { async speakAsCustomer() { return { move: 'leave', message: '' }; } },
  ];
  for (const runtime of modes) {
    const { scenario, trial } = await conversation(card, runtime);
    assert.equal(trial.events.filter(event => event.type === 'observation').length, 1);
    assert.equal(automaticTrialResult(scenario, trial), 'pass');
  }
});

test('calibration keeps an unread free-customer path unknown instead of claiming drift', () => {
  const record = calibrated(loggedRun(1, () => ({ e1: 'pass', e2: 'fail' })), () => ['pass', 'pass']);
  record.trials[0]!.events.find(event => event.type === 'simulator')!.result = {
    protocol: 'card-customer-free-v1', move: 'leave', message: '',
  };
  const disagreement = buildResultView(record).calibration!.disagreements[0]!;
  assert.equal(disagreement.path, null);
  assert.notEqual(disagreement.suggests.kind, 'drift');
});
