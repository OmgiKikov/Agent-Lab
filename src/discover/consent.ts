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
import { ANALYSIS_LIMIT, PER_TOPIC_LIMIT } from './schema.js';

/*
 * What the owner agrees to before logs are analysed: one value every surface renders as it is — what is read, what is
 * left out and why, how many conversations are judged and how they are chosen, where the text goes, and the ceiling of
 * the calls. Nothing of the agent runs: no situation is made, no agent or simulated customer is started.
 *
 *   ceiling = the topic map (none when a map of these logs is reused)
 *           + a plan per topic, with the choice of its articles when the materials do not fit one request
 *           + for each conversation, at most every expectation of a plan, two votes each
 */

/** Calls a topic spends choosing articles of a knowledge base too large for one request: from the titles, then on reading them. */
const READING_CALLS = 2;
/** Topics one analysis plans at most: the map's own and «Другое». */
const PLAN_TOPICS = 16;
/** Votes of the judge on one expectation of one conversation. */
const VOTES = 2;

/** The most model calls an analysis of `conversations` makes: every answer passing the first time. */
export function analysisCeiling(input: { task: string; sources: readonly Source[]; conversations: number; topicMapCalls: number }): number {
  const reading = workInputIssue({ task: input.task, sources: input.sources }) ? READING_CALLS : 0;
  const topics = Math.min(input.conversations, PLAN_TOPICS);
  return input.topicMapCalls + topics * (1 + reading) + input.conversations * PLAN_EXPECTATIONS * VOTES;
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
  topicMapCalls: number;
  callCeiling: number;
  prompts: { count: number; bytes: number };
  readers: { provider: string; model: string; roles: ('builder' | 'judge')[] }[];
  personal: PersonalData;
}

/** The consent of analysing up to `requested` conversations of `batch` against `sources`, reading what the store holds of the logs' topic map. */
export async function analysisConsent(store: Pick<ExperimentStore, 'readTopicMap'>, input: { batch: ImportBatch; task: string; sources: readonly Source[]; requested: number;
  builder: BuilderModel; judge: { provider: string; model: string }; demo?: boolean }): Promise<AnalysisConsent> {
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
  const builderRole = { provider: input.builder.provider, model: input.builder.id };
  const readers: AnalysisConsent['readers'] = [{ ...builderRole, roles: ['builder'] }];
  if (input.judge.provider === builderRole.provider && input.judge.model === builderRole.model) readers[0]!.roles.push('judge');
  else readers.push({ ...input.judge, roles: ['judge'] });
  return {
    conversations, readable: batch.dialogues.length, judgeable,
    ...batch.sample && batch.dialogues.length < batch.sample.usable ? { sample: { usable: batch.sample.usable, taken: batch.dialogues.length } } : {},
    unread, unjudgeable: counts, analysed, perTopic: PER_TOPIC_LIMIT, topicMapCalls, demo: !!input.demo,
    callCeiling: analysisCeiling({ task: input.task, sources: input.sources, conversations: analysed, topicMapCalls }),
    prompts: promptLoad(input.sources), readers: input.demo ? [] : readers.filter(reader => reader.provider && reader.model), personal: personalData(batch),
  };
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
      `Lab разметит темы всех прочитанных разговоров — это покажет, с чем приходят клиенты, — и разберёт до ${countText(consent.analysed, CONVERSATIONS_UP_TO)} из ${consent.judgeable}: поровну из всех тем, не больше ${consent.perTopic} из одной. Частота нарушений будет среди разобранных, а не по всему трафику.`,
      'Правила берутся из ваших материалов, каждое — на дословной цитате; к каждому разговору — только правила его ситуации.',
      ...(consent.readers.length ? [`Тексты разговоров уйдут ${providers.size > 1 ? 'провайдерам' : `провайдеру ${consent.readers[0]!.provider}`}: ${consent.readers.map(reader => `${providers.size > 1 ? `${reader.provider} — ` : ''}модель ${reader.model} ${work(reader.roles)}`).join('; ')}.`] : []),
      ...(personal.conversations ? [`В ${countText(personal.conversations, IN_CONVERSATIONS)} похоже на личные данные: ${kinds.join(', ')}; они уйдут ${providers.size > 1 ? 'провайдерам' : 'провайдеру'} как есть.`] : []),
      ...(consent.prompts.count ? [`Промпты агента — ${countText(consent.prompts.count, PROMPTS)}, ${Math.ceil(consent.prompts.bytes / 1000)} КБ — судья читает их правила с каждым разговором.`] : []),
      consent.demo ? 'Учебный пример: темы, правила и оценки — заготовки без модели, ничего не тратится. Агент не запускается, ситуации не создаются.' : `Расход — не больше ${countText(consent.callCeiling, CALLS)} модели${consent.topicMapCalls ? `, из них ${consent.topicMapCalls} — на разметку тем` : ''}: по два голоса судьи на каждое правило каждого разговора. Это потолок, а не прогноз. Агент не запускается, ситуации не создаются.`,
    ],
  };
}
