import { countText, pluralForm } from '../plural.js';
import { OTHER, trafficSchema, type Traffic } from './schema.js';
import { topicDialogues, topicTitle, type TopicMap, type TopicRef } from './topic-map.js';

/*
 * How much of the logged traffic a set of situations covers (E1), and the topic shares the
 * traffic-weighted accuracy reads (E2). A topic of the traffic is a topic of the map with at least one
 * conversation, «Другое» included; it is covered when at least one situation belongs to it. A card
 * library keeps the traffic of its map as counts (`Traffic`, schema.ts); the shares are derived here.
 *
 *   15 ситуаций покрывают 9 из 11 тем — 94% диалогов
 *   Не покрыты: Жалоба на сотрудника (4% диалогов), Партнёрская программа (2%)
 *
 * A map that sorted more than CATCH_ALL_SHARE of the conversations into «Другое» found no topics for most of them:
 * then its shares say little about the traffic, and every line built on them says so.
 *
 * Pure: the words of both lines are here, the screens only place them.
 */

export interface TrafficTopic {
  id: TopicRef;
  /** «Другое»: the conversations that fit no topic of the map. */
  other?: true;
  title: string;
  /** Sorted conversations of this topic, and their share of all sorted conversations. */
  dialogues: number;
  share: number;
}
export interface TopicTraffic {
  /** Largest share first; equal shares in the map's order, «Другое» last. */
  topics: TrafficTopic[];
  /** Conversations with a topic, and every conversation of the import, the excluded ones included. */
  labeled: number;
  logged: number;
}

/** Above this share of the sorted conversations in «Другое», the map found no topic for most of them: its shares say little about the traffic. */
export const CATCH_ALL_SHARE = 0.3;

/** The share of the sorted conversations that fit no topic («Другое»). */
export const catchAllShare = (traffic: Pick<TopicTraffic, 'topics'>): number => traffic.topics.reduce((sum, topic) => sum + (topic.other ? topic.share : 0), 0);

/** What an owner is told when most conversations fit no topic; undefined while the map sorted most of them. */
export function untopicedText(traffic: Pick<TopicTraffic, 'topics'>): string | undefined {
  const share = catchAllShare(traffic);
  return share > CATCH_ALL_SHARE ? `${sharePercent(share)} разговоров не попали ни в одну тему («Другое») — доли тем мало что говорят о трафике` : undefined;
}

/** Each topic's share of the sorted conversations, from the counts; `topics` keep their order. */
export function withShares(topics: readonly Omit<TrafficTopic, 'share'>[], logged: number): TopicTraffic {
  const labeled = topics.reduce((sum, topic) => sum + topic.dialogues, 0);
  return { topics: topics.map(topic => ({ ...topic, share: topic.dialogues / labeled })), labeled, logged };
}

/** The topics of the logged conversations with their shares: the weights of the traffic-weighted accuracy. */
export function topicTraffic(map: TopicMap): TopicTraffic {
  const groups = [...topicDialogues(map)];
  // Sorting is stable: equal shares keep the map's order.
  const topics = groups.map(([id, dialogueIds]) => ({ id, ...(id === OTHER ? { other: true as const } : {}), title: topicTitle(map, id)!, dialogues: dialogueIds.length })).sort((a, b) => b.dialogues - a.dialogues);
  return withShares(topics, groups.reduce((sum, [, dialogueIds]) => sum + dialogueIds.length, map.excluded.length));
}

/** What a card library keeps of a map: its identity and the traffic's counts; undefined when no conversation has a topic. */
export function trafficSummary(map: TopicMap): Traffic | undefined {
  const { topics, labeled, logged } = topicTraffic(map);
  if (!labeled) return undefined;
  return trafficSchema.parse({ importId: map.importId, contentHash: map.contentHash, model: map.model, promptVersion: map.promptVersion,
    topics: topics.map(({ id, title, dialogues }) => ({ id, title, dialogues })), labeled, logged });
}

export interface TopicCoverage {
  /** Situations counted, with a topic of this map or without one. */
  situations: number;
  /** Topics of the traffic, and those with at least one situation. */
  topics: number;
  covered: number;
  /** Sorted conversations, and the share of them whose topic is covered. */
  dialogues: number;
  share: number;
  /** Topics without a situation, largest share first. */
  uncovered: TrafficTopic[];
  /** Why the shares say little: most conversations fit no topic (untopicedText); absent while the map sorted most of them. */
  untopiced?: string;
}

/**
 * Coverage of the situations whose topics are `situationTopics`: one entry per counted situation — the
 * topic of its source conversation in `traffic` (topicOfDialogue), undefined for a situation without one.
 */
export function topicCoverage(traffic: TopicTraffic, situationTopics: readonly (TopicRef | undefined)[]): TopicCoverage {
  const used = new Set(situationTopics);
  const covered = traffic.topics.filter(topic => used.has(topic.id));
  // Counted in conversations and divided once, so full coverage is exactly 1.
  const coveredDialogues = covered.reduce((sum, topic) => sum + topic.dialogues, 0);
  const untopiced = untopicedText(traffic);
  return {
    situations: situationTopics.length, topics: traffic.topics.length, covered: covered.length,
    dialogues: traffic.labeled, share: traffic.labeled ? coveredDialogues / traffic.labeled : 0,
    uncovered: traffic.topics.filter(topic => !used.has(topic.id)), ...(untopiced ? { untopiced } : {}),
  };
}

/** A share in whole percent as the owner reads it: a share that is neither none nor all never reads as 0% or 100%. */
export function sharePercent(share: number): string {
  if (share <= 0) return '0%';
  if (share >= 1) return '100%';
  const percent = Math.round(share * 100);
  return percent < 1 ? 'меньше 1%' : `${Math.min(percent, 99)}%`;
}

const SITUATIONS: [string, string, string] = ['ситуация', 'ситуации', 'ситуаций'];
const COVER: [string, string, string] = ['покрывает', 'покрывают', 'покрывают'];
/** Genitive after «из»: «из 1 темы», «из 11 тем». */
const TOPICS_OF: [string, string, string] = ['темы', 'тем', 'тем'];
const TOPICS: [string, string, string] = ['тема', 'темы', 'тем'];
/** Uncovered topics named one by one; more are summed as «и ещё N тем». */
const UNCOVERED_NAMED = 3;

/**
 * «15 ситуаций покрывают 9 из 11 тем — 94% диалогов», and — when most conversations fit no topic — that the shares say
 * little; undefined when the map sorted no conversation into a topic.
 */
export function coverageLine(coverage: TopicCoverage): string | undefined {
  if (!coverage.topics) return undefined;
  return `${countText(coverage.situations, SITUATIONS)} ${pluralForm(coverage.situations, COVER)} ${coverage.covered} из ${coverage.topics} ${pluralForm(coverage.topics, TOPICS_OF)} — ${sharePercent(coverage.share)} диалогов`
    + (coverage.untopiced ? `; но ${coverage.untopiced}` : '');
}

/** «Не покрыты: Жалоба на сотрудника (4% диалогов), Партнёрская программа (2%)»; undefined when every topic is covered. */
export function uncoveredLine(coverage: TopicCoverage): string | undefined {
  const { uncovered } = coverage;
  if (!uncovered.length) return undefined;
  // «и ещё 1 тема» would hide one name to save none: a single remaining topic is named instead.
  const named = uncovered.length <= UNCOVERED_NAMED + 1 ? uncovered : uncovered.slice(0, UNCOVERED_NAMED);
  const rest = uncovered.slice(named.length);
  const items = named.map((topic, index) => `${topic.title} (${sharePercent(topic.share)}${index ? '' : ' диалогов'})`).join(', ');
  const restShare = rest.reduce((sum, topic) => sum + topic.dialogues, 0) / coverage.dialogues;
  const tail = rest.length ? ` и ещё ${countText(rest.length, TOPICS)} (${sharePercent(restShare)})` : '';
  return `${uncovered.length === 1 ? 'Не покрыта' : 'Не покрыты'}: ${items}${tail}`;
}
