import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyUsage, goalAttainment, replyQuality, settingsSchema, simulatorFidelity, type Experiment, type HumanReview, type JudgeAudit, type MetricAssessment, type Trial, type ValidationExclusion } from '../src/contracts.js';
import { allFailuresPointer, allFailuresTitle, buildResultView, causeSection, failureListRows, NOT_MEASURED_TEXT, resultViewLines, resultViewRows, SECTION_TEXT, unmeasuredControl, wilson } from '../src/result-view.js';
import { rowsToLines } from '../src/explain.js';
import { compareRuns, NOT_MEASURED_CODES, stabilityBetweenRuns, type NotMeasuredCode } from '../src/comparison.js';
import { AGREED_RATIONALE_PREFIX, GOAL_UNSUPPORTED_RATIONALE, SPLIT_RATIONALE_PREFIX } from '../src/judge.js';
import { ExperimentStore } from '../src/store.js';
import { ExperimentLab } from '../src/experiment.js';
import { embeddedBefore, evidenceBundle } from '../src/artifacts.js';
import { sealJudgeReceipt } from '../src/judge.js';
import { sourceIdentity } from '../src/normalize.js';

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
  '  ? Ситуация deviated0 — симулятор отклонился от диалога',
  '  ? Ситуация deviated1 — симулятор отклонился от диалога',
  '  ? Ситуация unclear0 — судья не уверен, что симулятор держался диалога',
  '  ? Ситуация split0 — судья не уверен: голоса разошлись',
  'Контроль: не задан.',
  // The acquiring run has 11 failed goals queued for review and one passed goal in the sample,
  // so the agreement row is printed even before the first mark (F6).
  'Согласие с судьёй: ещё не проверено.',
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
  assert.deepEqual(lines, ['Проверенных ситуаций нет.', 'Не измерено: 2 — судья не уверен: голоса разошлись.',
    '  ? Ситуация u0 — судья не уверен: голоса разошлись', '  ? Ситуация u1 — судья не уверен: голоса разошлись', 'Контроль: не задан.']);
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
  assert.deepEqual(view.coverage, { examined: 40, included: 13, text: ACQUIRING_BLOCK.at(-1),
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

/**
 * One quick mark on the failed situation `t-fail0` of a freshly stored acquiring run, written
 * through the lab (which stamps the judgment it answers), then read back out of the spawned CLI.
 * Each call uses its own store, so the three marks below never see one another.
 */
async function quickMarked(verdict: HumanReview['verdict'], note: string): Promise<{ block: string[]; stored: Experiment }> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-agreement-'));
  try {
    const record = acquiringShape();
    const store = new ExperimentStore(directory);
    await store.init();
    try { await store.save(record); } finally { await store.close(); }
    // The lab holds the writer lock, so it is opened and closed around the mark alone.
    const lab = new ExperimentLab(directory);
    await lab.init();
    try {
      await lab.addHumanReview(record.id, { trialId: 't-fail0', metricId: 'goal_attainment', source: 'quick',
        verdict, judgeVerdict: 'fail', note, durationMs: 1200 });
    } finally { await lab.close(); }
    const reader = new ExperimentStore(directory);
    await reader.init();
    let stored: Experiment;
    try { stored = await reader.get(record.id); } finally { await reader.close(); }
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'summary', '--id', record.id, '--data-dir', directory]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    const lines = stdout.split('\n');
    return { block: lines.slice(0, lines.indexOf('')), stored };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('a quick mark saved by the lab shows as the agreement row in the CLI summary', { timeout: 20000 }, async () => {
  const { block, stored } = await quickMarked('fail', 'Быстрая отметка: согласен с судьёй.');
  assert.equal(block[0], ACQUIRING_BLOCK[0], 'agreeing with the judge leaves the number where it was');
  assert.ok(block.includes('Согласие с судьёй: 1 из 1 проверенных · мало проверок (провалы: 1 из 1 · успехи ещё не проверены).'), block.join('\n'));
  assert.ok(block.includes('  Цель — согласие в 9 случаях из 10.'), block.join('\n'));
  assert.deepEqual(block, resultViewLines(buildResultView(stored), { details: true }));
  const view = buildResultView(stored);
  assert.equal(view.agreement.queueFailures.length, 11, '9 failed goals plus the unmeasured deviated0 and unclear0');
  assert.deepEqual(view.agreement.sampledPasses, ['t-deviated1'], 'the single recorded pass is the whole sample');
});

test('a quick «не согласен» moves the headline and is counted against the judge', { timeout: 20000 }, async () => {
  const { block, stored } = await quickMarked('pass', 'Проверка: судья не учёл уточнение клиента.');
  assert.equal(block[0], 'Справился в 1 из 9 проверенных ситуаций — 11%.');
  assert.ok(block.includes('Согласие с судьёй: 0 из 1 проверенных · мало проверок (провалы: 0 из 1 · успехи ещё не проверены).'), block.join('\n'));
  assert.deepEqual(block, resultViewLines(buildResultView(stored), { details: true }));
  const view = buildResultView(stored);
  assert.equal(view.agreement.failures.checked, 1);
  assert.equal(view.agreement.failures.agreed, 0);
  assert.deepEqual(view.agreement.disagreements.map(item => item.trialId), ['t-fail0']);
});

test('a quick «не могу сказать» leaves the judge failure in the number and only counts itself', { timeout: 20000 }, async () => {
  const { block, stored } = await quickMarked('unknown', 'Быстрая отметка: не могу сказать.');
  assert.equal(block[0], ACQUIRING_BLOCK[0], 'the owner’s doubt does not remove a failure from the number');
  // The whole first block is the untouched acquiring block plus the one tail row the mark earns.
  assert.deepEqual(resultViewLines(buildResultView(stored)),
    [...ACQUIRING_BLOCK.slice(0, -1), '  Человек не смог решить: 1.', ACQUIRING_BLOCK.at(-1)!]);
  assert.ok(block.includes('Согласие с судьёй: ещё не проверено.'), block.join('\n'));
  assert.ok(block.includes('  Человек не смог решить: 1.'), block.join('\n'));
  assert.ok(!block.some(line => line.includes('человек не смог решить')), 'the card keeps the judge verdict, so it has no such reason');
  assert.deepEqual(block, resultViewLines(buildResultView(stored), { details: true }));
  const view = buildResultView(stored);
  assert.equal(view.agreement.unsure, 1);
  assert.equal(view.agreement.checked, 0, 'doubt is not a check');
  assert.deepEqual(view.agreement.disagreements, []);
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

test('reason not_judged: without any judgment the missing fidelity vote is not «judge unsure»', () => {
  // A live code-only reassessment keeps no assessments at all; the judge never ran.
  expectReason('not_judged', card('c'), [attempt('c', { assessmentError: 'Только точные проверки; рубрики не переоценивались.', assessments: undefined })]);
  expectReason('not_judged', card('c'), [attempt('c', { assessments: undefined })]);
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

// ---- Stability: found flips against the source run, never a promise of the same result. ----
const SOURCE_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
/** The source run and its repeat of the same cards; `after` lists each card's goal on the repeat. */
function repeatPair(before: Record<string, Result>, after: Record<string, Result>, overrides: { before?: Partial<Experiment>; after?: Partial<Experiment> } = {}) {
  const make = (goals: Record<string, Result>, extra: Partial<Experiment>) => run(Object.keys(goals).map(id => card(id)),
    Object.entries(goals).map(([id, goal]) => attempt(id, goal === 'unknown' ? { goal, goalRationale: SPLIT } : { goal })),
    { mode: 'demo', targetFingerprint: 'fp-agent', ...extra });
  return {
    source: make(before, { id: SOURCE_ID, ...overrides.before }),
    repeat: make(after, { id: 'b1b2c3d4-0000-4000-8000-000000000002', parentRunId: SOURCE_ID, ...overrides.after }),
  };
}

test('a repeat counts situations whose goal verdict flipped, and they stay in the headline', () => {
  const { source, repeat } = repeatPair({ A: 'pass', B: 'fail' }, { A: 'fail', B: 'fail' });
  const view = buildResultView(repeat, { before: source });
  assert.equal(view.stability?.basis, 'repeat');
  assert.equal(view.stability?.checked, 2);
  assert.deepEqual(view.stability?.unstable, [{ scenarioId: 'A', title: 'Ситуация A', before: 'pass', after: 'fail' }]);
  assert.equal(view.cards.find(item => item.scenarioId === 'A')?.unstable, true);
  assert.equal(view.cards.find(item => item.scenarioId === 'B')?.unstable, false);
  assert.equal(view.headline.text, 'Справился в 0 из 2 проверенных ситуаций — 0%.');
  const lines = resultViewLines(view);
  assert.deepEqual(lines.slice(0, 3), [view.headline.text, view.headline.smallSample, 'Нестабильных: 1 (повтор прогона a1b2c3d4).']);
  assert.ok(resultViewLines(view, { details: true }).includes('  нестабильно: Ситуация A — было «справился», стало «не справился»'));
  assert.ok(lines.every(line => !line.startsWith('  нестабильно')), 'the per-card lines are details only');
  assert.equal(buildResultView(repeat).stability, undefined, 'no source run, no stability line');
  assert.ok(resultViewLines(buildResultView(repeat)).every(line => !/Нестабильных|Стабильность/.test(line)));
});

test('a flip between a decided verdict and unknown is not instability', () => {
  const { source, repeat } = repeatPair({ A: 'pass', B: 'fail', C: 'unknown' }, { A: 'unknown', B: 'fail', C: 'pass' });
  const view = buildResultView(repeat, { before: source });
  assert.equal(view.stability?.checked, 1);
  assert.deepEqual(view.stability?.unstable, []);
  assert.ok(resultViewLines(view).includes('Нестабильных: 0 (повтор прогона a1b2c3d4).'));
  assert.ok(view.cards.every(item => !item.unstable));
});

test('a changed agent or an incomparable pair is said in words, not counted as instability', () => {
  const agent = repeatPair({ A: 'pass' }, { A: 'fail' }, { after: { targetFingerprint: 'fp-other' } });
  const changed = buildResultView(agent.repeat, { before: agent.source });
  assert.deepEqual(changed.stability, { basis: 'repeat', comparedWith: SOURCE_ID, checked: 0, unstable: [], skipped: 'агент изменился между прогонами' });
  assert.ok(resultViewLines(changed).includes('Стабильность не проверена: агент изменился между прогонами.'));
  assert.ok(changed.cards.every(item => !item.unstable));
  const version = repeatPair({ A: 'pass' }, { A: 'fail' }, { before: { targetVersion: 'v1' }, after: { targetVersion: 'v2' } });
  assert.equal(buildResultView(version.repeat, { before: version.source }).stability?.skipped, 'агент изменился между прогонами');
  const judge = repeatPair({ A: 'pass' }, { A: 'fail' }, { after: { evaluatorVersion: 'judge-2' } });
  const incomparable = buildResultView(judge.repeat, { before: judge.source });
  assert.equal(incomparable.stability?.skipped, 'прогоны несравнимы');
  assert.ok(resultViewLines(incomparable).includes('Стабильность не проверена: прогоны несравнимы.'));
});

test('a source rebuilt from embedded evidence is compared through its embedded identity, never with the current run', () => {
  // A saved suite loaded against a new agent version while the original run is missing.
  const version = repeatPair({ A: 'pass' }, { A: 'fail' }, { before: { targetVersion: 'v1' }, after: { targetVersion: 'v2' } });
  const legacy: Experiment = { ...version.repeat, sourceEvidence: { runId: SOURCE_ID, trials: structuredClone(version.source.trials), humanReviews: [] } };
  const unavailable = buildResultView(legacy, { before: embeddedBefore(legacy, SOURCE_ID) });
  assert.deepEqual(unavailable.stability, { basis: 'repeat', comparedWith: SOURCE_ID, checked: 0, unstable: [], skipped: 'исходный прогон недоступен' });
  assert.ok(resultViewLines(unavailable).includes('Стабильность не проверена: исходный прогон недоступен.'));
  assert.ok(unavailable.cards.every(item => !item.unstable));
  const known: Experiment = { ...legacy, sourceEvidence: { ...legacy.sourceEvidence!, identity: sourceIdentity(version.source, ['A']) } };
  assert.equal(buildResultView(known, { before: embeddedBefore(known, SOURCE_ID) }).stability?.skipped, 'агент изменился между прогонами');
  // Another agent definition is another agent too.
  const agent = { instructions: 'Отвечай кратко.', tools: [] } as unknown as Experiment['revisions'][number]['spec'];
  const revised: Experiment = { ...known, targetVersion: 'v1', revisions: [{ id: 'r2', parentId: null, spec: { ...agent, instructions: 'Иначе.' }, hypothesis: '', createdAt: 'now' }],
    sourceEvidence: { ...known.sourceEvidence!, identity: sourceIdentity({ ...version.source, revisions: [{ id: 'r1', parentId: null, spec: agent, hypothesis: '', createdAt: 'now' }] }, ['A']) } };
  assert.equal(buildResultView(revised, { before: embeddedBefore(revised, SOURCE_ID) }).stability?.skipped, 'агент изменился между прогонами');
  // The same agent: the flip is found against the embedded attempts.
  const same = repeatPair({ A: 'pass', B: 'fail' }, { A: 'fail', B: 'fail' });
  const portable: Experiment = { ...same.repeat, sourceEvidence: { runId: SOURCE_ID, trials: structuredClone(same.source.trials), humanReviews: [], identity: sourceIdentity(same.source, ['A', 'B']) } };
  const found = buildResultView(portable, { before: embeddedBefore(portable, SOURCE_ID) });
  assert.deepEqual(found.stability, buildResultView(same.repeat, { before: same.source }).stability);
});

test('a card edited after load-suite is neither unstable nor fixed/regressed against a rebuilt source', () => {
  const same = repeatPair({ A: 'pass', B: 'fail' }, { A: 'fail', B: 'fail' });
  const edited: Experiment = { ...structuredClone(same.repeat), sourceEvidence: { runId: SOURCE_ID, trials: structuredClone(same.source.trials), humanReviews: [],
    identity: sourceIdentity(same.source, ['A', 'B']) } };
  edited.scenarios[0]!.metrics = edited.scenarios[0]!.metrics!.map(metric => metric.id === 'goal_attainment' ? { ...metric, passCriteria: 'Другое условие.' } : metric);
  const rebuilt = embeddedBefore(edited, SOURCE_ID)!;
  const view = buildResultView(edited, { before: rebuilt });
  assert.ok(view.cards.every(item => !item.unstable), JSON.stringify(view.stability));
  assert.deepEqual(view.stability, buildResultView(edited, { before: same.source }).stability, 'the same answer as with the stored source');
  const diff = compareRuns(rebuilt, edited);
  assert.ok(diff.notes.some(note => note.startsWith('Содержимое карточек изменилось')), JSON.stringify(diff.notes));
  assert.deepEqual([diff.fixed, diff.regressed], [[], []]);
  // Against the stored source the edited card is not counted either.
  assert.equal(stabilityBetweenRuns({ ...same.source }, edited).unstable.length, 0);
});

test('CLI summary of a repeat names the flips against the stored source run, from the built dist', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-stability-'));
  try {
    const { source, repeat } = repeatPair({ A: 'pass', B: 'fail' }, { A: 'fail', B: 'fail' });
    const store = new ExperimentStore(directory);
    await store.init();
    try { await store.save(source); await store.save(repeat); } finally { await store.close(); }
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'summary', '--id', repeat.id, '--data-dir', directory]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    const lines = stdout.split('\n');
    assert.deepEqual(lines.slice(0, lines.indexOf('')), resultViewLines(buildResultView(repeat, { before: source }), { details: true }));
    assert.ok(lines.includes('Нестабильных: 1 (повтор прогона a1b2c3d4).'));
    assert.ok(lines.includes('  нестабильно: Ситуация A — было «справился», стало «не справился»'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI summary says why the source run was not read and never swaps a corrupt source for the embedded copy', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-stability-'));
  try {
    const { source, repeat } = repeatPair({ A: 'pass' }, { A: 'fail' });
    const portable: Experiment = { ...repeat, sourceEvidence: { runId: SOURCE_ID, trials: structuredClone(source.trials), humanReviews: [], identity: sourceIdentity(source, ['A']) } };
    const store = new ExperimentStore(directory);
    await store.init();
    try { await store.save(portable); } finally { await store.close(); }
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const summary = async () => {
      const child = spawn(process.execPath, [cli, 'summary', '--id', portable.id, '--data-dir', directory]);
      let stdout = ''; let stderr = '';
      child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      const code = await new Promise<number | null>(resolve => child.on('close', resolve));
      assert.equal(code, 0, stderr);
      return stdout;
    };
    // Missing: the embedded copy is used and the reader is told so.
    const missing = await summary();
    assert.match(missing, /Нестабильных: 1/);
    assert.match(missing, /Внимание: Базовый прогон a1b2c3d4-0000-4000-8000-000000000001 не найден/);
    // Corrupt: no fallback, the reason is named.
    await writeFile(join(directory, `${SOURCE_ID}.json`), '{ not json', { mode: 0o600 });
    const corrupt = await summary();
    assert.doesNotMatch(corrupt, /Нестабильных|Стабильность/);
    assert.match(corrupt, /Внимание: Исходный прогон a1b2c3d4-0000-4000-8000-000000000001 не удалось прочитать/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI summary checks receipts against sidecars like the Pi bundle does', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-stability-'));
  try {
    const { source, repeat } = repeatPair({ A: 'pass', B: 'fail' }, { A: 'fail', B: 'fail' }, { before: { mode: 'live' }, after: { mode: 'live' } });
    const audit = (raw: string): JudgeAudit => ({ protocolHash: 'p', inputHash: 'i', provider: 'offline', model: 'judge', prompt: 'p', input: '{}',
      attempts: [{ startedAt: 'now', raw }], notApplicable: [] });
    for (const item of repeat.trials) item.judgeReceipt = sealJudgeReceipt(audit(`sealed ${item.id}`), true);
    const store = new ExperimentStore(directory);
    await store.init();
    try {
      await store.save(source); await store.save(repeat);
      for (const item of repeat.trials) store.writeJudgeAudit(repeat.id, item.id, audit(`edited ${item.id}`));
    } finally { await store.close(); }
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'summary', '--id', repeat.id, '--data-dir', directory]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Внимание: Прогон b1b2c3d4-0000-4000-8000-000000000002: квитанция судьи не совпала с файлом полной оценки у 2 попыток/);
    const bundle = await evidenceBundle(repeat, new ExperimentStore(directory));
    const lines = stdout.split('\n');
    assert.deepEqual(lines.slice(0, resultViewLines(bundle.view!, { details: true }).length), resultViewLines(bundle.view!, { details: true }));
    assert.ok(bundle.warnings.some(warning => lines.includes(`Внимание: ${warning}`)), 'the same warning on both surfaces');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** A reassessment of the source run's saved answers: same trial ids, a new manifest, the source embedded. */
function reassessPair(before: Record<string, Result>, after: Record<string, Result>, overrides: Partial<Experiment> = {}) {
  const { source } = repeatPair(before, before);
  const { repeat } = repeatPair(after, after);
  const record: Experiment = { ...repeat, manifestHash: 'h2', trials: repeat.trials.map(item => ({ ...item, manifestHash: 'h2' })),
    assessmentOf: SOURCE_ID, assessmentTrialIds: source.trials.map(item => item.id), evidenceHash: 'evidence',
    sourceEvidence: { runId: SOURCE_ID, trials: structuredClone(source.trials), humanReviews: [] }, ...overrides };
  return { source, record };
}

test('a reassessment names the situations whose judge verdict flipped on the same answers', () => {
  const { source, record } = reassessPair({ A: 'fail', B: 'pass' }, { A: 'pass', B: 'pass' });
  const view = buildResultView(record, { before: source });
  assert.equal(view.stability?.basis, 'reassess');
  assert.equal(view.cards.find(item => item.scenarioId === 'A')?.unstable, true);
  assert.equal(view.headline.text, 'Справился в 2 из 2 проверенных ситуаций — 100%.');
  const lines = resultViewLines(view, { details: true });
  assert.ok(lines.includes('Нестабильных: 1 (переоценка прогона a1b2c3d4).'));
  assert.ok(lines.includes('  нестабильно: Ситуация A — было «не справился», стало «справился»'));
});

test('a reassessment by another judge, or without evidence, prints no instability count', () => {
  const judge = reassessPair({ A: 'fail' }, { A: 'pass' }, { settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1, judge: { provider: 'openrouter', model: 'another-judge' } }) });
  const view = buildResultView(judge.record, { before: judge.source });
  assert.ok(resultViewLines(view).includes('Стабильность не проверена: судья или его настройки изменились.'));
  assert.ok(view.cards.every(item => !item.unstable));
  const bare = reassessPair({ A: 'fail' }, { A: 'pass' });
  delete bare.record.evidenceHash;
  const plain = buildResultView(bare.record, { before: bare.source });
  assert.equal(plain.stability, undefined);
  assert.ok(resultViewLines(plain).every(line => !/Нестабильных|Стабильность/.test(line)));
});

const CONTROL_WARNING = 'Контроль не пройден — числу пока не верить: проверьте судью и связь с агентом.';
const CONTROL_UNMEASURED_WARNING = 'Контроль не измерен — числу пока не верить: проверьте судью и связь с агентом.';
/** 13 cards: `ctl` is the positive control, the other 12 are 3 passed and 9 failed. */
function withControl(control: Parameters<typeof attempt>[1], cardOverrides: Partial<Card> = {}, ids = ['ctl']): Experiment {
  const record = scored(3, 9);
  record.scenarios.push(card('ctl', cardOverrides));
  record.trials.push(attempt('ctl', control));
  record.positiveControlScenarioIds = ids;
  return record;
}

test('a passing control stays out of the headline and gets its own line', () => {
  const view = buildResultView(withControl({ goal: 'pass' }));
  assert.equal(view.headline.text, 'Справился в 3 из 12 проверенных ситуаций — 25%.');
  assert.equal(view.control.warning, null);
  assert.equal(view.cards.find(item => item.scenarioId === 'ctl')?.control, true);
  assert.deepEqual(resultViewLines(view), [
    'Справился в 3 из 12 проверенных ситуаций — 25%.',
    'Мало данных: реальная доля где-то от 9% до 53%.',
    'Контроль: пройден ✓',
    // Deliberate change: the 9 failures and the 3 sampled passes are a review queue, so F6 is printed.
    'Согласие с судьёй: ещё не проверено.',
  ]);
});

test('a failed control puts the warning on the first line', () => {
  const view = buildResultView(withControl({ goal: 'fail' }));
  const lines = resultViewLines(view);
  assert.equal(lines[0], CONTROL_WARNING);
  assert.equal(lines[1], 'Справился в 3 из 12 проверенных ситуаций — 25%.');
  assert.ok(lines.includes('Контроль: не пройден ✗'));
  // The warning keeps its own role and the number keeps `lead`: the alarm is never rendered as
  // plain text, and the one number the product exists to show is never muted under it.
  const rows = resultViewRows(view);
  assert.deepEqual(rows.slice(0, 2).map(row => row.role), ['alarm', 'lead']);
  assert.equal(rows.find(row => row.role === 'lead')!.text, view.headline.text);
  assert.equal(rows.filter(row => row.role === 'lead').length, 1);
});

test('without a control warning the number is still the only lead row', () => {
  const rows = resultViewRows(buildResultView(scored(3, 9)));
  assert.equal(rows[0]!.role, 'lead');
  assert.equal(rows.filter(row => row.role === 'alarm').length, 0);
  assert.equal(rows.filter(row => row.role === 'lead').length, 1);
});

test('an unmeasured control is named with its reason, warned about and not counted as unmeasured', () => {
  const view = buildResultView(withControl({ goal: 'unknown', goalRationale: `${SPLIT_RATIONALE_PREFIX} pass / fail. Основания каждой оценки сохранены в judgeAudit.` }));
  const lines = resultViewLines(view);
  assert.equal(lines[0], CONTROL_UNMEASURED_WARNING, 'the warning and the control line use the same word');
  assert.ok(lines.includes('Контроль: не измерен — судья не уверен: голоса разошлись.'));
  assert.equal(view.notMeasured.total, 0);
  assert.equal(view.headline.decided, 12);
});

test('a control still running is not a failure and is not pending in the headline', () => {
  const record = withControl({ goal: 'pass' });
  record.phase = 'evaluating';
  record.trials = record.trials.filter(item => item.scenarioId !== 'ctl');
  const view = buildResultView(record);
  assert.equal(view.control.warning, null);
  assert.equal(view.pending, 0);
  assert.ok(resultViewLines(view).includes('Контроль: ещё не проверен.'));
});

test('a synthetic control is labelled, and several controls are counted on their own line', () => {
  const synthetic = buildResultView(withControl({ goal: 'pass' }, { provenance: 'synthetic' }));
  assert.ok(resultViewLines(synthetic).includes('Контроль: пройден ✓ · синтетическая ситуация'));
  const record = withControl({ goal: 'fail' });
  record.positiveControlScenarioIds = ['ctl', 'p0'];
  const mixed = buildResultView(record);
  assert.equal(mixed.headline.text, 'Справился в 2 из 11 проверенных ситуаций — 18%.');
  assert.ok(resultViewLines(mixed).includes('Контроль: пройдено 1 из 2.'));
  record.positiveControlScenarioIds = ['p0', 'p1'];
  assert.ok(resultViewLines(buildResultView(record)).includes('Контроль: пройдено 2 из 2 ✓'));
  // One failed and one unmeasured control: the warning names both.
  record.positiveControlScenarioIds = ['ctl', 'p0'];
  const p0 = record.trials.find(item => item.scenarioId === 'p0')!;
  p0.assessments = p0.assessments!.map(item => item.metricId === 'goal_attainment' ? { ...item, result: 'unknown' as const, evidence: [], rationale: SPLIT } : item);
  assert.equal(resultViewLines(buildResultView(record))[0], 'Контроль не пройден или не измерен — числу пока не верить: проверьте судью и связь с агентом.');
});

test('the control alarm and the control line read one predicate, so they never contradict each other', () => {
  // A control that is `unknown` with no recorded reason is still being decided. The line calls it
  // «ещё не проверен», so the row above it must not shout «не измерен» about the same card.
  assert.equal(unmeasuredControl({ outcome: 'unknown' }), false);
  assert.equal(unmeasuredControl({ outcome: 'unknown', reason: 'in_progress' }), false);
  assert.equal(unmeasuredControl({ outcome: 'pass' }), false);
  assert.equal(unmeasuredControl({ outcome: 'fail' }), false);
  for (const reason of NOT_MEASURED_CODES.filter(code => code !== 'in_progress')) {
    assert.equal(unmeasuredControl({ outcome: 'unknown', reason }), true, reason);
  }
  // The end-to-end pair still agrees on a real record.
  const running = withControl({ goal: 'pass' });
  running.phase = 'evaluating';
  running.trials = running.trials.filter(item => item.scenarioId !== 'ctl');
  const view = buildResultView(running);
  assert.equal(view.control.warning, null);
  assert.ok(resultViewLines(view).includes('Контроль: ещё не проверен.'));
});

test('a control id that is not in the set is ignored by the view', () => {
  const record = scored(3, 9);
  record.positiveControlScenarioIds = ['missing'];
  const view = buildResultView(record);
  assert.equal(view.control.cards.length, 0);
  assert.equal(view.headline.decided, 12);
  assert.ok(resultViewLines(view).includes('Контроль: не задан.'));
});

test('a control that flipped in a repeat is marked on its line and left out of the instability count', () => {
  const { source, repeat } = repeatPair({ A: 'fail', B: 'pass' }, { A: 'pass', B: 'fail' });
  repeat.positiveControlScenarioIds = ['A'];
  const view = buildResultView(repeat, { before: source });
  const lines = resultViewLines(view);
  assert.ok(lines.includes('Нестабильных: 1 (повтор прогона a1b2c3d4).'));
  assert.ok(lines.includes('Контроль: пройден ✓ · нестабильно'));
});

test('a control that became one turn in a repeat is another question, so its flip is never called unstable', () => {
  const { source, repeat } = repeatPair({ A: 'fail', B: 'pass' }, { A: 'pass', B: 'fail' });
  source.scenarios.find(s => s.id === 'A')!.user.maxFollowUps = 5;
  repeat.scenarios.find(s => s.id === 'A')!.user.maxFollowUps = 0;
  repeat.positiveControlScenarioIds = ['A'];
  const stability = stabilityBetweenRuns(source, repeat);
  assert.equal(stability.skipped, null);
  assert.deepEqual(stability.unstable.map(row => row.scenarioId), ['B'], 'the counted card that flipped is still reported');
  const lines = resultViewLines(buildResultView(repeat, { before: source }));
  assert.ok(lines.includes('Нестабильных: 1 (повтор прогона a1b2c3d4).'));
  assert.ok(lines.includes('Контроль: пройден ✓'), lines.join('\n'));
  assert.ok(lines.every(line => !line.startsWith('Контроль:') || !line.includes('нестабильно')));
});

// ---- Phase 2: named unmeasured situations, top causes and the full failure list. ----

test('every unmeasured situation sits under the not-measured row with its phase-1 reason', () => {
  const view = buildResultView(acquiringShape());
  const rows = resultViewRows(view);
  const at = rows.findIndex(row => row.text.startsWith('Не измерено:'));
  assert.deepEqual(rows.slice(at + 1, at + 5).map(row => [row.role, row.indent]), Array.from({ length: 4 }, () => ['situation', 2]));
  assert.equal(rows[0]?.role, 'lead');
  assert.ok(resultViewLines(view).includes('  ? Ситуация split0 — судья не уверен: голоса разошлись'));
  const unsupported = run([card('c'), card('d')], [
    attempt('c', { goal: 'unknown', goalRationale: `${AGREED_RATIONALE_PREFIX} ${GOAL_UNSUPPORTED_RATIONALE}` }),
    attempt('d', { goal: 'unknown', goalRationale: SPLIT }),
  ]);
  const lines = resultViewLines(buildResultView(unsupported));
  assert.ok(lines.includes('  ? Ситуация c — нет доказательства в ответе'), lines.join('\n'));
  assert.ok(lines.includes('  ? Ситуация d — судья не уверен: голоса разошлись'), lines.join('\n'));
});

test('with nothing unmeasured there is no not-measured row and no situation row', () => {
  const measured = buildResultView(scored(2, 1));
  assert.deepEqual(resultViewLines(measured, { details: true }), [
    'Справился в 2 из 3 проверенных ситуаций — 67%.', 'Мало данных: реальная доля где-то от 21% до 94%.', 'Контроль: не задан.',
    // Deliberate change: one failure and two sampled passes make a review queue, so F6 is printed.
    'Согласие с судьёй: ещё не проверено.']);
  assert.ok(resultViewRows(measured).every(row => row.role !== 'situation'));
  const draft = buildResultView(run([card('a')], [], { phase: 'review' }));
  assert.ok(resultViewLines(draft).every(line => !line.includes('?')));
  assert.equal(causeSection(measured)?.kind, 'failures');
  assert.equal(causeSection(buildResultView(scored(2, 0))), null, 'no failures, no heading');
  assert.deepEqual(failureListRows(buildResultView(scored(2, 0))), []);
});

/** The explanation rows of a fixture failure: no expectation, the whole reply, no rules. */
const NO_RULE_DETAILS = (indent: string) => [
  `${indent}Должен был: ожидание не записано в ситуации.`,
  `${indent}Сказал (реплика #1): «Ответ агента»`,
  `${indent}Правило: у ситуации нет правила из ваших материалов.`,
];

/** One passed and three failed situations; clusters of 1, 3, 0 (a passing card only), 1 and 1 failed situations. */
function clustered(): Experiment {
  const record = scored(1, 3);
  record.failureModes = [
    { id: 'small', name: 'Не уточняет модель терминала', description: 'd', trialIds: ['t-f1'] },
    { id: 'big', name: 'Не называет срок возврата', description: 'd', trialIds: ['t-p0', 't-f0', 't-f1', 't-f2'] },
    { id: 'passing', name: 'Лишние извинения', description: 'd', trialIds: ['t-p0'] },
    { id: 'third', name: 'Отвечает вне инструкций', description: 'd', trialIds: ['t-f2'] },
    { id: 'fourth', name: 'Путает тарифы', description: 'd', trialIds: ['t-f0'] },
  ];
  return record;
}

test('top causes count distinct failed situations, drop clusters without one, and keep three', () => {
  const view = buildResultView(clustered());
  assert.deepEqual(view.topCauses.map(cause => [cause.name, cause.count, cause.example.scenarioId]), [
    ['Не называет срок возврата', 3, 'f0'], ['Не уточняет модель терминала', 1, 'f1'], ['Отвечает вне инструкций', 1, 'f2']]);
  const section = causeSection(view);
  assert.equal(section?.kind, 'causes');
  assert.deepEqual(rowsToLines(section!.rows), [
    '1. Не называет срок возврата — 3 ситуации',
    '   Пример: Ситуация f0',
    ...NO_RULE_DETAILS('     '),
    '',
    '2. Не уточняет модель терминала — 1 ситуация',
    '   Пример: Ситуация f1',
    ...NO_RULE_DETAILS('     '),
    '',
    '3. Отвечает вне инструкций — 1 ситуация',
    '   Пример: Ситуация f2',
    ...NO_RULE_DETAILS('     '),
  ]);
  assert.equal(SECTION_TEXT[section!.kind].text, 'Главные причины провалов:');
  assert.equal(allFailuresTitle(16), 'Все провалы (16):');
  assert.equal(allFailuresPointer('fae4ee59-1234'), 'Все провалы — /agent-lab fae4ee59, раздел 1, Enter.');
});

test('without clusters the first three failures are shown; the full list keeps every failure in record order', () => {
  const view = buildResultView(scored(0, 16));
  assert.equal(view.failures.length, 16);
  assert.deepEqual(view.failures.map(item => item.scenarioId), Array.from({ length: 16 }, (_, i) => `f${i}`));
  const section = causeSection(view);
  assert.equal(section?.kind, 'failures');
  assert.equal(SECTION_TEXT[section!.kind].text, 'Провалы:');
  assert.deepEqual(section!.rows.filter(row => row.role === 'title').map(row => row.text), ['✗ Ситуация f0', '✗ Ситуация f1', '✗ Ситуация f2']);
  const all = failureListRows(view);
  assert.equal(all.filter(row => row.role === 'title').length, 16);
  assert.equal(all.filter(row => row.role === 'blank').length, 15);
  const jargon = /goal_attainment|prompt_compliance|user_fidelity|unknown|рубрик|протокол|кластер|метрик|judge|seq/i;
  const acquiring = buildResultView(acquiringShape());
  for (const line of [...rowsToLines(all), ...rowsToLines(causeSection(buildResultView(clustered()))!.rows), ...resultViewLines(acquiring, { details: true })]) {
    assert.doesNotMatch(line, jargon, line);
  }
});

test('CLI summary: block, top causes, every failure, then the details; the old «Почему» part is gone', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-result-view-causes-'));
  try {
    const record = clustered();
    const escape = String.fromCharCode(27);
    record.scenarios[3]!.title = `Ситуация ${escape}[31mf2`;
    const store = new ExperimentStore(directory);
    await store.init();
    try { await store.save(record); } finally { await store.close(); }
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'summary', '--id', record.id, '--data-dir', directory]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    assert.ok(!stdout.includes(escape), 'terminal sequences from a title never reach the output');
    const lines = stdout.split('\n');
    const block = resultViewLines(buildResultView(record), { details: true });
    assert.deepEqual(lines.slice(0, block.length + 2), [...block, '', 'Главные причины провалов:']);
    const causes = lines.indexOf('Главные причины провалов:');
    const all = lines.indexOf('Все провалы (3):');
    const details = lines.indexOf('Подробности:');
    assert.ok(causes > 0 && all > causes && details > all, stdout);
    assert.equal(lines[causes + 1], '1. Не называет срок возврата — 3 ситуации');
    assert.equal(lines[all - 1], '');
    assert.deepEqual(lines.slice(all + 1, details - 1).filter(line => line.startsWith('✗')), ['✗ Ситуация f0', '✗ Ситуация f1', '✗ Ситуация f2']);
    assert.equal(lines[details - 1], '');
    assert.ok(!lines.includes('Почему:'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ---- F6: the agreement row at every size, fed by quick marks written straight into the record. ----
/** `saw` is the judgment the person was shown; `verdict` is the answer they gave. */
const quick = (trialId: string, verdict: HumanReview['verdict'], saw: 'pass' | 'fail'): HumanReview =>
  ({ ...review(trialId, verdict, { metricId: 'goal_attainment' }), source: 'quick', judgeVerdict: saw });
const agreementRow = (record: Experiment) => resultViewLines(buildResultView(record)).find(line => line.startsWith('Согласие с судьёй'));
/** `agreed` failures answered right, one more answered wrong; the same for passes. */
function marked(passes: number, failures: number, agreedFailures: number, agreedPasses: number): Experiment {
  const record = scored(passes, failures);
  const reviews: HumanReview[] = [];
  for (let i = 0; i < failures; i++) reviews.push(quick(`t-f${i}`, i < agreedFailures ? 'fail' : 'pass', 'fail'));
  for (let i = 0; i < passes; i++) reviews.push(quick(`t-p${i}`, i < agreedPasses ? 'pass' : 'fail', 'pass'));
  return { ...record, humanReviews: reviews };
}

test('the agreement row follows the number of checks: no percent below 10, «мало проверок» below 20', () => {
  assert.equal(agreementRow(scored(1, 1)), 'Согласие с судьёй: ещё не проверено.', 'M = 0 with a queue');
  assert.equal(agreementRow({ ...scored(1, 1), humanReviews: [quick('t-f0', 'fail', 'fail')] }),
    'Согласие с судьёй: 1 из 1 проверенных · мало проверок (провалы: 1 из 1 · успехи ещё не проверены).', 'M = 1 keeps «N из M проверенных»');
  assert.equal(agreementRow(marked(1, 1, 1, 0)), 'Согласие с судьёй: 1 из 2 проверенных · мало проверок (провалы: 1 из 1 · успехи: 0 из 1).', 'M = 2');
  assert.equal(agreementRow(marked(0, 9, 8, 0)), 'Согласие с судьёй: 8 из 9 проверенных · мало проверок (провалы: 8 из 9 · успехов нет).', 'M = 9');
  assert.equal(agreementRow(marked(1, 9, 8, 1)), 'Согласие с судьёй: 9 из 10 проверенных — 90% · мало проверок (провалы: 8 из 9 · успехи: 1 из 1).', 'M = 10');
  assert.equal(agreementRow(marked(2, 17, 16, 2)), 'Согласие с судьёй: 18 из 19 проверенных — 95% · мало проверок (провалы: 16 из 17 · успехи: 2 из 2).', 'M = 19');
  assert.equal(agreementRow(marked(3, 17, 16, 2)), 'Согласие с судьёй: 18 из 20 проверенных — 90% (провалы: 16 из 17 · успехи: 2 из 3).', 'M = 20');
  const rows = resultViewLines(buildResultView(marked(0, 9, 8, 0)));
  assert.ok(rows.every(line => !line.includes('каппа') && !line.toLowerCase().includes('kappa')), 'no kappa, no error matrix');
});

test('the agreement parts name what is still unchecked instead of counting it as agreement', () => {
  const failuresOnly = { ...scored(1, 1), humanReviews: [quick('t-f0', 'fail', 'fail')] };
  assert.equal(agreementRow(failuresOnly), 'Согласие с судьёй: 1 из 1 проверенных · мало проверок (провалы: 1 из 1 · успехи ещё не проверены).');
  const passesOnly = { ...scored(1, 1), humanReviews: [quick('t-p0', 'pass', 'pass')] };
  assert.equal(agreementRow(passesOnly), 'Согласие с судьёй: 1 из 1 проверенных · мало проверок (провалы ещё не проверены · успехи: 1 из 1).');
  const noFailures = { ...scored(2, 0), humanReviews: [quick('t-p0', 'pass', 'pass')] };
  assert.equal(agreementRow(noFailures), 'Согласие с судьёй: 1 из 1 проверенных · мало проверок (провалов нет · успехи: 1 из 1).');
});

test('the agreement tail rows appear only under their condition and in one fixed order', () => {
  const record = { ...scored(1, 2), humanReviews: [quick('t-f0', 'fail', 'fail'), quick('t-f1', 'unknown', 'fail'), quick('t-p0', 'pass', 'fail')] };
  // The unsure mark also makes its card unmeasured, so only the agreement block is compared here.
  const lines = resultViewLines(buildResultView(record));
  assert.deepEqual(lines.slice(lines.findIndex(line => line.startsWith('Согласие'))), [
    'Согласие с судьёй: 1 из 1 проверенных · мало проверок (провалы: 1 из 1 · успехи ещё не проверены).',
    '  Цель — согласие в 9 случаях из 10.',
    '  Человек не смог решить: 1.',
    '  Отметки устарели после смены судьи: 1.',
  ]);
  const goalOnly = resultViewLines(buildResultView(marked(0, 1, 1, 0)));
  assert.deepEqual(goalOnly.filter(line => line.startsWith('  ')), ['  Цель — согласие в 9 случаях из 10.']);
  assert.ok(!resultViewLines(buildResultView(scored(1, 1))).some(line => line.startsWith('  Цель')), 'no goal row before the first check');
});

test('stale marks alone report themselves, and a run with nothing to check keeps the old block', () => {
  const undecided = scored(0, 0, 1);
  const stale = { ...undecided, sourceEvidence: { runId: 'run-0', trials: undecided.trials, humanReviews: [quick('t-u0', 'fail', 'fail')] } };
  const lines = resultViewLines(buildResultView(stale));
  assert.equal(agreementRow(stale), 'Согласие с судьёй: ещё не проверено.');
  assert.ok(lines.includes('  Отметки устарели после смены судьи: 1.'));
  assert.ok(!lines.some(line => line.startsWith('  Цель')));
  const empty = buildResultView(scored(0, 0, 2));
  assert.ok(resultViewLines(empty, { details: true }).every(line => !line.includes('Согласие с судьёй')), 'nothing to check prints no agreement row');
  assert.deepEqual(resultViewLines(empty), ['Проверенных ситуаций нет.', 'Не измерено: 2 — судья не уверен: голоса разошлись.',
    '  ? Ситуация u0 — судья не уверен: голоса разошлись', '  ? Ситуация u1 — судья не уверен: голоса разошлись', 'Контроль: не задан.']);
});
