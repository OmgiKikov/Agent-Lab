import type { Source } from '../contracts.js';
import { PLAN_EXPECTATIONS } from '../card/plan.js';
import { promptLoad, promptsOversize } from '../card/budget.js';
import { countLeftOut, leftOutTotal, leftOutWords } from '../log-issues.js';
import { workInputIssue } from '../limits.js';
import { personalData, type PersonalData } from '../personal-data.js';
import { countText } from '../plural.js';
import type { ImportBatch, LeftOutCount } from '../scenario-contracts.js';
import { planTopicMap, reusableTopicMap, topicMapKey, type BuilderModel } from '../miner/topic-map.js';
import type { ExperimentStore } from '../store.js';
import { unjudgeable } from './criteria.js';
import { FIT_BATCH } from './fit.js';
import { ANALYSIS_LIMIT, ANALYSIS_TOTAL_LIMIT, PER_TOPIC_LIMIT, type LogAnalysis } from './schema.js';

/*
 * What the owner agrees to before logs are analysed: one value every surface renders as it is — what is read, what is
 * left out and why, how many conversations are judged and how they are chosen, where the text goes, and the ceiling of
 * the calls. Nothing of the agent runs: no situation is made, no agent or simulated customer is started.
 *
 *   ceiling = the topic map (none when a map of these logs is reused)
 *           + a plan per topic, with the choice of its articles when the materials do not fit one request, and the
 *             reviewer's check when the plan says the materials are silent for the topic
 *           + where a topic may hold more conversations than its plan reads: the fit of them (a call for FIT_BATCH),
 *             and a plan and a fit of those the topic's plan does not fit
 *           + for each conversation, at most every expectation of a plan, two votes each
 *
 * A continuation (continuationConsent) is agreed to the same way: the next conversations, what is reused without a call.
 */

/** Calls a topic spends choosing articles of a knowledge base too large for one request: from the titles, then on reading them. */
const READING_CALLS = 2;
/** The reviewer's one call on a topic whose plan says the materials are silent for it (discover/analyze.ts reviewGap). */
const GAP_REVIEW_CALLS = 1;
/** Topics one analysis plans at most: the map's own and «Другое». */
const PLAN_TOPICS = 16;
/** Votes of the judge on one expectation of one conversation. */
const VOTES = 2;

/**
 * The most model calls an analysis of `conversations` makes: every answer passing the first time. `extras`: a topic may
 * hold more conversations than its plan read — always so in a continuation —, so they are fitted, and those the topic's
 * plan does not fit get a plan and a fit of their own.
 */
export function analysisCeiling(input: { task: string; sources: readonly Source[]; conversations: number; topicMapCalls: number; topics?: number; extras?: boolean }): number {
  const reading = workInputIssue({ task: input.task, sources: input.sources }) ? READING_CALLS : 0;
  const topics = input.topics ?? Math.min(input.conversations, PLAN_TOPICS);
  const plan = 1 + reading + GAP_REVIEW_CALLS;
  const extras = input.extras ?? input.conversations > topics;
  const fitting = extras ? topics * (plan + 2) + Math.ceil(input.conversations / FIT_BATCH) : 0;
  return input.topicMapCalls + topics * plan + fitting + input.conversations * PLAN_EXPECTATIONS * VOTES;
}

/** The time an analysis may take: an hour, and a minute more for every conversation. */
export const analysisTime = (conversations: number): number => Math.min(4 * 3_600_000, 3_600_000 + conversations * 60_000);

export interface AnalysisConsent {
  /** Every conversation of the log, the ones the import could read, and those of them Lab can judge. */
  conversations: number; readable: number; judgeable: number;
  /** A log larger than one import: the readable conversations its sample was drawn from, and those taken. */
  sample?: { usable: number; taken: number };
  /** Rows the import refused, counted by why. */
  unread: LeftOutCount[];
  /** Readable conversations without a customer's message or the agent's reply: nothing to judge in them. */
  unjudgeable: { no_customer: number; no_agent_reply: number };
  /** Conversations judged at most, and at most so many of one topic. */
  analysed: number; perTopic: number;
  /** The teaching example: no model reads anything. */
  demo: boolean;
  /** The tools the owner declared the log records every call of (discover/schema.ts logContractSchema); none — no call's absence is proved. */
  recorded: string[];
  topicMapCalls: number;
  callCeiling: number;
  prompts: { count: number; bytes: number };
  readers: { provider: string; model: string; roles: ('builder' | 'judge')[] }[];
  personal: PersonalData;
}

/** The consent of analysing up to `requested` conversations of `batch` against `sources`, reading what the store holds of the logs' topic map. */
export async function analysisConsent(store: Pick<ExperimentStore, 'readTopicMap'>, input: { batch: ImportBatch; task: string; sources: readonly Source[]; requested: number;
  builder: BuilderModel; judge: { provider: string; model: string }; demo?: boolean; recorded?: readonly string[] }): Promise<AnalysisConsent> {
  const { batch } = input;
  const oversize = promptsOversize(input.task, [...input.sources]);
  if (oversize) throw new Error(oversize);
  const counts = { no_customer: 0, no_agent_reply: 0 };
  for (const dialogue of batch.dialogues) { const reason = unjudgeable(dialogue); if (reason) counts[reason]++; }
  const judgeable = batch.dialogues.length - counts.no_customer - counts.no_agent_reply;
  if (!judgeable) throw new Error(`В логах нет ни одного разговора, где клиент пишет и агент отвечает: разбирать нечего.${batch.dialogues.length ? ` Без реплики клиента — ${counts.no_customer}, без ответа агента — ${counts.no_agent_reply}. Проверьте, что сообщения клиента помечены ролью user, а агента — assistant.` : ''}`);
  const stored = await store.readTopicMap(topicMapKey(batch, input.builder));
  const topicMapCalls = reusableTopicMap(stored, batch, input.builder) ? 0 : planTopicMap(batch, input.builder, stored).calls;
  const analysed = Math.min(input.requested, judgeable, ANALYSIS_LIMIT);
  const conversations = batch.sample?.dialogues ?? batch.dialogues.length + batch.rejected.length;
  const unread = countLeftOut(batch.rejected.flatMap(row => row.issues ? [{ issues: row.issues, ...(row.id ? { id: row.id } : {}) }] : []));
  const readers = readersOf(input.builder, input.judge);
  return {
    conversations, readable: batch.dialogues.length, judgeable,
    ...batch.sample && batch.dialogues.length < batch.sample.usable ? { sample: { usable: batch.sample.usable, taken: batch.dialogues.length } } : {},
    unread, unjudgeable: counts, analysed, perTopic: PER_TOPIC_LIMIT, topicMapCalls, demo: !!input.demo, recorded: [...input.recorded ?? []],
    callCeiling: analysisCeiling({ task: input.task, sources: input.sources, conversations: analysed, topicMapCalls }),
    prompts: promptLoad(input.sources), readers: input.demo ? [] : readers, personal: personalData(batch),
  };
}

/** The readers of the conversations' text: the builder and the judge, one entry when they are the same model. */
function readersOf(builder: BuilderModel, judge: { provider: string; model: string }): AnalysisConsent['readers'] {
  const builderRole = { provider: builder.provider, model: builder.id };
  const readers: AnalysisConsent['readers'] = [{ ...builderRole, roles: ['builder'] }];
  if (judge.provider === builderRole.provider && judge.model === builderRole.model) readers[0]!.roles.push('judge');
  else readers.push({ ...judge, roles: ['judge'] });
  return readers.filter(reader => reader.provider && reader.model);
}

/**
 * What the owner agrees to before an analysis is continued: the next conversations — none selected before —, what is
 * carried with no call (findings whose key still holds under this judge), what is done again and why, the ceiling.
 */
export interface ContinuationConsent {
  analysisId: string; file: string;
  /** Conversations the judge can read, those the analysis selected before, and those not selected yet. */
  judgeable: number; picked: number; available: number;
  /** The next conversations selected at most. */
  analysed: number;
  /** Findings carried with no call, and the earlier ones not carried: made by another judge or under other inputs. */
  reused: number; stale: number;
  /** Topics whose plan Lab did not finish before, planned again. */
  replanned: number;
  /** Conversations selected before and not fitted to their topic's plan yet: fitted now, then judged. */
  refitted: number;
  topicMapCalls: number; callCeiling: number; demo: boolean;
  readers: AnalysisConsent['readers'];
}

/**
 * The consent of continuing `earlier` by up to `more` conversations: `draft` is the continuation as it would start
 * (discover/analyze.ts continueFrom) and `pendingJobs` the judgments its carried conversations still need.
 */
export async function continuationConsent(store: Pick<ExperimentStore, 'readTopicMap'>, input: { earlier: LogAnalysis; draft: LogAnalysis; batch: ImportBatch; more: number; pendingJobs: number;
  unfitted: number; builder: BuilderModel; judge: { provider: string; model: string } }): Promise<ContinuationConsent> {
  const { earlier, draft, batch } = input;
  const judgeable = batch.dialogues.filter(dialogue => !unjudgeable(dialogue)).length;
  const picked = earlier.selection.picked.length;
  const available = Math.max(0, Math.min(judgeable, ANALYSIS_TOTAL_LIMIT) - picked);
  const replannedGroups = draft.topics.filter(group => !group.scenarioId);
  // Lab's own unfinished work — a plan, a fit, a judgment — is done by a continuation even when every conversation is selected.
  const unfinished = replannedGroups.length + input.unfitted + input.pendingJobs;
  if (!available && !unfinished) throw new Error(`В разборе уже выбраны и оценены все ${countText(picked, CONVERSATIONS)}, которые можно оценить: продолжать нечем. Разберите другую выгрузку логов.`);
  const analysed = Math.min(input.more, available, ANALYSIS_LIMIT);
  const stored = earlier.selection.method === 'topics' ? await store.readTopicMap(topicMapKey(batch, input.builder)) : undefined;
  const topicMapCalls = earlier.selection.method !== 'topics' || reusableTopicMap(stored, batch, input.builder) ? 0 : planTopicMap(batch, input.builder, stored).calls;
  const replannedConversations = replannedGroups.reduce((sum, group) => sum + group.dialogueIds.length + (group.extra?.length ?? 0), 0);
  const plans = analysisCeiling({ task: draft.task, sources: draft.sources, conversations: analysed + replannedConversations + input.unfitted, topicMapCalls,
    topics: replannedGroups.length + Math.min(analysed + input.unfitted, PLAN_TOPICS), extras: true });
  return { analysisId: earlier.id, file: earlier.logs.file, judgeable, picked, available, analysed, reused: draft.continues?.reused ?? 0,
    stale: earlier.findings.length - (draft.continues?.reused ?? 0), replanned: replannedGroups.length, refitted: input.unfitted, topicMapCalls,
    callCeiling: plans + input.pendingJobs * VOTES, demo: earlier.mode === 'demo', readers: earlier.mode === 'demo' ? [] : readersOf(input.builder, input.judge) };
}

const CONVERSATIONS: [string, string, string] = ['разговор', 'разговора', 'разговоров'];
/** After «до»: «до 1 разговора», «до 24 разговоров». */
const CONVERSATIONS_UP_TO: [string, string, string] = ['разговора', 'разговоров', 'разговоров'];
const CALLS: [string, string, string] = ['вызова', 'вызовов', 'вызовов'];
const PROMPTS: [string, string, string] = ['промпт', 'промпта', 'промптов'];
const IN_CONVERSATIONS: [string, string, string] = ['разговоре', 'разговорах', 'разговорах'];

/** What each model does with the conversations' text. */
const work = (roles: readonly ('builder' | 'judge')[]): string => roles.includes('builder')
  ? roles.includes('judge') ? 'размечает темы, находит правила и оценивает разговоры' : 'размечает темы и находит правила, которые к ним относятся' : 'оценивает разговоры по правилам';

/** The consent in the owner's words: one question and the lines under it. Every surface asks it with these words. */
export function analysisConsentText(consent: AnalysisConsent, file: string): { question: string; lines: string[] } {
  const { sample, unjudgeable: skipped, personal } = consent;
  const unread = leftOutTotal(consent.unread);
  const skippedTotal = skipped.no_customer + skipped.no_agent_reply;
  const providers = new Set(consent.readers.map(reader => reader.provider));
  const kinds = [...personal.cards ? [`номера карт — ${personal.cards}`] : [], ...personal.phones ? [`телефоны — ${personal.phones}`] : [], ...personal.emails ? [`почта — ${personal.emails}`] : []];
  return {
    question: `Найти ошибки агента в ${countText(consent.analysed, IN_CONVERSATIONS)} из «${file}»?`,
    lines: [
      sample ? `В логах ${countText(consent.conversations, CONVERSATIONS)}; в одну загрузку входит ${sample.taken} из ${sample.usable} прочитанных — по хешу содержимого, без отбора по исходу.`
        : `В логах ${countText(consent.conversations, CONVERSATIONS)}.`,
      ...(unread ? [`Не прочитаны ${countText(unread, CONVERSATIONS)}: ${leftOutWords(consent.unread).join(' · ')}.`] : []),
      ...(skippedTotal ? [`Нечего оценивать в ${countText(skippedTotal, IN_CONVERSATIONS)}: ${[...skipped.no_customer ? [`нет реплики клиента — ${skipped.no_customer}`] : [], ...skipped.no_agent_reply ? [`нет ответа агента — ${skipped.no_agent_reply}`] : []].join(', ')}.`] : []),
      `Lab разметит темы всех прочитанных разговоров — это покажет, с чем приходят клиенты, — и разберёт до ${countText(consent.analysed, CONVERSATIONS_UP_TO)} из ${consent.judgeable}: места делятся между темами по их доле среди прочитанных разговоров, а места, оставшиеся после округления, получают сначала темы без единого места. Правила темы Lab находит по её разговорам, не больше ${consent.perTopic}; другой разговор темы Lab сначала сверяет с найденным планом и оценивает по правилам того варианта, в котором клиент, — а разговорам, которые ни к одному варианту не подошли, ищет правила отдельно. Частота нарушений будет среди разобранных, а не по всему трафику. Продолжить разбор следующими разговорами можно позже — уже сделанное не оплачивается повторно.`,
      'Правила берутся из ваших материалов, каждое — на дословной цитате; к каждому разговору — только правила его ситуации.',
      consent.recorded.length ? `Вы подтвердили: лог записывает каждый вызов ${consent.recorded.join(', ')} в разговорах, помеченных полными. Если правило требует такой вызов, а его нет, — это нарушение. Отсутствие вызова других инструментов не доказывается.`
        : 'Что лог записывает каждый вызов инструментов, вы не подтверждали: если правило требует действия, а вызова в логе нет, Lab скажет «не видно», а не «нарушено».',
      ...(consent.readers.length ? [`Тексты разговоров уйдут ${providers.size > 1 ? 'провайдерам' : `провайдеру ${consent.readers[0]!.provider}`}: ${consent.readers.map(reader => `${providers.size > 1 ? `${reader.provider} — ` : ''}модель ${reader.model} ${work(reader.roles)}`).join('; ')}.`] : []),
      ...(personal.conversations ? [`В ${countText(personal.conversations, IN_CONVERSATIONS)} похоже на личные данные: ${kinds.join(', ')}; они уйдут ${providers.size > 1 ? 'провайдерам' : 'провайдеру'} как есть.`] : []),
      ...(consent.prompts.count ? [`Промпты агента — ${countText(consent.prompts.count, PROMPTS)}, ${Math.ceil(consent.prompts.bytes / 1000)} КБ — судья читает их правила с каждым разговором.`] : []),
      consent.demo ? 'Учебный пример: темы, правила и оценки — заготовки без модели, ничего не тратится. Агент не запускается, ситуации не создаются.' : `Расход — не больше ${countText(consent.callCeiling, CALLS)} модели${consent.topicMapCalls ? `, из них ${consent.topicMapCalls} — на разметку тем` : ''}: по два голоса судьи на каждое правило каждого разговора. Это потолок, а не прогноз. Агент не запускается, ситуации не создаются.`,
    ],
  };
}

/** The consent of a continuation in the owner's words: one question and the lines under it, the same on every surface. */
export function continuationConsentText(consent: ContinuationConsent): { question: string; lines: string[] } {
  const providers = new Set(consent.readers.map(reader => reader.provider));
  return {
    question: consent.analysed ? `Продолжить разбор «${consent.file}»: ещё до ${countText(consent.analysed, CONVERSATIONS_UP_TO)}?`
      : `Доделать разбор «${consent.file}»? Новых разговоров не осталось — Lab закончит то, что не доделал.`,
    lines: [
      `Уже выбрано ${consent.picked} из ${countText(consent.judgeable, CONVERSATIONS_UP_TO)}, которые можно оценить; не выбрано ещё ${consent.available}. Следующие Lab возьмёт так же: по доле тем среди прочитанных разговоров, без отбора по исходу.`,
      consent.reused ? `Уже сделанные оценки — ${consent.reused} — перейдут без вызова модели: правила, логи и судья те же.` : 'Уже сделанных оценок, которые можно перенести, нет.',
      ...(consent.stale ? [`${countText(consent.stale, ['оценка', 'оценки', 'оценок'])} прошлого разбора сделаны другим судьёй или по другим правилам — Lab оценит их заново; прошлый разбор не меняется.`] : []),
      ...(consent.replanned ? [`Тем, где работа Lab не закончилась, — ${consent.replanned}: правила для них Lab попробует найти снова.`] : []),
      ...(consent.refitted ? [`${countText(consent.refitted, ['разговор', 'разговора', 'разговоров'])} прошлого разбора Lab сначала сверит с планом темы, потом оценит.`] : []),
      'Новый разговор темы, для которой правила уже найдены, Lab сначала сверяет с её планом и оценивает по правилам того варианта, в котором клиент; разговорам, которые ни к одному варианту не подошли, и новой теме Lab ищет правила отдельно.',
      ...(consent.readers.length ? [`Тексты разговоров уйдут ${providers.size > 1 ? 'провайдерам' : `провайдеру ${consent.readers[0]!.provider}`}: ${consent.readers.map(reader => `${providers.size > 1 ? `${reader.provider} — ` : ''}модель ${reader.model} ${work(reader.roles)}`).join('; ')}.`] : []),
      consent.demo ? 'Учебный пример: оценки — заготовки без модели, ничего не тратится.' : `Расход — не больше ${countText(consent.callCeiling, CALLS)} модели${consent.topicMapCalls ? `, из них ${consent.topicMapCalls} — на разметку тем` : ''}. Это потолок, а не прогноз.`,
    ],
  };
}
