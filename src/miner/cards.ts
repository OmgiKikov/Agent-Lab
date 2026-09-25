import { cardSchema, type Card, type LibraryV2, type PreparationProgress } from '../card/schema.js';
import type { CardStatus } from '../card/status.js';
import { coverageLine, topicCoverage, uncoveredLine, withShares, type TopicCoverage, type TopicTraffic } from './coverage.js';
import { OTHER, type CardTopic } from './schema.js';
import { countText } from '../plural.js';

/*
 * The logs' topics as a card library carries them: each card the topic it stands for, the library the traffic of
 * the maps its cards were sampled from. Everything here reads the library alone, so the situation list of a draft
 * and the result of an accepted run count topics the same way, with no map, import or store at hand.
 *
 *   dialogue card ─► the topic of its conversation in the map      similar card ─► its parent's
 *   card from the owner's rules ─► none: it covers no topic of the logs and has no row of its own
 */

/** A topic among every import of one library. Import and topic ids are identifiers, so the slash never occurs in either. */
export const trafficKey = (topic: CardTopic): string => `${topic.batchId}/${topic.id}`;

/** The traffic of every import the cards were sampled from, as one: each topic of each map is a topic of its own, keyed by trafficKey. */
export function libraryTraffic(library: Pick<LibraryV2, 'traffic'>): TopicTraffic | undefined {
  const summaries = library.traffic ?? [];
  if (!summaries.length) return undefined;
  const topics = summaries.flatMap(traffic => traffic.topics.map(topic => ({ id: trafficKey({ batchId: traffic.importId, id: topic.id }), ...(topic.id === OTHER ? { other: true as const } : {}),
    title: topic.title, dialogues: topic.dialogues })))
    // Sorting is stable: equal shares keep the order of the imports and of each map.
    .sort((a, b) => b.dialogues - a.dialogues);
  return withShares(topics, summaries.reduce((sum, traffic) => sum + traffic.logged, 0));
}

/** The topic of the logs a card stands for: its own; a similar card without one stands for its parent's; none otherwise. */
export function cardTrafficTopic(library: Pick<LibraryV2, 'cards'>, card: Card): CardTopic | undefined {
  const seen = new Set<string>();
  let current: Card | undefined = card;
  while (current && !seen.has(current.id)) {
    if (current.trafficTopic) return current.trafficTopic;
    const origin: Card['origin'] = current.origin;
    if (origin.kind !== 'similar') return undefined;
    seen.add(current.id);
    current = library.cards.find(item => item.id === origin.parentId);
  }
  return undefined;
}

/** A card made from a sampled conversation, standing for that conversation's topic: its title in the owner's words, and its id. */
export function withTrafficTopic(card: Card, topic: { ref: CardTopic; title: string } | undefined): Card {
  return topic ? cardSchema.parse({ ...card, topic: topic.title, trafficTopic: topic.ref }) : card;
}

/** How much of the library's traffic the cards `cardIds` cover, one entry per card; undefined without the logs' topics. */
export function cardCoverage(library: Pick<LibraryV2, 'cards' | 'traffic'>, cardIds: readonly string[]): TopicCoverage | undefined {
  const traffic = libraryTraffic(library);
  if (!traffic) return undefined;
  return topicCoverage(traffic, cardIds.map(id => {
    const card = library.cards.find(item => item.id === id);
    const topic = card && cardTrafficTopic(library, card);
    return topic && trafficKey(topic);
  }));
}

/**
 * The two lines above the situation list, over the cards ready to run: «15 ситуаций покрывают 9 из 11 тем —
 * 94% диалогов» and, while a topic has no ready card, «Не покрыты: …». Undefined when the logs' topics are unknown.
 */
export function situationCoverage(library: LibraryV2, statuses: ReadonlyMap<string, Pick<CardStatus, 'status'>>): { line: string; uncovered: string | undefined } | undefined {
  const coverage = cardCoverage(library, library.cards.filter(card => statuses.get(card.id)?.status === 'ready').map(card => card.id));
  const line = coverage && coverageLine(coverage);
  return coverage && line ? { line, uncovered: uncoveredLine(coverage) } : undefined;
}

/**
 * The requests of the logs the owner's rules leave open, as a preparation found them (card/prepare.ts): «Правил нет для
 * 3 запросов из логов: …» — a gap in the rules for the owner to fill, never a failure of Lab. Undefined when there is none.
 */
export function gapsLine(progress: PreparationProgress | undefined): string | undefined {
  const gaps = progress?.protocol === 'cards-v1' || progress?.protocol === 'cards-v2' ? progress.excluded.flatMap(item => item.uncovered ? [item.uncovered] : []) : [];
  if (!gaps.length) return undefined;
  return `Правил нет для ${countText(gaps.length, ['запроса', 'запросов', 'запросов'])} из логов: ${gaps.slice(0, 3).map(gap => `«${gap}»`).join('; ')}${
    gaps.length > 3 ? ` и ещё ${gaps.length - 3}` : ''}. Добавьте правила в материалы — иначе такие запросы не проверяются.`;
}
