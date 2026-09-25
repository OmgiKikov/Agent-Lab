import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { test } from 'node:test';
import { createPiRuntime, getPiStatus } from '../src/pi.js';
import { TASK_ATTEMPTS } from '../src/llm/structured.js';
import { CARD_ROLE } from '../src/prompts.js';
import { judgeInput, JUDGE_RESPONSE_FORMAT, observableSources } from '../src/judge.js';
import { createGigaProvider, GIGA_PROVIDER_ID } from '../src/giga-provider.js';
import { DEFAULT_JUDGE, emptyUsage, settingsSchema, targetSchema, type Scenario, type Trial } from '../src/contracts.js';
import { promptCompliance } from '../src/assessment.js';
import { loggedMessages } from '../src/card/checks.js';
import { proposalCall, type CallSource, type CardProposalRequest, type DialogueProposal } from '../src/card/proposal.js';
import { importBatch } from '../src/scenario-library.js';
import { callContext, fixture, fixtureSettings as settings } from './helpers/pi-fixture.js';
import { dialogues, policy, proposals } from './helpers/card-prep.js';

const lateBatch = importBatch(dialogues);
/** One proposal request over the invented refund dialogue «late», reading `sources`. */
function proposalRequest(sources: CallSource[] = [{ id: 'source-1', name: 'Правила', content: policy }]): CardProposalRequest {
  return { task: 'Возвраты', topics: [], written: [],
    call: proposalCall({ source: { kind: 'dialogue', batchId: lateBatch.id, dialogueId: 'late' }, messages: loggedMessages(lateBatch.dialogues[0]!), sources, maxTurns: 6 }) };
}
/** The careful proposal of «late» with every duty resting on `basis`, or each duty on its own basis. */
const citingLate = (...basis: DialogueProposal['agentMust'][number]['basis']): DialogueProposal => ({ ...structuredClone(proposals.late),
  agentMust: proposals.late.agentMust.map(duty => ({ ...duty, basis })) });

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
    ...reviewFields, id: `card_${index}`, familyId: 'support', title: `Support question ${index}`, requirementIds: ['req_1'], provenance: 'synthetic', tier: 'regression',
    user: { goal: 'Learn how to contact support', facts: 'I need help', persona: 'Customer seeking support', characteristics: ['Concise'], behavior: 'Ask once', opening: 'How do I contact support?', maxFollowUps: 0 },
    initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [],
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

test('a model call reads no discovered resources and the simulator receives only explicit user data', async () => {
  const f = await fixture(() => JSON.stringify({ message: 'Please use the later time.', done: false }));
  const cwd = process.cwd();
  try {
    await mkdir(join(f.directory, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(f.directory, 'AGENTS.md'), 'PRIVATE_CONTEXT_SENTINEL');
    await writeFile(join(f.directory, '.pi', 'extensions', 'leak.ts'), "process.env.AGENT_LAB_EXTENSION_LOADED='yes'; export default function() {};");
    process.chdir(f.directory);
    const { ctx, usage } = callContext();
    const output = await f.adapter.userTurn!({
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
    assert.ok(f.requests.every(r => !r.tools?.length), 'a model call offers no tools');
    assert.equal(process.env.AGENT_LAB_EXTENSION_LOADED, undefined);
    // Providers the host's environment enables (a cloud key, an AWS profile) are the host's, not discovered from the project:
    // a clean runtime in the same process shows them too, and only what the fixture registered may come on top.
    const status = await getPiStatus(f.runtime);
    const host = await ModelRuntime.create({ authPath: join(f.directory, 'host-auth.json'), modelsPath: null,
      modelsStorePath: join(f.directory, 'host-models.json'), allowModelNetwork: false, refreshOnCreate: false });
    const hosted = new Set((await host.getAvailable()).map(model => `${model.provider}/${model.id}`));
    assert.deepEqual(status.models.filter(model => !hosted.has(`${model.provider}/${model.id}`)), [{ provider: 'agent-lab-test', id: 'test-model', name: 'Offline SDK fixture' }]);
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
    assert.deepEqual(await f.adapter.userTurn!(input, callContext().ctx), replies[0]);
    assert.deepEqual(await f.adapter.userTurn!(input, callContext().ctx), { done: true, message: '' });
    assert.match(f.requests[0]?.systemPrompt ?? '', /done:true with a nonempty message means deliver this final user message, receive the target response, then end/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /done:true with an empty message means stop now without another target response/);
  } finally { await f.close(); }
});

test('the call budget stops a repair before another provider request, and malformed structured output remains invalid', async () => {
  const f = await fixture(() => 'This is not JSON');
  try {
    const { ctx, usage } = callContext({ limit: 1 });
    await assert.rejects(f.adapter.selectSources!({ task: 'Check rules', catalog: [{ id: 'source_1', name: 'rules.md', chars: 15 }], dialogue: { id: 'd', messages: [] }, limit: 3 }, ctx), /Call budget exhausted/);
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
    await assert.rejects(fenced.adapter.userTurn!(input, callContext().ctx), /не проходит проверку.*not a single JSON object/s);
  } finally { await fenced.close(); }

  const prose = await fixture(() => 'Here you go: {"message":"hi","done":false}');
  try {
    await assert.rejects(prose.adapter.userTurn!({ user: { goal: 'A', facts: 'A', behavior: 'A', opening: 'A' }, messages: [], turn: 0 }, callContext().ctx), /не проходит проверку.*not a single JSON object/s);
  } finally { await prose.close(); }
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
      const pending = f.adapter.userTurn!({ user: { goal: 'A', facts: 'A', behavior: 'A', opening: 'A' }, messages: [], turn: 0 }, ctx);
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
    assert.ok(!f.requests[0]?.tools?.length);
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

test('кластер провалов ссылается только на переданные провалы: неизвестный id отклоняет схема, а имя кластера — слова модели', async () => {
  const failures = [
    { trialId: 't1', card: 'Тариф', reason: 'Часть проверок провалена.', failed: ['Клиент получил ответ'], trace: 'Агент: оператору необходимо осуществить ручной поиск' },
    { trialId: 't2', card: 'Возврат', reason: 'Часть проверок провалена.', failed: ['Клиент получил ответ'], trace: 'Агент: обратитесь на горячую линию' },
  ];
  const invented = { modes: [{ id: 'hotline', name: 'Отправил на горячую линию вместо ответа', description: 'd', trialIds: ['t1', 't9'] }] };
  const good = { modes: [{ id: 'hotline', name: 'Отправил на горячую линию вместо ответа', description: 'Нашёл статью и всё равно перевёл клиента.', stage: 'сборка ответа', trialIds: ['t1', 't2'] }] };
  const replies = [invented, good];
  let step = -1;
  const f = await fixture(() => { step += 1; return JSON.stringify(replies[step]); });
  try {
    const modes = await f.adapter.failureModes!({ task: 'Проверить агента', failures }, callContext().ctx);
    assert.deepEqual(modes, good.modes);
    assert.equal(f.requests.length, 2, 'выдуманный диалог отклонён, исправление принято');
    assert.deepEqual(JSON.parse(f.requests[0]!.systemPrompt!.split('\n').find(line => line.startsWith('{"$schema"'))!).properties.modes.items.properties.trialIds.items.enum, ['t1', 't2'],
      'the answer schema lists exactly the supplied failures');
    assert.match(JSON.stringify(f.requests[1]!.messages), /not in the supplied failures/i);
  } finally { await f.close(); }
  // Whether a name says what went wrong is the model's judgement under its role, not a pattern over its words.
  const plain = { modes: [{ id: 'bad', name: 'Bad answer', description: 'd', trialIds: ['t1', 't2'] }] };
  const g = await fixture(() => JSON.stringify(plain));
  try {
    assert.deepEqual(await g.adapter.failureModes!({ task: 'Проверить агента', failures }, callContext().ctx), plain.modes);
    assert.equal(g.requests.length, 1);
  } finally { await g.close(); }
});

test('a quote that is not verbatim is repaired from the stated reason instead of losing the situation', async () => {
  const quote = 'Если номер терминала уже указан, не запрашивайте его повторно';
  const cite = (text: string) => ({ sourceId: 'source-1', quote: text, rule: 'Номер не спрашивается повторно.', kind: 'behavior' as const });
  // First the model paraphrases the source, which is the most common real rejection.
  const outputs = [citingLate(cite('Если номер терминала уже назван, его не запрашивают снова')), citingLate(cite(quote))];
  const f = await fixture((_request, index) => JSON.stringify(outputs[index]));
  try {
    const answer = await f.adapter.proposeCard!(proposalRequest(), callContext().ctx);
    assert.deepEqual(answer, outputs[1]);
    assert.equal(f.requests.length, 2, 'one rejected answer, one repair');
    // A proposal carries a whole dialogue, so its repair starts afresh: the evidence, the reason and the latest draft.
    const { repair } = JSON.parse(String(f.requests[1]!.messages[0]!.content)) as { repair: string };
    assert.match(repair, /agentMust\[0\]\.basis\[0\]: the quote is not a verbatim substring of "Правила"/, 'the model is told exactly what to fix');
    assert.match(repair, /agentMust\[1\]\.basis\[0\]/, 'every quote that misses is named, so one repair fixes them all');
    assert.match(repair, /shorter contiguous fragment/);
  } finally { await f.close(); }
});

test('a source marked as the agent prompt reaches the builder and the judge labelled', async () => {
  const prompt = 'Отвечай только по эквайрингу. Всегда заканчивай ответ вопросом «Чем ещё помочь?». Никогда не называй внутренние системы.';
  const f = await fixture(() => JSON.stringify(citingLate({ sourceId: 'prompt_1', quote: 'Всегда заканчивай ответ вопросом «Чем ещё помочь?»', rule: 'Ответ заканчивается вопросом «Чем ещё помочь?».', kind: 'behavior' })));
  try {
    const promptSource = { id: 'prompt_1', name: 'system.md', content: prompt, hash: 'hash', kind: 'prompt' as const };
    await f.adapter.proposeCard!(proposalRequest([promptSource, { id: 'kb_1', name: 'Статья', content: 'Тариф виден в СберБизнес.' }]), callContext().ctx);
    assert.match(f.requests[0]?.systemPrompt ?? '', /the agent's own prompts \(named «промпт агента»\)/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /A prompt says what the agent was told, not what it does/);
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
    await adapter.userTurn!({ user: scenario.user, messages: [{ role: 'user', content: 'Help' }, { role: 'assistant', content: 'Here is help' }], turn: 0 }, callContext().ctx);
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

test('a judge on the internal gateway gets the strict response schema on its own wire, translated into model_options', async () => {
  const f = await fixture(() => { throw new Error('The planner provider must not assess'); });
  const bodies: any[] = [];
  // The real giga provider over a transport stand-in: the catalog, then one chat answer per vote.
  const provider = await createGigaProvider({}, async (path, body) => {
    if (path === '/v1/models') return { status: 200, text: JSON.stringify({ data: [{ id: 'giga-judge', type: 'chat' }] }) };
    bodies.push(body);
    const answer = JSON.stringify({ assessments: [{ metricId: 'goal', passCondition: 'met', failCondition: 'not_met', rationale: 'The instruction is present.', evidence: [1], citations: [{ seq: 1, quote: 'Instruction' }] }] });
    return { status: 200, text: JSON.stringify({ finish_reason: 'stop', messages: [{ role: 'assistant', content: [{ text: answer }] }], usage: { input_tokens: 10, output_tokens: 5 } }) };
  });
  assert.ok(provider);
  f.runtime.registerProvider(GIGA_PROVIDER_ID, provider);
  try {
    const adapter = await createPiRuntime({ ...settings, judge: { provider: GIGA_PROVIDER_ID, model: 'giga-judge' } }, f.runtime);
    const scenario = { ...plainCard(0), split: 'dev' as const, metrics: [reviewFields.metrics[0]!] };
    const trial: Trial = { id: 'trial', revisionId: 'revision', scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0, split: 'dev', userMode: 'static',
      manifestHash: 'hash', outcome: 'ungraded', reason: '', checks: [], events: [{ seq: 0, type: 'user', text: 'Help' }, { seq: 1, type: 'assistant', text: 'Instruction' }],
      initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1 };
    const { ctx } = callContext();
    assert.equal((await adapter.assess!({ scenario, trial, sources: [] }, ctx))[0]!.result, 'pass');
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.equal(body.response_format, undefined);
      assert.deepEqual(body.model_options.response_format, { type: 'json_schema', schema: JUDGE_RESPONSE_FORMAT.json_schema.schema, strict: true });
    }
  } finally { await f.close(); }
});

test('the simulator receives knows, answers and cannotKnow but never the external world', async () => {
  const f = await fixture(() => JSON.stringify({ message: 'It ends with 4321.', done: false }));
  try {
    const { ctx } = callContext();
    const reply = await f.adapter.userTurn!({ user: { goal: 'Block the lost card', facts: 'Card ends with 4321', behavior: 'Answer once', opening: 'Block my card', maxFollowUps: 1,
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

test('raw line breaks are rejected and a new valid provider reply preserves the exact source text', async () => {
  const quote = 'Rule one.\nRule two.';
  const sources = [{ id: 'source_1', name: 'prompt.md', content: quote, kind: 'prompt' as const }];
  const valid = JSON.stringify(citingLate({ sourceId: 'source_1', quote, rule: 'Two rules', kind: 'behavior' }));
  const rawNewline = valid.replace('Rule one.\\nRule two.', 'Rule one.\nRule two.');
  assert.notEqual(rawNewline, valid);
  const f = await fixture((_request, index) => index === 0 ? rawNewline : valid);
  try {
    const answer = await f.adapter.proposeCard!(proposalRequest(sources), callContext().ctx) as DialogueProposal;
    assert.equal(f.requests.length, 2);
    assert.match(JSON.stringify(f.requests[1]?.messages), /not a single JSON object/);
    assert.equal(answer.agentMust[0]!.basis[0]!.quote, quote);
  } finally { await f.close(); }
  const g = await fixture((_request, index) => index === 0 ? 'Here is the card: {"title": [}' : valid);
  try {
    const answer = await g.adapter.proposeCard!(proposalRequest(sources), callContext({ limit: 2 }).ctx) as DialogueProposal;
    assert.equal(answer.agentMust[0]!.basis[0]!.quote, quote);
    const repair = JSON.stringify(g.requests[1]?.messages);
    assert.match(repair, /not a single JSON object/);
    assert.match(repair, /Unexpected|position|token/i);
  } finally { await g.close(); }
});

test('unescaped quotes require a new valid provider reply and are never rewritten locally', async () => {
  const quote = 'Удали данные из "СберДруг", "ДРУГ", "ЦКР" и не упоминай "историю вопросов".';
  const valid = JSON.stringify(citingLate({ sourceId: 'source_1', quote, rule: 'Не называть "СберДруг" и "ДРУГ" в ответе.', kind: 'behavior' }));
  const broken = valid.replaceAll('\\"', '"');
  const f = await fixture((_request, index) => index === 0 ? broken : valid);
  try {
    const answer = await f.adapter.proposeCard!(proposalRequest([{ id: 'source_1', name: 'prompt.md', content: quote, kind: 'prompt' }]), callContext().ctx) as DialogueProposal;
    assert.equal(f.requests.length, 2);
    assert.match(JSON.stringify(f.requests[1]?.messages), /not a single JSON object/);
    assert.equal(answer.agentMust[0]!.basis[0]!.quote, quote);
    assert.equal(answer.agentMust[0]!.basis[0]!.rule, 'Не называть "СберДруг" и "ДРУГ" в ответе.');
    assert.match(f.requests[0]?.systemPrompt ?? '', /inside strings/i);
  } finally { await f.close(); }
});

test('a proposal may cite only what a user can see; a stored rule typed unobservable never reaches the judge', async () => {
  assert.match(CARD_ROLE, /never a machine output format of a prompt \(return JSON, a named field, an envelope\)/);
  assert.match(CARD_ROLE, /Cite only kinds listed in rulebook\.binds/);
  const prompt = 'Отвечай на «вы». ВСЕГДА возвращай валидный JSON в формате {"output": "*Финальный ответ*"}. Никогда не направляй в поддержку.';
  // Requirements a preparation grounded before the proposal cited the materials: one of them typed as the prompt's machine format.
  const req = (id: string, quote: string, observable: boolean) => ({ id, text: id, sourceId: 'prompt_1', quote, critical: true, observable, kind: 'behavior' as const });
  const stored = [req('formal', 'Отвечай на «вы»', true), req('json', 'ВСЕГДА возвращай валидный JSON в формате {"output": "*Финальный ответ*"}', false), req('no_support', 'Никогда не направляй в поддержку', true)];
  const [judged] = observableSources([{ id: 'prompt_1', name: 'prompt.md', content: prompt, hash: 'h', kind: 'prompt' }], stored);
  assert.match(judged!.content, /Отвечай на «вы»/);
  assert.match(judged!.content, /Никогда не направляй в поддержку/);
  assert.doesNotMatch(judged!.content, /JSON/);
});

test('the controlled user answers with one allowed action id and the expectation judge reads what the customer never sees', async () => {
  const { createUserState, allowedUserActions } = await import('../src/user-controller.js');
  const { storedRunV1 } = await import('./helpers/library-v1.js');
  // A stored first-format card, judged now through its projection: its one required checkpoint is one expectation.
  const scenario = structuredClone(storedRunV1().scenarios.find(item => item.id === 'known_number')!);
  const view = scenario.execution!.evaluatorView;
  if (!('checkpoints' in view)) throw new Error('a first-format card');
  view.checkpoints = [{ ...view.checkpoints[0]!, rule: `${view.checkpoints[0]!.rule} EVALUATOR_ONLY_MARKER` }];
  const vote = { assessments: [{ metricId: 'ask_once', passCondition: 'met', failCondition: 'not_met', rationale: 'Уточнение соответствует правилу', evidence: [1], citations: [{ seq: 1, quote: 'Назовите терминал' }] }] };
  const f = await fixture((_request, index) => JSON.stringify(index === 0 ? { actionId: 'finish' } : vote), true);
  try {
    const adapter = await createPiRuntime(settingsSchema.parse({ ...settings, roles: { simulator: { provider: settings.provider, model: 'role-model' } }, judge: { provider: settings.provider, model: 'test-model' } }), f.runtime);
    const state = createUserState(scenario.execution!.userView.policy, scenario.execution!.userView.facts);
    const actions = allowedUserActions(state, 'Назовите терминал');
    const { ctx, usage } = callContext();
    assert.deepEqual(await adapter.selectUserAction!({ user: scenario.execution!.userView, state: state.position, actions, messages: [{ role: 'assistant', content: 'Назовите терминал' }], turn: 0 }, ctx), { actionId: 'finish' });
    assert.match(f.requests[0]!.systemPrompt!, new RegExp(`"actionId":\\{"type":"string","enum":\\[${actions.map(action => `"${action.id}"`).join(',')}\\]\\}`), 'the answer is one of the allowed ids');
    assert.doesNotMatch(f.requests[0]!.systemPrompt!, /factIds/, 'fact references come from the chosen action');
    const trial: Trial = { id: 't', scenarioId: scenario.id, familyId: scenario.familyId, revisionId: 'r', userMode: 'reactive', repeat: 0, split: 'dev', manifestHash: 'h', outcome: 'ungraded', reason: '', checks: [], initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1, events: [{ seq: 0, type: 'user', text: 'Возврат' }, { seq: 1, type: 'assistant', text: 'Назовите терминал' }] };
    const judged = await adapter.assess!({ scenario, sources: [], trial }, ctx);
    assert.deepEqual(judged.map(item => [item.metricId, item.result]), [['ask_once', 'pass']], 'the required checkpoint is judged as one expectation');
    assert.deepEqual(f.modelsUsed, ['role-model', 'test-model', 'test-model']);
    assert.equal(usage.calls, 3, 'one controller move and two votes on the one expectation');
    assert.doesNotMatch(JSON.stringify(f.requests[0]), /EVALUATOR_ONLY_MARKER|checkpoints|requirementId|environmentView|backend/);
    assert.match(JSON.stringify(f.requests[1]), /EVALUATOR_ONLY_MARKER/);
    assert.ok(f.requests.every(r => !r.tools?.length));
  } finally { await f.close(); }
});

test('a stored first-format card through Pi transport and the evaluator: a move outside the policy is refused by the answer schema, the disclosure is exact and the refusal is judged', async () => {
  const { evaluateTrial } = await import('../src/evaluation.js');
  const { headlineTrialResult } = await import('../src/outcomes.js');
  const { storedRunV1 } = await import('./helpers/library-v1.js');
  const { USER_CONTROLLER_ROLE, ASSESS_ROLE } = await import('../src/prompts.js');
  const { sources, requirements } = storedRunV1();
  for (const verdict of ['pass', 'fail'] as const) {
    // The stored card with a first-format customer program: the number named on request, then the customer leaves.
    const s = structuredClone(storedRunV1().scenarios.find(item => item.id === 'known_number')!);
    const user = s.execution!.userView;
    s.user.opening = 'Помогите с возвратом'; user.opening = 'Помогите с возвратом';
    user.facts = [{ id: 'terminal_number', statement: 'Номер терминала: 1234', value: '1234' }];
    user.policy = { version: 1, initialState: 'ask', states: ['ask', 'answered', 'done'], terminalStates: ['done'], maxFollowUps: 1, repetitionLimit: 1,
      actions: [{ id: 'number', kind: 'answer', factIds: ['terminal_number'], payload: 'Номер терминала: 1234', ifAsked: 'номер терминала' }, { id: 'finish', kind: 'finish', factIds: [] }],
      transitions: [{ from: 'ask', to: 'answered', actionId: 'number', when: 'Уточнение номера' }, { from: 'answered', to: 'done', actionId: 'finish', when: 'Получен отказ или инструкция' }] };
    const view = s.execution!.evaluatorView;
    if (!('checkpoints' in view)) throw new Error('a first-format card');
    view.checkpoints = [{ ...view.checkpoints[0]!, rule: `${view.checkpoints[0]!.rule} EVALUATOR_ONLY_MARKER` }];
    let selectorCalls = 0;
    const refusal = verdict === 'pass' ? 'Без дополнительных данных возврат невозможен' : 'Возврат запрещён всем';
    const agent = await httpAgent((_message, index) => index === 0 ? 'Назовите номер терминала' : refusal);
    const f = await fixture(request => {
      const prompt = request.systemPrompt ?? '';
      // The first answer names a move the policy does not allow: the schema refuses it and the model is asked again.
      if (prompt.startsWith(USER_CONTROLLER_ROLE)) return JSON.stringify({ actionId: ++selectorCalls === 1 ? 'leave' : selectorCalls === 2 ? 'number' : 'finish' });
      if (prompt.startsWith(ASSESS_ROLE)) return JSON.stringify({ assessments: [{ metricId: 'ask_once', passCondition: verdict === 'pass' ? 'met' : 'not_met', failCondition: verdict === 'pass' ? 'not_met' : 'met',
        rationale: verdict === 'pass' ? 'Корректно объяснён отказ' : 'Отказ противоречит правилу', evidence: [4], citations: [{ seq: 4, quote: refusal }] }] });
      throw new Error('The agent under test is external: no other model role is expected here.');
    });
    try {
      const { ctx, usage } = callContext();
      const trial = await evaluateTrial({ runtime: f.adapter, scenario: s, revision: { id: 'base', parentId: null, spec: { name: 'Агент', instructions: 'Помогать клиенту', tools: [] }, hypothesis: '', createdAt: '' }, repeat: 0, manifestHash: 'h', sources, requirements, settings: settingsSchema.parse({ ...settings, maxTurns: 2 }), ctx, userMode: 'reactive', target: agent.target });
      assert.deepEqual(trial.events.filter(e => e.type === 'user').map(e => e.text), ['Помогите с возвратом', 'Номер терминала: 1234']);
      assert.equal(trial.events.filter(e => e.type === 'assistant').length, 2);
      assert.deepEqual(trial.events.filter(e => e.type === 'simulator').map(e => (e.result as { decision: unknown }).decision), [{ actionId: 'number' }, { actionId: 'finish' }]);
      assert.equal(trial.checkpoints, undefined, 'no checkpoint verdict is written any more');
      assert.equal(headlineTrialResult(s, trial), verdict);
      assert.deepEqual(agent.sent, ['Помогите с возвратом', 'Номер терминала: 1234']);
      assert.equal(usage.calls, 5, 'three controller answers (one refused by the schema) and two votes; the external agent costs no model call');
      assert.equal(trial.usage.calls, 5);
      assert.ok(trial.judgeReceipt?.complete);
      for (const request of f.requests.filter(r => !(r.systemPrompt ?? '').startsWith(ASSESS_ROLE))) assert.doesNotMatch(JSON.stringify(request), /EVALUATOR_ONLY_MARKER/);
      assert.doesNotMatch(JSON.stringify(agent.bodies), /EVALUATOR_ONLY_MARKER/);
    } finally { await f.close(); await agent.close(); }
  }
});

test('a first-format checkpoint with an exact check is graded directly, never judged; a diagnostic checkpoint decides nothing', async () => {
  const { assessTrial, grade } = await import('../src/evaluation.js');
  const { headlineTrialResult } = await import('../src/outcomes.js');
  const { storedRunV1 } = await import('./helpers/library-v1.js');
  const scenario = structuredClone(storedRunV1().scenarios.find(item => item.id === 'known_number')!);
  const view = scenario.execution!.evaluatorView;
  if (!('checkpoints' in view)) throw new Error('a first-format card');
  delete scenario.metrics;
  const required = { ...view.checkpoints[0]!, check: { id: 'literal', kind: 'answer_contains', description: 'Уточнение', value: 'Назовите номер терминала' } };
  scenario.checks = [required.check as never];
  view.checkpoints = [required, { ...required, id: 'diagnostic', role: 'diagnostic', check: undefined }];
  for (const [reply, verdict] of [['Назовите номер терминала', 'pass'], ['Возврат оформлен', 'fail']] as const) {
    const trial: Trial = { id: 't', scenarioId: scenario.id, familyId: scenario.familyId, revisionId: 'r', userMode: 'reactive', repeat: 0, split: 'dev', manifestHash: 'h', outcome: 'ungraded', reason: '', checks: [], initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1, events: [{ seq: 0, type: 'user', text: 'Возврат' }, { seq: 1, type: 'assistant', text: reply }] };
    trial.checks = grade(scenario, trial);
    trial.outcome = trial.checks.every(check => check.passed) ? 'pass' : 'fail';
    const f = await fixture(() => { throw new Error('No judge call: nothing is left to judge.'); });
    try {
      const { ctx, usage } = callContext();
      assert.deepEqual(await assessTrial(f.adapter, scenario, [], trial, ctx, []), []);
      assert.equal(usage.calls, 0);
      assert.deepEqual(trial.checks.map(check => check.id), ['literal'], 'the exact check of the checkpoint is a direct check');
      assert.equal(headlineTrialResult(scenario, trial), verdict);
    } finally { await f.close(); }
  }
});

test('a missing JSON closer is a failed attempt; only the next complete response supplies fields', async () => {
  const valid = JSON.stringify(proposals.late);
  const raw = valid.slice(0, -1);
  assert.throws(() => JSON.parse(raw));
  const f = await fixture((_request, index) => index === 0 ? raw : valid);
  try {
    const seen: unknown[] = [], { ctx, usage } = callContext();
    ctx.onGeneratorOutput = response => seen.push(response);
    const answer = await f.adapter.proposeCard!(proposalRequest(), ctx);
    assert.deepEqual(answer, proposals.late);
    assert.equal(usage.calls, 2);
    assert.deepEqual(seen, [{ role: 'card-proposal', text: raw, attempt: 1 }, { role: 'card-proposal', text: valid, attempt: 2 }]);
  } finally { await f.close(); }
});

test('structural recovery never supplies a truncated string or a missing schema field, and rejections stay observable', async () => {
  for (const raw of ['{"message":"unfinished', '{"done":false}']) {
    const f = await fixture(() => raw);
    try {
      const { ctx } = callContext(), rejections: unknown[] = [], outputs: unknown[] = [];
      ctx.onGeneratorValidation = value => rejections.push(value);
      ctx.onGeneratorOutput = value => outputs.push(value);
      await assert.rejects(f.adapter.userTurn!({ user: { goal: 'A', facts: 'A', behavior: 'A', opening: 'A' }, messages: [], turn: 0 }, ctx), /не проходит проверку/);
      assert.equal(outputs.length, TASK_ATTEMPTS);
      assert.equal(rejections.length, TASK_ATTEMPTS);
      assert.ok(rejections.every((r: any) => r.accepted === false && r.reason));
    } finally { await f.close(); }
  }
});

test('the card reviewer runs on the configured judge, named by its role or by the judge setting, never on the builder', async () => {
  const verdict = { status: 'ready', reason: 'Подтверждено разговором.' };
  const f = await fixture(() => JSON.stringify({ claims: { goal: verdict } }), true);
  try {
    const payload = { card: {}, dialogue: null, requirements: [], articles: [], claims: [{ alias: 'goal', kind: 'goal', subject: '' }] };
    for (const overrides of [{ roles: { judge: { provider: settings.provider, model: 'role-model' } } }, { judge: { provider: settings.provider, model: 'role-model' } }]) {
      const adapter = await createPiRuntime(settingsSchema.parse({ ...settings, ...overrides }), f.runtime);
      assert.deepEqual((await adapter.reviewCard!({ aliases: ['goal'], payload: payload as never }, callContext().ctx)).verdicts, { goal: verdict });
    }
    assert.deepEqual(f.modelsUsed, ['role-model', 'role-model']);
  } finally { await f.close(); }
});

test('the reviewer\'s doubt about the account names a later message of the card, an enum of this call', async () => {
  const verdict = { status: 'needs_owner', reason: 'После «Спасибо!» клиент ждал ответа о сроке.', message: 4 };
  const f = await fixture((_request, index) => JSON.stringify({ claims: { coverage: index === 0 ? { ...verdict, message: 3 } : verdict } }));
  try {
    const payload = { card: { coverage: [{ message: 2, as: 'fact', reason: null }, { message: 4, as: 'stop', reason: null }] }, dialogue: null, requirements: [], articles: [],
      claims: [{ alias: 'coverage', kind: 'coverage', subject: '' }] };
    assert.deepEqual((await f.adapter.reviewCard!({ aliases: ['coverage'], payload: payload as never }, callContext().ctx)).verdicts, { coverage: verdict });
    assert.match(f.requests[0]!.systemPrompt!, /"message":\{"default":null,"anyOf":\[\{"type":"number","enum":\[2,4\]\},\{"type":"null"\}\]\}/);
    assert.equal(f.requests.length, 2, 'a message the card does not account for is refused and asked again');
  } finally { await f.close(); }
});

test('bounded schema retries retain the evidence and latest rejected draft without accumulating prior drafts', async () => {
  // The card reviewer is bounded: its request carries a whole dialogue, so a repair starts afresh from the evidence.
  const verdict = { status: 'ready', reason: 'Подтверждено разговором.' };
  const f = await fixture((_request, index) => index < 3 ? JSON.stringify({ wrong: `rejected-draft-${index}` }) : JSON.stringify({ claims: { goal: verdict } }));
  try {
    const payload = { card: { title: 'Исходные материалы остаются' }, dialogue: null, requirements: [], articles: [], claims: [{ alias: 'goal', kind: 'goal', subject: '' }] };
    assert.deepEqual((await f.adapter.reviewCard!({ aliases: ['goal'], payload: payload as never }, callContext().ctx)).verdicts, { goal: verdict });
    assert.equal(f.requests.length, 4);
    const last = JSON.stringify(f.requests[3]!.messages);
    assert.match(last, /Исходные материалы остаются/);
    assert.match(last, /rejected-draft-2/);
    assert.doesNotMatch(last, /rejected-draft-0|rejected-draft-1/);
  } finally { await f.close(); }
});

test('a card proposal that does not bind goes back with its exact reason, and the repaired answer is taken', async () => {
  // The first answer names the terminal number with a digit the customer never wrote.
  const broken = { ...proposals.late, knows: [{ ...proposals.late.knows[0]!, value: '5679' }] };
  const f = await fixture((_request, index) => JSON.stringify(index === 0 ? broken : proposals.late));
  try {
    const { ctx, usage } = callContext();
    const answer = await f.adapter.proposeCard!(proposalRequest(), ctx);
    assert.deepEqual(answer, proposals.late);
    assert.equal(usage.calls, 2, 'one proposal and one repair');
    const system = f.requests[0]!.systemPrompt!;
    assert.ok(system.startsWith(CARD_ROLE));
    assert.match(system, /"writesEvent":\{"type":"number","enum":\[0,2,4\]\}/, 'a message is referred to by an index of this call');
    assert.match(system, /"sourceId":\{"type":"string","enum":\["source-1"\]\}/, 'a basis cites a source of this call');
    assert.match(system, /"kind":\{"type":"string","enum":\["behavior","knowledge","operator_procedure"\]\}/, 'and names the kind of its rule');
    assert.doesNotMatch(system, /"id":|"number":|"requirementIds"/, 'ids, numbers and the rules\' ids belong to the harness');
    const repair = JSON.parse(String(f.requests[1]!.messages[0]!.content)) as { repair: string; previousReply: string };
    assert.match(repair.repair, /knows\[0\] "Номер терминала": the value "5679" is not in customer message 2 as whole words\./);
    assert.match(repair.previousReply, /"5679"/, 'the repair starts afresh from the evidence and the latest draft only');
    assert.match(JSON.stringify(f.requests[0]!.messages), /Помогите с возвратом\./, 'the model reads the dialogue');
  } finally { await f.close(); }
});

test('the card reviewer answers exactly the listed claims, under the judge\'s model, and a missing answer is asked for again', async () => {
  const { CARD_REVIEW_ROLE } = await import('../src/prompts.js');
  const verdict = { status: 'ready', reason: 'Подтверждено разговором.' };
  const f = await fixture((_request, index) => JSON.stringify({ claims: index === 0 ? { goal: verdict } : { goal: verdict, fact_f1: { status: 'needs_owner', reason: 'Неясно, знал ли клиент номер заранее.' } } }), true);
  try {
    const adapter = await createPiRuntime(settingsSchema.parse({ ...settings, judge: { provider: settings.provider, model: 'role-model' } }), f.runtime);
    const { ctx, usage } = callContext();
    const payload = { card: {}, dialogue: null, requirements: [], articles: [], claims: [{ alias: 'goal', kind: 'goal', subject: '' }, { alias: 'fact_f1', kind: 'fact', subject: 'f1' }] };
    const review = await adapter.reviewCard!({ aliases: ['goal', 'fact_f1'], payload: payload as never }, ctx);
    assert.deepEqual(review, { verdicts: { goal: verdict, fact_f1: { status: 'needs_owner', reason: 'Неясно, знал ли клиент номер заранее.' } }, model: 'agent-lab-test/role-model' });
    assert.equal(usage.calls, 2);
    assert.deepEqual(f.modelsUsed, ['role-model', 'role-model'], 'the reviewer is the judge, not the author');
    assert.ok(f.requests[0]!.systemPrompt!.startsWith(CARD_REVIEW_ROLE));
    assert.match(JSON.stringify(f.requests[1]!.messages), /claims\.fact_f1/, 'the repair names the missing claim');
  } finally { await f.close(); }
});
