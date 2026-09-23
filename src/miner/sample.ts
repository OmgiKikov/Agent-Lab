import { seededOrder, topicDialogues, type TopicMap, type TopicRef } from './topic-map.js';

/*
 * The representative sample (E1): which logged conversations become situations when the owner asks for
 * `count` of them. The topics of the map are strata, «Другое» one more of them: each gets seats in
 * proportion to its share of the conversations, at least one while the count allows (otherwise the
 * largest topics get one each), rounded by the largest remainder. Ties and the order inside a topic come
 * from the import's content hash — never Math.random, never how a conversation ended.
 *
 *   quota = seats × size / Σ free sizes ─► a quota below 1 is held at 1, the rest re-share ─► floors + largest remainders
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
 * Seats for `count` out of strata of `sizes` (largest first, the order ties follow). A stratum whose
 * proportional quota is below one is held at one and the others re-share the remaining seats, until every
 * free quota is at least one; then floors, and the seats left over go to the largest remainders. Integers
 * throughout, so equal inputs give equal seats on every machine.
 */
export function allocate(sizes: readonly number[], count: number): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (count >= total) return [...sizes];
  if (count < sizes.length) return sizes.map((_, index) => index < count ? 1 : 0);
  const held = new Set<number>();
  let seats = count, weight = total;
  for (;;) {
    const below = sizes.flatMap((size, index) => !held.has(index) && seats * size < weight ? [index] : []);
    if (!below.length) break;
    for (const index of below) { held.add(index); seats -= 1; weight -= sizes[index]!; }
  }
  // Holding a stratum at one only lowers the others' quotas, so every free quota stays within its stratum's size.
  const floors = sizes.map((size, index) => held.has(index) ? 1 : (seats * size - (seats * size) % weight) / weight);
  let left = count - floors.reduce((sum, seat) => sum + seat, 0);
  const byRemainder = sizes.flatMap((size, index) => held.has(index) ? [] : [{ index, remainder: (seats * size) % weight }])
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder) {
    if (left === 0) break;
    floors[index] = floors[index]! + 1;
    left -= 1;
  }
  return floors;
}

/** The conversations to prepare as `count` situations: every topic represented in proportion to its share of the logs. */
export function representativeSample(map: TopicMap, count: number): RepresentativeSample {
  if (!Number.isInteger(count) || count < 1) throw new Error('Число ситуаций должно быть целым и не меньше 1.');
  const groups = [...topicDialogues(map)];
  const total = groups.reduce((sum, [, dialogueIds]) => sum + dialogueIds.length, 0);
  // Sorting is stable: topics of equal size keep the content hash's order.
  const ranked = seededOrder(groups, map.contentHash, ([topicId]) => `topic:${topicId}`).sort((a, b) => b[1].length - a[1].length);
  const seats = allocate(ranked.map(([, dialogueIds]) => dialogueIds.length), count);
  const strata = ranked.map(([topicId, dialogueIds], index): SampleStratum => ({
    topicId, share: dialogueIds.length / total, available: dialogueIds.length, allocated: seats[index]!,
    dialogueIds: seededOrder(dialogueIds, map.contentHash, dialogueId => `pick:${dialogueId}`),
  }));
  const picked: string[] = [];
  for (let round = 0; strata.some(stratum => stratum.allocated > round); round++) {
    for (const stratum of strata) if (stratum.allocated > round) picked.push(stratum.dialogueIds[round]!);
  }
  return { picked, strata, excluded: map.excluded };
}
