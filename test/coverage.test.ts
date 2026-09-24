import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyUsage, settingsSchema, type Experiment, type Trial } from '../src/contracts.js';
import { goalAttainment, replyQuality, simulatorFidelity, type MetricAssessment } from '../src/assessment.js';
import { topicView } from '../src/coverage.js';
import { buildResultView } from '../src/result-view.js';
import { realityParts } from '../src/result-text.js';
import type { Verdict } from '../src/run.js';

type Library = NonNullable<Experiment['librarySnapshot']>;
type Card = Experiment['scenarios'][number];
const world = { records: {}, writableFields: [], transientFailures: 0 };
const TITLES: Record<string, string> = { refund: 'Возврат покупки', delivery: 'Доставка', bonus: 'Бонусы' };

/**
 * A library with only what the topic view reads: the imported conversations by batch, the topics
 * with the conversations they name (`batch|dialogue`) and the topic of each variant (= situation id).
 */
function library(options: { logged: Record<string, string[]>; topics: { id: string; sources: string[] }[]; variants: Record<string, string> }): Library {
  return {
    formatVersion: 1,
    imports: Object.entries(options.logged).map(([id, dialogues]) => ({ id, dialogues: dialogues.map(dialogue => ({ id: dialogue })) })),
    businessScenarios: options.topics.map(topic => ({ id: topic.id, title: TITLES[topic.id] ?? `Тема ${topic.id}`,
      sourceDialogues: topic.sources.map(source => ({ batchId: source.split('|')[0], dialogueId: source.split('|')[1] })) })),
    variants: Object.entries(options.variants).map(([id, businessScenarioId]) => ({ id, businessScenarioId })),
  } as unknown as Library;
}

function card(id: string): Card {
  return {
    id, familyId: id, title: `Ситуация ${id}`, requirementIds: [], provenance: 'production', tier: 'regression', goalObservation: 'reply',
    user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 3 }, initialState: world, checks: [],
    metrics: [{ ...goalAttainment }, { ...replyQuality }, { ...simulatorFidelity }], split: 'dev',
  };
}
const vote = (metricId: string, result: MetricAssessment['result']): MetricAssessment => ({ metricId, result, rationale: 'Обоснование.', evidence: [1] });
function attempt(scenarioId: string, goal: 'pass' | 'fail' = 'pass'): Trial {
  return {
    id: `t-${scenarioId}`, revisionId: 'rev', scenarioId, familyId: scenarioId, repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: 'h',
    outcome: 'ungraded', reason: 'Диалог дошёл до конца.', checks: [],
    events: [{ seq: 0, type: 'user', text: 'Здравствуйте' }, { seq: 1, type: 'assistant', text: 'Ответ агента' }, { seq: 2, type: 'simulator', result: { message: '', done: true } }],
    initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 1,
    assessments: [vote('goal_attainment', goal), vote('reply_quality', 'pass'), vote('user_fidelity', 'pass')],
  };
}
function run(cards: Card[] = [], trials: Trial[] = [], overrides: Partial<Experiment> = {}): Experiment {
  return {
    schemaVersion: '1', id: 'run-1', task: 't', mode: 'live', workflow: 'evaluate', createdAt: 'now', updatedAt: 'now', phase: 'results_review', message: '',
    sources: [], settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }),
    target: { kind: 'command', command: 'python3', args: ['agent.py'], timeoutMs: 60000 },
    requirements: [], questions: [], goldenCases: [], dialogues: [], profiles: [], notes: '', scenarios: cards, revisions: [], selectedRevisionId: null,
    manifestHash: 'h', reviewedAt: null, reviewMode: 'human', controlConsumedAt: null, acceptedTests: [], trials, comparisons: [], iterations: [],
    usage: emptyUsage(), error: null, limitations: [], humanReviews: [], ...overrides,
  };
}
const withLibrary = (snapshot: Library) => run([], [], { librarySnapshot: snapshot });
/** The situations the view counts from: `controls` are positive controls. */
const cards = (outcomes: Record<string, Verdict>, controls: string[] = []) =>
  Object.entries(outcomes).map(([scenarioId, outcome]) => ({ scenarioId, outcome, control: controls.includes(scenarioId) }));
const close = (actual: number | null | undefined, expected: number) => assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

/** Seven logged conversations in two batches: refund names 3, delivery 2 new ones (one it shares with refund, one outside the imports), bonus 1, one has no topic. */
const SHARED = () => library({
  logged: { logs: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'], more: ['d1'] },
  topics: [
    { id: 'refund', sources: ['logs|d1', 'logs|d2', 'logs|d3'] },
    { id: 'delivery', sources: ['logs|d3', 'logs|d4', 'more|d1', 'logs|d99'] },
    { id: 'bonus', sources: ['logs|d5'] },
  ],
  variants: { r1: 'refund', r2: 'refund', v1: 'delivery' },
});

test('there is no topic view without a library or with fewer than two topics among the counted situations', () => {
  const snapshot = library({ logged: { logs: ['d1', 'd2'] }, topics: [{ id: 'refund', sources: ['logs|d1'] }, { id: 'delivery', sources: ['logs|d2'] }],
    variants: { r1: 'refund', v1: 'delivery' } });
  assert.equal(topicView(run(), cards({ r1: 'pass', v1: 'fail' })), null, 'no library');
  assert.ok(topicView(withLibrary(snapshot), cards({ r1: 'pass', v1: 'fail' })), 'two topics');
  assert.equal(topicView(withLibrary(snapshot), cards({ r1: 'pass' })), null, 'one topic');
  assert.equal(topicView(withLibrary(snapshot), cards({ r1: 'pass', v1: 'fail' }, ['v1'])), null, 'a control never puts its topic on the view');
  assert.equal(topicView(withLibrary(snapshot), cards({ r1: 'pass', x9: 'fail' })), null, 'a situation outside the library has no topic');
  assert.ok(topicView(withLibrary(snapshot), cards({ r1: 'pass', v1: 'unknown' })), 'an undecided situation still belongs to its topic');
});

test('shares are counted over the logged conversations with a known topic, each conversation once, for the first topic naming it', () => {
  const view = topicView(withLibrary(SHARED()), cards({ r1: 'pass', r2: 'fail', v1: 'pass' }))!;
  // logs|d1…d6 and more|d1 are logged; logs|d6 has no topic, logs|d99 was never imported.
  assert.deepEqual([view.logged, view.labeled], [7, 6], 'labeled < logged: the view says how many conversations have a known topic');
  assert.deepEqual(view.rows, [
    { id: 'refund', title: 'Возврат покупки', situations: 2, passed: 1, decided: 2, share: 3 / 6 },
    { id: 'delivery', title: 'Доставка', situations: 1, passed: 1, decided: 1, share: 2 / 6 },
  ]);
  assert.deepEqual(view.uncovered, { topics: 1, share: 1 / 6 }, 'bonus has a conversation but no situation');
  // (½ · 3/6 + 1 · 2/6) / (3/6 + 2/6)
  close(view.weighted, 0.7);
});

test('the weighted estimate needs at least two measured topics that logged conversations name', () => {
  const snapshot = library({ logged: { logs: ['d1', 'd2', 'd3'] },
    topics: [{ id: 'refund', sources: ['logs|d1', 'logs|d2'] }, { id: 'delivery', sources: ['logs|d3'] }, { id: 'bonus', sources: [] }],
    variants: { r1: 'refund', v1: 'delivery', b1: 'bonus' } });
  close(topicView(withLibrary(snapshot), cards({ r1: 'pass', v1: 'fail' }))!.weighted, 2 / 3);
  // A topic without a decided situation is not measured: one measured topic gives no estimate, the rows stay.
  const undecided = topicView(withLibrary(snapshot), cards({ r1: 'pass', v1: 'unknown' }))!;
  assert.equal(undecided.weighted, null);
  assert.deepEqual(undecided.rows.map(row => [row.id, row.decided, row.share]), [['refund', 1, 2 / 3], ['delivery', 0, 1 / 3]]);
  // A topic no logged conversation names has a zero share and is not measured either.
  const unnamed = topicView(withLibrary(snapshot), cards({ r1: 'pass', b1: 'fail' }))!;
  assert.deepEqual(unnamed.rows.map(row => [row.id, row.share]), [['refund', 2 / 3], ['bonus', 0]]);
  assert.equal(unnamed.weighted, null);
  assert.deepEqual(unnamed.uncovered, { topics: 1, share: 1 / 3 }, 'delivery has conversations but no situation');
  // Without any conversation of a known topic there are no shares at all.
  const blind = library({ logged: { logs: ['d1'] }, topics: [{ id: 'refund', sources: [] }, { id: 'delivery', sources: ['other|d1'] }],
    variants: { r1: 'refund', v1: 'delivery' } });
  const none = topicView(withLibrary(blind), cards({ r1: 'pass', v1: 'fail' }))!;
  assert.deepEqual(none.rows.map(row => row.share), [null, null]);
  assert.deepEqual([none.weighted, none.uncovered, none.logged, none.labeled], [null, null, 1, 0]);
});

test('rows run from the largest share, then the most situations, then the library order; controls are never counted', () => {
  const snapshot = library({ logged: { logs: ['d1', 'd2', 'd3', 'd4'] },
    topics: [{ id: 'a', sources: ['logs|d1'] }, { id: 'b', sources: ['logs|d2'] }, { id: 'c', sources: ['logs|d3', 'logs|d4'] }],
    variants: { a1: 'a', b1: 'b', b2: 'b', c1: 'c', c2: 'c' } });
  const view = topicView(withLibrary(snapshot), cards({ a1: 'pass', b1: 'pass', b2: 'fail', c1: 'fail', c2: 'pass' }, ['c2']))!;
  assert.deepEqual(view.rows.map(row => [row.id, row.situations, row.passed, row.decided]), [['c', 1, 0, 1], ['b', 2, 1, 2], ['a', 1, 1, 1]]);
  assert.deepEqual(topicView(withLibrary(snapshot), cards({ b1: 'fail', a1: 'pass' }))!.rows.map(row => row.id), ['a', 'b'], 'a full tie keeps the library order');
});

test('the result view carries the topic view of its counted situations', () => {
  const record = run([card('r1'), card('r2'), card('v1')], [attempt('r1'), attempt('r2', 'fail'), attempt('v1')], { librarySnapshot: SHARED() });
  const view = buildResultView(record);
  assert.deepEqual(view.topics, topicView(record, view.cards));
  assert.deepEqual(view.topics?.rows.map(row => [row.id, row.passed, row.decided]), [['refund', 1, 2], ['delivery', 1, 1]]);
  assert.deepEqual(realityParts(view), ['С учётом частоты тем — около 70% (темы известны у 6 из 7 разговоров)']);
  assert.equal(buildResultView(run([card('r1')], [attempt('r1')])).topics, null);
});
