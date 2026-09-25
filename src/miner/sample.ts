import { seededOrder, topicDialogues, type TopicMap, type TopicRef } from './topic-map.js';

/*
 * The representative sample (E1): which logged conversations become situations when the owner asks for
 * `count` of them. The topics of the map are strata, «Другое» one more of them: seats follow each topic's
 * share of the traffic — every sorted conversation, the ones no situation can be made of included — and a
 * topic takes at most as many as it has conversations a situation can be made of. A rare topic gets a seat
 * only out of those the rounding leaves, never at the expense of the topics most customers bring. Ties and
 * the order inside a topic come from the import's content hash — never Math.random, never how a conversation
 * ended.
 *
 *   quota = seats × size / Σ open sizes ─► a quota reaching its capacity takes all of it, the rest re-share
 *         ─► whole parts ─► the seats left: one each to open topics without a seat (largest first), then largest remainders
 */

export interface SampleStratum {
  topicId: TopicRef;
  /** This topic's share of the sorted conversations. */
  share: number;
  available: number;
  allocated: number;
  /** The topic's conversations in pick order: the first `allocated` are picked, the rest are its next candidates. */
  dialogueIds: string[];
}
export interface RepresentativeSample {
  /** One round over the topics at a time, largest first: any prefix of the sample spreads over as many topics as it can. */
  picked: string[];
  /** Largest share first; equal shares in the content hash's order. */
  strata: SampleStratum[];
  /** Conversations no sample can take, with the reason, as the map recorded them. */
  excluded: TopicMap['excluded'];
}

/**
 * Seats for `count` out of strata of `sizes` — each stratum's traffic, largest first, the order ties follow — each
 * taking at most its `capacity` (its conversations a situation can be made of; the traffic itself by default). Seats
 * follow traffic by the largest remainder method: a stratum whose proportional quota reaches its capacity takes all
 * of it and the others re-share the rest; every other stratum gets the whole part of its quota. The seats the rounding
 * leaves go first, one each, to strata that have none yet, the largest first — the floor of one never takes a seat
 * from the topics most customers bring — then to the largest remainders. Integers throughout, so equal inputs give
 * equal seats on every machine.
 */
export function allocate(sizes: readonly number[], count: number, capacity: readonly number[] = sizes): number[] {
  if (count >= capacity.reduce((sum, room) => sum + room, 0)) return [...capacity];
  const seats = sizes.map(() => 0);
  const open = new Set(sizes.flatMap((size, index) => size > 0 && capacity[index]! > 0 ? [index] : []));
  const weightOf = () => [...open].reduce((sum, index) => sum + sizes[index]!, 0);
  let left = count;
  for (;;) {
    const weight = weightOf();
    const full = [...open].filter(index => left * sizes[index]! >= capacity[index]! * weight);
    if (!full.length) break;
    for (const index of full) { seats[index] = capacity[index]!; left -= capacity[index]!; open.delete(index); }
  }
  const weight = weightOf();
  if (!weight) return seats;
  // Every open quota is below its capacity now, so its whole part and one more seat both fit in it.
  for (const index of open) seats[index] = (left * sizes[index]! - (left * sizes[index]!) % weight) / weight;
  let rest = left - [...open].reduce((sum, index) => sum + seats[index]!, 0);
  const order = [...open].sort((a, b) => Number(seats[a]! > 0) - Number(seats[b]! > 0)
    || (left * sizes[b]!) % weight - (left * sizes[a]!) % weight || a - b);
  for (const index of order) {
    if (!rest) break;
    seats[index] = seats[index]! + 1;
    rest -= 1;
  }
  return seats;
}

/**
 * The conversations to prepare as `count` situations: every topic represented in proportion to its share of the logs.
 * `unsuitable` are sorted conversations no situation can be made of (topic-map.ts): they count in their topic's share
 * and are never picked.
 */
export function representativeSample(map: TopicMap, count: number, unsuitable: ReadonlySet<string> = new Set()): RepresentativeSample {
  if (!Number.isInteger(count) || count < 1) throw new Error('Число ситуаций должно быть целым и не меньше 1.');
  const groups = [...topicDialogues(map)];
  const total = groups.reduce((sum, [, dialogueIds]) => sum + dialogueIds.length, 0);
  const candidates = new Map(groups.map(([topicId, dialogueIds]) => [topicId, dialogueIds.filter(dialogueId => !unsuitable.has(dialogueId))]));
  // Sorting is stable: topics of equal size keep the content hash's order.
  const ranked = seededOrder(groups, map.contentHash, ([topicId]) => `topic:${topicId}`).sort((a, b) => b[1].length - a[1].length);
  const seats = allocate(ranked.map(([, dialogueIds]) => dialogueIds.length), count, ranked.map(([topicId]) => candidates.get(topicId)!.length));
  const strata = ranked.map(([topicId, dialogueIds], index): SampleStratum => ({
    topicId, share: dialogueIds.length / total, available: candidates.get(topicId)!.length, allocated: seats[index]!,
    dialogueIds: seededOrder(candidates.get(topicId)!, map.contentHash, dialogueId => `pick:${dialogueId}`),
  }));
  const picked: string[] = [];
  for (let round = 0; strata.some(stratum => stratum.allocated > round); round++) {
    for (const stratum of strata) if (stratum.allocated > round) picked.push(stratum.dialogueIds[round]!);
  }
  return { picked, strata, excluded: map.excluded };
}
