import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyUsage, goalAttainment, replyQuality, settingsSchema, simulatorFidelity, type Experiment, type HumanReview, type MetricAssessment, type Trial, type ValidationExclusion } from '../src/contracts.js';
import { buildResultView, NOT_MEASURED_TEXT, resultViewLines, wilson } from '../src/result-view.js';
import { NOT_MEASURED_CODES, type NotMeasuredCode } from '../src/comparison.js';
import { AGREED_RATIONALE_PREFIX, GOAL_UNSUPPORTED_RATIONALE, SPLIT_RATIONALE_PREFIX } from '../src/judge.js';
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

// ---- One test per not-measured reason: a minimal card that yields exactly that code. ----
const SPLIT = `${SPLIT_RATIONALE_PREFIX} pass / fail. Основания каждой оценки сохранены в judgeAudit.`;
const review = (trialId: string, verdict: HumanReview['verdict'], target: { metricId?: string; checkId?: string } = {}): HumanReview =>
  ({ id: `h-${trialId}-${verdict}-${target.metricId ?? target.checkId ?? 'dialogue'}`, trialId, verdict, note: 'n', createdAt: '2026-09-17T00:00:00Z', ...target });
const leak = { id: 'simulator_leak' as const, description: 'утечка', passed: false, evidence: '#2', heuristic: true };

/** One card `c` next to one decided card; returns the view and asserts `c` got exactly `code`. */
function expectReason(code: NotMeasuredCode, subject: Card, trials: Trial[], overrides: Partial<Experiment> = {}) {
  const record = run([subject, card('decided')], [...trials, attempt('decided', { goal: 'fail' })], overrides);
  const view = buildResultView(record);
  const row = view.cards.find(item => item.scenarioId === subject.id);
  assert.equal(row?.outcome, 'unknown');
  assert.equal(row?.reason, code);
  assert.equal(view.headline.decided, 1, 'the unmeasured card never enters the denominator');
  if (code !== 'in_progress') {
    assert.deepEqual(view.notMeasured.reasons, [{ code, label: NOT_MEASURED_TEXT[code], count: 1, scenarioIds: [subject.id] }]);
    assert.ok(resultViewLines(view).includes(`Не измерено: 1 — ${NOT_MEASURED_TEXT[code]}.`));
  }
  return view;
}

test('every reason code has a Russian label and the list keeps its fixed order', () => {
  assert.equal(NOT_MEASURED_CODES.length, 18);
  assert.deepEqual(Object.keys(NOT_MEASURED_TEXT), [...NOT_MEASURED_CODES]);
  assert.ok(Object.values(NOT_MEASURED_TEXT).every(label => /^[а-яё]/u.test(label)));
});

test('reason in_progress: a running phase without an attempt is pending, not unmeasured', () => {
  const view = expectReason('in_progress', card('c'), [], { phase: 'evaluating' });
  assert.equal(view.pending, 1);
  assert.equal(view.notMeasured.total, 0);
  assert.ok(resultViewLines(view).includes('Ещё проверяется: 1.'));
});

test('reason not_reached: a finished run without an attempt for the card', () => {
  expectReason('not_reached', card('c'), []);
});

test('reason stopped: a cancelled dialogue', () => {
  expectReason('stopped', card('c'), [attempt('c', { outcome: 'cancelled', reason: 'Диалог остановлен.', assessments: undefined })]);
});

test('reason turn_limit: the dialogue ran out of turns', () => {
  expectReason('turn_limit', card('c'), [attempt('c', { outcome: 'invalid', reason: 'Разговор не завершился в отведённое число реплик. Состояние внешний агент не сообщил.', assessments: undefined })]);
});

test('reason simulator_error: the simulated user failed', () => {
  expectReason('simulator_error', card('c'), [attempt('c', { outcome: 'invalid', reason: 'реплика симулированного пользователя: timeout', assessments: undefined })]);
});

test('reason agent_error: the agent or the connection failed', () => {
  expectReason('agent_error', card('c'), [attempt('c', { outcome: 'invalid', reason: 'ответ испытуемого: HTTP 500', assessments: undefined })]);
});

test('reason attempts_mismatch: the attempt belongs to another plan', () => {
  expectReason('attempts_mismatch', card('c'), [attempt('c', { manifestHash: 'other' })]);
});

test('reason judge_error: the judge answer was rejected', () => {
  expectReason('judge_error', card('c'), [attempt('c', { assessmentError: 'Judge response rejected; original responses and errors are preserved in judgeAudit' })]);
});

test('reason judge_stopped: assessment cancelled or out of budget', () => {
  expectReason('judge_stopped', card('c'), [attempt('c', { assessmentError: 'Metric assessment cancelled' })]);
  expectReason('judge_stopped', card('c'), [attempt('c', { assessmentError: 'Model call budget exhausted.' })]);
});

test('reason human_invalid: a person marked the dialogue or the goal verdict invalid', () => {
  expectReason('human_invalid', card('c'), [attempt('c')], { humanReviews: [review('t-c', 'invalid')] });
  expectReason('human_invalid', card('c'), [attempt('c', { goal: 'unknown' })], { humanReviews: [review('t-c', 'invalid', { metricId: 'goal_attainment' })] });
});

test('reason reset_unconfirmed: the agent did not confirm the external reset', () => {
  expectReason('reset_unconfirmed', card('c', { initialState: { ...world, external: { account: 'a1' } } }), [attempt('c')]);
});

test('reason simulator_deviated: a failed simulator check or a failed fidelity vote', () => {
  expectReason('simulator_deviated', card('c'), [attempt('c', { simulatorChecks: [leak] })]);
  expectReason('simulator_deviated', card('c'), [attempt('c', { fidelity: 'fail' })]);
  const overruled = buildResultView(run([card('c')], [attempt('c', { simulatorChecks: [leak] })], { humanReviews: [review('t-c', 'pass', { checkId: 'simulator_leak' })] }));
  assert.equal(overruled.cards[0]?.outcome, 'pass', 'a human overruling the check restores the verdict');
});

test('reason simulator_unclear: the fidelity vote is unknown or missing', () => {
  expectReason('simulator_unclear', card('c'), [attempt('c', { fidelity: 'unknown' })]);
  const missing = attempt('c');
  missing.assessments = missing.assessments!.filter(item => item.metricId !== 'user_fidelity');
  expectReason('simulator_unclear', card('c'), [missing]);
});

test('reason human_unknown: a person could not decide the goal', () => {
  expectReason('human_unknown', card('c'), [attempt('c', { goal: 'unknown' })], { humanReviews: [review('t-c', 'unknown', { metricId: 'goal_attainment' })] });
});

test('reason not_judged: no goal assessment, or a code-only reassessment', () => {
  const unjudged = attempt('c');
  unjudged.assessments = unjudged.assessments!.filter(item => item.metricId !== 'goal_attainment');
  expectReason('not_judged', card('c'), [unjudged]);
  expectReason('not_judged', card('c'), [attempt('c', { assessmentError: 'Только точные проверки; рубрики не переоценивались.' })]);
});

test('reason judge_split: the two goal votes disagreed', () => {
  expectReason('judge_split', card('c'), [attempt('c', { goal: 'unknown', goalRationale: SPLIT })]);
});

test('reason no_evidence: an agreed unsupported goal is not an unclear rule', () => {
  expectReason('no_evidence', card('c'), [attempt('c', { goal: 'unknown', goalRationale: `${AGREED_RATIONALE_PREFIX} ${GOAL_UNSUPPORTED_RATIONALE}` })]);
  expectReason('no_evidence', card('c'), [attempt('c', { goal: 'unknown', goalRationale: GOAL_UNSUPPORTED_RATIONALE })]);
});

test('reason judge_unclear: the goal stayed unknown for any other reason', () => {
  expectReason('judge_unclear', card('c'), [attempt('c', { goal: 'unknown', goalRationale: `${AGREED_RATIONALE_PREFIX} Условие не проверялось.` })]);
});

test('reason agent_error also names a legacy card without the goal rubric', () => {
  expectReason('agent_error', card('c', { metrics: [{ ...replyQuality }] }), [attempt('c', { outcome: 'invalid', reason: 'открытие сессии с испытуемым: ECONNREFUSED', assessments: undefined })]);
});

test('reason simulator_deviated wins over judge_split on the same card', () => {
  expectReason('simulator_deviated', card('c'), [attempt('c', { fidelity: 'fail', goal: 'unknown', goalRationale: SPLIT })]);
});

test('reasons with equal counts keep the fixed order and the line names the earlier one', () => {
  const record = run([card('split'), card('unclear'), card('decided')], [
    attempt('split', { goal: 'unknown', goalRationale: SPLIT }), attempt('unclear', { fidelity: 'unknown' }), attempt('decided', { goal: 'pass' }),
  ]);
  const view = buildResultView(record);
  assert.deepEqual(view.notMeasured.reasons.map(reason => reason.code), ['simulator_unclear', 'judge_split']);
  assert.ok(resultViewLines(view).includes('Не измерено: 2 — чаще всего судья не уверен, что симулятор держался диалога (1).'));
});
