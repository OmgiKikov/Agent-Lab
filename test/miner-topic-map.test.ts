import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fingerprint } from '../src/contracts.js';
import { ProviderFailure } from '../src/llm/model-call.js';
import { countText } from '../src/plural.js';
import { resolveModels } from '../src/llm/models.js';
import { runStructured, StructuredTaskError, TASK_ATTEMPTS } from '../src/llm/structured.js';
import {
  buildTopicMap, OTHER, planTopicMap, reusableTopicMap, TOPIC_MAP_PROMPT_VERSION, topicMapCalls, topicMapProgressSchema, topicMapSchema,
  type TopicMapBuild, type TopicMapProgress,
} from '../src/miner/topic-map.js';
import { MASKED, TOO_LONG, BUILDER, importOf, scriptedRunner, sortedByTruth, TOPICS, world, AGENT_REPLY, type Logged } from './helpers/miner.js';
import { callContext, fixture, fixtureSettings, type Request } from './helpers/pi-fixture.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const scripted = (run: TopicMapBuild['run'], extra: Partial<TopicMapBuild> = {}): TopicMapBuild => ({ builder: BUILDER, run, ctx: callContext().ctx, ...extra });
/** The last user message of a request, as JSON: the task's input, or a bounded repair `{input, repair, previousReply}`. */
const body = (request: Request): { input?: any; repair?: string; previousReply?: string } & Record<string, any> => {
  const content = request.messages.at(-1)!.content;
  return JSON.parse(typeof content === 'string' ? content : content.map(part => part.type === 'text' ? part.text : '').join(''));
};
const inputOf = (request: Request) => { const b = body(request); return b.input ?? b; };
const schemaOf = (request: Request) => JSON.parse(request.systemPrompt!.split('\n').find(line => line.startsWith('{"$schema"'))!);

test('conversations the import check refuses are excluded with their reason before any call and are never sent', async () => {
  const logged = [...world(), MASKED, TOO_LONG];
  const batch = importOf(logged);
  const plan = planTopicMap(batch, BUILDER);
  assert.deepEqual(plan.excluded, [
    { dialogueId: 'd101', kind: 'masked', reason: 'реплика клиента целиком скрыта обезличиванием' },
    { dialogueId: 'd102', kind: 'length', reason: 'нужны 1–16 реплик клиента' },
  ]);
  assert.equal(plan.dialogues, 100);
  const { run, calls } = scriptedRunner(logged);
  const map = await buildTopicMap(plan, scripted(run));
  const sent = JSON.stringify(calls.map(call => call.input));
  for (const hidden of ['d101', 'd102', '*** ***', 'Вопрос про лимиты']) assert.ok(!sent.includes(hidden), `${hidden} was sent`);
  assert.ok(!sent.includes(AGENT_REPLY), 'the old agent\'s replies are never sent: only the customers\' own words');
  assert.deepEqual(map.excluded, plan.excluded);
  assert.deepEqual([...Object.keys(map.assignments), ...map.excluded.map(exclusion => exclusion.dialogueId)].sort(), batch.dialogues.map(dialogue => dialogue.id).sort(),
    'every conversation of the import is sorted or excluded, exactly once');
});

test('the count the confirmation shows is what the build spends: one proposal and one call per batch of at most 40', async () => {
  assert.deepEqual([0, 1, 40, 41, 80, 81, 300].map(topicMapCalls), [0, 2, 2, 3, 3, 4, 9]);
  const logged = world();
  const plan = planTopicMap(importOf(logged), BUILDER);
  assert.equal(plan.calls, topicMapCalls(100));
  assert.deepEqual(plan.batches.map(batch => batch.length), [34, 33, 33], 'batches of even size, never above 40');
  assert.deepEqual(plan.batches.flat().map(conversation => conversation.dialogueId), logged.map(item => item.id), 'in import order');
  const { run, calls } = scriptedRunner(logged);
  const { ctx, usage } = callContext();
  const map = await buildTopicMap(plan, scripted(run, { ctx }));
  assert.equal(usage.calls, plan.calls);
  assert.deepEqual(calls.map(call => call.label), ['Темы разговоров', 'Темы разговоров, часть 1 из 3', 'Темы разговоров, часть 2 из 3', 'Темы разговоров, часть 3 из 3']);
  assert.deepEqual(Object.values(map.assignments).filter(ref => ref === OTHER).length, 6);

  const nothing = planTopicMap(importOf([MASKED, TOO_LONG]), BUILDER);
  assert.equal(nothing.calls, 0, 'nothing usable, nothing to pay for');
  const idle = scriptedRunner([]);
  const empty = await buildTopicMap(nothing, scripted(idle.run));
  assert.equal(idle.calls.length, 0);
  assert.deepEqual([empty.topics, empty.assignments, empty.excluded.length], [[], {}, 2]);
});

test('the proposal reads a seeded sample of customer openings within its byte cap, never an id; the harness numbers the topics', async () => {
  const verbose = Array.from({ length: 300 }, (_, n): Logged => ({ id: `c${n}`, topic: OTHER,
    customer: [`Обращение №${n}. ${'Подробно описываю, что случилось с моим платежом. '.repeat(10)}`, 'И ещё одно сообщение.'] }));
  const batch = importOf(verbose);
  const plan = planTopicMap(batch, BUILDER);
  const bytes = plan.openings.reduce((sum, opening) => sum + Buffer.byteLength(JSON.stringify(opening), 'utf8'), 0);
  assert.ok(bytes <= 48_000, `${bytes} bytes of openings`);
  assert.ok(plan.openings.length >= 140 && plan.openings.length < 300, `${plan.openings.length} openings: the cap, not the import, bounds the sample`);
  assert.ok(plan.openings.every(opening => Buffer.byteLength(opening.join(''), 'utf8') <= 300), 'each opening is at most 300 bytes');
  assert.deepEqual(planTopicMap(batch, BUILDER).openings, plan.openings, 'the same import gives the same sample');
  assert.notDeepEqual(planTopicMap(importOf(verbose.slice(1)), BUILDER).openings.slice(0, 10), plan.openings.slice(0, 10), 'the seed is the import\'s content');

  const logged = world();
  const small = importOf(logged);
  const { run, calls } = scriptedRunner(logged);
  const map = await buildTopicMap(planTopicMap(small, BUILDER), scripted(run));
  assert.ok(!JSON.stringify(calls[0]!.input).includes('"d0'), 'the proposal reads no ids');
  assert.deepEqual(map.topics.map(topic => [topic.id, topic.title]), TOPICS.map((topic, index) => [`t${index + 1}`, topic.title]));
  assert.deepEqual([map.importId, map.contentHash, map.model, map.promptVersion], [small.id, small.contentHash, 'agent-lab-test/test-model', TOPIC_MAP_PROMPT_VERSION]);
});

test('a conversation is cut to its byte budget on a character boundary, a quote counted at what it costs in the request', () => {
  const emoji = '😀'.repeat(400), quotes = '"\\'.repeat(400), cyrillic = `${'я'.repeat(499)}ж${'щ'.repeat(100)}`;
  const plan = planTopicMap(importOf([
    { id: 'emoji', customer: [emoji, 'второе сообщение'], topic: OTHER },
    { id: 'quotes', customer: [quotes], topic: OTHER },
    { id: 'cyrillic', customer: [cyrillic, 'не поместится'], topic: OTHER },
    { id: 'lines', customer: ['Первая‮ строка\n\n  вторая\tстрока', 'ещё'], topic: OTHER },
  ]), BUILDER);
  const excerptOf = (dialogueId: string) => plan.batches.flat().find(conversation => conversation.dialogueId === dialogueId)!.customer;
  const requestBytes = (turns: string[]) => turns.reduce((sum, turn) => sum + Buffer.byteLength(JSON.stringify(JSON.stringify(turn)), 'utf8') - 6, 0);
  for (const dialogueId of ['emoji', 'quotes', 'cyrillic']) {
    const turns = excerptOf(dialogueId);
    assert.ok(requestBytes(turns) <= 1_000 && requestBytes(turns) > 990, `${dialogueId}: ${requestBytes(turns)} request bytes`);
    assert.ok(turns.every(turn => Buffer.from(turn, 'utf8').toString('utf8') === turn), `${dialogueId}: no character is cut in half`);
  }
  assert.deepEqual(excerptOf('emoji'), [emoji.slice(0, 500)], '250 emoji of four bytes, and nothing after them');
  assert.equal(excerptOf('quotes')[0], quotes.slice(0, 250), 'a quote or a backslash costs four bytes');
  assert.deepEqual(excerptOf('cyrillic'), [cyrillic.slice(0, 500)]);
  assert.deepEqual(excerptOf('lines'), ['Первая строка вторая строка', 'ещё'], 'one plain line per message, without control or bidi characters');
});

test('an interrupted build continues from its last finished batch and ends with the map of a build that never stopped', async () => {
  const logged = world();
  const batch = importOf(logged);
  const whole = await buildTopicMap(planTopicMap(batch, BUILDER), scripted(scriptedRunner(logged).run));

  let stored: unknown;
  const failing = scriptedRunner(logged, { failAt: 3 });
  await assert.rejects(buildTopicMap(planTopicMap(batch, BUILDER), scripted(failing.run, { onProgress: progress => { stored = clone(progress); } })),
    error => error instanceof ProviderFailure && error.kind === 'rate limit');
  assert.equal(Object.keys(topicMapProgressSchema.parse(stored).assignments).length, 34, 'the proposal and the first batch were kept');

  const plan = planTopicMap(batch, BUILDER, stored);
  assert.equal(plan.calls, 2, 'the continuation promises only the batches left');
  const rest = scriptedRunner(logged);
  const { ctx, usage } = callContext();
  const resumed = await buildTopicMap(plan, scripted(rest.run, { ctx }));
  assert.deepEqual(rest.calls.map(call => call.label), ['Темы разговоров, часть 2 из 3', 'Темы разговоров, часть 3 из 3'], 'the proposal is not asked again');
  assert.equal(usage.calls, plan.calls);
  assert.deepEqual(resumed, whole);
  assert.equal(fingerprint(resumed), fingerprint(whole));
});

test('a continuation or a finished map is reused only for the same import, content, builder model and prompt version', async () => {
  const logged = world();
  const batch = importOf(logged);
  const snapshots: TopicMapProgress[] = [];
  const map = await buildTopicMap(planTopicMap(batch, BUILDER), scripted(scriptedRunner(logged).run, { onProgress: progress => { snapshots.push(clone(progress)); } }));
  assert.equal(snapshots.length, 4, 'the proposal and every batch reach onProgress');
  const partial = snapshots[1]!;
  const fresh = topicMapCalls(100);
  const role = { provider: 'agent-lab-test', id: 'role-model' };
  const callsFor = (stored: unknown, builder = BUILDER) => planTopicMap(batch, builder, stored).calls;
  assert.equal(callsFor(partial), 2);
  assert.equal(callsFor(partial, role), fresh, 'another builder model');
  assert.equal(callsFor({ ...partial, promptVersion: 'a'.repeat(64) }), fresh, 'an older prompt');
  assert.equal(callsFor({ ...partial, contentHash: 'b'.repeat(64) }), fresh, 'other content');
  assert.equal(callsFor({ ...partial, assignments: Object.fromEntries(Object.entries(partial.assignments).slice(1)) }), fresh, 'a torn batch');
  assert.equal(callsFor({ ...partial, assignments: { ...partial.assignments, stranger: 't1' } }), fresh, 'a conversation of another import');
  assert.equal(callsFor({ ...partial, note: 'damaged' }), fresh, 'a damaged file');

  assert.deepEqual(reusableTopicMap(clone(map), batch, BUILDER), map);
  assert.equal(reusableTopicMap(map, batch, role), undefined, 'another builder model');
  assert.equal(reusableTopicMap({ ...map, promptVersion: 'a'.repeat(64) }, batch, BUILDER), undefined, 'an older prompt');
  assert.equal(reusableTopicMap(map, importOf(logged.slice(1)), BUILDER), undefined, 'another import');
  assert.equal(reusableTopicMap({ ...map, assignments: Object.fromEntries(Object.entries(map.assignments).slice(1)) }, batch, BUILDER), undefined, 'a conversation missing');
  assert.equal(reusableTopicMap({ ...map, excluded: [{ dialogueId: 'd999', kind: 'length', reason: 'нужны 1–16 реплик клиента' }] }, batch, BUILDER), undefined,
    'exclusions this import does not have');
});

test('a stored map is strict and parses to itself: unknown, renumbered or inconsistent content is refused', async () => {
  const logged = [...world(), MASKED];
  const raw = clone(await buildTopicMap(planTopicMap(importOf(logged), BUILDER), scripted(scriptedRunner(logged).run)));
  assert.equal(fingerprint(topicMapSchema.parse(raw)), fingerprint(raw), 'nothing is added, trimmed or defaulted');
  const refused = (value: unknown, why: string) => assert.equal(topicMapSchema.safeParse(value).success, false, why);
  const firstTopic = (change: Record<string, unknown>) => ({ ...raw, topics: raw.topics.map((topic, index) => index ? topic : { ...topic, ...change }) });
  refused({ ...raw, note: 'x' }, 'an unknown field');
  refused(firstTopic({ share: 0.4 }), 'an unknown field of a topic');
  refused(firstTopic({ title: ' Возврат оплаты' }), 'an untrimmed title');
  refused(firstTopic({ title: 'Возврат\nоплаты' }), 'a title on two lines');
  refused(firstTopic({ title: 'В'.repeat(61) }), 'a title over 60 characters');
  refused({ ...raw, topics: raw.topics.map((topic, index) => ({ ...topic, id: `t${index + 2}` })) }, 'topics not numbered from t1');
  refused({ ...raw, assignments: { ...raw.assignments, d001: 't9' } }, 'an assignment to a topic the map lacks');
  refused({ ...raw, assignments: { ...raw.assignments, 'd 001': 't1' } }, 'a key that is not an id');
  refused({ ...raw, excluded: [...raw.excluded, { dialogueId: 'd001', kind: 'length', reason: 'нужны 1–16 реплик клиента' }] }, 'a conversation sorted and excluded');
  refused({ ...raw, excluded: [{ ...raw.excluded[0], kind: 'lost' }] }, 'an exclusion of an unknown kind');
  refused({ ...raw, formatVersion: 2 }, 'another format');
  const { promptVersion: _, ...unversioned } = raw;
  refused(unversioned, 'a map without its prompt version');
  const { excluded: __, ...progress } = raw;
  assert.equal(fingerprint(topicMapProgressSchema.parse(progress)), fingerprint(progress));
  assert.equal(topicMapProgressSchema.safeParse({ ...progress, topics: [], assignments: {} }).success, false, 'a continuation always holds the proposal');
});

test('an invented topic or a skipped conversation is refused by the per-call enum and check, and repaired', async () => {
  const logged = world().slice(0, 5);
  const first = logged[0]!.id;
  const truth = new Map(logged.map(item => [item.id, item.topic]));
  const replies: ((input: any) => unknown)[] = [
    () => ({ topics: TOPICS.slice(0, 3).map(({ title, description }) => ({ title, description })) }),
    input => ({ assignments: input.conversations.map((conversation: any, index: number) => ({ dialogueId: conversation.dialogueId, topicId: index ? 't1' : 't9' })) }),
    input => ({ assignments: input.conversations.slice(1).map((conversation: any) => ({ dialogueId: conversation.dialogueId, topicId: 't1' })) }),
    input => sortedByTruth(input, truth),
  ];
  const f = await fixture((request, index) => JSON.stringify(replies[index]!(inputOf(request))));
  try {
    const models = await resolveModels(f.runtime, fixtureSettings, AbortSignal.timeout(1000));
    const map = await f.adapter.topicMap!.build(planTopicMap(importOf(logged), models.builder), callContext().ctx, async () => {});
    assert.equal(f.requests.length, 4);
    const item = schemaOf(f.requests[1]!).properties.assignments.items.properties;
    assert.deepEqual(item.dialogueId.enum, logged.map(conversation => conversation.id), 'the conversations of exactly this call');
    assert.deepEqual(item.topicId.enum, ['t1', 't2', 't3', OTHER], 'the proposed topics and other');
    assert.match(body(f.requests[2]!).repair!, /Not a topic id/);
    assert.match(body(f.requests[3]!).repair!, new RegExp(`Missing: ${first}\\.`));
    assert.deepEqual(map.assignments, sortedByTruth({ topics: map.topics, conversations: logged.map(item => ({ dialogueId: item.id })) }, truth).assignments
      .reduce((all, { dialogueId, topicId }) => ({ ...all, [dialogueId]: topicId }), {}));
  } finally { await f.close(); }
});

test('a batch that never passes fails typed and names its part; what was finished is kept and continued', async () => {
  const logged = world().slice(0, 41);
  const truth = new Map(logged.map(item => [item.id, item.topic]));
  const f = await fixture((request, index) => {
    const input = inputOf(request);
    if (!input.topics) return JSON.stringify({ topics: TOPICS.map(({ title, description }) => ({ title, description })) });
    const answer = sortedByTruth(input, truth);
    // The second batch always skips its first conversation.
    return JSON.stringify(index > 1 ? { assignments: answer.assignments.slice(1) } : answer);
  });
  try {
    const models = await resolveModels(f.runtime, fixtureSettings, AbortSignal.timeout(1000));
    const batch = importOf(logged);
    const snapshots: unknown[] = [];
    await assert.rejects(f.adapter.topicMap!.build(planTopicMap(batch, models.builder), callContext().ctx, async progress => { snapshots.push(clone(progress)); }),
    error => error instanceof StructuredTaskError && error.message.startsWith(`Темы разговоров, часть 2 из 2: модель ${countText(TASK_ATTEMPTS, ['раз', 'раза', 'раз'])} подряд`));
    assert.equal(f.requests.length, 2 + TASK_ATTEMPTS);
    assert.equal(snapshots.length, 2, 'the proposal and the first batch were delivered before the failure');
    const plan = planTopicMap(batch, models.builder, snapshots.at(-1));
    assert.equal(plan.calls, 1);
    const rest = scriptedRunner(logged);
    const map = await buildTopicMap(plan, { builder: models.builder, run: rest.run, ctx: callContext().ctx });
    assert.deepEqual(rest.calls.map(call => call.label), ['Темы разговоров, часть 2 из 2']);
    assert.equal(Object.keys(map.assignments).length, 41);
  } finally { await f.close(); }
});

test('the largest request of either step fits its byte cap, a repair carrying the rejected draft included', async () => {
  const id = (n: number) => `${'x'.repeat(76)}${String(n).padStart(4, '0')}`;
  // Quotes and backslashes cost four bytes each inside the request: the caps must hold for them too.
  const essay = (n: number) => `${'Мне ответили "ждите", а я жду уже \\ неделю, и "ничего". '.repeat(9)}№${n}`;
  const logged = Array.from({ length: 280 }, (_, n): Logged => ({ id: id(n), customer: [essay(n), essay(n + 1000)], topic: OTHER }));
  const topics = Array.from({ length: 15 }, (_, index) => ({
    title: `Тема ${index + 1} ${'ж'.repeat(60)}`.slice(0, 60),
    description: `${'Клиент подробно описывает ситуацию и просит помочь с ней. '.repeat(5)}`.slice(0, 235) + ` №${index + 1}`,
  }));
  const f = await fixture(request => {
    const { input, repair } = { input: inputOf(request), repair: body(request).repair };
    if (!input.topics) return JSON.stringify({ topics: repair ? topics : [...topics.slice(0, 14), topics[0]] });
    const assignments = input.conversations.map((conversation: any) => ({ dialogueId: conversation.dialogueId, topicId: OTHER }));
    return JSON.stringify({ assignments: repair ? assignments : [...assignments, assignments[0]] });
  });
  try {
    const models = await resolveModels(f.runtime, fixtureSettings, AbortSignal.timeout(1000));
    const plan = planTopicMap(importOf(logged), models.builder);
    assert.deepEqual(plan.batches.map(batch => batch.length), Array(7).fill(40));
    const map = await buildTopicMap(plan, { builder: models.builder, run: (task, input, ctx) => runStructured(f.runtime, models, task, input, ctx), ctx: callContext().ctx });
    assert.equal(Object.keys(map.assignments).length, 280);
    assert.equal(f.requests.length, 2 + 7 * 2, 'every step was rejected once and repaired');
    assert.ok(f.requests.filter((_, index) => index % 2 === 1).every(request => body(request).previousReply), 'each repair carries the rejected draft');
    const size = (request: Request) => Buffer.byteLength(JSON.stringify({ systemPrompt: request.systemPrompt, messages: request.messages }), 'utf8');
    const proposal = Math.max(...f.requests.slice(0, 2).map(size)), classification = Math.max(...f.requests.slice(2).map(size));
    assert.ok(proposal > 55_000 && proposal <= 120_000, `proposal ${proposal} bytes`);
    assert.ok(classification > 60_000 && classification <= 120_000, `classification ${classification} bytes`);
  } finally { await f.close(); }
});
