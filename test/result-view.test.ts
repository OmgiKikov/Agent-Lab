import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyUsage, experimentSchema, settingsSchema, type Experiment, type HumanReview, type Trial, type ValidationExclusion } from '../src/contracts.js';
import { goalAttainment, promptCompliance, replyQuality, simulatorFidelity, type JudgeAudit, type MetricAssessment } from '../src/assessment.js';
import { buildResultView, exclusionCounts, exitCodeOf, NOT_MEASURED_TEXT, SMALL_SAMPLE, unmeasuredControl, wilson, type ResultView } from '../src/result-view.js';
import { accuracyRow, alarmRow, causeRows, disagreementRows, errorListRows, headRows, MAX_WIDTH, nextRows, nextStepText, plainText, resultScreen, runLine, trustParts, trustSegments, unmeasuredRows } from '../src/result-text.js';
import { assertPlainCopy } from './helpers/copy-check.js';
import { rowsToLines } from '../src/explain.js';
import { compareRuns, stabilityBetweenRuns } from '../src/comparison.js';
import { NOT_MEASURED_CODES, type NotMeasuredCode } from '../src/run.js';
import { AGREED_RATIONALE_PREFIX, GOAL_UNSUPPORTED_RATIONALE, SPLIT_RATIONALE_PREFIX } from '../src/judge.js';
import { ExperimentStore } from '../src/store.js';
import { ExperimentLab } from '../src/experiment.js';
import { embeddedBefore, evidenceBundle } from '../src/artifacts.js';
import { sealJudgeReceipt } from '../src/judge.js';
import { sourceIdentity } from '../src/normalize.js';
import { COUNTING_RULES } from '../src/outcomes.js';
import { decisions } from '../src/inbox.js';

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
/** The first block of the acquiring run: the number and the one trust line under it. */
const ACQUIRING_HEAD = [
  // 4 of the 13 counted situations are not measured (31%, above NOT_MEASURED_WARN_ABOVE): the headline names them (HN-3).
  'Точность агента: 0% — справился в 0 из 9 ситуаций, ещё 4 не измерено',
  // The acquiring run has 9 usable goal failures queued for review and no pass in the sample (the
  // only recorded pass, deviated1, is unusable), so the judge part is there before the first mark (F6, CR-01).
  'Вероятно, от 0% до 30% (95%) · мало данных · не измерено 4 — чаще всего клиент в симуляции отошёл от ситуации (2) · судью ещё не проверяли',
];

const SPLIT = `${SPLIT_RATIONALE_PREFIX} pass / fail. Основания каждой оценки сохранены в judgeAudit.`;
/** The texts of the first block: the alarm, the number, the trust line and the reality line. */
const head = (view: ResultView) => headRows(view).map(row => row.text);
/** The result screen as the spawned CLI prints it: without a terminal it is laid out in MAX_WIDTH columns. */
const screen = (view: ResultView) => plainText(resultScreen(view, { surface: 'cli' }), MAX_WIDTH);
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
/** `agent-lab summary` of one stored run, spawned from the built dist the way a script runs it. */
async function summary(directory: string, id: string, ...extra: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, 'summary', '--id', id, '--data-dir', directory, ...extra]);
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout, stderr };
}
async function saveAll(directory: string, records: Experiment[]): Promise<void> {
  const store = new ExperimentStore(directory);
  await store.init();
  try { for (const record of records) await store.save(record); } finally { await store.close(); }
}

test('the headline names passed over decided situations, with the 95% interval and the small-sample warning', () => {
  const view = buildResultView(scored(3, 9));
  assert.deepEqual(view.headline, { passed: 3, decided: 12, accuracy: 0.25, range: wilson(3, 12), smallSample: true });
  assert.deepEqual(head(view), ['Точность агента: 25% — справился в 3 из 12 ситуаций', 'Вероятно, от 9% до 53% (95%) · мало данных · судью ещё не проверяли']);
  assert.equal(accuracyRow(view).role, 'accuracy:bad');
  assert.equal(view.countingRules, 'goal-and-rules-v2');
  assert.equal(accuracyRow(buildResultView(scored(1, 0))).text, 'Точность агента: 100% — справился в 1 из 1 ситуации');
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

test('19 decided situations carry the small-sample warning, 20 show the interval without it', () => {
  assert.equal(SMALL_SAMPLE, 20);
  const nineteen = buildResultView(scored(5, 14));
  assert.equal(nineteen.headline.decided, 19);
  assert.equal(nineteen.headline.smallSample, true);
  assert.ok(trustParts(nineteen).includes('мало данных'));
  assert.equal(headRows(nineteen)[1]?.role, 'trust:small');
  const twenty = buildResultView(scored(10, 10));
  assert.equal(accuracyRow(twenty).text, 'Точность агента: 50% — справился в 10 из 20 ситуаций');
  assert.equal(twenty.headline.smallSample, false);
  assert.ok(twenty.headline.range, 'the range stays on the view for other surfaces');
  assert.deepEqual(trustParts(twenty), ['Вероятно, от 30% до 70% (95%)', 'судью ещё не проверяли']);
  assert.equal(headRows(twenty)[1]?.role, 'trust');
});

test('no decided situation shows no percent, and the reason opens the trust line', () => {
  const view = buildResultView(scored(0, 0, 2));
  assert.equal(view.headline.accuracy, null);
  assert.equal(view.headline.range, null);
  assert.deepEqual(head(view), ['Точность агента: нет данных — ни одна ситуация не измерена', 'Не измерено 2 — судья не уверен — его оценки разошлись']);
  assert.equal(accuracyRow(view).role, 'accuracy:none');
  assert.deepEqual(rowsToLines(unmeasuredRows(view)), ['Не измерено',
    '  Ситуация u0: судья не уверен — его оценки разошлись', '  Ситуация u1: судья не уверен — его оценки разошлись']);
  assert.deepEqual(view.next, [{ kind: 'why_unmeasured', count: 2 }]);
  assert.ok(!screen(view).includes('%'), screen(view));
});

test('a draft that never ran says so and lists nothing as unmeasured', () => {
  const view = buildResultView(run([card('a'), card('b')], [], { phase: 'review' }));
  assert.deepEqual(head(view), ['Точность агента: прогон ещё не запускался']);
  assert.equal(view.notMeasured.total, 0);
  assert.equal(view.pending, 0);
  assert.equal(view.control.alarm, null);
  assert.deepEqual(view.next, [], 'a draft that never ran offers no next step');
  assert.deepEqual(view.cards.map(item => item.reason), ['not_reached', 'not_reached'], 'its cards keep their reason');
  assert.deepEqual(rowsToLines(resultScreen(view, { surface: 'cli' })), ['Точность агента: прогон ещё не запускался', '', 'Прогон now · 2 ситуации']);
  assert.equal(exitCodeOf(view), 2);
});

test('the acquiring-shaped run gives exactly the first block promised for fae4ee59', () => {
  const view = buildResultView(acquiringShape());
  assert.deepEqual(head(view), ACQUIRING_HEAD);
  assert.deepEqual(view.notMeasured.reasons.map(reason => [reason.code, reason.count]),
    [['simulator_deviated', 2], ['simulator_unclear', 1], ['judge_split', 1]]);
  assert.deepEqual(rowsToLines(unmeasuredRows(view)), [
    'Не измерено',
    '  Ситуация deviated0: клиент в симуляции отошёл от ситуации',
    '  Ситуация deviated1: клиент в симуляции отошёл от ситуации',
    '  Ситуация unclear0: судья не уверен, что клиент держался ситуации',
    '  Ситуация split0: судья не уверен — его оценки разошлись',
  ]);
  assert.deepEqual(view.coverage, { examined: 40, included: 13,
    excluded: [{ kind: 'unconfirmed', label: 'в правилах нет ожидаемого ответа', count: 21 }, { kind: 'customer_data', label: 'нужны данные клиента', count: 6 }] });
  assert.ok(!JSON.stringify(view).includes('модельный текст'), 'model-written exclusion reasons never reach the view');
  assert.equal(view.scope.cards, 13);
  assert.equal(view.scope.dialogues, 13);
});

test('exclusions are counted by kind, most frequent first, and never enter the denominator', () => {
  const exclusion = (kind: ValidationExclusion['kind'], i: number): ValidationExclusion => ({ dialogueId: `${kind}${i}`, kind, reason: 'модельный текст' });
  const exclusions = [
    ...[0, 1].map(i => exclusion('masked', i)), ...[0, 1].map(i => exclusion('unconfirmed', i)),
    exclusion('length', 0), ...[0, 1, 2].map(i => exclusion('customer_data', i)),
  ];
  assert.deepEqual(exclusionCounts(exclusions).map(item => [item.kind, item.count]),
    [['customer_data', 3], ['unconfirmed', 2], ['masked', 2], ['length', 1]], 'equal counts keep the fixed kind order');
  assert.deepEqual(exclusionCounts([]), []);
  const view = buildResultView({ ...scored(1, 1), validationExclusions: exclusions });
  assert.deepEqual([view.headline.passed, view.headline.decided], [1, 2]);
  assert.deepEqual([view.coverage.examined, view.coverage.included], [8, 0]);
});

test('CLI summary prints the result screen of the same view, and --json the view itself, from the built dist', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-result-view-'));
  try {
    const record = acquiringShape();
    await saveAll(directory, [record]);
    const view = buildResultView(record);
    const text = await summary(directory, record.id);
    assert.equal(text.code, 0, text.stderr);
    assert.equal(text.stdout, `${screen(view)}\n`);
    assert.equal(text.stdout.split('\n')[0], ` ${ACQUIRING_HEAD[0]}`);
    assert.ok(!text.stdout.includes('Бизнес-цель достигнута'), 'the old headline with another denominator is gone');
    const json = await summary(directory, record.id, '--json');
    assert.equal(json.code, 0, json.stderr);
    const machine = JSON.parse(json.stdout);
    assert.deepEqual(machine.view, JSON.parse(JSON.stringify(view)));
    assert.equal(machine.exitCode, 2, 'four situations were not measured');
    assert.deepEqual(machine.lines, screen(view).split('\n'));
    assert.deepEqual(machine.warnings, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/**
 * One quick mark on the failed situation `t-fail0` of a freshly stored acquiring run, written
 * through the lab (which stamps the judgment it answers), then read back out of the spawned CLI.
 * Each call uses its own store, so the three marks below never see one another.
 */
async function quickMarked(verdict: HumanReview['verdict'], note: string): Promise<{ stdout: string; stored: Experiment }> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-agreement-'));
  try {
    const record = acquiringShape();
    await saveAll(directory, [record]);
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
    const { code, stdout, stderr } = await summary(directory, record.id);
    assert.equal(code, 0, stderr);
    return { stdout, stored };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('a quick mark saved by the lab is counted as agreement in the CLI summary', { timeout: 20000 }, async () => {
  const { stdout, stored } = await quickMarked('fail', 'Быстрая отметка: согласен с судьёй.');
  const view = buildResultView(stored);
  assert.equal(stdout, `${screen(view)}\n`);
  assert.equal(head(view)[0], ACQUIRING_HEAD[0], 'agreeing with the judge leaves the number where it was');
  // CR-01: the only recorded pass (deviated1) is unusable, so there is no pass to double-check.
  assert.ok(trustParts(view).includes('с судьёй согласны 1 из 1'), trustParts(view).join(' · '));
  assert.equal(view.agreement.queueFailures.length, 9, '9 failed goals; the unmeasured deviated0 and unclear0 are not queued (CR-01)');
  assert.deepEqual(view.agreement.sampledPasses, [], 'the single recorded pass is unusable, so the sample is empty');
  assert.equal(view.agreement.queueFailures.length, view.headline.decided - view.headline.passed, 'the queue holds exactly the failures the headline counts');
});

test('a quick «не согласен» moves the headline and is counted against the judge', { timeout: 20000 }, async () => {
  const { stdout, stored } = await quickMarked('pass', 'Проверка: судья не учёл уточнение клиента.');
  const view = buildResultView(stored);
  assert.equal(stdout, `${screen(view)}\n`);
  assert.equal(head(view)[0], 'Точность агента: 11% — справился в 1 из 9 ситуаций, ещё 4 не измерено');
  assert.ok(trustParts(view).includes('с судьёй согласны 0 из 1'), trustParts(view).join(' · '));
  assert.equal(view.agreement.failures.checked, 1);
  assert.equal(view.agreement.failures.agreed, 0);
  assert.deepEqual(view.agreement.disagreements.map(item => item.trialId), ['t-fail0']);
  assert.ok(stdout.includes('Вы не согласились с судьёй'), 'the CLI lists the disagreement');
});

test('a quick «не могу сказать» leaves the judge failure in the number and only counts itself', { timeout: 20000 }, async () => {
  const { stdout, stored } = await quickMarked('unknown', 'Быстрая отметка: не могу сказать.');
  const view = buildResultView(stored);
  assert.equal(stdout, `${screen(view)}\n`);
  assert.deepEqual(head(view), ACQUIRING_HEAD, 'the owner’s doubt does not remove a failure from the number');
  assert.equal(view.cards.find(item => item.scenarioId === 'fail0')?.outcome, 'fail');
  assert.ok(!stdout.includes(NOT_MEASURED_TEXT.human_unknown), 'the card keeps the judge verdict, so it has no such reason');
  assert.equal(view.agreement.unsure, 1);
  assert.equal(view.agreement.checked, 0, 'doubt is not a check');
  assert.deepEqual(view.agreement.disagreements, []);
  assert.deepEqual(view.next[0], { kind: 'review_judge', failures: 8, passes: 0, unsure: 1 });
  assert.equal(nextStepText(view.next[0]!), 'Проверить, прав ли судья — 8 ошибок ждут вашего «да» или «нет», 1 с ответом «не знаю»');
});

// ---- One test per not-measured reason: a minimal card that yields exactly that code. ----
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
    assert.ok(trustParts(view).includes(`не измерено 1 — ${NOT_MEASURED_TEXT[code]}`), trustParts(view).join(' · '));
    assert.deepEqual(rowsToLines(unmeasuredRows(view)), ['Не измерено', `  ${subject.title}: ${NOT_MEASURED_TEXT[code]}`]);
    assert.equal(exitCodeOf(view), 2, 'an unmeasured situation leaves the CI result incomplete');
  }
  return view;
}

test('every reason code has a Russian label and the list keeps its fixed order', () => {
  assert.equal(NOT_MEASURED_CODES.length, 21);
  assert.equal(NOT_MEASURED_CODES.indexOf('judge_unavailable'), NOT_MEASURED_CODES.indexOf('judge_error') + 1);
  assert.equal(NOT_MEASURED_CODES.indexOf('measurement_error'), NOT_MEASURED_CODES.indexOf('service_reply') + 1);
  assert.deepEqual(Object.keys(NOT_MEASURED_TEXT), [...NOT_MEASURED_CODES]);
  assert.ok(Object.values(NOT_MEASURED_TEXT).every(label => /^[а-яё]/u.test(label)));
});

test('reason in_progress: a running phase without an attempt is pending, not unmeasured', () => {
  const view = expectReason('in_progress', card('c'), [], { phase: 'evaluating' });
  assert.equal(view.pending, 1);
  assert.equal(view.notMeasured.total, 0);
  assert.ok(trustParts(view).includes('ещё проверяется 1'), trustParts(view).join(' · '));
  assert.deepEqual(view.next, [{ kind: 'wait' }]);
  assert.equal(exitCodeOf(view), 2);
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
  assert.equal(NOT_MEASURED_TEXT.judge_error, 'судья ответил не по формату');
});

test('reason judge_unavailable: a provider that did not answer is not a malformed judge answer', () => {
  for (const error of ['Pi provider response incomplete: rate limit', 'Pi request deadline exceeded', 'Запрос к openrouter/x не прошёл. …', 'Модель вернула пустой ответ.']) {
    expectReason('judge_unavailable', card('c'), [attempt('c', { assessmentError: error })]);
  }
  assert.equal(NOT_MEASURED_TEXT.judge_unavailable, 'судья не ответил — сбой связи или лимит запросов');
});

test('reason judge_stopped: assessment cancelled or out of budget', () => {
  expectReason('judge_stopped', card('c'), [attempt('c', { assessmentError: 'Metric assessment cancelled' })]);
  expectReason('judge_stopped', card('c'), [attempt('c', { assessmentError: 'Model call budget exhausted.' })]);
});

test('typed causes are read before the recorded text', () => {
  expectReason('turn_limit', card('c'), [attempt('c', { outcome: 'invalid', reason: 'ответ испытуемого: HTTP 500', invalidCause: 'turn_limit', assessments: undefined })]);
  expectReason('service_reply', card('c'), [attempt('c', { outcome: 'invalid', reason: 'Разговор не завершился в отведённое число реплик.', invalidCause: 'service_reply', assessments: undefined })]);
  expectReason('judge_unavailable', card('c'), [attempt('c', { assessmentError: 'Judge response rejected; original responses and errors are preserved in judgeAudit', assessmentFailure: 'unavailable' })]);
  expectReason('judge_error', card('c'), [attempt('c', { assessmentError: 'Pi request deadline exceeded', assessmentFailure: 'rejected' })]);
});

test('reason measurement_error: the connection answered but did not show what the checks need — never «агент не ответил»', () => {
  const trial = attempt('c', { outcome: 'invalid', reason: 'проверка наблюдений: Состояние внешний агент не сообщил.', invalidCause: 'measurement', assessments: undefined });
  assert.equal(experimentSchema.parse(run([card('c')], [trial])).trials[0]!.invalidCause, 'measurement', 'the appended cause parses');
  const view = expectReason('measurement_error', card('c'), [trial]);
  assert.ok(trustParts(view).includes('не измерено 1 — подключение не показало, что нужно для проверки'));
  const inbox = decisions({ run: { record: run([card('c'), card('decided')], [trial, attempt('decided', { goal: 'fail' })]), view } });
  const agent = inbox.find(item => item.key.endsWith(':agent'));
  assert.equal(agent?.text, '1 ситуация не измерена: подключение не показало, что нужно для проверки — проверьте связь с агентом.');
  assert.ok(agent?.choices.some(choice => choice.label === 'Проверить связь с агентом'));
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

test('reason service_reply: the stand answered with a service text instead of the agent', () => {
  expectReason('service_reply', card('c'), [attempt('c', { outcome: 'invalid', reason: 'Стенд ответил служебным текстом «не получен ответ»: это не ответ агента, ситуация не измерена.', assessments: undefined })]);
  assert.equal(NOT_MEASURED_TEXT.service_reply, 'вместо агента ответил стенд');
});

test('reason agent_error also names a legacy card without the goal rubric', () => {
  expectReason('agent_error', card('c', { metrics: [{ ...replyQuality }] }), [attempt('c', { outcome: 'invalid', reason: 'открытие сессии с испытуемым: ECONNREFUSED', assessments: undefined })]);
});

test('reason simulator_deviated wins over judge_split on the same card', () => {
  expectReason('simulator_deviated', card('c'), [attempt('c', { fidelity: 'fail', goal: 'unknown', goalRationale: SPLIT })]);
});

test('reasons with equal counts keep the fixed order and the trust line names the earlier one', () => {
  const record = run([card('split'), card('unclear'), card('decided')], [
    attempt('split', { goal: 'unknown', goalRationale: SPLIT }), attempt('unclear', { fidelity: 'unknown' }), attempt('decided', { goal: 'pass' }),
  ]);
  const view = buildResultView(record);
  assert.deepEqual(view.notMeasured.reasons.map(reason => reason.code), ['simulator_unclear', 'judge_split']);
  assert.ok(trustParts(view).includes('не измерено 2 — чаще всего судья не уверен, что клиент держался ситуации (1)'), trustParts(view).join(' · '));
});

test('repeats that disagree make a situation flaky: it still counts as failed and the trust line says so', () => {
  const settings = settingsSchema.parse({ userModes: ['reactive'], repeats: 2 });
  const second = (trial: Trial): Trial => ({ ...trial, id: `${trial.id}-1`, repeat: 1 });
  const record = run([card('a'), card('b')], [attempt('a'), second(attempt('a', { goal: 'fail' })), attempt('b'), second(attempt('b'))], { settings });
  const view = buildResultView(record);
  assert.deepEqual(view.cards.map(item => [item.scenarioId, item.outcome, item.flaky, item.unstable]), [['a', 'fail', true, false], ['b', 'pass', false, false]]);
  assert.deepEqual([view.headline.passed, view.headline.decided], [1, 2], 'fail-first: one failed repeat fails the situation');
  assert.deepEqual(view.failures.map(item => [item.scenarioId, item.trialId]), [['a', 't-a-1']]);
  assert.ok(trustParts(view).includes('нестабильно 1'), trustParts(view).join(' · '));
  assert.ok(!trustParts(buildResultView(scored(1, 1))).some(part => part.includes('нестабильно')));
});

test('the scope names the agent version the owner gave, never a fingerprint', () => {
  const at = new Date(2026, 8, 23, 14, 5);
  const now = new Date(2026, 8, 23, 18, 0);
  const base = { ...scored(1, 0), createdAt: at.toISOString() };
  assert.equal(buildResultView(base).scope.target, null);
  assert.equal(buildResultView({ ...base, targetFingerprint: 'fp-agent' }).scope.target, null);
  assert.equal(buildResultView({ ...base, targetRelease: 'release-7' }).scope.target, 'release-7');
  const named = buildResultView({ ...base, targetVersion: 'v2', targetRelease: 'release-7', usage: { ...emptyUsage(), costUsd: 0.14 } });
  assert.equal(named.scope.target, 'v2');
  assert.equal(runLine(named, now).text, 'Прогон сегодня в 14:05 · версия v2 · 1 ситуация · $0.14');
  assert.equal(runLine(buildResultView({ ...base, mode: 'demo', targetFingerprint: 'fp-agent' }), now).text, 'Прогон сегодня в 14:05 · 1 ситуация · учебный пример');
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
const unstablePart = (view: ResultView) => trustParts(view).find(part => part.startsWith('нестабильно'));

test('a repeat counts situations whose goal verdict flipped, and they stay in the headline', () => {
  const { source, repeat } = repeatPair({ A: 'pass', B: 'fail' }, { A: 'fail', B: 'fail' });
  const view = buildResultView(repeat, { before: source });
  assert.equal(view.stability?.basis, 'repeat');
  assert.equal(view.stability?.checked, 2);
  assert.deepEqual(view.stability?.unstable, [{ scenarioId: 'A', title: 'Ситуация A', before: 'pass', after: 'fail' }]);
  assert.equal(view.cards.find(item => item.scenarioId === 'A')?.unstable, true);
  assert.equal(view.cards.find(item => item.scenarioId === 'B')?.unstable, false);
  assert.equal(accuracyRow(view).text, 'Точность агента: 0% — справился в 0 из 2 ситуаций');
  assert.equal(unstablePart(view), 'нестабильно 1');
  assert.equal(buildResultView(repeat).stability, undefined, 'no source run, nothing to call unstable');
  assert.equal(unstablePart(buildResultView(repeat)), undefined);
});

test('a flip between a decided verdict and unknown is not instability', () => {
  const { source, repeat } = repeatPair({ A: 'pass', B: 'fail', C: 'unknown' }, { A: 'unknown', B: 'fail', C: 'pass' });
  const view = buildResultView(repeat, { before: source });
  assert.equal(view.stability?.checked, 1);
  assert.deepEqual(view.stability?.unstable, []);
  assert.equal(unstablePart(view), undefined);
  assert.ok(view.cards.every(item => !item.unstable));
});

test('a changed agent or an incomparable pair is recorded in words, not counted as instability', () => {
  const agent = repeatPair({ A: 'pass' }, { A: 'fail' }, { after: { targetFingerprint: 'fp-other' } });
  const changed = buildResultView(agent.repeat, { before: agent.source });
  assert.deepEqual(changed.stability, { basis: 'repeat', comparedWith: SOURCE_ID, checked: 0, unstable: [], skipped: 'агент изменился между прогонами' });
  assert.equal(unstablePart(changed), undefined);
  assert.ok(changed.cards.every(item => !item.unstable));
  const version = repeatPair({ A: 'pass' }, { A: 'fail' }, { before: { targetVersion: 'v1' }, after: { targetVersion: 'v2' } });
  assert.equal(buildResultView(version.repeat, { before: version.source }).stability?.skipped, 'агент изменился между прогонами');
  const judge = repeatPair({ A: 'pass' }, { A: 'fail' }, { after: { evaluatorVersion: 'judge-2' } });
  const incomparable = buildResultView(judge.repeat, { before: judge.source });
  assert.equal(incomparable.stability?.skipped, 'прогоны несравнимы');
  assert.equal(unstablePart(incomparable), undefined);
});

test('a source rebuilt from embedded evidence is compared through its embedded identity, never with the current run', () => {
  // A saved suite loaded against a new agent version while the original run is missing.
  const version = repeatPair({ A: 'pass' }, { A: 'fail' }, { before: { targetVersion: 'v1' }, after: { targetVersion: 'v2' } });
  const legacy: Experiment = { ...version.repeat, sourceEvidence: { runId: SOURCE_ID, trials: structuredClone(version.source.trials), humanReviews: [] } };
  const unavailable = buildResultView(legacy, { before: embeddedBefore(legacy, SOURCE_ID) });
  assert.deepEqual(unavailable.stability, { basis: 'repeat', comparedWith: SOURCE_ID, checked: 0, unstable: [], skipped: 'исходный прогон недоступен' });
  assert.equal(unstablePart(unavailable), undefined);
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

test('CLI summary of a repeat counts the flips against the stored source run, from the built dist', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-stability-'));
  try {
    const { source, repeat } = repeatPair({ A: 'pass', B: 'fail' }, { A: 'fail', B: 'fail' });
    await saveAll(directory, [source, repeat]);
    const { code, stdout, stderr } = await summary(directory, repeat.id);
    assert.equal(code, 0, stderr);
    assert.equal(stdout, `${screen(buildResultView(repeat, { before: source }))}\n`);
    assert.match(stdout, /нестабильно 1/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI summary says why the source run was not read and never swaps a corrupt source for the embedded copy', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-stability-'));
  try {
    const { source, repeat } = repeatPair({ A: 'pass' }, { A: 'fail' });
    const portable: Experiment = { ...repeat, sourceEvidence: { runId: SOURCE_ID, trials: structuredClone(source.trials), humanReviews: [], identity: sourceIdentity(source, ['A']) } };
    await saveAll(directory, [portable]);
    const read = async () => {
      const { code, stdout, stderr } = await summary(directory, portable.id);
      assert.equal(code, 0, stderr);
      return stdout;
    };
    // Missing: the embedded copy is used and the reader is told so.
    const missing = await read();
    assert.match(missing, /нестабильно 1/);
    assert.match(missing, /Внимание: Исходный прогон не найден\. Сравнение восстановлено из сохранённых в наборе ситуаций и разговоров/);
    assert.doesNotMatch(missing.split('\n').filter(line => line.startsWith('Внимание:')).join('\n'), /a1b2c3d4/, 'a warning names no run id');
    // Corrupt: no fallback, the reason is named.
    await writeFile(join(directory, `${SOURCE_ID}.json`), '{ not json', { mode: 0o600 });
    const corrupt = await read();
    assert.doesNotMatch(corrupt, /нестабильно/);
    assert.match(corrupt, /Внимание: Исходный прогон не удалось прочитать: Файл повреждён или слишком большой\./);
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
    const { code, stdout, stderr } = await summary(directory, repeat.id);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Внимание: Этот прогон: запись оценки судьи не совпала с полной оценкой у 2 разговоров\./);
    const bundle = await evidenceBundle(repeat, new ExperimentStore(directory));
    assert.ok(stdout.startsWith(`${screen(bundle.view)}\n`), stdout);
    assert.ok(bundle.warnings.some(warning => stdout.split('\n').includes(`Внимание: ${warning}`)), 'the same warning on both surfaces');
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
  assert.deepEqual(view.stability?.unstable, [{ scenarioId: 'A', title: 'Ситуация A', before: 'fail', after: 'pass' }]);
  assert.equal(view.cards.find(item => item.scenarioId === 'A')?.unstable, true);
  assert.equal(accuracyRow(view).text, 'Точность агента: 100% — справился в 2 из 2 ситуаций');
  assert.equal(unstablePart(view), 'нестабильно 1');
});

test('a reassessment by another judge, or without evidence, counts no instability', () => {
  const judge = reassessPair({ A: 'fail' }, { A: 'pass' }, { settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1, judge: { provider: 'openrouter', model: 'another-judge' } }) });
  const view = buildResultView(judge.record, { before: judge.source });
  assert.equal(view.stability?.skipped, 'судья или его настройки изменились');
  assert.equal(unstablePart(view), undefined);
  assert.ok(view.cards.every(item => !item.unstable));
  const bare = reassessPair({ A: 'fail' }, { A: 'pass' });
  delete bare.record.evidenceHash;
  const plain = buildResultView(bare.record, { before: bare.source });
  assert.equal(plain.stability, undefined);
  assert.equal(unstablePart(plain), undefined);
});

const CONTROL_FAILED = '✗ Числу пока не верить: контрольная ситуация не прошла — проверьте связь с агентом';
const CONTROL_UNMEASURED = '✗ Числу пока не верить: контрольная ситуация не измерена — проверьте связь с агентом';
/** 13 cards: `ctl` is the positive control, the other 12 are 3 passed and 9 failed. */
function withControl(control: Parameters<typeof attempt>[1], cardOverrides: Partial<Card> = {}, ids = ['ctl']): Experiment {
  const record = scored(3, 9);
  record.scenarios.push(card('ctl', cardOverrides));
  record.trials.push(attempt('ctl', control));
  record.positiveControlScenarioIds = ids;
  return record;
}

test('a passing control stays out of the headline and out of the review queue', () => {
  const view = buildResultView(withControl({ goal: 'pass' }));
  assert.deepEqual([view.headline.passed, view.headline.decided], [3, 12]);
  assert.equal(view.control.alarm, null);
  assert.deepEqual(view.control.cards.map(item => [item.scenarioId, item.outcome, item.control]), [['ctl', 'pass', true]]);
  assert.equal(view.cards.find(item => item.scenarioId === 'ctl')?.control, true);
  assert.deepEqual(head(view), ['Точность агента: 25% — справился в 3 из 12 ситуаций', 'Вероятно, от 9% до 53% (95%) · мало данных · судью ещё не проверяли']);
  assert.ok(![...view.agreement.queueFailures, ...view.agreement.sampledPasses].includes('t-ctl'), 'the control is never in the review queue');
});

test('a failed control puts the alarm above the number and asks to check the connection first', () => {
  const view = buildResultView(withControl({ goal: 'fail' }));
  assert.equal(view.control.alarm, 'failed');
  // The alarm keeps its own role and the number keeps its accuracy role: the one number the
  // product exists to show is never muted under the alarm.
  const rows = headRows(view);
  assert.deepEqual(rows.slice(0, 2).map(row => [row.role, row.text]), [['alarm', CONTROL_FAILED], ['accuracy:bad', 'Точность агента: 25% — справился в 3 из 12 ситуаций']]);
  assert.equal(rows.filter(row => row.role.startsWith('accuracy')).length, 1);
  assert.deepEqual(view.next, [{ kind: 'check_connection' }]);
  assert.equal(exitCodeOf(view), 2, 'a control alarm makes the CI result incomplete');
});

test('without a control alarm the number is the first row', () => {
  const view = buildResultView(scored(3, 9));
  assert.equal(alarmRow(view), null);
  const rows = headRows(view);
  assert.equal(rows[0]!.role, 'accuracy:bad');
  assert.equal(rows.filter(row => row.role === 'alarm').length, 0);
  assert.equal(rows.filter(row => row.role.startsWith('accuracy')).length, 1);
});

test('an unmeasured control is named with its reason, alarmed about and not counted as unmeasured', () => {
  const view = buildResultView(withControl({ goal: 'unknown', goalRationale: SPLIT }));
  assert.equal(view.control.alarm, 'unmeasured');
  assert.equal(head(view)[0], CONTROL_UNMEASURED);
  assert.deepEqual(view.control.cards.map(item => [item.outcome, item.reason]), [['unknown', 'judge_split']]);
  assert.equal(view.notMeasured.total, 0);
  assert.equal(view.headline.decided, 12);
});

test('a control still running is not a failure and is not pending in the headline', () => {
  const record = withControl({ goal: 'pass' });
  record.phase = 'evaluating';
  record.trials = record.trials.filter(item => item.scenarioId !== 'ctl');
  const view = buildResultView(record);
  assert.equal(view.control.alarm, null);
  assert.equal(view.pending, 0);
  assert.deepEqual(view.control.cards.map(item => [item.outcome, item.reason]), [['unknown', 'in_progress']]);
  assert.deepEqual(view.next, [{ kind: 'wait' }]);
});

test('a synthetic control keeps its provenance, and several controls are counted apart from the headline', () => {
  const synthetic = buildResultView(withControl({ goal: 'pass' }, { provenance: 'synthetic' }));
  assert.equal(synthetic.control.cards[0]?.provenance, 'synthetic');
  assert.equal(synthetic.scope.synthetic, 1);
  const mixed = buildResultView(withControl({ goal: 'fail' }, {}, ['ctl', 'p0']));
  assert.equal(accuracyRow(mixed).text, 'Точность агента: 18% — справился в 2 из 11 ситуаций');
  assert.deepEqual(mixed.control.cards.map(item => [item.scenarioId, item.outcome]), [['p0', 'pass'], ['ctl', 'fail']]);
  assert.equal(mixed.control.alarm, 'failed');
  assert.equal(alarmRow(mixed)?.text, '✗ Числу пока не верить: контрольные ситуации не прошли — проверьте связь с агентом');
  const passed = buildResultView(withControl({ goal: 'fail' }, {}, ['p0', 'p1']));
  assert.deepEqual(passed.control.cards.map(item => item.outcome), ['pass', 'pass']);
  assert.equal(passed.control.alarm, null);
  // One failed and one unmeasured control: the alarm names both.
  const both = withControl({ goal: 'fail' }, {}, ['ctl', 'p0']);
  const p0 = both.trials.find(item => item.scenarioId === 'p0')!;
  p0.assessments = p0.assessments!.map(item => item.metricId === 'goal_attainment' ? { ...item, result: 'unknown' as const, evidence: [], rationale: SPLIT } : item);
  const view = buildResultView(both);
  assert.equal(view.control.alarm, 'failed_or_unmeasured');
  assert.equal(head(view)[0], '✗ Числу пока не верить: контрольные ситуации не прошли или не измерены — проверьте связь с агентом');
});

test('the control alarm reads one predicate, so a control still being decided is never called unmeasured', () => {
  // A control that is `unknown` with no recorded reason is still being decided: no alarm about it.
  assert.equal(unmeasuredControl({ outcome: 'unknown' }), false);
  assert.equal(unmeasuredControl({ outcome: 'unknown', reason: 'in_progress' }), false);
  assert.equal(unmeasuredControl({ outcome: 'pass' }), false);
  assert.equal(unmeasuredControl({ outcome: 'fail' }), false);
  for (const reason of NOT_MEASURED_CODES.filter(code => code !== 'in_progress')) {
    assert.equal(unmeasuredControl({ outcome: 'unknown', reason }), true, reason);
  }
  // The same predicate on a real record.
  const running = withControl({ goal: 'pass' });
  running.phase = 'evaluating';
  running.trials = running.trials.filter(item => item.scenarioId !== 'ctl');
  const view = buildResultView(running);
  assert.equal(view.control.alarm, null);
  assert.equal(alarmRow(view), null);
});

test('a control id that is not in the set is ignored by the view', () => {
  const record = scored(3, 9);
  record.positiveControlScenarioIds = ['missing'];
  const view = buildResultView(record);
  assert.equal(view.control.cards.length, 0);
  assert.equal(view.control.alarm, null);
  assert.equal(view.headline.decided, 12);
});

// ---- Phase 03.1: the control is decided by its goal alone; a counted card by the goal and the prompt rules. ----
const RULED_METRICS = [{ ...goalAttainment }, { ...promptCompliance }, { ...simulatorFidelity }];
/** One reactive attempt whose request was met but which broke a prompt rule (the shape of the stored control ae812a24). */
const metButBroke = (id: string) => attempt(id, { assessments: [vote('goal_attainment', 'pass'), vote('prompt_compliance', 'fail'), vote('user_fidelity', 'pass')] });

test('a control that met its goal but broke a rule still passes as a control, while the same counted card fails the headline', () => {
  const record = run([card('ctl', { metrics: RULED_METRICS }), card('c', { metrics: RULED_METRICS })], [metButBroke('ctl'), metButBroke('c')],
    { positiveControlScenarioIds: ['ctl'] });
  const view = buildResultView(record);
  assert.equal(accuracyRow(view).text, 'Точность агента: 0% — справился в 0 из 1 ситуации');
  assert.deepEqual([view.headline.passed, view.headline.decided], [0, 1], 'the control is left out of the number');
  const control = view.cards.find(item => item.scenarioId === 'ctl')!;
  assert.deepEqual([control.outcome, control.goal, control.rules, control.control], ['pass', 'pass', 'fail', true]);
  assert.deepEqual(view.control.cards.map(item => [item.outcome, item.rules]), [['pass', 'fail']]);
  assert.equal(view.control.alarm, null, 'a broken rule on the control is shown, never the «числу пока не верить» alarm');
  const counted = view.cards.find(item => item.scenarioId === 'c')!;
  assert.deepEqual([counted.outcome, counted.goal, counted.rules], ['fail', 'pass', 'fail']);
  assert.equal(view.countingRules, 'goal-and-rules-v2');
  // The phase-1 fixtures carry no prompt rules: their cards say so instead of inventing a rules result.
  const plain = buildResultView(scored(1, 1));
  assert.deepEqual(plain.cards.map(item => [item.goal, item.rules]), [['pass', 'none'], ['fail', 'none']]);
});

// ---- Phase 03.1: the breakdown of the headline into its goal and prompt-rule halves. ----
const PROMPT_SOURCE = { id: 'src-p', name: 'Системный промпт', hash: 'p', kind: 'prompt' as const,
  content: 'Ты помощник по эквайрингу.\n- Не направляй клиента в поддержку.\n- Не обещай сроки, которых нет в инструкциях.\n- Отвечай по инструкциям банка.' };
const PROMPT_RULES = [
  { id: 'no-support', text: 'Не направляй клиента в поддержку.', sourceId: 'src-p', quote: 'Не направляй клиента в поддержку.', critical: false },
  { id: 'no-promises', text: 'Не обещай сроки, которых нет в инструкциях.', sourceId: 'src-p', quote: 'Не обещай сроки, которых нет в инструкциях.', critical: false },
];
/** Judge wording that names owner rule 1 / rule 2 uniquely, and one that names nothing. */
const BROKE_1 = 'Нарушено правило «Не направляй клиента в поддержку» — агент отправил клиента в поддержку.';
const BROKE_2 = 'Нарушено правило «Не обещай сроки, которых нет в инструкциях» — агент назвал срок.';
const BROKE_UNNAMED = 'Агент нарушил правило о сроках.';
type RuledSpec = { goal: Result; rules: Result | 'none'; rationale?: string; fidelity?: Result; control?: boolean };
/** One reactive attempt per card; a card with `rules: 'none'` carries the phase-1 rubrics (goal, reply quality, fidelity) instead. */
function ruledRun(specs: Record<string, RuledSpec>, overrides: Partial<Experiment> = {}): Experiment {
  const entries = Object.entries(specs);
  const cards = entries.map(([id, spec]) => card(id, { requirementIds: ['no-support', 'no-promises'],
    metrics: spec.rules === 'none' ? [{ ...goalAttainment }, { ...replyQuality }, { ...simulatorFidelity }] : RULED_METRICS }));
  const trials = entries.map(([id, spec]) => attempt(id, { assessments: [
    vote('goal_attainment', spec.goal, spec.goal === 'unknown' ? SPLIT : undefined),
    spec.rules === 'none' ? vote('reply_quality', 'pass') : vote('prompt_compliance', spec.rules, spec.rules === 'unknown' ? SPLIT : spec.rationale),
    vote('user_fidelity', spec.fidelity ?? 'pass'),
  ] }));
  const controls = entries.filter(([, spec]) => spec.control).map(([id]) => id);
  return run(cards, trials, { sources: [PROMPT_SOURCE], requirements: PROMPT_RULES, ...(controls.length ? { positiveControlScenarioIds: controls } : {}), ...overrides });
}
const NO_RULES = { broken: 0, decided: 0, commonRule: null, commonRuleCount: 0 };

test('the breakdown counts met requests and broken rules over the counted cards, and names the one most frequent rule with its count', () => {
  const plain = buildResultView(ruledRun({ a: { goal: 'pass', rules: 'fail' }, b: { goal: 'fail', rules: 'fail' }, u: { goal: 'pass', rules: 'fail', fidelity: 'fail' } }));
  assert.deepEqual([plain.headline.passed, plain.headline.decided], [0, 2]);
  assert.deepEqual(plain.breakdown, { goal: { met: 1, decided: 2 }, rules: { broken: 2, decided: 2, commonRule: null, commonRuleCount: 0 }, withoutRules: 0 },
    'an unusable card counts in neither part');
  const named = buildResultView(ruledRun({ a: { goal: 'pass', rules: 'fail', rationale: BROKE_1 }, b: { goal: 'fail', rules: 'fail', rationale: BROKE_1 } }));
  assert.deepEqual(named.breakdown.rules, { broken: 2, decided: 2, commonRule: 1, commonRuleCount: 2 });
  const tie = buildResultView(ruledRun({ a: { goal: 'pass', rules: 'fail', rationale: BROKE_1 }, b: { goal: 'fail', rules: 'fail', rationale: BROKE_2 } }));
  assert.deepEqual([tie.breakdown.rules.commonRule, tie.breakdown.rules.commonRuleCount], [null, 0], 'a tie names no rule');
  const top = buildResultView(ruledRun({ a: { goal: 'pass', rules: 'fail', rationale: BROKE_1 }, b: { goal: 'fail', rules: 'fail', rationale: BROKE_1 },
    c: { goal: 'fail', rules: 'fail', rationale: BROKE_2 }, d: { goal: 'fail', rules: 'fail', rationale: BROKE_UNNAMED }, e: { goal: 'pass', rules: 'pass' } }));
  assert.deepEqual(top.breakdown, { goal: { met: 2, decided: 5 }, rules: { broken: 4, decided: 5, commonRule: 1, commonRuleCount: 2 }, withoutRules: 0 },
    'the strict top count names the rule');
  assert.equal(accuracyRow(top).text, 'Точность агента: 20% — справился в 1 из 5 ситуаций');
  // Controls are never counted in the breakdown.
  const controlled = buildResultView(ruledRun({ a: { goal: 'pass', rules: 'fail', rationale: BROKE_1 }, b: { goal: 'fail', rules: 'fail', rationale: BROKE_1 },
    ctl: { goal: 'pass', rules: 'fail', rationale: BROKE_2, control: true } }));
  assert.deepEqual(controlled.breakdown, { goal: { met: 1, decided: 2 }, rules: { broken: 2, decided: 2, commonRule: 1, commonRuleCount: 2 }, withoutRules: 0 });
  // Goal unknown + rules fail: the request is undecided, the broken rule still counts.
  const undecidedGoal = buildResultView(ruledRun({ a: { goal: 'unknown', rules: 'fail' }, b: { goal: 'pass', rules: 'unknown' } }));
  assert.deepEqual(undecidedGoal.breakdown.goal, { met: 1, decided: 1 });
  assert.deepEqual([undecidedGoal.breakdown.rules.broken, undecidedGoal.breakdown.rules.decided], [1, 1]);
});

test('a mixed set counts the cards without prompt rules; goal-only, legacy and never-run sets count no rules', () => {
  const mixed = buildResultView(ruledRun({ a: { goal: 'pass', rules: 'fail' }, b: { goal: 'fail', rules: 'none' } }));
  assert.deepEqual(mixed.breakdown, { goal: { met: 1, decided: 2 }, rules: { broken: 1, decided: 1, commonRule: null, commonRuleCount: 0 }, withoutRules: 1 });
  const goalOnly = buildResultView(scored(3, 9));
  assert.deepEqual(goalOnly.breakdown, { goal: { met: 3, decided: 12 }, rules: NO_RULES, withoutRules: 12 });
  const legacy = buildResultView(run([card('c', { metrics: [{ ...replyQuality }] })], [attempt('c', { assessments: [vote('reply_quality', 'fail')] })]));
  assert.equal(legacy.headline.decided, 1, 'the legacy card is still decided by the strict rule');
  assert.deepEqual(legacy.breakdown, { goal: { met: 0, decided: 0 }, rules: NO_RULES, withoutRules: 0 }, 'a legacy card has neither half');
  const draft = buildResultView(run([card('a', { metrics: RULED_METRICS })], [], { phase: 'review' }));
  assert.deepEqual(draft.breakdown, { goal: { met: 0, decided: 0 }, rules: NO_RULES, withoutRules: 0 });
  assert.deepEqual(head(draft), ['Точность агента: прогон ещё не запускался']);
  const nothingDecided = buildResultView(scored(0, 0, 2));
  assert.deepEqual(nothingDecided.breakdown.goal, { met: 0, decided: 0 }, 'no decided part');
});

/** The stored run fae4ee59 under the new rule, in counts only: 9 double failures, 1 goal unknown + rules fail, 3 unusable; no rule named. */
function acquiringRulesShape(): Experiment {
  const specs: Record<string, RuledSpec> = {};
  for (let i = 0; i < 9; i++) specs[`both${i}`] = { goal: 'fail', rules: 'fail' };
  specs.split0 = { goal: 'unknown', rules: 'fail' };
  specs.deviated0 = { goal: 'fail', rules: 'fail', fidelity: 'fail' };
  specs.deviated1 = { goal: 'pass', rules: 'fail', fidelity: 'fail' };
  specs.unclear0 = { goal: 'fail', rules: 'fail', fidelity: 'unknown' };
  return ruledRun(specs, { sources: [], requirements: [] });
}

test('the acquiring run under the new rule reads 0 of 10, with requests met 0 of 9 and rules broken 10 of 10', () => {
  const view = buildResultView(acquiringRulesShape());
  assert.equal(accuracyRow(view).text, 'Точность агента: 0% — справился в 0 из 10 ситуаций, ещё 3 не измерено', '3 of 13 not measured: the headline names them');
  assert.deepEqual(view.breakdown, { goal: { met: 0, decided: 9 }, rules: { broken: 10, decided: 10, commonRule: null, commonRuleCount: 0 }, withoutRules: 0 });
  assert.equal(view.notMeasured.total, 3);
  assert.deepEqual(view.notMeasured.reasons.map(reason => [reason.code, reason.count]), [['simulator_deviated', 2], ['simulator_unclear', 1]]);
  assert.equal(view.failures.length, 10);
  assert.deepEqual(new Set(view.failures.map(item => item.kind)), new Set(['both', 'rules']), 'nine double failures and one rules-only failure');
  // A double failure can be a cause example.
  const record = acquiringRulesShape();
  record.failureModes = [{ id: 'support', name: 'Отправляет клиента в поддержку', description: 'd', trialIds: ['t-both0', 't-both1'] }];
  assert.equal(buildResultView(record).topCauses[0]?.example.kind, 'both');
});

test('a control with prompt rules is decided by its goal: a broken rule there is never the alarm', () => {
  const view = (specs: Record<string, RuledSpec>) => buildResultView(ruledRun({ c: { goal: 'fail', rules: 'pass' }, ...specs }));
  const brokeRule = view({ ctl: { goal: 'pass', rules: 'fail', control: true } });
  assert.deepEqual(brokeRule.control.cards.map(item => [item.outcome, item.goal, item.rules]), [['pass', 'pass', 'fail']]);
  assert.equal(brokeRule.control.alarm, null);
  assert.equal(view({ ctl: { goal: 'pass', rules: 'pass', control: true } }).control.alarm, null);
  assert.equal(view({ ctl: { goal: 'pass', rules: 'unknown', control: true } }).control.alarm, null, 'undecided rules do not matter to a control');
  const failedGoal = view({ ctl: { goal: 'fail', rules: 'fail', control: true } });
  assert.equal(failedGoal.control.alarm, 'failed', 'the failed goal is still the alarm');
  assert.equal(head(failedGoal)[0], CONTROL_FAILED);
  const undecidedGoal = view({ ctl: { goal: 'unknown', rules: 'fail', control: true } });
  assert.deepEqual(undecidedGoal.control.cards.map(item => [item.outcome, item.reason]), [['unknown', 'judge_split']], 'an undecided goal names the goal’s reason');
  assert.equal(undecidedGoal.control.alarm, 'unmeasured');
  assert.equal(view({ ctl: { goal: 'pass', rules: 'fail', control: true }, ctl2: { goal: 'pass', rules: 'pass', control: true } }).control.alarm, null);
  assert.equal(view({ ctl: { goal: 'pass', rules: 'pass', control: true }, ctl2: { goal: 'fail', rules: 'fail', control: true } }).control.alarm, 'failed');
  // A control without prompt rules is decided the same way.
  assert.equal(view({ ctl: { goal: 'pass', rules: 'none', control: true } }).control.alarm, null);
  assert.equal(view({ ctl: { goal: 'fail', rules: 'none', control: true } }).control.alarm, 'failed');
  const jargon = /goal_attainment|prompt_compliance|user_fidelity|unknown|рубрик|протокол|кластер|метрик|judge|seq/i;
  for (const text of [head(failedGoal)[0]!, head(undecidedGoal)[0]!]) {
    assert.doesNotMatch(text, jargon, text);
    assertPlainCopy(text);
  }
});

test('a control that flipped in a repeat is marked unstable and left out of the instability count', () => {
  const { source, repeat } = repeatPair({ A: 'fail', B: 'pass' }, { A: 'pass', B: 'fail' });
  repeat.positiveControlScenarioIds = ['A'];
  const view = buildResultView(repeat, { before: source });
  assert.deepEqual(view.stability?.unstable.map(row => row.scenarioId), ['B']);
  assert.equal(unstablePart(view), 'нестабильно 1');
  assert.deepEqual(view.control.cards.map(item => [item.scenarioId, item.outcome, item.unstable]), [['A', 'pass', true]]);
});

test('a control that became one turn in a repeat is another question, so its flip is never called unstable', () => {
  const { source, repeat } = repeatPair({ A: 'fail', B: 'pass' }, { A: 'pass', B: 'fail' });
  source.scenarios.find(s => s.id === 'A')!.user.maxFollowUps = 5;
  repeat.scenarios.find(s => s.id === 'A')!.user.maxFollowUps = 0;
  repeat.positiveControlScenarioIds = ['A'];
  const stability = stabilityBetweenRuns(source, repeat);
  assert.equal(stability.skipped, null);
  assert.deepEqual(stability.unstable.map(row => row.scenarioId), ['B'], 'the counted card that flipped is still reported');
  const view = buildResultView(repeat, { before: source });
  assert.equal(unstablePart(view), 'нестабильно 1');
  assert.deepEqual(view.control.cards.map(item => [item.scenarioId, item.unstable]), [['A', false]]);
});

// ---- Phase 2: named unmeasured situations, top causes and the full failure list. ----

test('every unmeasured situation is listed under «Не измерено» with its reason', () => {
  const view = buildResultView(acquiringShape());
  const rows = unmeasuredRows(view);
  assert.deepEqual(rows.map(row => [row.role, row.indent]), [['heading', 0], ...Array.from({ length: 4 }, () => ['item:muted', 2])]);
  assert.ok(rowsToLines(rows).includes('  Ситуация split0: судья не уверен — его оценки разошлись'));
  const unsupported = run([card('c'), card('d')], [
    attempt('c', { goal: 'unknown', goalRationale: `${AGREED_RATIONALE_PREFIX} ${GOAL_UNSUPPORTED_RATIONALE}` }),
    attempt('d', { goal: 'unknown', goalRationale: SPLIT }),
  ]);
  assert.deepEqual(rowsToLines(unmeasuredRows(buildResultView(unsupported))), ['Не измерено',
    '  Ситуация d: судья не уверен — его оценки разошлись', '  Ситуация c: в ответе агента нет доказательства'], 'equal counts keep the fixed reason order');
});

test('with nothing unmeasured there is no «Не измерено» block, and no failure says so honestly', () => {
  const measured = buildResultView(scored(2, 1));
  assert.deepEqual(head(measured), ['Точность агента: 67% — справился в 2 из 3 ситуаций', 'Вероятно, от 21% до 94% (95%) · мало данных · судью ещё не проверяли']);
  assert.deepEqual(unmeasuredRows(measured), []);
  assert.ok(!screen(measured).includes('Не измерено'));
  assert.deepEqual(unmeasuredRows(buildResultView(run([card('a')], [], { phase: 'review' }))), []);
  assert.deepEqual(rowsToLines(causeRows(measured)), ['Почему ошибается', '  1  Ситуация f0']);
  const clean = buildResultView(scored(2, 0));
  assert.deepEqual(causeRows(clean), [{ role: 'good', indent: 0, text: 'Ошибок нет. Это не гарантия для живых клиентов: проверены 2 ситуации.' }]);
  assert.deepEqual(errorListRows(clean), []);
  assert.deepEqual(causeRows(buildResultView(scored(0, 0, 2))), [], 'nothing decided, nothing to say about errors');
});

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
/** The example of a fixture failure: no expectation, the whole reply, no rule. */
const NO_RULE_EXAMPLE = 'Ожидалось: не записано в ситуации · Агент: «Ответ агента»';

test('top causes count distinct failed situations, drop clusters without one, and keep three', () => {
  const view = buildResultView(clustered());
  assert.deepEqual(view.topCauses.map(cause => [cause.name, cause.count, cause.scenarioIds, cause.example.scenarioId]), [
    ['Не называет срок возврата', 3, ['f0', 'f1', 'f2'], 'f0'], ['Не уточняет модель терминала', 1, ['f1'], 'f1'], ['Отвечает вне инструкций', 1, ['f2'], 'f2']]);
  assert.deepEqual(causeRows(view, { examples: true }).map(row => [row.role, row.indent, row.text, row.right ?? null]), [
    ['heading', 0, 'Почему ошибается', null],
    ['item', 2, '1  Не называет срок возврата', '3 ситуации'],
    ['muted', 5, 'Ситуация f0', null],
    ['quote', 5, NO_RULE_EXAMPLE, null],
    ['item', 2, '2  Не уточняет модель терминала', '1 ситуация'],
    ['muted', 5, 'Ситуация f1', null],
    ['quote', 5, NO_RULE_EXAMPLE, null],
    ['item', 2, '3  Отвечает вне инструкций', '1 ситуация'],
    ['muted', 5, 'Ситуация f2', null],
    ['quote', 5, NO_RULE_EXAMPLE, null],
  ]);
  assert.deepEqual(causeRows(view).filter(row => row.role === 'item').map(row => row.short), ['3', '1', '1'], 'a narrow screen keeps the count');
});

test('without clusters the first three failures are named; the full list keeps every failure in record order', () => {
  const view = buildResultView(scored(0, 16));
  assert.equal(view.failures.length, 16);
  assert.deepEqual(view.failures.map(item => item.scenarioId), Array.from({ length: 16 }, (_, i) => `f${i}`));
  assert.deepEqual(rowsToLines(causeRows(view)), ['Почему ошибается', '  1  Ситуация f0', '  2  Ситуация f1', '  3  Ситуация f2', '  и ещё 13 ошибок']);
  const all = errorListRows(view);
  assert.equal(all[0]?.text, 'Все ошибки');
  assert.deepEqual(all.filter(row => row.role === 'failed').map(row => row.text), Array.from({ length: 16 }, (_, i) => `✗ ${i + 1}  Ситуация f${i}`));
  assert.equal(all.filter(row => row.role === 'quote' && row.text === NO_RULE_EXAMPLE).length, 16, 'every error keeps its example');
  const jargon = /goal_attainment|prompt_compliance|user_fidelity|unknown|рубрик|протокол|кластер|метрик|judge|seq/i;
  const acquiring = buildResultView(acquiringShape());
  for (const line of [...plainText(all, MAX_WIDTH).split('\n'), ...plainText(causeRows(buildResultView(clustered()), { examples: true }), MAX_WIDTH).split('\n'), ...screen(acquiring).split('\n')]) {
    assert.doesNotMatch(line, jargon, line);
  }
});

test('CLI summary: the number, the causes, every error, then «Дальше»', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-result-view-causes-'));
  try {
    const record = clustered();
    await saveAll(directory, [record]);
    const { code, stdout, stderr } = await summary(directory, record.id);
    assert.equal(code, 0, stderr);
    assert.equal(stdout, `${screen(buildResultView(record))}\n`);
    const lines = stdout.split('\n');
    assert.equal(lines[0], ' Точность агента: 25% — справился в 1 из 4 ситуаций');
    const causes = lines.indexOf(' Почему ошибается');
    const all = lines.indexOf(' Все ошибки');
    const next = lines.indexOf(' Дальше');
    assert.ok(causes > 0 && all > causes && next > all, stdout);
    assert.match(lines[causes + 1]!, /^ {3}1 {2}Не называет срок возврата +3 ситуации$/);
    assert.equal(lines[all - 1], '', 'blocks are separated by one blank line');
    assert.deepEqual(lines.slice(all + 1, next).filter(line => line.trimStart().startsWith('✗')).map(line => line.trim()),
      ['✗ 1  Ситуация f0', '✗ 2  Ситуация f1', '✗ 3  Ситуация f2']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ---- F6: the owner's agreement with the judge, fed by quick marks written straight into the record. ----
/** `saw` is the judgment the person was shown; `verdict` is the answer they gave. */
const quick = (trialId: string, verdict: HumanReview['verdict'], saw: 'pass' | 'fail'): HumanReview =>
  ({ ...review(trialId, verdict, { metricId: 'goal_attainment' }), source: 'quick', judgeVerdict: saw });
/** The judge part of the trust line: the owner's agreement, or that the judge was not checked yet. */
const judgePart = (record: Experiment) => trustParts(buildResultView(record)).find(part => part.startsWith('с судьёй') || part.startsWith('судью'));
/** `agreed` failures answered right, one more answered wrong; the same for passes. */
function marked(passes: number, failures: number, agreedFailures: number, agreedPasses: number): Experiment {
  const record = scored(passes, failures);
  const reviews: HumanReview[] = [];
  for (let i = 0; i < failures; i++) reviews.push(quick(`t-f${i}`, i < agreedFailures ? 'fail' : 'pass', 'fail'));
  for (let i = 0; i < passes; i++) reviews.push(quick(`t-p${i}`, i < agreedPasses ? 'pass' : 'fail', 'pass'));
  return { ...record, humanReviews: reviews };
}

test('the agreement is counted over the owner’s checks, split by the judge’s failures and passes, at every size', () => {
  const counts = (record: Experiment) => {
    const { agreed, checked, failures, passes } = buildResultView(record).agreement;
    return { agreed, checked, failures, passes };
  };
  assert.equal(judgePart(scored(1, 1)), 'судью ещё не проверяли', 'M = 0 with a queue');
  assert.equal(counts(scored(1, 1)).checked, 0);
  const one = { ...scored(1, 1), humanReviews: [quick('t-f0', 'fail', 'fail')] };
  assert.equal(judgePart(one), 'с судьёй согласны 1 из 1', 'M = 1');
  assert.deepEqual(counts(one), { agreed: 1, checked: 1, failures: { agreed: 1, checked: 1 }, passes: { agreed: 0, checked: 0 } });
  const bands: [Experiment, string, ReturnType<typeof counts>][] = [
    [marked(1, 1, 1, 0), 'с судьёй согласны 1 из 2', { agreed: 1, checked: 2, failures: { agreed: 1, checked: 1 }, passes: { agreed: 0, checked: 1 } }],
    [marked(0, 9, 8, 0), 'с судьёй согласны 8 из 9', { agreed: 8, checked: 9, failures: { agreed: 8, checked: 9 }, passes: { agreed: 0, checked: 0 } }],
    [marked(1, 9, 8, 1), 'с судьёй согласны 9 из 10', { agreed: 9, checked: 10, failures: { agreed: 8, checked: 9 }, passes: { agreed: 1, checked: 1 } }],
    [marked(2, 17, 16, 2), 'с судьёй согласны 18 из 19', { agreed: 18, checked: 19, failures: { agreed: 16, checked: 17 }, passes: { agreed: 2, checked: 2 } }],
    [marked(3, 17, 16, 2), 'с судьёй согласны 18 из 20', { agreed: 18, checked: 20, failures: { agreed: 16, checked: 17 }, passes: { agreed: 2, checked: 3 } }],
  ];
  for (const [record, part, expected] of bands) {
    assert.equal(judgePart(record), part);
    assert.deepEqual(counts(record), expected, part);
  }
  assert.ok(trustParts(buildResultView(marked(0, 9, 8, 0))).every(part => !part.includes('каппа') && !part.toLowerCase().includes('kappa')), 'no kappa, no error matrix');
});

test('what is still unchecked is named as the next step instead of being counted as agreement', () => {
  const failuresOnly = buildResultView({ ...scored(1, 1), humanReviews: [quick('t-f0', 'fail', 'fail')] });
  assert.deepEqual([failuresOnly.agreement.failures, failuresOnly.agreement.passes], [{ agreed: 1, checked: 1 }, { agreed: 0, checked: 0 }]);
  assert.deepEqual(failuresOnly.agreement.unmarked, ['t-p0']);
  assert.deepEqual(failuresOnly.next[0], { kind: 'review_judge', failures: 0, passes: 1, unsure: 0 });
  assert.equal(nextStepText(failuresOnly.next[0]!), 'Проверить, прав ли судья — 1 успех на перепроверку');
  const passesOnly = buildResultView({ ...scored(1, 1), humanReviews: [quick('t-p0', 'pass', 'pass')] });
  assert.deepEqual([passesOnly.agreement.failures, passesOnly.agreement.passes], [{ agreed: 0, checked: 0 }, { agreed: 1, checked: 1 }]);
  assert.deepEqual(passesOnly.next[0], { kind: 'review_judge', failures: 1, passes: 0, unsure: 0 });
  assert.equal(nextStepText(passesOnly.next[0]!), 'Проверить, прав ли судья — 1 ошибка ждёт вашего «да» или «нет»');
  const noFailures = buildResultView({ ...scored(2, 0), humanReviews: [quick('t-p0', 'pass', 'pass')] });
  assert.deepEqual([noFailures.agreement.failures, noFailures.agreement.passes], [{ agreed: 0, checked: 0 }, { agreed: 1, checked: 1 }]);
  assert.deepEqual(noFailures.next[0], { kind: 'review_judge', failures: 0, passes: 1, unsure: 0 });
});

test('doubt and a changed judgment are counted apart, never as checks', () => {
  const record = { ...scored(1, 2), humanReviews: [quick('t-f0', 'fail', 'fail'), quick('t-f1', 'unknown', 'fail'), quick('t-p0', 'pass', 'fail')] };
  const view = buildResultView(record);
  const { checked, agreed, unsure, stale, staleRule } = view.agreement;
  assert.deepEqual({ checked, agreed, unsure, stale, staleRule }, { checked: 1, agreed: 1, unsure: 1, stale: 1, staleRule: 0 });
  assert.equal(judgePart(record), 'с судьёй согласны 1 из 1');
  assert.equal(view.cards.find(item => item.scenarioId === 'f1')?.outcome, 'fail', 'a quick «не могу сказать» keeps the judge’s failure');
  assert.deepEqual(view.next[0], { kind: 'review_judge', failures: 0, passes: 1, unsure: 1 });
  assert.equal(nextStepText(view.next[0]!), 'Проверить, прав ли судья — 1 успех на перепроверку, 1 с ответом «не знаю»');
  const goalOnly = buildResultView(marked(0, 1, 1, 0));
  assert.deepEqual([goalOnly.agreement.checked, goalOnly.agreement.unsure, goalOnly.agreement.stale], [1, 0, 0]);
  assert.deepEqual(goalOnly.next, [{ kind: 'repeat' }, { kind: 'report' }], 'the whole queue is answered');
});

test('a carried mark alone is stale, and a run with nothing to check says nothing about the judge', () => {
  // A carried mark on a decided failure is stale (03.1: an undecided situation is not in the agreement at all, so its old mark has nothing to be stale against).
  const failed = scored(0, 1);
  const stale = { ...failed, sourceEvidence: { runId: 'run-0', trials: failed.trials, humanReviews: [quick('t-f0', 'fail', 'fail')] } };
  assert.deepEqual([buildResultView(stale).agreement.stale, buildResultView(stale).agreement.checked], [1, 0]);
  assert.equal(judgePart(stale), 'судью ещё не проверяли');
  const undecided = scored(0, 0, 1);
  const forgotten = { ...undecided, sourceEvidence: { runId: 'run-0', trials: undecided.trials, humanReviews: [quick('t-u0', 'fail', 'fail')] } };
  assert.equal(buildResultView(forgotten).agreement.stale, 0, 'a mark on a situation the judge no longer decides counts nowhere');
  assert.equal(judgePart(forgotten), undefined);
  const empty = buildResultView(scored(0, 0, 2));
  assert.equal(judgePart(scored(0, 0, 2)), undefined, 'nothing to check, no judge part');
  assert.deepEqual(head(empty), ['Точность агента: нет данных — ни одна ситуация не измерена', 'Не измерено 2 — судья не уверен — его оценки разошлись']);
});

// ---- F7 and F8: whose judgment the owner overturned, and what is still to be marked. ----
const HEX_ID = '0123abcd-0000-4000-8000-000000000000';

/**
 * Two overturned judgments: a success the owner called a failure and a failure he called a
 * success. The dialogues are recorded the other way round from the cards, so the order of the
 * list proves it follows the record's card order and not the order the marks were written in.
 */
function disagreed(notes: [string, string] = ['Агент пообещал перевод, которого не делает.', 'Клиент назвал номер заявки, агент его не использовал.']): Experiment {
  const cards = [card('pass0', { title: 'Смена реквизитов' }), card('fail0', { title: 'Возврат через терминал' })];
  const trials = [attempt('fail0', { goal: 'fail' }), attempt('pass0', { goal: 'pass' })];
  return run(cards, trials, { id: HEX_ID, humanReviews: [
    { ...quick('t-fail0', 'pass', 'fail'), note: notes[1] },
    { ...quick('t-pass0', 'fail', 'pass'), note: notes[0] },
  ] });
}

test('the disagreements read in the card order of the record, with both directions of the verdict', () => {
  const view = buildResultView(disagreed());
  assert.deepEqual(disagreementRows(view).map(row => row.role), ['heading', 'item', 'muted', 'quote', 'item', 'muted', 'quote']);
  assert.deepEqual(rowsToLines(disagreementRows(view)), [
    'Вы не согласились с судьёй',
    '  Смена реквизитов',
    '    Судья: справился → вы: не справился',
    '    Причина: «Агент пообещал перевод, которого не делает.»',
    '  Возврат через терминал',
    '    Судья: не справился → вы: справился',
    '    Причина: «Клиент назвал номер заявки, агент его не использовал.»',
  ]);
  assert.ok(!view.next.some(step => step.kind === 'review_judge'), 'both queued situations are answered, so nothing is left to mark');
});

// ---- 03.1: marks under the previous counting rule, and a disagreement that overturned one half of a double failure. ----
/** A quick mark the lab would store today: on `metricId`, stamped with the counting rule unless `stamped` is false. */
const ruledQuick = (trialId: string, metricId: string, verdict: HumanReview['verdict'], saw: 'pass' | 'fail', stamped = true, note = 'отметка'): HumanReview =>
  ({ ...review(trialId, verdict, { metricId }), id: `q-${trialId}-${metricId}`, note, source: 'quick', judgeVerdict: saw, ...(stamped ? { countingRules: COUNTING_RULES } : {}) });
const GOAL = 'goal_attainment', RULES = 'prompt_compliance';
/** One double failure `d` (goal and rules failed), optionally beside more ruled cards. */
const doubled = (reviews: HumanReview[], more: Record<string, RuledSpec> = {}) =>
  buildResultView(ruledRun({ d: { goal: 'fail', rules: 'fail' }, ...more }, { id: HEX_ID, humanReviews: reviews }));
const verdictRow = (view: ResultView) => rowsToLines(disagreementRows(view)).find(line => line.startsWith('    Судья:'))?.trim();

test('a mark given under the previous counting rule is counted apart and the situation is asked again', () => {
  const view = doubled([ruledQuick('t-d', GOAL, 'fail', 'fail', false)]);
  assert.equal(view.agreement.staleRule, 1);
  assert.equal(view.agreement.stale, 0, 'an old-rule mark is not a judge change');
  assert.equal(view.agreement.checked, 0, 'nothing was checked yet');
  assert.ok(trustParts(view).includes('судью ещё не проверяли'), trustParts(view).join(' · '));
  assert.deepEqual(view.next[0], { kind: 'review_judge', failures: 1, passes: 0, unsure: 0 }, 'the situation still needs marks under the current rule');
  // A stamped rules mark next to it answers only half: the situation stays out of the count.
  const half = doubled([ruledQuick('t-d', GOAL, 'fail', 'fail', false), ruledQuick('t-d', RULES, 'fail', 'fail')]);
  assert.equal(half.agreement.staleRule, 1);
  assert.equal(half.agreement.checked, 0);
});

test('agreement, doubt, a changed judgment and the previous rule are each counted once', () => {
  const view = doubled([
    ...[GOAL, RULES].map(id => ruledQuick('t-a', id, 'fail', 'fail')),
    ...[GOAL, RULES].map(id => ruledQuick('t-u', id, 'unknown', 'fail')),
    ...[GOAL, RULES].map(id => ruledQuick('t-s', id, 'pass', 'pass')),
    ruledQuick('t-d', GOAL, 'fail', 'fail', false),
  ], { a: { goal: 'fail', rules: 'fail' }, u: { goal: 'fail', rules: 'fail' }, s: { goal: 'fail', rules: 'fail' } });
  const { checked, agreed, unsure, stale, staleRule } = view.agreement;
  assert.deepEqual({ checked, agreed, unsure, stale, staleRule }, { checked: 1, agreed: 1, unsure: 1, stale: 1, staleRule: 1 });
  assert.ok(trustParts(view).includes('с судьёй согласны 1 из 1'), trustParts(view).join(' · '));
  assert.deepEqual(view.next[0], { kind: 'review_judge', failures: 2, passes: 0, unsure: 1 });
  assert.equal(nextStepText(view.next[0]!), 'Проверить, прав ли судья — 2 ошибки ждут вашего «да» или «нет», 1 с ответом «не знаю»');
  for (const text of [...trustParts(view), ...view.next.map(nextStepText)]) assertPlainCopy(text, 'F6');
});

test('a situation the owner reviewed in full is counted as reviewed and leaves the review queue', () => {
  const full = (trialId: string, verdict: HumanReview['verdict'], metricId?: string) => review(trialId, verdict, metricId ? { metricId } : {});
  const base = scored(1, 2);
  const none = buildResultView(base);
  assert.deepEqual(none.reviewed, { situations: 0, contradicted: 0 });
  assert.deepEqual(none.next[0], { kind: 'review_judge', failures: 2, passes: 1, unsure: 0 });
  const one = buildResultView({ ...base, humanReviews: [full('t-f0', 'fail', GOAL)] });
  assert.deepEqual(one.reviewed, { situations: 1, contradicted: 0 });
  assert.equal(one.agreement.checked, 0, 'a full review is not a one-key agreement mark');
  assert.ok(trustParts(one).includes('вы проверили 1 ситуацию'), trustParts(one).join(' · '));
  assert.ok(!trustParts(one).includes('судью ещё не проверяли'));
  assert.deepEqual(one.next[0], { kind: 'review_judge', failures: 1, passes: 1, unsure: 0 }, 'the reviewed failure no longer waits for a mark');
  // A whole-dialogue verdict is a full review too; the word follows the count.
  const two = buildResultView({ ...base, humanReviews: [full('t-f0', 'fail', GOAL), full('t-f1', 'fail')] });
  assert.deepEqual(two.reviewed, { situations: 2, contradicted: 0 }, 'both verdicts agree with the headline');
  assert.ok(trustParts(two).includes('вы проверили 2 ситуации'), trustParts(two).join(' · '));
  assert.deepEqual(two.next[0], { kind: 'review_judge', failures: 0, passes: 1, unsure: 0 });
  const all = buildResultView({ ...base, humanReviews: ['t-f0', 't-f1', 't-p0'].map(id => full(id, id === 't-p0' ? 'pass' : 'fail', GOAL)) });
  assert.equal(all.reviewed.situations, 3);
  assert.deepEqual(all.next, [{ kind: 'repeat' }, { kind: 'report' }], 'nothing is left to mark');
  // Not a full review: a one-key mark, an «invalid» verdict, a rubric that does not decide the situation, a control.
  assert.equal(buildResultView({ ...base, humanReviews: [quick('t-f0', 'fail', 'fail')] }).reviewed.situations, 0);
  assert.equal(buildResultView({ ...base, humanReviews: [full('t-f0', 'invalid')] }).reviewed.situations, 0);
  assert.equal(buildResultView({ ...base, humanReviews: [full('t-f0', 'invalid', GOAL)] }).reviewed.situations, 0);
  assert.equal(buildResultView({ ...base, humanReviews: [full('t-f0', 'fail', 'reply_quality')] }).reviewed.situations, 0);
  const controlled = withControl({ goal: 'pass' });
  assert.equal(buildResultView({ ...controlled, humanReviews: [full('t-ctl', 'pass', GOAL)] }).reviewed.situations, 0, 'a control is never counted');
  // Both halves of a ruled card decide it, so a verdict on the prompt rules is a full review.
  assert.equal(doubled([full('t-d', 'fail', RULES)]).reviewed.situations, 1);
  // A strict legacy card is decided by all its agent rubrics, so a verdict on any of them is a full review.
  const legacy = run([card('l', { metrics: [{ ...replyQuality }] })], [attempt('l', { assessments: [vote('reply_quality', 'fail')] })]);
  assert.equal(buildResultView({ ...legacy, humanReviews: [full('t-l', 'fail', 'reply_quality')] }).reviewed.situations, 1);
  // The owner’s agreement with the judge is said instead when there is one.
  const both = buildResultView({ ...base, humanReviews: [full('t-f0', 'fail', GOAL), quick('t-f1', 'fail', 'fail')] });
  assert.equal(both.reviewed.situations, 1);
  assert.ok(trustParts(both).includes('с судьёй согласны 1 из 1'), trustParts(both).join(' · '));
  assert.ok(!trustParts(both).some(part => part.startsWith('вы проверили')));
  assertPlainCopy(trustParts(two).join(' · '), 'reviewed');
});

test('a whole-dialogue verdict against the headline is named as a contradiction and never moves the number', () => {
  const full = (trialId: string, verdict: HumanReview['verdict'], metricId?: string) => review(trialId, verdict, metricId ? { metricId } : {});
  const base = scored(1, 2);
  const against = buildResultView({ ...base, humanReviews: [full('t-f1', 'pass'), full('t-p0', 'fail')] });
  assert.deepEqual(against.reviewed, { situations: 2, contradicted: 2 });
  assert.deepEqual([against.headline.passed, against.headline.decided], [1, 3], 'a verdict on the whole dialogue never moves the number');
  assert.deepEqual(trustSegments(against).slice(-2), [{ text: 'вы проверили 2 ситуации', warn: false }, { text: 'ваши отметки расходятся с итогом: 2', warn: true }]);
  assertPlainCopy(trustParts(against).join(' · '), 'contradicted');
  // Not a contradiction: a verdict that agrees, an undecided verdict, a verdict on the goal (it moves the number instead),
  // a situation without a verdict of its own, a control.
  assert.deepEqual(buildResultView({ ...base, humanReviews: [full('t-f1', 'fail'), full('t-p0', 'pass')] }).reviewed, { situations: 2, contradicted: 0 });
  assert.deepEqual(buildResultView({ ...base, humanReviews: [full('t-f1', 'unknown')] }).reviewed, { situations: 1, contradicted: 0 });
  const moved = buildResultView({ ...base, humanReviews: [full('t-f0', 'pass', GOAL)] });
  assert.deepEqual(moved.reviewed, { situations: 1, contradicted: 0 });
  assert.deepEqual([moved.headline.passed, moved.headline.decided], [2, 3]);
  const undecided = scored(0, 1, 1);
  assert.deepEqual(buildResultView({ ...undecided, humanReviews: [full('t-u0', 'pass')] }).reviewed, { situations: 1, contradicted: 0 }, 'an undecided situation has nothing to contradict');
  assert.deepEqual(buildResultView({ ...withControl({ goal: 'fail' }), humanReviews: [full('t-ctl', 'pass')] }).reviewed, { situations: 0, contradicted: 0 });
  assert.ok(!trustParts(buildResultView(base)).some(part => part.startsWith('ваши отметки')));
});

test('a disagreement that overturned one half of a double failure names the overturned half', () => {
  const judgeFailed = (goalAnswer: HumanReview['verdict'], rulesAnswer: HumanReview['verdict']) =>
    doubled([ruledQuick('t-d', GOAL, goalAnswer, 'fail', true, 'Причина владельца.'), ruledQuick('t-d', RULES, rulesAnswer, 'fail', true, 'Причина владельца.')]);
  // The verdict word alone would read «не справился → не справился» (CTX-26): the overturned half comes first, then the other.
  assert.equal(verdictRow(judgeFailed('fail', 'pass')), 'Судья: не справился → вы: правила промпта соблюдены; запрос не выполнен');
  assert.equal(verdictRow(judgeFailed('pass', 'fail')), 'Судья: не справился → вы: запрос выполнен; правила промпта нарушены');
  assert.equal(verdictRow(judgeFailed('pass', 'unknown')), 'Судья: не справился → вы: запрос выполнен; про правила промпта не уверены');
  assert.equal(verdictRow(judgeFailed('unknown', 'pass')), 'Судья: не справился → вы: правила промпта соблюдены; про запрос не уверены');
  assert.equal(verdictRow(judgeFailed('pass', 'pass')), 'Судья: не справился → вы: справился', 'a full overturn names no half');
  assert.equal(verdictRow(judgeFailed('fail', 'fail')), undefined, 'agreement is not a disagreement');
  const view = judgeFailed('fail', 'pass');
  assert.deepEqual(view.agreement.disagreements.map(item => [item.judge, item.human, item.overturned]), [['fail', 'fail', [RULES]]]);
  assert.deepEqual(rowsToLines(disagreementRows(view)), ['Вы не согласились с судьёй', '  Ситуация d',
    '    Судья: не справился → вы: правила промпта соблюдены; запрос не выполнен', '    Причина: «Причина владельца.»']);
  assert.equal(accuracyRow(view).text, 'Точность агента: 0% — справился в 0 из 1 ситуации', 'the request is still unmet, so the number does not move');

  const judgePassed = (goalAnswer: HumanReview['verdict'], rulesAnswer: HumanReview['verdict']) => buildResultView(ruledRun({ p: { goal: 'pass', rules: 'pass' } },
    { id: HEX_ID, humanReviews: [ruledQuick('t-p', GOAL, goalAnswer, 'pass', true, 'Причина владельца.'), ruledQuick('t-p', RULES, rulesAnswer, 'pass', true, 'Причина владельца.')] }));
  assert.equal(verdictRow(judgePassed('fail', 'pass')), 'Судья: справился → вы: запрос не выполнен; правила промпта соблюдены');
  assert.equal(verdictRow(judgePassed('pass', 'fail')), 'Судья: справился → вы: правила промпта нарушены; запрос выполнен');
  assert.equal(verdictRow(judgePassed('fail', 'unknown')), 'Судья: справился → вы: запрос не выполнен; про правила промпта не уверены');
  assert.equal(verdictRow(judgePassed('unknown', 'fail')), 'Судья: справился → вы: правила промпта нарушены; про запрос не уверены');
  assert.equal(verdictRow(judgePassed('fail', 'fail')), 'Судья: справился → вы: не справился', 'a full overturn of a pass names no half');
  assert.equal(accuracyRow(judgePassed('fail', 'pass')).text, 'Точность агента: 0% — справился в 0 из 1 ситуации', 'one overturned half is enough to take the pass out of the number');

  // Every row we write is plain Russian (the title row is record text, so only our rows are scanned).
  const jargon = /goal_attainment|prompt_compliance|user_fidelity|unknown|рубрик|протокол|кластер|метрик|judge|seq|agree|disagree|unsure|stale|quick/i;
  for (const item of [judgeFailed('fail', 'pass'), judgeFailed('pass', 'unknown'), judgePassed('unknown', 'fail')]) {
    const line = verdictRow(item)!;
    assert.doesNotMatch(line, jargon, line);
    assertPlainCopy(line, 'F7');
  }
});

test('the agreement queue holds exactly the failures the headline decides, on the phase-1 and the rules shape of fae4ee59', () => {
  const goalOnly = buildResultView(acquiringShape());
  assert.equal(goalOnly.agreement.queueFailures.length, 9, 'deviated0 and unclear0 are «не измерено», so they are not queued');
  assert.deepEqual(goalOnly.agreement.sampledPasses, [], 'deviated1 is unusable, so it is not sampled');
  assert.equal(goalOnly.agreement.queueFailures.length, goalOnly.headline.decided - goalOnly.headline.passed);
  const rules = buildResultView(acquiringRulesShape());
  assert.equal(rules.headline.decided - rules.headline.passed, 10);
  assert.equal(rules.agreement.queueFailures.length, rules.headline.decided - rules.headline.passed, 'nine double failures and the rules-only failure of split0');
  assert.ok(rules.agreement.queueFailures.includes('t-split0'), 'an undecided goal next to broken rules is a rules-only failure with one target');
  assert.ok(!rules.agreement.queueFailures.includes('t-deviated0') && !rules.agreement.queueFailures.includes('t-unclear0'));
  assert.deepEqual(rules.agreement.sampledPasses, []);
});

test('the owner’s reason is shown whole: whitespace runs become one space and 600 characters survive', () => {
  const long = 'Клиент назвал номер заявки, агент его не использовал. '.repeat(20).slice(0, 600).trimEnd().padEnd(600, 'о');
  assert.equal(long.length, 600);
  const rows = disagreementRows(buildResultView(disagreed(['Агент\tответил\n\nне  по правилам.', long])));
  const lines = rowsToLines(rows);
  assert.equal(lines[3], '    Причина: «Агент ответил не по правилам.»');
  assert.equal(lines[6], `    Причина: «${long}»`);
  assert.equal(lines[6]!.length, 600 + '    Причина: «»'.length, 'nothing was cut from the reason');
  const plain = plainText(rows, MAX_WIDTH);
  assert.ok(!plain.includes('…'), plain);
  assert.ok(plain.split('\n').map(line => line.trim()).join(' ').includes(`Причина: «${long}»`), 'the wrapped reason keeps every word');
});

test('the next step asks for the owner’s check while a queued situation is unmarked or doubted, and only then', () => {
  const open = buildResultView(run([card('f0')], [attempt('f0', { goal: 'fail' })], { id: HEX_ID }));
  assert.deepEqual(disagreementRows(open), []);
  assert.deepEqual(open.next, [{ kind: 'review_judge', failures: 1, passes: 0, unsure: 0 }, { kind: 'repeat' }, { kind: 'report' }]);
  assert.deepEqual(nextRows(open, 'board').map(row => [row.role, row.text]), [
    ['heading', 'Дальше'],
    ['next:first', 'Проверить, прав ли судья — 1 ошибка ждёт вашего «да» или «нет»'],
    ['next', 'Повторить прогон на новой версии агента'],
    ['next', 'Отчёт для заказчика'],
  ]);
  assert.deepEqual(nextRows(open, 'chat'), [{ role: 'next:first', indent: 0, text: 'Дальше: проверьте, прав ли судья, — скажите «покажи ошибку 1».' }]);
  const two = [card('f0'), card('f1')];
  const failures = [attempt('f0', { goal: 'fail' }), attempt('f1', { goal: 'fail' })];
  const answered = buildResultView(run(two, failures, { id: HEX_ID, humanReviews: [quick('t-f0', 'fail', 'fail'), quick('t-f1', 'fail', 'fail')] }));
  assert.deepEqual(answered.next, [{ kind: 'repeat' }, { kind: 'report' }], 'every queued situation is answered');
  // «Не могу сказать» keeps a situation in the queue: it is doubt, not a decision.
  const doubted = buildResultView(run(two, failures, { id: HEX_ID, humanReviews: [quick('t-f0', 'fail', 'fail'), quick('t-f1', 'unknown', 'fail')] }));
  assert.deepEqual(doubted.next[0], { kind: 'review_judge', failures: 0, passes: 0, unsure: 1 });
  assert.equal(nextStepText(doubted.next[0]!), 'Проверить, прав ли судья — 1 с ответом «не знаю»');
  const nothing = buildResultView(run([card('u0')], [attempt('u0', { goal: 'unknown', goalRationale: SPLIT })], { id: HEX_ID }));
  assert.deepEqual(nothing.next, [{ kind: 'why_unmeasured', count: 1 }], 'the judge decided nothing, so there is nothing to mark');
});

test('CLI summary lists the owner’s disagreement after every error', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-disagreement-cli-'));
  try {
    const record = clustered();
    record.id = HEX_ID;
    record.scenarios[1]!.title = 'Возврат через терминал';
    // The owner overturns one failure and leaves the other two in the queue.
    record.humanReviews = [{ ...quick('t-f0', 'pass', 'fail'), note: 'Судья не учёл уточнение клиента.' }];
    await saveAll(directory, [record]);
    const { code, stdout, stderr } = await summary(directory, record.id);
    assert.equal(code, 0, stderr);
    assert.equal(stdout, `${screen(buildResultView(record))}\n`);
    const lines = stdout.split('\n');
    const all = lines.indexOf(' Все ошибки');
    const at = lines.indexOf(' Вы не согласились с судьёй');
    const next = lines.indexOf(' Дальше');
    assert.ok(all > 0 && at > all && next > at, stdout);
    assert.equal(lines[at - 1], '', 'a blank line separates the block');
    assert.deepEqual(lines.slice(at, at + 4), [
      ' Вы не согласились с судьёй',
      '   Возврат через терминал',
      '     Судья: не справился → вы: справился',
      '     Причина: «Судья не учёл уточнение клиента.»',
    ]);
    assert.equal(lines[next + 1], '   Проверьте, прав ли судья: откройте прогон в Pi (/agent-lab)', 'two failures still wait for a mark');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/*
 * result-text.ts leaves escaping to each surface; the CLI escapes every row before layout, so a
 * terminal sequence in record text — a situation title, the owner's reason — never reaches the terminal.
 */
test('CLI summary never lets a terminal sequence from a title or the owner’s reason reach the terminal', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-escape-cli-'));
  try {
    const escape = String.fromCharCode(27);
    const record = clustered();
    record.scenarios[3]!.title = `Ситуация ${escape}[31mf2`;
    record.humanReviews = [{ ...quick('t-f0', 'pass', 'fail'), note: `Судья ${escape}[31mне учёл уточнение клиента.` }];
    await saveAll(directory, [record]);
    const { code, stdout, stderr } = await summary(directory, record.id);
    assert.equal(code, 0, stderr);
    assert.ok(!stdout.includes(escape), 'terminal sequences from record text never reach the output');
    assert.ok(stdout.includes('Судья не учёл уточнение клиента.'), 'the visible words stay');
    // f0 was overturned by the owner, so f2 is the second error.
    assert.ok(stdout.split('\n').some(line => line.trim() === '✗ 2  Ситуация f2'), stdout);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** The same record with every situation titled in Russian: a card title is record text, not our copy. */
const inRussian = (record: Experiment): Experiment =>
  ({ ...record, scenarios: record.scenarios.map((scenario, i) => ({ ...scenario, title: `Ситуация №${i + 1}` })) });

test('the trust line, the disagreements and the next steps are plain Russian on every band', () => {
  const tails = { ...scored(1, 2), humanReviews: [quick('t-f0', 'fail', 'fail'), quick('t-f1', 'unknown', 'fail'), quick('t-p0', 'pass', 'fail')] };
  const bands: [string, Experiment][] = [
    ['M = 0', scored(1, 1)],
    ['M = 1', { ...scored(1, 1), humanReviews: [quick('t-f0', 'fail', 'fail')] }],
    ['M = 10', marked(1, 9, 8, 1)],
    ['M = 20', marked(3, 17, 16, 2)],
    ['M with doubt and a changed judgment', tails],
    ['nothing decided', scored(0, 0, 2)],
  ];
  for (const [label, record] of bands) {
    const view = buildResultView(inRussian(record));
    assert.ok(trustParts(view).length, `${label} prints a trust line`);
    for (const text of [...trustParts(view), ...nextRows(view, 'board').map(row => row.text), ...nextRows(view, 'chat').map(row => row.text)]) assertPlainCopy(text, label);
  }
  for (const line of rowsToLines(disagreementRows(buildResultView(inRussian(disagreed()))))) assertPlainCopy(line, 'F7');
  // The scan itself: it catches machine words and lets the allowed key letters and command through.
  assert.throws(() => assertPlainCopy('Согласие с судьёй: метрика сходится.'), /метрик/);
  assert.throws(() => assertPlainCopy('Оценка goal_attainment не сошлась.'), /goal/);
  assert.throws(() => assertPlainCopy('Отметка stale после смены судьи.'), /stale/);
  assertPlainCopy('y · n · s — согласие с судьёй');
  assertPlainCopy('Откройте в Pi: /agent-lab 0123abcd');
});

test('the trust line is one row that carries its parts, and its role says whether the sample is small', () => {
  const small = headRows(buildResultView(scored(1, 2)));
  assert.deepEqual(small.map(row => row.role), ['accuracy:bad', 'trust:small']);
  assert.equal(small[1]!.text, small[1]!.parts!.join(' · '));
  assert.deepEqual(headRows(buildResultView(scored(10, 10))).map(row => row.role), ['accuracy:warn', 'trust']);
  assert.deepEqual(headRows(buildResultView(scored(20, 0))).map(row => row.role), ['accuracy:good', 'trust']);
  // A narrow screen breaks the line only between its parts, each broken line ending with «·».
  const broken = plainText([small[1]!], 40).split('\n');
  assert.ok(broken.length > 1, broken.join('\n'));
  assert.ok(broken.slice(0, -1).every(line => line.endsWith('·')), broken.join('\n'));
});
