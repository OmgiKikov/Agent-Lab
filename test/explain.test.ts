import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyUsage, settingsSchema, type Experiment, type Requirement, type Source, type Trial } from '../src/contracts.js';
import { goalAttainment, promptCompliance, type MetricAssessment } from '../src/assessment.js';
import { failureExplanation, ruleRegister, type FailureExplanation } from '../src/explain.js';
// Read through the namespace, so a missing export fails an assertion, not the module link.
import * as explain from '../src/explain.js';
import { AGREED_RATIONALE_PREFIX } from '../src/judge.js';
import { buildResultView } from '../src/result-view.js';
import { errorListRows, MAX_WIDTH, plainText } from '../src/result-text.js';
import { ExperimentStore } from '../src/store.js';

/*
 * Synthetic owner materials only: two one-line knowledge sources and a multi-line prompt.
 * Requirements are listed out of owner order on purpose. The explanation is data the surfaces word
 * (result-text.ts, report.ts): what was expected, the reply the judge pointed at, the owner rules.
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

const EXPECTED = 'Объяснить порядок возврата через терминал и срок зачисления.';
const SAID = { seq: 1, quote: 'Ожидайте, заявка передана специалисту.' };
/** The parts of an explanation a surface reads, rules by their number in the owner's materials. */
const partsOf = (explanation: FailureExplanation) => ({
  kind: explanation.kind, expected: explanation.expected, said: explanation.said, ...(explanation.unsaid ? { unsaid: explanation.unsaid } : {}),
  rules: explanation.rules.map(rule => rule.number), violated: explanation.violated?.number ?? null,
});

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
  // Knowledge rules first, then the prompt rule; every verified rule is kept, the surfaces show the first.
  assert.deepEqual(partsOf(explanation), { kind: 'goal', expected: EXPECTED, said: SAID, rules: [1, 2, 6], violated: null });
  assert.equal(explanation.trialId, 't-refund');
  assert.equal(failureExplanation(record, record.scenarios[1]!), null, 'a passing situation has no explanation');
  const view = buildResultView(record);
  assert.equal(view.failures.length, view.headline.decided - view.headline.passed);
  assert.deepEqual(view.failures.map(partsOf), [partsOf(explanation)]);
  // The explanation is data: no second copy of the words rides along with it.
  assert.deepEqual(Object.keys(explanation).sort(), ['expected', 'kind', 'rules', 'said', 'scenarioId', 'title', 'trialId']);
  for (const dead of ['situationEvidence', 'exampleRows', 'rowsToLines', 'UNVERIFIED_REPLY']) assert.equal(dead in explain, false, dead);
});

test('CLI summary lists every failed situation with its explanation, from the built dist', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-explain-'));
  try {
    const record = refundRun();
    const store = new ExperimentStore(directory);
    await store.init();
    try { await store.save(record); } finally { await store.close(); }
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const summary = async (...extra: string[]) => {
      const child = spawn(process.execPath, [cli, 'summary', '--id', record.id, '--data-dir', directory, ...extra]);
      let stdout = ''; let stderr = '';
      child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      const code = await new Promise<number | null>(resolve => child.on('close', resolve));
      assert.equal(code, 0, stderr);
      return stdout;
    };
    const stdout = await summary();
    const lines = stdout.split('\n');
    // The CLI prints the one result screen: its «Все ошибки» block is the view's error list at the same width.
    const errors = plainText(errorListRows(buildResultView(record)), MAX_WIDTH).split('\n');
    const at = lines.indexOf(errors[0]!);
    assert.equal(errors[0], ' Все ошибки');
    assert.ok(at > 0, stdout);
    assert.deepEqual(lines.slice(at, at + errors.length), errors);
    // Every failure says what was expected, what the agent said and the owner's rule, in the owner's words.
    const block = errors.map(line => line.trim()).join(' ');
    assert.match(block, /✗ 1 {2}Возврат через терминал/);
    assert.ok(block.includes('Ожидалось: Объяснить порядок возврата через терминал и срок зачисления.'), block);
    assert.ok(block.includes('Агент: «Ожидайте, заявка передана специалисту.»'), block);
    assert.ok(block.includes('Правило: «Возврат выполняется через меню терминала в течение 30 дней.»'), block);
    // The number opens the screen, the causes come before the list, and «Дальше» names the commands.
    assert.equal(lines[0], ' Точность агента: 50% — справился в 1 из 2 ситуаций');
    const causes = lines.indexOf(' Почему ошибается');
    assert.ok(causes > 0 && causes < at, stdout);
    assert.ok(lines.indexOf(' Дальше') > at, stdout);
    assert.ok(lines.some(line => line.trim() === `Отчёт для заказчика: agent-lab export --id ${record.id} --format html`), stdout);
    // --json carries the same view, the CI exit code and the very lines printed above.
    const machine = JSON.parse(await summary('--json'));
    assert.deepEqual(Object.keys(machine).sort(), ['exitCode', 'lines', 'view', 'warnings']);
    assert.equal(machine.exitCode, 1, 'a counted situation failed');
    assert.deepEqual(machine.view.failures.map((item: FailureExplanation) => [item.expected, item.said]), [[EXPECTED, SAID]]);
    assert.deepEqual(machine.lines, lines.slice(0, machine.lines.length));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ---- Every variant of the explanation (UI-SPEC F1 variants table). ----

const QUOTES_RULE_6 = `${AGREED_RATIONALE_PREFIX} Нарушено правило «Не обещай сроки, которых нет в инструкциях» — агент назвал срок «два дня».`;
const complianceFail = (rationale: string) => verdict('prompt_compliance', 'fail', { rationale, citations: [{ seq: 1, quote: 'Срок — два дня.' }] });
const expectedTexts: string[] = [];

interface Variant { card?: Partial<Card>; assessments?: MetricAssessment[]; trial?: Partial<Trial>; mutate?: (record: Experiment) => void }
function explainOne(variant: Variant = {}): FailureExplanation {
  const subject = card('refund', { title: 'Возврат через терминал', requirementIds: ['refund-money', 'refund-path'], ...variant.card });
  const record = structuredClone(run([subject], [attempt('refund', variant.assessments ?? [goalFail(), verdict('prompt_compliance', 'pass')], variant.trial)]));
  variant.mutate?.(record);
  const explanation = failureExplanation(record, record.scenarios[0]!);
  assert.ok(explanation, 'the variant must have an explanation');
  if (explanation.expected) expectedTexts.push(explanation.expected);
  return explanation;
}

test('the reply is the one the judge pointed at, verified; a reply it did not point at is never put in its place', () => {
  const twoReplies = { events: [
    { seq: 0, type: 'user' as const, text: 'Как вернуть покупку?' },
    { seq: 1, type: 'assistant' as const, text: 'Первый ответ.' },
    { seq: 2, type: 'user' as const, text: 'А подробнее?' },
    { seq: 3, type: 'assistant' as const, text: 'Второй   ответ\nагента.' },
  ] };
  // The judge cited the customer's message, not a reply: the last reply proves nothing about the failure.
  const uncited = explainOne({ trial: twoReplies, assessments: [verdict('goal_attainment', 'fail', { evidence: [0], citations: [{ seq: 0, quote: 'Как вернуть' }] })] });
  assert.deepEqual([uncited.said, uncited.unsaid], [null, 'not_cited']);
  // A tool expectation's evidence is a tool result: no reply stands in for it either.
  const tool = explainOne({ trial: { events: [...twoReplies.events, { seq: 4, type: 'tool_result' as const, text: '{}' }] },
    assessments: [verdict('goal_attainment', 'fail', { evidence: [4] })] });
  assert.deepEqual([tool.said, tool.unsaid], [null, 'not_cited']);

  const byEvidence = explainOne({ assessments: [verdict('goal_attainment', 'fail', { evidence: [1] })] });
  assert.deepEqual([byEvidence.said, byEvidence.unsaid], [{ seq: 1, quote: REPLY }, undefined], 'a reply the evidence names is shown whole');

  const badQuote = explainOne({ assessments: [goalFail({ citations: [{ seq: 1, quote: 'Деньги уже на карте.' }] })] });
  assert.deepEqual([badQuote.said, badQuote.unsaid], [null, 'unverified'], 'words the reply does not hold are never quoted');
  assert.deepEqual(partsOf(badQuote).rules, [1, 2], 'the other parts stay');

  const silent = explainOne({ trial: { events: [{ seq: 0, type: 'user', text: 'Как вернуть покупку?' }] } });
  assert.deepEqual([silent.said, silent.unsaid], [null, 'no_reply']);
});

test('a missing expectation is taken from the first rule, or left out', () => {
  const fromRule = explainOne({ card: { successCriteria: undefined } });
  assert.equal(fromRule.expected, 'Своими словами: Возврат выполняется через меню терминала в течение 30 дней.');
  const bare = explainOne({ card: { successCriteria: undefined, requirementIds: [] } });
  assert.deepEqual(partsOf(bare), { kind: 'goal', expected: null, said: SAID, rules: [], violated: null });
});

test('an unknown or tampered rule is never numbered or shown; the verified ones stay', () => {
  const cases: [string, string[], (record: Experiment) => void][] = [
    ['unknown requirement id', ['ghost', 'refund-path'], () => {}],
    ['source text changed', ['refund-money', 'refund-path'], record => { record.sources[0]!.content = record.sources[0]!.content.replace('Деньги приходят', 'Средства поступают'); }],
    ['requirement quote rewritten', ['refund-money', 'refund-path'], record => { record.requirements.find(item => item.id === 'refund-money')!.quote = 'Деньги не возвращаются.'; }],
    ['source removed', ['bank-only', 'refund-path'], record => { record.sources = record.sources.filter(source => source.id !== 'src-p'); }],
  ];
  for (const [name, requirementIds, mutate] of cases) assert.deepEqual(partsOf(explainOne({ card: { requirementIds }, mutate })).rules, [1], name);
  assert.deepEqual(partsOf(explainOne({ card: { requirementIds: ['ghost-1', 'ghost-2', 'ghost-3'] } })).rules, []);
});

test('every verified rule is kept, knowledge first; a machine-format rule is never shown or counted', () => {
  const rulesFor = (requirementIds: string[]) => partsOf(explainOne({ card: { requirementIds } })).rules;
  assert.deepEqual(rulesFor(['refund-path']), [1]);
  assert.deepEqual(rulesFor(['refund-path', 'fee', 'bank-only', 'tariff-change']), [1, 3, 4, 5]);
  assert.deepEqual(rulesFor(['no-promises', 'bank-only', 'tariff-change', 'fee', 'refund-money', 'refund-path', 'ghost']), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(rulesFor(['bank-only', 'fee']), [3, 5], 'knowledge first');
  assert.deepEqual(rulesFor(['json-format', 'refund-path']), [1]);
  assert.deepEqual(rulesFor(['json-format']), []);
  const quotedMachine = explainOne({ assessments: [verdict('goal_attainment', 'pass'),
    complianceFail(`${AGREED_RATIONALE_PREFIX} Нарушено «Ответ оформляй в JSON с полем "answer"».`)] });
  assert.equal(quotedMachine.violated, undefined, 'a machine-format rule is never named as violated');
});

test('only the prompt-rule check failed: the expectation is the one violated rule, or none when it cannot be named', () => {
  const named = explainOne({ card: { requirementIds: ['refund-path', 'no-promises'] }, assessments: [verdict('goal_attainment', 'pass'), complianceFail(QUOTES_RULE_6)] });
  assert.deepEqual(partsOf(named), { kind: 'rules', expected: 'соблюдать правило «Не обещай сроки, которых нет в инструкциях.»', said: { seq: 1, quote: 'Срок — два дня.' },
    rules: [1, 6], violated: 6 });

  const unnamed = (explanation: FailureExplanation) => [explanation.kind, explanation.expected, explanation.violated];
  const two = explainOne({ assessments: [verdict('goal_attainment', 'pass'),
    complianceFail(`${AGREED_RATIONALE_PREFIX} Нарушены «Не обещай сроки, которых нет в инструкциях» и «Отвечай только по инструкциям банка».`)] });
  assert.deepEqual(unnamed(two), ['rules', null, undefined], 'two candidate rules name nothing');
  assert.deepEqual(unnamed(explainOne({ assessments: [verdict('goal_attainment', 'pass'), complianceFail('Агент нарушил правило о сроках.')] })), ['rules', null, undefined]);
  assert.deepEqual(unnamed(explainOne({ assessments: [verdict('goal_attainment', 'pass'), complianceFail('Нарушено «сроки».')] })), ['rules', null, undefined],
    'a quote shorter than 12 characters names nothing');

  // A span long enough to pass the 12-character filter but far from the whole rule is a
  // coincidence, not evidence: «по инструкциям банка» is 20 of the 36 characters of rule 5.
  const partial = explainOne({ assessments: [verdict('goal_attainment', 'pass'),
    complianceFail(`${AGREED_RATIONALE_PREFIX} Агент ответил не «по инструкциям банка», а своими словами.`)] });
  assert.equal(partial.violated, undefined, 'a span covering part of one rule names nothing');
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

test('a failed goal with a broken rule in the same attempt is «оба»: the goal\'s expectation and the violated rule, when it can be named', () => {
  assert.deepEqual(partsOf(explainOne({ assessments: [goalFail(), complianceFail(QUOTES_RULE_6)] })),
    { kind: 'both', expected: EXPECTED, said: SAID, rules: [1, 2], violated: 6 });
  assert.deepEqual(partsOf(explainOne({ card: { requirementIds: ['refund-path', 'no-promises'] }, assessments: [goalFail(), complianceFail(QUOTES_RULE_6)] })),
    { kind: 'both', expected: EXPECTED, said: SAID, rules: [1, 6], violated: 6 });
  const unnamed = explainOne({ assessments: [goalFail(), complianceFail('Агент нарушил правило о сроках.')] });
  assert.deepEqual([unnamed.kind, unnamed.violated], ['both', undefined]);
  const tie = explainOne({ assessments: [goalFail(),
    complianceFail(`${AGREED_RATIONALE_PREFIX} Нарушены «Не обещай сроки, которых нет в инструкциях» и «Отвечай только по инструкциям банка».`)] });
  assert.deepEqual([tie.kind, tie.violated], ['both', undefined], 'two candidate rules name nothing');

  // The single kinds: only the goal failed, or only the rules failed.
  assert.equal(explainOne({ assessments: [goalFail(), verdict('prompt_compliance', 'pass')] }).kind, 'goal');
  const rulesOnly = explainOne({ assessments: [verdict('goal_attainment', 'unknown'), complianceFail(QUOTES_RULE_6)] });
  assert.deepEqual(partsOf(rulesOnly), { kind: 'rules', expected: 'соблюдать правило «Не обещай сроки, которых нет в инструкциях.»',
    said: { seq: 1, quote: 'Срок — два дня.' }, rules: [1, 2], violated: 6 });
  // A legacy card without the goal rubric is explained as before and never becomes «оба».
  assert.equal(explainOne({ card: { metrics: [{ ...promptCompliance }] }, assessments: [complianceFail(QUOTES_RULE_6)] }).kind, 'goal');
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

test('quotes are kept whole with whitespace collapsed; nothing is shortened', () => {
  const long = `Начало ответа. ${'Очень длинное объяснение условий возврата. '.repeat(20)}Конец ответа.`;
  assert.ok(long.length > 850);
  const spaced = 'Ожидайте,  заявка\nпередана   специалисту.';
  const collapsed = explainOne({
    card: { successCriteria: 'Объяснить  порядок\nвозврата.' },
    trial: { events: [{ seq: 0, type: 'user', text: 'Как?' }, { seq: 1, type: 'assistant', text: `${spaced} ${long}` }] },
    assessments: [goalFail({ citations: [{ seq: 1, quote: spaced }] })],
  });
  assert.equal(collapsed.expected, 'Объяснить порядок возврата.');
  assert.deepEqual(collapsed.said, { seq: 1, quote: 'Ожидайте, заявка передана специалисту.' });
  const whole = explainOne({
    trial: { events: [{ seq: 0, type: 'user', text: 'Как?' }, { seq: 1, type: 'assistant', text: long }] },
    assessments: [goalFail({ citations: [{ seq: 1, quote: long }] })],
  });
  assert.equal(whole.said?.quote, long.trim());
  assert.ok(expectedTexts.every(text => !text.includes('…')));
});

test('jargon backstop: no expectation an explanation words carries machine words or requirement ids', () => {
  assert.ok(expectedTexts.length >= 10, 'the variant tests above ran first');
  const forbidden = /goal_attainment|prompt_compliance|user_fidelity|unknown|рубрик|протокол|кластер|метрик|judge|seq/i;
  const ids = REQUIREMENTS.map(item => item.id);
  for (const text of expectedTexts) {
    assert.doesNotMatch(text, forbidden, text);
    for (const id of ids) assert.ok(!text.includes(id), `${id} in ${text}`);
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
