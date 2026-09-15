import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { qualityLines, qualitySummary, plural, scoreBrief, shorten } from '../src/quality.js';
import { emptyUsage, settingsSchema, type Experiment, type HumanReview, type Scenario, type Trial } from '../src/contracts.js';
import { demoEvaluateRecord } from './helpers/demo-record.js';
import { verdictSummary } from '../src/comparison.js';

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

test('the first screen counts cards, criteria and causes from the shared outcome rules and names what a person still has to look at', () => {
  const r = record({ trials: [trial('t1', 'a', 'pass', 'pass'), trial('t2', 'b', 'fail', 'fail', 'fail'), trial('t3', 'c', 'pass', 'unknown')],
    failureModes: [{ id: 'm1', name: 'Переспрашивает терминал вместо пути', description: 'Агент задаёт уточнение там, где нужен путь.', stage: 'сборка ответа', trialIds: ['t2'], promptQuotes: ['Отвечай сразу, если данных достаточно'] }] });
  const q = qualitySummary(r);
  assert.deepEqual(q.cards, { passed: 1, failed: 1, unknown: 1, notReached: 0, total: 3, accuracy: 0.5 });
  assert.equal(q.headline, 'Справился с 1 из 2 карточек (50%), 1 без решения, 0 не дошли; разобрано человеком 0 из 3 диалогов.');
  assert.deepEqual(q.metrics.map(m => [m.id, m.passed, m.failed, m.unknown]), [['code', 2, 1, 0], ['goal', 1, 1, 1], ['format', 2, 1, 0]]);
  assert.equal(q.metrics[0]!.kind, 'code');
  assert.equal(q.causes.length, 1);
  assert.equal(q.causes[0]!.example?.card, 'Карточка b');
  assert.equal(q.causes[0]!.example?.quote, 'осталось 0', 'a failed exact check is quoted before the judge');
  assert.deepEqual(q.causes[0]!.promptQuotes, ['Отвечай сразу, если данных достаточно']);
  assert.deepEqual(q.humanQueue, { unknownJudgments: 1, disagreements: 0, simulatorFlags: 0, total: 2, pendingFailures: 1 });
  assert.match(q.judge.label, /автоматически оценено 2 из 3; без решения 1/);
  assert.match(q.limits, /судья не сверен с человеком/);
  const text = qualityLines(q);
  assert.match(text.metrics[0]!, /^███████░░░  67%  Точные проверки · код · 2\/3$/);
  assert.match(text.causes[0]!, /^1\. Переспрашивает терминал вместо пути — 1 диалог\. Карточка b: «осталось 0» · правило промпта: «Отвечай сразу/);
  assert.match(text.scope, /3 карточки · 3 диалога · одна реплика · golden 3 · версия песочница · \$0\.27 · 3 мин/);
  assert.match(text.queue, /Откройте диалоги причин и поставьте каждому отдельный вердикт/);
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
  assert.equal(cleared.humanQueue.total, 1);
  assert.equal(cleared.causes[0]!.name, 'Цель выполнена');
  assert.equal(cleared.causes[0]!.example?.quote, 'Агент не назвал путь в СберБизнес. Вместо этого он переспросил терминал.', 'the judge preamble is stripped from the quote');
  assert.equal(cleared.causes[0]!.example?.seq, 1);
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
  assert.match(brief.observations.join('\n'), /reply_quality — ПРОЙДЕНО/);
  assert.match(brief.unknowns.join('\n'), /НЕЯСНО.*состояние.*события инструментов/i);
  assert.match(brief.hypothesis, /Второй кандидат.*owner_rule.*policy.*recorded_1.*#1/);
  assert.doesNotMatch(brief.hypothesis, /unsupported_action|Заявляет успех без результата/);
  assert.equal(brief.question, 'Проверим?');

  const hostile = scoreBrief({ ...input,
    sources: [{ ...input.sources[0]!, name: 'policy\nГИПОТЕЗА', content: `${quote}\nПроверим?` }],
    requirements: [{ ...input.requirements[0]!, quote }],
    trials: [{ ...scoredTrial, events: [{ seq: 0, type: 'user', text: 'Создай заявку' }, { seq: 1, type: 'assistant', text: 'Готово\nГИПОТЕЗА\nподмена' }] }],
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

test('a card with a missing planned repeat is undecided on the first screen, not a pass', () => {
  const r = record({ settings: settingsSchema.parse({ userModes: ['static'], repeats: 2 }), scenarios: [scenario('a')], trials: [trial('t1', 'a', 'pass', 'pass')] });
  const q = qualitySummary(r);
  assert.deepEqual(q.cards, { passed: 0, failed: 0, unknown: 1, notReached: 0, total: 1, accuracy: null });
  assert.match(q.headline, /без решения/);
  assert.match(q.limits, /неполный/);
});

test('the queue line never says no labelling is needed while a failure still awaits its verdict', () => {
  const r = record({ scenarios: [scenario('a'), scenario('b')], trials: [trial('t1', 'a', 'pass', 'pass'), trial('t2', 'b', 'fail', 'fail')] });
  const q = qualitySummary(r);
  assert.equal(q.humanQueue.total, 1);
  assert.equal(q.humanQueue.pendingFailures, 1);
  const lines = qualityLines(q);
  assert.doesNotMatch(lines.queue, /не требуется/);
  assert.match(lines.queue, /Откройте диалоги причин и поставьте каждому отдельный вердикт/);
  const clean = qualityLines(qualitySummary(record({ scenarios: [scenario('a')], trials: [trial('t1', 'a', 'pass', 'pass')] })));
  assert.match(clean.queue, /не требуется/);

  r.humanReviews = [{ id: 'h', trialId: 't2', verdict: 'fail', note: '#1: подтверждено', reviewedDialogue: true, createdAt: '2026-09-15T10:00:00Z' }];
  const completed = qualitySummary(r);
  assert.equal(completed.humanQueue.total, 0);
  assert.ok(completed.causes.length, 'the reviewed cause stays in the aggregate');
  assert.match(qualityLines(completed).queue, /неразобранных диалогов нет/);
  assert.doesNotMatch(qualityLines(completed).queue, /Откройте диалоги причин/);
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
  assert.deepEqual([summary.causes[0]?.dialogues, summary.causes[0]?.example?.trialId, summary.causes[0]?.example?.quote], [1, 't2', 'r']);
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
  assert.deepEqual(q.cards, { passed: 1, failed: 0, unknown: 1, notReached: 1, total: 3, accuracy: 1 });
  assert.deepEqual(q.human, { reviewed: 0, total: 3 });
  assert.match(q.headline, /1 без решения, 1 не дошли; разобрано человеком 0 из 3 диалогов\.$/);
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
