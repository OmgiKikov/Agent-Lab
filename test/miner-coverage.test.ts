import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverageLine, sharePercent, topicCoverage, topicTraffic, uncoveredLine } from '../src/miner/coverage.js';
import { representativeSample } from '../src/miner/sample.js';
import { buildTopicMap, OTHER, planTopicMap, topicOfDialogue } from '../src/miner/topic-map.js';
import { BUILDER, importOf, mapOf, MASKED, MODELS, RUNTIME, scriptedRunner, world } from './helpers/miner.js';
import { callContext } from './helpers/pi-fixture.js';

test('the coverage line agrees in number with 1, 2 and 5 situations and topics', () => {
  const line = (sizes: number[], situations: (string | undefined)[]) => coverageLine(topicCoverage(mapOf(sizes), situations));
  assert.equal(line([10], ['t1']), '1 ситуация покрывает 1 из 1 темы — 100% диалогов');
  assert.equal(line([10, 10], ['t1', 't2']), '2 ситуации покрывают 2 из 2 тем — 100% диалогов');
  assert.equal(line([20, 20, 20, 20, 20], ['t1', 't1', 't2', 't3', 't3']), '5 ситуаций покрывают 3 из 5 тем — 60% диалогов');
  assert.equal(line([20, 20, 20, 20, 20], []), '0 ситуаций покрывают 0 из 5 тем — 0% диалогов');
  assert.equal(line(Array(11).fill(10), Array.from({ length: 21 }, (_, i) => `t${1 + i % 9}`)), '21 ситуация покрывает 9 из 11 тем — 82% диалогов');
  assert.equal(line([], []), undefined, 'no topic, no line');
});

test('uncovered topics are named with their shares, largest first; a long tail is summed', () => {
  const uncovered = (sizes: number[], other: number, situations: string[]) => uncoveredLine(topicCoverage(mapOf(sizes, { other }), situations));
  assert.equal(uncovered([60, 36, 4], 0, ['t1', 't2']), 'Не покрыта: Смена тарифа (4% диалогов)');
  assert.equal(uncovered([60, 34, 4], 2, ['t1', 't2']), 'Не покрыты: Смена тарифа (4% диалогов), Другое (2%)');
  assert.equal(uncovered([40, 20, 15, 12, 8, 5], 0, ['t1', 't2']), 'Не покрыты: Смена тарифа (15% диалогов), Подключение терминала (12%), Жалоба на сотрудника (8%), Тема 6 (5%)',
    'four are named: hiding one behind «и ещё 1 тема» saves nothing');
  assert.equal(uncovered([30, 20, 15, 12, 8, 5, 5, 5], 0, ['t1']),
    'Не покрыты: Статус заявки (20% диалогов), Смена тарифа (15%), Подключение терминала (12%) и ещё 4 темы (23%)');
  assert.equal(uncovered([60, 40], 0, ['t1', 't2']), undefined, 'all covered');
});

test('a share that is neither none nor all never reads as 0% or 100%', () => {
  assert.deepEqual([0, 0.004, 0.005, 0.5, 0.94, 0.995, 0.999, 1].map(sharePercent), ['0%', 'меньше 1%', '1%', '50%', '94%', '99%', '99%', '100%']);
  const nearlyAll = topicCoverage(mapOf([299, 1]), ['t1']);
  assert.equal(coverageLine(nearlyAll), '1 ситуация покрывает 1 из 2 тем — 99% диалогов');
  assert.equal(uncoveredLine(nearlyAll), 'Не покрыта: Статус заявки (меньше 1% диалогов)');
});

test('situations without a topic of the map are counted but cover nothing; «Другое» is covered like any topic', () => {
  const map = mapOf([50, 30], { other: 20 });
  const coverage = topicCoverage(map, ['t1', undefined, OTHER, 'unknown']);
  assert.deepEqual([coverage.situations, coverage.topics, coverage.covered, coverage.share], [4, 3, 2, 0.7]);
  assert.equal(coverageLine(coverage), '4 ситуации покрывают 2 из 3 тем — 70% диалогов');
  assert.equal(uncoveredLine(coverage), 'Не покрыта: Статус заявки (30% диалогов)');
});

test('the traffic of a map: topic shares of the sorted conversations, largest first, and how many were logged and labeled', () => {
  const excluded = [{ dialogueId: 'x1', kind: 'length' as const, reason: 'нужны 1–16 реплик клиента' }];
  const traffic = topicTraffic(mapOf([10, 30, 0, 20], { other: 40, excluded }));
  assert.deepEqual(traffic.topics.map(topic => [topic.id, topic.title, topic.dialogues, topic.share]),
    [[OTHER, 'Другое', 40, 0.4], ['t2', 'Статус заявки', 30, 0.3], ['t4', 'Подключение терминала', 20, 0.2], ['t1', 'Возврат оплаты', 10, 0.1]],
    'a proposed topic without conversations is not a topic of the traffic');
  assert.deepEqual([traffic.labeled, traffic.logged], [100, 101]);
});

test('a representative sample of the logs covers every topic, and each picked conversation names its topic', async () => {
  const logged = [...world(), MASKED];
  const batch = importOf(logged);
  const map = await buildTopicMap(planTopicMap(batch, BUILDER), { runtime: RUNTIME, models: MODELS, run: scriptedRunner(logged).run, ctx: callContext().ctx });
  const sample = representativeSample(map, 15);
  const topics = sample.picked.map(dialogueId => topicOfDialogue(map, { batchId: batch.id, dialogueId }));
  assert.ok(topics.every(topic => topic !== undefined));
  const coverage = topicCoverage(map, topics);
  assert.equal(coverageLine(coverage), '15 ситуаций покрывают 6 из 6 тем — 100% диалогов');
  assert.equal(uncoveredLine(coverage), undefined);
  assert.equal(topicOfDialogue(map, { batchId: 'import_other', dialogueId: sample.picked[0]! }), undefined, 'a conversation of another import has no topic here');
  assert.equal(topicOfDialogue(map, { batchId: batch.id, dialogueId: MASKED.id }), undefined, 'an excluded conversation has no topic');
  assert.equal(topicOfDialogue(map, { batchId: batch.id, dialogueId: 'toString' }), undefined, 'only the map\'s own keys are assignments');
});
