import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectationSheet, testPlanLines, trialProofLines } from '../src/quality.js';
import { countText } from '../src/plural.js';
import { emptyUsage, settingsSchema, type Experiment, type HumanReview, type Scenario, type Trial, type VariantExecution } from '../src/contracts.js';
import { RAG_RUBRICS } from '../src/assessment.js';
import { draftHash } from '../src/lab/record.js';
import { buildResultView, exitCodeOf } from '../src/result-view.js';
import { accuracyRow, causeRows, plainText, resultScreen } from '../src/result-text.js';
import { htmlReport } from '../src/report.js';

const world = { records: { r: { t: '0' } }, writableFields: ['t'], transientFailures: 0 };
const goal = { id: 'goal', name: 'Цель выполнена', subject: 'agent' as const, description: 'd', passCriteria: 'p', failCriteria: 'f' };
const format = { id: 'format', name: 'Формат ответа', subject: 'agent' as const, description: 'd', passCriteria: 'p', failCriteria: 'f' };
function scenario(id: string, checks = true): Scenario {
  return { id, familyId: id, title: `Карточка ${id}`, requirementIds: [], provenance: 'curated', user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 1 },
    initialState: world, checks: checks ? [{ id: 'time', kind: 'state_equals', description: 'Время изменено', recordId: 'r', field: 't', value: '1' }] : [], metrics: [goal, format], split: 'dev' };
}
function trial(id: string, scenarioId: string, outcome: Trial['outcome'], goalResult: 'pass' | 'fail' | 'unknown', formatResult: 'pass' | 'fail' | 'unknown' = 'pass', userMode: Trial['userMode'] = 'static'): Trial {
  return { id, revisionId: 'rev', scenarioId, familyId: scenarioId, repeat: 0, userMode, split: 'dev', manifestHash: 'h', outcome, reason: 'r',
    checks: [{ id: 'time', description: 'Время изменено', passed: outcome === 'pass', evidence: outcome === 'pass' ? '' : 'осталось 0' }],
    events: [{ seq: 0, type: 'user', text: 'hi' }, { seq: 1, type: 'assistant', text: 'ok' }], initialState: world, finalState: world, usage: { ...emptyUsage(), costUsd: 0.01 }, elapsedMs: 60000,
    assessments: [{ metricId: 'goal', result: goalResult, rationale: 'Совпало 2/2 оценок этой рубрики в свежих сессиях; это не проверка правильности. Агент не назвал путь в СберБизнес. Вместо этого он переспросил терминал.', evidence: [1] },
      { metricId: 'format', result: formatResult, rationale: 'r', evidence: [1] }] };
}
function record(overrides: Partial<Experiment> = {}): Experiment {
  return { schemaVersion: '1', id: 'exp', task: 't', mode: 'live', workflow: 'evaluate', createdAt: 'now', updatedAt: 'now', phase: 'results_review', message: '',
    sources: [], settings: settingsSchema.parse({ userModes: ['static'], repeats: 1 }), target: { kind: 'sandbox' }, requirements: [], questions: [], goldenCases: [], dialogues: [], profiles: [],
    scenarios: [scenario('a'), scenario('b'), scenario('c')], revisions: [], selectedRevisionId: null, manifestHash: 'h', reviewedAt: null, reviewMode: 'human', controlConsumedAt: null,
    trials: [], comparisons: [], iterations: [], usage: { ...emptyUsage(), calls: 6, costUsd: 0.27 }, error: null, limitations: [], humanReviews: [], ...overrides };
}
const review = (trialId: string, metricId: string, verdict: HumanReview['verdict']): HumanReview => ({
  id: `h-${trialId}-${metricId}-${verdict}`, trialId, metricId, verdict, note: 'n', createdAt: '2026-09-15T10:00:00Z',
});

test('RAG diagnostics never move the headline', () => {
  const t = trial('rag_trial', 'a', 'pass', 'pass');
  t.events.splice(1, 0, { seq: 2, type: 'retrieval', result: { chunks: [], complete: true } });
  t.assessments!.push(...RAG_RUBRICS.map(metric => ({ metricId: metric.id, result: 'fail' as const, evidence: [2], rationale: 'Missing context' })));
  const view = buildResultView(record({ scenarios: [scenario('a')], trials: [t] }));
  assert.deepEqual([view.headline.passed, view.headline.decided], [1, 1]);
  assert.deepEqual(view.failures, []);
});

test('one-test acceptance projection shows the complete current definition and observation channel', () => {
  const opening = `Первая строка\n${'длинный вход '.repeat(240)}`;
  const success = `Ответ основан на политике.\n${'полный критерий '.repeat(220)}`;
  const current = record({ phase: 'review', reviewMode: null,
    sources: [{ id: 'policy-source', name: 'policy.md', content: 'Тариф должен быть 1%.', hash: 'source-hash' }],
    requirements: [{ id: 'policy', text: 'Назвать точный тариф.', sourceId: 'policy-source', quote: 'Тариф должен быть 1%.', critical: true }], scenarios: [{
    ...scenario('a'), requirementIds: ['policy'], assumptions: ['Агент видит политику.'],
    goalObservation: 'reply',
    user: { ...scenario('a').user, goal: 'Получить точный ответ', facts: 'Тариф известен владельцу', behavior: 'Отвечает кратко',
      opening, script: ['Уточнение один', 'Уточнение два'], maxFollowUps: 2, persona: 'Владелец магазина',
      characteristics: ['Не любит жаргон'], knows: ['Номер точки 42'], cannotKnow: ['Внутренний ID'],
      answers: [{ ifAsked: 'Какая точка?', reply: '42' }] },
    checks: [{ id: 'answer', kind: 'answer_equals', description: 'Точный ответ', value: 'Тариф 1%' }],
    successCriteria: success,
  }] });
  const projection = testPlanLines(current);
  assert.equal(projection.draftHash, draftHash(current));
  const text = projection.lines.join('\n');
  assert.match(text, /^Тест\nСитуация\n  Название: Карточка a/m);
  assert.ok(!text.includes(draftHash(current).slice(0, 12)), 'the hash seals the definition; the owner reads the definition');
  for (const expected of ['Цель: Получить точный ответ', 'Факты: Тариф известен владельцу', 'Поведение: Отвечает кратко',
    'Максимум продолжений: 2', 'Персона: Владелец магазина', 'Характеристики:', '- Не любит жаргон',
    'Известно пользователю:', '- Номер точки 42', 'Пользователь не знает:', '- Внутренний ID',
    'Ответы на уточнения:', '«Какая точка?» → «42»', 'Требования:', '- Назвать точный тариф. · policy.md: «Тариф должен быть 1%.»', 'Допущения:',
    'Только начальная реплика',
    'Точные проверки:', '- Точный ответ', 'Последний ответ в точности: "Тариф 1%"',
    'Что оценивает судья:', '- Цель выполнена · агент', 'Справился: p', 'Не справился: f']) assert.ok(text.includes(expected), expected);
  // The owner reads the definition in words: no mode names, no settings keys, no JSON.
  assert.doesNotMatch(text, /static|reactive|scripted|maxTurns|PASS|FAIL|\{"/);
  assert.doesNotMatch(text, /\[(policy|answer|goal)\]/, 'no ids in the owner\'s dialog');
  assert.ok(text.includes(opening.replace('\n', '\n  ')));
  assert.ok(text.includes(success.replace('\n', '\n  ')));
  assert.doesNotMatch(text, /Уточнение один|Уточнение два/, 'script is not executed or shown in static mode');
  assert.match(text, /Наблюдение\n  ответ агента$/m);
  assert.match(text, /Этот тест действительно проверяет нужное поведение\?$/);

  const scripted = testPlanLines({ ...current, settings: settingsSchema.parse({ userModes: ['scripted'], maxTurns: 6 }) });
  assert.match(scripted.lines.join('\n'), /Продолжения по сценарию:\n  1\. Уточнение один\n  2\. Уточнение два/);
});

test('acceptance projection rejects ambiguous drafts and names tool/state observations exactly', () => {
  const base = record({ phase: 'review', reviewMode: null, scenarios: [{ ...scenario('a'), successCriteria: 'Готово' }] });
  assert.throws(() => testPlanLines(base), /канал наблюдения/);
  assert.throws(() => testPlanLines({ ...base, scenarios: [] }), /ровно один/);
  assert.throws(() => testPlanLines({ ...base, workflow: 'compare' }), /evaluate/);
  assert.throws(() => testPlanLines({ ...base, phase: 'results_review' }), /незапущенный/);
  const tool = testPlanLines({ ...base, scenarios: [{ ...base.scenarios[0]!, goalObservation: 'tool' }] });
  assert.match(tool.lines.join('\n'), /Наблюдение\n  результат инструмента$/m);
  const stateRecord = { ...base, scenarios: [{ ...base.scenarios[0]!, goalObservation: 'state' as const,
    initialState: { records: { A: { status: 'new' } }, writableFields: ['status'], transientFailures: 0 } }] };
  const state = testPlanLines(stateRecord);
  assert.match(state.lines.join('\n'), /Исходное состояние:\n  Записи:\n  - A: status = new\n  Агент может менять: status/);
  assert.match(state.lines.join('\n'), /Наблюдение\n  итоговое состояние$/m);
});

const ruleSource = { id: 'src_rules', name: 'Правила возврата', content: 'Первая строка.\nВерните деньги через терминал.\nТретья строка.\nЧетвёртая строка.\nПятая строка.' };
const promptSource = { id: 'src_prompt', name: 'Промпт агента', content: 'Отвечайте вежливо.\nresponse_format: json\nЕщё строка.\nИ ещё строка.', kind: 'prompt' as const };
const rulesRecord = (overrides: Partial<Experiment> = {}): Experiment => record({
  phase: 'review', reviewMode: null, sources: [ruleSource, promptSource],
  requirements: [
    { id: 'refund', text: 'Возврат через терминал', sourceId: ruleSource.id, quote: 'Верните деньги через терминал.', critical: true },
    { id: 'polite', text: 'Вежливость', sourceId: promptSource.id, quote: 'Отвечайте вежливо.', critical: false },
    { id: 'machine', text: 'Формат', sourceId: promptSource.id, quote: 'response_format: json', critical: false },
  ],
  ...overrides,
});
const sheetCard = (id: string, extra: Partial<Scenario> = {}): Scenario => ({ ...scenario(id), requirementIds: ['refund'], successCriteria: `Ожидание ${id}`, ...extra });

test('the expectation sheet names every situation, its expectation and its owner rules', () => {
  const draft = rulesRecord({ scenarios: [
    sheetCard('a'),
    sheetCard('b', { requirementIds: ['refund', 'polite', 'machine', 'unknown_rule'], successCriteria: '   ' }),
    sheetCard('c', { requirementIds: [] }),
  ] });
  const sheet = expectationSheet(draft);
  assert.equal(sheet.count, 3);
  assert.equal(sheet.countText, '3 ситуации');
  assert.equal(sheet.labelWidth, 2);
  assert.equal(sheet.lines[0], 'Что агент должен сделать: 3 ситуации. Номер правила — порядок в ваших материалах.');
  assert.equal(sheet.lines[1], '');
  // The confirmation is bound to the draft's hash; the owner reads the expectations, never the hash.
  assert.equal(sheet.draftHash, draftHash(draft));
  assert.ok(!sheet.lines.some(line => line.includes(draftHash(draft).slice(0, 12)) || line.includes('Версия ожиданий')), 'no hash on screen');
  assert.equal(sheet.lines.at(-1), '   Правило: у ситуации нет правила из ваших материалов.', 'the sheet ends with its last situation');
  assert.equal(sheet.lines[2], '1. Ситуация: g');
  assert.deepEqual(sheet.cards[0]!.details, [
    { role: 'expected', text: 'Должен: Ожидание a' },
    { role: 'rule', text: 'Правило 1 · Правила возврата, строка 2: «Верните деньги через терминал.»' },
  ]);
  assert.equal(sheet.lines[3], '   Должен: Ожидание a');
  assert.equal(sheet.lines[4], '   Правило 1 · Правила возврата, строка 2: «Верните деньги через терминал.»');
  assert.equal(sheet.lines[5], '');
  // An empty expectation, an unknown rule and the internal machine-format prompt rule.
  assert.deepEqual(sheet.cards[1]!.details, [
    { role: 'unverified', text: 'Должен: ожидание не записано.' },
    { role: 'rule', text: 'Правило 1 · Правила возврата, строка 2: «Верните деньги через терминал.»' },
    { role: 'rule', text: 'Правило 2 · Промпт агента, строка 1: «Отвечайте вежливо.»' },
    { role: 'unverified', text: 'Правило: объяснение не подтверждено цитатой' },
  ]);
  assert.deepEqual(sheet.cards[2]!.details, [
    { role: 'expected', text: 'Должен: Ожидание c' },
    { role: 'unverified', text: 'Правило: у ситуации нет правила из ваших материалов.' },
  ]);
  assert.equal(sheet.cards.every(item => item.ownerEdited === false), true);
  assert.throws(() => expectationSheet({ ...draft, workflow: 'compare' }), /evaluate/);
  assert.throws(() => expectationSheet({ ...draft, phase: 'results_review' }), /незапущенного/);
});

test('the sheet marks a situation the owner changed and the compact form keeps two rules a situation and counts the rest', () => {
  const draft = rulesRecord({ id: 'run_1234567890', scenarios: [sheetCard('a'), sheetCard('b', { requirementIds: ['refund', 'polite', 'unknown_1', 'unknown_2'] })],
    ownerExpectationScenarioIds: ['a'] });
  const sheet = expectationSheet(draft);
  assert.equal(sheet.cards[0]!.ownerEdited, true);
  assert.deepEqual(sheet.cards[0]!.details.at(-1), { role: 'marker', text: 'Ожидание изменено владельцем — с прошлыми прогонами не сравнивается.' });
  assert.equal(sheet.cards[1]!.ownerEdited, false);
  assert.equal(sheet.cards[1]!.details.some(detail => detail.role === 'marker'), false);
  assert.equal(sheet.lines.filter(line => line.includes('Ожидание изменено владельцем')).length, 1);

  const compact = sheet.compactLines();
  assert.equal(compact.filter(line => line.trim().startsWith('Правило')).length, 3, 'at most two rule rows per situation');
  assert.equal(compact.some(line => line.trim() === 'и ещё 2 правила'), true);
  assert.equal(compact.some(line => line.includes('Ожидание изменено владельцем')), true);
  assert.ok(!compact.some(line => line.includes(draft.id.slice(0, 8)) || line.includes('раздел') || line.includes('/agent-lab')), 'no id and no pointer to a screen that is gone');
  assert.equal(compact.at(-1), '   и ещё 2 правила');
});

test('the sheet handles no situations, twelve situations and eleven rules in one situation', () => {
  const empty = expectationSheet(rulesRecord({ scenarios: [] }));
  assert.deepEqual(empty.lines, ['Ситуаций пока нет.', 'Они появятся после подготовки: скажите в чате, что проверить.']);
  assert.deepEqual(empty.cards, []);
  assert.equal(empty.countText, '0 ситуаций');
  assert.deepEqual(empty.compactLines(), empty.lines);

  const many = expectationSheet(rulesRecord({ scenarios: Array.from({ length: 12 }, (_, index) => sheetCard(`card_${index}`)) }));
  assert.equal(many.labelWidth, 3);
  assert.equal(many.countText, '12 ситуаций');
  assert.equal(many.lines[2], ' 1. Ситуация: g');
  assert.equal(many.lines[3], '    Должен: Ожидание card_0');
  assert.equal(many.lines.find(line => line.includes('Ситуация') && line.startsWith('12.')), '12. Ситуация: g');

  const eleven = rulesRecord({
    sources: [{ ...ruleSource, content: Array.from({ length: 11 }, (_, index) => `Правило номер ${index} про возврат.`).join('\n') }],
    requirements: Array.from({ length: 11 }, (_, index) => ({ id: `rule_${index}`, text: `Правило ${index}`, sourceId: ruleSource.id,
      quote: `Правило номер ${index} про возврат.`, critical: false })),
    scenarios: [sheetCard('a', { requirementIds: Array.from({ length: 11 }, (_, index) => `rule_${index}`) })],
  });
  const sheet = expectationSheet(eleven);
  assert.equal(sheet.cards[0]!.details.filter(detail => detail.role === 'rule').length, 11);
  assert.equal(sheet.cards[0]!.details.every(detail => detail.role !== 'unverified'), true);
  assert.equal(sheet.compactLines().some(line => line.trim() === 'и ещё 9 правил'), true);
});

test('trial proof preserves passing and failing dialogue evidence with exact citation ids', () => {
  const fullReply = `Полный ответ\n${'важная деталь '.repeat(120)}`;
  const passedTrial = { ...trial('pass_trial', 'a', 'pass', 'pass'), reason: 'Цель достигнута.',
    events: [{ seq: 2, type: 'assistant' as const, text: fullReply }, { seq: 0, type: 'user' as const, text: 'Исходный вопрос' }],
    checks: [{ id: 'time', description: 'Время изменено точно', passed: true, evidence: 'A.time = 1' }],
    assessments: [{ metricId: 'goal', result: 'pass' as const, rationale: 'Ответ и состояние подтверждают успех.', evidence: [2] }],
  };
  const passedRecord = record({ scenarios: [scenario('a')], trials: [passedTrial] });
  const before = JSON.stringify(passedRecord);
  const passed = trialProofLines(passedRecord, passedTrial.id);
  const passText = passed.lines.join('\n');
  assert.deepEqual({ trialId: passed.trialId, scenarioId: passed.scenarioId, outcome: passed.outcome, automaticVerdict: passed.automaticVerdict, reason: passed.reason },
    { trialId: 'pass_trial', scenarioId: 'a', outcome: 'pass', automaticVerdict: 'pass', reason: 'Цель достигнута.' });
  assert.ok(passText.indexOf('#0 ПОЛЬЗОВАТЕЛЬ') < passText.indexOf('#2 АГЕНТ'), 'dialogue is ordered by persisted seq');
  assert.ok(passText.includes(fullReply.replace('\n', '\n  ')), 'assistant meaning is not truncated');
  assert.match(passText, /PASS \[time\] Время изменено точно\n  Доказательство: A\.time = 1/);
  assert.match(passText, /PASS \[goal\] Цель выполнена · события: #2\n  Обоснование: Ответ и состояние подтверждают успех\./);
  assert.equal(JSON.stringify(passedRecord), before, 'projection is pure');

  const failedTrial = { ...trial('fail_trial', 'a', 'fail', 'fail'), reason: 'Осталось старое время.',
    assessments: [{ metricId: 'goal', result: 'fail' as const, rationale: 'Ответ #1 не достиг цели.', evidence: [1] }] };
  const failed = trialProofLines(record({ scenarios: [scenario('a')], trials: [failedTrial] }), failedTrial.id);
  const failText = failed.lines.join('\n');
  assert.equal(failed.outcome, 'fail');
  assert.match(failText, /Исход: fail\nАвтоматический вердикт: fail\nПричина: Осталось старое время\./);
  assert.match(failText, /FAIL \[time\] Время изменено\n  Доказательство: осталось 0/);
  assert.match(failText, /FAIL \[goal\] Цель выполнена · события: #1/);

  const rubricScenario = scenario('rubric_only', false);
  const rubricTrial = { ...trial('rubric_trial', rubricScenario.id, 'ungraded', 'fail'), checks: [] };
  const rubricProof = trialProofLines(record({ scenarios: [rubricScenario], trials: [rubricTrial] }), rubricTrial.id);
  assert.equal(rubricProof.outcome, 'ungraded');
  assert.equal(rubricProof.automaticVerdict, 'fail');
  assert.match(rubricProof.lines.join('\n'), /Исход: ungraded\nАвтоматический вердикт: fail/);
  assert.throws(() => trialProofLines(passedRecord, 'missing'), /не найден/);
});

test('a legacy card without the goal rubric is counted by the strict rule, and its recorded cause is named', () => {
  const r = record({ trials: [trial('t1', 'a', 'pass', 'pass'), trial('t2', 'b', 'fail', 'fail', 'fail'), trial('t3', 'c', 'pass', 'unknown')],
    failureModes: [{ id: 'm1', name: 'Переспрашивает терминал вместо пути', description: 'Агент задаёт уточнение там, где нужен путь.', stage: 'сборка ответа', trialIds: ['t2'], promptQuotes: ['Отвечай сразу, если данных достаточно'] }] });
  const view = buildResultView(r);
  assert.deepEqual(view.cards.map(card => [card.scenarioId, card.outcome, card.goal, card.rules]), [['a', 'pass', 'none', 'none'], ['b', 'fail', 'none', 'none'], ['c', 'unknown', 'none', 'none']]);
  assert.deepEqual([view.headline.passed, view.headline.decided, view.headline.accuracy], [1, 2, 0.5]);
  assert.deepEqual(view.notMeasured.reasons.map(reason => reason.scenarioIds), [['c']], 'an undecided criterion leaves the situation unmeasured');
  assert.deepEqual(view.topCauses.map(cause => [cause.name, cause.count, cause.scenarioIds, cause.example.trialId]), [['Переспрашивает терминал вместо пути', 1, ['b'], 't2']]);
});

test('the headline counts a situation as handled only when the request was met and the prompt rules were kept', () => {
  const goalAttainment = { ...goal, id: 'goal_attainment', name: 'Достижение цели' };
  const promptCompliance = { ...format, id: 'prompt_compliance', name: 'Соблюдение промпта' };
  const scenarios = ['solved', 'failed', 'broken'].map(id => ({ ...scenario(id, false), metrics: [goalAttainment, promptCompliance] }));
  const assessed = (id: string, scenarioId: string, goalResult: 'pass' | 'fail', promptResult: 'pass' | 'fail'): Trial => ({
    ...trial(id, scenarioId, 'ungraded', goalResult, promptResult), checks: [], assessments: [
      { metricId: 'goal_attainment', result: goalResult, rationale: 'goal', evidence: [1] },
      { metricId: 'prompt_compliance', result: promptResult, rationale: 'prompt', evidence: [1] },
    ],
  });
  const invalid = { ...assessed('t3', 'broken', 'fail', 'fail'), outcome: 'invalid' as const, assessments: undefined };
  const view = buildResultView(record({ scenarios, trials: [assessed('t1', 'solved', 'pass', 'fail'), assessed('t2', 'failed', 'fail', 'fail'), invalid],
    failureModes: [{ id: 'business', name: 'Бизнес-причина', description: 'd', trialIds: ['t2'] }] }));
  // Phase 03.1: t1 met the request but broke a prompt rule, so it is not «справился».
  assert.deepEqual(view.cards.map(card => [card.scenarioId, card.outcome, card.goal, card.rules]),
    [['solved', 'fail', 'pass', 'fail'], ['failed', 'fail', 'fail', 'fail'], ['broken', 'unknown', 'unknown', 'unknown']]);
  assert.deepEqual([view.headline.passed, view.headline.decided, view.headline.accuracy], [0, 2, 0]);
  assert.deepEqual(view.notMeasured.reasons.map(reason => [reason.code, reason.scenarioIds]), [['agent_error', ['broken']]]);
  assert.deepEqual(view.breakdown.goal, { met: 1, decided: 2 });
  assert.deepEqual([view.breakdown.rules.broken, view.breakdown.rules.decided], [2, 2]);
  // The saved example is the verified agent reply of that dialogue, not the judge's rationale.
  const example = view.topCauses[0]?.example;
  assert.equal(example?.trialId, 't2', 'a business failure explains the headline');
  assert.deepEqual(example?.said, { seq: 1, quote: 'ok', judgeCited: true }, 'the quote is the reply the judge pointed at');
});

// ---- Phase 03.1: the report number is the CLI number — same rule, same non-control cards. ----
const GOAL_ATTAINMENT = { ...goal, id: 'goal_attainment', name: 'Достижение цели' };
const PROMPT_COMPLIANCE = { ...format, id: 'prompt_compliance', name: 'Соблюдение правил промпта' };
const REPLY_QUALITY = { ...format, id: 'reply_quality', name: 'Качество ответа' };
type Verdict = 'pass' | 'fail' | 'unknown';
/** One attempt judged on the given rubrics; `votes` are in the order of `metrics`. */
function judgedCard(id: string, metrics: typeof goal[], votes: Verdict[]): { scenario: Scenario; trial: Trial } {
  const card = { ...scenario(id, false), metrics };
  const attempt: Trial = { ...trial(`t-${id}`, id, 'ungraded', 'pass'), checks: [],
    assessments: metrics.map((metric, i) => ({ metricId: metric.id, result: votes[i]!, rationale: 'r', evidence: votes[i] === 'unknown' ? [] : [1] })) };
  return { scenario: card, trial: attempt };
}
function judgedRecord(cards: ReturnType<typeof judgedCard>[], overrides: Partial<Experiment> = {}): Experiment {
  return record({ scenarios: cards.map(c => c.scenario), trials: cards.map(c => c.trial), ...overrides });
}

test('the report counts the same non-control situations by the same rule as the CLI headline', () => {
  const rubrics = [GOAL_ATTAINMENT, PROMPT_COMPLIANCE];
  const r = judgedRecord([
    judgedCard('met', rubrics, ['pass', 'pass']), judgedCard('broke', rubrics, ['pass', 'fail']), judgedCard('missed', rubrics, ['fail', 'pass']),
    judgedCard('unsure', rubrics, ['pass', 'unknown']), judgedCard('ctl', rubrics, ['pass', 'fail']),
  ], { positiveControlScenarioIds: ['ctl'] });
  const view = buildResultView(r);
  assert.deepEqual([view.headline.passed, view.headline.decided], [1, 3]);
  assert.deepEqual(view.notMeasured.reasons.map(reason => reason.scenarioIds), [['unsure']]);
  assert.deepEqual(view.control.cards.map(card => [card.scenarioId, card.outcome]), [['ctl', 'pass']], 'the control is decided by its goal alone and never counted');
  assert.equal(view.control.alarm, null);
  assert.equal(accuracyRow(view).text, 'Точность агента: 33% — справился в 1 из 3 ситуаций');
  assert.match(plainText(resultScreen(view, { surface: 'cli' }), 100), /Точность агента: 33% — справился в 1 из 3 ситуаций/);
  const html = htmlReport(r);
  assert.ok(html.includes('33%') && html.includes('справился в 1 из 3 ситуаций'), 'the report prints the same number');
});

test('reply quality never moves the headline: a met request with kept rules and a quality failure is «справился»', () => {
  const rubrics = [GOAL_ATTAINMENT, PROMPT_COMPLIANCE, REPLY_QUALITY];
  const view = buildResultView(judgedRecord([judgedCard('a', rubrics, ['pass', 'pass', 'fail']), judgedCard('b', rubrics, ['fail', 'fail', 'pass'])]));
  assert.deepEqual(view.cards.map(card => [card.scenarioId, card.outcome]), [['a', 'pass'], ['b', 'fail']]);
  assert.deepEqual([view.headline.passed, view.headline.decided], [1, 2]);
});

test('an unresolved simulator flag leaves the situation unmeasured instead of counting it as a failure', () => {
  const t = trial('t1', 'a', 'pass', 'fail', 'pass', 'reactive');
  t.events.push({ seq: 2, type: 'simulator', result: { message: '4321', done: false } }, { seq: 3, type: 'user', text: '4321' }, { seq: 4, type: 'assistant', text: 'ok' });
  t.simulatorChecks = [{ id: 'simulator_fabrication', description: 'd', evidence: 'Подозрение: реплика #3', passed: false, heuristic: true, seq: 3 }];
  const r = record({ scenarios: [scenario('a')], settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }), trials: [t] });
  const flagged = buildResultView(r);
  assert.deepEqual(flagged.cards.map(card => [card.outcome, card.reason]), [['unknown', 'simulator_deviated']]);
  assert.equal(flagged.headline.decided, 0);
  // A human clears the suspicion: the same dialogue becomes a decided failure, explained by the verified agent reply.
  const cleared = buildResultView({ ...r, humanReviews: [{ id: 'h', trialId: 't1', verdict: 'pass', note: 'ложная тревога', createdAt: '2026-09-14T00:00:00Z', checkId: 'simulator_fabrication' }] });
  assert.deepEqual([cleared.headline.passed, cleared.headline.decided], [0, 1]);
  assert.deepEqual(cleared.failures[0]?.said, { seq: 1, quote: 'ok', judgeCited: true }, 'the verified agent reply is quoted, never the judge rationale');
});

test('plural forms', () => {
  assert.deepEqual([1, 2, 5, 11, 21, 22].map(n => countText(n, ['диалог', 'диалога', 'диалогов'])), ['1 диалог', '2 диалога', '5 диалогов', '11 диалогов', '21 диалог', '22 диалога']);
});

test('a situation with a missing planned repeat is unmeasured, not a pass', () => {
  const view = buildResultView(record({ settings: settingsSchema.parse({ userModes: ['static'], repeats: 2 }), scenarios: [scenario('a')], trials: [trial('t1', 'a', 'pass', 'pass')] }));
  assert.deepEqual(view.cards.map(card => [card.outcome, card.reason]), [['unknown', 'attempts_mismatch']]);
  assert.equal(view.headline.decided, 0);
  assert.equal(exitCodeOf(view), 2);
});

test('duplicate attempts cannot replace missing repeats, and selected reassessments use their selected attempts', () => {
  const first = trial('t1', 'a', 'pass', 'pass');
  const r = record({ scenarios: [scenario('a')], settings: settingsSchema.parse({ userModes: ['static'], repeats: 2 }), trials: [first, { ...first, id: 't2' }] });
  assert.deepEqual(buildResultView(r).cards.map(card => card.outcome), ['unknown']);
  const reassessed = { ...r, assessmentTrialIds: ['t1'], trials: [first] };
  assert.deepEqual(buildResultView(reassessed).cards.map(card => card.outcome), ['pass']);
});

test('a saved failure cluster is explained by an attempt that still fails after the human rubric verdicts', () => {
  const corrected = trial('t1', 'a', 'pass', 'fail');
  const failed = { ...trial('t2', 'a', 'pass', 'fail', 'fail'), repeat: 1 };
  const r = record({ scenarios: [scenario('a')], settings: settingsSchema.parse({ userModes: ['static'], repeats: 2 }), trials: [corrected, failed],
    humanReviews: [review('t1', 'goal', 'pass'), review('t2', 'goal', 'pass')],
    failureModes: [{ id: 'saved', name: 'Сохранённый кластер', description: 'd', trialIds: ['t1', 't2'] }] });
  const view = buildResultView(r);
  assert.deepEqual(view.cards.map(card => [card.outcome, card.flaky]), [['fail', true]], 'the corrected attempt passes, the other still fails');
  assert.deepEqual(view.topCauses.map(cause => [cause.name, cause.count, cause.example.trialId, cause.example.said?.quote]), [['Сохранённый кластер', 1, 't2', 'ok']]);
});

test('the view separates decided, undecided and stopped situations and counts every current dialogue', () => {
  const invalid = { ...trial('cancelled', 'c', 'fail', 'fail'), outcome: 'cancelled' as const };
  const view = buildResultView(record({ trials: [trial('t1', 'a', 'pass', 'pass'), trial('t2', 'b', 'pass', 'unknown'), invalid] }));
  assert.deepEqual([view.headline.passed, view.headline.decided], [1, 1]);
  assert.deepEqual(view.notMeasured.reasons.map(reason => [reason.code, reason.scenarioIds]), [['stopped', ['c']], ['judge_unclear', ['b']]]);
  assert.equal(view.scope.dialogues, 3);
});

test('a cause example that cannot be quoted says so instead of showing a judge rationale', () => {
  const failed = trial('t1', 'a', 'fail', 'fail');
  // No exact check, and the judge cites words the stored reply does not contain.
  failed.checks = [];
  failed.assessments = [{ metricId: 'goal', result: 'fail', rationale: 'Агент ошибся.', evidence: [1], citations: [{ seq: 1, quote: 'этого в ответе нет' }] }];
  const view = buildResultView(record({ scenarios: [scenario('a', false)], trials: [failed],
    failureModes: [{ id: 'c', name: 'Причина', description: 'd', trialIds: ['t1'] }] }));
  assert.equal(view.topCauses[0]?.example.said, null);
  assert.ok(!JSON.stringify(view.topCauses[0]).includes('Агент ошибся'));

  // No surface may wrap that status line in «…»: doing so states that the agent said it.
  const causes = plainText(causeRows(view, { examples: true }), 100);
  assert.match(causes, /Агент: ответ не подтверждён цитатой/);
  assert.doesNotMatch(causes, /«ответ не подтверждён цитатой»/);
});

test('a verified reply is still quoted, and only a verified one', () => {
  const failed = trial('t1', 'a', 'fail', 'fail');
  failed.checks = [];
  const view = buildResultView(record({ scenarios: [scenario('a', false)], trials: [failed],
    failureModes: [{ id: 'c', name: 'Причина', description: 'd', trialIds: ['t1'] }] }));
  assert.equal(view.topCauses[0]?.example.said?.quote, 'ok');
  assert.match(plainText(causeRows(view, { examples: true }), 100), /Агент: «ok»/);
});

test('a cause example keeps the whole agent reply; every surface wraps it', () => {
  const long = `Здравствуйте! ${'Разъясняю условия эквайринга по пунктам. '.repeat(40)}`.trim();
  const failed = trial('t1', 'a', 'fail', 'fail');
  failed.checks = [];
  failed.events = [{ seq: 0, type: 'user', text: 'hi' }, { seq: 1, type: 'assistant', text: long }];
  const view = buildResultView(record({ scenarios: [scenario('a', false)], trials: [failed],
    failureModes: [{ id: 'c', name: 'Причина', description: 'd', trialIds: ['t1'] }] }));
  assert.ok(long.length > 1000);
  assert.equal(view.topCauses[0]?.example.said?.quote, long);
});

test('required checkpoint decisions reach the headline while diagnostics remain explanatory', async () => {
  const { storedRunV1 } = await import('./helpers/library-v1.js');
  // A stored first-format card, compiled when it was accepted; its attempt carries the checkpoint judge's verdicts.
  const s = storedRunV1().scenarios.find(item => item.id === 'known_number')!;
  const t = trial('controlled', s.id, 'ungraded', 'pass'); t.familyId = s.familyId; t.checks = []; t.initialState = s.initialState; t.finalState = s.initialState;
  t.assessments = [{ metricId: 'library_required', result: 'pass', rationale: 'Корректный отказ', evidence: [1] }];
  t.checkpoints = [{ checkpointId: 'ask_once', requirementId: 'refund_rule', observation: 'reply', role: 'required', result: 'fail', evidence: [1], rationale: 'Номер запрошен повторно' },
    { checkpointId: 'refund_explanation', requirementId: 'refund_rule', observation: 'reply', role: 'required', result: 'pass', evidence: [1], rationale: 'Возврат объяснён' },
    { checkpointId: 'diagnostic', requirementId: 'refund_rule', observation: 'reply', role: 'diagnostic', result: 'fail', evidence: [1], rationale: 'Диагностика' }];
  const r = record({ scenarios: [s], trials: [t] });
  // A derivation is remembered per record snapshot, so each reading takes a fresh copy of the mutated record.
  const accuracy = () => buildResultView({ ...r }).headline.accuracy;
  assert.equal(accuracy(), 0);
  t.checkpoints[0]!.result = 'pass';
  assert.equal(accuracy(), 1, 'the failed diagnostic decides nothing');
  t.checkpoints[0]!.result = 'unknown';
  assert.equal(accuracy(), null);
  assert.match(trialProofLines(r, t.id).lines.join('\n'), /КОНТРОЛЬНЫЕ ТОЧКИ/);
  assert.match(trialProofLines(r, t.id).lines.join('\n'), /refund_rule/);
});

test('a first-format checkpoint with an exact check is a direct check of every newly judged attempt', async () => {
  const { storedRunV1 } = await import('./helpers/library-v1.js');
  const s = structuredClone(storedRunV1().scenarios.find(item => item.id === 'known_number')!);
  const execution = s.execution as VariantExecution;
  const literal = { id: 'literal', kind: 'answer_equals' as const, description: 'Точная инструкция', value: 'Инструкция' };
  execution.evaluatorView.checkpoints = [{ ...execution.evaluatorView.checkpoints[0]!, check: literal }];
  s.checks = [literal];
  const t = trial('controlled_exact', s.id, 'pass', 'pass'); t.familyId = s.familyId; t.initialState = s.initialState; t.finalState = s.initialState; t.assessments = [];
  t.checks = [{ id: 'literal', description: 'Точная инструкция', passed: true, evidence: 'Последний ответ совпал' }];
  const r = record({ scenarios: [s], trials: [t] });
  // A derivation is remembered per record snapshot, so each reading takes a fresh copy of the mutated record.
  const accuracy = () => buildResultView({ ...r }).headline.accuracy;
  assert.equal(accuracy(), 1, 'nothing is left to judge: the exact check decides');
  t.checks[0]!.passed = false; t.outcome = 'fail';
  assert.equal(accuracy(), 0);
});

