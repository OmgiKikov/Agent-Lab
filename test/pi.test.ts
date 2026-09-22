import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelRuntime, type ProviderConfig } from '@earendil-works/pi-coding-agent';
import { createPiRuntime, getPiStatus, groundingRequest, REPAIR_ATTEMPTS } from '../src/pi.js';
import { FOCUSED_REQUIREMENT_LIMIT } from '../src/limits.js';
import { REQUIREMENTS_ROLE } from '../src/prompts.js';
import { judgeInput } from '../src/judge.js';
import { ExperimentLab } from '../src/experiment.js';
import { DEFAULT_JUDGE, emptyUsage, promptCompliance, REQUIREMENT_LIMIT, settingsSchema, targetSchema, type CallContext, type Scenario, type Trial } from '../src/contracts.js';

type Request = Parameters<NonNullable<ProviderConfig['streamSimple']>>[1];
type Options = Parameters<NonNullable<ProviderConfig['streamSimple']>>[2];
type Message = Awaited<ReturnType<ReturnType<ModelRuntime['streamSimple']>['result']>>;
type Reply = string | Message['content'];
const settings = settingsSchema.parse({ provider: 'agent-lab-test', model: 'test-model', timeoutMs: 1000 });

test('invalid role configuration fails before any paid builder request and names configuration separately from authentication', async () => {
  const f = await fixture(() => '{}');
  try {
    await assert.rejects(createPiRuntime(settingsSchema.parse({ ...settings, judge: { provider: settings.provider, model: 'missing-judge' } }), f.runtime), /Модель не найдена в конфигурации Pi/);
    assert.equal(f.requests.length, 0);
    await assert.rejects(createPiRuntime(settingsSchema.parse({ ...settings, provider: `${settings.provider}/${settings.model}` }), f.runtime), error => {
      assert.match(String(error), /Укажите provider="agent-lab-test", model="test-model"/);
      assert.doesNotMatch(String(error), /login|ключ/); return true;
    });
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});
const reviewFields = {
  successCriteria: 'The user receives the requested result supported by observable evidence.', assumptions: ['User and record details are synthetic fixtures.'],
  metrics: [
    { id: 'goal', name: 'Goal attainment', subject: 'agent' as const, description: 'Check the requested outcome.', passCriteria: 'The requested outcome is established.', failCriteria: 'The requested outcome is contradicted or omitted.' },
    { id: 'fidelity', name: 'User fidelity', subject: 'simulator' as const, description: 'Check assigned user facts and behavior.', passCriteria: 'Known facts and assigned interaction behavior are followed.', failCriteria: 'The user invents facts or violates assigned behavior.' },
  ],
};
function plainCard(index: number): Omit<Scenario, 'split'> {
  return {
    ...reviewFields, id: `card_${index}`, familyId: 'support', title: `Support question ${index}`, requirementIds: ['req_1'], provenance: 'synthetic',
    user: { goal: 'Learn how to contact support', facts: 'I need help', persona: 'Customer seeking support', characteristics: ['Concise'], behavior: 'Ask once', opening: 'How do I contact support?', maxFollowUps: 0 },
    initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [],
  };
}

/** Scripted replies by step. A repair attempt replays the same answer, so a rejected
 * output stays rejected until the attempt bound is reached. */
function scripted(outputs: unknown[]): (request: Request, index: number, options?: Options) => Reply {
  let step = -1;
  return request => {
    if (!/Your previous answer was rejected/.test(JSON.stringify(request.messages ?? []))) step += 1;
    return JSON.stringify(outputs[step]);
  };
}

function callContext(options: { timeoutMs?: number; signal?: AbortSignal; limit?: number } = {}) {
  const usage = emptyUsage();
  const ctx: CallContext = {
    signal: options.signal ?? new AbortController().signal, timeoutMs: options.timeoutMs ?? 1000,
    beforeCall() {
      if (usage.calls >= (options.limit ?? 100)) throw new Error('Call budget exhausted');
      usage.calls++;
    },
    addUsage(value) {
      usage.inputTokens += value.inputTokens;
      usage.outputTokens += value.outputTokens;
      usage.costUsd = usage.costUsd === null || value.costUsd === null ? null : usage.costUsd + value.costUsd;
    },
  };
  return { ctx, usage };
}

async function fixture(reply: (request: Request, index: number, options?: Options) => Reply | Promise<Reply>, roleModel = false, reasoning = false) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-pi-'));
  const requests: Request[] = [];
  const modelsUsed: string[] = [];
  const runtime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'), modelsPath: null,
    modelsStorePath: join(directory, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.registerProvider('agent-lab-test', {
    api: 'openai-completions', apiKey: 'fixture-only-not-a-real-key', baseUrl: 'http://127.0.0.1:1',
    models: (roleModel ? ['test-model', 'role-model'] : ['test-model']).map(id => ({
      id, name: 'Offline SDK fixture', reasoning, input: ['text'],
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, contextWindow: 200000, maxTokens: 16384,
    })),
    streamSimple(model, request, options) {
      modelsUsed.push(model.id);
      const index = requests.length;
      requests.push(JSON.parse(JSON.stringify(request)));
      const finished = (async (): Promise<Message> => {
        const value = await reply(request, index, options);
        const content: Message['content'] = typeof value === 'string' ? [{ type: 'text', text: value }] : value;
        return {
          role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18,
            cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.001, total: 0.032 } },
          stopReason: content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now(),
        };
      })();
      // The SDK consumes the public stream iterator/result protocol. No network or model output is mocked above it.
      return {
        result: () => finished,
        async *[Symbol.asyncIterator]() {
          const message = await finished;
          yield { type: 'start', partial: message };
          yield { type: 'done', reason: message.stopReason, message };
        },
      } as ReturnType<ModelRuntime['streamSimple']>;
    },
  });
  return {
    runtime, requests, directory, modelsUsed,
    adapter: await createPiRuntime(settings, runtime),
    async close() { await rm(directory, { recursive: true, force: true }); },
  };
}

/** An external agent over HTTP inside the test process: it answers each delivered message in turn and keeps what it received. */
async function httpAgent(reply: (message: string, index: number) => unknown) {
  const { createServer } = await import('node:http');
  const sent: string[] = [], bodies: unknown[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body) as { message: string };
      bodies.push(parsed); sent.push(parsed.message);
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify(reply(parsed.message, sent.length - 1)));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as import('node:net').AddressInfo;
  return { sent, bodies, target: targetSchema.parse({ kind: 'http', url: `http://127.0.0.1:${port}/` }),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test('real SDK sessions omit discovered resources and simulator receives only explicit user data', async () => {
  const f = await fixture(() => JSON.stringify({ message: 'Please use the later time.', done: false }));
  const cwd = process.cwd();
  try {
    await mkdir(join(f.directory, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(f.directory, 'AGENTS.md'), 'PRIVATE_CONTEXT_SENTINEL');
    await writeFile(join(f.directory, '.pi', 'extensions', 'leak.ts'), "process.env.AGENT_LAB_EXTENSION_LOADED='yes'; export default function() {};");
    process.chdir(f.directory);
    const { ctx, usage } = callContext();
    const output = await f.adapter.userTurn({
      user: {
        goal: 'Reschedule', facts: 'Record ID A; desired time 11:00', behavior: 'Provide the ID and time when asked', opening: 'Move my appointment', maxFollowUps: 1,
        persona: 'Appointment holder', characteristics: ['Answers concisely'],
        checks: 'HIDDEN_RUBRIC_SENTINEL', initialState: { transientFailures: 'BACKEND_FAILURE_SCHEDULE_SENTINEL' },
      } as never,
      messages: [{ role: 'assistant', content: 'Which time?' }], turn: 1,
    }, ctx);
    assert.equal(output.message, 'Please use the later time.');
    assert.equal(usage.calls, 1);
    assert.deepEqual(usage, { calls: 1, inputTokens: 13, outputTokens: 5, costUsd: 0.032 });
    const payload = JSON.stringify(f.requests);
    assert.match(payload, /Which time/);
    assert.match(payload, /Record ID A; desired time 11:00/);
    assert.match(payload, /maxFollowUps/);
    assert.match(payload, /Appointment holder|Answers concisely/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /assigned interaction behavior takes priority over achieving the goal/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /use done:true rather than repeatedly asking "try again" to force success/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /Before composing another message, check whether the assigned stopping condition/);
    assert.doesNotMatch(payload, /PRIVATE_CONTEXT_SENTINEL|HIDDEN_RUBRIC_SENTINEL|BACKEND_FAILURE_SCHEDULE_SENTINEL|Current working directory/);
    assert.deepEqual(f.requests[0]?.tools, []);
    assert.ok(f.requests.every(r => !(r.tools ?? []).some(t => /web|fetch|browse|bash|read|write/.test(t.name))));
    assert.equal(process.env.AGENT_LAB_EXTENSION_LOADED, undefined);
    const status = await getPiStatus(f.runtime);
    assert.deepEqual(status.models, [{ provider: 'agent-lab-test', id: 'test-model', name: 'Offline SDK fixture' }]);
  } finally { process.chdir(cwd); await f.close(); }
});

test('simulator preserves a final user message separately from stopping without another message', async () => {
  const replies = [{ message: 'Record ID A.', done: true }, { done: true }];
  const f = await fixture((_request, index) => JSON.stringify(replies[index]));
  try {
    const input = {
      user: { goal: 'Move my appointment', facts: 'Record ID A', behavior: 'Provide the ID when asked, then end', opening: 'Move my appointment', maxFollowUps: 1 },
      messages: [{ role: 'assistant' as const, content: 'What is the record ID?' }], turn: 1,
    };
    assert.deepEqual(await f.adapter.userTurn(input, callContext().ctx), replies[0]);
    assert.deepEqual(await f.adapter.userTurn(input, callContext().ctx), { done: true, message: '' });
    assert.match(f.requests[0]?.systemPrompt ?? '', /done:true with a nonempty message means deliver this final user message, receive the target response, then end/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /done:true with an empty message means stop now without another target response/);
  } finally { await f.close(); }
});

test('the call budget stops a repair before another provider request, and malformed structured output remains invalid', async () => {
  const f = await fixture(() => 'This is not JSON');
  try {
    const { ctx, usage } = callContext({ limit: 1 });
    await assert.rejects(f.adapter.groundRequirements!({ task: 'Check rules', sources: [{ id: 'source_1', name: 'rules.md', content: 'Reply formally.', hash: 'h' }] }, ctx), /Call budget exhausted/);
    assert.equal(usage.calls, 1);
    assert.equal(f.requests.length, 1, 'the repair attempt is refused before it reaches the provider');
  } finally { await f.close(); }
  const malformed = await fixture(() => 'This is not JSON');
  try {
    await assert.rejects(malformed.adapter.userTurn!({ user: { goal: 'A', facts: 'A', behavior: 'A', opening: 'A' }, messages: [], turn: 0 }, callContext().ctx), /не проходит проверку.*not a single JSON object/s);
  } finally { await malformed.close(); }
});

test('a structured answer wrapped in a markdown fence is not repaired into JSON', async () => {
  const fenced = await fixture(() => '```json\n{"message":"Move it to 11:00","done":false}\n```');
  try {
    const input = { user: { goal: 'A', facts: 'A', behavior: 'A', opening: 'A' }, messages: [], turn: 0 };
    await assert.rejects(fenced.adapter.userTurn(input, callContext().ctx), /не проходит проверку.*not a single JSON object/s);
  } finally { await fenced.close(); }

  const prose = await fixture(() => 'Here you go: {"message":"hi","done":false}');
  try {
    await assert.rejects(prose.adapter.userTurn({ user: { goal: 'A', facts: 'A', behavior: 'A', opening: 'A' }, messages: [], turn: 0 }, callContext().ctx), /не проходит проверку.*not a single JSON object/s);
  } finally { await prose.close(); }
});

test('grounding asks the model for requirements only: one request, no cards and no agent', async () => {
  // Nothing here may be invented by the model: the owner brought the agent, and the situations come from the library.
  const f = await fixture(() => JSON.stringify({
    requirements: [{ id: 'req_1', text: 'The agent answers acquiring questions.', sourceId: 'source-1', quote: 'answers acquiring questions', critical: true }],
    questions: [],
  }));
  try {
    const grounded = await f.adapter.groundRequirements!({
      task: 'Evaluate the owner agent',
      sources: [{ id: 'source-1', name: 'perimeter.md', content: 'The agent answers acquiring questions and nothing else.', hash: 'h' }],
    }, callContext().ctx);
    assert.deepEqual(Object.keys(grounded).sort(), ['questions', 'requirements']);
    assert.equal(grounded.requirements[0]!.quote, 'answers acquiring questions');
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('two requirements with one id go back to the model instead of failing the preparation', async () => {
  const content = 'Rule one: reply formally. Rule two: numbered steps.';
  const req = (id: string, quote: string) => ({ id, text: id, sourceId: 'source_1', quote, critical: true });
  const outputs = [
    { requirements: [req('req_1', 'reply formally'), req('req_1', 'numbered steps')], questions: [] },
    { requirements: [req('req_1', 'reply formally'), req('req_2', 'numbered steps')], questions: [] },
  ];
  const f = await fixture((_request, index) => JSON.stringify(outputs[index]));
  try {
    const grounded = await f.adapter.groundRequirements!({ task: 'Check rules', sources: [{ id: 'source_1', name: 'rules.md', content, hash: 'h' }] }, callContext().ctx);
    assert.deepEqual(grounded.requirements.map(r => r.id), ['req_1', 'req_2']);
    assert.match(JSON.stringify(f.requests[1]?.messages), /share an id/);
  } finally { await f.close(); }
});

test('deadline and external cancellation reach the actual SDK provider stream', async () => {
  for (const cancel of [false, true]) {
    let providerAborted = false;
    const f = await fixture((_request, _index, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => { providerAborted = true; reject(new Error('request aborted')); }, { once: true });
    }));
    try {
      const controller = new AbortController();
      const { ctx, usage } = callContext({ timeoutMs: cancel ? 1000 : 25, signal: controller.signal });
      const pending = f.adapter.userTurn({ user: { goal: 'A', facts: 'A', behavior: 'A', opening: 'A' }, messages: [], turn: 0 }, ctx);
      const timer = cancel ? setTimeout(() => controller.abort(new Error('User cancelled')), 25) : undefined;
      await assert.rejects(pending, cancel ? /User cancelled/ : /deadline exceeded/);
      if (timer) clearTimeout(timer);
      assert.equal(providerAborted, true);
      assert.equal(usage.costUsd, null, 'Aborted requests without usage cannot be reported as free');
    } finally { await f.close(); }
  }
});

test('missing model selection fails without demo fallback', async () => {
  await assert.rejects(createPiRuntime(settingsSchema.parse({})), /Выберите провайдера и модель/);
});

test('isolated assessment uses approved rubrics and trace evidence without inheriting deterministic verdicts', async () => {
  const assessments = [
    { metricId: 'goal', result: 'pass', rationale: 'The reply provides the support contact.', evidence: [1], citations: [{ seq: 1, quote: 'support@example.test' }] },
    { metricId: 'fidelity', result: 'unknown', rationale: 'No reactive user turn occurred.', evidence: [], citations: [] },
  ];
  const f = await fixture((_request, index, options) => { assert.equal(options?.temperature, 0); return JSON.stringify({ assessments: assessments.slice(Math.floor(index / 2), Math.floor(index / 2) + 1).map(({ result, ...row }) => ({ ...row, passCondition: result === 'pass' ? 'met' : 'unclear', failCondition: result === 'pass' ? 'not_met' : 'unclear' })) }); });
  try {
    const scenario: Scenario = { ...plainCard(0), split: 'dev' };
    scenario.user.script = ['UNDELIVERED_FOLLOWUP_SENTINEL']; scenario.user.maxFollowUps = 1;
    const trial: Trial = {
      id: 'trial_1', revisionId: 'revision_1', scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0,
      split: 'dev', userMode: 'static', manifestHash: 'hash', outcome: 'fail', reason: 'DETERMINISTIC_GRADE_SENTINEL', checks: [],
      events: [{ seq: 0, type: 'user', text: 'How do I contact support?' }, { seq: 1, type: 'assistant', text: 'Email support@example.test.' }],
      initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1,
      observation: { state: 'missing', tools: 'partial' },
    };
    const { ctx, usage } = callContext();
    assert.deepEqual((await f.adapter.assess!({ scenario, sources: [], trial }, ctx)).map(a => ({ ...a, rationale: a.rationale.replace(/^Совпало 2\/2 оценок этой рубрики в свежих сессиях; это не проверка правильности\. /, '') })), assessments);
    assert.equal(usage.calls, 4);
    assert.deepEqual(f.requests[0]?.tools, []);
    assert.deepEqual(f.requests[0]?.messages.map(({ role, content }) => ({ role, content })), f.requests[1]?.messages.map(({ role, content }) => ({ role, content })), 'each vote receives exactly the same evidence and no previous judgment; SDK timestamps are local metadata');
    const payload = JSON.stringify(f.requests[0]?.messages);
    assert.match(payload, /passCriteria|support@example.test/);
    assert.match(payload, /userMode.*static/);
    assert.doesNotMatch(payload, /DETERMINISTIC_GRADE_SENTINEL/);
    assert.doesNotMatch(payload, /UNDELIVERED_FOLLOWUP_SENTINEL/);
    assert.match(payload, /observation.*missing.*partial/);
    assert.match(payload, /finalState\\?":null/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /actual event seq number/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /provisional model estimates for human review/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /check each continuation against the stopping rule/);
    assert.deepEqual(await f.adapter.assess!({ scenario: { ...scenario, metrics: undefined }, sources: [], trial }, ctx), []);
    assert.equal(usage.calls, 4, 'Legacy cards without rubrics do not incur a judge call');
  } finally { await f.close(); }
});

test('расплывчатое имя типа провала отклоняется и переписывается, ссылки проверяются', async () => {
  const failures = [
    { trialId: 't1', card: 'Тариф', reason: 'Часть проверок провалена.', failed: ['Клиент получил ответ'], trace: 'Агент: оператору необходимо осуществить ручной поиск' },
    { trialId: 't2', card: 'Возврат', reason: 'Часть проверок провалена.', failed: ['Клиент получил ответ'], trace: 'Агент: обратитесь на горячую линию' },
  ];
  const vague = { modes: [{ id: 'bad', name: 'Bad answer', description: 'd', trialIds: ['t1', 't2'] }] };
  const invented = { modes: [{ id: 'hotline', name: 'Отправил на горячую линию вместо ответа', description: 'd', trialIds: ['t1', 't9'] }] };
  const good = { modes: [{ id: 'hotline', name: 'Отправил на горячую линию вместо ответа', description: 'Нашёл статью и всё равно перевёл клиента.', stage: 'сборка ответа', trialIds: ['t1', 't2'] }] };
  // Каждая попытка получает следующий ответ: проверяем, что отказ доходит и правка принимается.
  const replies = [vague, invented, good];
  let step = -1;
  const f = await fixture(() => { step += 1; return JSON.stringify(replies[step]); });
  try {
    const modes = await f.adapter.failureModes!({ task: 'Проверить агента', failures }, callContext().ctx);
    assert.deepEqual(modes, good.modes);
    assert.equal(f.requests.length, 3, 'две попытки отклонены, третья принята');
    const rejections = JSON.stringify(f.requests.slice(1).map(r => r.messages));
    assert.match(rejections, /does not say what went wrong/);
    assert.match(rejections, /not in the supplied failures/);
  } finally { await f.close(); }
});

test('a rejected answer is repaired from the stated reason instead of losing the run', async () => {
  const quote = 'Support is available by email.';
  const source = { id: 'source_1', name: 'Policy', content: quote, hash: 'hash' };
  // First the model paraphrases the source, which is the most common real rejection.
  const outputs = [
    { requirements: [{ id: 'req_1', text: quote, sourceId: 'source_1', quote: 'Support can be reached by email.', critical: true }], questions: [] },
    { requirements: [{ id: 'req_1', text: quote, sourceId: 'source_1', quote, critical: true }], questions: [] },
  ];
  const f = await fixture((_request, index) => JSON.stringify(outputs[index]));
  try {
    const grounded = await f.adapter.groundRequirements!({ task: 'Evaluate support answers', sources: [source] }, callContext().ctx);
    assert.equal(grounded.requirements[0]?.quote, quote);
    assert.equal(f.requests.length, 2, 'one rejected answer, one repair');
    const repair = JSON.stringify(f.requests[1]?.messages ?? []);
    assert.match(repair, /Your previous answer was rejected/);
    assert.match(repair, /verbatim substring/, 'the model is told exactly what to fix');
  } finally { await f.close(); }
});

test('a source marked as the agent prompt reaches the builder and the judge labelled', async () => {
  const prompt = 'Отвечай только по эквайрингу. Всегда заканчивай ответ вопросом «Чем ещё помочь?». Никогда не называй внутренние системы.';
  const f = await fixture(() => JSON.stringify({ requirements: [{ id: 'req_1', text: 'Every reply ends with «Чем ещё помочь?»', sourceId: 'prompt_1', quote: 'Всегда заканчивай ответ вопросом «Чем ещё помочь?»', critical: true }], questions: [] }));
  try {
    const promptSource = { id: 'prompt_1', name: 'system.md', content: prompt, hash: 'hash', kind: 'prompt' as const };
    await f.adapter.groundRequirements!({ task: 'Проверить агента эквайринга', sources: [promptSource, { id: 'kb_1', name: 'Статья', content: 'Тариф виден в СберБизнес.', hash: 'h2' }] }, callContext().ctx);
    assert.match(f.requests[0]?.systemPrompt ?? '', /kind: prompt\) is the agent's own instructions, not a business policy/);
    assert.match(JSON.stringify(f.requests[0]?.messages), /system\.md \(промпт агента\)/);
    assert.doesNotMatch(JSON.stringify(f.requests[0]?.messages), /Статья \(промпт агента\)/);
    const card: Scenario = { ...plainCard(0), split: 'dev', checks: [], metrics: [{ ...promptCompliance }] };
    const judge = judgeInput({ scenario: card, sources: [promptSource],
      trial: { id: 't', revisionId: 'r', scenarioId: card.id, familyId: card.familyId, repeat: 0, userMode: 'static', split: 'dev', manifestHash: 'h', outcome: 'ungraded', reason: '', checks: [], events: [], initialState: card.initialState, finalState: card.initialState, usage: emptyUsage(), elapsedMs: 1 } });
    assert.equal(judge.sources[0]!.name, 'system.md (промпт агента)');
  } finally { await f.close(); }
});

test('role overrides select the actual SDK model independently for simulation and judging', async () => {
  const f = await fixture((_request, index) => JSON.stringify(index === 0 ? { message: '', done: true }
    : { assessments: [{ metricId: 'goal', passCondition: 'met', failCondition: 'not_met', rationale: 'Recorded reply provides help', evidence: [1], citations: [{ seq: 1, quote: 'Here is help' }] }] }), true);
  try {
    const adapter = await createPiRuntime(settingsSchema.parse({ ...settings, roles: { judge: { provider: settings.provider, model: 'role-model' } } }), f.runtime);
    const scenario = { ...plainCard(0), split: 'dev' as const, metrics: [reviewFields.metrics[0]!] };
    await adapter.userTurn({ user: scenario.user, messages: [{ role: 'user', content: 'Help' }, { role: 'assistant', content: 'Here is help' }], turn: 0 }, callContext().ctx);
    const trial: Trial = { id: 't', scenarioId: scenario.id, familyId: scenario.familyId, revisionId: 'r', userMode: 'static', repeat: 0, split: 'dev',
      manifestHash: 'hash', outcome: 'ungraded', reason: '', checks: [], initialState: scenario.initialState, finalState: scenario.initialState,
      usage: emptyUsage(), elapsedMs: 1, events: [{ seq: 0, type: 'user', text: 'Help' }, { seq: 1, type: 'assistant', text: 'Here is help' }] };
    const result = await adapter.assess!({ scenario, sources: [], trial }, callContext().ctx);
    assert.equal(result[0]!.result, 'pass');
    assert.deepEqual(f.modelsUsed, ['test-model', 'role-model', 'role-model']);
  } finally { await f.close(); }
});

for (const judge of [{ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6', upstream: 'anthropic' }, DEFAULT_JUDGE])
test(`OpenRouter ${judge.model} sends the pinned provider and isolated rubric on the wire`, async () => {
  const f = await fixture(() => { throw new Error('The planner provider must not assess'); });
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: any }[] = [];
  try {
    await f.runtime.setRuntimeApiKey('openrouter', 'offline-fixture-key');
    assert.equal(f.runtime.getModel('openrouter', 'anthropic/claude-sonnet-4.6')!.api, 'anthropic-messages', 'fixture exercises the catalog adapter mismatch');
    globalThis.fetch = async (request, init) => {
      const url = String(typeof request === 'object' && 'url' in request ? request.url : request);
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
      const body = JSON.parse(String(init?.body)); requests.push({ url, body });
      assert.equal(body.model, judge.model);
      assert.deepEqual(body.provider, { only: [judge.upstream], allow_fallbacks: false });
      if (judge.model === DEFAULT_JUDGE.model) assert.deepEqual(body.reasoning, { effort: 'medium' });
      assert.equal(body.temperature, f.runtime.getModel(judge.provider, judge.model)!.reasoning ? undefined : 0);
      assert.equal(body.max_tokens, 16384); assert.equal(body.max_completion_tokens, undefined);
      assert.equal(body.messages[0].role, 'system');
      assert.equal(body.response_format.type, 'json_schema'); assert.equal(body.response_format.json_schema.strict, true);
      assert.equal(body.response_format.json_schema.schema.properties.assessments.maxItems, undefined);
      const content = body.messages.at(-1).content;
      const data = JSON.parse(typeof content === 'string' ? content : content.map((c: any) => c.text ?? '').join(''));
      assert.equal(data.scenario.metrics.length, 1, 'the actual HTTP request isolates each rubric');
      const answer = JSON.stringify({ assessments: [
        { metricId: 'goal', passCondition: 'met', failCondition: 'not_met', rationale: 'The instruction is present.', evidence: [1], citations: [{ seq: 1, quote: 'Instruction' }] },
        { metricId: 'fidelity', passCondition: 'unclear', failCondition: 'unclear', rationale: 'No dynamic turn.', evidence: [], citations: [] },
      ].filter(m => m.metricId === data.scenario.metrics[0].id) });
      return new Response(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
    const adapter = await createPiRuntime({ ...settings, judge }, f.runtime);
    const scenario = { ...plainCard(0), split: 'dev' as const };
    const trial: Trial = { id: 'trial', revisionId: 'revision', scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0, split: 'dev', userMode: 'static',
      manifestHash: 'hash', outcome: 'ungraded', reason: '', checks: [], events: [{ seq: 0, type: 'user', text: 'Help' }, { seq: 1, type: 'assistant', text: 'Instruction' }],
      initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1 };
    const { ctx, usage } = callContext();
    assert.equal((await adapter.assess!({ scenario, trial, sources: [] }, ctx))[0]!.result, 'pass');
    assert.equal(usage.calls, 4); assert.equal(requests.length, 4);
    assert.deepEqual(requests[0]!.body.messages, requests[1]!.body.messages);
    assert.deepEqual(requests[2]!.body.messages, requests[3]!.body.messages);
    assert.notDeepEqual(requests[0]!.body.messages, requests[2]!.body.messages);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test('the simulator receives knows, answers and cannotKnow but never the external world', async () => {
  const f = await fixture(() => JSON.stringify({ message: 'It ends with 4321.', done: false }));
  try {
    const { ctx } = callContext();
    const reply = await f.adapter.userTurn({ user: { goal: 'Block the lost card', facts: 'Card ends with 4321', behavior: 'Answer once', opening: 'Block my card', maxFollowUps: 1,
      knows: ['Last four digits 4321'], cannotKnow: ['Why the hold exists'], answers: [{ ifAsked: 'digits', reply: 'It ends with 4321.' }],
      initialState: { external: { secret: 'EXTERNAL_WORLD_SENTINEL' } } } as never, messages: [{ role: 'assistant', content: 'Which card?' }], turn: 1 }, ctx);
    assert.equal(reply.message, 'It ends with 4321.');
    const wire = JSON.stringify(f.requests);
    assert.match(wire, /Last four digits 4321/);
    assert.match(wire, /Why the hold exists/);
    assert.match(wire, /answers.{0,20}ifAsked.{0,20}digits/);
    assert.doesNotMatch(wire, /EXTERNAL_WORLD_SENTINEL/);
    assert.match(wire, /never invent a value/);
  } finally { await f.close(); }
});

test('failure clusters may quote only a supplied prompt, verbatim', async () => {
  const cluster = (promptQuotes: string[]) => ({ modes: [{ id: 'hotline', name: 'Нашёл статью и всё равно отправил на линию', description: 'd', trialIds: ['t1'], promptQuotes }] });
  const failures = [{ trialId: 't1', card: 'c', reason: 'r', failed: ['x'], trace: '#1 user: hi' }];
  const f = await fixture((_request, index) => JSON.stringify(index === 0 ? cluster(['not in the prompt']) : cluster(['hand off to the hotline'])));
  try {
    const modes = await f.adapter.failureModes!({ task: 't', failures, prompt: 'When unsure, hand off to the hotline.' }, callContext().ctx);
    assert.deepEqual(modes[0]!.promptQuotes, ['hand off to the hotline']);
    assert.match(JSON.stringify(f.requests), /verbatim substring of the supplied prompt/);
    assert.match(JSON.stringify(f.requests[0]), /When unsure, hand off to the hotline/);
  } finally { await f.close(); }
  const g = await fixture((_request, index) => JSON.stringify(index === 0 ? cluster(['anything']) : cluster([])));
  try {
    const modes = await g.adapter.failureModes!({ task: 't', failures }, callContext().ctx);
    assert.deepEqual(modes[0]!.promptQuotes, []);
    assert.match(JSON.stringify(g.requests), /No prompt was supplied/);
  } finally { await g.close(); }
});

test('requirements extraction states its budget and asks the model to merge when it overshoots', async () => {
  const quote = 'Reply in the formal register and never redirect the user to a phone line.';
  const many = Array.from({ length: REQUIREMENT_LIMIT + 1 }, (_, i) => ({ id: `req_${i}`, text: `Observable rule ${i}`, sourceId: 'prompt_1', quote, critical: false }));
  const outputs = [{ requirements: many, questions: [] }, { requirements: many.slice(0, 2), questions: [] }];
  const f = await fixture((_request, index) => JSON.stringify(outputs[index]));
  try {
    const grounded = await f.adapter.groundRequirements!({
      task: 'Check the agent against its own prompt',
      sources: [{ id: 'prompt_1', name: 'prompt.md', content: quote, hash: 'h', kind: 'prompt' }],
    }, callContext().ctx);
    assert.equal(grounded.requirements.length, 2);
    // The budget is stated up front, and an overshoot is answered with what to do, not with a schema dump.
    assert.match(f.requests[0]?.systemPrompt ?? '', new RegExp(`at most ${REQUIREMENT_LIMIT} requirements`));
    const repair = JSON.stringify(f.requests[1]?.messages);
    assert.match(repair, new RegExp(`at most ${REQUIREMENT_LIMIT} requirements`));
    assert.match(repair, /merge closely related rules/i);
    assert.doesNotMatch(repair, /Too big/);
  } finally { await f.close(); }
});

test('requirement quotes are matched through the typography a model normalises, then stored in the source\'s own characters', async () => {
  const content = 'Раздел «Эквайринг» → «Мои точки продаж» → карточка точки → «Тариф».';
  const f = await fixture(() => JSON.stringify({ requirements: [{ id: 'req_1', text: 'Where the tariff is shown', sourceId: 'source_1', quote: 'Раздел "Эквайринг" -> "Мои точки продаж"', critical: true }], questions: [] }));
  try {
    const grounded = await f.adapter.groundRequirements!({ task: 'Check tariff answers', sources: [{ id: 'source_1', name: 'idp/tariff_view.md', content, hash: 'h' }] }, callContext().ctx);
    assert.equal(f.requests.length, 1, 'normalised typography costs no repair attempt');
    assert.equal(grounded.requirements[0]!.quote, 'Раздел «Эквайринг» → «Мои точки продаж»');
  } finally { await f.close(); }
});

test('raw line breaks are rejected and a new valid provider reply preserves the exact source text', async () => {
  const quote = 'Rule one.\nRule two.';
  const sources = [{ id: 'source_1', name: 'prompt.md', content: quote, hash: 'h', kind: 'prompt' as const }];
  const valid = JSON.stringify({ requirements: [{ id: 'req_1', text: 'Two rules', sourceId: 'source_1', quote, critical: true }], questions: [] });
  const rawNewline = '{"requirements":[{"id":"req_1","text":"Two rules","sourceId":"source_1","quote":"Rule one.\nRule two.","critical":true}],"questions":[]}';
  const f = await fixture((_request, index) => index === 0 ? rawNewline : valid);
  try {
    const grounded = await f.adapter.groundRequirements!({ task: 'Check rules', sources }, callContext().ctx);
    assert.equal(f.requests.length, 2);
    assert.match(JSON.stringify(f.requests[1]?.messages), /not a single JSON object/);
    assert.equal(grounded.requirements[0]!.quote, quote);
  } finally { await f.close(); }
  const g = await fixture((_request, index) => index === 0 ? 'Here are the requirements: {"requirements": [}' : valid);
  try {
    const grounded = await g.adapter.groundRequirements!({ task: 'Check rules', sources }, callContext({ limit: 2 }).ctx);
    assert.equal(grounded.requirements[0]!.quote, quote);
    const repair = JSON.stringify(g.requests[1]?.messages);
    assert.match(repair, /not a single JSON object/);
    assert.match(repair, /Unexpected|position|token/i);
  } finally { await g.close(); }
});

test('unescaped quotes require a new valid provider reply and are never rewritten locally', async () => {
  const quote = 'Удали данные из "СберДруг", "ДРУГ", "ЦКР" и не упоминай "историю вопросов".';
  const broken = '{"requirements":[{"id":"req_1","text":"No "СберДруг", "ДРУГ" data in a reply","sourceId":"source_1","quote":"Удали данные из "СберДруг", "ДРУГ", "ЦКР" и не упоминай "историю вопросов".","critical":true}],"questions":[]}';
  const outputs = [broken, JSON.stringify({ requirements: [{ id: 'req_1', text: 'No \"СберДруг\", \"ДРУГ\" data in a reply', sourceId: 'source_1', quote, critical: true }], questions: [] })];
  const f = await fixture((_request, index) => outputs[index]!);
  try {
    const grounded = await f.adapter.groundRequirements!({ task: 'Check internal names', sources: [{ id: 'source_1', name: 'prompt.md', content: quote, hash: 'h', kind: 'prompt' }] }, callContext().ctx);
    assert.equal(f.requests.length, 2);
    assert.match(JSON.stringify(f.requests[1]?.messages), /not a single JSON object/);
    assert.equal(grounded.requirements[0]!.quote, quote);
    assert.equal(grounded.requirements[0]!.text, 'No "СберДруг", "ДРУГ" data in a reply');
    assert.match(f.requests[0]?.systemPrompt ?? '', /inside strings/i);
  } finally { await f.close(); }
});

test('a rejection names every requirement whose quote is not in its source, so one repair fixes them all', async () => {
  const content = 'Rule one: reply formally. Rule two: never send the user to a phone line. Rule three: numbered steps.';
  const req = (id: string, quote: string) => ({ id, text: id, sourceId: 'source_1', quote, critical: true });
  const outputs = [
    { requirements: [req('req_1', 'reply formally'), req('req_2', 'never phone the user'), req('req_3', 'numbered lists')], questions: [] },
    { requirements: [req('req_1', 'reply formally'), req('req_2', 'never send the user to a phone line'), req('req_3', 'numbered steps')], questions: [] },
  ];
  const f = await fixture((_request, index) => JSON.stringify(outputs[index]));
  try {
    const grounded = await f.adapter.groundRequirements!({ task: 'Check rules', sources: [{ id: 'source_1', name: 'prompt.md', content, hash: 'h', kind: 'prompt' }] }, callContext().ctx);
    assert.equal(grounded.requirements.length, 3);
    assert.equal(f.requests.length, 2, 'one repair fixes every named quote');
    const repair = JSON.stringify(f.requests[1]?.messages);
    assert.match(repair, /req_2/);
    assert.match(repair, /req_3/);
    assert.match(repair, /shorter/i);
  } finally { await f.close(); }
});

test('a quote that lives in another supplied source is re-attributed to it instead of being rejected', async () => {
  const rules = 'Удали из ответа служебную информацию: данные из "СберДруг", "ЦКР".';
  const articles = 'Терминал блокируется по инициативе банка.';
  const f = await fixture(() => JSON.stringify({ requirements: [{ id: 'req_1', text: 'No internal names', sourceId: 'article_1', quote: 'данные из "СберДруг", "ЦКР"', critical: true }], questions: [] }));
  try {
    const grounded = await f.adapter.groundRequirements!({ task: 'Check internal names',
      sources: [{ id: 'article_1', name: 'block.md', content: articles, hash: 'a' }, { id: 'prompt_1', name: 'prompt.md', content: rules, hash: 'p', kind: 'prompt' }] }, callContext().ctx);
    assert.equal(f.requests.length, 1);
    assert.equal(grounded.requirements[0]!.sourceId, 'prompt_1');
    assert.equal(grounded.requirements[0]!.quote, 'данные из "СберДруг", "ЦКР"');
  } finally { await f.close(); }
});

test('a machine output-format instruction in the agent prompt is an internal interface, not a requirement a user can observe', async () => {
  const prompt = 'Отвечай на «вы». ВСЕГДА возвращай валидный JSON в формате {"output": "*Финальный ответ*"}. Никогда не направляй в поддержку.';
  const req = (id: string, quote: string) => ({ id, text: id, sourceId: 'prompt_1', quote, critical: true });
  const outputs = [
    { requirements: [req('formal', 'Отвечай на «вы»'), req('json', 'ВСЕГДА возвращай валидный JSON в формате {"output": "*Финальный ответ*"}')], questions: [] },
    { requirements: [req('formal', 'Отвечай на «вы»'), req('no_support', 'Никогда не направляй в поддержку')], questions: [] },
  ];
  const f = await fixture((_request, index) => JSON.stringify(outputs[index]));
  try {
    const grounded = await f.adapter.groundRequirements!({ task: 'Check the agent against its prompt', sources: [{ id: 'prompt_1', name: 'prompt.md', content: prompt, hash: 'h', kind: 'prompt' }] }, callContext().ctx);
    assert.deepEqual(grounded.requirements.map(r => r.id), ['formal', 'no_support']);
    assert.match(JSON.stringify(f.requests[1]?.messages), /machine output format/i);
    assert.match(f.requests[0]?.systemPrompt ?? '', /machine output format/i);
  } finally { await f.close(); }
});

test('Pi chronological proposals and separate semantic assessment pass every event through real transport', async () => {
  const { importBatch, createLibrary } = await import('../src/scenario-library.js');
  const { chronologicalInput } = await import('../src/scenario-preparation.js');
  const { proposals, rawDialogues, sources, requirements } = await import('./helpers/scenario-library.js');
  const batch = importBatch(rawDialogues);
  const f = await fixture(scripted([{ proposals: proposals(batch.id).slice(1) }, { findings: [] }]));
  try {
    assert.equal(typeof f.adapter.scenarioProposals, 'function', 'real Pi exposes chronological extraction');
    const { ctx, usage } = callContext();
    const extracted = await f.adapter.scenarioProposals!({ protocol: 'chronological-scenarios-v1', task: 'Проверка', batchId: batch.id, sources, requirements, dialogues: chronologicalInput(batch) }, ctx);
    const library = createLibrary({ batch, sources, requirements, proposals: extracted });
    await f.adapter.assessScenarioProposals!({ protocol: 'chronological-scenarios-v1', library, fields: [] }, ctx);
    const first = JSON.stringify(f.requests[0]);
    assert.match(first, /Возврат займёт три дня/);
    assert.match(first, /assistant/);
    assert.match(first, /eventIndex/);
    assert.equal(usage.calls, 2, 'semantic review has its own model budget call');
    assert.match(JSON.stringify(f.requests[1]), /learned_in_source/);
  } finally { await f.close(); }
});

test('real Pi extraction, semantic admission and library store form one chronological preparation path', async () => {
  const { createInputSchema } = await import('../src/contracts.js');
  const { demoTarget } = await import('../src/demo.js');
  const { libraryHash } = await import('../src/scenario-library.js');
  const { importDialogues } = await import('../src/imports.js');
  const { coverageProposals: proposals, rawDialogues, sources, requirements } = await import('./helpers/scenario-library.js');
  const payloads: any[] = [];
  const f = await fixture(request => {
    const message = request.messages.find(message => message.role === 'user')!;
    const content = message.content;
    const text = typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('');
    const payload = JSON.parse(text); payloads.push(payload);
    if (payload.batchId) return JSON.stringify({ proposals: proposals(payload.batchId).filter(p => payload.dialogues.some((d: any) => d.id === p.variant.sourceDialogues[0]!.dialogueId)) });
    if (payload.library) return JSON.stringify({ findings: payload.fields.flatMap((field: any) => field.paths.map((path: string) => ({ variantId: field.variantId, path, status: 'ready', reason: 'Проверено по всей хронологии и требованиям' }))) });
    if (payload.user) return JSON.stringify({ done: true, message: '' });
    return JSON.stringify({ requirements: requirements.map(r => ({ ...r, sourceId: 'source-1' })), questions: [] });
  });
  const lab = new ExperimentLab(join(f.directory, 'store'), f.adapter);
  try {
    await lab.init();
    const original = importDialogues(rawDialogues);
    const seed = await lab.create(createInputSchema.parse({ task: 'Проверка', materials: sources.map(s => ({ name: s.name, content: s.content })),
      mode: 'live', scenarioCount: 0, settings, target: demoTarget(),
      existingAgent: { name: 'Агент', instructions: 'Уточните номер терминала', tools: [] },
      originalImport: original.originalImport, dialogues: original.dialogues.slice(0, 1) }));
    await lab.waitForIdle();
    const result = await lab.readLibrary(seed.id);
    assert.equal(result.experiment.phase, 'review', result.experiment.error ?? '');
    assert.deepEqual(payloads.find(p => p.dialogues?.[0]?.id === 'repeated').dialogues[0].messages.map((m: any) => m.role), ['user', 'assistant', 'user']);
    assert.equal(result.library.businessScenarios.length, 1);
    assert.equal(result.experiment.scenarios.length, 0);
    const accepted = await lab.acceptLibrary(seed.id, libraryHash(result.library), ['variant_2']);
    await f.adapter.userTurn!({ user: accepted.experiment.scenarios[0]!.user, messages: [], turn: 0 }, callContext().ctx);
    assert.doesNotMatch(JSON.stringify(payloads.find(p => p.user)), /три дня/);
    assert.equal((await lab.store.readImport(original.originalImport.id)).dialogues.length, 2);
  } finally { await lab.close(); await f.close(); }
});

test('scenario transport rejects malformed world arrays before library compilation and sends repair feedback', async () => {
  const { importBatch } = await import('../src/scenario-library.js');
  const { chronologicalInput } = await import('../src/scenario-preparation.js');
  const { proposals, rawDialogues, sources, requirements } = await import('./helpers/scenario-library.js');
  const batch = importBatch(rawDialogues), valid = proposals(batch.id)[0]!;
  const bad = structuredClone(valid); bad.variant.environmentFixture.initialState.records = [] as any;
  const f = await fixture((_request, index) => JSON.stringify({ proposals: [index ? valid : bad] }));
  try {
    const { ctx, usage } = callContext();
    const output = await f.adapter.scenarioProposals!({ protocol: 'chronological-scenarios-v1', task: 'Проверка возврата', batchId: batch.id,
      sources, requirements, dialogues: chronologicalInput(batch, ['terminal']) }, ctx);
    assert.equal(usage.calls, 2);
    assert.deepEqual(output[0]!.variant.environmentFixture.initialState.records, {});
    assert.match(JSON.stringify(f.requests[1]), /initialState.records/);
    assert.match(f.requests[0]!.systemPrompt!, /5678/);
    assert.match(f.requests[0]!.systemPrompt!, /not already disclosed/i);
  } finally { await f.close(); }
});

test('scenario proposal transport rejects a prose deterministic check and permits semantic checkpoints without one', async () => {
  const { importBatch } = await import('../src/scenario-library.js');
  const { chronologicalInput } = await import('../src/scenario-preparation.js');
  const { proposals, rawDialogues, sources, requirements } = await import('./helpers/scenario-library.js');
  const batch = importBatch(rawDialogues), valid = proposals(batch.id)[0]!;
  delete valid.variant.evaluationSpec.checkpoints[0]!.check;
  const bad = structuredClone(valid); bad.variant.evaluationSpec.checkpoints[0]!.check = 'Проверить смысл ответа';
  const f = await fixture((_request, index) => JSON.stringify({ proposals: [index ? valid : bad] }));
  try {
    const { ctx, usage } = callContext();
    const result = await f.adapter.scenarioProposals!({ protocol: 'chronological-scenarios-v1', task: 'Проверка возврата', batchId: batch.id,
      sources, requirements, dialogues: chronologicalInput(batch, ['terminal']) }, ctx);
    assert.equal(usage.calls, 2, 'prose check must fail SDK schema admission');
    assert.equal(result[0]!.variant.evaluationSpec.checkpoints[0]!.check, undefined);
    assert.match(JSON.stringify(f.requests[1]), /checkpoints.*check/);
    assert.match(f.requests[0]!.systemPrompt!, /omit.*check.*semantic/i);
  } finally { await f.close(); }
});

test('controlled user and checkpoint roles use actual simulator/judge models and isolated compiler payloads', async () => {
  const { acceptLibrary, compileLibrary, libraryHash } = await import('../src/scenario-library.js');
  const { libraryFixture } = await import('./helpers/scenario-library.js');
  const { createUserState, allowedUserActions } = await import('../src/user-controller.js');
  const { checkpointInput } = await import('../src/checkpoints.js');
  const library = libraryFixture();
  const scenario = compileLibrary(acceptLibrary(library, libraryHash(library), ['variant_1']))[0]!;
  scenario.execution!.evaluatorView.checkpoints[0]!.rule += ' EVALUATOR_ONLY_MARKER';
  const f = await fixture((_request, index) => JSON.stringify(index === 0 ? { actionId: 'finish', factIds: [] }
    : { results: [{ checkpointId: 'ask_terminal', result: 'pass', evidence: [1], rationale: 'Уточнение соответствует правилу' }] }), true);
  try {
    const adapter = await createPiRuntime(settingsSchema.parse({ ...settings, roles: { simulator: { provider: settings.provider, model: 'role-model' } }, judge: { provider: settings.provider, model: 'test-model' } }), f.runtime);
    const state = createUserState(scenario.execution!.userView.policy, scenario.execution!.userView.facts);
    const { ctx, usage } = callContext();
    await adapter.selectUserAction!({ user: scenario.execution!.userView, state: state.position, actions: allowedUserActions(state, 'Назовите терминал'), messages: [{ role: 'assistant', content: 'Назовите терминал' }], turn: 0 }, ctx);
    const trial: Trial = { id: 't', scenarioId: scenario.id, familyId: scenario.familyId, revisionId: 'r', userMode: 'reactive', repeat: 0, split: 'dev', manifestHash: 'h', outcome: 'ungraded', reason: '', checks: [], initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1, events: [{ seq: 0, type: 'user', text: 'Возврат' }, { seq: 1, type: 'assistant', text: 'Назовите терминал' }] };
    await adapter.assessCheckpoints!(checkpointInput(scenario, trial), ctx);
    assert.deepEqual(f.modelsUsed, ['role-model', 'test-model']);
    assert.equal(usage.calls, 2);
    assert.doesNotMatch(JSON.stringify(f.requests[0]), /EVALUATOR_ONLY_MARKER|checkpoints|requirementId|environmentView|backend/);
    assert.match(JSON.stringify(f.requests[1]), /EVALUATOR_ONLY_MARKER/);
    assert.deepEqual(f.requests.map(r => r.tools), [[], []]);
  } finally { await f.close(); }
});

test('real compiler, Pi transport and evaluator enforce repair, exact disclosure and correct-versus-wrong refusal', async () => {
  const { evaluateTrial } = await import('../src/evaluation.js');
  const { headlineTrialResult } = await import('../src/outcomes.js');
  const { acceptLibrary, compileLibrary, libraryHash } = await import('../src/scenario-library.js');
  const { libraryFixture, sources, requirements } = await import('./helpers/scenario-library.js');
  const { USER_CONTROLLER_ROLE, CHECKPOINT_ROLE, ASSESS_ROLE } = await import('../src/prompts.js');
  for (const verdict of ['pass', 'fail'] as const) {
    const library = libraryFixture();
    library.variants[0]!.behaviorPolicy = { version: 1, initialState: 'ask', states: ['ask', 'answered', 'done'], terminalStates: ['done'], maxFollowUps: 1, repetitionLimit: 1,
      actions: [{ id: 'number', kind: 'answer', factIds: ['terminal_number'], payload: 'Номер терминала: 1234', ifAsked: 'номер терминала' }, { id: 'finish', kind: 'finish', factIds: [] }],
      transitions: [{ from: 'ask', to: 'answered', actionId: 'number', when: 'Уточнение номера' }, { from: 'answered', to: 'done', actionId: 'finish', when: 'Получен отказ или инструкция' }] };
    const s = compileLibrary(acceptLibrary(library, libraryHash(library), ['variant_1']))[0]!;
    s.execution!.evaluatorView.checkpoints[0]!.rule += ' EVALUATOR_ONLY_MARKER';
    let selectorCalls = 0;
    const agent = await httpAgent((_message, index) => index === 0 ? 'Назовите номер терминала' : verdict === 'pass' ? 'Без дополнительных данных возврат невозможен' : 'Возврат запрещён всем');
    const f = await fixture(request => {
      const prompt = request.systemPrompt ?? '';
      if (prompt.startsWith(USER_CONTROLLER_ROLE)) return JSON.stringify(++selectorCalls === 1 ? { actionId: 'number', factIds: ['hidden'] } : selectorCalls === 2 ? { actionId: 'number', factIds: ['terminal_number'] } : { actionId: 'finish', factIds: [] });
      if (prompt.startsWith(CHECKPOINT_ROLE)) return JSON.stringify({ results: [{ checkpointId: 'ask_terminal', result: verdict, evidence: [0, 1, 4, 5], rationale: verdict === 'pass' ? 'Корректно объяснён отказ' : 'Отказ противоречит правилу' }] });
      if (prompt.startsWith(ASSESS_ROLE)) return JSON.stringify({ assessments: [{ metricId: 'library_required', passCondition: 'met', failCondition: 'not_met', rationale: 'Уточнение дано', evidence: [1], citations: [{ seq: 1, quote: 'Назовите номер терминала' }] }] });
      throw new Error('The agent under test is external: no other model role is expected here.');
    });
    try {
      const { ctx, usage } = callContext();
      const trial = await evaluateTrial({ runtime: f.adapter, scenario: s, revision: { id: 'base', parentId: null, spec: { name: 'Агент', instructions: 'Помогать клиенту', tools: [] }, hypothesis: '', createdAt: '' }, repeat: 0, manifestHash: 'h', sources, requirements, settings: settingsSchema.parse({ ...settings, maxTurns: 2 }), ctx, userMode: 'reactive', target: agent.target });
      assert.deepEqual(trial.events.filter(e => e.type === 'user').map(e => e.text), ['Помогите с возвратом', 'Номер терминала: 1234']);
      assert.equal(trial.events.filter(e => e.type === 'assistant').length, 2);
      assert.equal(trial.events.filter(e => e.type === 'simulator' && (e.result as any).accepted === false).length, 1);
      assert.equal(headlineTrialResult(s, trial), verdict);
      assert.deepEqual(agent.sent, ['Помогите с возвратом', 'Номер терминала: 1234']);
      assert.equal(usage.calls, 6, 'three user actions, one checkpoint judgment and two rubric votes; the external agent costs no model call');
      assert.equal(trial.usage.calls, 6);
      assert.ok(trial.judgeReceipt?.complete);
      for (const request of f.requests.filter(r => !(r.systemPrompt ?? '').startsWith(CHECKPOINT_ROLE) && !(r.systemPrompt ?? '').startsWith(ASSESS_ROLE))) assert.doesNotMatch(JSON.stringify(request), /EVALUATOR_ONLY_MARKER/);
      assert.doesNotMatch(JSON.stringify(agent.bodies), /EVALUATOR_ONLY_MARKER/);
    } finally { await f.close(); await agent.close(); }
  }
});

test('checkpoint SDK boundary tolerates malformed known diagnostics while required decisions remain strict', async () => {
  const { acceptLibrary, compileLibrary, libraryHash } = await import('../src/scenario-library.js');
  const { libraryFixture } = await import('./helpers/scenario-library.js');
  const { checkpointInput } = await import('../src/checkpoints.js');
  const { assessTrial } = await import('../src/evaluation.js');
  const { headlineTrialResult } = await import('../src/outcomes.js');
  const library = libraryFixture();
  const scenario = compileLibrary(acceptLibrary(library, libraryHash(library), ['variant_1']))[0]!;
  delete scenario.metrics;
  const required = scenario.execution!.evaluatorView.checkpoints[0]!;
  required.check = { id: 'literal', kind: 'answer_contains', description: 'Уточнение', value: 'Назовите номер терминала' };
  scenario.checks = [required.check as any];
  scenario.execution!.evaluatorView.checkpoints.push({ ...required, id: 'diagnostic', role: 'diagnostic' });
  const trial: Trial = { id: 't', scenarioId: scenario.id, familyId: scenario.familyId, revisionId: 'r', userMode: 'reactive', repeat: 0, split: 'dev', manifestHash: 'h', outcome: 'ungraded', reason: '', checks: [], initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1, events: [{ seq: 0, type: 'user', text: 'Возврат' }, { seq: 1, type: 'assistant', text: 'Назовите номер терминала' }] };
  const valid = { checkpointId: 'ask_terminal', result: 'pass', evidence: [1], rationale: 'Уточнение есть' };
  for (const diagnostics of [
    [{ checkpointId: 'diagnostic', result: 4, evidence: 'wrong', rationale: null }],
    [{ ...valid, checkpointId: 'diagnostic' }, { ...valid, checkpointId: 'diagnostic' }],
  ]) {
    const f = await fixture(() => JSON.stringify({ results: [valid, ...diagnostics] }));
    try {
      const { ctx, usage } = callContext();
      await assessTrial(f.adapter, scenario, [], trial, ctx, []);
      assert.equal(headlineTrialResult(scenario, trial), 'pass');
      assert.equal(trial.checkpoints?.find(c => c.checkpointId === 'diagnostic')?.result, 'unknown');
      assert.equal(usage.calls, 1, 'diagnostic defects must not trigger batch repair or erase required evidence');
    } finally { await f.close(); }
  }
  const invalid = await fixture(() => JSON.stringify({ results: [{ ...valid, result: 4 }] }));
  try {
    await assert.rejects(invalid.adapter.assessCheckpoints!(checkpointInput(scenario, trial), callContext().ctx), /не проходит проверку/);
  } finally { await invalid.close(); }
});

test('scenario proposal transport separates no-log owner requirements from real import identity before a model call', async () => {
  const f = await fixture(() => JSON.stringify({ proposals: [] }));
  try {
    const base = { protocol: 'chronological-scenarios-v1' as const, task: 'Проверка', sources: [], requirements: [], dialogues: [] };
    const { ctx } = callContext();
    await assert.rejects(f.adapter.scenarioProposals!(base, ctx), /batchId|импорт/);
    await assert.rejects(f.adapter.scenarioProposals!({ ...base, preparationMode: 'owner_requirements', batchId: 'imaginary' }, ctx), /лог|импорт/);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await f.adapter.scenarioProposals!({ ...base, preparationMode: 'owner_requirements' }, ctx), []);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('Pi semantic transport receives authenticated owner authority beside unchanged source chronology', async () => {
  const { libraryFixture } = await import('./helpers/scenario-library.js');
  const { editLibrary, libraryHash } = await import('../src/scenario-library.js');
  const { planSemanticWork } = await import('../src/scenario-work.js');
  const source = libraryFixture();
  const edited = editLibrary(source, libraryHash(source), { kind: 'edit_fact', variantId: 'variant_1', factId: 'terminal_number', statement: 'Номер терминала: 4321', value: '4321', availability: 'initial', editId: 'owner_transport', reason: 'Личные данные известны заранее' });
  const job = planSemanticWork(edited).jobs.find(j => j.input.scope === 'fields' && j.input.fields[0]!.variantId === 'variant_1')!;
  const expected = job.input.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path, status: 'ready', reason: 'Тест передачи контекста, не модельная оценка' })));
  const f = await fixture(scripted([{ findings: expected }]));
  try {
    await f.adapter.assessScenarioProposals!(job.input, callContext().ctx);
    const request = JSON.stringify(f.requests[0]);
    assert.match(request, /ownerFactEvidence/);
    assert.match(request, /verified/);
    assert.match(request, /owner_transport/);
    assert.match(request, /1234/, 'old chronology is retained independently of edited 4321');
    assert.match(request, /4321/);
  } finally { await f.close(); }
});

test('grounding for one dialogue asks for the rules that decide that dialogue only, with a smaller cap than a whole-policy grounding', () => {
  const whole = groundingRequest({ task: 't', sources: [] });
  const focused = groundingRequest({ task: 't', sources: [], focus: { dialogueId: 'd', customerMessages: ['Как вернуть деньги?'] } });
  assert.equal(whole.limit, REQUIREMENT_LIMIT);
  assert.equal(focused.limit, FOCUSED_REQUIREMENT_LIMIT);
  assert.equal(whole.role, REQUIREMENTS_ROLE);
  assert.ok(focused.role.startsWith(REQUIREMENTS_ROLE) && /customerMessages/.test(focused.role.slice(REQUIREMENTS_ROLE.length)), 'the focus clause is appended, the base role is unchanged');
  assert.deepEqual(focused.payload.customerMessages, ['Как вернуть деньги?']);
  assert.equal('customerMessages' in whole.payload, false);
  assert.equal('dialogues' in focused.payload, false, 'the old agent’s replies never reach the grounding call');
  assert.ok(focused.schema.safeParse({ requirements: Array.from({ length: FOCUSED_REQUIREMENT_LIMIT + 1 }, (_, i) => ({ id: `r${i}`, text: 'x', sourceId: 's', quote: 'x', critical: true })), questions: [] }).success === false);
});

test('a missing JSON closer is a failed attempt; only the next complete response supplies fields', async () => {
  const { proposals, rawDialogues, sources, requirements } = await import('./helpers/scenario-library.js');
  const { importBatch, chronologicalInput } = { ...(await import('../src/scenario-library.js')), ...(await import('../src/scenario-preparation.js')) };
  const batch = importBatch(rawDialogues), expected = proposals(batch.id).slice(0, 1);
  expected[0]!.variant.environmentFixture.initialState = { records: {}, writableFields: [], transientFailures: 0 };
  const raw = JSON.stringify({ proposals: expected }).replace(/}\]}$/, ']}');
  assert.throws(() => JSON.parse(raw));
  const valid = JSON.stringify({ proposals: expected });
  const f = await fixture((_request, index) => index === 0 ? raw : valid);
  try {
    const seen: unknown[] = [], { ctx, usage } = callContext();
    ctx.onGeneratorOutput = response => seen.push(response);
    const actual = await f.adapter.scenarioProposals!({ protocol: 'chronological-scenarios-v1', task: 'Возврат', sources, requirements, batchId: batch.id, dialogues: chronologicalInput(batch) }, ctx);
    assert.deepEqual(actual, expected);
    assert.equal(usage.calls, 2);
    assert.deepEqual(seen, [{ role: (await import('../src/prompts.js')).SCENARIO_PROPOSALS_ROLE, text: raw, attempt: 1 }, { role: (await import('../src/prompts.js')).SCENARIO_PROPOSALS_ROLE, text: valid, attempt: 2 }]);
  } finally { await f.close(); }
});

test('structural recovery never supplies a truncated string or a missing schema field, and rejections stay observable', async () => {
  for (const raw of ['{"message":"unfinished', '{"done":false}']) {
    const f = await fixture(() => raw);
    try {
      const { ctx } = callContext(), rejections: unknown[] = [], outputs: unknown[] = [];
      ctx.onGeneratorValidation = value => rejections.push(value);
      ctx.onGeneratorOutput = value => outputs.push(value);
      await assert.rejects(f.adapter.userTurn({ user: { goal: 'A', facts: 'A', behavior: 'A', opening: 'A' }, messages: [], turn: 0 }, ctx), /не проходит проверку/);
      assert.equal(outputs.length, REPAIR_ATTEMPTS);
      assert.equal(rejections.length, REPAIR_ATTEMPTS);
      assert.ok(rejections.every((r: any) => r.accepted === false && r.reason));
    } finally { await f.close(); }
  }
});

test('semantic admission honors the configured judge instead of silently reusing the builder', async () => {
  const { libraryFixture } = await import('./helpers/scenario-library.js');
  const { planSemanticWork } = await import('../src/scenario-work.js');
  const job = planSemanticWork(libraryFixture()).jobs[0]!;
  const findings = job.input.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path, status: 'blocked', reason: 'Контрольный ответ транспортного теста' })));
  const f = await fixture(() => JSON.stringify({ findings }), true);
  try {
    for (const overrides of [{ roles: { judge: { provider: settings.provider, model: 'role-model' } } }, { judge: { provider: settings.provider, model: 'role-model' } }]) {
      const adapter = await createPiRuntime(settingsSchema.parse({ ...settings, ...overrides }), f.runtime);
      assert.deepEqual(await adapter.assessScenarioProposals!(job.input, callContext().ctx), findings);
    }
    assert.deepEqual(f.modelsUsed, ['role-model', 'role-model']);
  } finally { await f.close(); }
});

test('bounded schema retries retain the evidence and latest rejected draft without accumulating prior drafts', async () => {
  const { importBatch } = await import('../src/scenario-library.js');
  const { chronologicalInput } = await import('../src/scenario-preparation.js');
  const { proposals, rawDialogues, sources, requirements } = await import('./helpers/scenario-library.js');
  const batch = importBatch(rawDialogues), valid = proposals(batch.id)[0]!;
  const f = await fixture((_request, index) => index < 3 ? JSON.stringify({ wrong: `rejected-draft-${index}` }) : JSON.stringify({ proposals: [valid] }));
  try {
    await f.adapter.scenarioProposals!({ protocol: 'chronological-scenarios-v1', task: 'Исходные материалы остаются', batchId: batch.id,
      sources, requirements, dialogues: chronologicalInput(batch, ['terminal']) }, callContext().ctx);
    assert.equal(f.requests.length, 4);
    const last = JSON.stringify(f.requests[3]!.messages);
    assert.match(last, /Исходные материалы остаются/);
    assert.match(last, /rejected-draft-2/);
    assert.doesNotMatch(last, /rejected-draft-0|rejected-draft-1/);
  } finally { await f.close(); }
});

test('semantic correction uses the configured judge model and preserves the builder for ordinary proposals', async () => {
  const { importBatch } = await import('../src/scenario-library.js');
  const { chronologicalInput } = await import('../src/scenario-preparation.js');
  const { proposals, rawDialogues, sources, requirements } = await import('./helpers/scenario-library.js');
  const batch = importBatch(rawDialogues), proposal = proposals(batch.id)[0]!;
  const f = await fixture(() => JSON.stringify({ proposals: [proposal] }), true);
  try {
    const adapter = await createPiRuntime(settingsSchema.parse({ ...settings, judge: { provider: settings.provider, model: 'role-model' } }), f.runtime);
    const input = { protocol: 'chronological-scenarios-v1' as const, task: 'Проверка', batchId: batch.id, sources, requirements, dialogues: chronologicalInput(batch, ['terminal']) };
    await adapter.scenarioProposals!(input, callContext().ctx);
    await adapter.scenarioProposals!({ ...input, feedback: { proposals: [proposal], issues: [{ code: 'semantic_finding', path: 'userState', message: 'Сохранить исходную цель' }] } }, callContext().ctx);
    assert.deepEqual(f.modelsUsed, ['test-model', 'role-model']);
  } finally { await f.close(); }
});

test('an observed one-turn request without personal facts rejects invented customer follow-ups before publication', async () => {
  const { importBatch } = await import('../src/scenario-library.js');
  const { chronologicalInput } = await import('../src/scenario-preparation.js');
  const { proposals, rawDialogues, sources, requirements } = await import('./helpers/scenario-library.js');
  const batch = importBatch(rawDialogues), valid = proposals(batch.id)[0]!;
  valid.variant.userState.facts = [];
  valid.variant.behaviorPolicy = { version: 1, initialState: 'reply', states: ['reply', 'end'], terminalStates: ['end'], maxFollowUps: 0, repetitionLimit: 1,
    actions: [{ id: 'finish', kind: 'finish', factIds: [] }], transitions: [{ from: 'reply', to: 'end', actionId: 'finish', when: 'Агент ответил' }] };
  const bad = structuredClone(valid); bad.variant.behaviorPolicy.maxFollowUps = 1;
  bad.variant.behaviorPolicy.actions.push({ id: 'invented', kind: 'clarify', factIds: [], payload: 'А если у меня другая проблема?' });
  const f = await fixture((_request, index) => JSON.stringify({ proposals: [index ? valid : bad] }));
  try {
    const dialogues = chronologicalInput(batch, ['terminal']); dialogues[0]!.messages = dialogues[0]!.messages.slice(0, 1); dialogues[0]!.events = dialogues[0]!.events.slice(0, 1);
    const result = await f.adapter.scenarioProposals!({ protocol: 'chronological-scenarios-v1', task: 'Проверка', batchId: batch.id, sources, requirements, dialogues }, callContext().ctx);
    assert.equal(f.requests.length, 2);
    assert.equal(result[0]!.variant.behaviorPolicy.maxFollowUps, 0);
    assert.match(JSON.stringify(f.requests[1]!.messages), /one-turn scope/);
  } finally { await f.close(); }
});

test('proposal transport hides and rejects read-only source coverage authority fields', async () => {
  const { importBatch } = await import('../src/scenario-library.js');
  const { chronologicalInput } = await import('../src/scenario-preparation.js');
  const { proposals, rawDialogues, sources, requirements } = await import('./helpers/scenario-library.js');
  const batch = importBatch(rawDialogues), valid = proposals(batch.id)[0]!;
  const bad = { ...structuredClone(valid), variant: { ...structuredClone(valid.variant), sourceCoverageRequired: true,
    sourceCoverageBasis: [{ batchId: batch.id, dialogueId: 'terminal', eventIndex: 0 }] } };
  const f = await fixture((_request, index) => JSON.stringify({ proposals: [index ? valid : bad] }));
  try {
    const { ctx, usage } = callContext();
    const result = await f.adapter.scenarioProposals!({ protocol: 'chronological-scenarios-v1', task: 'Проверка', batchId: batch.id, sources, requirements, dialogues: chronologicalInput(batch, ['terminal']) }, ctx);
    assert.equal(usage.calls, 2, 'generated authority fields are schema-rejected before the repaired proposal is returned');
    assert.equal(result[0]!.variant.sourceCoverageRequired, undefined);
    assert.equal(result[0]!.variant.sourceCoverageBasis, undefined);
    assert.doesNotMatch(f.requests[0]!.systemPrompt!, /"sourceCoverageRequired":|"sourceCoverageBasis":/, 'the model output schema does not advertise harness-owned fields');
    assert.match(JSON.stringify(f.requests[1]!.messages), /sourceCoverageRequired|sourceCoverageBasis/);
  } finally { await f.close(); }
});

test('proposal transport rejects coverage of an opening even when the one-turn source has personal facts', async () => {
  const { importBatch } = await import('../src/scenario-library.js');
  const { chronologicalInput } = await import('../src/scenario-preparation.js');
  const { proposals, rawDialogues, sources, requirements } = await import('./helpers/scenario-library.js');
  const batch = importBatch(rawDialogues), valid = proposals(batch.id)[0]!;
  const bad = { ...structuredClone(valid), variant: { ...structuredClone(valid.variant), sourceCoverage: [{ batchId: batch.id, dialogueId: 'terminal', eventIndex: 0,
    disposition: 'initial_fact', actionIds: [], factIds: ['terminal_number'], reason: 'Номер назван в начале' }] } };
  const f = await fixture((_request, index) => JSON.stringify({ proposals: [index ? valid : bad] }));
  try {
    const result = await f.adapter.scenarioProposals!({ protocol: 'chronological-scenarios-v1', task: 'Проверка', batchId: batch.id, sources, requirements, dialogues: chronologicalInput(batch, ['terminal']) }, callContext().ctx);
    assert.equal(f.requests.length, 2);
    assert.equal(result[0]!.variant.sourceCoverage, undefined);
    assert.equal(result[0]!.variant.userState.facts[0]!.value, '1234', 'personal knowledge is preserved');
    assert.match(JSON.stringify(f.requests[1]!.messages), /opening is not a continuation/);
  } finally { await f.close(); }
});
