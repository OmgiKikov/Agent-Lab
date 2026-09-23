import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createInputSchema, type MetricAssessment, type Runtime } from '../src/contracts.js';
import { storedEvidence } from '../src/card/prepare.js';
import type { CardProposal, CardProposalRequest } from '../src/card/proposal.js';
import type { Card, CardPreparation } from '../src/card/schema.js';
import { cardStatuses } from '../src/card/status.js';
import { demoTarget } from '../src/demo.js';
import { ExperimentLab } from '../src/experiment.js';
import { importDialogues } from '../src/imports.js';
import { StructuredTaskError } from '../src/llm/structured.js';
import { situationCoverage } from '../src/miner/cards.js';
import { preparationConsent } from '../src/miner/plan.js';
import { buildTopicMap, OTHER, TOPIC_MAP_PROMPT_VERSION } from '../src/miner/topic-map.js';
import { libraryHash } from '../src/scenario-library.js';
import { BUILDER, scriptedRunner, type Logged } from './helpers/miner.js';

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
 * Every role by a fixed rule: topics from the answer key of `logged` (a topic call can fail like a provider), one rule
 * grounded, a card per conversation titled «<its topic> — <conversation>» from the one topic the harness offers, every
 * claim ready, a customer who leaves after the first reply, and a judge that fails only the titles `fails` names.
 */
function minerRuntime(logged: readonly Logged[], options: { failTopicAt?: number; reject?: (request: CardProposalRequest) => boolean; fails?: (title: string) => boolean } = {}) {
  const seen: Seen = { proposals: [], topicCalls: [] };
  const topics = scriptedRunner(logged, options.failTopicAt ? { failAt: options.failTopicAt } : {});
  const must = [{ text: 'ответить на вопрос клиента по существу', requirementIds: ['answer_rule'], appliesWhen: null, observation: 'reply' as const }];
  const runtime: Runtime = {
    topicMap: { builder: BUILDER, build: (plan, ctx, onProgress) => buildTopicMap(plan, { builder: BUILDER, ctx, onProgress,
      run: (task, input, callCtx) => { seen.topicCalls.push(task.label); return topics.run(task, input, callCtx); } }) },
    async groundRequirements(input, ctx) {
      ctx.beforeCall();
      return { requirements: [{ id: 'answer_rule', sourceId: input.sources[0]!.id, text: 'Отвечать по существу вопроса клиента.', quote: RULE, critical: true }], questions: [] };
    },
    async proposeCard(request, ctx): Promise<CardProposal> {
      ctx.beforeCall(); seen.proposals.push(structuredClone(request));
      if (options.reject?.(request)) throw new StructuredTaskError('Ситуация из диалога: ответ модели не прошёл проверку.');
      const { source } = request.call;
      if (source.kind === 'rules') return { title: `По правилам ${request.written.length + 1}`, topic: 'Вопросы клиентов', wants: 'Получить ответ',
        writes: request.written.length ? 'Подскажите, как у вас всё устроено?' : 'Подскажите, пожалуйста.', leaves: 'получил ответ', agentMust: must };
      const topic = request.topics[0] ?? 'Без темы';
      return { title: `${topic} — ${source.dialogueId}`, topic, wants: 'Получить ответ на свой вопрос', writesEvent: request.call.customerEvents[0]!, knows: [],
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
    const consent = await preparationConsent(lab.store, { batch, settings: createInput(batch).settings, situations: 15 });
    assert.deepEqual({ ...consent, excluded: consent.excluded.map(item => [item.dialogueId, item.kind]) }, {
      conversations: 92, usable: 90, promised: 15, topicMapCalls: 4, callCeiling: 150,
      excluded: [['no id', 'unreadable'], ['masked1', 'masked']],
    }, 'one proposal and three batches of 30; the unreadable row and the masked conversation reach no model');
    assert.match(consent.excluded[0]!.reason, /Некорректный id диалога/);
    assert.equal(consent.excluded[1]!.reason, 'реплика клиента целиком скрыта обезличиванием');
    const all = await preparationConsent(lab.store, { batch, settings: createInput(batch).settings, situations: 200 });
    assert.equal(all.promised, 90, 'never more situations than usable conversations');
    assert.equal((await preparationConsent(lab.store, { batch, settings: createInput(batch).settings })).promised, 15, 'fifteen when the owner names no number');
    await assert.rejects(preparationConsent(lab.store, { batch, settings: createInput(batch).settings, situations: 0 }), /от 1 до 200/);
  });
});

test('the promise is what is prepared: the representative sample of every topic, each card under its conversation\'s topic', async () => {
  const logged = TEN();
  const batch = batchOf(logged);
  const { runtime, seen } = minerRuntime(logged);
  await withLab(runtime, async (lab, directory) => {
    const consent = await preparationConsent(lab.store, { batch, settings: createInput(batch).settings, situations: 5 });
    assert.deepEqual([consent.promised, consent.topicMapCalls], [5, 2]);
    const draft = await lab.create(createInput(batch), { cards: true, situations: 5 });
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
    assert.deepEqual([progress.status, progress.requestedCount, progress.pending, progress.excluded], ['complete', 5, [], []]);
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
    const draft = await lab.create(createInput(batch), { cards: true, situations: 5 });
    await lab.waitForIdle();
    const { library, experiment } = await lab.readCards(draft.id);
    const progress = experiment.preparationProgress as CardPreparation;
    const [refunds, statuses, tariffs] = progress.sample!.map(stratum => stratum.dialogueIds) as [string[], string[], string[]];
    assert.equal(refused, refunds[0]);
    assert.deepEqual(seen.proposals.map(unitOf), [refunds[0], statuses[0], tariffs[0], refunds[1], refunds[2], refunds[3], tariffs[1]],
      'one round over the topics, then each refused pick\'s replacement');
    assert.deepEqual(library.cards.map(conversationOf), [statuses[0], refunds[1], refunds[2], refunds[3]]);
    assert.deepEqual([progress.status, progress.pending, progress.excluded.map(item => item.dialogueId)], ['complete', [], [refunds[0], tariffs[0], tariffs[1]]]);
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
    const draft = await lab.create(createInput(batch), { cards: true, situations: 3 });
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
    assert.deepEqual([progress.status, progress.pending], ['complete', []]);
  });
});
