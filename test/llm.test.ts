import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { DEFAULT_JUDGE, emptyUsage, experimentSchema, settingsSchema, type Experiment } from '../src/contracts.js';
import { ExperimentLab } from '../src/experiment.js';
import { hasCompleteJudgment, observableSources, scenarioSources } from '../src/judge.js';
import { callModel, ProviderFailure, type ProviderFailureKind } from '../src/llm/model-call.js';
import { resolveModels } from '../src/llm/models.js';
import { REPAIR_ATTEMPTS, runStructured, StructuredTaskError } from '../src/llm/structured.js';
import { createPiRuntime, evaluatorVersion } from '../src/pi.js';
import { planSemanticWork } from '../src/scenario-work.js';
import { callContext, fixture, fixtureSettings, type Reply } from './helpers/pi-fixture.js';
import { libraryFixture } from './helpers/scenario-library.js';

const storedFixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const text = (content: unknown): string => typeof content === 'string' ? content : (content as { text?: string }[]).map(part => part.text ?? '').join('');

/** Agrees with every rubric, citing the last agent reply verbatim: the deterministic judge the stored judgments were made with. */
function agreeingJudgment(data: string): string {
  const input = JSON.parse(data) as { scenario: { metrics: { id: string }[] }; trial: { events: { seq: number; type: string; content: string }[] } };
  const reply = input.trial.events.filter(event => event.type === 'assistant' && event.content.trim()).at(-1);
  return JSON.stringify({ assessments: input.scenario.metrics.map(metric => reply
    ? { metricId: metric.id, passCondition: 'met', failCondition: 'not_met', rationale: 'The recorded reply answers the request.', evidence: [reply.seq], citations: [{ seq: reply.seq, quote: reply.content.slice(0, 120) }] }
    : { metricId: metric.id, passCondition: 'unclear', failCondition: 'unclear', rationale: 'No agent reply was recorded.', evidence: [], citations: [] }) });
}

/** OpenRouter's Chat Completions endpoint, offline: every request is kept, and `answer` writes the reply to its last message. */
function openRouter(answer: (data: string, body: any) => string) {
  const bodies: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (request, init) => {
    assert.equal(String(typeof request === 'object' && 'url' in request ? request.url : request), 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    return new Response(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: answer(text(body.messages.at(-1).content), body) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  return { bodies, restore() { globalThis.fetch = original; } };
}

const verifies = (record: Experiment) => record.trials.map(trial => {
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId)!;
  return hasCompleteJudgment({ scenario, sources: observableSources(scenarioSources(record, scenario), record.requirements), trial });
});
/** A receipt without its audit hash: the audit also keeps request times; protocol, input, configuration, transport and votes are the judgment. */
const receipts = (record: Experiment) => record.trials.map(trial => {
  const { auditHash: _, ...receipt } = trial.judgeReceipt!;
  return receipt;
});

/*
 * test/fixtures/pre-harness-judgments.json holds the stored runs recorded-run.json (judged by an offline Pi provider, and by
 * the default OpenRouter judge) and legacy-demo-run.json, reassessed at 85f0fa7 through the Pi runtime that still opened a
 * coding-agent session per request, with the judge above. They are how the tests hold the harness to the receipts already on disk.
 */
test('judgments written before the harness still verify, and the harness writes the same receipts for the same stored runs', async () => {
  const judged = await storedFixture('pre-harness-judgments.json') as Record<string, unknown>;
  const local = { provider: fixtureSettings.provider, model: fixtureSettings.model };
  const wire = openRouter(data => agreeingJudgment(data));
  try {
    for (const [name, source, judge] of [['recordedRun', 'recorded-run.json', local], ['recordedRunOpenRouter', 'recorded-run.json', DEFAULT_JUDGE], ['legacyDemoRun', 'legacy-demo-run.json', local]] as const) {
      const before = experimentSchema.parse(judged[name]);
      assert.ok(before.trials.every(trial => trial.judgeReceipt?.complete && !trial.judgeAudit), `${name} carries receipts only`);
      assert.deepEqual(verifies(before), before.trials.map(() => true), `${name}: a receipt made before the harness verifies`);
      // Today's evaluator also names the controller of compiled cards (its prompt left the card definitions), so it is a
      // new evaluator version; a stored run keeps its own, and only its judge receipts must stay identical.
      assert.notEqual(evaluatorVersion(before.settings), before.evaluatorVersion, `${name}: the controller prompt is part of today's evaluator version`);
      const f = await fixture(request => agreeingJudgment(text(request.messages.at(-1)!.content)));
      const directory = await mkdtemp(join(tmpdir(), 'agent-lab-llm-'));
      try {
        await f.runtime.setRuntimeApiKey('openrouter', 'offline-fixture-key');
        const lab = new ExperimentLab(directory, await createPiRuntime(settingsSchema.parse({ ...fixtureSettings, judge }), f.runtime));
        await lab.init();
        try {
          const stored = experimentSchema.parse(await storedFixture(source));
          await lab.store.save(stored);
          const pending = await lab.reassess(stored.id, { judge });
          await lab.waitForIdle();
          const after = await lab.get(pending.id);
          assert.equal(after.phase, 'results_review', after.error ?? '');
          assert.deepEqual(verifies(after), after.trials.map(() => true));
          assert.equal(after.evaluatorVersion, evaluatorVersion(after.settings), 'the reassessment is judged by today\'s evaluator');
          assert.deepEqual(receipts(after), receipts(before), `${name}: the same judge protocol, input, configuration, transport and votes`);
        } finally { await lab.close(); }
      } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
    }
    assert.ok(wire.bodies.length > 0, 'the OpenRouter judge answered on the wire');
  } finally { wire.restore(); }
});

test('a provider that did not answer fails with its stored label, typed by kind, and the request is charged exactly once', async () => {
  const cases: [Reply, ProviderFailureKind, string][] = [
    [{ content: [], stopReason: 'error', errorMessage: '429 Too Many Requests' }, 'rate limit', 'Pi provider response incomplete: rate limit'],
    [{ content: [], stopReason: 'error', errorMessage: 'Insufficient credits on the account' }, 'insufficient credit', 'Pi provider response incomplete: insufficient credit'],
    [{ content: [], stopReason: 'error', errorMessage: 'This model maximum context length is 8192 tokens' }, 'context limit', 'Pi provider response incomplete: context limit'],
    [{ content: [], stopReason: 'error', errorMessage: 'upstream went away' }, 'incomplete', 'Pi provider response incomplete: error'],
    [{ content: [{ type: 'text', text: '{"partial":' }], stopReason: 'length' }, 'incomplete', 'Pi provider response incomplete: length'],
    ['   ', 'empty', 'Модель вернула пустой ответ.'],
  ];
  for (const [reply, kind, message] of cases) {
    const f = await fixture(() => reply);
    try {
      const { ctx, usage } = callContext(), partial: string[] = [];
      const model = f.runtime.getModel(fixtureSettings.provider, fixtureSettings.model)!;
      await assert.rejects(callModel(f.runtime, model, { system: 's', messages: [{ role: 'user', content: 'q', timestamp: 0 }], maxTokens: 100 }, ctx, value => partial.push(value)),
        error => error instanceof ProviderFailure && error.kind === kind && error.message === message);
      assert.deepEqual(usage, { calls: 1, inputTokens: 13, outputTokens: 5, costUsd: 0.032 }, message);
      assert.deepEqual(partial, kind === 'incomplete' && message.endsWith('length') ? ['{"partial":'] : [], 'a partial text is evidence, never an answer');
    } finally { await f.close(); }
  }
});

test('the deadline ends a request whose provider ignores cancellation, and an unanswered request is never reported as free', async () => {
  const f = await fixture(() => new Promise<never>(() => {}));
  try {
    const { ctx, usage } = callContext({ timeoutMs: 30 });
    const model = f.runtime.getModel(fixtureSettings.provider, fixtureSettings.model)!;
    await assert.rejects(callModel(f.runtime, model, { system: 's', messages: [{ role: 'user', content: 'q', timestamp: 0 }], maxTokens: 100 }, ctx),
      error => error instanceof ProviderFailure && error.kind === 'deadline' && error.message === 'Pi request deadline exceeded');
    assert.deepEqual(usage, { calls: 1, inputTokens: 0, outputTokens: 0, costUsd: null });
  } finally { await f.close(); }
});

test('a provider without credentials is refused before the budget is charged, as an unreachable provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-llm-'));
  try {
    const runtime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, modelsStorePath: join(directory, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
    runtime.registerProvider('keyless', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1',
      models: [{ id: 'm', name: 'Keyless fixture', reasoning: false, input: ['text'], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
      streamSimple() { throw new Error('A request without credentials must not be sent.'); } });
    const { ctx, usage } = callContext();
    await assert.rejects(callModel(runtime, runtime.getModel('keyless', 'm')!, { system: 's', messages: [{ role: 'user', content: 'q', timestamp: 0 }], maxTokens: 100 }, ctx),
      error => error instanceof ProviderFailure && error.kind === 'unavailable' && /Запрос к keyless\/m не прошёл/.test(error.message));
    assert.deepEqual(usage, emptyUsage());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a structured task repairs within one conversation, names its step in every failure and keeps the failure class', async () => {
  const task = { id: 'probe', label: 'Проба', role: 'builder' as const, instructions: 'Return the answer.', output: z.strictObject({ answer: z.literal(42) }) };
  const never = await fixture(() => '{"answer":41}');
  try {
    const models = await resolveModels(never.runtime, fixtureSettings, AbortSignal.timeout(1000));
    await assert.rejects(runStructured(never.runtime, models, task, { question: 'x' }, callContext().ctx),
      error => error instanceof StructuredTaskError && error.message.startsWith(`Проба: модель ${REPAIR_ATTEMPTS} раза подряд`) && /These fields do not match the schema: answer \(/.test(error.message));
    assert.equal(never.requests.length, REPAIR_ATTEMPTS);
    assert.deepEqual(never.requests[1]!.messages.map(message => message.role), ['user', 'assistant', 'user'], 'a repair continues the same message list');
    assert.match(text(never.requests[1]!.messages[2]!.content), /Your previous answer was rejected/);
  } finally { await never.close(); }
  const limited = await fixture(() => ({ content: [], stopReason: 'error', errorMessage: 'rate limit reached' }));
  try {
    const models = await resolveModels(limited.runtime, fixtureSettings, AbortSignal.timeout(1000));
    await assert.rejects(runStructured(limited.runtime, models, task, {}, callContext().ctx),
      error => error instanceof ProviderFailure && error.kind === 'rate limit' && error.message === 'Проба: Pi provider response incomplete: rate limit');
    assert.equal(limited.requests.length, 1, 'a provider failure is not repaired');
  } finally { await limited.close(); }
});

test('the catalog is an enum of the source selection schema up to 500 articles; a larger catalog is checked id by id', async () => {
  const dialogue = { id: 'd', messages: [{ role: 'user' as const, content: 'Как вернуть деньги?' }] };
  for (const size of [3, 501]) {
    const catalog = Array.from({ length: size }, (_, i) => ({ id: `article_${i}`, name: `Статья ${i}`, chars: 100 }));
    const f = await fixture((_request, index) => JSON.stringify({ sourceIds: index === 0 ? ['article_1', 'invented'] : ['article_1'] }));
    try {
      assert.deepEqual(await f.adapter.selectSources!({ task: 't', catalog, dialogue, limit: 5 }, callContext().ctx), { sourceIds: ['article_1'] });
      const schema = f.requests[0]!.systemPrompt!.split('\n').find(line => line.startsWith('{"$schema"'))!;
      assert.equal(JSON.parse(schema).properties.sourceIds.items.enum?.length, size === 3 ? 3 : undefined);
      assert.equal(JSON.parse(schema).properties.sourceIds.maxItems, 5, 'the limit is stated in the schema');
      assert.match(text(f.requests[1]!.messages.at(-1)!.content), size === 3 ? /Not a catalog id/ : /Unknown source ids: invented/);
    } finally { await f.close(); }
  }
});

test('every judge-role task of an OpenRouter judge goes through the Chat Completions adapter pinned to its upstream', async () => {
  const library = libraryFixture();
  const job = planSemanticWork(library).jobs[0]!;
  const wire = openRouter(data => {
    const input = JSON.parse(data);
    return JSON.stringify({ findings: input.fields.flatMap((field: any) => field.paths.map((path: string) => ({ variantId: field.variantId, path, status: 'ready', reason: 'Проверено' }))) });
  });
  const f = await fixture(() => { throw new Error('The builder provider must not answer a judge-role task.'); });
  try {
    await f.runtime.setRuntimeApiKey('openrouter', 'offline-fixture-key');
    const adapter = await createPiRuntime(settingsSchema.parse({ ...fixtureSettings, judge: DEFAULT_JUDGE }), f.runtime);
    await adapter.assessScenarioProposals!(job.input, callContext().ctx);
    assert.equal(wire.bodies.length, 1);
    for (const body of wire.bodies) {
      assert.equal(body.model, DEFAULT_JUDGE.model);
      assert.deepEqual(body.provider, { only: [DEFAULT_JUDGE.upstream], allow_fallbacks: false });
      assert.deepEqual(body.response_format, { type: 'json_object' });
    }
    assert.equal(f.requests.length, 0);
  } finally { wire.restore(); await f.close(); }
});
