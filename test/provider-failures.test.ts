import { createServer } from 'node:http';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { experimentSchema, type Usage } from '../src/contracts.js';
import { ExperimentLab } from '../src/experiment.js';
import { callModel, PROVIDER_CONCURRENCY, ProviderFailure, providerFailureOf, REFUSED_RETRIES, type ModelReply, type ProviderDelivery, type ProviderFailureKind } from '../src/llm/model-call.js';
import { resolveModels } from '../src/llm/models.js';
import { runStructured } from '../src/llm/structured.js';
import type { CallContext, Runtime } from '../src/runtime.js';
import { callContext, fixture, fixtureSettings, type Reply } from './helpers/pi-fixture.js';

/*
 * What a failed model request says about itself (kind, delivery, retryable), how a request refused before any answer is
 * sent again without a second charge, and how the requests of one provider share one limit. The provider is the offline
 * Pi fixture: every reply goes through the SDK's stream protocol; a refused one never emits `start`.
 */

const ask = { system: 's', messages: [{ role: 'user' as const, content: 'q', timestamp: 0 }], maxTokens: 100 };
const failed = (errorMessage: string, rest: Partial<ModelReply> = {}): ModelReply => ({ role: 'assistant', content: [], api: 'openai-completions', provider: 'p', model: 'm',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'error', errorMessage, timestamp: 0, ...rest });

test('a failure is typed from the stream protocol, the reported status and whole words of the provider text, never from substrings', () => {
  const cases: [string, ModelReply, { started: boolean; status?: number }, ProviderFailureKind, ProviderDelivery, boolean, number | undefined][] = [
    // Words, not substrings: a token count holding «429» is not a rate limit, a load balancer is not a balance.
    ['token count', failed("This model's maximum context length is 8192 tokens. However, you requested 142900 tokens."), { started: false }, 'context limit', 'refused', false, undefined],
    ['load balancer', failed('upstream load balancer reset the connection'), { started: false }, 'connection failure', 'cut', true, undefined],
    ['status first', failed('429 Too Many Requests'), { started: false }, 'rate limit', 'refused', true, 429],
    ['status after http', failed('Giga gateway request failed with HTTP 503'), { started: false }, 'overloaded', 'refused', true, 503],
    ['status in a body', failed('{"error":{"message":"Slow down","code":429}}'), { started: false }, 'rate limit', 'refused', true, 429],
    ['status reported', failed('upstream error'), { started: false, status: 502 }, 'overloaded', 'refused', true, 502],
    ['camel case', failed('RateLimitError: slow down'), { started: false }, 'rate limit', 'refused', true, undefined],
    ['throttled tokens', failed('ThrottlingException: Too many tokens, please wait before trying again.'), { started: false }, 'rate limit', 'refused', true, undefined],
    // An exhausted quota comes with the rate limit's status, and no wait lifts it.
    ['quota', failed('429 You exceeded your current quota, please check your plan and billing details.'), { started: false }, 'insufficient credit', 'refused', false, 429],
    ['credit', failed('Your credit balance is too low to access the API.'), { started: false }, 'insufficient credit', 'refused', false, undefined],
    ['payment', failed('402 Payment Required'), { started: false }, 'insufficient credit', 'refused', false, 402],
    ['key', failed('401 Incorrect API key provided'), { started: false }, 'access denied', 'refused', false, 401],
    ['connection', failed('Connection error.'), { started: false }, 'connection failure', 'cut', true, undefined],
    // A timeout may still be answered on the provider's side; an answer that began and broke off may be billed.
    ['timeout', failed('Request timed out.'), { started: false }, 'timeout', 'cut', true, undefined],
    ['overloaded mid-answer', failed('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), { started: true }, 'overloaded', 'cut', true, undefined],
    ['output without start', failed('stream ended', { usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }), { started: false }, 'incomplete', 'cut', false, undefined],
    ['unknown delivery', failed('upstream went away'), { started: false }, 'incomplete', 'cut', false, undefined],
    ['bad request', failed('400 Invalid parameter: temperature'), { started: false }, 'incomplete', 'refused', false, 400],
    ['length', failed('', { stopReason: 'length', errorMessage: undefined }), { started: true }, 'length', 'answered', false, undefined],
  ];
  for (const [name, reply, observed, kind, delivery, retryable, status] of cases) {
    const failure = providerFailureOf(reply, observed);
    assert.deepEqual([failure.kind, failure.delivery, failure.retryable, failure.status], [kind, delivery, retryable, status], name);
    assert.ok(failure.message.startsWith('Pi provider response incomplete: '), `${name}: the stored label`);
  }
  assert.equal(providerFailureOf(failed('upstream went away'), { started: false }).message, 'Pi provider response incomplete: error', 'an unknown cause keeps the label older records carry');
});

/** A context with a call budget, summed usage and its own stop. */
function counted(signal?: AbortSignal) { return callContext({ timeoutMs: 2000, ...(signal ? { signal } : {}) }); }

test('a request refused before any answer is sent again after the wait its provider asked for, and charged once; its own cost is known and zero', async () => {
  const f = await fixture((_request, index) => index === 0
    ? { content: [], stopReason: 'error', status: 429, headers: { 'retry-after-ms': '10' }, errorMessage: '429 Too Many Requests' } : 'Готово.');
  try {
    const { ctx, usage } = counted();
    const model = f.runtime.getModel(fixtureSettings.provider, fixtureSettings.model)!;
    const answer = await callModel(f.runtime, model, ask, ctx);
    assert.equal(answer.text, 'Готово.');
    assert.equal(f.requests.length, 2);
    assert.deepEqual(usage, { calls: 1, inputTokens: 13, outputTokens: 5, costUsd: 0.032 }, 'one call against the budget; the refused request cost nothing');
  } finally { await f.close(); }
});

test('a request that stays refused fails after REFUSED_RETRIES more sends, still charged once', async () => {
  const f = await fixture(() => ({ content: [], stopReason: 'error', status: 503, headers: { 'retry-after': '0' }, errorMessage: '503 Service Unavailable' }));
  try {
    const { ctx, usage } = counted();
    const model = f.runtime.getModel(fixtureSettings.provider, fixtureSettings.model)!;
    await assert.rejects(callModel(f.runtime, model, ask, ctx),
      error => error instanceof ProviderFailure && error.kind === 'overloaded' && error.delivery === 'refused' && error.retryable && error.status === 503);
    assert.equal(f.requests.length, 1 + REFUSED_RETRIES);
    assert.deepEqual(usage, { calls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  } finally { await f.close(); }
});

test('what waiting cannot fix, what may already be billed and a wait longer than Lab waits are never sent again', async () => {
  const cases: [string, Reply, ProviderFailureKind, ProviderDelivery, Usage][] = [
    ['no access', { content: [], stopReason: 'error', status: 401, errorMessage: '401 Incorrect API key provided' }, 'access denied', 'refused', { calls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 }],
    ['cut off', { content: [], stopReason: 'error', started: true, errorMessage: 'Overloaded' }, 'overloaded', 'cut', { calls: 1, inputTokens: 13, outputTokens: 5, costUsd: 0.032 }],
    ['a two-minute wait', { content: [], stopReason: 'error', status: 429, headers: { 'Retry-After': '120' }, errorMessage: 'Too Many Requests' }, 'rate limit', 'refused', { calls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 }],
  ];
  for (const [name, reply, kind, delivery, charged] of cases) {
    const f = await fixture(() => reply);
    try {
      const { ctx, usage } = counted();
      const model = f.runtime.getModel(fixtureSettings.provider, fixtureSettings.model)!;
      await assert.rejects(callModel(f.runtime, model, ask, ctx), error => error instanceof ProviderFailure && error.kind === kind && error.delivery === delivery, name);
      assert.equal(f.requests.length, 1, name);
      assert.deepEqual(usage, charged, name);
    } finally { await f.close(); }
  }
});

test('the wait before a refused request is sent again ends when the operation stops', async () => {
  // No retry-after: Lab's own backoff, which waits at least half a second before the first repeat.
  const f = await fixture(() => ({ content: [], stopReason: 'error', errorMessage: 'Rate limit reached' }));
  try {
    const controller = new AbortController();
    const { ctx, usage } = counted(controller.signal);
    const model = f.runtime.getModel(fixtureSettings.provider, fixtureSettings.model)!;
    setTimeout(() => controller.abort(new Error('Cancelled by the user.')), 50);
    await assert.rejects(callModel(f.runtime, model, ask, ctx), /Cancelled by the user/);
    assert.equal(f.requests.length, 1, 'the stop ended the wait: nothing was sent after it');
    assert.equal(usage.calls, 1);
  } finally { await f.close(); }
});

test('the requests of one provider share one limit: the rest wait uncharged, and one stopped while waiting leaves without a charge', async () => {
  let inFlight = 0, peak = 0;
  const releases: (() => void)[] = [];
  let arrived = () => {};
  const f = await fixture(() => {
    inFlight++; peak = Math.max(peak, inFlight);
    arrived();
    return new Promise<string>(resolve => releases.push(() => { inFlight--; resolve('ok'); }));
  });
  try {
    const model = f.runtime.getModel(fixtureSettings.provider, fixtureSettings.model)!;
    let charged = 0;
    const context = (signal: AbortSignal): CallContext => ({ signal, timeoutMs: 5000, beforeCall() { charged++; }, addUsage() {} });
    const full = new Promise<void>(resolve => { arrived = () => { if (inFlight === PROVIDER_CONCURRENCY) resolve(); }; });
    const calls = Array.from({ length: PROVIDER_CONCURRENCY }, () => callModel(f.runtime, model, ask, context(new AbortController().signal)));
    const stopped = new AbortController();
    const waiting = callModel(f.runtime, model, ask, context(stopped.signal));
    const last = callModel(f.runtime, model, ask, context(new AbortController().signal));
    await full;
    assert.equal(charged, PROVIDER_CONCURRENCY, 'a request waiting for its place is not charged');
    stopped.abort(new Error('Cancelled by the user.'));
    await assert.rejects(waiting, /Cancelled by the user/);
    assert.equal(charged, PROVIDER_CONCURRENCY, 'nor when it is stopped while waiting');
    const lastSent = new Promise<void>(resolve => { arrived = resolve; });
    for (const release of releases.splice(0)) release();
    await Promise.all(calls);
    await lastSent;
    releases.shift()!();
    assert.equal((await last).text, 'ok');
    assert.equal(peak, PROVIDER_CONCURRENCY, 'never more in flight than the limit');
    assert.equal(f.requests.length, PROVIDER_CONCURRENCY + 1, 'the stopped request was never sent');
    assert.equal(charged, PROVIDER_CONCURRENCY + 1);
  } finally { await f.close(); }
});

test('a whole answer cut at the output cap is an answer: a structured task repairs it like a rejected one', async () => {
  const task = { id: 'probe', label: 'Проба', role: 'builder' as const, instructions: 'Return the answer.', output: z.strictObject({ answer: z.literal(42) }) };
  const f = await fixture((_request, index) => index === 0 ? { content: [{ type: 'text', text: '{"answer":' }], stopReason: 'length' } : '{"answer":42}');
  try {
    const models = await resolveModels(f.runtime, fixtureSettings, AbortSignal.timeout(1000));
    const { ctx, usage } = counted();
    const rejections: unknown[] = [];
    ctx.onGeneratorValidation = value => { if (!value.accepted) rejections.push(value); };
    assert.deepEqual(await runStructured(f.runtime, models, task, { question: 'x' }, ctx), { answer: 42 });
    assert.equal(f.requests.length, 2);
    assert.equal(usage.calls, 2, 'both answers were billed');
    assert.match(JSON.stringify(rejections), /cut off at the output limit/);
    assert.match(JSON.stringify(f.requests[1]!.messages), /cut off at the output limit/, 'the repair names the reason');
  } finally { await f.close(); }
});

test('a re-assessment records a judge the provider did not answer as «unavailable» by its type', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-provider-'));
  const runtime: Runtime = {
    async assess() { throw new ProviderFailure('overloaded', 'Проверка: провайдер перегружен', { delivery: 'refused' }); },
    async userTurn() { throw new Error('a re-assessment never runs the simulator'); },
  };
  const lab = new ExperimentLab(directory, runtime);
  await lab.init();
  try {
    const stored = experimentSchema.parse(JSON.parse(await readFile(new URL('./fixtures/recorded-run.json', import.meta.url), 'utf8')));
    await lab.store.save(stored);
    const pending = await lab.reassess(stored.id);
    await lab.waitForIdle();
    const record = await lab.get(pending.id);
    assert.equal(record.phase, 'results_review', record.error ?? '');
    assert.ok(record.trials.length > 0);
    for (const trial of record.trials) {
      assert.equal(trial.assessmentError, 'Проверка: провайдер перегружен');
      assert.equal(trial.assessmentFailure, 'unavailable');
    }
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});


test('a request accepted before a socket reset is not retried or declared free', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lab-provider-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let accepted = 0;
  const server = createServer(async request => {
    let body = ''; for await (const chunk of request) body += chunk;
    if (JSON.parse(body).messages.length) accepted++;
    request.socket.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const runtime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null,
    modelsStorePath: join(directory, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  runtime.registerProvider('accepted-reset', { api: 'openai-completions', apiKey: 'local-fixture',
    baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: 'test', name: 'Local test', reasoning: false,
      input: ['text'], cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, contextWindow: 20000, maxTokens: 1000 }] });
  const { ctx, usage } = callContext({ limit: 1, timeoutMs: 5000 });
  await assert.rejects(callModel(runtime, runtime.getModel('accepted-reset', 'test')!, ask, ctx),
    error => error instanceof ProviderFailure && error.kind === 'connection failure' && error.delivery === 'cut');
  assert.equal(accepted, 1);
  assert.equal(usage.calls, 1);
  assert.equal(usage.costUsd, null, 'no reply cannot establish the price of an accepted request');
});
