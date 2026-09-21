import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyUsage, goalAttainment, promptCompliance, settingsSchema, type Experiment, type MetricAssessment, type Requirement, type Source, type Trial } from '../src/contracts.js';
import { exampleRows, failureExplanation, ruleRegister, rowsToLines, UNVERIFIED } from '../src/explain.js';
// Phase-3 evidence is read through the namespace, so a missing export fails an assertion, not the module link.
import * as explain from '../src/explain.js';
import { AGREED_RATIONALE_PREFIX } from '../src/judge.js';
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
const requirement = (id: string, sourceId: string, quote: string): Requirement => ({ id, text: `Своими словами: ${quote}`, sourceId, quote, critical: false });
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

// ---- Task 2: every variant of the explanation (UI-SPEC F1 variants table). ----

const TITLE = '✗ Возврат через терминал';
const EXPECTED = '  Должен был: Объяснить порядок возврата через терминал и срок зачисления.';
const SAID = '  Сказал (реплика #1): «Ожидайте, заявка передана специалисту.»';
const RULE_1 = '  Правило 1 · Возврат покупки: «Возврат выполняется через меню терминала в течение 30 дней.»';
const RULE_2 = '  Правило 2 · Возврат покупки: «Деньги приходят на карту за пять рабочих дней.»';
const RULE_5 = '  Правило 5 · Системный промпт, строка 2: «Отвечай только по инструкциям банка.»';
const RULE_6 = 'Правило 6 · Системный промпт, строка 3: «Не обещай сроки, которых нет в инструкциях.»';
const VIOLATED_6 = '  Нарушено правило 6 · Системный промпт, строка 3: «Не обещай сроки, которых нет в инструкциях.»';
const QUOTES_RULE_6 = `${AGREED_RATIONALE_PREFIX} Нарушено правило «Не обещай сроки, которых нет в инструкциях» — агент назвал срок «два дня».`;
const complianceFail = (rationale: string) => verdict('prompt_compliance', 'fail', { rationale, citations: [{ seq: 1, quote: 'Срок — два дня.' }] });
const allRows: string[][] = [];

interface Variant { card?: Partial<Card>; assessments?: MetricAssessment[]; trial?: Partial<Trial>; mutate?: (record: Experiment) => void }
function explainOne(variant: Variant = {}) {
  const subject = card('refund', { title: 'Возврат через терминал', requirementIds: ['refund-money', 'refund-path'], ...variant.card });
  const record = structuredClone(run([subject], [attempt('refund', variant.assessments ?? [goalFail(), verdict('prompt_compliance', 'pass')], variant.trial)]));
  variant.mutate?.(record);
  const explanation = failureExplanation(record, record.scenarios[0]!);
  assert.ok(explanation, 'the variant must have an explanation');
  allRows.push(explanation.lines);
  return explanation;
}

test('the reply falls back to the last agent reply, the evidence reply, or says it cannot be shown', () => {
  const twoReplies = { events: [
    { seq: 0, type: 'user' as const, text: 'Как вернуть покупку?' },
    { seq: 1, type: 'assistant' as const, text: 'Первый ответ.' },
    { seq: 2, type: 'user' as const, text: 'А подробнее?' },
    { seq: 3, type: 'assistant' as const, text: 'Второй   ответ\nагента.' },
  ] };
  const uncited = explainOne({ trial: twoReplies, assessments: [verdict('goal_attainment', 'fail', { evidence: [0], citations: [{ seq: 0, quote: 'Как вернуть' }] })] });
  assert.equal(uncited.lines[2], '  Сказал (реплика #3, судья не указал реплику): «Второй ответ агента.»');
  assert.deepEqual(uncited.said, { seq: 3, quote: 'Второй ответ агента.', judgeCited: false });

  const byEvidence = explainOne({ assessments: [verdict('goal_attainment', 'fail', { evidence: [1] })] });
  assert.equal(byEvidence.lines[2], `  Сказал (реплика #1): «${REPLY}»`);
  assert.equal(byEvidence.said?.judgeCited, true);

  const badQuote = explainOne({ assessments: [goalFail({ citations: [{ seq: 1, quote: 'Деньги уже на карте.' }] })] });
  assert.equal(badQuote.lines[2], `  Сказал (реплика #1): ${UNVERIFIED}`);
  assert.equal(badQuote.rows[2]?.role, 'unverified');
  assert.equal(badQuote.said, null);
  assert.deepEqual(badQuote.lines.filter((_, i) => i !== 2), [TITLE, EXPECTED, RULE_1, RULE_2], 'the other rows stay');

  const silent = explainOne({ trial: { events: [{ seq: 0, type: 'user', text: 'Как вернуть покупку?' }] } });
  assert.equal(silent.lines[2], '  Сказал: в записи нет ответа агента.');
  assert.equal(silent.rows[2]?.role, 'unverified');
});

test('a missing expectation is taken from the first shown rule, or said to be missing', () => {
  const fromRule = explainOne({ card: { successCriteria: undefined } });
  assert.equal(fromRule.lines[1], '  Должен был (из правила): Своими словами: Возврат выполняется через меню терминала в течение 30 дней.');
  const bare = explainOne({ card: { successCriteria: undefined, requirementIds: [] } });
  assert.deepEqual(bare.lines, [TITLE, '  Должен был: ожидание не записано в ситуации.', SAID, '  Правило: у ситуации нет правила из ваших материалов.']);
  assert.equal(bare.rows[1]?.role, 'unverified');
  assert.equal(bare.rows[3]?.role, 'unverified');
});

test('an unknown or tampered rule is named as unverified, after the verified ones, and never numbered', () => {
  const cases: [string, string[], (record: Experiment) => void][] = [
    ['unknown requirement id', ['ghost', 'refund-path'], () => {}],
    ['source text changed', ['refund-money', 'refund-path'], record => { record.sources[0]!.content = record.sources[0]!.content.replace('Деньги приходят', 'Средства поступают'); }],
    ['requirement quote rewritten', ['refund-money', 'refund-path'], record => { record.requirements.find(item => item.id === 'refund-money')!.quote = 'Деньги не возвращаются.'; }],
    ['source removed', ['bank-only', 'refund-path'], record => { record.sources = record.sources.filter(source => source.id !== 'src-p'); }],
  ];
  for (const [name, requirementIds, mutate] of cases) {
    const explanation = explainOne({ card: { requirementIds }, mutate });
    assert.deepEqual(explanation.lines, [TITLE, EXPECTED, SAID, RULE_1, `  Правило: ${UNVERIFIED}`], name);
    assert.equal(explanation.rows[4]?.role, 'unverified', name);
    assert.equal(explanation.unverifiedRules, 1, name);
  }
  const allBroken = explainOne({ card: { requirementIds: ['ghost-1', 'ghost-2', 'ghost-3'] } });
  assert.deepEqual(allBroken.lines, [TITLE, EXPECTED, SAID, `  Правило: ${UNVERIFIED}`, `  Правило: ${UNVERIFIED}`, '  и ещё 1 правило'],
    'a block where every rule is unverified keeps its title and all rows');
});

test('zero, one, two and many rules: two rows at most, then «и ещё K» with the right plural', () => {
  const rowsFor = (requirementIds: string[]) => {
    const explanation = explainOne({ card: { requirementIds } });
    return { rules: explanation.rows.filter(row => row.role === 'rule' || (row.role === 'unverified' && row.text.startsWith('Правило:'))).length,
      more: explanation.rows.find(row => row.role === 'more')?.text };
  };
  assert.deepEqual(rowsFor(['refund-path']), { rules: 1, more: undefined });
  assert.deepEqual(rowsFor(['refund-path', 'fee']), { rules: 2, more: undefined });
  assert.deepEqual(rowsFor(['refund-path', 'fee', 'bank-only']), { rules: 2, more: 'и ещё 1 правило' });
  assert.deepEqual(rowsFor(['refund-path', 'fee', 'bank-only', 'tariff-change']), { rules: 2, more: 'и ещё 2 правила' });
  assert.deepEqual(rowsFor(['no-promises', 'bank-only', 'tariff-change', 'fee', 'refund-money', 'refund-path', 'ghost']), { rules: 2, more: 'и ещё 5 правил' });
  const none = explainOne({ card: { requirementIds: [] } });
  assert.equal(none.lines.at(-1), '  Правило: у ситуации нет правила из ваших материалов.');
});

test('knowledge rules come first; a prompt rule names its line; a machine-format rule is never shown or counted', () => {
  const mixed = explainOne({ card: { requirementIds: ['bank-only', 'fee'] } });
  assert.deepEqual(mixed.lines.slice(3), ['  Правило 3 · Тарифы: «Комиссия за эквайринг составляет 1,8 процента.»', RULE_5]);
  const machine = explainOne({ card: { requirementIds: ['json-format', 'refund-path'] } });
  assert.deepEqual(machine.lines, [TITLE, EXPECTED, SAID, RULE_1]);
  assert.equal(machine.moreRules, 0);
  const onlyMachine = explainOne({ card: { requirementIds: ['json-format'] } });
  assert.equal(onlyMachine.lines.at(-1), '  Правило: у ситуации нет правила из ваших материалов.');
  const quotedMachine = explainOne({ assessments: [verdict('goal_attainment', 'pass'),
    complianceFail(`${AGREED_RATIONALE_PREFIX} Нарушено «Ответ оформляй в JSON с полем "answer"».`)] });
  assert.equal(quotedMachine.violated, undefined, 'a machine-format rule is never named as violated');
});

test('only the prompt-rule check failed: the expectation is the one violated rule, or says it cannot be named', () => {
  const named = explainOne({ card: { requirementIds: ['refund-path', 'no-promises'] }, assessments: [verdict('goal_attainment', 'pass'), complianceFail(QUOTES_RULE_6)] });
  assert.equal(named.kind, 'rules');
  assert.deepEqual(named.lines, [TITLE, `  Должен был: соблюдать правило 6 · Системный промпт, строка 3: «Не обещай сроки, которых нет в инструкциях.»`,
    '  Сказал (реплика #1): «Срок — два дня.»', RULE_1, `  ${RULE_6}`]);
  assert.equal(named.violated?.number, 6);
  assert.ok(!named.lines.some(line => line.includes('Нарушено')), 'no duplicate «Нарушено» row');

  const unnamed = '  Должен был: соблюдать правила из ваших материалов — объяснение не подтверждено цитатой';
  const two = explainOne({ assessments: [verdict('goal_attainment', 'pass'),
    complianceFail(`${AGREED_RATIONALE_PREFIX} Нарушены «Не обещай сроки, которых нет в инструкциях» и «Отвечай только по инструкциям банка».`)] });
  assert.equal(two.lines[1], unnamed);
  assert.equal(two.rows[1]?.role, 'unverified');
  assert.equal(two.violated, undefined);
  const none = explainOne({ assessments: [verdict('goal_attainment', 'pass'), complianceFail('Агент нарушил правило о сроках.')] });
  assert.equal(none.lines[1], unnamed);
  const short = explainOne({ assessments: [verdict('goal_attainment', 'pass'), complianceFail('Нарушено «сроки».')] });
  assert.equal(short.lines[1], unnamed, 'a quote shorter than 12 characters names nothing');

  // A span long enough to pass the 12-character filter but far from the whole rule is a
  // coincidence, not evidence: «по инструкциям банка» is 20 of the 36 characters of rule 5.
  const partial = explainOne({ assessments: [verdict('goal_attainment', 'pass'),
    complianceFail(`${AGREED_RATIONALE_PREFIX} Агент ответил не «по инструкциям банка», а своими словами.`)] });
  assert.equal(partial.violated, undefined, 'a span covering part of one rule names nothing');
  assert.equal(partial.lines[1], unnamed);
  // A short rule quoted inside a long judge span is the same coincidence from the other side.
  const swallowed = explainOne({ assessments: [verdict('goal_attainment', 'pass'),
    complianceFail(`${AGREED_RATIONALE_PREFIX} Нарушено «агент упомянул тариф, эквайринг и сроки в одном ответе».`)] });
  assert.equal(swallowed.violated, undefined);
  // A near-exact span still names its rule, and so does a rule quoted whole inside a longer span.
  const inside = explainOne({ assessments: [verdict('goal_attainment', 'pass'),
    complianceFail(`${AGREED_RATIONALE_PREFIX} Нарушено «правило: Отвечай только по инструкциям банка. Агент ушёл в сторону».`)] });
  assert.equal(inside.violated?.number, 5);

  const record = run([card('fine')], [attempt('fine', [verdict('goal_attainment', 'pass'), verdict('prompt_compliance', 'pass')])]);
  assert.equal(failureExplanation(record, record.scenarios[0]!), null, 'nothing failed, nothing to explain');
});

test('a failed goal names the violated prompt rule once, unless it is already shown', () => {
  // Phase 03.1: the goal failed and the prompt-rule check failed in the same attempt, so this is «оба»; the rows are the goal rows.
  const extra = explainOne({ assessments: [goalFail(), complianceFail(QUOTES_RULE_6)] });
  assert.deepEqual(extra.lines, [TITLE, EXPECTED, SAID, RULE_1, RULE_2, VIOLATED_6]);
  assert.equal(extra.rows.at(-1)?.role, 'violated');
  const shown = explainOne({ card: { requirementIds: ['refund-path', 'no-promises'] }, assessments: [goalFail(), complianceFail(QUOTES_RULE_6)] });
  assert.deepEqual(shown.lines, [TITLE, EXPECTED, SAID, RULE_1, `  ${RULE_6}`]);
  const counted = explainOne({ card: { requirementIds: ['refund-path', 'refund-money', 'no-promises'] }, assessments: [goalFail(), complianceFail(QUOTES_RULE_6)] });
  assert.deepEqual(counted.lines.slice(3), [RULE_1, RULE_2, '  и ещё 1 правило', VIOLATED_6],
    'a rule hidden behind «и ещё» is still named as violated');
});

// ---- Phase 03.1: a double failure is «оба»; the phase-2 kinds keep their rows byte for byte. ----

test('a failed goal with a broken rule in the same attempt is «оба»: the goal rows plus the rule, or a named unverified row', () => {
  const named = explainOne({ assessments: [goalFail(), complianceFail(QUOTES_RULE_6)] });
  assert.equal(named.kind, 'both');
  assert.deepEqual(named.lines, [TITLE, EXPECTED, SAID, RULE_1, RULE_2, VIOLATED_6], 'the goal rows, then the violated rule named once');
  assert.equal(named.violated?.number, 6);
  const shown = explainOne({ card: { requirementIds: ['refund-path', 'no-promises'] }, assessments: [goalFail(), complianceFail(QUOTES_RULE_6)] });
  assert.equal(shown.kind, 'both');
  assert.deepEqual(shown.lines, [TITLE, EXPECTED, SAID, RULE_1, `  ${RULE_6}`], 'a rule already shown is not repeated');
  const unnamed = explainOne({ assessments: [goalFail(), complianceFail('Агент нарушил правило о сроках.')] });
  assert.equal(unnamed.kind, 'both');
  assert.deepEqual(unnamed.lines, [TITLE, EXPECTED, SAID, RULE_1, RULE_2, `  Нарушены правила промпта — ${UNVERIFIED}`],
    'when the rule cannot be named, the second half of the failure is still said');
  assert.equal(unnamed.rows.at(-1)?.role, 'unverified');
  assert.equal(unnamed.violated, undefined);
  const tie = explainOne({ assessments: [goalFail(),
    complianceFail(`${AGREED_RATIONALE_PREFIX} Нарушены «Не обещай сроки, которых нет в инструкциях» и «Отвечай только по инструкциям банка».`)] });
  assert.equal(tie.kind, 'both');
  assert.equal(tie.lines.at(-1), `  Нарушены правила промпта — ${UNVERIFIED}`, 'two candidate rules name nothing');

  // The phase-2 kinds are unchanged: only the goal failed, or only the rules failed.
  const goalOnly = explainOne({ assessments: [goalFail(), verdict('prompt_compliance', 'pass')] });
  assert.equal(goalOnly.kind, 'goal');
  assert.deepEqual(goalOnly.lines, [TITLE, EXPECTED, SAID, RULE_1, RULE_2]);
  const rulesOnly = explainOne({ assessments: [verdict('goal_attainment', 'unknown'), complianceFail(QUOTES_RULE_6)] });
  assert.equal(rulesOnly.kind, 'rules');
  assert.deepEqual(rulesOnly.lines, [TITLE, `  Должен был: соблюдать правило 6 · Системный промпт, строка 3: «Не обещай сроки, которых нет в инструкциях.»`,
    '  Сказал (реплика #1): «Срок — два дня.»', RULE_1, RULE_2], 'a rules-only failure never gets the «Нарушено» row');
  // A legacy card without the goal rubric is explained as before and never becomes «оба».
  const legacy = explainOne({ card: { metrics: [{ ...promptCompliance }] }, assessments: [complianceFail(QUOTES_RULE_6)] });
  assert.equal(legacy.kind, 'goal');
});

test('violatedRuleNumber names the rule the explanation names, else null', () => {
  assert.equal(typeof explain.violatedRuleNumber, 'function', 'explain.ts exports violatedRuleNumber (03.1)');
  const named = run([card('refund')], [attempt('refund', [goalFail(), complianceFail(QUOTES_RULE_6)])]);
  assert.equal(explain.violatedRuleNumber(named, named.trials[0]!), 6);
  assert.equal(explain.violatedRuleNumber(named, named.trials[0]!), failureExplanation(named, named.scenarios[0]!)?.violated?.number);
  const unnamed = run([card('refund')], [attempt('refund', [goalFail(), complianceFail('Агент нарушил правило о сроках.')])]);
  assert.equal(explain.violatedRuleNumber(unnamed, unnamed.trials[0]!), null);
  const kept = run([card('refund')], [attempt('refund', [goalFail(), verdict('prompt_compliance', 'pass')])]);
  assert.equal(explain.violatedRuleNumber(kept, kept.trials[0]!), null, 'rules that were kept name nothing');
  const machine = run([card('refund')], [attempt('refund', [goalFail(), complianceFail(`${AGREED_RATIONALE_PREFIX} Нарушено «Ответ оформляй в JSON с полем "answer"».`)])]);
  assert.equal(explain.violatedRuleNumber(machine, machine.trials[0]!), null, 'a machine-format rule is never named');
});

test('quotes are shown whole with whitespace collapsed; no row is shortened', () => {
  const long = `Начало ответа. ${'Очень длинное объяснение условий возврата. '.repeat(20)}Конец ответа.`;
  assert.ok(long.length > 850);
  const spaced = 'Ожидайте,  заявка\nпередана   специалисту.';
  const collapsed = explainOne({
    card: { successCriteria: 'Объяснить  порядок\nвозврата.' },
    trial: { events: [{ seq: 0, type: 'user', text: 'Как?' }, { seq: 1, type: 'assistant', text: `${spaced} ${long}` }] },
    assessments: [goalFail({ citations: [{ seq: 1, quote: spaced }] })],
  });
  assert.equal(collapsed.lines[1], '  Должен был: Объяснить порядок возврата.');
  assert.equal(collapsed.lines[2], '  Сказал (реплика #1): «Ожидайте, заявка передана специалисту.»');
  const whole = explainOne({
    trial: { events: [{ seq: 0, type: 'user', text: 'Как?' }, { seq: 1, type: 'assistant', text: long }] },
    assessments: [goalFail({ citations: [{ seq: 1, quote: long }] })],
  });
  assert.equal(whole.lines[2], `  Сказал (реплика #1): «${long.trim()}»`);
  assert.ok(allRows.flat().every(line => !line.includes('…')));
});

test('exampleRows retitles the block and indents its details by three more columns', () => {
  const explanation = explainOne();
  const rows = exampleRows(explanation);
  assert.deepEqual(rows[0], { role: 'example', indent: 3, text: 'Пример: Возврат через терминал' });
  assert.deepEqual(rows.slice(1).map(row => row.indent), explanation.rows.slice(1).map(() => 5));
  assert.deepEqual(rows.slice(1).map(row => row.text), explanation.rows.slice(1).map(row => row.text));
});

test('jargon backstop: no explanation row carries machine words or requirement ids', () => {
  assert.ok(allRows.length >= 10, 'the variant tests above ran first');
  const forbidden = /goal_attainment|prompt_compliance|user_fidelity|unknown|рубрик|протокол|кластер|метрик|judge|seq/i;
  const ids = REQUIREMENTS.map(item => item.id);
  for (const line of allRows.flat()) {
    assert.doesNotMatch(line, forbidden, line);
    for (const id of ids) assert.ok(!line.includes(id), `${id} in ${line}`);
  }
});

test('a short knowledge source is named without a line; a source of four lines and more keeps it', () => {
  const record = run([], []);
  const register = ruleRegister(record);
  // src-a and src-b are one-line knowledge files, src-p is a four-line prompt.
  assert.equal(register.get('refund-money')?.line, null);
  assert.equal(register.get('fee')?.line, null);
  assert.ok((register.get('bank-only')?.line ?? 0) > 0);

  const three = structuredClone(record);
  three.sources[0]!.content = 'Возврат выполняется через меню терминала в течение 30 дней.\n\nДеньги приходят на карту за пять рабочих дней.\nОстальное решает поддержка.';
  assert.equal(ruleRegister(three).get('refund-money')?.line, null, 'three non-blank lines are still found by name');

  const four = structuredClone(three);
  four.sources[0]!.content += '\nЖалобы принимает отделение.';
  assert.equal(ruleRegister(four).get('refund-money')?.line, 3, 'from four non-blank lines the line is named');
});

/** The evidence the agreement block shows (UI-SPEC F10); asserts the export exists before calling it. */
function evidenceOf(record: Experiment, scenarioIndex: number, metricId: string) {
  assert.equal(typeof explain.situationEvidence, 'function', 'explain.ts exports situationEvidence (UI-SPEC F10)');
  const scenario = record.scenarios[scenarioIndex]!;
  const trial = record.trials.find(item => item.scenarioId === scenario.id)!;
  return explain.situationEvidence(record, scenario, trial, metricId);
}
/** The owner's one-key answer, stored as the board writes it. */
const quickReview = (trialId: string, verdict: 'pass' | 'fail' | 'unknown', judgeVerdict: 'pass' | 'fail', note: string) =>
  ({ id: `q-${trialId}-${verdict}`, trialId, metricId: 'goal_attainment', source: 'quick' as const, verdict, judgeVerdict, note, createdAt: 'now' });

test('доказательство провала — строки объяснения без заголовка, и несогласие владельца их не меняет', () => {
  const record = refundRun();
  const rows = evidenceOf(record, 0, 'goal_attainment');
  assert.deepEqual(rowsToLines(rows), REFUND_LINES.slice(1), 'the same rows as the phase-2 explanation, title removed');
  assert.ok(rows.every(row => row.role !== 'title' && row.indent === 2));
  const marked: Experiment = { ...record, humanReviews: [quickReview('t-refund', 'pass', 'fail', 'Агент ответил верно, судья ошибся.')] };
  assert.equal(failureExplanation(marked, marked.scenarios[0]!), null, 'the overridden result hides the phase-2 explanation');
  assert.deepEqual(evidenceOf(marked, 0, 'goal_attainment'), rows, 'a disagreement never rewrites the evidence the owner judged');
  const agreed: Experiment = { ...record, humanReviews: [quickReview('t-refund', 'fail', 'fail', 'Быстрая отметка: согласен с судьёй.')] };
  assert.deepEqual(evidenceOf(agreed, 0, 'goal_attainment'), rows);
});

test('доказательство успеха: цитата, на которую сослался судья, иначе последняя реплика; строки «Нарушено правило» нет', () => {
  const passed = (assessments: MetricAssessment[], overrides: Partial<Trial> = {}, requirementIds = ['refund-path', 'no-promises']) =>
    run([card('ok', { title: 'Возврат прошёл', requirementIds })], [attempt('ok', assessments, overrides)]);
  const cited = evidenceOf(passed([verdict('goal_attainment', 'pass', { citations: [{ seq: 1, quote: 'Ожидайте, заявка передана специалисту.' }] }),
    complianceFail(QUOTES_RULE_6)]), 0, 'goal_attainment');
  assert.deepEqual(rowsToLines(cited), [EXPECTED, SAID, RULE_1, `  ${RULE_6}`]);
  assert.ok(cited.every(row => row.role !== 'violated' && !row.text.startsWith('Нарушено')), 'a pass never names a violated rule');

  const twoReplies = { events: [
    { seq: 0, type: 'user' as const, text: 'Как вернуть покупку?' },
    { seq: 1, type: 'assistant' as const, text: 'Первый ответ.' },
    { seq: 2, type: 'user' as const, text: 'А подробнее?' },
    { seq: 3, type: 'assistant' as const, text: 'Второй   ответ\nагента.' },
  ] };
  const uncited = evidenceOf(passed([verdict('goal_attainment', 'pass', { evidence: [] })], twoReplies), 0, 'goal_attainment');
  assert.equal(rowsToLines(uncited)[1], '  Сказал (реплика #3, судья не указал реплику): «Второй ответ агента.»');

  const bad = evidenceOf(passed([verdict('goal_attainment', 'pass', { citations: [{ seq: 1, quote: 'Деньги уже на карте.' }] })]), 0, 'goal_attainment');
  assert.equal(rowsToLines(bad)[1], `  Сказал (реплика #1): ${UNVERIFIED}`, 'an unverifiable citation is a status row, never a quotation');
  assert.equal(bad[1]?.role, 'unverified');

  const bare = evidenceOf(passed([verdict('goal_attainment', 'pass')], {}, []), 0, 'goal_attainment');
  assert.equal(rowsToLines(bare).at(-1), '  Правило: у ситуации нет правила из ваших материалов.');
  assert.ok(bare.every(row => row.indent === 2));

  const undecided = evidenceOf(passed([verdict('goal_attainment', 'unknown')]), 0, 'goal_attainment');
  assert.deepEqual(undecided, [], 'no recorded pass or fail, no evidence');
});

test('варианты объяснения провала попадают в блок согласия без изменений', () => {
  const variants: Variant[] = [
    { assessments: [goalFail({ citations: [{ seq: 1, quote: 'Деньги уже на карте.' }] })] },
    { card: { requirementIds: ['ghost', 'refund-path'] } },
    { card: { requirementIds: [] } },
    { card: { requirementIds: ['refund-path', 'refund-money', 'no-promises'] }, assessments: [goalFail(), complianceFail(QUOTES_RULE_6)] },
    { assessments: [goalFail(), complianceFail(QUOTES_RULE_6)] },
  ];
  for (const variant of variants) {
    const explanation = explainOne(variant);
    const subject = card('refund', { title: 'Возврат через терминал', requirementIds: ['refund-money', 'refund-path'], ...variant.card });
    const record = structuredClone(run([subject], [attempt('refund', variant.assessments ?? [goalFail(), verdict('prompt_compliance', 'pass')], variant.trial)]));
    assert.deepEqual(evidenceOf(record, 0, 'goal_attainment'), explanation.rows.slice(1), JSON.stringify(variant.card ?? variant.assessments));
  }
});
