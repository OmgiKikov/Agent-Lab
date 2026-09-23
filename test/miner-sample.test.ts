import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allocate, representativeSample } from '../src/miner/sample.js';
import { OTHER, topicMapSchema, topicTitle } from '../src/miner/topic-map.js';
import { hashOf, mapOf } from './helpers/miner.js';

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
/** A fixed pseudo-random sequence for the sweep: the test is the same on every run. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) % 2 ** 31);
}

test('seats sum to the count, one per topic while the count allows, within one of the proportional share, never above it rounded up', () => {
  const next = sequence(20260923);
  for (let trial = 0; trial < 400; trial++) {
    const sizes = Array.from({ length: 1 + next() % 16 }, () => 1 + next() % 80).sort((a, b) => b - a);
    const total = sum(sizes);
    for (const count of new Set([1, 2, 3, 5, 8, 15, 16, 25, 40, total - 1, total, total + 3].filter(count => count >= 1))) {
      const seats = allocate(sizes, count);
      const quota = (index: number) => count * sizes[index]! / total;
      const context = `sizes ${sizes} · count ${count} · seats ${seats}`;
      assert.equal(sum(seats), Math.min(count, total), context);
      assert.deepEqual(allocate(sizes, count), seats, `deterministic: ${context}`);
      if (count >= total) { assert.deepEqual(seats, sizes, context); continue; }
      if (count < sizes.length) { assert.deepEqual(seats, sizes.map((_, index) => index < count ? 1 : 0), `the largest topics: ${context}`); continue; }
      seats.forEach((seat, index) => {
        assert.ok(seat >= 1 && seat <= sizes[index]!, `one per topic, never more than it has: ${context}`);
        assert.ok(seat <= Math.ceil(quota(index)), `never above its share rounded up: ${context}`);
        if (quota(index) < 1) assert.equal(seat, 1, `a topic below one seat is held at one: ${context}`);
        sizes.forEach((size, other) => {
          if (size < sizes[index]!) assert.ok(seat >= seats[other]!, `a larger topic never gets fewer: ${context}`);
        });
      });
      if (sizes.every((_, index) => quota(index) >= 1)) {
        seats.forEach((seat, index) => assert.ok(Math.abs(seat - quota(index)) < 1, `within one of its share: ${context}`));
      }
    }
  }
});

test('15 situations over the logs follow the traffic: every topic represented, «Другое» one more stratum, every prefix spread over the topics', () => {
  // 40, 25, 15, 10 and 4 conversations in five topics and 6 in «Другое»: quotas 6 · 3.75 · 2.25 · 1.5 · 0.6 · 0.9.
  const map = mapOf([40, 25, 15, 10, 4], { other: 6 });
  const sample = representativeSample(map, 15);
  assert.deepEqual(sample.strata.map(stratum => [stratum.topicId, stratum.available, stratum.allocated]),
    [['t1', 40, 6], ['t2', 25, 4], ['t3', 15, 2], ['t4', 10, 1], [OTHER, 6, 1], ['t5', 4, 1]]);
  assert.deepEqual(sample.strata.map(stratum => stratum.share), [0.4, 0.25, 0.15, 0.1, 0.06, 0.04]);
  assert.equal(topicTitle(map, OTHER), 'Другое');
  assert.equal(sample.picked.length, 15);
  assert.equal(new Set(sample.picked).size, 15);
  const topicOf = (dialogueId: string) => map.assignments[dialogueId];
  assert.equal(new Set(sample.picked.slice(0, 6).map(topicOf)).size, 6, 'the first six picks are six topics');
  for (const stratum of sample.strata) {
    assert.deepEqual(sample.picked.filter(dialogueId => topicOf(dialogueId) === stratum.topicId), stratum.dialogueIds.slice(0, stratum.allocated),
      'a topic\'s picks are the head of its order; the rest are its next candidates');
    assert.deepEqual([...stratum.dialogueIds].sort(), Object.keys(map.assignments).filter(dialogueId => topicOf(dialogueId) === stratum.topicId).sort());
  }
});

test('fewer situations than topics: one each for the largest, ties broken by the content hash, not by topic order', () => {
  const choices = new Set<string>();
  for (let k = 0; k < 12; k++) {
    const map = mapOf([30, 20, 20, 20, 10], { contentHash: hashOf(`import ${k}`) });
    const sample = representativeSample(map, 3);
    const chosen = sample.strata.filter(stratum => stratum.allocated).map(stratum => stratum.topicId);
    assert.equal(chosen.length, 3);
    assert.equal(chosen[0], 't1', 'the largest topic first');
    assert.ok(chosen.slice(1).every(topicId => ['t2', 't3', 't4'].includes(topicId)), 'then two of the equal ones, never the smallest');
    assert.deepEqual(representativeSample(map, 3), sample, 'the same import, the same sample');
    choices.add(chosen.slice(1).sort().join(','));
  }
  assert.ok(choices.size > 1, 'which of the equal topics win depends on the import, not on the order they were proposed in');
});

test('the order inside a topic is seeded by the content hash only; a count at or above the logs takes them all', () => {
  const map = mapOf([12, 8], { other: 3 });
  const reordered = topicMapSchema.parse({ ...map, assignments: Object.fromEntries(Object.entries(map.assignments).reverse()) });
  assert.deepEqual(representativeSample(reordered, 5), representativeSample(map, 5), 'the order the assignments were stored in changes nothing');
  const reseeded = representativeSample(mapOf([12, 8], { other: 3, contentHash: hashOf('another import') }), 5);
  assert.deepEqual(reseeded.strata.map(stratum => stratum.allocated), representativeSample(map, 5).strata.map(stratum => stratum.allocated));
  assert.notDeepEqual(reseeded.picked, representativeSample(map, 5).picked, 'another import, another draw');
  for (const count of [23, 40]) {
    const all = representativeSample(map, count);
    assert.deepEqual([...all.picked].sort(), Object.keys(map.assignments).sort());
    assert.deepEqual(all.strata.map(stratum => stratum.allocated), all.strata.map(stratum => stratum.available));
  }
});

test('excluded conversations come with their reasons and are never picked; a count below one is refused', () => {
  const excluded = [{ dialogueId: 'x1', kind: 'masked' as const, reason: 'реплика клиента целиком скрыта обезличиванием' }];
  const map = mapOf([5, 3], { excluded });
  const sample = representativeSample(map, 8);
  assert.deepEqual(sample.excluded, excluded);
  assert.ok(!sample.picked.includes('x1'));
  assert.equal(sample.picked.length, 8);
  for (const count of [0, -1, 2.5]) assert.throws(() => representativeSample(map, count), /не меньше 1/);
  const empty = representativeSample(mapOf([]), 5);
  assert.deepEqual([empty.picked, empty.strata], [[], []]);
});
