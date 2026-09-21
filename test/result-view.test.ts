import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyUsage, goalAttainment, promptCompliance, replyQuality, settingsSchema, simulatorFidelity, type Experiment, type HumanReview, type JudgeAudit, type MetricAssessment, type Trial, type ValidationExclusion } from '../src/contracts.js';
import { agreementNextStep, agreementSectionLines, allFailuresPointer, allFailuresTitle, buildResultView, causeSection, disagreementRows, disagreementTitle, DISAGREEMENT_BOARD_TITLE, failureListRows, NOT_MEASURED_TEXT, resultViewLines, resultViewRows, SECTION_TEXT, unmeasuredControl, wilson } from '../src/result-view.js';
import { assertPlainCopy } from './helpers/copy-check.js';
import { rowsToLines } from '../src/explain.js';
import { compareRuns, NOT_MEASURED_CODES, stabilityBetweenRuns, type NotMeasuredCode } from '../src/comparison.js';
import { AGREED_RATIONALE_PREFIX, GOAL_UNSUPPORTED_RATIONALE, SPLIT_RATIONALE_PREFIX } from '../src/judge.js';
import { ExperimentStore } from '../src/store.js';
import { ExperimentLab } from '../src/experiment.js';
import { embeddedBefore, evidenceBundle } from '../src/artifacts.js';
import { sealJudgeReceipt } from '../src/judge.js';
import { sourceIdentity } from '../src/normalize.js';
import { COUNTING_RULES } from '../src/outcomes.js';

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
  // Phase 03.1: the fixture cards carry no prompt rules, so the breakdown row says so (C-304).
  'Правил промпта в наборе нет — считается только запрос.',
  'Мало данных: реальная доля где-то от 0% до 30%.',
  'Не измерено: 4 — чаще всего симулятор отклонился от диалога (2).',
  '  ? Ситуация deviated0 — симулятор отклонился от диалога',
  '  ? Ситуация deviated1 — симулятор отклонился от диалога',
  '  ? Ситуация unclear0 — судья не уверен, что симулятор держался диалога',
  '  ? Ситуация split0 — судья не уверен: голоса разошлись',
  'Контроль: не задан.',
  // The acquiring run has 9 usable goal failures queued for review and no pass in the sample (the
  // only recorded pass, deviated1, is unusable), so the agreement row is printed before the first
  // mark because the queue is not empty (F6, CR-01).
  'Согласие с судьёй: ещё не проверено.',
  'Из 40 диалогов в набор вошли 13. Не вошли 27: в правилах нет ожидаемого ответа — 21, нужны данные клиента — 6.',
];

test('the headline names passed over decided situations and the Wilson caveat for a small sample', () => {
  const view = buildResultView(scored(3, 9));
  assert.equal(view.headline.text, 'Справился в 3 из 12 проверенных ситуаций — 25%.');
  assert.equal(view.headline.smallSample, 'Мало данных: реальная доля где-то от 9% до 53%.');
  assert.deepEqual(resultViewLines(view).slice(0, 3), [view.headline.text, 'Правил промпта в наборе нет — считается только запрос.', view.headline.smallSample]);
  assert.equal(view.countingRules, 'goal-and-rules-v2');
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
  // CR-01: the only recorded pass (deviated1) is unusable, so there is no sample and the pass part reads «успехов нет».
  assert.ok(block.includes('Согласие с судьёй: 1 из 1 проверенных · мало проверок (провалы: 1 из 1 · успехов нет).'), block.join('\n'));
  assert.ok(block.includes('  Цель — согласие в 9 случаях из 10.'), block.join('\n'));
  assert.deepEqual(block, resultViewLines(buildResultView(stored), { details: true }));
  const view = buildResultView(stored);
  assert.equal(view.agreement.queueFailures.length, 9, '9 failed goals; the unmeasured deviated0 and unclear0 are not queued (CR-01)');
  assert.deepEqual(view.agreement.sampledPasses, [], 'the single recorded pass is unusable, so the sample is empty');
  assert.equal(view.agreement.queueFailures.length, view.headline.decided - view.headline.passed, 'the queue holds exactly the failures the headline counts');
});

test('a quick «не согласен» moves the headline and is counted against the judge', { timeout: 20000 }, async () => {
  const { block, stored } = await quickMarked('pass', 'Проверка: судья не учёл уточнение клиента.');
  assert.equal(block[0], 'Справился в 1 из 9 проверенных ситуаций — 11%.');
  assert.ok(block.includes('Согласие с судьёй: 0 из 1 проверенных · мало проверок (провалы: 0 из 1 · успехов нет).'), block.join('\n'));
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
  // Phase 03.1: the C-304 row sits between the number and the caveat (the fixture cards carry no prompt rules).
  assert.deepEqual(lines.slice(0, 4), [view.headline.text, 'Правил промпта в наборе нет — считается только запрос.', view.headline.smallSample, 'Нестабильных: 1 (повтор прогона a1b2c3d4).']);
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
    'Правил промпта в наборе нет — считается только запрос.',
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

// ---- Phase 03.1: the control is decided by its goal alone; a counted card by the goal and the prompt rules. ----
const RULED_METRICS = [{ ...goalAttainment }, { ...promptCompliance }, { ...simulatorFidelity }];
/** One reactive attempt whose request was met but which broke a prompt rule (the shape of the stored control ae812a24). */
const metButBroke = (id: string) => attempt(id, { assessments: [vote('goal_attainment', 'pass'), vote('prompt_compliance', 'fail'), vote('user_fidelity', 'pass')] });

test('a control that met its goal but broke a rule still passes as a control, while the same counted card fails the headline', () => {
  const record = run([card('ctl', { metrics: RULED_METRICS }), card('c', { metrics: RULED_METRICS })], [metButBroke('ctl'), metButBroke('c')],
    { positiveControlScenarioIds: ['ctl'] });
  const view = buildResultView(record);
  assert.equal(view.headline.text, 'Справился в 0 из 1 проверенной ситуации — 0%.');
  assert.deepEqual([view.headline.passed, view.headline.decided], [0, 1], 'the control is left out of the number');
  const control = view.cards.find(item => item.scenarioId === 'ctl')!;
  assert.deepEqual([control.outcome, control.goal, control.rules, control.control], ['pass', 'pass', 'fail', true]);
  assert.deepEqual(view.control.cards.map(item => [item.outcome, item.rules]), [['pass', 'fail']]);
  assert.equal(view.control.warning, null, 'a broken rule on the control is shown, never the «числу пока не верить» alarm');
  const counted = view.cards.find(item => item.scenarioId === 'c')!;
  assert.deepEqual([counted.outcome, counted.goal, counted.rules], ['fail', 'pass', 'fail']);
  assert.equal(view.countingRules, 'goal-and-rules-v2');
  // The phase-1 fixtures carry no prompt rules: their cards say so instead of inventing a rules result.
  const plain = buildResultView(scored(1, 1));
  assert.deepEqual(plain.cards.map(item => [item.goal, item.rules]), [['pass', 'none'], ['fail', 'none']]);
});

// ---- Phase 03.1: the breakdown row under the headline and the control line with the rules result. ----
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
const BREAKDOWN_TEXT = (view: ReturnType<typeof buildResultView>) => view.breakdown.text;

test('the breakdown row counts met requests and broken rules over the counted cards, and names the one most frequent rule with its count', () => {
  const plain = buildResultView(ruledRun({ a: { goal: 'pass', rules: 'fail' }, b: { goal: 'fail', rules: 'fail' }, u: { goal: 'pass', rules: 'fail', fidelity: 'fail' } }));
  assert.equal(plain.headline.text, 'Справился в 0 из 2 проверенных ситуаций — 0%.');
  assert.deepEqual(plain.breakdown, { goal: { met: 1, decided: 2 }, rules: { broken: 2, decided: 2, commonRule: null, commonRuleCount: 0 }, withoutRules: 0,
    text: 'Запрос выполнен: 1 из 2. Правила промпта нарушены: 2 из 2.' }, 'an unusable card counts in neither part');
  const named = buildResultView(ruledRun({ a: { goal: 'pass', rules: 'fail', rationale: BROKE_1 }, b: { goal: 'fail', rules: 'fail', rationale: BROKE_1 } }));
  assert.equal(BREAKDOWN_TEXT(named), 'Запрос выполнен: 1 из 2. Правила промпта нарушены: 2 из 2, из них правило 1 — 2.');
  assert.deepEqual([named.breakdown.rules.commonRule, named.breakdown.rules.commonRuleCount], [1, 2]);
  const tie = buildResultView(ruledRun({ a: { goal: 'pass', rules: 'fail', rationale: BROKE_1 }, b: { goal: 'fail', rules: 'fail', rationale: BROKE_2 } }));
  assert.equal(BREAKDOWN_TEXT(tie), 'Запрос выполнен: 1 из 2. Правила промпта нарушены: 2 из 2.', 'a tie names no rule');
  const top = buildResultView(ruledRun({ a: { goal: 'pass', rules: 'fail', rationale: BROKE_1 }, b: { goal: 'fail', rules: 'fail', rationale: BROKE_1 },
    c: { goal: 'fail', rules: 'fail', rationale: BROKE_2 }, d: { goal: 'fail', rules: 'fail', rationale: BROKE_UNNAMED }, e: { goal: 'pass', rules: 'pass' } }));
  assert.equal(BREAKDOWN_TEXT(top), 'Запрос выполнен: 2 из 5. Правила промпта нарушены: 4 из 5, из них правило 1 — 2.', 'the strict top count names the rule');
  assert.equal(top.headline.text, 'Справился в 1 из 5 проверенных ситуаций — 20%.');
  // Controls are never counted in A, B, C, D or K.
  const controlled = buildResultView(ruledRun({ a: { goal: 'pass', rules: 'fail', rationale: BROKE_1 }, b: { goal: 'fail', rules: 'fail', rationale: BROKE_1 },
    ctl: { goal: 'pass', rules: 'fail', rationale: BROKE_2, control: true } }));
  assert.equal(BREAKDOWN_TEXT(controlled), 'Запрос выполнен: 1 из 2. Правила промпта нарушены: 2 из 2, из них правило 1 — 2.');
  // Goal unknown + rules fail: the request is undecided, the broken rule still counts.
  const undecidedGoal = buildResultView(ruledRun({ a: { goal: 'unknown', rules: 'fail' }, b: { goal: 'pass', rules: 'unknown' } }));
  assert.deepEqual(undecidedGoal.breakdown.goal, { met: 1, decided: 1 });
  assert.deepEqual([undecidedGoal.breakdown.rules.broken, undecidedGoal.breakdown.rules.decided], [1, 1]);
});

test('a mixed set names the cards without prompt rules; a goal-only set says the rules are absent; legacy and never-run sets print nothing', () => {
  const mixed = buildResultView(ruledRun({ a: { goal: 'pass', rules: 'fail' }, b: { goal: 'fail', rules: 'none' } }));
  assert.equal(BREAKDOWN_TEXT(mixed), 'Запрос выполнен: 1 из 2. Правила промпта нарушены: 1 из 1. Без правил промпта: 1 — по ним считается только запрос.');
  assert.equal(mixed.breakdown.withoutRules, 1);
  const goalOnly = buildResultView(scored(3, 9));
  assert.equal(BREAKDOWN_TEXT(goalOnly), 'Правил промпта в наборе нет — считается только запрос.');
  assert.deepEqual(goalOnly.breakdown.goal, { met: 3, decided: 12 });
  assert.deepEqual(goalOnly.breakdown.rules, { broken: 0, decided: 0, commonRule: null, commonRuleCount: 0 });
  const legacy = buildResultView(run([card('c', { metrics: [{ ...replyQuality }] })], [attempt('c', { assessments: [vote('reply_quality', 'fail')] })]));
  assert.equal(legacy.headline.decided, 1, 'the legacy card is still decided by the strict rule');
  assert.equal(BREAKDOWN_TEXT(legacy), null);
  const draft = buildResultView(run([card('a', { metrics: RULED_METRICS })], [], { phase: 'review' }));
  assert.equal(BREAKDOWN_TEXT(draft), null);
  assert.deepEqual(resultViewLines(draft), ['Прогон ещё не запускался.', 'Контроль: не задан.']);
  const nothingDecided = buildResultView(scored(0, 0, 2));
  assert.equal(BREAKDOWN_TEXT(nothingDecided), null, 'no decided part, no row');
  // The row sits right under the number, before the small-sample caveat, as an ordinary line.
  const rows = resultViewRows(mixed);
  assert.deepEqual(rows.slice(0, 3).map(row => [row.role, row.indent, row.text]), [
    ['lead', 0, 'Справился в 0 из 2 проверенных ситуаций — 0%.'],
    ['line', 0, mixed.breakdown.text],
    ['line', 0, mixed.headline.smallSample],
  ]);
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

test('the acquiring run under the new rule reads 0 of 10 with the breakdown 0 of 9 and 10 of 10 right under it', () => {
  const view = buildResultView(acquiringRulesShape());
  assert.deepEqual(resultViewLines(view).slice(0, 2), ['Справился в 0 из 10 проверенных ситуаций — 0%.', 'Запрос выполнен: 0 из 9. Правила промпта нарушены: 10 из 10.']);
  assert.equal(view.notMeasured.total, 3);
  assert.deepEqual(view.notMeasured.reasons.map(reason => [reason.code, reason.count]), [['simulator_deviated', 2], ['simulator_unclear', 1]]);
  assert.equal(view.failures.length, 10);
  assert.deepEqual(new Set(view.failures.map(item => item.kind)), new Set(['both', 'rules']), 'nine double failures and one rules-only failure');
  // A double failure can be a cause example.
  const record = acquiringRulesShape();
  record.failureModes = [{ id: 'support', name: 'Отправляет клиента в поддержку', description: 'd', trialIds: ['t-both0', 't-both1'] }];
  assert.equal(buildResultView(record).topCauses[0]?.example.kind, 'both');
});

test('a control with prompt rules names both facts on its line; a broken rule there is never the alarm', () => {
  const line = (specs: Record<string, RuledSpec>) => resultViewLines(buildResultView(ruledRun({ c: { goal: 'fail', rules: 'pass' }, ...specs }))).find(row => row.startsWith('Контроль:'));
  const warning = (specs: Record<string, RuledSpec>) => buildResultView(ruledRun({ c: { goal: 'fail', rules: 'pass' }, ...specs })).control.warning;
  assert.equal(line({ ctl: { goal: 'pass', rules: 'fail', control: true } }), 'Контроль: запрос выполнен ✓ · правила промпта нарушены ✗');
  assert.equal(warning({ ctl: { goal: 'pass', rules: 'fail', control: true } }), null);
  assert.equal(line({ ctl: { goal: 'pass', rules: 'pass', control: true } }), 'Контроль: запрос выполнен ✓ · правила промпта соблюдены ✓');
  assert.equal(line({ ctl: { goal: 'pass', rules: 'unknown', control: true } }), 'Контроль: запрос выполнен ✓ · правила промпта не измерены');
  assert.equal(line({ ctl: { goal: 'fail', rules: 'fail', control: true } }), 'Контроль: запрос не выполнен ✗ · правила промпта нарушены ✗');
  assert.equal(warning({ ctl: { goal: 'fail', rules: 'fail', control: true } }), CONTROL_WARNING, 'the failed goal is still the alarm');
  assert.equal(line({ ctl: { goal: 'unknown', rules: 'fail', control: true } }), 'Контроль: не измерен — судья не уверен: голоса разошлись.', 'an undecided goal keeps the phase-1 text');
  assert.equal(line({ ctl: { goal: 'pass', rules: 'fail', control: true }, ctl2: { goal: 'pass', rules: 'pass', control: true } }),
    'Контроль: пройдено 2 из 2 ✓ · правила промпта нарушены в 1 из 2');
  assert.equal(line({ ctl: { goal: 'pass', rules: 'pass', control: true }, ctl2: { goal: 'pass', rules: 'pass', control: true } }),
    'Контроль: пройдено 2 из 2 ✓ · правила промпта соблюдены в 2 из 2');
  assert.equal(line({ ctl: { goal: 'pass', rules: 'pass', control: true }, ctl2: { goal: 'fail', rules: 'fail', control: true } }),
    'Контроль: пройдено 1 из 2 · правила промпта нарушены в 1 из 2.');
  // A control without prompt rules keeps the phase-1 line byte for byte.
  assert.equal(line({ ctl: { goal: 'pass', rules: 'none', control: true } }), 'Контроль: пройден ✓');
  assert.equal(line({ ctl: { goal: 'fail', rules: 'none', control: true } }), 'Контроль: не пройден ✗');
  assert.equal(line({ ctl: { goal: 'pass', rules: 'none', control: true }, ctl2: { goal: 'fail', rules: 'none', control: true } }), 'Контроль: пройдено 1 из 2.');
  const jargon = /goal_attainment|prompt_compliance|user_fidelity|unknown|рубрик|протокол|кластер|метрик|judge|seq/i;
  for (const text of [line({ ctl: { goal: 'pass', rules: 'fail', control: true } })!, BREAKDOWN_TEXT(buildResultView(ruledRun({ a: { goal: 'pass', rules: 'fail', rationale: BROKE_1 } })))!]) {
    assert.doesNotMatch(text, jargon, text);
    assertPlainCopy(text);
  }
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
    'Справился в 2 из 3 проверенных ситуаций — 67%.', 'Правил промпта в наборе нет — считается только запрос.',
    'Мало данных: реальная доля где-то от 21% до 94%.', 'Контроль: не задан.',
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
  // A carried mark on a decided failure is stale (03.1: an undecided situation is not in the agreement at all, so its old mark has nothing to be stale against).
  const failed = scored(0, 1);
  const stale = { ...failed, sourceEvidence: { runId: 'run-0', trials: failed.trials, humanReviews: [quick('t-f0', 'fail', 'fail')] } };
  const lines = resultViewLines(buildResultView(stale));
  assert.equal(agreementRow(stale), 'Согласие с судьёй: ещё не проверено.');
  assert.ok(lines.includes('  Отметки устарели после смены судьи: 1.'));
  assert.ok(!lines.some(line => line.startsWith('  Цель')));
  const undecided = scored(0, 0, 1);
  const forgotten = { ...undecided, sourceEvidence: { runId: 'run-0', trials: undecided.trials, humanReviews: [quick('t-u0', 'fail', 'fail')] } };
  assert.ok(resultViewLines(buildResultView(forgotten)).every(line => !line.includes('Согласие с судьёй') && !line.includes('устарели')), 'a mark on a situation the judge no longer decides prints nothing');
  const empty = buildResultView(scored(0, 0, 2));
  assert.ok(resultViewLines(empty, { details: true }).every(line => !line.includes('Согласие с судьёй')), 'nothing to check prints no agreement row');
  assert.deepEqual(resultViewLines(empty), ['Проверенных ситуаций нет.', 'Не измерено: 2 — судья не уверен: голоса разошлись.',
    '  ? Ситуация u0 — судья не уверен: голоса разошлись', '  ? Ситуация u1 — судья не уверен: голоса разошлись', 'Контроль: не задан.']);
});

// ---- F7 and F8: whose judgment the owner overturned, and where the rest of the queue is marked. ----
const HEX_ID = '0123abcd-0000-4000-8000-000000000000';
const NEXT_STEP = 'Отметить согласие с судьёй можно в Pi: /agent-lab 0123abcd, раздел 3.';

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
  assert.deepEqual(disagreementRows(view).map(row => row.role),
    ['dis-title', 'dis-verdicts', 'dis-reason', 'blank', 'dis-title', 'dis-verdicts', 'dis-reason']);
  assert.deepEqual(rowsToLines(disagreementRows(view)), [
    '! Смена реквизитов',
    '  Судья: справился → владелец: не справился',
    '  Причина: «Агент пообещал перевод, которого не делает.»',
    '',
    '! Возврат через терминал',
    '  Судья: не справился → владелец: справился',
    '  Причина: «Клиент назвал номер заявки, агент его не использовал.»',
  ]);
  assert.equal(disagreementTitle(2), 'Несогласия с судьёй (2):');
  assert.equal(DISAGREEMENT_BOARD_TITLE, 'НЕСОГЛАСИЯ С СУДЬЁЙ');
  assert.deepEqual(agreementSectionLines(view), ['Несогласия с судьёй (2):', ...rowsToLines(disagreementRows(view))]);
  assert.equal(agreementNextStep(view), null, 'both queued situations are answered, so nothing is left to mark');
});

// ---- 03.1: marks under the previous counting rule, and a disagreement that overturned one half of a double failure. ----
/** A quick mark the lab would store today: on `metricId`, stamped with the counting rule unless `stamped` is false. */
const ruledQuick = (trialId: string, metricId: string, verdict: HumanReview['verdict'], saw: 'pass' | 'fail', stamped = true, note = 'отметка'): HumanReview =>
  ({ ...review(trialId, verdict, { metricId }), id: `q-${trialId}-${metricId}`, note, source: 'quick', judgeVerdict: saw, ...(stamped ? { countingRules: COUNTING_RULES } : {}) });
const GOAL = 'goal_attainment', RULES = 'prompt_compliance';
const RULE_STALE_ROW = '  Отметки поставлены по прежнему правилу подсчёта: 1. Отметьте заново.';
/** One double failure `d` (goal and rules failed), optionally beside more ruled cards; `HEX_ID` so the F8 row can be scanned. */
const doubled = (reviews: HumanReview[], more: Record<string, RuledSpec> = {}) =>
  buildResultView(ruledRun({ d: { goal: 'fail', rules: 'fail' }, ...more }, { id: HEX_ID, humanReviews: reviews }));
const verdictRow = (view: ReturnType<typeof buildResultView>) => rowsToLines(disagreementRows(view)).find(line => line.startsWith('  Судья:'));

test('a mark given under the previous counting rule is named in its own tail row and told to be made again', () => {
  const view = doubled([ruledQuick('t-d', GOAL, 'fail', 'fail', false)]);
  assert.equal(view.agreement.staleRule, 1);
  const lines = resultViewLines(view);
  const at = lines.indexOf('Согласие с судьёй: ещё не проверено.');
  assert.ok(at >= 0, lines.join('\n'));
  assert.equal(lines[at + 1], RULE_STALE_ROW);
  assert.ok(!lines.includes('  Отметки устарели после смены судьи: 1.'), 'an old-rule mark is not a judge change');
  assert.ok(!lines.some(line => line.startsWith('  Цель')), 'nothing was checked yet');
  assert.equal(agreementNextStep(view), NEXT_STEP, 'the situation still needs marks under the current rule');
  // A stamped goal mark next to it answers only half: the row and the next step stay.
  const half = doubled([ruledQuick('t-d', GOAL, 'fail', 'fail', false), ruledQuick('t-d', RULES, 'fail', 'fail')]);
  assert.ok(resultViewLines(half).includes(RULE_STALE_ROW));
  assert.equal(half.agreement.checked, 0);
});

test('the agreement tail rows keep one order: the target, the doubt, the judge change, the previous rule', () => {
  const view = doubled([
    ...[GOAL, RULES].map(id => ruledQuick('t-a', id, 'fail', 'fail')),
    ...[GOAL, RULES].map(id => ruledQuick('t-u', id, 'unknown', 'fail')),
    ...[GOAL, RULES].map(id => ruledQuick('t-s', id, 'pass', 'pass')),
    ruledQuick('t-d', GOAL, 'fail', 'fail', false),
  ], { a: { goal: 'fail', rules: 'fail' }, u: { goal: 'fail', rules: 'fail' }, s: { goal: 'fail', rules: 'fail' } });
  const lines = resultViewLines(view);
  assert.deepEqual(lines.slice(lines.findIndex(line => line.startsWith('Согласие')), lines.findIndex(line => line.startsWith('Согласие')) + 5), [
    'Согласие с судьёй: 1 из 1 проверенных · мало проверок (провалы: 1 из 1 · успехов нет).',
    '  Цель — согласие в 9 случаях из 10.',
    '  Человек не смог решить: 1.',
    '  Отметки устарели после смены судьи: 1.',
    RULE_STALE_ROW,
  ]);
  for (const line of lines.filter(line => line.startsWith('  ') && !line.startsWith('  ?'))) assertPlainCopy(line, 'F6');
});

test('a disagreement that overturned one half of a double failure names both halves, the overturned one first', () => {
  const judgeFailed = (goalAnswer: HumanReview['verdict'], rulesAnswer: HumanReview['verdict']) =>
    doubled([ruledQuick('t-d', GOAL, goalAnswer, 'fail', true, 'Причина владельца.'), ruledQuick('t-d', RULES, rulesAnswer, 'fail', true, 'Причина владельца.')]);
  assert.equal(verdictRow(judgeFailed('fail', 'pass')), '  Судья: не справился → владелец: правила промпта соблюдены; запрос не выполнен');
  assert.equal(verdictRow(judgeFailed('pass', 'fail')), '  Судья: не справился → владелец: запрос выполнен; правила промпта нарушены');
  assert.equal(verdictRow(judgeFailed('pass', 'unknown')), '  Судья: не справился → владелец: запрос выполнен; про правила промпта не уверен');
  assert.equal(verdictRow(judgeFailed('unknown', 'pass')), '  Судья: не справился → владелец: правила промпта соблюдены; про запрос не уверен');
  assert.equal(verdictRow(judgeFailed('pass', 'pass')), '  Судья: не справился → владелец: справился', 'a full overturn keeps C-62 byte for byte');
  assert.equal(verdictRow(judgeFailed('fail', 'fail')), undefined, 'agreement is not a disagreement');
  const view = judgeFailed('fail', 'pass');
  assert.deepEqual(rowsToLines(disagreementRows(view)), ['! Ситуация d', '  Судья: не справился → владелец: правила промпта соблюдены; запрос не выполнен', '  Причина: «Причина владельца.»']);
  assert.equal(view.headline.text, 'Справился в 0 из 1 проверенной ситуации — 0%.', 'the request is still unmet, so the number does not move');

  const judgePassed = (goalAnswer: HumanReview['verdict'], rulesAnswer: HumanReview['verdict']) => buildResultView(ruledRun({ p: { goal: 'pass', rules: 'pass' } },
    { id: HEX_ID, humanReviews: [ruledQuick('t-p', GOAL, goalAnswer, 'pass', true, 'Причина владельца.'), ruledQuick('t-p', RULES, rulesAnswer, 'pass', true, 'Причина владельца.')] }));
  assert.equal(verdictRow(judgePassed('fail', 'pass')), '  Судья: справился → владелец: запрос не выполнен; правила промпта соблюдены');
  assert.equal(verdictRow(judgePassed('pass', 'fail')), '  Судья: справился → владелец: правила промпта нарушены; запрос выполнен');
  assert.equal(verdictRow(judgePassed('fail', 'unknown')), '  Судья: справился → владелец: запрос не выполнен; про правила промпта не уверен');
  assert.equal(verdictRow(judgePassed('unknown', 'fail')), '  Судья: справился → владелец: правила промпта нарушены; про запрос не уверен');
  assert.equal(verdictRow(judgePassed('fail', 'fail')), '  Судья: справился → владелец: не справился', 'a full overturn of a pass keeps C-62');
  assert.equal(judgePassed('fail', 'pass').headline.text, 'Справился в 0 из 1 проверенной ситуации — 0%.', 'one overturned half is enough to take the pass out of the number');

  // Every new row is plain Russian (the title row is record text, so only our rows are scanned).
  const jargon = /goal_attainment|prompt_compliance|user_fidelity|unknown|рубрик|протокол|кластер|метрик|judge|seq|agree|disagree|unsure|stale|quick/i;
  for (const view of [judgeFailed('fail', 'pass'), judgeFailed('pass', 'unknown'), judgePassed('unknown', 'fail'), doubled([ruledQuick('t-d', GOAL, 'fail', 'fail', false)])]) {
    for (const line of [...rowsToLines(disagreementRows(view)).filter(line => line.startsWith('  Судья:')), ...resultViewLines(view).filter(line => line.startsWith('  Отметки'))]) {
      assert.doesNotMatch(line, jargon, line);
      assertPlainCopy(line, 'F7');
    }
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
  const lines = rowsToLines(disagreementRows(buildResultView(disagreed(['Агент\tответил\n\nне  по правилам.', long]))));
  assert.equal(lines[2], '  Причина: «Агент ответил не по правилам.»');
  assert.equal(lines[6], `  Причина: «${long}»`);
  assert.equal(lines[6]!.length, 600 + '  Причина: «»'.length, 'nothing was cut from the reason');
  assert.ok(!lines.some(line => line.includes('…')), lines.join('\n'));
});

test('the next step points at the board while something in the queue is unmarked, and only then', () => {
  const open = buildResultView(run([card('f0')], [attempt('f0', { goal: 'fail' })], { id: HEX_ID }));
  assert.deepEqual(disagreementRows(open), []);
  assert.equal(agreementNextStep(open), NEXT_STEP);
  assert.deepEqual(agreementSectionLines(open), [NEXT_STEP], 'without a disagreement the section is the next step alone');
  const answered = buildResultView(run([card('f0'), card('f1')], [attempt('f0', { goal: 'fail' }), attempt('f1', { goal: 'fail' })],
    { id: HEX_ID, humanReviews: [quick('t-f0', 'fail', 'fail'), quick('t-f1', 'unknown', 'fail')] }));
  assert.equal(agreementNextStep(answered), null, '«не могу сказать» is an answer for the queue too');
  assert.deepEqual(agreementSectionLines(answered), []);
  const nothing = buildResultView(run([card('u0')], [attempt('u0', { goal: 'unknown', goalRationale: SPLIT })], { id: HEX_ID }));
  assert.deepEqual(agreementSectionLines(nothing), [], 'the judge decided nothing, so there is nothing to mark');
});

test('CLI summary puts the disagreement and the next step between the causes and the full list, escaped', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-disagreement-cli-'));
  try {
    const escape = String.fromCharCode(27);
    const record = clustered();
    record.id = HEX_ID;
    record.scenarios[1]!.title = 'Возврат через терминал';
    // The owner overturns one failure and leaves the other two in the queue; his reason is untrusted text.
    record.humanReviews = [{ ...quick('t-f0', 'pass', 'fail'), note: `Судья ${escape}[31mне учёл уточнение клиента.` }];
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
    const causes = lines.findIndex(line => ['Главные причины провалов:', 'Провалы:'].includes(line));
    const at = lines.indexOf('Несогласия с судьёй (1):');
    const all = lines.findIndex(line => line.startsWith('Все провалы ('));
    assert.ok(causes > 0 && at > causes && all > at, stdout);
    assert.equal(lines[at - 1], '', 'a blank line separates the section from the causes');
    assert.deepEqual(lines.slice(at, all - 1), [
      'Несогласия с судьёй (1):',
      '! Возврат через терминал',
      '  Судья: не справился → владелец: справился',
      '  Причина: «Судья не учёл уточнение клиента.»',
      '',
      NEXT_STEP,
    ]);
    assert.ok(!stdout.includes(escape), 'a terminal sequence from the reason never reaches the terminal');
    assert.ok(stdout.includes('Судья не учёл уточнение клиента.'), 'the visible words stay');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** The same record with every situation titled in Russian: a card title is record text, not our copy. */
const inRussian = (record: Experiment): Experiment =>
  ({ ...record, scenarios: record.scenarios.map((scenario, i) => ({ ...scenario, title: `Ситуация №${i + 1}` })) });
/** The F6 rows of a record: the main agreement row and the tail rows under it. */
function agreementBlock(record: Experiment): string[] {
  const lines = resultViewLines(buildResultView(record));
  const at = lines.findIndex(line => line.startsWith('Согласие с судьёй'));
  return at < 0 ? [] : lines.slice(at).filter(line => line.startsWith('Согласие с судьёй') || line.startsWith('  '));
}

test('the agreement row, the disagreements and the next step are plain Russian on every band', () => {
  const tails = { ...scored(1, 2), humanReviews: [quick('t-f0', 'fail', 'fail'), quick('t-f1', 'unknown', 'fail'), quick('t-p0', 'pass', 'fail')] };
  const bands: [string, Experiment][] = [
    ['M = 0', scored(1, 1)],
    ['M = 1', { ...scored(1, 1), humanReviews: [quick('t-f0', 'fail', 'fail')] }],
    ['M = 10', marked(1, 9, 8, 1)],
    ['M = 20', marked(3, 17, 16, 2)],
    ['M with tails', tails],
  ];
  for (const [label, record] of bands) {
    const rows = agreementBlock(inRussian(record));
    assert.ok(rows.length, `${label} prints an agreement row`);
    for (const line of rows) assertPlainCopy(line, label);
  }
  for (const line of agreementSectionLines(buildResultView(inRussian(disagreed())))) assertPlainCopy(line, 'F7');
  assertPlainCopy(agreementNextStep(buildResultView(run([card('f0')], [attempt('f0', { goal: 'fail' })], { id: HEX_ID })))!, 'F8');
  // The scan itself: it catches machine words and lets the allowed key letters and command through.
  assert.throws(() => assertPlainCopy('Согласие с судьёй: метрика сходится.'), /метрик/);
  assert.throws(() => assertPlainCopy('Оценка goal_attainment не сошлась.'), /goal/);
  assert.throws(() => assertPlainCopy('Отметка stale после смены судьи.'), /stale/);
  assertPlainCopy('y · n · s — согласие с судьёй');
  assertPlainCopy(NEXT_STEP);
});

test('строки согласия в первом блоке несут свои роли, а текст блока не меняется', () => {
  const record = { ...scored(1, 2), humanReviews: [quick('t-f0', 'fail', 'fail'), quick('t-f1', 'unknown', 'fail'), quick('t-p0', 'pass', 'fail')] };
  const view = buildResultView(record);
  const rows = resultViewRows(view);
  const at = rows.findIndex(row => row.text.startsWith('Согласие с судьёй'));
  assert.deepEqual(rows.slice(at).map(row => [row.role, row.indent]),
    [['agreement', 0], ['agreement-tail', 2], ['agreement-tail', 2], ['agreement-tail', 2]]);
  assert.ok(rows.slice(0, at).every(row => !String(row.role).startsWith('agreement')), 'no other row takes the agreement roles');
  assert.deepEqual(resultViewLines(view), rowsToLines(rows));
  assert.equal(resultViewRows(buildResultView(scored(1, 1))).find(row => row.text === 'Согласие с судьёй: ещё не проверено.')?.role, 'agreement');
});
