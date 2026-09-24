import { isRunnable, materialSources, type CreateInput, type Settings, type ValidationExclusion } from '../contracts.js';
import type { CallContext, Runtime } from '../runtime.js';
import { preparationCeiling, promptGroundingCalls } from '../card/budget.js';
import type { CardPreparation, LibraryV2 } from '../card/schema.js';
import type { ImportBatch } from '../scenario-contracts.js';
import type { ExperimentStore } from '../store.js';
import { countText } from '../plural.js';
import { clip } from '../text.js';
import { trafficSummary } from './coverage.js';
import { representativeSample } from './sample.js';
import { sampleSchema, type CardTopic, type SampleStrata, type Traffic } from './schema.js';
import { planTopicMap, reusableTopicMap, topicMapKey, usableConversations, type BuilderModel, type TopicMap } from './topic-map.js';

/*
 * The Scenario Miner inside a preparation (E1). Before anything is spent the owner reads one consent value; then
 * the import's topic map is reused or built, and the representative sample of the requested count becomes the
 * preparation's units:
 *
 *   consent: map calls · the preparation's ceiling · situations promised · conversations left out, each with its reason
 *   map:     stored under the same key ─► reused, no call · build in progress ─► continued · each step stored first
 *   units:   the sample's picks; a pick that makes no situation ─► the next untried conversation of its topic
 *
 * A preparation therefore never makes more situations than the consent promised.
 */

/** Situations prepared from logs when the owner names no number. */
export const DEFAULT_SITUATIONS = 15;
/** The most situations one preparation makes. */
export const SITUATION_LIMIT = 200;

/** The number of situations asked for: DEFAULT_SITUATIONS when none is named. */
export function situationCount(requested: number | undefined): number {
  const count = requested ?? DEFAULT_SITUATIONS;
  if (!Number.isInteger(count) || count < 1 || count > SITUATION_LIMIT) throw new Error(`Число ситуаций — целое от 1 до ${SITUATION_LIMIT}.`);
  return count;
}

/** The model that builds a live preparation's topic map: the builder role's, or the run's — the one the Pi runtime resolves. */
export function builderOf(settings: Pick<Settings, 'provider' | 'model' | 'roles'>): BuilderModel {
  const choice = settings.roles?.builder ?? { provider: settings.provider, model: settings.model };
  return { provider: choice.provider, id: choice.model };
}

/** A logged conversation no situation is made from: a row the import could not read, or one the usability check refuses. */
export interface LeftOut { dialogueId: string; kind: 'unreadable' | ValidationExclusion['kind']; reason: string }

/** The conversations of an import left out before anything is spent, in import order: the unreadable rows, then the unusable conversations. */
function leftOut(batch: ImportBatch, unusable: readonly ValidationExclusion[]): LeftOut[] {
  return [
    ...batch.rejected.map((row): LeftOut => ({ dialogueId: clip(row.id ?? `row_${row.index}`, 200), kind: 'unreadable', reason: clip(row.reasons.join('; '), 2000) })),
    ...unusable.map(({ dialogueId, kind, reason }): LeftOut => ({ dialogueId, kind, reason })),
  ];
}

/**
 * What the owner agrees to before logs become situations: one value every surface renders as it is. Spending has
 * two numbers: the calls of the topic map when every answer passes — none when a stored map of these logs is
 * reused — and the ceiling the whole preparation stops at, the map included (card/budget.ts). The draft's own call
 * limit stays the run's budget.
 */
export interface PreparationConsent {
  /** Logged conversations in the import, every row counted, and those a situation can be made from. */
  conversations: number;
  usable: number;
  /** Situations promised: the preparation never makes more. */
  promised: number;
  topicMapCalls: number;
  /** Calls that read the agent's prompts once for every conversation (card/budget.ts); none when the materials fit one call. */
  promptCalls: number;
  callCeiling: number;
  /** Conversations no situation is made from, with the reason; none of them reaches a model. */
  excluded: LeftOut[];
  /** The draft has a connected agent: Lab sends it one message to learn whether its tool calls can be judged (connection.ts). */
  asksAgent: boolean;
}

/**
 * The consent of preparing `situations` situations from the logs of `input` (its import) under its settings and
 * rules, reading what the store already holds of the logs' topic map.
 */
export async function preparationConsent(store: Pick<ExperimentStore, 'readTopicMap'>, request: { input: CreateInput; situations?: number }): Promise<PreparationConsent> {
  const { input } = request;
  const batch = input.originalImport;
  if (!batch) throw new Error('Согласие на подготовку из логов нужно только тогда, когда логи есть.');
  const builder = builderOf(input.settings);
  const stored = await store.readTopicMap(topicMapKey(batch, builder));
  const { dialogueIds, excluded } = usableConversations(batch);
  const promised = Math.min(situationCount(request.situations), dialogueIds.length);
  const topicMapCalls = reusableTopicMap(stored, batch, builder) ? 0 : planTopicMap(batch, builder, stored).calls;
  const sources = materialSources(input.materials);
  return {
    conversations: batch.dialogues.length + batch.rejected.length, usable: dialogueIds.length, promised, topicMapCalls,
    promptCalls: promptGroundingCalls(input.task, sources),
    callCeiling: preparationCeiling({ task: input.task, sources, situations: promised, fromLogs: true, topicMapCalls }),
    excluded: leftOut(batch, excluded), asksAgent: isRunnable(input.target),
  };
}

const CONVERSATIONS: [string, string, string] = ['разговор', 'разговора', 'разговоров'];
/** The count after «не больше»: «не больше 21 вызова», «не больше 115 вызовов». */
const CALLS: [string, string, string] = ['вызова', 'вызовов', 'вызовов'];
const SITUATIONS_ACC: [string, string, string] = ['ситуацию', 'ситуации', 'ситуаций'];
/** Why a conversation makes no situation, in the owner's words. */
const LEFT_OUT_TEXT: Record<LeftOut['kind'], string> = {
  unreadable: 'запись не читается', length: 'нет реплик клиента или их больше 16', masked: 'реплика клиента скрыта обезличиванием',
  customer_data: 'нужны данные клиента', unconfirmed: 'в правилах нет ожидаемого ответа',
};

/** What the preparation asks of the agent: nothing, or the one probe of its tools — a call to the agent, not to a model. */
const agentWords = (asksAgent: boolean): string => asksAgent ? 'Lab один раз спросит агента, какие инструменты он показывает' : 'агент не запускается';

/**
 * The consent in the owner's words: one question and the lines under it — what is read, how many situations at
 * most, what is left out and why, and the ceiling of the spending. Every surface asks it with these words.
 */
export function consentText(consent: PreparationConsent, source: string): { question: string; lines: string[] } {
  const counts = new Map<LeftOut['kind'], number>();
  for (const item of consent.excluded) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  // Sorting is stable: equal counts keep the order the conversations were left out in.
  const reasons = [...counts].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${LEFT_OUT_TEXT[kind]} — ${count}`);
  const spentOn = [...(consent.topicMapCalls ? [`${consent.topicMapCalls} — на разметку тем`] : []),
    ...(consent.promptCalls ? [`${consent.promptCalls} — на правила из промптов агента`] : [])];
  return {
    question: `Собрать ${countText(consent.promised, SITUATIONS_ACC)} из ${source}?`,
    lines: [
      `В логах ${countText(consent.conversations, CONVERSATIONS)}, подходят ${consent.usable}. Ситуаций будет не больше ${consent.promised} — по одной на разговор, из всех тем логов.`,
      ...(reasons.length ? [`Не войдут ${countText(consent.excluded.length, CONVERSATIONS)}: ${reasons.join(' · ')}.`] : []),
      `Расход — не больше ${countText(consent.callCeiling, CALLS)} модели на всю подготовку${spentOn.length ? `, из них ${spentOn.join(', ')}` : ''}. Это потолок, а не прогноз; ${agentWords(consent.asksAgent)}.`,
    ],
  };
}

/** The consent of a preparation from the owner's rules alone, in the same words: how many situations, and the ceiling of the spending. */
export function rulesConsentText(situations: number, callCeiling: number, asksAgent = false): { question: string; lines: string[] } {
  return {
    question: `Собрать ${countText(situations, SITUATIONS_ACC)} по вашим правилам?`,
    lines: ['Логов нет: ситуации строятся только по правилам — без выдуманных разговоров и личных данных клиента.',
      `Расход — не больше ${countText(callCeiling, CALLS)} модели на всю подготовку. Это потолок, а не прогноз; ${agentWords(asksAgent)}.`],
  };
}

/** The conversations a preparation turns into situations: its units, the lists their replacements come from, what is left out, and the topics' traffic. */
export interface LogSample {
  /** Situations asked for: the preparation never makes more. */
  count: number;
  /** The units in order: one round over the topics at a time. */
  picked: string[];
  strata: SampleStrata;
  excluded: LeftOut[];
  /** The traffic of the import's topic map; none when the runtime cannot map topics. */
  traffic?: Traffic;
}

/**
 * The import's topic map by the mapper's builder. A stored map under the same key is reused without a call;
 * otherwise a stored build in progress is continued, and every finished step is stored before the next call, so
 * a build cut short by a crash, a stop or the budget costs nothing it already paid for.
 */
async function topicMapOf(store: ExperimentStore, batch: ImportBatch, mapper: NonNullable<Runtime['topicMap']>, ctx: CallContext, onStep: (message: string) => void): Promise<TopicMap> {
  const stored = await store.readTopicMap(topicMapKey(batch, mapper.builder));
  const reused = reusableTopicMap(stored, batch, mapper.builder);
  if (reused) return reused;
  const plan = planTopicMap(batch, mapper.builder, stored);
  let done = 0;
  const step = () => { if (done < plan.calls) onStep(`Размечаю темы разговоров: шаг ${done + 1} из ${plan.calls}`); };
  step();
  const map = await mapper.build(plan, ctx, async progress => { await store.writeTopicMap(progress); done++; step(); });
  await store.writeTopicMap(map);
  return map;
}

/**
 * The sample of `count` situations from `batch`. With a runtime that maps topics, the representative sample of the
 * import's topic map (sample.ts). A runtime that cannot map them takes the first usable conversations in the
 * import's order and claims no topic. Either way the unusable conversations are left out before anything is spent.
 */
export async function logSample(store: ExperimentStore, batch: ImportBatch, runtime: Runtime, ctx: CallContext, count: number,
  onStep: (message: string) => void = () => {}): Promise<LogSample> {
  const { dialogueIds: usable, excluded: unusable } = usableConversations(batch);
  const excluded = leftOut(batch, unusable);
  // Nothing to sample: fail before the policy is read, instead of paying for a preparation with no unit.
  if (!usable.length) throw new Error('В логах нет ни одного разговора, из которого можно сделать ситуацию.');
  if (!runtime.topicMap) return { count, picked: usable.slice(0, count), strata: [{ dialogueIds: usable }], excluded };
  const map = await topicMapOf(store, batch, runtime.topicMap, ctx, onStep);
  const sample = representativeSample(map, count);
  const traffic = trafficSummary(map);
  onStep('Темы разговоров размечены. Готовлю ситуации.');
  return { count, picked: sample.picked, strata: sampleSchema.parse(sample.strata.map(({ topicId, dialogueIds }) => ({ topicId, dialogueIds }))), excluded,
    ...(traffic ? { traffic } : {}) };
}

/**
 * The conversation that takes the seat of `unit`, a pick the preparation made no situation from: the next one of
 * its topic that is neither prepared, nor waiting, nor left out. None when the topic has no conversation left, or
 * when `unit` is not a pick of the sample: the promise then keeps one seat fewer, never one more.
 */
export function replacementFor(progress: Pick<CardPreparation, 'sample' | 'pending' | 'processed'>, unit: string): string | undefined {
  const stratum = progress.sample?.find(item => item.dialogueIds.includes(unit));
  const tried = new Set([...progress.processed, ...progress.pending, unit]);
  return stratum?.dialogueIds.find(dialogueId => !tried.has(dialogueId));
}

/** The topic a unit of the sample stands for, titled from the library's traffic of `batchId`; none without topics. */
export function unitTopic(progress: Pick<CardPreparation, 'sample'>, library: Pick<LibraryV2, 'traffic'>, batchId: string, unit: string): { ref: CardTopic; title: string } | undefined {
  const id = progress.sample?.find(item => item.dialogueIds.includes(unit))?.topicId;
  const title = id && library.traffic?.find(traffic => traffic.importId === batchId)?.topics.find(topic => topic.id === id)?.title;
  return id && title ? { ref: { batchId, id }, title } : undefined;
}
