import type { Experiment } from './contracts.js';
import { libraryV1Of } from './card/legacy-v1.js';
import type { LibraryV2 } from './card/schema.js';
import { cardCoverage, cardTrafficTopic, libraryTraffic, trafficKey } from './miner/cards.js';
import { catchAllShare, CATCH_ALL_SHARE, type TopicCoverage } from './miner/coverage.js';
import type { Verdict } from './run.js';

/*
 * How close the number is to real traffic (E2): the counted situations grouped by the topic of the
 * logged conversations they came from, each topic's share of those conversations, and the accuracy
 * weighted by that share over the measured topics — with the share of the traffic those topics hold.
 * The weighted accuracy is a rough orientation, never a second headline: it is given only when every
 * topic it weighs has at least WEIGHTED_MIN_DECIDED decided situations and those topics hold at least
 * half of the traffic; otherwise only the share is. A card library carries the traffic of the logs' topic map (miner/): every
 * conversation of the import has its topic, so the shares are those of the whole import, and a card
 * stands for the topic of its conversation. A first-format library has no map: there a topic is a
 * business scenario, and a logged conversation has one only when a business scenario names it as a
 * source, so the shares are counted over those conversations — the view says how many that is.
 * Pure: no I/O, no wording.
 */

export interface TopicRow {
  id: string; title: string;
  /** Counted situations of this topic, and how many of them the agent handled out of those decided. */
  situations: number; passed: number; decided: number;
  /** This topic's share of the logged conversations with a known topic; null when no logged conversation has one. */
  share: number | null;
}
export interface TopicView {
  /** Largest share first, then the most situations, then the library order. */
  rows: TopicRow[];
  /** Topics of logged conversations without any counted situation: their share of the conversations with a known topic. */
  uncovered: { topics: number; share: number } | null;
  /**
   * The per-topic accuracy weighted by each measured topic's share of conversations — a rough orientation for the logged
   * traffic, said only under the topics, never beside the headline; null without shares, with fewer than two measured
   * topics, with a measured topic of fewer than WEIGHTED_MIN_DECIDED decided situations, or when the measured topics hold
   * less than WEIGHTED_FROM of the conversations, or when the catch-all topic dominates.
   */
  weighted: number | null;
  /** The share of the conversations with a known topic whose topic has a decided situation: the traffic `weighted` speaks for. */
  measuredShare: number;
  /** Logged conversations of the imports, and those among them with a known topic. */
  logged: number; labeled: number;
}

/**
 * Below this share of the conversations the weighted estimate would stand for topics it never measured, and a number
 * «с учётом частоты тем» would say more about the unmeasured traffic than about the agent: it is not given.
 */
export const WEIGHTED_FROM = 0.5;
/**
 * The fewest decided situations a topic needs before its share may weigh its accuracy: one or two situations say
 * almost nothing about a topic, and weighting them by a large share would pass a guess off as the traffic's accuracy.
 */
export const WEIGHTED_MIN_DECIDED = 3;

interface CountedCard { scenarioId: string; outcome: Verdict; control: boolean }

/** One topic's row: its counted situations, and how many of the decided ones the agent handled. */
function topicRow(id: string, title: string, own: readonly CountedCard[], share: number | null): TopicRow {
  const passed = own.filter(card => card.outcome === 'pass').length;
  return { id, title, situations: own.length, passed, decided: passed + own.filter(card => card.outcome === 'fail').length, share };
}

/** The topics with a decided situation and a share of the conversations: the ones an estimate can weigh. */
const measuredRows = (rows: readonly TopicRow[]) => rows.filter(row => row.decided > 0 && row.share !== null && row.share > 0);
const shareOf = (rows: readonly TopicRow[]) => rows.reduce((sum, row) => sum + (row.share ?? 0), 0);

/**
 * The accuracy of each measured topic weighted by its share, normalised over the measured topics: roughly what the agent
 * would score on the traffic of those topics. Null without shares, with fewer than two measured topics, when one of them
 * has fewer than WEIGHTED_MIN_DECIDED decided situations, or when they hold less than WEIGHTED_FROM of the conversations
 * (the shares are ratios of counts, hence the tolerance).
 */
function weightedAccuracy(rows: readonly TopicRow[]): number | null {
  const measured = measuredRows(rows);
  const measuredShare = shareOf(measured);
  return measured.length >= 2 && measured.every(row => row.decided >= WEIGHTED_MIN_DECIDED) && measuredShare + 1e-9 >= WEIGHTED_FROM
    ? measured.reduce((sum, row) => sum + row.share! * (row.passed / row.decided), 0) / measuredShare : null;
}

/** The rows' view parts that follow from the rows alone. */
const estimateOf = (rows: readonly TopicRow[]) => ({ weighted: weightedAccuracy(rows), measuredShare: Math.min(1, shareOf(measuredRows(rows))) });

/** The topic rows of a run of accepted cards: each counted card under the topic of the logs it stands for, shares from the library's traffic. */
function cardTopicView(library: LibraryV2, cards: CountedCard[]): TopicView | null {
  const traffic = libraryTraffic(library);
  if (!traffic) return null;
  const topicOf = new Map(library.cards.flatMap(card => {
    const topic = cardTrafficTopic(library, card);
    return topic ? [[card.id, trafficKey(topic)] as const] : [];
  }));
  const counted = cards.filter(card => !card.control && topicOf.has(card.scenarioId));
  const used = new Set(counted.map(card => topicOf.get(card.scenarioId)!));
  if (used.size < 2) return null;
  // The traffic lists the topics largest first, so its order breaks the ties the way the first format's library order does.
  const order = new Map(traffic.topics.map((topic, index) => [topic.id, index]));
  const rows = traffic.topics.filter(topic => used.has(topic.id))
    .map(topic => topicRow(topic.id, topic.title, counted.filter(card => topicOf.get(card.scenarioId) === topic.id), topic.share))
    .sort((a, b) => b.share! - a.share! || b.situations - a.situations || order.get(a.id)! - order.get(b.id)!);
  const missing = traffic.topics.filter(topic => !used.has(topic.id));
  const uncovered = missing.length ? { topics: missing.length, share: missing.reduce((sum, topic) => sum + topic.dialogues, 0) / traffic.labeled } : null;
  const estimate = estimateOf(rows);
  return { rows, uncovered, ...estimate, ...(catchAllShare(traffic) > CATCH_ALL_SHARE ? { weighted: null } : {}), logged: traffic.logged, labeled: traffic.labeled };
}

/** The topic rows of a run made from a library with at least two topics among its counted situations; null otherwise. */
export function topicView(record: Experiment, cards: CountedCard[]): TopicView | null {
  if (record.librarySnapshot?.formatVersion === 2) return cardTopicView(record.librarySnapshot, cards);
  const library = libraryV1Of(record);
  if (!library) return null;
  const topicOf = new Map(library.variants.map(variant => [variant.id, variant.businessScenarioId]));
  const counted = cards.filter(card => !card.control && topicOf.has(card.scenarioId));
  const used = new Set(counted.map(card => topicOf.get(card.scenarioId)!));
  if (used.size < 2) return null;
  // Each logged conversation counts once, for the first topic that names it.
  const logged = new Set(library.imports.flatMap(batch => batch.dialogues.map(dialogue => `${batch.id}|${dialogue.id}`)));
  const labels = new Map<string, string>();
  for (const topic of library.businessScenarios) {
    for (const source of topic.sourceDialogues) {
      const key = `${source.batchId}|${source.dialogueId}`;
      if (logged.has(key) && !labels.has(key)) labels.set(key, topic.id);
    }
  }
  const conversations = new Map<string, number>();
  for (const topic of labels.values()) conversations.set(topic, (conversations.get(topic) ?? 0) + 1);
  const labeled = labels.size;
  const share = (id: string): number | null => labeled ? (conversations.get(id) ?? 0) / labeled : null;
  const order = new Map(library.businessScenarios.map((topic, index) => [topic.id, index]));
  const rows = library.businessScenarios.filter(topic => used.has(topic.id))
    .map(topic => topicRow(topic.id, topic.title, counted.filter(card => topicOf.get(card.scenarioId) === topic.id), share(topic.id)))
    .sort((a, b) => (b.share ?? 0) - (a.share ?? 0) || b.situations - a.situations || order.get(a.id)! - order.get(b.id)!);
  const missing = [...conversations.keys()].filter(id => !used.has(id));
  const uncovered = labeled && missing.length
    ? { topics: missing.length, share: missing.reduce((sum, id) => sum + (conversations.get(id) ?? 0), 0) / labeled } : null;
  return { rows, uncovered, ...estimateOf(rows), logged: logged.size, labeled };
}

/** How much of the logged traffic the counted situations of a card run cover (E1); null without the logs' topics. */
export function trafficCoverage(record: Experiment, cards: CountedCard[]): TopicCoverage | null {
  const library = record.librarySnapshot;
  if (library?.formatVersion !== 2) return null;
  return cardCoverage(library, cards.filter(card => !card.control).map(card => card.scenarioId)) ?? null;
}
