import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyUsage, goalAttainment, replyQuality, settingsSchema, simulatorFidelity, type Experiment, type MetricAssessment, type Scenario, type Trial, type ValidationExclusion } from '../src/contracts.js';
import { buildResultView, resultViewLines, wilson } from '../src/result-view.js';
import { SPLIT_RATIONALE_PREFIX } from '../src/judge.js';
import { ExperimentStore } from '../src/store.js';

const world = { records: {}, writableFields: [], transientFailures: 0 };
type Card = Experiment['scenarios'][number];
type Result = MetricAssessment['result'];

function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id, familyId: id, title: `Ситуация ${id}`, requirementIds: [], provenance: 'production', tier: 'regression', goalObservation: 'reply',
    user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 3 }, initialState: world, checks: [],
    metrics: [{ ...goalAttainment }, { ...replyQuality }, { ...simulatorFidelity }], split: 'dev', ...overrides,
  };
}
const vote = (metricId: string, result: Result, rationale = 'Обоснование.'): MetricAssessment =>
  ({ metricId, result, rationale, evidence: result === 'unknown' ? [] : [1] });

/** opening → reply → the simulator ends the dialogue; one reactive attempt per card. */
function attempt(scenarioId: string, options: { goal?: Result; goalRationale?: string; fidelity?: Result; fidelityRationale?: string } & Partial<Trial> = {}): Trial {
  const { goal = 'pass', goalRationale, fidelity = 'pass', fidelityRationale, ...overrides } = options;
  return {
    id: `t-${scenarioId}`, revisionId: 'rev', scenarioId, familyId: scenarioId, repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: 'h',
    outcome: 'ungraded', reason: 'Диалог дошёл до конца.', checks: [],
    events: [
      { seq: 0, type: 'user', text: 'Здравствуйте' },
      { seq: 1, type: 'assistant', text: 'Ответ агента' },
      { seq: 2, type: 'simulator', result: { message: '', done: true } },
    ],
    initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 1,
    assessments: [vote('goal_attainment', goal, goalRationale), vote('reply_quality', 'pass'), vote('user_fidelity', fidelity, fidelityRationale)],
    ...overrides,
  };
}

function run(cards: Card[], trials: Trial[], overrides: Partial<Experiment> = {}): Experiment {
  return {
    schemaVersion: '1', id: 'run-1', task: 't', mode: 'live', workflow: 'evaluate', createdAt: 'now', updatedAt: 'now', phase: 'results_review', message: '',
    sources: [], settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }),
    target: { kind: 'command', command: 'python3', args: ['agent.py'], timeoutMs: 60000 },
    requirements: [], questions: [], goldenCases: [], dialogues: [], profiles: [], notes: '', scenarios: cards, revisions: [], selectedRevisionId: null,
    manifestHash: 'h', reviewedAt: null, reviewMode: 'human', controlConsumedAt: null, acceptedTests: [], trials, comparisons: [], iterations: [],
    usage: emptyUsage(), error: null, limitations: [], humanReviews: [], ...overrides,
  };
}
/** passed + failed decided cards, plus unmeasured cards with a split goal vote. */
function scored(passed: number, failed: number, unmeasured = 0): Experiment {
  const cards: Card[] = [];
  const trials: Trial[] = [];
  const add = (id: string, options: Parameters<typeof attempt>[1]) => { cards.push(card(id)); trials.push(attempt(id, options)); };
  for (let i = 0; i < passed; i++) add(`p${i}`, { goal: 'pass' });
  for (let i = 0; i < failed; i++) add(`f${i}`, { goal: 'fail' });
  for (let i = 0; i < unmeasured; i++) add(`u${i}`, { goal: 'unknown', goalRationale: `${SPLIT_RATIONALE_PREFIX} pass / fail. Основания каждой оценки сохранены в judgeAudit.` });
  return run(cards, trials);
}

/** The stored acquiring run fae4ee59 in counts only: 9 failed goals, 2 fidelity fails, 1 fidelity unknown, 1 split goal, 27 exclusions. */
function acquiringShape(): Experiment {
  const cards: Card[] = [];
  const trials: Trial[] = [];
  const add = (id: string, options: Parameters<typeof attempt>[1]) => { cards.push(card(id)); trials.push(attempt(id, options)); };
  for (let i = 0; i < 9; i++) add(`fail${i}`, { goal: 'fail' });
  add('deviated0', { goal: 'fail', fidelity: 'fail' });
  add('deviated1', { goal: 'pass', fidelity: 'fail' });
  add('unclear0', { goal: 'fail', fidelity: 'unknown', fidelityRationale: `${SPLIT_RATIONALE_PREFIX} pass / fail. Основания каждой оценки сохранены в judgeAudit.` });
  add('split0', { goal: 'unknown', goalRationale: `${SPLIT_RATIONALE_PREFIX} pass / unknown. Основания каждой оценки сохранены в judgeAudit.` });
  const exclusions: ValidationExclusion[] = [
    ...Array.from({ length: 21 }, (_, i) => ({ dialogueId: `x${i}`, kind: 'unconfirmed' as const, reason: 'модельный текст' })),
    ...Array.from({ length: 6 }, (_, i) => ({ dialogueId: `c${i}`, kind: 'customer_data' as const, reason: 'модельный текст' })),
  ];
  const dialogues = cards.map(item => ({ id: item.id, messages: [{ role: 'user' as const, content: 'реплика' }], outcome: 'unknown' as const }));
  return run(cards, trials, { dialogues, validationExclusions: exclusions });
}
const ACQUIRING_BLOCK = [
  'Справился в 0 из 9 проверенных ситуаций — 0%.',
  'Мало данных: реальная доля где-то от 0% до 30%.',
  'Не измерено: 4 — чаще всего симулятор отклонился от диалога (2).',
  'Контроль: не задан.',
  'Из 40 диалогов в набор вошли 13. Не вошли 27: в правилах нет ожидаемого ответа — 21, нужны данные клиента — 6.',
];

test('the headline names passed over decided situations and the Wilson caveat for a small sample', () => {
  const view = buildResultView(scored(3, 9));
  assert.equal(view.headline.text, 'Справился в 3 из 12 проверенных ситуаций — 25%.');
  assert.equal(view.headline.smallSample, 'Мало данных: реальная доля где-то от 9% до 53%.');
  assert.deepEqual(resultViewLines(view).slice(0, 2), [view.headline.text, view.headline.smallSample]);
  assert.equal(view.countingRules, 'goal-v1');
  assert.equal(buildResultView(scored(1, 0)).headline.text, 'Справился в 1 из 1 проверенной ситуации — 100%.');
});

test('wilson matches the verified 95% vectors and is null without decided situations', () => {
  const vectors: [number, number, number, number][] = [
    [0, 9, 0, 30], [1, 8, 2, 47], [3, 12, 9, 53], [0, 1, 0, 79], [1, 1, 21, 100], [12, 12, 76, 100],
    [5, 19, 12, 49], [9, 10, 60, 98], [0, 13, 0, 23], [1, 14, 1, 31], [20, 20, 84, 100],
  ];
  for (const [passed, decided, lo, hi] of vectors) {
    const range = wilson(passed, decided);
    assert.ok(range, `${passed}/${decided}`);
    assert.deepEqual(range.map(x => Math.round(x * 100)), [lo, hi], `${passed}/${decided}`);
    assert.ok(range[0] >= 0 && range[1] <= 1);
  }
  assert.equal(wilson(0, 0), null);
});

test('19 decided situations carry the caveat, 20 show the percent without it', () => {
  const nineteen = buildResultView(scored(5, 14));
  assert.equal(nineteen.headline.decided, 19);
  assert.match(nineteen.headline.smallSample ?? '', /^Мало данных: /);
  const twenty = buildResultView(scored(10, 10));
  assert.equal(twenty.headline.text, 'Справился в 10 из 20 проверенных ситуаций — 50%.');
  assert.equal(twenty.headline.smallSample, null);
  assert.ok(twenty.headline.range, 'the range stays on the view for other surfaces');
  assert.ok(resultViewLines(twenty).every(line => !line.startsWith('Мало данных')));
});

test('no decided situation shows no percent, and the reason sits in the not-measured line', () => {
  const view = buildResultView(scored(0, 0, 2));
  assert.equal(view.headline.text, 'Проверенных ситуаций нет.');
  assert.equal(view.headline.accuracy, null);
  assert.equal(view.headline.range, null);
  const lines = resultViewLines(view);
  assert.deepEqual(lines, ['Проверенных ситуаций нет.', 'Не измерено: 2 — судья не уверен: голоса разошлись.', 'Контроль: не задан.']);
  assert.ok(lines.every(line => !line.includes('%')));
});

test('a draft that never ran says so and lists nothing as unmeasured', () => {
  const draft = run([card('a'), card('b')], [], { phase: 'review' });
  const view = buildResultView(draft);
  assert.equal(view.headline.text, 'Прогон ещё не запускался.');
  assert.equal(view.notMeasured.total, 0);
  assert.equal(view.pending, 0);
  assert.deepEqual(resultViewLines(view), ['Прогон ещё не запускался.', 'Контроль: не задан.']);
});

test('the acquiring-shaped run gives exactly the first block promised for fae4ee59', () => {
  const view = buildResultView(acquiringShape());
  assert.deepEqual(resultViewLines(view), ACQUIRING_BLOCK);
  assert.deepEqual(view.notMeasured.reasons.map(reason => [reason.code, reason.count]),
    [['simulator_deviated', 2], ['simulator_unclear', 1], ['judge_split', 1]]);
  assert.deepEqual(view.coverage, { examined: 40, included: 13, text: ACQUIRING_BLOCK[4],
    excluded: [{ kind: 'unconfirmed', label: 'в правилах нет ожидаемого ответа', count: 21 }, { kind: 'customer_data', label: 'нужны данные клиента', count: 6 }] });
  assert.deepEqual(resultViewLines(view, { details: true }), [...ACQUIRING_BLOCK, 'Не измерено по причинам:',
    '  симулятор отклонился от диалога — 2', '  судья не уверен, что симулятор держался диалога — 1', '  судья не уверен: голоса разошлись — 1']);
  assert.ok(resultViewLines(view, { details: true }).every(line => !line.includes('модельный текст')), 'model-written exclusion reasons never reach the block');
  assert.equal(view.scope.cards, 13);
  assert.equal(view.scope.dialogues, 13);
});

test('CLI summary prints the ResultView block first, from the built dist', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-result-view-'));
  try {
    const record = acquiringShape();
    const store = new ExperimentStore(directory);
    await store.init();
    try { await store.save(record); } finally { await store.close(); }
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'summary', '--id', record.id, '--data-dir', directory]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    const lines = stdout.split('\n');
    const block = lines.slice(0, lines.indexOf(''));
    assert.deepEqual(block, resultViewLines(buildResultView(record), { details: true }));
    assert.equal(block[0], ACQUIRING_BLOCK[0]);
    assert.ok(lines.includes('Подробности:'));
    assert.ok(!stdout.includes('Бизнес-цель достигнута'), 'the old headline with another denominator is gone');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
