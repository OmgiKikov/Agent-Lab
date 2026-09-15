import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qualityLines, qualitySummary, plural, shorten } from '../src/quality.js';
import { emptyUsage, settingsSchema, type Experiment, type Scenario, type Trial } from '../src/contracts.js';

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

test('the first screen counts cards, criteria and causes from the shared outcome rules and names what a person still has to look at', () => {
  const r = record({ trials: [trial('t1', 'a', 'pass', 'pass'), trial('t2', 'b', 'fail', 'fail', 'fail'), trial('t3', 'c', 'pass', 'unknown')],
    failureModes: [{ id: 'm1', name: 'Переспрашивает терминал вместо пути', description: 'Агент задаёт уточнение там, где нужен путь.', stage: 'сборка ответа', trialIds: ['t2'], promptQuotes: ['Отвечай сразу, если данных достаточно'] }] });
  const q = qualitySummary(r);
  assert.deepEqual(q.cards, { passed: 1, failed: 1, unknown: 1, total: 3, accuracy: 0.5 });
  assert.equal(q.headline, 'Справился с 1 из 2 карточек (50%), 1 без решения.');
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
  assert.match(text.queue, /Разметить человеку: 2 \(неясных 1/);
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

test('a card with a missing planned repeat is undecided on the first screen, not a pass', () => {
  const r = record({ settings: settingsSchema.parse({ userModes: ['static'], repeats: 2 }), scenarios: [scenario('a')], trials: [trial('t1', 'a', 'pass', 'pass')] });
  const q = qualitySummary(r);
  assert.deepEqual(q.cards, { passed: 0, failed: 0, unknown: 1, total: 1, accuracy: null });
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
  assert.match(lines.queue, /1 провал/);
  const clean = qualityLines(qualitySummary(record({ scenarios: [scenario('a')], trials: [trial('t1', 'a', 'pass', 'pass')] })));
  assert.match(clean.queue, /не требуется/);
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
