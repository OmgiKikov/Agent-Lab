import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createInputSchema, experimentSchema, fingerprint, settingsSchema } from '../src/contracts.js';
import type { MetricAssessment } from '../src/assessment.js';
import type { Runtime } from '../src/runtime.js';
import { storedEvidence } from '../src/card/prepare.js';
import type { CardProposal, CardProposalRequest } from '../src/card/proposal.js';
import { addCard } from '../src/card/library.js';
import { cardSchema, libraryV2Schema, type Card, type CardPreparation } from '../src/card/schema.js';
import { cardStatuses } from '../src/card/status.js';
import { createDemoRuntime, demoInput, demoTarget } from '../src/demo.js';
import { STOP_LABEL } from '../src/errors.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { importDialogues } from '../src/imports.js';
import { StructuredTaskError } from '../src/llm/structured.js';
import { cardTrafficTopic, situationCoverage } from '../src/miner/cards.js';
import { coverageLine, uncoveredLine } from '../src/miner/coverage.js';
import { builderOf, preparationConsent } from '../src/miner/plan.js';
import { buildTopicMap, OTHER, planTopicMap, TOPIC_MAP_PROMPT_VERSION } from '../src/miner/topic-map.js';
import { createPiRuntime } from '../src/pi.js';
import { markdownReport } from '../src/report.js';
import { realityParts, topicRows } from '../src/result-text.js';
import { buildResultView } from '../src/result-view.js';
import { libraryHash } from '../src/scenario-library.js';
import { cardInput, cardRuntime } from './helpers/card-prep.js';
import { libraryV1File } from './helpers/library-v1.js';
import { BUILDER, scriptedRunner, type Logged } from './helpers/miner.js';
import { callContext, fixture, fixtureSettings } from './helpers/pi-fixture.js';

/*
 * The Scenario Miner inside a preparation (M2): the consent, the topic map built through the runtime and kept next to
 * its import, the representative sample as the preparation's units with replacements inside a topic, the topics on
 * cards, and a card run's result read from the record alone. A deterministic runtime answers every role; no model.
 */

const RULE = 'Отвечайте клиенту по существу его вопроса.';
const SAYS: Record<string, string> = {
  'Возврат оплаты': 'Хочу вернуть деньги за покупку', 'Статус заявки': 'Какой статус моей заявки?', 'Смена тарифа': 'Как сменить тариф?', [OTHER]: 'Где ближайшее отделение?',
};
const PREFIX: Record<string, string> = { 'Возврат оплаты': 'r', 'Статус заявки': 's', 'Смена тарифа': 'p', [OTHER]: 'o' };

/** A support log, one customer message per conversation, grouped by true topic: `r1…` refunds, `s1…` statuses, `p1…` tariffs, `o1…` none of them. */
function logs(sizes: [topic: string, count: number][]): Logged[] {
  return sizes.flatMap(([topic, count]) => Array.from({ length: count }, (_, index): Logged =>
    ({ id: `${PREFIX[topic]}${index + 1}`, customer: [`${SAYS[topic]} Обращение ${PREFIX[topic]}${index + 1}.`], topic })));
}
/** The import of `logged`, each customer message answered once; `extra` rows go in as they are (an unreadable one is rejected by the import). */
const batchOf = (logged: readonly Logged[], extra: unknown[] = []) => importDialogues([
  ...logged.map(item => ({ id: item.id, messages: item.customer.flatMap(content => [{ role: 'user', content }, { role: 'assistant', content: 'Сейчас помогу.' }]) })),
  ...extra,
]).originalImport;
/** One customer message hidden by de-identification: the import keeps the conversation, the usability check refuses it. */
const MASKED_ROW = { id: 'masked1', messages: [{ role: 'user', content: 'Здравствуйте!' }, { role: 'assistant', content: 'Слушаю вас.' }, { role: 'user', content: '*** ***' }] };
const UNREADABLE_ROW = { id: 'no id', messages: [{ role: 'user', content: 'Здравствуйте' }] };

const settings = (extra: Record<string, unknown> = {}) => ({ provider: BUILDER.provider, model: BUILDER.id, repeats: 1, maxTurns: 3, maxCalls: 150, userModes: ['reactive'], ...extra });
const createInput = (batch: ReturnType<typeof batchOf>, extra: Record<string, unknown> = {}) => createInputSchema.parse({
  task: 'Проверить поддержку', mode: 'live', target: demoTarget(), scenarioCount: 0, materials: [{ name: 'Правила поддержки', content: RULE }],
  originalImport: batch, settings: settings(extra) });

interface Seen { proposals: CardProposalRequest[]; topicCalls: string[] }
/**
 * Every role by a fixed rule: topics from the answer key of `logged` (a topic call can fail like a provider), the one rule
 * cited, a card per conversation titled «<its topic> — <conversation>» from the one topic the harness offers, every
 * claim ready, a customer who leaves after the first reply, and a judge that fails only the titles `fails` names.
 */
function minerRuntime(logged: readonly Logged[], options: { failTopicAt?: number; reject?: (request: CardProposalRequest) => boolean; fails?: (title: string) => boolean } = {}) {
  const seen: Seen = { proposals: [], topicCalls: [] };
  const topics = scriptedRunner(logged, options.failTopicAt ? { failAt: options.failTopicAt } : {});
  const runtime: Runtime = {
    topicMap: { builder: BUILDER, build: (plan, ctx, onProgress) => buildTopicMap(plan, { builder: BUILDER, ctx, onProgress,
      run: (task, input, callCtx) => { seen.topicCalls.push(task.label); return topics.run(task, input, callCtx); } }) },
    async proposeCard(request, ctx): Promise<CardProposal> {
      ctx.beforeCall(); seen.proposals.push(structuredClone(request));
      if (options.reject?.(request)) throw new StructuredTaskError('Ситуация из диалога: ответ модели не прошёл проверку.');
      const { source } = request.call;
      // The one duty cites the one rule, the whole support policy.
      const must = [{ text: 'ответить на вопрос клиента по существу', basis: [{ sourceId: request.call.sources[0].id, quote: RULE, rule: 'Отвечать по существу вопроса клиента.', kind: 'behavior' as const }],
        appliesWhen: null, observation: 'reply' as const }];
      if (source.kind === 'rules') return { title: `По правилам ${request.written.length + 1}`, topic: 'Вопросы клиентов', wants: 'Получить ответ',
        writes: request.written.length ? 'Подскажите, как у вас всё устроено?' : 'Подскажите, пожалуйста.', leaves: 'получил ответ', agentMust: must };
      const topic = request.topics[0] ?? 'Без темы';
      return { title: `${topic} — ${source.dialogueId}`, topic, wants: 'Получить ответ на свой вопрос', clarity: 'clear', writesEvent: request.call.customerEvents[0]!, knows: [], plausibleKnows: [],
        leaves: 'получил ответ или понял, что агент не поможет', turn: null, agentMust: must, coverage: {} };
    },
    async reviewCard(request, ctx) {
      ctx.beforeCall();
      return { verdicts: Object.fromEntries(request.aliases.map(alias => [alias, { status: 'ready' as const, reason: 'Подтверждено разговором и правилом.' }])), model: 'fixture/reviewer' };
    },
    async selectUserAction() { return { actionId: 'leave' }; },
    async assess({ scenario, trial }) {
      const pass = !options.fails?.(scenario.title);
      const reply = trial.events.filter(event => event.type === 'assistant').at(-1)!;
      return (scenario.metrics ?? []).map((metric): MetricAssessment => ({ metricId: metric.id, result: pass ? 'pass' : 'fail', evidence: [reply.seq], rationale: pass ? 'Выполнено.' : 'Не выполнено.' }));
    },
  };
  return { runtime, seen };
}

/** Refunds, statuses and tariffs in the proportion 5 : 3 : 2; the helper's proposal numbers them t1, t2, t3. */
const TEN = () => logs([['Возврат оплаты', 5], ['Статус заявки', 3], ['Смена тарифа', 2]]);
const TOPIC_BY_PREFIX: Record<string, string> = { r: 't1', s: 't2', p: 't3', o: OTHER };
const TITLE: Record<string, string> = { t1: 'Возврат оплаты', t2: 'Статус заявки', t3: 'Смена тарифа', [OTHER]: 'Другое' };
const conversationOf = (card: Card): string => card.origin.kind === 'dialogue' ? card.origin.dialogueId : '';
const unitOf = (request: CardProposalRequest): string => request.call.source.kind === 'dialogue' ? request.call.source.dialogueId : request.call.source.unit;

async function withLab(runtime: Runtime, work: (lab: ExperimentLab, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-miner-'));
  const lab = new ExperimentLab(directory, runtime);
  try { await lab.init(); await work(lab, directory); } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
}

test('the consent names the topic map\'s calls, the ceiling, the promise and every conversation left out, with its reason', async () => {
  const logged = logs([['Возврат оплаты', 50], ['Статус заявки', 30], ['Смена тарифа', 10]]);
  const batch = batchOf(logged, [MASKED_ROW, UNREADABLE_ROW]);
  await withLab(minerRuntime(logged).runtime, async lab => {
    const consent = await preparationConsent(lab.store, { input: createInput(batch), situations: 15 });
    assert.deepEqual({ ...consent, excluded: consent.excluded.map(item => [item.dialogueId, item.kind]) }, {
      conversations: 92, usable: 90, promised: 15, topicMapCalls: 4, prompts: { count: 0, bytes: 0 }, callCeiling: 154, asksAgent: true,
      excluded: [['no id', 'unreadable'], ['masked1', 'masked']],
    }, 'one proposal and three batches of 30; the unreadable row and the masked conversation reach no model');
    assert.equal(consent.callCeiling, 4 + 15 * (6 + 2 * 2), 'the ceiling is the preparation\'s own: the map, and per situation its proposal allowance with its one revision and the reviews of the card and of that revision — not the draft\'s limit of 150');
    assert.match(consent.excluded[0]!.reason, /Некорректный id диалога/);
    assert.equal(consent.excluded[1]!.reason, 'реплика клиента целиком скрыта обезличиванием');
    const all = await preparationConsent(lab.store, { input: createInput(batch), situations: 200 });
    assert.equal(all.promised, 90, 'never more situations than usable conversations');
    assert.equal((await preparationConsent(lab.store, { input: createInput(batch) })).promised, 15, 'fifteen when the owner names no number');
    await assert.rejects(preparationConsent(lab.store, { input: createInput(batch), situations: 0 }), /от 1 до 200/);
  });
});

test('a preparation stops at the ceiling its consent stated, not at the draft\'s limit, which stays the run\'s budget', async () => {
  const logged = TEN();
  const batch = batchOf(logged);
  const { runtime } = minerRuntime(logged);
  // The model never gets a proposal right: every attempt is charged, none is accepted, and each conversation gives its seat to the next.
  runtime.proposeCard = async (_request, ctx) => { for (;;) ctx.beforeCall(); };
  await withLab(runtime, async lab => {
    const consent = await preparationConsent(lab.store, { input: createInput(batch), situations: 2 });
    assert.equal(consent.callCeiling, 2 + 2 * (6 + 2 * 2));
    const draft = await lab.create(createInput(batch), { situations: 2 });
    await lab.waitForIdle();
    const stopped = await lab.get(draft.id);
    assert.deepEqual([stopped.stop, stopped.error], ['budget', STOP_LABEL.budget]);
    assert.deepEqual([stopped.usage.calls, stopped.settings.maxCalls], [consent.callCeiling, 150], 'the promise and the stop are one number');
  });
});

test('the promise is what is prepared: the representative sample of every topic, each card under its conversation\'s topic', async () => {
  const logged = TEN();
  const batch = batchOf(logged);
  const { runtime, seen } = minerRuntime(logged);
  await withLab(runtime, async (lab, directory) => {
    const consent = await preparationConsent(lab.store, { input: createInput(batch), situations: 5 });
    assert.deepEqual([consent.promised, consent.topicMapCalls], [5, 2]);
    const draft = await lab.create(createInput(batch), { situations: 5 });
    await lab.waitForIdle();
    const { library, experiment } = await lab.readCards(draft.id);
    assert.equal(experiment.phase, 'review', experiment.error ?? '');
    assert.equal(library.cards.length, consent.promised, 'as many situations as the consent promised');
    const seats = library.cards.reduce<Record<string, number>>((all, card) => ({ ...all, [card.trafficTopic!.id]: (all[card.trafficTopic!.id] ?? 0) + 1 }), {});
    assert.deepEqual(seats, { t1: 3, t2: 1, t3: 1 }, 'seats by share, at least one per topic');
    for (const card of library.cards) {
      const topic = TOPIC_BY_PREFIX[conversationOf(card)[0]!]!;
      assert.deepEqual([card.trafficTopic, card.topic], [{ batchId: batch.id, id: topic }, TITLE[topic]], `${card.title}: the topic of its conversation, in the map's words`);
    }
    assert.deepEqual(seen.proposals.map(request => request.topics), library.cards.map(card => [card.topic]), 'the model is offered its conversation\'s topic alone');
    assert.deepEqual(library.traffic, [{ importId: batch.id, contentHash: batch.contentHash, model: 'agent-lab-test/test-model', promptVersion: TOPIC_MAP_PROMPT_VERSION,
      topics: [{ id: 't1', title: 'Возврат оплаты', dialogues: 5 }, { id: 't2', title: 'Статус заявки', dialogues: 3 }, { id: 't3', title: 'Смена тарифа', dialogues: 2 }],
      labeled: 10, logged: 10 }]);
    const progress = experiment.preparationProgress as CardPreparation;
    assert.deepEqual([progress.requestedCount, progress.pending, progress.excluded], [5, [], []]);
    assert.deepEqual(progress.sample!.map(stratum => [stratum.topicId, stratum.dialogueIds.length]), [['t1', 5], ['t2', 3], ['t3', 2]]);

    const files = await readdir(join(directory, 'imports'));
    const maps = files.filter(name => name.startsWith(`${batch.id}.topics-`));
    assert.deepEqual([files.length, maps.length], [2, 1], 'the map lives next to its import');
    assert.equal((await stat(join(directory, 'imports', maps[0]!))).mode & 0o777, 0o600);
    const journal = await lab.store.generatorEvidence(draft.id);
    assert.deepEqual(journal.filter(event => event.method === 'topicMap').map(event => event.kind), ['request', 'result'], 'the map\'s build is journaled like every builder call');

    const statuses = cardStatuses({ library, evidence: await storedEvidence(lab.store, library), maxTurns: experiment.settings.maxTurns });
    assert.deepEqual(situationCoverage(library, statuses), { line: '5 ситуаций покрывают 3 из 3 тем — 100% диалогов', uncovered: undefined });
    const refundsReady = new Map([...statuses].map(([id, status]) => [id, library.cards.find(card => card.id === id)!.trafficTopic!.id === 't1' ? status : { ...status, status: 'needs_owner' as const }]));
    assert.deepEqual(situationCoverage(library, refundsReady), { line: '3 ситуации покрывают 1 из 3 тем — 50% диалогов',
      uncovered: 'Не покрыты: Статус заявки (30% диалогов), Смена тарифа (20%)' }, 'only ready cards cover a topic');
  });
});

test('a pick that makes no situation gives its seat to the next conversation of its topic in the same run; a topic that runs out keeps its seat empty', async () => {
  const logged = TEN();
  const batch = batchOf(logged);
  let refused: string | undefined;
  const { runtime, seen } = minerRuntime(logged, { reject: request => {
    if (request.topics[0] === 'Смена тарифа') return true;
    if (request.topics[0] !== 'Возврат оплаты' || refused) return false;
    refused = unitOf(request);
    return true;
  } });
  await withLab(runtime, async lab => {
    const draft = await lab.create(createInput(batch), { situations: 5 });
    await lab.waitForIdle();
    const { library, experiment } = await lab.readCards(draft.id);
    const progress = experiment.preparationProgress as CardPreparation;
    const [refunds, statuses, tariffs] = progress.sample!.map(stratum => stratum.dialogueIds) as [string[], string[], string[]];
    assert.equal(refused, refunds[0]);
    assert.deepEqual(seen.proposals.map(unitOf), [refunds[0], statuses[0], tariffs[0], refunds[1], refunds[2], refunds[3], tariffs[1]],
      'one round over the topics, then each refused pick\'s replacement');
    assert.deepEqual(library.cards.map(conversationOf), [statuses[0], refunds[1], refunds[2], refunds[3]]);
    assert.deepEqual([progress.pending, progress.excluded.map(item => item.dialogueId)], [[], [refunds[0], tariffs[0], tariffs[1]]]);
    assert.match(progress.excluded[0]!.reason, /не прошёл проверку/);
    assert.ok(library.cards.length < progress.requestedCount!, 'never more than promised: both tariffs failed, and no other topic takes their seat');
  });
});

test('a pick whose paid call died in flight is never asked again: after the resume its seat goes to the next conversation of its topic', async () => {
  const logged = TEN();
  const batch = batchOf(logged);
  const { runtime, seen } = minerRuntime(logged);
  const propose = runtime.proposeCard!;
  let died: string | undefined;
  runtime.proposeCard = async (request, ctx) => {
    if (died) return propose(request, ctx);
    ctx.beforeCall(); died = unitOf(request);
    throw new Error('Provider disconnected after accepting the request');
  };
  await withLab(runtime, async lab => {
    const draft = await lab.create(createInput(batch), { situations: 3 });
    await lab.waitForIdle();
    assert.match((await lab.get(draft.id)).error ?? '', /Provider disconnected/);
    await lab.resumePreparation(draft.id, libraryHash((await lab.readCards(draft.id)).library));
    await lab.waitForIdle();
    const { library, experiment } = await lab.readCards(draft.id);
    const progress = experiment.preparationProgress as CardPreparation;
    const refunds = progress.sample![0]!.dialogueIds;
    assert.equal(died, refunds[0]);
    assert.match(progress.excluded.find(item => item.dialogueId === died)?.reason ?? '', /стоимость неизвестна/);
    assert.ok(!seen.proposals.some(request => unitOf(request) === died), 'the dead call is not repeated');
    assert.deepEqual(library.cards.map(card => [conversationOf(card), card.trafficTopic!.id]).sort(),
      [[refunds[1], 't1'], [progress.sample![1]!.dialogueIds[0], 't2'], [progress.sample![2]!.dialogueIds[0], 't3']].sort());
    assert.deepEqual(progress.pending, []);
  });
});

test('the topic map is paid for once: a build cut short continues from its last stored step, a finished map is reused', async () => {
  const logged = logs([['Возврат оплаты', 50], ['Статус заявки', 30], ['Смена тарифа', 10]]);
  const batch = batchOf(logged);
  const broken = minerRuntime(logged, { failTopicAt: 3 });
  const working = minerRuntime(logged);
  const { runtime } = broken;
  await withLab(runtime, async lab => {
    const mapCalls = async (extra: Record<string, unknown> = {}) =>
      (await preparationConsent(lab.store, { input: createInput(batch, extra), situations: 3 })).topicMapCalls;
    assert.equal(await mapCalls(), 4);
    const failed = await lab.create(createInput(batch), { situations: 3 });
    await lab.waitForIdle();
    const stopped = await lab.get(failed.id);
    assert.deepEqual([stopped.phase, stopped.librarySnapshot], ['error', undefined]);
    assert.match(stopped.error ?? '', /rate limit/);
    assert.deepEqual(broken.seen.topicCalls, ['Темы разговоров', 'Темы разговоров, часть 1 из 3', 'Темы разговоров, часть 2 из 3']);
    assert.equal(await mapCalls(), 2, 'the proposal and the first batch are stored: two calls are left');

    runtime.topicMap = working.runtime.topicMap;
    const first = await lab.create(createInput(batch), { situations: 3 });
    await lab.waitForIdle();
    assert.deepEqual(working.seen.topicCalls, ['Темы разговоров, часть 2 из 3', 'Темы разговоров, часть 3 из 3'], 'the build goes on where it stopped');
    assert.equal(await mapCalls(), 0, 'a finished map of these logs costs nothing');
    assert.equal(await mapCalls({ roles: { builder: { provider: 'agent-lab-test', model: 'role-model' } } }), 4, 'another builder model maps the logs anew');

    const again = await lab.create(createInput(batch), { situations: 3 });
    await lab.waitForIdle();
    assert.equal(working.seen.topicCalls.length, 2, 'the stored map is reused without a call');
    const [one, two] = await Promise.all([first.id, again.id].map(id => lab.readCards(id)));
    assert.deepEqual(two!.library.cards.map(conversationOf), one!.library.cards.map(conversationOf), 'the same map gives the same sample');
    assert.deepEqual(two!.library.traffic, one!.library.traffic);
    assert.equal(one!.experiment.usage.calls - two!.experiment.usage.calls, 2, 'the reused map spends none of the budget');
  });
});

test('topics on cards: a dialogue card takes its conversation\'s, a similar card its parent\'s, a card from the owner\'s rules none', async () => {
  const logged = TEN();
  const batch = batchOf(logged);
  await withLab(minerRuntime(logged).runtime, async lab => {
    const rules = await lab.create(createInputSchema.parse({ task: 'Проверить поддержку', mode: 'live', target: demoTarget(), scenarioCount: 2,
      materials: [{ name: 'Правила поддержки', content: RULE }], settings: settings() }));
    await lab.waitForIdle();
    const written = await lab.readCards(rules.id);
    assert.deepEqual(written.library.cards.map(card => [card.origin.kind, card.topic, card.trafficTopic]), [['rules', 'Вопросы клиентов', undefined], ['rules', 'Вопросы клиентов', undefined]]);
    assert.deepEqual([written.library.traffic, (written.experiment.preparationProgress as CardPreparation).sample], [undefined, undefined]);
    assert.equal(situationCoverage(written.library, new Map(written.library.cards.map(card => [card.id, { status: 'ready' as const }]))), undefined, 'no logs, no coverage line');

    const sampled = await lab.create(createInput(batch), { situations: 2 });
    await lab.waitForIdle();
    const { library } = await lab.readCards(sampled.id);
    const parent = library.cards[0]!;
    const { trafficTopic: _topic, ...unmarked } = parent;
    const similar = cardSchema.parse({ ...unmarked, id: 'card_similar', number: library.nextNumber, origin: { kind: 'similar', parentId: parent.id, change: { kind: 'turn', turn: null } } });
    const drafted = addCard(library, similar);
    assert.deepEqual(cardTrafficTopic(drafted, similar), parent.trafficTopic, 'a similar card stands for its parent\'s topic');
    const copied = cardSchema.parse({ ...similar, trafficTopic: parent.trafficTopic });
    assert.deepEqual(cardTrafficTopic(addCard(library, copied), copied), parent.trafficTopic, 'and so does one that copied it');
    const orphaned = libraryV2Schema.parse({ ...drafted, cards: drafted.cards.filter(card => card.id !== parent.id) });
    assert.equal(cardTrafficTopic(orphaned, similar), undefined, 'a similar card whose parent was removed claims no topic');
    const naming = (trafficTopic: unknown) => libraryV2Schema.safeParse({ ...library, cards: library.cards.map(card => card.id === parent.id ? { ...card, trafficTopic } : card) }).success;
    assert.deepEqual([naming({ batchId: batch.id, id: 't4' }), naming({ batchId: 'import_other', id: 't1' }), naming(parent.trafficTopic)], [false, false, true],
      'a card names only a topic its library has the traffic of');
  });
});

test('a card run reads its topics from the record alone: rows by traffic share, the weighted estimate, the coverage in the report', async () => {
  const logged = logs([['Возврат оплаты', 5], ['Статус заявки', 3], ['Смена тарифа', 2], [OTHER, 1]]);
  const batch = batchOf(logged, [MASKED_ROW]);
  const { runtime } = minerRuntime(logged, { fails: title => title.startsWith('Статус заявки') });
  await withLab(runtime, async (lab, directory) => {
    // Three seats for four topics: the three largest get one each, «Другое» none.
    const draft = await lab.create(createInput(batch), { situations: 3 });
    await lab.waitForIdle();
    const { library } = await lab.readCards(draft.id);
    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    await lab.start(draft.id, { approved: true, expectedHash: draftHash(accepted.experiment), requireAccepted: true });
    await lab.waitForIdle();
    assert.equal((await lab.get(draft.id)).phase, 'results_review');
    // Nothing but the record: the logs and their map leave the store.
    await rm(join(directory, 'imports'), { recursive: true });
    const finished = await lab.get(draft.id);
    const view = buildResultView(finished);
    assert.deepEqual([view.headline.passed, view.headline.decided], [2, 3]);
    assert.deepEqual(view.topics!.rows.map(row => [row.title, row.passed, row.decided, row.share]),
      [['Возврат оплаты', 1, 1, 5 / 11], ['Статус заявки', 0, 1, 3 / 11], ['Смена тарифа', 1, 1, 2 / 11]], 'shares of the whole import, largest first');
    // (5/11 · 1 + 3/11 · 0 + 2/11 · 1) / (10/11) = 0.7: the uncovered «Другое» weighs nothing.
    assert.ok(Math.abs(view.topics!.weighted! - 0.7) < 1e-9, String(view.topics!.weighted));
    assert.deepEqual([view.topics!.uncovered, view.topics!.labeled, view.topics!.logged], [{ topics: 1, share: 1 / 11 }, 11, 12]);
    // The estimate names the share of the conversations its measured topics hold; the masked conversation has no topic.
    assert.deepEqual(realityParts(view), ['С учётом частоты тем — около 70% (измерены темы 91% диалогов; темы известны у 11 из 12 разговоров)']);
    assert.deepEqual([coverageLine(view.topicCoverage!), uncoveredLine(view.topicCoverage!)], ['3 ситуации покрывают 3 из 4 тем — 91% диалогов', 'Не покрыта: Другое (9% диалогов)']);
    assert.deepEqual(topicRows(view).map(row => [row.text, row.right?.trim().split(/\s{3,}/)]), [
      ['По темам', ['справился', 'доля диалогов']], ['Возврат оплаты', ['1 из 1', '45%']], ['Статус заявки', ['0 из 1', '27%']], ['Смена тарифа', ['1 из 1', '18%']],
      ['Не покрыто ситуациями', ['—', '9%']]]);

    const report = markdownReport(finished);
    const method = report.slice(report.indexOf('## Как считали'));
    assert.ok(method.includes('- 3 ситуации покрывают 3 из 4 тем — 91% диалогов. Не покрыта: Другое \\(9% диалогов\\).'), method);
    const table = report.slice(report.indexOf('## По темам'), report.indexOf('## Почему ошибается'));
    for (const row of ['| Возврат оплаты | 1 из 1 | 45% |', '| Статус заявки | 0 из 1 | 27% |', '| Смена тарифа | 1 из 1 | 18% |', '| Не покрыто ситуациями | — | 9% |']) assert.ok(table.includes(row), table);

    const repeat = await lab.repeat(draft.id);
    assert.deepEqual(buildResultView(repeat).topicCoverage, view.topicCoverage, 'a repeat stands for the same topics, with no map at hand');
  });
});

test('records without the logs\' topics read as before; the new stored fields parse to themselves', async () => {
  const legacy = experimentSchema.parse(await libraryV1File('run.json'));
  assert.equal(buildResultView(legacy).topicCoverage, null);
  assert.ok(!markdownReport(legacy).includes('покрыва'), 'a first-format run has no coverage sentence');
  // The card-preparation runtime of the earlier tests maps no topics: the first usable conversations, in import order, and no topic claimed.
  await withLab(cardRuntime(), async lab => {
    const draft = await lab.create(cardInput());
    await lab.waitForIdle();
    const { library, experiment } = await lab.readCards(draft.id);
    const progress = experiment.preparationProgress as CardPreparation;
    assert.deepEqual([progress.processed, progress.requestedCount, progress.sample], [['late', 'known'], 15, [{ dialogueIds: ['late', 'known'] }]]);
    assert.deepEqual([library.traffic, library.cards.map(card => card.trafficTopic)], [undefined, [undefined, undefined]]);
    assert.equal(situationCoverage(library, new Map(library.cards.map(card => [card.id, { status: 'ready' as const }]))), undefined);
  });
  await withLab(minerRuntime(TEN()).runtime, async (lab, directory) => {
    const draft = await lab.create(createInput(batchOf(TEN())), { situations: 2 });
    await lab.waitForIdle();
    const raw = JSON.parse(await readFile(join(directory, `${draft.id}.json`), 'utf8'));
    assert.ok(raw.librarySnapshot.traffic && raw.librarySnapshot.cards[0].trafficTopic && raw.preparationProgress.sample);
    assert.equal(fingerprint(experimentSchema.parse(raw)), fingerprint(raw), 'nothing is added, trimmed or defaulted');
  });
});

test('the demo runtime answers with a fixed topic map and spends nothing', async () => {
  const demo = createDemoRuntime();
  const mapper = demo.topicMap!;
  const batch = importDialogues(demoInput().dialogues).originalImport;
  const { ctx, usage } = callContext();
  const map = await mapper.build(planTopicMap(batch, mapper.builder), ctx, async () => {});
  assert.deepEqual([map.topics.map(topic => topic.title), map.assignments, map.model, usage.calls], [['Возврат оплаты'], { known: 't1', late: 't1' }, 'agent-lab/demo', 0]);
  assert.deepEqual(await mapper.build(planTopicMap(batch, mapper.builder), ctx, async () => {}), map, 'the same map every time');
  await assert.rejects(mapper.build(planTopicMap(batchOf(TEN()), mapper.builder), ctx, async () => {}), /Учебный пример поддерживает только/);
});

test('the Pi runtime maps topics with the builder model the consent plans with', async () => {
  const f = await fixture(() => '{}', true);
  try {
    assert.deepEqual(f.adapter.topicMap!.builder, builderOf(fixtureSettings));
    const roles = settingsSchema.parse({ ...fixtureSettings, roles: { builder: { provider: 'agent-lab-test', model: 'role-model' } } });
    const adapter = await createPiRuntime(roles, f.runtime);
    assert.deepEqual([adapter.topicMap!.builder, builderOf(roles)], [{ provider: 'agent-lab-test', id: 'role-model' }, { provider: 'agent-lab-test', id: 'role-model' }]);
  } finally { await f.close(); }
});
