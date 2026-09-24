import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MetricAssessment } from '../src/assessment.js';
import { recordedExpectationResult } from '../src/card/expectations.js';
import { proposalPayload, type CardProposal } from '../src/card/proposal.js';
import { probeToolChannel, TOOL_PROBE_OPENING } from '../src/connection.js';
import { experimentSchema, isCardExecution, type RunnableTarget } from '../src/contracts.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { rulesConsentText } from '../src/miner/plan.js';
import { toolExpectationsText } from '../src/result-text.js';
import { buildResultView } from '../src/result-view.js';
import type { Runtime } from '../src/runtime.js';
import { libraryHash } from '../src/scenario-library.js';
import { cardInput, cardRuntime, type Received } from './helpers/card-prep.js';

/*
 * W4: the agent's tool calls are judged. One probe message before the preparation learns whether the connection
 * shows a complete tool journal and names its tools; only then is the proposal offered the tool channel, the card
 * compiled with the agent's tool contract, and a tool duty decided from a cited tool result — never from the words.
 */

const agent = (exportName: string): RunnableTarget => ({ kind: 'module', path: fileURLToPath(new URL('./fixtures/kb-agent.mjs', import.meta.url)), exportName });

/** The fixture runtime; when the tool channel is offered, the explanation duty is proposed on the agent's tool and judged from its result. */
function toolRuntime(received: Received): Runtime {
  const base = cardRuntime(received);
  return { ...base,
    async proposeCard(request, ctx): Promise<CardProposal> {
      const proposal = structuredClone(await base.proposeCard!(request, ctx));
      if (request.call.observations.includes('tool')) proposal.agentMust = proposal.agentMust.map((duty, index) =>
        index === proposal.agentMust.length - 1 ? { ...duty, text: 'до ответа найти правила возврата в базе знаний', observation: 'tool' } : duty);
      return proposal;
    },
    async assess(input, ctx) {
      const judged = await base.assess!(input, ctx);
      const execution = input.scenario.execution;
      const tools = new Set(execution && isCardExecution(execution) ? execution.evaluatorView.expectations.filter(item => item.observation === 'tool').map(item => item.id) : []);
      const result = input.trial.events.find(event => event.type === 'tool_result');
      return judged.map((item): MetricAssessment => tools.has(item.metricId) && result ? { ...item, result: 'pass', evidence: [result.seq] } : item);
    },
  };
}

async function withLab(runtime: Runtime, work: (lab: ExperimentLab) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-tools-'));
  const lab = new ExperimentLab(directory, runtime);
  try { await lab.init(); await work(lab); } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
}

test('the probe confirms a complete, named tool journal and nothing less', async () => {
  const signal = new AbortController().signal;
  const confirmed = await probeToolChannel(agent('createSession'), TOOL_PROBE_OPENING, signal);
  assert.deepEqual([confirmed.confirmed, confirmed.tools, confirmed.reason], [true, ['kb_search'], undefined]);
  const partial = await probeToolChannel(agent('createPartialSession'), TOOL_PROBE_OPENING, signal);
  assert.deepEqual([partial.confirmed, partial.tools, partial.reason], [false, [], 'агент не подтвердил полный журнал инструментов — оцениваем только ответы']);
});

test('confirmed tools: the proposal is offered them, the card is compiled with the contract and judged by the tool result', async () => {
  const seen: Received = { proposals: [], reviews: [] };
  await withLab(toolRuntime(seen), async lab => {
    const draft = await lab.create(cardInput({ target: agent('createSession') }));
    await lab.waitForIdle();
    const { library, experiment } = await lab.readCards(draft.id);
    assert.equal(experiment.phase, 'review', experiment.error ?? '');
    assert.deepEqual([experiment.toolChannel?.confirmed, experiment.toolChannel?.tools], [true, ['kb_search']], 'the probe is stored on the record');
    assert.deepEqual(seen.proposals.map(request => [request.call.observations, request.call.tools]), [[['reply', 'tool'], ['kb_search']], [['reply', 'tool'], ['kb_search']]]);
    assert.deepEqual(proposalPayload(seen.proposals[0]!).target, { observations: ['reply', 'tool'], tools: ['kb_search'] });
    assert.deepEqual(library.cards.map(card => card.agentMust.map(duty => duty.observation)), [['reply', 'tool'], ['reply', 'tool']]);

    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    const scenario = accepted.experiment.scenarios[0]!;
    assert.deepEqual(scenario.execution?.environmentView, { mode: 'prompt', contract: { operations: ['kb_search'], reset: false, observations: ['reply', 'tool'], confirmed: true } });
    const [reply, tool] = scenario.metrics!;
    assert.ok(tool!.description.includes('по журналу инструментов агента') && !reply!.description.includes('журналу инструментов'), 'only a tool duty is judged from the tool log');

    await lab.start(draft.id, { approved: true, expectedHash: draftHash(accepted.experiment), requireAccepted: true });
    await lab.waitForIdle();
    const finished = await lab.get(draft.id);
    assert.equal(finished.phase, 'results_review', finished.error ?? '');
    const trial = finished.trials.find(item => item.scenarioId === scenario.id)!;
    const duty = { id: 'e2', observation: 'tool' as const };
    assert.equal(recordedExpectationResult(trial, duty), 'pass', 'a cited tool result of a complete journal decides the duty');
    assert.equal(recordedExpectationResult({ ...trial, observation: { ...trial.observation!, tools: 'partial' } }, duty), 'unknown', 'a partial journal proves nothing');
    const view = buildResultView(finished);
    assert.equal(view.scope.toolExpectations, 2);
    assert.equal(toolExpectationsText(view), '2 ожидания проверены по вызовам инструментов агента');
  });
});

test('an unconfirmed journal keeps the agent judged on its replies, and says why', async () => {
  const seen: Received = { proposals: [], reviews: [] };
  await withLab(toolRuntime(seen), async lab => {
    const draft = await lab.create(cardInput({ target: agent('createPartialSession') }));
    await lab.waitForIdle();
    const { library, experiment } = await lab.readCards(draft.id);
    assert.equal(experiment.phase, 'review', experiment.error ?? '');
    assert.equal(experiment.toolChannel?.reason, 'агент не подтвердил полный журнал инструментов — оцениваем только ответы');
    assert.deepEqual(seen.proposals.map(request => [request.call.observations, request.call.tools]), [[['reply'], undefined], [['reply'], undefined]]);
    assert.deepEqual(proposalPayload(seen.proposals[0]!).target, { observations: ['reply'] });
    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    assert.deepEqual(accepted.experiment.scenarios.map(scenario => scenario.execution?.environmentView), [{ mode: 'prompt' }, { mode: 'prompt' }], 'compiled as before');
    assert.equal(toolExpectationsText(buildResultView(accepted.experiment)), null);
  });
});

test('the consent names the one question to the agent; the stored probe is a closed shape', () => {
  assert.ok(rulesConsentText(1, 20, true).lines.at(-1)!.endsWith('Lab один раз спросит агента, какие инструменты он показывает.'));
  assert.ok(rulesConsentText(1, 20).lines.at(-1)!.endsWith('агент не запускается.'));
  const shape = experimentSchema.safeParse({ toolChannel: { confirmed: true, tools: ['kb_search'], checkedAt: 'now', extra: 1 } });
  assert.ok(!shape.success && shape.error.issues.some(issue => issue.path[0] === 'toolChannel'));
});
