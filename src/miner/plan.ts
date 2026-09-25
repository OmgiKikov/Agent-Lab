import { isRunnable, materialSources, type CreateInput, type Settings } from '../contracts.js';
import type { CallContext, Runtime } from '../runtime.js';
import { preparationCeiling, promptLoad, promptsOversize } from '../card/budget.js';
import type { CardPreparation, LibraryV2 } from '../card/schema.js';
import { roleChoices } from '../llm/models.js';
import { countLeftOut, issueText, leftOutTotal, leftOutWords, mergeLeftOut, rolesLine, unknownRoles, wayOut } from '../log-issues.js';
import { personalData, type PersonalData } from '../personal-data.js';
import type { ImportBatch, LeftOutCount } from '../scenario-contracts.js';
import type { ExperimentStore } from '../store.js';
import { countText, pluralForm } from '../plural.js';
import { clip } from '../text.js';
import { topicTraffic, trafficSummary, untopicedText } from './coverage.js';
import { representativeSample } from './sample.js';
import { sampleSchema, type CardTopic, type SampleStrata, type Traffic } from './schema.js';
import { planTopicMap, reusableTopicMap, topicMapKey, usableConversations, type BuilderModel, type TopicMap, type Unsuitable } from './topic-map.js';

/*
 * The Scenario Miner inside a preparation (E1). Before anything is spent the owner reads one consent value; then
 * the import's topic map is reused or built, and the representative sample of the requested count becomes the
 * preparation's units:
 *
 *   consent: map calls · the preparation's ceiling · situations promised · every conversation of the log left out,
 *            counted by its reason — or, when none of them fits, no consent at all: why, and what to do
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

/** A conversation of an import no situation is made from: a row the import refused, or one it read that no situation can be made of. */
export interface LeftOut { dialogueId: string; reason: string }

/** The conversations of an import left out before anything is spent, in import order: the rows it refused, then the ones no situation can be made of. */
export function leftBeforeSpending(batch: ImportBatch, unsuitable: readonly Unsuitable[] = usableConversations(batch).unsuitable): LeftOut[] {
  return [
    ...batch.rejected.map((row): LeftOut => ({ dialogueId: clip(row.id ?? `row_${row.index}`, 200), reason: clip(row.reasons.join(' '), 2000) })),
    ...unsuitable.map(({ dialogueId, issue }): LeftOut => ({ dialogueId, reason: issueText(issue) })),
  ];
}

/** Why the conversations of a log make no situation, counted: typed, and in their own words the rows of an import read before reasons were typed. */
interface LogLeft { counts: LeftOutCount[]; asRead: { reason: string; count: number }[] }

/**
 * Every conversation of the log no situation is made from, counted by why: a sample's import counted the whole log as it
 * read it; an import that keeps every row counts its refused rows and the ones no situation can be made of.
 */
function logLeft(batch: ImportBatch, unsuitable: readonly Unsuitable[]): LogLeft {
  const situations = countLeftOut(unsuitable.map(({ dialogueId, issue }) => ({ issues: [issue], id: dialogueId })));
  if (batch.sample) return { counts: batch.sample.left ?? situations, asRead: [] };
  const asRead = new Map<string, number>();
  for (const row of batch.rejected) if (!row.issues) asRead.set(row.reasons[0]!, (asRead.get(row.reasons[0]!) ?? 0) + 1);
  const refused = countLeftOut(batch.rejected.flatMap(row => row.issues ? [{ issues: row.issues, ...(row.id ? { id: row.id } : {}) }] : []));
  return { counts: mergeLeftOut(refused, situations), asRead: [...asRead].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) };
}

/** Each reason of a log's left-out conversations with its count, the typed ones first. */
const leftWords = (left: LogLeft): string[] =>
  [...leftOutWords(left.counts), ...left.asRead.map(item => `${item.reason.charAt(0).toLowerCase()}${item.reason.slice(1)} — ${item.count}`)];
const leftCount = (left: LogLeft): number => leftOutTotal(left.counts) + left.asRead.reduce((sum, item) => sum + item.count, 0);

/**
 * No conversation of the logs makes a situation, so no consent is asked: the message says every reason with its
 * count and the way out of the most frequent one. `roles` are the role names Lab does not know — the owner may still
 * say who writes under them, and each surface asks that its own way.
 */
export class NothingFits extends Error {
  constructor(left: LogLeft, conversations: number) {
    const reasons = leftWords(left);
    super(`Из логов не собрать ни одной ситуации: ни один из ${countText(conversations, CONVERSATIONS_OF)} не подходит${reasons.length ? ` — ${reasons.join(' · ')}` : ''}. ${wayOut(left.counts)}`);
    this.name = 'NothingFits';
    this.roles = unknownRoles(left.counts);
  }
  readonly roles: readonly string[];
}

/** The role names of an import's conversations Lab does not know, as written: what the owner is asked to map. */
export const loggedRolesToMap = (batch: ImportBatch): string[] => unknownRoles(logLeft(batch, []).counts);

/**
 * What the owner agrees to before logs become situations: one value every surface renders as it is. Spending has
 * two numbers: the calls of the topic map when every answer passes — none when a stored map of these logs is
 * reused — and the ceiling the whole preparation stops at, the map included (card/budget.ts). The draft's own call
 * limit stays the run's budget.
 */
export interface PreparationConsent {
  /** Logged conversations in the log, every row counted, and — in the import — those a situation can be made from. */
  conversations: number;
  usable: number;
  /** A log larger than one import: the readable conversations its sample was drawn from, and the conversations taken. */
  sample?: { usable: number; taken: number };
  /** Situations promised: the preparation never makes more. */
  promised: number;
  topicMapCalls: number;
  /** The agent's prompts every situation reads in full (card/budget.ts promptLoad): how many, and their size. */
  prompts: { count: number; bytes: number };
  callCeiling: number;
  /**
   * Conversations of the log no situation is made from, counted by why (log-issues.ts). A long one is still sorted into
   * its topic, so it counts in the traffic; none is a situation.
   */
  left: LeftOutCount[];
  /** The refused rows of an import read before reasons were typed, by the words it stored. */
  leftAsRead: { reason: string; count: number }[];
  /** The draft has a connected agent: Lab sends it one message to learn whether its tool calls can be judged (connection.ts). */
  asksAgent: boolean;
  /** The stored topic map of these logs found no topic for most conversations (coverage.ts untopicedText); absent otherwise, or before a map. */
  untopiced?: string;
  /**
   * Where the conversations' text goes: the provider and the model of each role that reads it — the builder maps the
   * topics and writes the situations, the judge checks each situation against its conversation (llm/models.ts roleChoices).
   */
  readers: { provider: string; model: string; roles: ('builder' | 'judge')[] }[];
  /** Conversations of the import holding personal data in the open, by shape (personal-data.ts): they go to the provider as they are. */
  personal: PersonalData;
}

/** Who reads the conversations' text: each distinct provider and model of the roles that read it, the builder first. */
function readersOf(settings: CreateInput['settings']): PreparationConsent['readers'] {
  const { builder, judge } = roleChoices(settings);
  const readers: PreparationConsent['readers'] = [];
  for (const [role, choice] of [['builder', builder], ['judge', judge]] as const) {
    if (!choice.provider || !choice.model) continue;
    const same = readers.find(reader => reader.provider === choice.provider && reader.model === choice.model);
    if (same) same.roles.push(role); else readers.push({ provider: choice.provider, model: choice.model, roles: [role] });
  }
  return readers;
}

/**
 * The consent of preparing `situations` situations from the logs of `input` (its import) under its settings and
 * rules, reading what the store already holds of the logs' topic map. A log no situation can be made from asks for no
 * consent: the refusal says why and what to do.
 */
export async function preparationConsent(store: Pick<ExperimentStore, 'readTopicMap'>, request: { input: CreateInput; situations?: number }): Promise<PreparationConsent> {
  const { input } = request;
  const batch = input.originalImport;
  if (!batch) throw new Error('Согласие на подготовку из логов нужно только тогда, когда логи есть.');
  const builder = builderOf(input.settings);
  const stored = await store.readTopicMap(topicMapKey(batch, builder));
  const { dialogueIds, unsuitable } = usableConversations(batch);
  const left = logLeft(batch, unsuitable);
  const conversations = batch.sample?.dialogues ?? batch.dialogues.length + batch.rejected.length;
  if (!dialogueIds.length) throw new NothingFits(left, conversations);
  const promised = Math.min(situationCount(request.situations), dialogueIds.length);
  const reused = reusableTopicMap(stored, batch, builder);
  const topicMapCalls = reused ? 0 : planTopicMap(batch, builder, stored).calls;
  const sources = materialSources(input.materials);
  // Prompts too large for any request would make no situation: the owner hears it before agreeing to anything.
  const oversize = promptsOversize(input.task, sources);
  if (oversize) throw new Error(oversize);
  return {
    // A sample is told only where it took fewer than it could read: a small log with a row too large to keep took them all.
    conversations, usable: dialogueIds.length, ...batch.sample && batch.dialogues.length < batch.sample.usable ? { sample: { usable: batch.sample.usable, taken: batch.dialogues.length } } : {},
    promised, topicMapCalls,
    prompts: promptLoad(sources),
    callCeiling: preparationCeiling({ task: input.task, sources, situations: promised, fromLogs: true, topicMapCalls }),
    left: left.counts, leftAsRead: left.asRead, asksAgent: isRunnable(input.target),
    ...(reused && untopicedText(topicTraffic(reused)) ? { untopiced: untopicedText(topicTraffic(reused))! } : {}),
    readers: readersOf(input.settings), personal: personalData(batch),
  };
}

const CONVERSATIONS: [string, string, string] = ['разговор', 'разговора', 'разговоров'];
/** The count after «из»: «ни один из 50 разговоров». */
const CONVERSATIONS_OF: [string, string, string] = ['разговора', 'разговоров', 'разговоров'];
/** The count after «не больше»: «не больше 21 вызова», «не больше 115 вызовов». */
const CALLS: [string, string, string] = ['вызова', 'вызовов', 'вызовов'];
const SITUATIONS_ACC: [string, string, string] = ['ситуацию', 'ситуации', 'ситуаций'];
/** The ceiling holds the one revision of a situation the check rejected (card/budget.ts). */
const REVISION_TEXT = 'Сюда входит одна переделка каждой ситуации, которую не пропустила проверка.';
const PROMPTS: [string, string, string] = ['промпт', 'промпта', 'промптов'];

/** «в 3 разговорах». */
const CONVERSATIONS_IN: [string, string, string] = ['разговоре', 'разговорах', 'разговорах'];
/** What a model does with the conversations' text, by the roles it plays. */
const roleWork = (roles: readonly ('builder' | 'judge')[]): string => roles.includes('builder')
  ? roles.includes('judge') ? 'размечает темы, пишет и проверяет ситуации' : 'размечает темы и пишет ситуации' : 'проверяет ситуации';

/** Where the conversations' text goes, and what of it looks like personal data: the owner's call, never masked by Lab. */
function providerLines(consent: PreparationConsent): string[] {
  const { readers, personal } = consent;
  if (!readers.length) return [];
  const providers = new Set(readers.map(reader => reader.provider));
  const who = readers.map(reader => `${providers.size > 1 ? `${reader.provider} — ` : ''}модель ${reader.model} ${roleWork(reader.roles)}`);
  const lines = [`Тексты разговоров уйдут ${providers.size > 1 ? 'провайдерам' : `провайдеру ${readers[0]!.provider}`}: ${who.join('; ')}.`];
  const kinds = [...personal.cards ? [`номера карт — ${personal.cards}`] : [], ...personal.phones ? [`телефоны — ${personal.phones}`] : [], ...personal.emails ? [`почта — ${personal.emails}`] : []];
  if (personal.conversations) lines.push(`В ${countText(personal.conversations, CONVERSATIONS_IN)} похоже на личные данные: ${kinds.join(', ')}; они уйдут ${providers.size > 1 ? 'провайдерам' : 'провайдеру'} как есть.`);
  return lines;
}

/** What the preparation asks of the agent: nothing, or the one probe of its tools — a call to the agent, not to a model. */
const agentWords = (asksAgent: boolean): string => asksAgent ? 'Lab один раз спросит агента, какие инструменты он показывает' : 'агент не запускается';

/**
 * The consent in the owner's words: one question and the lines under it — what is read, how many situations at
 * most, what is left out and why, and the ceiling of the spending. Every surface asks it with these words.
 */
export function consentText(consent: PreparationConsent, source: string): { question: string; lines: string[] } {
  const left: LogLeft = { counts: consent.left, asRead: consent.leftAsRead };
  const reasons = leftWords(left);
  const { prompts, sample } = consent;
  const roles = rolesLine(consent.left);
  // A larger log than one import: the owner hears how many it held and how the import's sample was taken.
  const logged = sample ? `В логах ${countText(consent.conversations, CONVERSATIONS)}; в одну загрузку входит ${sample.taken} из ${sample.usable} прочитанных — Lab берёт их по хешу содержимого, без отбора по исходу. В ситуации из них подходят ${consent.usable}.`
    : `В логах ${countText(consent.conversations, CONVERSATIONS)}, в ситуации подходят ${consent.usable}.`;
  return {
    question: `Собрать ${countText(consent.promised, SITUATIONS_ACC)} из ${source}?`,
    lines: [
      `${logged} Ситуаций будет не больше ${consent.promised} — по одной на разговор, из всех тем логов.`,
      ...(reasons.length ? [`${pluralForm(leftCount(left), ['Не войдёт', 'Не войдут', 'Не войдут'])} в ситуации ${countText(leftCount(left), CONVERSATIONS)}${sample ? ' логов' : ''}: ${reasons.join(' · ')}.`] : []),
      ...(roles ? [roles] : []),
      ...(consent.untopiced ? [`Темы этих логов уже размечены, но ${consent.untopiced}.`] : []),
      ...providerLines(consent),
      ...(prompts.count ? [`Промпты агента — ${countText(prompts.count, PROMPTS)}, ${Math.ceil(prompts.bytes / 1000)} КБ — читаются целиком с каждым разговором.`] : []),
      `Расход — не больше ${countText(consent.callCeiling, CALLS)} модели на всю подготовку${consent.topicMapCalls ? `, из них ${consent.topicMapCalls} — на разметку тем` : ''}. ${REVISION_TEXT} Это потолок, а не прогноз; ${agentWords(consent.asksAgent)}.`,
    ],
  };
}

/** The consent of a preparation from the owner's rules alone, in the same words: how many situations, and the ceiling of the spending. */
export function rulesConsentText(situations: number, callCeiling: number, asksAgent = false): { question: string; lines: string[] } {
  return {
    question: `Собрать ${countText(situations, SITUATIONS_ACC)} по вашим правилам?`,
    lines: ['Логов нет: ситуации строятся только по правилам — без выдуманных разговоров и личных данных клиента.',
      `Расход — не больше ${countText(callCeiling, CALLS)} модели на всю подготовку. ${REVISION_TEXT} Это потолок, а не прогноз; ${agentWords(asksAgent)}.`],
  };
}

/** The conversations a preparation turns into situations: its units, the lists their replacements come from, what is left out, and the topics' traffic. */
export interface LogSample {
  /** Situations asked for: the preparation never makes more. */
  count: number;
  /** The units in order: one round over the topics at a time. */
  picked: string[];
  strata: SampleStrata;
  /** The conversations of the import left out before anything is spent, with the reason. */
  excluded: LeftOut[];
  /** The traffic of the import's topic map; none when the runtime cannot map topics. */
  traffic?: Traffic;
}

/**
 * The import's topic map by the mapper's builder. A stored map under the same key is reused without a call;
 * otherwise a stored build in progress is continued, and every finished step is stored before the next call, so
 * a build cut short by a crash, a stop or the budget costs nothing it already paid for.
 */
async function topicMapOf(store: ExperimentStore, batch: ImportBatch, mapper: NonNullable<Runtime['topicMap']>, ctx: CallContext, onStep: (message: string) => void | Promise<void>): Promise<TopicMap> {
  const stored = await store.readTopicMap(topicMapKey(batch, mapper.builder));
  const reused = reusableTopicMap(stored, batch, mapper.builder);
  if (reused) return reused;
  const plan = planTopicMap(batch, mapper.builder, stored);
  let done = 0;
  const step = async () => { if (done < plan.calls) await onStep(`Размечаю темы разговоров: шаг ${done + 1} из ${plan.calls}`); };
  await step();
  const map = await mapper.build(plan, ctx, async progress => { await store.writeTopicMap(progress); done++; await step(); });
  await store.writeTopicMap(map);
  return map;
}

/**
 * The sample of `count` situations from `batch`. With a runtime that maps topics, the representative sample of the
 * import's topic map (sample.ts). A runtime that cannot map them takes the first usable conversations in the
 * import's order and claims no topic. Either way the unusable conversations are left out before anything is spent.
 */
export async function logSample(store: ExperimentStore, batch: ImportBatch, runtime: Runtime, ctx: CallContext, count: number,
  onStep: (message: string) => void | Promise<void> = () => {}): Promise<LogSample> {
  const { dialogueIds: usable, unsuitable } = usableConversations(batch);
  const excluded = leftBeforeSpending(batch, unsuitable);
  // Nothing to sample: fail before the policy is read, instead of paying for a preparation with no unit.
  if (!usable.length) throw new NothingFits(logLeft(batch, unsuitable), batch.sample?.dialogues ?? batch.dialogues.length + batch.rejected.length);
  if (!runtime.topicMap) return { count, picked: usable.slice(0, count), strata: [{ dialogueIds: usable }], excluded };
  const map = await topicMapOf(store, batch, runtime.topicMap, ctx, onStep);
  const sample = representativeSample(map, count, new Set(unsuitable.map(item => item.dialogueId)));
  const traffic = trafficSummary(map);
  // A map that found no topic for most conversations is said so at once, not only in the result.
  const untopiced = untopicedText(topicTraffic(map));
  await onStep(untopiced ? `Темы разговоров размечены, но ${untopiced}. Готовлю ситуации.` : 'Темы разговоров размечены. Готовлю ситуации.');
  // A topic whose every conversation is unsuitable has no candidate: it stays in the traffic and out of the sample.
  return { count, picked: sample.picked, strata: sampleSchema.parse(sample.strata.flatMap(({ topicId, dialogueIds }) => dialogueIds.length ? [{ topicId, dialogueIds }] : [])), excluded,
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
