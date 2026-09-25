import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { DEFAULT_JUDGE, emptyUsage, experimentSchema, fingerprint, settingsSchema, type Experiment, type Usage } from '../src/contracts.js';
import type { JudgeAudit } from '../src/assessment.js';
import { ExperimentLab } from '../src/experiment.js';
import { hasCompleteJudgment, JUDGE_PROMPT, JUDGE_PROTOCOL, JUDGE_PROTOCOL_16384, JUDGE_RESPONSE_FORMAT, judgeResponseSchema, observableSources, scenarioSources } from '../src/judge.js';
import { PLANT_ERROR_ROLE } from '../src/judge-check-task.js';
import { MASK_FILL_ROLE } from '../src/card/unmask.js';
import { callModel, ProviderFailure, type ProviderDelivery, type ProviderFailureKind } from '../src/llm/model-call.js';
import { resolveModels } from '../src/llm/models.js';
import { runStructured, StructuredTaskError, TASK_ATTEMPTS } from '../src/llm/structured.js';
import { countText } from '../src/plural.js';
import * as prompts from '../src/prompts.js';
import { createPiRuntime, evaluatorVersion } from '../src/pi.js';
import { callContext, fixture, fixtureSettings, type Reply } from './helpers/pi-fixture.js';
import { cardDraft } from './helpers/card-library.js';
import { pendingClaims, reviewRequests } from '../src/card/review.js';

const storedFixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('a single JSON fence costs one call; extra prose, broken JSON and invalid fields still fail', async () => {
  const task = { id: 'fenced-json', label: 'Fenced JSON', role: 'builder' as const, instructions: 'Return an answer.', output: z.strictObject({ answer: z.string() }) };
  for (const reply of ['```json\n{"answer":"да"}\n```', '```\r\n{"answer":"да"}\r\n```']) {
    const f = await fixture(() => reply);
    try {
      const models = await resolveModels(f.runtime, fixtureSettings, new AbortController().signal);
      const { ctx, usage } = callContext();
      assert.deepEqual(await runStructured(f.runtime, models, task, {}, ctx), { answer: 'да' });
      assert.equal(usage.calls, 1);
    } finally { await f.close(); }
  }
  for (const reply of ['Here it is:\n```json\n{"answer":"да"}\n```', '```json\n{"answer":"да"}\n```\nextra', '```json\n{"answer":}\n```', '```json\n{"answer":123}\n```', '```json\n{"answer":"да"}\n```\n```json\n{}\n```']) {
    const f = await fixture(() => reply);
    try {
      const models = await resolveModels(f.runtime, fixtureSettings, new AbortController().signal);
      await assert.rejects(runStructured(f.runtime, models, task, {}, callContext().ctx), StructuredTaskError);
    } finally { await f.close(); }
  }
});

test('long valid structured replies use the model output window without byte-based rejection or repairs', async () => {
  const answer = { text: 'Подробное объяснение. '.repeat(1500) };
  const limits: Array<number | undefined> = [];
  const f = await fixture((_request, _index, options) => {
    limits.push(options?.maxTokens);
    return JSON.stringify(answer);
  }, false, true, 65_536);
  try {
    const models = await resolveModels(f.runtime, fixtureSettings, new AbortController().signal);
    const { ctx, usage } = callContext();
    for (const bounded of [undefined, { requestBytes: 200_000 }]) {
      const result = await runStructured(f.runtime, models, {
        id: 'long-reply', label: 'Long reply', role: 'builder', instructions: 'Explain fully.',
        output: z.strictObject({ text: z.string() }), ...(bounded ? { bounded } : {}),
      }, {}, ctx);
      assert.deepEqual(result, answer);
    }
    assert.deepEqual(limits, [65_536, 65_536]);
    assert.equal(usage.calls, 2, 'one call per task, with no repairs for response size');
  } finally { await f.close(); }
});
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
/** Compare the actual evidence and votes across the old and current output-window configurations. */
const receipts = (record: Experiment) => record.trials.map(trial => {
  const { auditHash: _, protocolHash: _protocol, configurationHash: _configuration, ...receipt } = trial.judgeReceipt!;
  return receipt;
});

/*
 * test/fixtures/pre-harness-judgments.json holds the stored runs recorded-run.json (judged by an offline Pi provider, and by
 * the default OpenRouter judge) and legacy-demo-run.json, reassessed at 85f0fa7 through the Pi runtime that still opened a
 * coding-agent session per request, with the judge above. They are how the tests hold the harness to the receipts already on disk.
 */
test('old judgments still verify and new judgments preserve evidence and votes under the updated configuration', async () => {
  const judged = await storedFixture('pre-harness-judgments.json') as Record<string, unknown>;
  const local = { provider: fixtureSettings.provider, model: fixtureSettings.model };
  const wire = openRouter(data => agreeingJudgment(data));
  try {
    for (const [name, source, judge] of [['recordedRun', 'recorded-run.json', local], ['recordedRunOpenRouter', 'recorded-run.json', DEFAULT_JUDGE], ['legacyDemoRun', 'legacy-demo-run.json', local]] as const) {
      const before = experimentSchema.parse(judged[name]);
      assert.ok(before.trials.every(trial => trial.judgeReceipt?.complete && !trial.judgeAudit), `${name} carries receipts only`);
      assert.deepEqual(verifies(before), before.trials.map(() => true), `${name}: a receipt made before the harness verifies`);
      // Stored runs retain their evaluator; new judgments name the current output-window policy.
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
          assert.deepEqual(receipts(after), receipts(before), `${name}: the same input, transport and votes`);
          for (const [index, trial] of after.trials.entries()) {
            assert.notEqual(trial.judgeReceipt!.protocolHash, before.trials[index]!.judgeReceipt!.protocolHash);
            assert.notEqual(trial.judgeReceipt!.configurationHash, before.trials[index]!.judgeReceipt!.configurationHash);
          }
        } finally { await lab.close(); }
      } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
    }
    assert.ok(wire.bodies.length > 0, 'the OpenRouter judge answered on the wire');
  } finally { wire.restore(); }
});

/** A judgment's protocol hash as it is sealed: the protocol alone, or under the judge's sampling configuration. */
const sealedProtocol = (judged: { configurationHash?: string }) => judged.configurationHash
  ? fingerprint({ protocol: JUDGE_PROTOCOL_16384, configuration: judged.configurationHash }) : JUDGE_PROTOCOL_16384;

test('stored audits retain the frozen prompt and old protocol while new judgments use a distinct protocol', async () => {
  // The sidecar audits of a stored run keep the prompt the judge was given, word for word.
  const directory = new URL('./fixtures/library-v1/run.judge/', import.meta.url);
  const audits = await Promise.all((await readdir(directory)).map(async name => JSON.parse(await readFile(new URL(name, directory), 'utf8')) as JudgeAudit));
  assert.ok(audits.length > 0);
  for (const audit of audits) {
    assert.equal(audit.prompt, JUDGE_PROMPT, 'the frozen prompt is the stored one');
    assert.equal(audit.protocolHash, sealedProtocol(audit));
  }
  // Every stored receipt is sealed by the protocol that hashes the frozen prompt and response format.
  const judged = await storedFixture('pre-harness-judgments.json') as Record<string, unknown>;
  const stored = Object.values(judged).flatMap(value => experimentSchema.parse(value).trials.map(trial => trial.judgeReceipt!));
  assert.ok(stored.length > 0);
  for (const receipt of stored) assert.equal(receipt.protocolHash, sealedProtocol(receipt));
  assert.equal(JUDGE_PROTOCOL_16384, '23b18c288b2345bd2a044b687ceb63f5000e71a897a44b8dbac35e7a0937ff75', 'the protocol of every stored judgment');
  assert.notEqual(JUDGE_PROTOCOL, JUDGE_PROTOCOL_16384);
  // The prompt shows the answer's schema as frozen text. When a zod upgrade writes the parse schema differently this fails:
  // check that it still accepts the same answers, and change this expectation — never the prompt.
  const shown = JUDGE_PROMPT.slice(JUDGE_PROMPT.lastIndexOf('\n') + 1);
  assert.equal(shown, JSON.stringify(z.toJSONSchema(judgeResponseSchema)));
  assert.doesNotMatch(JSON.stringify(JUDGE_RESPONSE_FORMAT), /"(minimum|maximum|minLength|maxLength|maxItems)"/, 'the wire format drops the bounds the grammar lacks');
});

test('every structured task is told the data boundary exactly once', async () => {
  // runStructured puts it after every role; a role that carried it too told the model twice.
  for (const [name, role] of Object.entries({ ...prompts, PLANT_ERROR_ROLE, MASK_FILL_ROLE })) {
    if (name !== 'DATA_BOUNDARY' && typeof role === 'string') assert.ok(!role.includes(prompts.DATA_BOUNDARY), `${name} carries the data boundary itself`);
  }
  const f = await fixture(() => JSON.stringify({ replyIndex: 0, newReply: 'Обратитесь в поддержку.', whatWasBroken: 'Агент отправил клиента в поддержку.' }));
  try {
    await f.adapter.plantError!.plant({ expectation: 'Не отправлять в поддержку', rules: ['Никогда не направляй в поддержку'], replies: [{ index: 0, text: 'Сделайте возврат в приложении.' }] }, callContext().ctx);
    assert.equal(f.requests[0]!.systemPrompt!.split(prompts.DATA_BOUNDARY).length - 1, 1);
  } finally { await f.close(); }
});

test('a provider that did not answer fails with its stored label, typed by kind and by what the request cost, and is charged exactly once', async () => {
  // Refused before any answer: nothing was generated, the cost is known and zero. Answered or cut: the provider's usage.
  const free: Usage = { calls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const billed: Usage = { calls: 1, inputTokens: 13, outputTokens: 5, costUsd: 0.032 };
  const cases: [Reply, ProviderFailureKind, ProviderDelivery, string, Usage][] = [
    [{ content: [], stopReason: 'error', errorMessage: 'Insufficient credits on the account' }, 'insufficient credit', 'refused', 'Pi provider response incomplete: insufficient credit', free],
    [{ content: [], stopReason: 'error', errorMessage: 'This model maximum context length is 8192 tokens' }, 'context limit', 'refused', 'Pi provider response incomplete: context limit', free],
    [{ content: [], stopReason: 'error', errorMessage: 'upstream went away' }, 'incomplete', 'cut', 'Pi provider response incomplete: error', { ...free, costUsd: null }],
    [{ content: [], stopReason: 'error', errorMessage: 'upstream went away', started: true }, 'incomplete', 'cut', 'Pi provider response incomplete: error', billed],
    [{ content: [{ type: 'text', text: '{"partial":' }], stopReason: 'length' }, 'length', 'answered', 'Pi provider response incomplete: length', billed],
    ['   ', 'empty', 'answered', 'Модель вернула пустой ответ.', billed],
  ];
  for (const [reply, kind, delivery, message, charged] of cases) {
    const f = await fixture(() => reply);
    try {
      const { ctx, usage } = callContext(), partial: string[] = [];
      const model = f.runtime.getModel(fixtureSettings.provider, fixtureSettings.model)!;
      await assert.rejects(callModel(f.runtime, model, { system: 's', messages: [{ role: 'user', content: 'q', timestamp: 0 }] }, ctx, value => partial.push(value)),
        error => error instanceof ProviderFailure && error.kind === kind && error.delivery === delivery && error.message === message);
      assert.equal(f.requests.length, 1, `${message}: a refusal waiting cannot fix, and anything that may have been billed, is not sent again`);
      assert.deepEqual(usage, charged, message);
      assert.deepEqual(partial, kind === 'length' ? ['{"partial":'] : [], 'a partial text is evidence, never an answer');
    } finally { await f.close(); }
  }
});

test('the deadline ends a request whose provider ignores cancellation, and an unanswered request is never reported as free', async () => {
  const f = await fixture(() => new Promise<never>(() => {}));
  try {
    const { ctx, usage } = callContext({ timeoutMs: 30 });
    const model = f.runtime.getModel(fixtureSettings.provider, fixtureSettings.model)!;
    await assert.rejects(callModel(f.runtime, model, { system: 's', messages: [{ role: 'user', content: 'q', timestamp: 0 }] }, ctx),
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
    await assert.rejects(callModel(runtime, runtime.getModel('keyless', 'm')!, { system: 's', messages: [{ role: 'user', content: 'q', timestamp: 0 }] }, ctx),
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
      error => error instanceof StructuredTaskError && error.message.startsWith(`Проба: модель ${countText(TASK_ATTEMPTS, ['раз', 'раза', 'раз'])} подряд вернула`)
        && /These fields do not match the schema: answer \(/.test(error.message));
    assert.equal(never.requests.length, TASK_ATTEMPTS);
    assert.deepEqual(never.requests[1]!.messages.map(message => message.role), ['user', 'assistant', 'user'], 'a repair continues the same message list');
    assert.match(text(never.requests[1]!.messages[2]!.content), /Your previous answer was rejected/);
  } finally { await never.close(); }
  const denied = await fixture(() => ({ content: [], stopReason: 'error', status: 401, errorMessage: '401 Incorrect API key provided' }));
  try {
    const models = await resolveModels(denied.runtime, fixtureSettings, AbortSignal.timeout(1000));
    await assert.rejects(runStructured(denied.runtime, models, task, {}, callContext().ctx),
      error => error instanceof ProviderFailure && error.kind === 'access denied' && error.message === 'Проба: Pi provider response incomplete: access denied'
        && error.delivery === 'refused' && !error.retryable && error.status === 401);
    assert.equal(denied.requests.length, 1, 'a provider failure is not repaired');
  } finally { await denied.close(); }
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
  // The card reviewer is a judge-role task like the rubric votes.
  const { library, evidence } = cardDraft({ review: false });
  const card = library.cards[0]!, context = { library, evidence };
  const request = reviewRequests(card, pendingClaims(card, context), context)[0]!;
  const wire = openRouter(data => {
    const input = JSON.parse(data) as { claims: { alias: string }[] };
    return JSON.stringify({ claims: Object.fromEntries(input.claims.map(claim => [claim.alias, { status: 'ready', reason: 'Проверено' }])) });
  });
  const f = await fixture(() => { throw new Error('The builder provider must not answer a judge-role task.'); });
  try {
    await f.runtime.setRuntimeApiKey('openrouter', 'offline-fixture-key');
    const adapter = await createPiRuntime(settingsSchema.parse({ ...fixtureSettings, judge: DEFAULT_JUDGE }), f.runtime);
    await adapter.reviewCard!(request, callContext().ctx);
    assert.equal(wire.bodies.length, 1);
    for (const body of wire.bodies) {
      assert.equal(body.model, DEFAULT_JUDGE.model);
      assert.deepEqual(body.provider, { only: [DEFAULT_JUDGE.upstream], allow_fallbacks: false });
      assert.deepEqual(body.response_format, { type: 'json_object' });
    }
    assert.equal(f.requests.length, 0);
  } finally { wire.restore(); await f.close(); }
});
