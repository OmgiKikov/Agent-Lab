import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { discoveryBrief, expectationSheet, qualityLines, qualitySummary, plural, scoreBrief, shorten, testPlanLines, trialProofLines } from '../src/quality.js';
import { emptyUsage, RAG_RUBRICS, settingsSchema, type Experiment, type HumanReview, type Scenario, type Trial } from '../src/contracts.js';
import { draftHash } from '../src/experiment.js';
import { demoEvaluateRecord } from './helpers/demo-record.js';
import { verdictSummary } from '../src/comparison.js';
import { buildResultView } from '../src/result-view.js';
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

test('RAG diagnostics remain independent of accuracy and require complete usable evidence', () => {
  const t = trial('rag_trial', 'a', 'pass', 'pass');
  t.events.splice(1, 0, { seq: 2, type: 'retrieval', result: { chunks: [], complete: true } });
  t.assessments!.push(...RAG_RUBRICS.map(metric => ({ metricId: metric.id, result: 'fail' as const, evidence: [2], rationale: 'Missing context' })));
  const r = record({ scenarios: [scenario('a')], trials: [t] });
  const q = qualitySummary(r);
  assert.equal(q.cards.accuracy, 1); assert.equal(q.strict.accuracy, 1);
  assert.equal(q.rag.complete, 1); assert.equal(q.rag.signals.length, 1);
  assert.equal(q.metrics.filter(m => m.id.startsWith('rag_')).length, 3);
  assert.match(qualityLines(q).rag.join(' '), /не хватает знания/);
  (t.events[1]!.result as { complete: boolean }).complete = false;
  assert.equal(qualitySummary(r).rag.signals.length, 0);
  assert.equal(qualitySummary(r).rag.partial, 1);
  t.events.splice(1, 1);
  assert.deepEqual(qualityLines(qualitySummary(r)).rag, [], 'without retrieval evidence the first screen says nothing about RAG');
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
  assert.match(text, /^ТЕСТ\nСИТУАЦИЯ\n  Название: Карточка a/m);
  for (const expected of ['Цель: Получить точный ответ', 'Факты: Тариф известен владельцу', 'Поведение: Отвечает кратко',
    'Максимум продолжений: 2', 'Персона: Владелец магазина', 'Характеристики:', '- Не любит жаргон',
    'Известно пользователю:', '- Номер точки 42', 'Пользователь не знает:', '- Внутренний ID',
    'Ответы на уточнения:', '«Какая точка?» → «42»', 'Требования:', '- [policy] Назвать точный тариф. · policy.md: «Тариф должен быть 1%.»', 'Допущения:',
    'Исходное состояние:', 'Режимы: static', 'static · только начальная реплика',
    'Точные проверки:', '[answer] Точный ответ', 'Последний ответ в точности: "Тариф 1%"',
    'Рубрики судьи:', '[goal] Цель выполнена · agent', 'PASS: p', 'FAIL: f']) assert.ok(text.includes(expected), expected);
  assert.ok(text.includes(opening.replace('\n', '\n  ')));
  assert.ok(text.includes(success.replace('\n', '\n  ')));
  assert.doesNotMatch(text, /Уточнение один|Уточнение два/, 'script is not executed or shown in static mode');
  assert.match(text, /НАБЛЮДЕНИЕ\n  ответ агента \(reply\)/);
  assert.match(text, /Этот тест действительно проверяет нужное поведение\?$/);

  const scripted = testPlanLines({ ...current, settings: settingsSchema.parse({ userModes: ['scripted'], maxTurns: 6 }) });
  assert.match(scripted.lines.join('\n'), /scripted · продолжения:\n  1\. Уточнение один\n  2\. Уточнение два/);
});

test('acceptance projection rejects ambiguous drafts and names tool/state observations exactly', () => {
  const base = record({ phase: 'review', reviewMode: null, scenarios: [{ ...scenario('a'), successCriteria: 'Готово' }] });
  assert.throws(() => testPlanLines(base), /канал наблюдения/);
  assert.throws(() => testPlanLines({ ...base, scenarios: [] }), /ровно один/);
  assert.throws(() => testPlanLines({ ...base, workflow: 'compare' }), /evaluate/);
  assert.throws(() => testPlanLines({ ...base, phase: 'results_review' }), /незапущенный/);
  const tool = testPlanLines({ ...base, scenarios: [{ ...base.scenarios[0]!, goalObservation: 'tool' }] });
  assert.match(tool.lines.join('\n'), /НАБЛЮДЕНИЕ\n  результат инструмента \(tool\)/);
  const stateRecord = { ...base, scenarios: [{ ...base.scenarios[0]!, goalObservation: 'state' as const,
    initialState: { records: { A: { status: 'new' } }, writableFields: ['status'], transientFailures: 0 } }] };
  const state = testPlanLines(stateRecord);
  assert.match(state.lines.join('\n'), /Исходное состояние: \{"records":\{"A":\{"status":"new"\}\},"writableFields":\["status"\],"transientFailures":0\}/);
  assert.match(state.lines.join('\n'), /НАБЛЮДЕНИЕ\n  итоговое состояние \(state\)/);
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
  assert.deepEqual(sheet.boardHead, ['ЧТО АГЕНТ ДОЛЖЕН СДЕЛАТЬ', '3 ситуации · номер правила — порядок в ваших материалах']);
  assert.equal(sheet.lines[0], 'Что агент должен сделать: 3 ситуации. Номер правила — порядок в ваших материалах.');
  assert.equal(sheet.lines[1], '');
  assert.equal(sheet.lines.at(-1), `Версия ожиданий: ${draftHash(draft).slice(0, 12)}`);
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

test('the sheet marks a situation the owner changed and the compact form points at the full list', () => {
  const draft = rulesRecord({ id: 'run_1234567890', scenarios: [sheetCard('a'), sheetCard('b', { requirementIds: ['refund', 'polite', 'unknown_1', 'unknown_2'] })],
    ownerExpectationScenarioIds: ['a'] });
  const sheet = expectationSheet(draft);
  assert.equal(sheet.cards[0]!.ownerEdited, true);
  assert.deepEqual(sheet.cards[0]!.details.at(-1), { role: 'marker', text: 'Ожидание изменено владельцем — с прошлыми прогонами не сравнивается.' });
  assert.equal(sheet.cards[1]!.ownerEdited, false);
  assert.equal(sheet.cards[1]!.details.some(detail => detail.role === 'marker'), false);
  assert.equal(sheet.lines.filter(line => line.includes('Ожидание изменено владельцем')).length, 1);

  const compact = sheet.compactLines(draft.id);
  assert.equal(compact.filter(line => line.trim().startsWith('Правило')).length, 3, 'at most two rule rows per situation');
  assert.equal(compact.some(line => line.trim() === 'и ещё 2 правила'), true);
  assert.equal(compact.some(line => line.includes('Ожидание изменено владельцем')), true);
  assert.equal(compact.at(-2), `Все правила — /agent-lab ${draft.id.slice(0, 8)}, раздел 2.`);
  assert.equal(compact.at(-1), sheet.lines.at(-1));
});

test('the sheet handles no situations, twelve situations and eleven rules in one situation', () => {
  const empty = expectationSheet(rulesRecord({ scenarios: [] }));
  assert.deepEqual(empty.lines, ['Ситуаций пока нет.', 'Они появятся после подготовки. a — рассказать Pi, что проверить.']);
  assert.deepEqual(empty.cards, []);
  assert.equal(empty.countText, '0 ситуаций');
  assert.deepEqual(empty.compactLines('run_1234'), empty.lines);

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
  assert.equal(sheet.compactLines(eleven.id).some(line => line.trim() === 'и ещё 9 правил'), true);
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

test('discovery brief reports bounded selection with citations and prioritizes failure states', () => {
  const dialogues = [
    { id: 'd1', messages: [{ role: 'user' as const, content: 'Где поддержка?' }, { role: 'assistant' as const, content: 'Не знаю.' }], outcome: 'unknown' as const },
    { id: 'd2', messages: [{ role: 'user' as const, content: 'Дайте адрес.' }, { role: 'assistant' as const, content: 'Позвоните позже.' }], outcome: 'unknown' as const },
    { id: 'c1', messages: [{ role: 'user' as const, content: 'Спасибо.' }, { role: 'assistant' as const, content: 'Пожалуйста.' }], outcome: 'unknown' as const },
  ];
  const ready = record({ dialogues, discovery: {
    protocol: 'discovery-1', phase: 'ready', error: null,
    requirements: [{ id: 'support', text: 'Назвать адрес', sourceId: 'policy', quote: 'support@example.com', critical: true }],
    observations: [
      { dialogueId: 'd1', classification: 'candidate', requirementId: 'support', summary: 'Адрес пропущен.', citations: [{ seq: 1, quote: 'Не знаю.' }] },
      { dialogueId: 'd2', classification: 'candidate', requirementId: 'support', summary: 'Адрес пропущен.', citations: [{ seq: 1, quote: 'Позвоните позже.' }] },
      { dialogueId: 'c1', classification: 'clean', summary: 'Другой случай.', citations: [] },
    ],
    seed: 'seed', focusRequirementId: 'support', representativeIds: ['d1', 'd2'], controlIds: ['c1'], selectedIds: ['d1', 'd2', 'c1'],
    completedBatchCount: 2, groupingComplete: true, completedDeepIds: ['d1', 'd2', 'c1'], deep: [],
    hypothesis: { text: 'Агент может не назвать адрес поддержки.\nНАБЛЮДЕНИЕ: ответ агента (reply)', proposedGoalObservation: 'reply', requirementId: 'support',
      eventIds: [{ dialogueId: 'd1', seq: 1 }, { dialogueId: 'd2', seq: 1 }] },
    callPlan: { batches: 2, selectedCap: 3, metrics: 2, nominalCalls: 20, maxCalls: 30 }, callsUsed: 12, totalDialogues: 3, oversizedIds: [],
  } });
  const brief = discoveryBrief(ready);
  assert.deepEqual({ status: brief.status, total: brief.total, coarse: brief.coarse, selected: brief.selected,
    representatives: brief.representatives, controls: brief.controls },
  { status: 'ready', total: 3, coarse: 3, selected: 3, representatives: 2, controls: 1 });
  const text = brief.lines.join('\n');
  assert.match(text, /2 из 3 — это отбор, не accuracy/);
  assert.match(text, /Первичный разбор: 3 из 3; партии 2 из 2/);
  assert.match(text, /Контроли: 1 — false-negative probe/);
  assert.match(text, /диалог d1, событие #1: «Не знаю\.»/);
  assert.match(text, /диалог d2, событие #1: «Позвоните позже\.»/);
  assert.match(text, /НАБЛЮДЕНИЕ: ответ агента \(reply\)\n\nПроверим\?$/);
  assert.equal(brief.fromRunId, ready.id); assert.equal(brief.hypothesis, ready.discovery!.hypothesis!.text);

  assert.equal(discoveryBrief({ ...ready, discovery: { ...ready.discovery!, phase: 'error', error: 'bad' } }).status, 'error');
  assert.equal(discoveryBrief({ ...ready, discovery: { ...ready.discovery!, phase: 'budget_exhausted', error: 'budget' } }).status, 'budget_exhausted');
  assert.equal(discoveryBrief({ ...ready, discovery: { ...ready.discovery!, phase: 'partial', error: 'partial' } }).status, 'partial');
  assert.equal(discoveryBrief({ ...ready, discovery: { ...ready.discovery!, phase: 'insufficient', hypothesis: undefined } }).status, 'insufficient');
  assert.equal(discoveryBrief({ ...ready, discovery: undefined }).status, 'insufficient');
});

test('the first screen counts cards, criteria and causes from the shared outcome rules and names what a person still has to look at', () => {
  const r = record({ trials: [trial('t1', 'a', 'pass', 'pass'), trial('t2', 'b', 'fail', 'fail', 'fail'), trial('t3', 'c', 'pass', 'unknown')],
    failureModes: [{ id: 'm1', name: 'Переспрашивает терминал вместо пути', description: 'Агент задаёт уточнение там, где нужен путь.', stage: 'сборка ответа', trialIds: ['t2'], promptQuotes: ['Отвечай сразу, если данных достаточно'] }] });
  const q = qualitySummary(r);
  assert.deepEqual(q.cards, { passed: 1, failed: 1, unknown: 1, invalid: 0, notReached: 0, total: 3, accuracy: 0.5 });
  assert.equal(q.headline, 'Справился с 1 из 2 карточек (50%), 1 без решения; разобрано человеком 0 из 3 диалогов.');
  assert.deepEqual(q.metrics.map(m => [m.id, m.passed, m.failed, m.unknown]), [['code', 2, 1, 0], ['goal', 1, 1, 1], ['format', 2, 1, 0]]);
  assert.equal(q.metrics[0]!.kind, 'code');
  assert.equal(q.causes.length, 1);
  assert.equal(q.causes[0]!.example?.card, 'Карточка b');
  assert.equal(q.causes[0]!.example?.quote, 'осталось 0', 'a failed exact check is quoted before the judge');
  assert.deepEqual(q.causes[0]!.promptQuotes, ['Отвечай сразу, если данных достаточно']);
  assert.deepEqual(q.humanQueue, { unknownJudgments: 1, disagreements: 0, simulatorFlags: 0, total: 1, pendingFailures: 0 });
  assert.match(q.judge.label, /автоматически оценено 2 из 3; без решения 1/);
  assert.match(q.limits, /судья не сверен с человеком/);
  const text = qualityLines(q);
  assert.match(text.metrics[0]!, /^███████░░░  67%  Точные проверки · код · 2\/3$/);
  assert.match(text.causes[0]!, /^1\. Переспрашивает терминал вместо пути — 1 диалог\. Карточка b: «осталось 0» · правило промпта: «Отвечай сразу/);
  assert.match(text.scope, /3 карточки · 3 диалога · одна реплика · golden 3 · версия песочница · \$0\.27 · 3 мин/);
  assert.match(text.queue, /Разметить человеку: 1/);
});

test('business accuracy follows the headline rule (request met and prompt rules kept) while strict success and other rubric failures stay separate', () => {
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
  const q = qualitySummary(record({ scenarios, trials: [assessed('t1', 'solved', 'pass', 'fail'), assessed('t2', 'failed', 'fail', 'fail'), invalid],
    failureModes: [{ id: 'business', name: 'Бизнес-причина', description: 'd', trialIds: ['t2'] }] }));
  assert.equal(q.primary, 'goal_attainment');
  // Phase 03.1 (deliberate pin change): t1 met the request but broke a prompt rule, so it is no longer «справился».
  assert.deepEqual(q.cards, { passed: 0, failed: 2, unknown: 0, invalid: 1, notReached: 0, total: 3, accuracy: 0 });
  assert.deepEqual(q.strict, { passed: 0, failed: 2, unknown: 0, invalid: 1, notReached: 0, total: 3, accuracy: 0, goalMetWithOtherFailures: 0 });
  assert.ok(q.headline.startsWith('Справился (запрос выполнен и правила промпта соблюдены) в 0 из 2 карточек (0%). '), q.headline);
  assert.match(q.headline, /Полностью прошли все критерии: 0 из 2 \(0%\)/);
  assert.doesNotMatch(q.headline, /провален другой критерий/);
  assert.doesNotMatch(q.headline, /Бизнес-цель|по цели/);
  assert.match(q.headline, /\. Невалидно: 1; разобрано человеком 0 из 3 диалогов\.$/);
  assert.equal(q.cardsLabel, 'Справился · запрос и правила промпта');
  // The saved example is the verified agent reply of that dialogue, not the judge's rationale.
  assert.equal(q.causes[0]?.example?.quote, 'ok');
  assert.equal(q.causes[0]?.example?.seq, 1);
  assert.equal(q.causes[0]?.example?.explanation?.trialId, 't2', 'a business failure explains the headline before secondary prompt/style failures');
  assert.equal(q.causes[0]?.example?.explanation?.said?.judgeCited, true, 'the quote is the reply the judge pointed at');
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

test('the report counts the same non-control cards by the same rule as the CLI headline', () => {
  const rubrics = [GOAL_ATTAINMENT, PROMPT_COMPLIANCE];
  const r = judgedRecord([
    judgedCard('met', rubrics, ['pass', 'pass']), judgedCard('broke', rubrics, ['pass', 'fail']), judgedCard('missed', rubrics, ['fail', 'pass']),
    judgedCard('unsure', rubrics, ['pass', 'unknown']), judgedCard('ctl', rubrics, ['pass', 'fail']),
  ], { positiveControlScenarioIds: ['ctl'] });
  const q = qualitySummary(r);
  const view = buildResultView(r);
  assert.equal(q.cards.passed, view.headline.passed);
  assert.equal(q.cards.passed + q.cards.failed, view.headline.decided);
  assert.deepEqual(q.cards, { passed: 1, failed: 2, unknown: 1, invalid: 0, notReached: 0, total: 4, accuracy: 1 / 3 }, 'the control is not in the cards');
  assert.equal(q.strict.total, 4, 'nor in the strict score');
  assert.equal(view.headline.text, 'Справился в 1 из 3 проверенных ситуаций — 33%.');
  assert.ok(q.headline.startsWith('Справился (запрос выполнен и правила промпта соблюдены) в 1 из 3 карточек (33%). '), q.headline);
  assert.match(q.headline, /\. Без решения: 1; разобрано человеком 0 из 5 диалогов\.$/);
  assert.equal(q.cardsLabel, 'Справился · запрос и правила промпта');
  assert.ok(htmlReport(r).includes('<h3>Справился · запрос и правила промпта</h3>'), 'the HTML grid carries the same label');
  assert.ok(!htmlReport(r).includes('Достижение бизнес-цели'));
});

test('reply quality never moves the report number: it is its own row, and a pass with a quality failure is counted and named', () => {
  const rubrics = [GOAL_ATTAINMENT, PROMPT_COMPLIANCE, REPLY_QUALITY];
  const q = qualitySummary(judgedRecord([judgedCard('a', rubrics, ['pass', 'pass', 'fail']), judgedCard('b', rubrics, ['fail', 'fail', 'pass'])]));
  assert.deepEqual([q.cards.passed, q.cards.failed], [1, 1]);
  assert.equal(q.strict.goalMetWithOtherFailures, 1);
  assert.ok(q.headline.startsWith('Справился (запрос выполнен и правила промпта соблюдены) в 1 из 2 карточек (50%). Полностью прошли все критерии: 0 из 2 (0%). В 1 карточке справился, но провален другой критерий. '), q.headline);
  const quality = q.metrics.find(m => m.id === 'reply_quality');
  assert.ok(quality, 'reply quality keeps its own row');
  assert.deepEqual([quality!.passed, quality!.failed], [1, 1]);
});

test('cardsLabel names the rule the number is counted by', () => {
  assert.equal(qualitySummary(judgedRecord([judgedCard('a', [GOAL_ATTAINMENT, PROMPT_COMPLIANCE], ['pass', 'pass'])])).cardsLabel, 'Справился · запрос и правила промпта');
  const goalOnly = qualitySummary(judgedRecord([judgedCard('a', [GOAL_ATTAINMENT, REPLY_QUALITY], ['pass', 'fail'])]));
  assert.equal(goalOnly.cardsLabel, 'Справился · запрос');
  assert.ok(goalOnly.headline.startsWith('Справился (запрос выполнен) в 1 из 1 карточки (100%). '), goalOnly.headline);
  const legacy = qualitySummary(record({ scenarios: [scenario('a')], trials: [trial('t1', 'a', 'pass', 'pass')] }));
  assert.equal(legacy.primary, 'all_criteria');
  assert.equal(legacy.cardsLabel, 'Справился · карточки');
  assert.ok(htmlReport(record({ scenarios: [scenario('a')], trials: [trial('t1', 'a', 'pass', 'pass')] })).includes('<h3>Справился · карточки</h3>'));
  // A control whose rules were broken never turns a goal-only set into a ruled one.
  const mixed = qualitySummary(judgedRecord([judgedCard('a', [GOAL_ATTAINMENT], ['pass']), judgedCard('ctl', [GOAL_ATTAINMENT, PROMPT_COMPLIANCE], ['pass', 'fail'])], { positiveControlScenarioIds: ['ctl'] }));
  assert.equal(mixed.cardsLabel, 'Справился · запрос');
});

test('an unresolved simulator flag makes the card undecided on the first screen instead of counting as a failure, and clusters fall back to weak spots', () => {
  const t = trial('t1', 'a', 'pass', 'fail', 'pass', 'reactive');
  t.events.push({ seq: 2, type: 'simulator', result: { message: '4321', done: false } }, { seq: 3, type: 'user', text: '4321' }, { seq: 4, type: 'assistant', text: 'ok' });
  t.simulatorChecks = [{ id: 'simulator_fabrication', description: 'd', evidence: 'Подозрение: реплика #3', passed: false, heuristic: true, seq: 3 }];
  const r = record({ scenarios: [scenario('a')], settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }), trials: [t] });
  const flagged = qualitySummary(r);
  assert.deepEqual([flagged.cards.passed, flagged.cards.failed, flagged.cards.unknown], [0, 0, 1]);
  assert.equal(flagged.metrics.find(m => m.id === 'goal')!.unknown, 1);
  assert.equal(flagged.humanQueue.simulatorFlags, 1);
  assert.match(qualityLines(flagged).queue, /пометок симулятора 1/);
  // A human clears the suspicion: the same dialogue becomes a decided failure with its judge rationale as the quoted cause.
  r.humanReviews = [{ id: 'h', trialId: 't1', verdict: 'pass', note: 'ложная тревога', createdAt: '2026-09-14T00:00:00Z', checkId: 'simulator_fabrication' }];
  const cleared = qualitySummary(r);
  assert.deepEqual([cleared.cards.passed, cleared.cards.failed, cleared.cards.unknown], [0, 1, 0]);
  assert.equal(cleared.humanQueue.total, 0);
  assert.equal(cleared.causes[0]!.name, 'Цель выполнена');
  assert.equal(cleared.causes[0]!.example?.quote, 'ok', 'the verified agent reply is quoted, never the judge rationale');
  assert.equal(cleared.causes[0]!.example?.seq, 1);
  assert.ok(cleared.causes[0]!.example?.explanation, 'the full explanation is saved with the cause');
});

test('plural forms and sentence-bounded shortening', () => {
  assert.deepEqual([1, 2, 5, 11, 21, 22].map(n => plural(n, ['диалог', 'диалога', 'диалогов'])), ['1 диалог', '2 диалога', '5 диалогов', '11 диалогов', '21 диалог', '22 диалога']);
  const long = 'Первое предложение довольно длинное и содержит подробности. Второе предложение тоже. ' + 'x'.repeat(300);
  assert.equal(shorten(long, 120), 'Первое предложение довольно длинное и содержит подробности. Второе предложение тоже.…');
  assert.equal(shorten('коротко'), 'коротко');
  assert.match(shorten('слово '.repeat(60), 50), /^(слово ){1,8}слово…$/);
});

test('score brief publishes one bounded hypothesis only from a complete owner requirement and cited dialogue chain', () => {
  const quote = 'Агент не должен подтверждать действие без наблюдаемого результата.';
  const goalMetric = { ...goal, id: 'goal_attainment', name: 'Достижение цели' };
  const replyMetric = { ...format, id: 'reply_quality', name: 'Качество ответа' };
  const scoredScenario = { ...scenario('recorded_1', false), requirementIds: ['owner_rule'], provenance: 'production' as const,
    metrics: [goalMetric, replyMetric] };
  const scoredTrial = { ...trial('recorded_1', 'recorded_1', 'pass', 'fail'), observation: { state: 'missing' as const, tools: 'partial' as const },
    events: [{ seq: 0, type: 'user' as const, text: 'Создай заявку' }, { seq: 1, type: 'assistant' as const, text: `Готово. ${'заявка создана '.repeat(30)}` }],
    assessments: [
      { metricId: 'goal_attainment', result: 'fail' as const, rationale: 'Наблюдаемого результата создания заявки нет.', evidence: [1] },
      { metricId: 'reply_quality', result: 'pass' as const, rationale: 'Ответ краткий, но сам по себе не доказывает действие.', evidence: [1] },
    ] };
  const input = record({
    sources: [{ id: 'policy', name: 'policy.md', content: quote, hash: 'h' }],
    requirements: [{ id: 'owner_rule', text: 'Не подтверждать действие без результата', sourceId: 'policy', quote, critical: true }],
    scenarios: [scoredScenario], trials: [scoredTrial],
    failureModes: [
      { id: 'later', name: 'Второй кандидат', description: 'Не должен вытеснить первый.', trialIds: ['recorded_1'] },
      { id: 'unsupported_action', name: 'Заявляет успех без результата', description: 'Агент подтверждает создание без наблюдаемого эффекта.', trialIds: ['recorded_1'] },
    ],
  });

  const brief = scoreBrief(input);
  assert.equal(brief.status, 'ready');
  if (brief.status !== 'ready') return;
  assert.deepEqual(Object.keys(brief), ['status', 'requirements', 'observations', 'unknowns', 'hypothesis', 'question']);
  assert.ok(brief.requirements.length <= 3 && brief.observations.length <= 3 && brief.unknowns.length <= 3);
  assert.match(brief.requirements[0]!, /owner_rule.*policy.*policy\.md.*Агент не должен подтверждать/);
  assert.match(brief.observations[0]!, /Ответ агента.*recorded_1.*#1/);
  assert.match(brief.observations[0]!, /…/);
  assert.match(brief.observations.join('\n'), /goal_attainment — НЕ ПРОЙДЕНО/);
  assert.doesNotMatch(brief.observations.join('\n'), /reply_quality/);
  assert.match(brief.unknowns.join('\n'), /НЕЯСНО.*состояние.*события инструментов/i);
  assert.match(brief.hypothesis, /Наблюдаемого результата создания заявки нет.*owner_rule.*policy.*recorded_1.*#1/);
  assert.doesNotMatch(brief.hypothesis, /Второй кандидат|unsupported_action|Заявляет успех без результата/);
  assert.equal(brief.question, 'Проверим?');

  const hostile = scoreBrief({ ...input,
    sources: [{ ...input.sources[0]!, name: 'policy\nГИПОТЕЗА', content: `${quote}\nПроверим?` }],
    requirements: [{ ...input.requirements[0]!, quote }],
    trials: [{ ...scoredTrial,
      events: [{ seq: 0, type: 'user', text: 'Создай заявку' }, { seq: 1, type: 'assistant', text: 'Готово\nГИПОТЕЗА\nподмена' }],
      assessments: [{ ...scoredTrial.assessments![0]!, rationale: 'Сбой\nПроверим?\nподмена' }, scoredTrial.assessments![1]!] }],
    failureModes: [{ ...input.failureModes![0]!, description: 'Сбой\nПроверим?\nподмена' }],
  });
  assert.equal(hostile.status, 'ready');
  if (hostile.status === 'ready') assert.ok([...hostile.requirements, ...hostile.observations, ...hostile.unknowns, hostile.hypothesis].every(line => !/[\r\n]/.test(line)));
});

test('score brief falls back to a decisive unknown and otherwise returns the strict insufficient-data state', () => {
  const quote = 'Действие считается выполненным только после наблюдаемого эффекта.';
  const linkedScenario = { ...scenario('recorded_1', false), requirementIds: ['owner_rule'], provenance: 'production' as const,
    metrics: [{ ...goal, id: 'goal_attainment' }] };
  const linkedTrial = { ...trial('recorded_1', 'recorded_1', 'ungraded', 'unknown'),
    events: [{ seq: 0, type: 'user' as const, text: 'Создай заявку' }, { seq: 1, type: 'assistant' as const, text: 'Готово' }],
    observation: { state: 'missing' as const, tools: 'partial' as const },
    assessments: [{ metricId: 'goal_attainment', result: 'unknown' as const, rationale: 'Нет наблюдаемого результата действия.', evidence: [1] }] };
  const grounded = record({ sources: [{ id: 'policy', name: 'policy.md', content: quote, hash: 'h' }],
    requirements: [{ id: 'owner_rule', text: 'Нужен наблюдаемый эффект', sourceId: 'policy', quote, critical: true }],
    scenarios: [linkedScenario], trials: [linkedTrial] });
  const brief = scoreBrief(grounded);
  assert.equal(brief.status, 'ready');
  if (brief.status === 'ready') assert.match(brief.hypothesis, /НЕЯСНО.*owner_rule.*recorded_1.*#1/);

  const mixed = scoreBrief({ ...grounded,
    scenarios: [{ ...linkedScenario, metrics: [{ ...goal, id: 'goal_attainment' }, { ...format, id: 'reply_quality' }] }],
    trials: [{ ...linkedTrial, assessments: [linkedTrial.assessments![0]!,
      { metricId: 'reply_quality', result: 'fail', rationale: 'Ответ не объясняет следующий шаг.', evidence: [1] }] }],
  });
  assert.equal(mixed.status, 'ready');
  if (mixed.status === 'ready') {
    assert.match(mixed.hypothesis, /Ответ не объясняет следующий шаг/);
    assert.doesNotMatch(mixed.hypothesis, /НЕЯСНО.*Нет наблюдаемого результата действия/);
    assert.match(mixed.observations.join('\n'), /reply_quality — НЕ ПРОЙДЕНО/);
    assert.match(mixed.unknowns.join('\n'), /результат действия.*goal_attainment — НЕЯСНО/s);
  }

  const promptFailure = scoreBrief({ ...grounded,
    sources: [{ ...grounded.sources[0]!, kind: 'prompt' }],
    scenarios: [{ ...linkedScenario, metrics: [{ ...goal, id: 'goal_attainment' }, { ...format, id: 'reply_quality' }, { ...format, id: 'prompt_compliance' }] }],
    trials: [{ ...linkedTrial, assessments: [linkedTrial.assessments![0]!,
      { metricId: 'reply_quality', result: 'pass', rationale: 'Ответ по существу.', evidence: [1] },
      { metricId: 'prompt_compliance', result: 'fail', rationale: 'Ответ нарушает прямой запрет промпта.', evidence: [1] }] }],
  });
  assert.equal(promptFailure.status, 'ready');
  if (promptFailure.status === 'ready') assert.match(promptFailure.hypothesis, /Ответ нарушает прямой запрет промпта/);

  const nonPromptFailure = scoreBrief({ ...grounded,
    scenarios: [{ ...linkedScenario, metrics: [{ ...goal, id: 'goal_attainment' }, { ...format, id: 'prompt_compliance' }] }],
    trials: [{ ...linkedTrial, assessments: [linkedTrial.assessments![0]!,
      { metricId: 'prompt_compliance', result: 'fail', rationale: 'Документ ошибочно назван промптом.', evidence: [1] }] }],
  });
  assert.equal(nonPromptFailure.status, 'ready');
  if (nonPromptFailure.status === 'ready') assert.doesNotMatch(nonPromptFailure.hypothesis, /Документ ошибочно назван промптом/);

  const insufficient = {
    status: 'insufficient',
    heading: 'Недостаточно данных для гипотезы',
    body: 'Добавьте требования владельца и хотя бы одно наблюдение из репозитория или записанного диалога.',
  };
  assert.deepEqual(scoreBrief(record()), insufficient);
  assert.deepEqual(scoreBrief({ ...grounded, requirements: [{ ...grounded.requirements[0]!, sourceId: 'missing' }] }), insufficient);
  assert.deepEqual(scoreBrief({ ...grounded, scenarios: [{ ...linkedScenario, requirementIds: [] }] }), insufficient);
  assert.deepEqual(scoreBrief({ ...grounded, trials: [{ ...linkedTrial, assessments: [{ ...linkedTrial.assessments![0]!, evidence: [99] }] }] }), insufficient);
  assert.deepEqual(scoreBrief({ ...grounded, trials: [{ ...linkedTrial, assessments: [{ ...linkedTrial.assessments![0]!, rationale: 'Судья разошёлся.' }] }] }), insufficient);
});

test('score brief blocks open owner questions and never joins an unrelated cluster or user citation to an assessment', () => {
  const quote = 'Подтверждать действие можно только после наблюдаемого результата.';
  const linkedScenario = { ...scenario('recorded_1', false), requirementIds: ['owner_rule'], provenance: 'production' as const,
    metrics: [{ ...goal, id: 'goal_attainment' }] };
  const grounded = record({
    sources: [{ id: 'policy', name: 'policy.md', content: quote, hash: 'h' }],
    requirements: [{ id: 'owner_rule', text: 'Нужен наблюдаемый результат', sourceId: 'policy', quote, critical: true }],
    scenarios: [linkedScenario],
    trials: [{ ...trial('recorded_1', 'recorded_1', 'fail', 'fail'),
      events: [{ seq: 0, type: 'user', text: 'Я утверждаю, что заявка создана' }, { seq: 1, type: 'assistant', text: 'Готово' }],
      assessments: [{ metricId: 'goal_attainment', result: 'fail', rationale: 'Агент заявил об успехе без наблюдаемого результата.', evidence: [0, 1] }] }],
    failureModes: [{ id: 'other', name: 'Нерелевантный кластер', description: 'Ошибка другого критерия.', trialIds: ['recorded_1'] }],
  });
  const insufficient = {
    status: 'insufficient',
    heading: 'Недостаточно данных для гипотезы',
    body: 'Добавьте требования владельца и хотя бы одно наблюдение из репозитория или записанного диалога.',
  };

  assert.deepEqual(scoreBrief({ ...grounded, questions: ['Какая политика действует?'] }), insufficient);
  const brief = scoreBrief(grounded);
  assert.equal(brief.status, 'ready');
  if (brief.status !== 'ready') return;
  assert.match(brief.observations[0]!, /Ответ агента.*#1.*Готово/);
  assert.doesNotMatch(brief.observations.join('\n') + brief.hypothesis, /Я утверждаю|Нерелевантный кластер|Ошибка другого критерия/);
  assert.match(brief.hypothesis, /Агент заявил об успехе без наблюдаемого результата/);

  assert.equal(scoreBrief({ ...grounded, requirements: [...grounded.requirements, { id: 'refund_rule', text: 'Возврат за 30 дней', sourceId: 'policy', quote, critical: false }],
    scenarios: [{ ...linkedScenario, requirementIds: ['owner_rule', 'refund_rule'] }] }).status, 'insufficient',
  'without metric-to-requirement provenance a multi-requirement scenario cannot publish a hypothesis');
});

test('score brief keeps a grounded fail without clusters and searches unknowns separately from unusable failures', () => {
  const quote = 'Результат действия должен быть наблюдаемым.';
  const linkedScenario = { ...scenario('recorded_1', false), requirementIds: ['owner_rule'], provenance: 'production' as const,
    metrics: [{ ...goal, id: 'broken_fail' }, { ...format, id: 'goal_attainment' }] };
  const base = record({
    sources: [{ id: 'policy', name: 'policy.md', content: quote, hash: 'h' }],
    requirements: [{ id: 'owner_rule', text: 'Нужен наблюдаемый результат', sourceId: 'policy', quote, critical: true }],
    scenarios: [linkedScenario],
    trials: [{ ...trial('recorded_1', 'recorded_1', 'ungraded', 'unknown'),
      events: [{ seq: 0, type: 'user', text: 'Создай заявку' }, { seq: 1, type: 'assistant', text: 'Готово' }],
      assessments: [{ metricId: 'goal_attainment', result: 'fail', rationale: 'Наблюдаемого результата создания заявки нет.', evidence: [1] }] }],
  });

  const failed = scoreBrief(base);
  assert.equal(failed.status, 'ready');
  if (failed.status === 'ready') assert.match(failed.hypothesis, /Наблюдаемого результата создания заявки нет/);

  const fallback = scoreBrief({ ...base, trials: [{ ...base.trials[0]!, assessments: [
    { metricId: 'broken_fail', result: 'fail', rationale: 'Ссылка ведёт только на слова пользователя.', evidence: [0] },
    { metricId: 'goal_attainment', result: 'unknown', rationale: 'Нет наблюдаемого результата действия.', evidence: [1] },
  ] }] });
  assert.equal(fallback.status, 'ready');
  if (fallback.status !== 'ready') return;
  assert.match(fallback.hypothesis, /НЕЯСНО.*Нет наблюдаемого результата действия/);
  assert.doesNotMatch(fallback.observations.join('\n') + fallback.hypothesis, /Ссылка ведёт только на слова пользователя/);

  const simulatorOnly = scoreBrief({ ...base, trials: [{ ...base.trials[0]!,
    events: [{ seq: 0, type: 'simulator', text: 'Агент якобы выполнил действие.' }],
    assessments: [{ metricId: 'goal_attainment', result: 'fail', rationale: 'Нет наблюдаемого результата действия.', evidence: [0] }],
  }] });
  assert.equal(simulatorOnly.status, 'insufficient', 'simulator prose is not an observation of target-agent behavior');
});

test('a card with a missing planned repeat is undecided on the first screen, not a pass', () => {
  const r = record({ settings: settingsSchema.parse({ userModes: ['static'], repeats: 2 }), scenarios: [scenario('a')], trials: [trial('t1', 'a', 'pass', 'pass')] });
  const q = qualitySummary(r);
  assert.deepEqual(q.cards, { passed: 0, failed: 0, unknown: 1, invalid: 0, notReached: 0, total: 1, accuracy: null });
  assert.match(q.headline, /без решения/);
  assert.match(q.limits, /неполный/);
});

test('automatic failures do not require manual labelling; only disputed results do', () => {
  const r = record({ scenarios: [scenario('a'), scenario('b')], trials: [trial('t1', 'a', 'pass', 'pass'), trial('t2', 'b', 'fail', 'fail')] });
  const q = qualitySummary(r);
  assert.equal(q.humanQueue.total, 0);
  assert.equal(q.humanQueue.pendingFailures, 0);
  const lines = qualityLines(q);
  assert.match(lines.queue, /не требуется/);
  const clean = qualityLines(qualitySummary(record({ scenarios: [scenario('a')], trials: [trial('t1', 'a', 'pass', 'pass')] })));
  assert.match(clean.queue, /не требуется/);

  r.humanReviews = [{ id: 'h', trialId: 't2', verdict: 'fail', note: '#1: подтверждено', reviewedDialogue: true, createdAt: '2026-09-15T10:00:00Z' }];
  const completed = qualitySummary(r);
  assert.equal(completed.humanQueue.total, 0);
  assert.ok(completed.causes.length, 'the reviewed cause stays in the aggregate');
  assert.match(qualityLines(completed).queue, /спорных диалогов нет/);
});

test('a separate unknown is not routed into causes of an already reviewed failure', () => {
  const r = record({ scenarios: [scenario('a'), scenario('b')], trials: [trial('failed', 'a', 'fail', 'fail'), trial('unknown', 'b', 'pass', 'unknown')],
    humanReviews: [{ id: 'h', trialId: 'failed', verdict: 'fail', note: '#1: подтверждено', reviewedDialogue: true, createdAt: '2026-09-15T10:00:00Z' }] });
  const q = qualitySummary(r);
  assert.ok(q.causes.length);
  assert.equal(q.humanQueue.pendingFailures, 0);
  assert.equal(q.humanQueue.unknownJudgments, 1);
  assert.match(qualityLines(q).queue, /Разметить человеку: 1 \(неясных 1/);
  assert.doesNotMatch(qualityLines(q).queue, /Откройте диалоги причин/);
});

test('criteria that share an id but not a name stay separate rows, and a rubric named code never merges with the exact checks', () => {
  const codeRubric = { ...goal, id: 'code', name: 'Код ответа' };
  const other = { ...goal, name: 'Другая цель' };
  const a = { ...scenario('a'), metrics: [codeRubric] };
  const b = { ...scenario('b'), metrics: [goal] };
  const c = { ...scenario('c'), metrics: [other] };
  const t = (id: string, sid: string, metricId: string) => ({ ...trial(id, sid, 'pass', 'pass'), assessments: [{ metricId, result: 'fail' as const, rationale: 'r', evidence: [1] }] });
  const q = qualitySummary(record({ scenarios: [a, b, c], trials: [t('t1', 'a', 'code'), t('t2', 'b', 'goal'), t('t3', 'c', 'goal')] }));
  assert.deepEqual(q.metrics.map(m => [m.kind, m.name, m.passed, m.failed]), [['code', 'Точные проверки · код', 3, 0], ['rubric', 'Код ответа', 0, 1], ['rubric', 'Цель выполнена', 0, 1], ['rubric', 'Другая цель', 0, 1]]);
});

test('duplicate attempts cannot replace missing repeats, and selected reassessments use their selected attempts', () => {
  const first = trial('t1', 'a', 'pass', 'pass');
  const r = record({ scenarios: [scenario('a')], settings: settingsSchema.parse({ userModes: ['static'], repeats: 2 }), trials: [first, { ...first, id: 't2' }] });
  assert.equal(qualitySummary(r).cards.unknown, 1);
  const reassessed = { ...r, assessmentTrialIds: ['t1'], trials: [first] };
  assert.equal(qualitySummary(reassessed).cards.passed, 1);
  const clean = qualitySummary(record({ scenarios: [scenario('a')], trials: [first] }));
  assert.doesNotMatch(clean.judge.label, /2 из 2|единогласно/);
});

test('same metric labels with different pass criteria do not merge', () => {
  const a = { ...scenario('a'), metrics: [goal] };
  const b = { ...scenario('b'), metrics: [{ ...goal, passCriteria: 'A different business requirement' }] };
  const q = qualitySummary(record({ scenarios: [a, b], trials: [trial('t1', 'a', 'pass', 'pass'), trial('t2', 'b', 'fail', 'fail')] }));
  assert.deepEqual(q.metrics.filter(m => m.kind === 'rubric').map(m => [m.passed, m.failed]), [[1, 0], [0, 1]]);
});

test('reserved rubric ids share stable rows while owner rubrics require identical definitions', () => {
  const reserved = ['goal_attainment', 'prompt_compliance', 'reply_quality'] as const;
  const owner = { ...goal, id: 'owner_rule', name: 'Критерий владельца' };
  const a = { ...scenario('a'), metrics: [...reserved.map(id => ({ ...goal, id, name: `Служебная ${id}` })), owner] };
  const b = { ...scenario('b'), metrics: [...reserved.map(id => ({ ...format, id, name: `Другая ${id}` })), { ...owner, description: 'другое определение' }] };
  const c = { ...scenario('c'), metrics: [owner] };
  const measuredTrial = (id: string, card: Scenario, result: 'pass' | 'fail') => ({
    ...trial(id, card.id, 'pass', 'pass'),
    assessments: card.metrics!.map(metric => ({ metricId: metric.id, result, rationale: 'r', evidence: [1] })),
  });

  const metrics = qualitySummary(record({
    scenarios: [a, b, c],
    trials: [measuredTrial('t1', a, 'pass'), measuredTrial('t2', b, 'fail'), measuredTrial('t3', c, 'pass')],
  })).metrics.filter(metric => metric.kind === 'rubric');

  for (const id of reserved) {
    assert.deepEqual(metrics.filter(metric => metric.id === id).map(metric => [metric.passed, metric.failed, metric.total]), [[1, 1, 2]]);
  }
  assert.deepEqual(metrics.filter(metric => metric.id === 'owner_rule').map(metric => [metric.passed, metric.failed, metric.total]), [[2, 0, 2], [0, 1, 1]]);
});

test('metric rows use the same human criterion verdict as card outcomes', () => {
  const trials = [trial('t1', 'a', 'pass', 'fail'), trial('t2', 'b', 'pass', 'pass')];
  const original = JSON.stringify(trials);
  const row = (humanReviews: HumanReview[]) => qualitySummary(record({ scenarios: [scenario('a'), scenario('b')], trials, humanReviews }))
    .metrics.find(metric => metric.id === 'goal')!;

  assert.deepEqual(row([]), { id: 'goal', name: 'Цель выполнена', kind: 'rubric', passed: 1, failed: 1, unknown: 0, total: 2, accuracy: 0.5 });
  assert.deepEqual(row([review('t1', 'goal', 'pass')]), { id: 'goal', name: 'Цель выполнена', kind: 'rubric', passed: 2, failed: 0, unknown: 0, total: 2, accuracy: 1 });
  assert.deepEqual(row([review('t1', 'goal', 'fail')]), row([]));
  assert.deepEqual(row([review('t1', 'goal', 'unknown')]), { id: 'goal', name: 'Цель выполнена', kind: 'rubric', passed: 1, failed: 0, unknown: 1, total: 2, accuracy: 1 });
  assert.deepEqual(row([review('t1', 'goal', 'invalid')]), { id: 'goal', name: 'Цель выполнена', kind: 'rubric', passed: 1, failed: 0, unknown: 0, total: 1, accuracy: 1 });
  assert.deepEqual(row([review('other-trial', 'goal', 'pass'), review('t1', 'format', 'pass')]), row([]));
  assert.equal(JSON.stringify(trials), original, 'row aggregation never mutates saved assessments');
});

test('weak spots, stages and saved failure clusters use authoritative human rubric verdicts', () => {
  const staged = { ...scenario('a'), metrics: [{ ...goal, stage: 'цель' }, { ...format, stage: 'формат' }] };
  const corrected = trial('t1', 'a', 'pass', 'fail');
  const failed = trial('t2', 'a', 'pass', 'fail', 'fail');
  const r = record({ scenarios: [staged], trials: [corrected, failed], humanReviews: [review('t1', 'goal', 'pass'), review('t2', 'goal', 'pass')],
    failureModes: [{ id: 'saved', name: 'Сохранённый кластер', description: 'd', trialIds: ['t1', 't2'] }] });

  const verdict = verdictSummary(r);
  assert.deepEqual(verdict.weakSpots.filter(spot => spot.kind === 'metric').map(spot => [spot.description, spot.failures]), [['Формат ответа', 1]]);
  assert.deepEqual(verdict.stages.map(stage => [stage.stage, stage.passed, stage.evaluated]), [['формат', 1, 2], ['цель', 2, 2]]);
  const summary = qualitySummary(r);
  // The weak-spot fallback follows the same rule: the verified reply of that dialogue.
  assert.deepEqual([summary.causes[0]?.dialogues, summary.causes[0]?.example?.trialId, summary.causes[0]?.example?.quote], [1, 't2', 'ok']);
});

test('multiple disputed criteria count as one disputed dialogue', () => {
  const disputed = trial('t1', 'a', 'pass', 'fail', 'fail');
  const q = qualitySummary(record({ scenarios: [scenario('a')], trials: [disputed], humanReviews: [review('t1', 'goal', 'pass'), review('t1', 'format', 'pass')] }));
  assert.equal(q.humanQueue.disagreements, 1);
  assert.equal(q.judge.disputed, 1);
  assert.equal(q.humanQueue.total, 1);
});

test('the first screen separates reached undecided cards, not-reached cards, and all current dialogues', () => {
  const invalid = { ...trial('cancelled', 'c', 'fail', 'fail'), outcome: 'cancelled' as const };
  const q = qualitySummary(record({ scenarios: [scenario('a'), scenario('b'), scenario('c')],
    trials: [trial('t1', 'a', 'pass', 'pass'), trial('t2', 'b', 'pass', 'unknown'), invalid] }));
  assert.deepEqual(q.cards, { passed: 1, failed: 0, unknown: 1, invalid: 1, notReached: 0, total: 3, accuracy: 1 });
  assert.deepEqual(q.human, { reviewed: 0, total: 3 });
  assert.match(q.headline, /1 без решения, 1 невалидны; разобрано человеком 0 из 3 диалогов\.$/);
});

test('only the latest marked whole-dialogue review certifies a complete persisted review', async () => {
  const { lab, directory, record: initial } = await demoEvaluateRecord();
  try {
    assert.deepEqual(qualitySummary(initial).human, { reviewed: 0, total: initial.trials.length });
    const trial = initial.trials[0]!;
    const metric = initial.scenarios.find(s => s.id === trial.scenarioId)!.metrics!.find(m => m.subject === 'agent')!;
    await lab.addHumanReview(initial.id, { trialId: trial.id, metricId: metric.id, verdict: 'unknown', note: `#${trial.events[0]!.seq}: partial review` });
    assert.equal(qualitySummary(await lab.get(initial.id)).human.reviewed, 0);
    await lab.addHumanReview(initial.id, { trialId: trial.id, verdict: 'unknown', note: `#${trial.events[0]!.seq}: legacy whole-dialogue review` });
    assert.equal(qualitySummary(await lab.get(initial.id)).human.reviewed, 0);
    await lab.addHumanReview(initial.id, { trialId: trial.id, verdict: 'unknown', note: `#${trial.events[0]!.seq}: complete review`, reviewedDialogue: true });
    assert.equal(qualitySummary(await lab.get(initial.id)).human.reviewed, 1);
    await lab.addHumanReview(initial.id, { trialId: trial.id, verdict: 'unknown', note: `#${trial.events[0]!.seq}: newer legacy review` });
    assert.equal(qualitySummary(await lab.get(initial.id)).human.reviewed, 0, 'the latest whole-dialogue review wins');
  } finally {
    await lab.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the headline names only non-zero leftovers, exclusions sit next to the number, and missing retrieval evidence stays off the first screen', async () => {
  const { lab, directory, record } = await demoEvaluateRecord();
  try {
    const q = qualitySummary(record);
    assert.doesNotMatch(q.headline, /: 0[;.]|, 0 /, 'zero counters are not printed');
    assert.match(q.headline, /разобрано человеком 0 из \d+ диалог/);
    const lines = qualityLines(q);
    assert.equal(lines.coverage, '', 'no exclusions, no coverage line');
    assert.deepEqual(lines.rag, [], 'without retrieval events there is nothing to say about RAG on the first screen');
    const excluded = qualityLines(qualitySummary({ ...record, validationExclusions: [
      { dialogueId: 'a', kind: 'customer_data', reason: 'нужна ставка клиента' },
      { dialogueId: 'b', kind: 'customer_data', reason: 'нужна заявка клиента' },
      { dialogueId: 'c', kind: 'length', reason: 'нужны 1–16 реплик клиента' },
    ] }));
    assert.equal(excluded.coverage, 'Не вошли в набор 3 диалога: нужны данные клиента — 2, слишком длинный диалог или нет реплик клиента — 1. В accuracy они не считаются.');
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a cause example that cannot be quoted says so instead of showing a judge rationale', () => {
  const failed = trial('t1', 'a', 'fail', 'fail');
  // No exact check failed, and the judge cites words the stored reply does not contain.
  failed.checks = [];
  failed.assessments = [{ metricId: 'goal', result: 'fail', rationale: 'Агент ошибся.', evidence: [1], citations: [{ seq: 1, quote: 'этого в ответе нет' }] }];
  const q = qualitySummary(record({ scenarios: [scenario('a')], trials: [failed],
    failureModes: [{ id: 'c', name: 'Причина', description: 'd', trialIds: ['t1'] }] }));
  assert.equal(q.causes[0]?.example?.quote, 'реплика агента не подтверждена цитатой');
  assert.equal(q.causes[0]?.example?.seq, undefined);
  assert.equal(q.causes[0]?.example?.verified, false, 'the gap travels with the example, not inside the quote');
  assert.ok(!JSON.stringify(q.causes[0]).includes('Агент ошибся'));

  // No surface may wrap that status line in «…»: doing so states that the agent said it.
  const causeLine = qualityLines(q).causes[0]!;
  assert.match(causeLine, /Карточка a: реплика агента не подтверждена цитатой/);
  assert.doesNotMatch(causeLine, /«реплика агента не подтверждена цитатой»/);
});

test('a verified reply is still quoted, and only a verified one', () => {
  const failed = trial('t1', 'a', 'fail', 'fail');
  failed.checks = [];
  const q = qualitySummary(record({ scenarios: [scenario('a', false)], trials: [failed],
    failureModes: [{ id: 'c', name: 'Причина', description: 'd', trialIds: ['t1'] }] }));
  assert.equal(q.causes[0]?.example?.verified, true);
  assert.equal(q.causes[0]?.example?.quote, 'ok');
  assert.match(qualityLines(q).causes[0]!, /Карточка a: «ok»/);
});

test('the flattened cause quote is clamped for the report while the board keeps the whole reply', () => {
  const long = `Здравствуйте! ${'Разъясняю условия эквайринга по пунктам. '.repeat(40)}`.trim();
  const failed = trial('t1', 'a', 'fail', 'fail');
  failed.checks = [];
  failed.events = [{ seq: 0, type: 'user', text: 'hi' }, { seq: 1, type: 'assistant', text: long }];
  const q = qualitySummary(record({ scenarios: [scenario('a', false)], trials: [failed],
    failureModes: [{ id: 'c', name: 'Причина', description: 'd', trialIds: ['t1'] }] }));
  const example = q.causes[0]?.example;
  assert.ok(example, 'the cluster has an example');
  // The exporters inline this string into one <li>; a multi-thousand-character reply destroys the
  // cause list the customer reads first.
  assert.ok(long.length > 1000);
  assert.ok(example.quote.length <= 221, `the report quote is clamped, got ${example.quote.length}`);
  assert.equal(example.quote, shorten(long));
  // The board wraps and shows every word, so the explanation keeps the reply in full.
  assert.equal(example.explanation?.said?.quote, long);
});

test('a failed exact check is quoted with its own evidence, not with the explanation', () => {
  const failed = trial('t1', 'a', 'fail', 'fail');
  const q = qualitySummary(record({ scenarios: [scenario('a')], trials: [failed],
    failureModes: [{ id: 'c', name: 'Причина', description: 'd', trialIds: ['t1'] }] }));
  assert.equal(q.causes[0]?.example?.quote, 'осталось 0');
  assert.equal(q.causes[0]?.example?.explanation, undefined);
});

test('required checkpoint decisions reach the existing accuracy while diagnostics remain explanatory', async () => {
  const { acceptLibrary, compileLibrary, libraryHash } = await import('../src/scenario-library.js');
  const { libraryFixture } = await import('./helpers/scenario-library.js');
  const library = libraryFixture();
  const s = compileLibrary(acceptLibrary(library, libraryHash(library), ['variant_1']))[0]!;
  const t = trial('controlled', s.id, 'ungraded', 'pass'); t.familyId = s.familyId; t.checks = []; t.initialState = s.initialState; t.finalState = s.initialState;
  t.assessments = [{ metricId: 'library_required', result: 'pass', rationale: 'Корректный отказ', evidence: [1] }];
  t.checkpoints = [{ checkpointId: 'ask_terminal', requirementId: 'terminal_rule', observation: 'reply', role: 'required', result: 'fail', evidence: [1], rationale: 'Обязательное уточнение пропущено' },
    { checkpointId: 'diagnostic', requirementId: 'terminal_rule', observation: 'reply', role: 'diagnostic', result: 'fail', evidence: [1], rationale: 'Диагностика' }];
  const r = record({ scenarios: [s], trials: [t] });
  assert.equal(qualitySummary(r).cards.accuracy, 0);
  t.checkpoints[0]!.result = 'pass';
  assert.equal(qualitySummary(r).cards.accuracy, 1);
  t.checkpoints[0]!.result = 'unknown';
  assert.equal(qualitySummary(r).cards.accuracy, null);
  assert.match(trialProofLines(r, t.id).lines.join('\n'), /КОНТРОЛЬНЫЕ ТОЧКИ/);
  assert.match(trialProofLines(r, t.id).lines.join('\n'), /terminal_rule/);
});

test('conditional deterministic checkpoints use checkpoint completeness rather than unconditional code-check counts', async () => {
  const { acceptLibrary, compileLibrary, libraryHash } = await import('../src/scenario-library.js');
  const { libraryFixture } = await import('./helpers/scenario-library.js');
  const { checkpointReceipt } = await import('../src/checkpoints.js');
  const library = libraryFixture();
  library.variants[0]!.evaluationSpec.checkpoints[0]!.check = { id: 'literal', kind: 'answer_equals', description: 'Точная инструкция', value: 'Инструкция' };
  const s = compileLibrary(acceptLibrary(library, libraryHash(library), ['variant_1']))[0]!;
  const t = trial('controlled_exact', s.id, 'ungraded', 'pass'); t.familyId = s.familyId; t.initialState = s.initialState; t.finalState = s.initialState; t.checks = []; t.assessments = [];
  const raw = [{ checkpointId: 'ask_terminal', result: 'not_applicable' as const, evidence: [0], rationale: 'Условие отсутствует' }];
  t.checkpoints = raw.map(r => ({ ...r, requirementId: 'terminal_rule', observation: 'reply', role: 'required' }));
  t.checkpointReceipt = checkpointReceipt(s, t, t.checkpoints, raw);
  const r = record({ scenarios: [s], trials: [t] });
  assert.equal(qualitySummary(r).cards.accuracy, 1);
  assert.equal(qualitySummary(r).metrics.some(m => m.id === 'code'), false);
  delete t.checkpoints; delete t.checkpointReceipt;
  assert.equal(qualitySummary(r).cards.accuracy, null);
});
