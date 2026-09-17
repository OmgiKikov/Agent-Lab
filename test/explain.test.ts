import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyUsage, goalAttainment, promptCompliance, settingsSchema, type Experiment, type MetricAssessment, type Requirement, type Source, type Trial } from '../src/contracts.js';
import { failureExplanation, ruleRegister } from '../src/explain.js';
import { buildResultView } from '../src/result-view.js';
import { ExperimentStore } from '../src/store.js';

/*
 * Synthetic owner materials only: two one-line knowledge sources and a multi-line prompt.
 * Requirements are listed out of owner order on purpose.
 */
const world = { records: {}, writableFields: [], transientFailures: 0 };
type Card = Experiment['scenarios'][number];

const SOURCES: Source[] = [
  { id: 'src-a', name: 'Возврат покупки', hash: 'a', kind: 'knowledge',
    content: 'Возврат выполняется через меню терминала в течение 30 дней. Деньги приходят на карту за пять рабочих дней.' },
  { id: 'src-b', name: 'Тарифы', hash: 'b', kind: 'knowledge',
    content: 'Комиссия за эквайринг составляет 1,8 процента. Тариф меняется по заявлению в личном кабинете.' },
  { id: 'src-p', name: 'Системный промпт', hash: 'p', kind: 'prompt',
    content: 'Ты помощник по эквайрингу.\n- Отвечай только по инструкциям банка.\n- Не обещай сроки, которых нет в инструкциях.\n- Ответ оформляй в JSON с полем "answer".' },
];
const requirement = (id: string, sourceId: string, quote: string): Requirement => ({ id, text: `Текст правила ${id}`, sourceId, quote, critical: false });
const REQUIREMENTS: Requirement[] = [
  requirement('tariff-change', 'src-b', 'Тариф меняется по заявлению в личном кабинете.'),
  requirement('no-promises', 'src-p', 'Не обещай сроки, которых нет в инструкциях.'),
  requirement('refund-money', 'src-a', 'Деньги приходят на карту за пять рабочих дней.'),
  requirement('bank-only', 'src-p', 'Отвечай только по инструкциям банка.'),
  requirement('refund-path', 'src-a', 'Возврат выполняется через меню терминала в течение 30 дней.'),
  requirement('fee', 'src-b', 'Комиссия за эквайринг составляет 1,8 процента.'),
  requirement('json-format', 'src-p', 'Ответ оформляй в JSON с полем "answer".'),
  requirement('invented', 'src-a', 'Возврат запрещён.'),
];
const REPLY = 'Ожидайте, заявка передана специалисту. Срок — два дня.';

function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id, familyId: id, title: `Ситуация ${id}`, requirementIds: [], provenance: 'production', tier: 'regression', goalObservation: 'reply',
    user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 3 }, initialState: world, checks: [],
    successCriteria: 'Объяснить порядок возврата через терминал и срок зачисления.',
    metrics: [{ ...goalAttainment }, { ...promptCompliance }], split: 'dev', ...overrides,
  };
}
const verdict = (metricId: string, result: MetricAssessment['result'], extra: Partial<MetricAssessment> = {}): MetricAssessment =>
  ({ metricId, result, rationale: 'Обоснование.', evidence: result === 'unknown' ? [] : [1], ...extra });

function attempt(scenarioId: string, assessments: MetricAssessment[], overrides: Partial<Trial> = {}): Trial {
  return {
    id: `t-${scenarioId}`, revisionId: 'rev', scenarioId, familyId: scenarioId, repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: 'h',
    outcome: 'ungraded', reason: 'Диалог дошёл до конца.', checks: [],
    events: [
      { seq: 0, type: 'user', text: 'Как вернуть покупку?' },
      { seq: 1, type: 'assistant', text: REPLY },
      { seq: 2, type: 'simulator', result: { message: '', done: true } },
    ],
    initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 1, assessments, ...overrides,
  };
}
const goalFail = (extra: Partial<MetricAssessment> = {}) => verdict('goal_attainment', 'fail', { citations: [{ seq: 1, quote: 'Ожидайте, заявка передана специалисту.' }], ...extra });

function run(cards: Card[], trials: Trial[], overrides: Partial<Experiment> = {}): Experiment {
  return {
    schemaVersion: '1', id: 'run-explain', task: 't', mode: 'live', workflow: 'evaluate', createdAt: 'now', updatedAt: 'now', phase: 'results_review', message: '',
    sources: SOURCES, settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }),
    target: { kind: 'command', command: 'python3', args: ['agent.py'], timeoutMs: 60000 },
    requirements: REQUIREMENTS, questions: [], goldenCases: [], dialogues: [], profiles: [], notes: '', scenarios: cards, revisions: [], selectedRevisionId: null,
    manifestHash: 'h', reviewedAt: null, reviewMode: 'human', controlConsumedAt: null, acceptedTests: [], trials, comparisons: [], iterations: [],
    usage: emptyUsage(), error: null, limitations: [], humanReviews: [], ...overrides,
  };
}

/** One failed refund situation with three rules and one passing situation. */
function refundRun(): Experiment {
  const failed = card('refund', { title: 'Возврат через терминал', requirementIds: ['no-promises', 'refund-money', 'refund-path'] });
  const passed = card('fee');
  return run([failed, passed], [
    attempt('refund', [goalFail(), verdict('prompt_compliance', 'pass')]),
    attempt('fee', [verdict('goal_attainment', 'pass'), verdict('prompt_compliance', 'pass')]),
  ]);
}

const REFUND_LINES = [
  '✗ Возврат через терминал',
  '  Должен был: Объяснить порядок возврата через терминал и срок зачисления.',
  '  Сказал (реплика #1): «Ожидайте, заявка передана специалисту.»',
  '  Правило 1 · Возврат покупки: «Возврат выполняется через меню терминала в течение 30 дней.»',
  '  Правило 2 · Возврат покупки: «Деньги приходят на карту за пять рабочих дней.»',
  '  и ещё 1 правило',
];

test('rule numbers follow the owner materials: source order, then quote position, never the array order', () => {
  const register = ruleRegister(run([], []));
  const numbers = Object.fromEntries([...register].map(([id, rule]) => [id, rule.number]));
  assert.deepEqual(numbers, { 'refund-path': 1, 'refund-money': 2, fee: 3, 'tariff-change': 4, 'bank-only': 5, 'no-promises': 6, 'json-format': 7 });
  assert.equal(register.get('invented'), undefined, 'a quote that is not verbatim in its source gets no number');
  assert.equal(register.get('refund-path')?.line, null, 'a one-line source never names a line');
  assert.equal(register.get('bank-only')?.line, 2);
  assert.equal(register.get('no-promises')?.line, 3);
  assert.equal(register.get('no-promises')?.prompt, true);
  const copy = structuredClone(run([], []));
  assert.deepEqual([...ruleRegister(copy)], [...register], 'a copy of the record numbers the rules the same way');
});

test('a failed situation is explained as expectation, reply and owner rules from the stored record', () => {
  const record = refundRun();
  const explanation = failureExplanation(record, record.scenarios[0]!);
  assert.ok(explanation);
  assert.deepEqual(explanation.lines, REFUND_LINES);
  assert.equal(explanation.trialId, 't-refund');
  assert.deepEqual(explanation.said, { seq: 1, quote: 'Ожидайте, заявка передана специалисту.', judgeCited: true });
  assert.equal(failureExplanation(record, record.scenarios[1]!), null, 'a passing situation has no explanation');
  const view = buildResultView(record);
  assert.equal(view.failures.length, view.headline.decided - view.headline.passed);
  assert.deepEqual(view.failures.map(item => item.lines), [REFUND_LINES]);
});

test('CLI summary lists every failed situation with its explanation, from the built dist', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-explain-'));
  try {
    const record = refundRun();
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
    const at = lines.indexOf('Все провалы (1):');
    assert.ok(at > 0, stdout);
    assert.deepEqual(lines.slice(at + 1, at + 1 + REFUND_LINES.length), REFUND_LINES);
    assert.ok(lines.indexOf('Подробности:') > at);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
