import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { emptyUsage, settingsSchema, type Experiment, type HumanReview, type Requirement, type Source, type Trial } from '../src/contracts.js';
import { goalAttainment, promptCompliance, replyQuality, simulatorFidelity, type MetricAssessment } from '../src/assessment.js';
import { SPLIT_RATIONALE_PREFIX } from '../src/judge.js';
import { buildResultView, COUNTING_RULES, exitCodeOf, NOT_MEASURED_TEXT, type ResultView } from '../src/result-view.js';
import {
  accuracyParts, accuracyRow, alarmRow, causeRows, chatBlock, countingLines, disagreementRows, dunnoText, errorListRows, failureRows, fitRows, GOOD_FROM, headRows,
  MAX_WIDTH, MIXED_FROM, NOT_MEASURED_WARN_ABOVE, nextRows, noErrorsText, plainText, realityParts, reasonLabel, resultScreen, runLine, saidText, topicRows, trustParts, trustSegments, whenText,
  type ResultRow,
} from '../src/result-text.js';
import { COUNTING_RULE_TEXT } from '../src/card/expectations.js';
import { assertPlainCopy } from './helpers/copy-check.js';

/*
 * The words of a result (src/result-text.ts), pinned on views that `buildResultView` builds from
 * synthetic records, so the text is tested on the same data every surface reads. Titles and
 * replies are Russian because the copy scan treats record text as our copy.
 */

const world = { records: {}, writableFields: [], transientFailures: 0 };
type Card = Experiment['scenarios'][number];
type Result = MetricAssessment['result'];
const SPLIT = `${SPLIT_RATIONALE_PREFIX} pass / fail. Основания каждой оценки сохранены в judgeAudit.`;
const RUN_ID = '0123abcd-0000-4000-8000-000000000000';
/** Local times, so «сегодня в 14:05» holds in every time zone. */
const CREATED = new Date(2026, 8, 23, 14, 5).toISOString();
const NOW = new Date(2026, 8, 23, 18, 0);
const RULE = 'Если номер терминала уже указан, не запрашивайте его повторно.';
const SOURCE: Source = { id: 'rules', name: 'Правила поддержки', content: RULE, hash: 'h', kind: 'knowledge' };
const REQUIREMENT: Requirement = { id: 'r1', text: 'Не переспрашивать номер терминала', sourceId: 'rules', quote: RULE, critical: true };

function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id, familyId: id, title: `Ситуация ${id}`, requirementIds: [], provenance: 'production', tier: 'regression', goalObservation: 'reply',
    user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 3 }, initialState: world, checks: [],
    metrics: [{ ...goalAttainment }, { ...replyQuality }, { ...simulatorFidelity }], split: 'dev', ...overrides,
  };
}
const vote = (metricId: string, result: Result, rationale = 'Обоснование.'): MetricAssessment =>
  ({ metricId, result, rationale, evidence: result === 'unknown' ? [] : [1] });
/** opening → reply → the simulator ends the dialogue; `repeat` above 0 gets its own trial id. */
function attempt(scenarioId: string, options: { goal?: Result; goalRationale?: string; fidelity?: Result; opening?: string; reply?: string } & Partial<Trial> = {}): Trial {
  const { goal = 'pass', goalRationale, fidelity = 'pass', opening = 'Здравствуйте', reply = 'Ответ агента', ...overrides } = options;
  const repeat = overrides.repeat ?? 0;
  return {
    id: repeat ? `t-${scenarioId}-${repeat}` : `t-${scenarioId}`, revisionId: 'rev', scenarioId, familyId: scenarioId, repeat, userMode: 'reactive', split: 'dev', manifestHash: 'h',
    outcome: 'ungraded', reason: 'Диалог дошёл до конца.', checks: [],
    events: [{ seq: 0, type: 'user', text: opening }, { seq: 1, type: 'assistant', text: reply }, { seq: 2, type: 'simulator', result: { message: '', done: true } }],
    initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 1,
    assessments: [vote('goal_attainment', goal, goalRationale), vote('reply_quality', 'pass'), vote('user_fidelity', fidelity)],
    ...overrides,
  };
}
function run(cards: Card[], trials: Trial[], overrides: Partial<Experiment> = {}): Experiment {
  return {
    schemaVersion: '1', id: RUN_ID, task: 't', mode: 'live', workflow: 'evaluate', createdAt: CREATED, updatedAt: CREATED, phase: 'results_review', message: '',
    sources: [], settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }),
    target: { kind: 'command', command: 'python3', args: ['agent.py'], timeoutMs: 60000 },
    requirements: [], questions: [], goldenCases: [], dialogues: [], profiles: [], notes: '', scenarios: cards, revisions: [], selectedRevisionId: null,
    manifestHash: 'h', reviewedAt: null, reviewMode: 'human', controlConsumedAt: null, acceptedTests: [], trials, comparisons: [], iterations: [],
    usage: emptyUsage(), error: null, limitations: [], humanReviews: [], ...overrides,
  };
}
/** `passed` + `failed` decided situations, `unmeasured` with a split goal vote, `pending` cards without a dialogue yet, then the controls. */
function scored(passed: number, failed: number, options: { unmeasured?: number; pending?: number; control?: Result | Result[] } = {}): Experiment {
  const cards: Card[] = [];
  const trials: Trial[] = [];
  const add = (id: string, title: string, goal: Parameters<typeof attempt>[1]) => { cards.push(card(id, { title })); trials.push(attempt(id, goal)); };
  for (let i = 0; i < passed; i++) add(`p${i}`, `Успех ${i + 1}`, { goal: 'pass' });
  for (let i = 0; i < failed; i++) add(`f${i}`, `Провал ${i + 1}`, { goal: 'fail' });
  for (let i = 0; i < (options.unmeasured ?? 0); i++) add(`u${i}`, `Не измерено ${i + 1}`, { goal: 'unknown', goalRationale: SPLIT });
  for (let i = 0; i < (options.pending ?? 0); i++) cards.push(card(`w${i}`, { title: `Ожидание ${i + 1}` }));
  const controls = options.control === undefined ? [] : Array.isArray(options.control) ? options.control : [options.control];
  controls.forEach((goal, i) => add(`ctl${i}`, `Контроль ${i + 1}`, goal === 'unknown' ? { goal, goalRationale: SPLIT } : { goal }));
  return run(cards, trials, {
    ...(options.pending ? { phase: 'evaluating' } : {}),
    ...(controls.length ? { positiveControlScenarioIds: controls.map((_, i) => `ctl${i}`) } : {}),
  });
}
/** A quick mark on the goal: `saw` is the judgment shown, `verdict` the owner's answer. */
const quick = (trialId: string, verdict: HumanReview['verdict'], saw: 'pass' | 'fail', note = 'Причина владельца.'): HumanReview =>
  ({ id: `q-${trialId}-${verdict}`, trialId, verdict, note, createdAt: '2026-09-17T00:00:00Z', metricId: 'goal_attainment', source: 'quick', judgeVerdict: saw });
/** Every decided counted attempt marked «согласен», except `skip`; `unsure` get «не могу сказать», `disagree` the opposite verdict. */
function marked(record: Experiment, options: { skip?: string[]; unsure?: string[]; disagree?: string[] } = {}): Experiment {
  const skip = new Set(options.skip ?? []), unsure = new Set(options.unsure ?? []), disagree = new Set(options.disagree ?? []);
  const reviews = record.trials.flatMap(trial => {
    const saw = trial.assessments?.find(item => item.metricId === 'goal_attainment')?.result;
    if (skip.has(trial.id) || (saw !== 'pass' && saw !== 'fail') || (record.positiveControlScenarioIds ?? []).includes(trial.scenarioId)) return [];
    const verdict = unsure.has(trial.id) ? 'unknown' : disagree.has(trial.id) ? (saw === 'pass' ? 'fail' : 'pass') : saw;
    return [quick(trial.id, verdict, saw)];
  });
  return { ...record, humanReviews: reviews };
}
/**
 * The run's cards grouped into topics of an accepted library: each topic names `conversations`
 * logged conversations as its sources; `unlabeled` more logged conversations have no topic.
 */
function withTopics(record: Experiment, topics: { id: string; title: string; cards: string[]; conversations: number }[], options: { unlabeled?: number } = {}): Experiment {
  let next = 0;
  const businessScenarios = topics.map(topic => ({ id: topic.id, title: topic.title,
    sourceDialogues: Array.from({ length: topic.conversations }, () => ({ batchId: 'logs', dialogueId: `d${++next}` })) }));
  const dialogues = Array.from({ length: next + (options.unlabeled ?? 0) }, (_, i) => ({ id: `d${i + 1}` }));
  const variants = topics.flatMap(topic => topic.cards.map(id => ({ id, businessScenarioId: topic.id })));
  return { ...record, librarySnapshot: { formatVersion: 1, imports: [{ id: 'logs', dialogues }], businessScenarios, variants } as unknown as Experiment['librarySnapshot'] };
}
/**
 * Seven situations: three topics (the third without a situation), three passes, three failures —
 * two of them one recorded cause and quoting the owner's rule, the third overturned by the owner —
 * and one the judge could not decide. Every decided situation is marked, so nothing waits for review.
 */
function rich(): Experiment {
  const cards: Card[] = [];
  const trials: Trial[] = [];
  const add = (id: string, title: string, goal: Result, extra: { opening?: string; reply?: string; criteria?: string; rule?: boolean; rationale?: string } = {}) => {
    cards.push(card(id, { title, ...(extra.criteria ? { successCriteria: extra.criteria } : {}), ...(extra.rule ? { requirementIds: ['r1'] } : {}) }));
    trials.push(attempt(id, { goal, ...(extra.rationale ? { goalRationale: extra.rationale } : {}), ...(extra.opening ? { opening: extra.opening } : {}), ...(extra.reply ? { reply: extra.reply } : {}) }));
  };
  add('p0', 'Возврат — частичный возврат', 'pass');
  add('f0', 'Возврат — номер назван сразу', 'fail', { opening: 'Номер терминала: 1234. Помогите с возвратом.', reply: 'Уточните номер терминала.', criteria: 'объяснить возврат, не спрашивая номер ещё раз', rule: true });
  add('f1', 'Возврат — клиент повторяет номер', 'fail', { reply: 'Назовите номер терминала ещё раз.', rule: true });
  add('p1', 'Статус заявки — где моя заявка', 'pass');
  add('p2', 'Статус заявки — заявка закрыта', 'pass');
  add('f2', 'Статус заявки — просит перезвонить', 'fail');
  add('u0', 'Смена тарифа — хочет дешевле', 'unknown', { rationale: SPLIT });
  const record = run(cards, trials, {
    sources: [SOURCE], requirements: [REQUIREMENT], usage: { ...emptyUsage(), costUsd: 0.14 },
    failureModes: [
      { id: 'm1', name: 'Переспрашивает номер, который клиент уже назвал', description: 'd', trialIds: ['t-f0', 't-f1'] },
      { id: 'm2', name: 'Обещает перезвонить вместо ответа', description: 'd', trialIds: ['t-f2'] },
    ],
  });
  return withTopics(marked(record, { disagree: ['t-f2'] }), [
    { id: 'refund', title: 'Возврат оплаты', cards: ['p0', 'f0', 'f1'], conversations: 6 },
    { id: 'status', title: 'Статус заявки', cards: ['p1', 'p2', 'f2'], conversations: 3 },
    { id: 'complaint', title: 'Жалоба на сотрудника', cards: [], conversations: 1 },
  ], { unlabeled: 2 });
}
/** One passed and three failed situations with recorded causes of 3, 1 and 1 failed situations (and one of passes only). */
function clustered(): Experiment {
  const record = scored(1, 3);
  record.failureModes = [
    { id: 'small', name: 'Не уточняет модель терминала', description: 'd', trialIds: ['t-f1'] },
    { id: 'big', name: 'Не называет срок возврата', description: 'd', trialIds: ['t-p0', 't-f0', 't-f1', 't-f2'] },
    { id: 'passing', name: 'Лишние извинения', description: 'd', trialIds: ['t-p0'] },
    { id: 'third', name: 'Отвечает вне инструкций', description: 'd', trialIds: ['t-f2'] },
  ];
  return record;
}
const view = (record: Experiment) => buildResultView(record);
const texts = (rows: { text: string }[]) => rows.map(row => row.text);
const blank = { role: 'blank', indent: 0, text: '' };
/** Rows split at the blank rows that separate blocks; asserts there is never a blank row at an edge or two in a row. */
function blocks(rows: ResultRow[], label: string): ResultRow[][] {
  assert.ok(rows.length, `${label}: rows`);
  assert.notEqual(rows[0]!.role, 'blank', `${label}: starts with a blank row`);
  assert.notEqual(rows.at(-1)!.role, 'blank', `${label}: ends with a blank row`);
  for (let i = 1; i < rows.length; i++) assert.ok(!(rows[i]!.role === 'blank' && rows[i - 1]!.role === 'blank'), `${label}: two blank rows at ${i}`);
  return rows.reduce<ResultRow[][]>((all, row) => { if (row.role === 'blank') all.push([]); else all.at(-1)!.push(row); return all; }, [[]]);
}

// ---- The answer ----

test('accuracyRow says the number and the situations in one line: «Точность агента: 72% — справился в 18 из 25 ситуаций»', () => {
  const v = view(scored(18, 7));
  assert.deepEqual(accuracyParts(v), { lead: 'Точность агента:', value: '72%', tail: '— справился в 18 из 25 ситуаций', level: 'warn' });
  assert.deepEqual(accuracyRow(v), { role: 'accuracy:warn', indent: 0, text: 'Точность агента: 72% — справился в 18 из 25 ситуаций' });
  // Genitive after «из»: one form for 1, 21, …; the plural genitive for everything else.
  const tails: [number, number, string][] = [
    [1, 0, '— справился в 1 из 1 ситуации'], [21, 0, '— справился в 21 из 21 ситуации'], [1, 1, '— справился в 1 из 2 ситуаций'],
    [3, 2, '— справился в 3 из 5 ситуаций'], [0, 11, '— справился в 0 из 11 ситуаций'], [22, 0, '— справился в 22 из 22 ситуаций'],
  ];
  for (const [passed, failed, tail] of tails) assert.equal(accuracyParts(view(scored(passed, failed))).tail, tail);
});

test('the colour level reads the rounded percent the row prints: 80 and up good, 50–79 warn, below 50 bad', () => {
  assert.equal(GOOD_FROM, 80);
  assert.equal(MIXED_FROM, 50);
  const vectors: [number, number, string, 'good' | 'warn' | 'bad'][] = [
    [12, 3, '80%', 'good'],
    // 39/49 is 79.6%: the row prints «80%», so the level is good next to it, never warn.
    [39, 10, '80%', 'good'],
    // 27/34 is 79.4%: «79%» is warn.
    [27, 7, '79%', 'warn'],
    [1, 1, '50%', 'warn'],
    // 62/125 is 49.6%: «50%» is warn; 42/85 is 49.4%: «49%» is bad.
    [62, 63, '50%', 'warn'],
    [42, 43, '49%', 'bad'],
    [0, 9, '0%', 'bad'],
    [21, 0, '100%', 'good'],
  ];
  for (const [passed, failed, value, level] of vectors) {
    const v = view(scored(passed, failed));
    assert.equal(accuracyParts(v).value, value, `${passed}/${passed + failed}`);
    assert.equal(accuracyParts(v).level, level, `${passed}/${passed + failed}`);
    assert.equal(accuracyRow(v).role, `accuracy:${level}`);
  }
});

test('HN-3: above 10% of counted situations not measured the number is never good, and the headline says how many', () => {
  assert.equal(NOT_MEASURED_WARN_ABOVE, 10);
  const thin = view(scored(5, 1, { unmeasured: 4 }));
  assert.deepEqual(accuracyParts(thin), { lead: 'Точность агента:', value: '83%', tail: '— справился в 5 из 6 ситуаций, ещё 4 не измерено', level: 'warn' });
  assert.equal(accuracyRow(thin).role, 'accuracy:warn');
  const edge = view(scored(9, 0, { unmeasured: 1 }));
  assert.deepEqual([accuracyParts(edge).level, accuracyParts(edge).tail], ['good', '— справился в 9 из 9 ситуаций'], 'exactly 10% is not above it');
  const over = view(scored(8, 0, { unmeasured: 1 }));
  assert.deepEqual([accuracyParts(over).level, accuracyParts(over).tail], ['warn', '— справился в 8 из 8 ситуаций, ещё 1 не измерено'], '1 of 9 is 11%');
  const bad = view(scored(1, 3, { unmeasured: 2 }));
  assert.equal(accuracyParts(bad).level, 'bad', 'a bad number stays bad');
  assert.ok(accuracyParts(bad).tail.endsWith(', ещё 2 не измерено'), accuracyParts(bad).tail);
  for (const record of [scored(9, 0, { control: 'unknown' }), scored(9, 0, { pending: 5 })]) {
    assert.deepEqual([accuracyParts(view(record)).level, accuracyParts(view(record)).tail], ['good', '— справился в 9 из 9 ситуаций'], 'controls and pending never count');
  }
});

test('OD-1 in the number: a situation whose only attempt got an empty reply is not measured, never failed', () => {
  const silent = attempt('s', { outcome: 'invalid', invalidCause: 'agent', reason: 'Испытуемый вернул пустой ответ.' });
  delete silent.assessments;
  const v = view(run([card('p'), card('s')], [attempt('p'), silent]));
  assert.deepEqual([v.headline.passed, v.headline.decided], [1, 1]);
  assert.deepEqual(v.notMeasured.reasons.map(reason => [reason.code, reason.count]), [['agent_error', 1]]);
});

test('without a decided situation the row has no number, the level none and a tail that says why', () => {
  const cases: [string, Experiment, string][] = [
    ['a draft that never ran', run([card('a'), card('b')], [], { phase: 'review' }), 'прогон ещё не запускался'],
    ['a draft still being prepared', run([card('a')], [], { phase: 'preparing' }), 'прогон ещё не запускался'],
    ['a run still going', scored(0, 0, { pending: 3 }), 'считается — ждут проверки 3 ситуации'],
    ['one situation still going', scored(0, 0, { pending: 1 }), 'считается — ждут проверки 1 ситуация'],
    ['five situations still going', scored(0, 0, { pending: 5 }), 'считается — ждут проверки 5 ситуаций'],
    ['nothing measured', scored(0, 0, { unmeasured: 2 }), 'нет данных — ни одна ситуация не измерена'],
  ];
  for (const [label, record, tail] of cases) {
    const v = view(record);
    assert.deepEqual(accuracyParts(v), { lead: 'Точность агента:', value: null, tail, level: 'none' }, label);
    assert.deepEqual(accuracyRow(v), { role: 'accuracy:none', indent: 0, text: `Точность агента: ${tail}` }, label);
  }
});

test('alarmRow warns above the number when a control failed or was not measured, for one control and for several', () => {
  const alarm = (record: Experiment) => alarmRow(view(record))?.text;
  const says = (what: string) => `✗ Числу пока не верить: ${what} — проверьте связь с агентом`;
  assert.equal(alarm(scored(5, 2, { control: 'fail' })), says('контрольная ситуация не прошла'));
  assert.equal(alarm(scored(5, 2, { control: ['fail', 'fail'] })), says('контрольные ситуации не прошли'));
  assert.equal(alarm(scored(5, 2, { control: 'unknown' })), says('контрольная ситуация не измерена'));
  assert.equal(alarm(scored(5, 2, { control: ['unknown', 'unknown'] })), says('контрольные ситуации не измерены'));
  assert.equal(alarm(scored(5, 2, { control: ['fail', 'unknown'] })), says('контрольные ситуации не прошли или не измерены'));
  assert.equal(alarmRow(view(scored(5, 2, { control: 'fail' })))?.role, 'alarm');
  assert.equal(alarmRow(view(scored(5, 2, { control: 'pass' }))), null, 'a passing control raises nothing');
  assert.equal(alarmRow(view(scored(5, 2))), null, 'no control, no alarm');
  // The alarm sits above the number, and a control is never part of the number.
  const head = headRows(view(scored(5, 2, { control: 'fail' })));
  assert.deepEqual(head.slice(0, 2).map(row => row.role), ['alarm', 'accuracy:warn']);
  for (const control of ['fail', 'unknown', 'pass'] as const) assert.equal(accuracyRow(view(scored(5, 2, { control }))).text, accuracyRow(view(scored(5, 2))).text, control);
});

// ---- The trust line ----

test('trustParts: interval, small sample, not measured, agreement and instability in this order, the first part capitalized', () => {
  // Two repeats per situation: r0 passed once and failed once, so it is decided as failed and counted as unstable.
  const record = run([], [], { settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 2 }) });
  const add = (id: string, goals: [Result, Result], extra: { goalRationale?: string; fidelity?: Result } = {}) => {
    record.scenarios.push(card(id, { title: `Ситуация ${id}` }));
    goals.forEach((goal, repeat) => record.trials.push(attempt(id, { goal, repeat, ...extra })));
  };
  add('p0', ['pass', 'pass']); add('p1', ['pass', 'pass']); add('f0', ['fail', 'fail']); add('r0', ['pass', 'fail']);
  add('u0', ['unknown', 'unknown'], { goalRationale: SPLIT }); add('u1', ['unknown', 'unknown'], { goalRationale: SPLIT });
  add('x0', ['pass', 'pass'], { fidelity: 'fail' });
  const v = view(marked(record));
  assert.equal(v.cards.find(item => item.scenarioId === 'r0')?.flaky, true);
  // Three of seven not measured: the share stands above the number as its alarm, and the trust line does not repeat it.
  assert.equal(alarmRow(v)?.text, `✗ Числу пока не верить: не измерено 3 из 7 ситуаций — чаще всего ${NOT_MEASURED_TEXT.judge_split} (2)`);
  assert.deepEqual(trustParts(v), [
    'Вероятно, от 15% до 85% (95%)',
    'мало данных',
    'с судьёй согласны 8 из 8',
    'нестабильно 1',
  ]);
  assert.deepEqual(trustSegments(v).map(part => part.warn), [false, true, false, false]);
  assert.deepEqual(trustSegments(v).map(part => part.text), trustParts(v));
  const row = headRows(v).find(item => item.role.startsWith('trust'));
  assert.deepEqual(row, { role: 'trust:small', indent: 0, text: trustParts(v).join(' · '), parts: trustParts(v) });
  // One of twenty not measured stays in the trust line, after the interval, as a warning with its share.
  const few = view(marked(scored(18, 1, { unmeasured: 1 })));
  assert.deepEqual(trustSegments(few), [
    { text: 'Вероятно, от 75% до 99% (95%)', warn: false }, { text: 'мало данных', warn: true },
    { text: `не измерено 1 из 20 — ${NOT_MEASURED_TEXT.judge_split}`, warn: true }, { text: 'с судьёй согласны 19 из 19', warn: false },
  ]);
  assert.equal(alarmRow(few), null);
  const twenty = view(marked(scored(20, 0, { unmeasured: 1 })));
  assert.deepEqual(trustSegments(twenty).map(part => [part.text, part.warn]).slice(1),
    [[`не измерено 1 из 21 — ${NOT_MEASURED_TEXT.judge_split}`, true], ['с судьёй согласны 20 из 20', false]]);
  assert.equal(headRows(twenty).find(item => item.role.startsWith('trust'))?.role, 'trust:small', 'a warning in the line paints the line as one, with no small sample');
});

test('trustParts: «мало данных» below 20 decided situations only, one reason named alone, what is still being checked', () => {
  const nineteen = view(scored(5, 14));
  assert.deepEqual(trustParts(nineteen), ['Вероятно, от 12% до 49% (95%)', 'мало данных', 'судью ещё не проверяли']);
  assert.equal(headRows(nineteen)[1]?.role, 'trust:small');
  const twenty = view(scored(10, 10));
  assert.ok(!trustParts(twenty).includes('мало данных'));
  assert.equal(headRows(twenty)[1]?.role, 'trust');
  assert.deepEqual(trustSegments(twenty).map(part => part.warn), [false, false]);
  assert.deepEqual(trustParts(view(scored(3, 9))).slice(0, 2), ['Вероятно, от 9% до 53% (95%)', 'мало данных']);
  // One reason: named without «чаще всего».
  assert.deepEqual(trustParts(view(scored(9, 0, { unmeasured: 1 }))).slice(2, 3), [`не измерено 1 из 10 — ${NOT_MEASURED_TEXT.judge_split}`]);
  // A run still going: what is pending, and no agreement part while the judge's queue is not final.
  assert.deepEqual(trustParts(view(scored(2, 1, { pending: 3 }))), ['Вероятно, от 21% до 94% (95%)', 'мало данных', 'ещё проверяется 3']);
});

test('trustParts: the owner\'s agreement is counted, «судью ещё не проверяли» while nothing is marked, nothing without a queue', () => {
  assert.ok(trustParts(view(scored(18, 7))).includes('судью ещё не проверяли'));
  assert.ok(trustParts(view(marked(scored(18, 7)))).includes('с судьёй согласны 25 из 25'));
  // A «не согласен» overturns the judge: the agreement counts it against the judge and the number moves with the owner.
  const overturned = view(marked(scored(18, 7), { disagree: ['t-f0'] }));
  assert.ok(trustParts(overturned).includes('с судьёй согласны 24 из 25'));
  assert.equal(accuracyRow(overturned).text, 'Точность агента: 76% — справился в 19 из 25 ситуаций');
  // Nothing decided, nothing to review: no agreement part, and the first part starts the sentence. Without a number there is
  // nothing to distrust yet, so the unmeasured share stays in the line.
  assert.deepEqual(trustParts(view(scored(0, 0, { unmeasured: 2 }))), [`Не измерено 2 из 2 — ${NOT_MEASURED_TEXT.judge_split}`]);
  assert.equal(alarmRow(view(scored(0, 0, { unmeasured: 2 }))), null);
  assert.deepEqual(trustParts(view(scored(0, 0, { pending: 3 }))), ['Ещё проверяется 3']);
  assert.deepEqual(trustParts(view(run([card('a')], [], { phase: 'review' }))), [], 'a draft has nothing to trust yet');
  assert.deepEqual(headRows(view(run([card('a')], [], { phase: 'review' }))).map(row => row.role), ['accuracy:none']);
});

test('trustParts: situations the owner reviewed in full are named instead of «судью ещё не проверяли»; a one-key mark still wins', () => {
  const full = (trialId: string): HumanReview => ({ id: `h-${trialId}`, trialId, metricId: 'goal_attainment', verdict: 'fail', note: 'Проверено целиком.', createdAt: '2026-09-17T00:00:00Z' });
  const reviewed = (failed: number, ids: string[]) => ({ ...scored(3, failed), humanReviews: ids.map(full) });
  const agreement = (record: Experiment) => trustParts(view(record)).at(-1);
  assert.equal(agreement(reviewed(2, ['t-f0'])), 'вы проверили 1 ситуацию');
  assert.equal(agreement(reviewed(2, ['t-f0', 't-f1'])), 'вы проверили 2 ситуации');
  assert.equal(agreement(reviewed(5, ['t-f0', 't-f1', 't-f2', 't-f3', 't-f4'])), 'вы проверили 5 ситуаций');
  const both = reviewed(2, ['t-f0']);
  both.humanReviews.push(quick('t-f1', 'fail', 'fail'));
  assert.equal(agreement(both), 'с судьёй согласны 1 из 1');
});

test('trustParts: a whole-dialogue verdict of the owner that contradicts the number is a warning part', () => {
  /** The owner's verdict on the whole dialogue: it does not decide the situation, so it can say the opposite. */
  const dialogue = (trialId: string, verdict: HumanReview['verdict']): HumanReview => ({ id: `d-${trialId}`, trialId, verdict, note: 'Прочитал разговор целиком.', createdAt: '2026-09-17T00:00:00Z' });
  const record = (reviews: HumanReview[]) => ({ ...scored(3, 2), humanReviews: reviews });
  const contradicted = view(record([dialogue('t-f0', 'pass')]));
  assert.equal(accuracyRow(contradicted).text, 'Точность агента: 60% — справился в 3 из 5 ситуаций', 'the owner\'s dialogue verdict does not move the number');
  assert.deepEqual(trustSegments(contradicted).slice(2), [
    { text: 'вы проверили 1 ситуацию', warn: false },
    { text: 'ваши отметки расходятся с итогом: 1', warn: true },
  ]);
  assert.deepEqual(trustParts(view(record([dialogue('t-f0', 'pass'), dialogue('t-p0', 'fail')]))).slice(2), ['вы проверили 2 ситуации', 'ваши отметки расходятся с итогом: 2']);
  // A verdict that agrees with the number contradicts nothing.
  assert.ok(!trustParts(view(record([dialogue('t-f0', 'fail'), dialogue('t-p0', 'pass')]))).some(part => part.startsWith('ваши отметки')));
  assert.deepEqual(trustSegments(view(scored(3, 2))).map(part => part.warn), [false, true, false], 'without reviews only «мало данных» warns');
});

test('disagreementRows: a full overturn says the verdict, a partial one names the halves, the overturned half first', () => {
  /** One situation with both headline halves, both failed by the judge, and the owner's one-key answer on each half. */
  const halves = (goal: HumanReview['verdict'], rules: HumanReview['verdict']): Experiment => {
    const record = run([card('b0', { title: 'Возврат — клиент торопится', metrics: [{ ...goalAttainment }, { ...promptCompliance }, { ...replyQuality }, { ...simulatorFidelity }] })],
      [attempt('b0', { assessments: [vote('goal_attainment', 'fail'), vote('prompt_compliance', 'fail'), vote('reply_quality', 'pass'), vote('user_fidelity', 'pass')] })]);
    const mark = (metricId: string, verdict: HumanReview['verdict']): HumanReview =>
      ({ ...quick('t-b0', verdict, 'fail', 'Запрос выполнен, но правило нарушено.'), id: `q-${metricId}`, metricId, countingRules: COUNTING_RULES });
    return { ...record, humanReviews: [mark('goal_attainment', goal), mark('prompt_compliance', rules)] };
  };
  const owner = (record: Experiment) => disagreementRows(view(record))[2]?.text;
  assert.deepEqual(disagreementRows(view(halves('pass', 'fail'))), [
    { role: 'heading', indent: 0, text: 'Вы не согласились с судьёй' },
    { role: 'item', indent: 2, text: 'Возврат — клиент торопится' },
    { role: 'muted', indent: 4, text: 'Судья: не справился → вы: запрос выполнен; правила промпта нарушены' },
    { role: 'quote', indent: 4, text: 'Причина: «Запрос выполнен, но правило нарушено.»' },
  ]);
  assert.equal(owner(halves('fail', 'pass')), 'Судья: не справился → вы: правила промпта соблюдены; запрос не выполнен');
  assert.equal(owner(halves('pass', 'unknown')), 'Судья: не справился → вы: запрос выполнен; про правила промпта не уверены');
  assert.equal(owner(halves('pass', 'pass')), 'Судья: не справился → вы: справился');
  assert.deepEqual(disagreementRows(view(halves('fail', 'fail'))), [], 'agreeing with both halves is no disagreement');
  assert.deepEqual(disagreementRows(view(scored(3, 2))), []);
});

// ---- Topics and reality ----

test('realityParts weighs the topics by their share of conversations and says how many conversations have a topic', () => {
  const v = view(rich());
  // Возврат оплаты: 1 of 3 at 60% of conversations; Статус заявки: 3 of 3 at 30% → (0.6·⅓ + 0.3·1) / 0.9 ≈ 56%, on 90% of them.
  assert.deepEqual(realityParts(v), ['С учётом частоты тем — около 56% (измерены темы 90% диалогов; темы известны у 10 из 12 разговоров)']);
  assert.deepEqual(headRows(v).at(-1), { role: 'reality', indent: 0, text: realityParts(v)[0], parts: realityParts(v) });
  // Every conversation has a topic: no parenthesis.
  // Every conversation has a topic: no parenthesis. 1 of 2 at 60%, 2 of 2 at 40% → 0.6·½ + 0.4·1 = 70%.
  const all = withTopics(scored(3, 1), [{ id: 'a', title: 'Возврат оплаты', cards: ['p0', 'f0'], conversations: 3 }, { id: 'b', title: 'Статус заявки', cards: ['p1', 'p2'], conversations: 2 }]);
  assert.deepEqual(realityParts(view(all)), ['С учётом частоты тем — около 70%']);
  assert.deepEqual(realityParts(view(scored(18, 7))), [], 'no library, no topics');
  assert.ok(headRows(view(scored(18, 7))).every(row => row.role !== 'reality'));
});

test('topicRows: the topics by share with the handled count and the share aligned in two columns, then the uncovered share', () => {
  const v = view(rich());
  const rows = topicRows(v);
  assert.deepEqual(rows.map(row => [row.role, row.indent, row.text]), [
    ['heading', 0, 'По темам'], ['item', 2, 'Возврат оплаты'], ['item', 2, 'Статус заявки'], ['item:muted', 2, 'Не покрыто ситуациями'],
  ]);
  assert.equal(rows[0]!.right, 'справился   доля диалогов');
  assert.deepEqual(rows.slice(1).map(row => row.right!.trim().split(/\s{3,}/)), [['1 из 3', '60%'], ['3 из 3', '30%'], ['—', '10%']]);
  // Laid out, both columns end where their headings end.
  const lines = fitRows(rows, 100).map(line => line.text);
  const end = (line: string, needle: string) => visibleWidth(line.slice(0, line.lastIndexOf(needle) + needle.length));
  for (const [line, handled] of [[lines[1]!, '1 из 3'], [lines[2]!, '3 из 3'], [lines[3]!, '—']] as const) {
    assert.equal(end(line, handled), end(lines[0]!, 'справился'), line);
    assert.equal(visibleWidth(line), visibleWidth(lines[0]!), line);
  }
});

test('topicRows: at most five topics, the rest in «Ещё N тем»; nothing when no topic has a decided situation', () => {
  const titles = ['Возврат оплаты', 'Статус заявки', 'Смена тарифа', 'Подключение терминала', 'Выписка по счёту', 'Отмена платежа', 'Жалоба на сотрудника'];
  const ids = ['p0', 'p1', 'p2', 'p3', 'p4', 'f0', 'f1'];
  const seven = withTopics(scored(5, 2), titles.map((title, i) => ({ id: `t${i}`, title, cards: [ids[i]!], conversations: 7 - i })));
  const rows = topicRows(view(seven));
  assert.deepEqual(texts(rows), ['По темам', ...titles.slice(0, 5), 'Ещё 2 темы']);
  // The rest sums its situations and its share: 0 of 2 at 3 of 28 conversations.
  assert.deepEqual(rows.at(-1)!.right!.trim().split(/\s{3,}/), ['0 из 2', '11%']);
  assert.equal(topicRows(view(withTopics(scored(6, 0), [...titles.slice(0, 6)].map((title, i) => ({ id: `t${i}`, title, cards: [`p${i}`], conversations: 1 }))))).at(-1)!.text, 'Ещё 1 тема');
  // A table of dashes says nothing.
  const undecided = withTopics(scored(0, 0, { unmeasured: 2 }), [{ id: 'a', title: 'Возврат оплаты', cards: ['u0'], conversations: 2 }, { id: 'b', title: 'Статус заявки', cards: ['u1'], conversations: 1 }]);
  assert.ok(view(undecided).topics, 'the topics are known');
  assert.deepEqual(topicRows(view(undecided)), []);
  assert.deepEqual(realityParts(view(undecided)), []);
  assert.deepEqual(topicRows(view(scored(18, 7))), []);
  // Without any conversation naming a topic there is no share column and no weighted number.
  const unshared = withTopics(scored(2, 1), [{ id: 'a', title: 'Возврат оплаты', cards: ['p0', 'f0'], conversations: 0 }, { id: 'b', title: 'Статус заявки', cards: ['p1'], conversations: 0 }]);
  assert.deepEqual(topicRows(view(unshared)).map(row => [row.text, row.right?.trim()]), [['По темам', 'справился'], ['Возврат оплаты', '1 из 2'], ['Статус заявки', '1 из 1']]);
  assert.deepEqual(realityParts(view(unshared)), []);
});

// ---- Causes ----

test('causeRows: the recorded causes by size with a never-cut counter, each with its example when asked', () => {
  const v = view(clustered());
  const rows = causeRows(v);
  assert.deepEqual(rows, [
    { role: 'heading', indent: 0, text: 'Почему ошибается' },
    { role: 'item', indent: 2, text: '1  Не называет срок возврата', right: '3 ситуации', short: '3' },
    { role: 'item', indent: 2, text: '2  Не уточняет модель терминала', right: '1 ситуация', short: '1' },
    { role: 'item', indent: 2, text: '3  Отвечает вне инструкций', right: '1 ситуация', short: '1' },
  ]);
  const withExamples = causeRows(v, { examples: true });
  assert.deepEqual(withExamples.slice(1, 4), [
    rows[1],
    { role: 'muted', indent: 5, text: 'Провал 1' },
    { role: 'quote', indent: 5, text: 'Ожидалось: не записано в ситуации · Агент: «Ответ агента»' },
  ]);
  // The rule of the example is quoted under it.
  const ruled = causeRows(view(rich()), { examples: true });
  assert.deepEqual(ruled, [
    { role: 'heading', indent: 0, text: 'Почему ошибается' },
    { role: 'item', indent: 2, text: '1  Переспрашивает номер, который клиент уже назвал', right: '2 ситуации', short: '2' },
    { role: 'muted', indent: 5, text: 'Возврат — номер назван сразу' },
    { role: 'quote', indent: 5, text: 'Ожидалось: объяснить возврат, не спрашивая номер ещё раз · Агент: «Уточните номер терминала.»' },
    { role: 'quote', indent: 5, text: `Правило: «${RULE}»` },
  ]);
});

test('causeRows without recorded causes: the first three failures by title and «и ещё …»; the honest sentence when nothing failed', () => {
  assert.deepEqual(texts(causeRows(view(scored(0, 16)))), ['Почему ошибается', '1  Провал 1', '2  Провал 2', '3  Провал 3', 'и ещё 13 ошибок']);
  assert.equal(causeRows(view(scored(0, 16))).at(-1)!.role, 'muted');
  assert.equal(causeRows(view(scored(0, 4))).at(-1)!.text, 'и ещё 1 ошибка');
  assert.equal(causeRows(view(scored(0, 5))).at(-1)!.text, 'и ещё 2 ошибки');
  assert.deepEqual(texts(causeRows(view(scored(1, 3)))), ['Почему ошибается', '1  Провал 1', '2  Провал 2', '3  Провал 3']);
  const explained = causeRows(view(scored(0, 2)), { examples: true });
  assert.deepEqual(explained.map(row => [row.role, row.indent]), [['heading', 0], ['item', 2], ['quote', 5], ['item', 2], ['quote', 5]], 'the title is the item itself');
  assert.deepEqual(causeRows(view(scored(3, 0))), [{ role: 'good', indent: 0, text: 'Ошибок нет. Это не гарантия для живых клиентов: проверены 3 ситуации.' }]);
  assert.equal(causeRows(view(scored(1, 0)))[0]!.text, 'Ошибок нет. Это не гарантия для живых клиентов: проверена 1 ситуация.');
  assert.equal(causeRows(view(scored(21, 0)))[0]!.text, 'Ошибок нет. Это не гарантия для живых клиентов: проверена 21 ситуация.');
  assert.deepEqual(causeRows(view(scored(0, 0, { unmeasured: 2 }))), [], 'nothing decided proves nothing');
});

// ---- Дальше ----

test('nextRows: the chat asks in words, the board has a row per step, the CLI names the command with the full run id', () => {
  const vectors: [string, Experiment, string, string[], string[]][] = [
    ['a control alarm', scored(5, 2, { control: 'fail' }), 'Дальше: проверьте связь с агентом — скажите «проверь подключение».',
      ['Проверить связь с агентом и судью — пока это не сделано, числу не верить'], ['Проверьте подключение: agent-lab doctor --yes']],
    ['a run still going', scored(2, 1, { pending: 3 }), 'Дальше: дождитесь конца прогона — результат придёт сюда.',
      ['Дождаться конца прогона — результат появится сам'], ['Дождитесь конца прогона']],
    ['the judge not reviewed', scored(18, 7), 'Дальше: проверьте, прав ли судья, — скажите «покажи ошибку 1».',
      ['Проверить, прав ли судья — 7 ошибок ждут вашего «да» или «нет», 3 успеха на перепроверку', 'Повторить прогон на новой версии агента', 'Отчёт для заказчика'],
      ['Проверьте, прав ли судья: откройте прогон в Pi (/agent-lab)', `Повторите прогон: agent-lab repeat --id ${RUN_ID}`, `Отчёт для заказчика: agent-lab export --id ${RUN_ID} --format html`]],
    ['nothing decided', scored(0, 0, { unmeasured: 2 }), 'Дальше: спросите, почему ситуации не измерены.',
      ['Посмотреть, почему не измерено 2 ситуации'], ['Причины — в списке «Не измерено» выше']],
    ['failures reviewed', marked(scored(12, 3)), 'Дальше: исправьте агента и скажите «повтори прогон».',
      ['Повторить прогон на новой версии агента', 'Отчёт для заказчика'], [`Повторите прогон: agent-lab repeat --id ${RUN_ID}`, `Отчёт для заказчика: agent-lab export --id ${RUN_ID} --format html`]],
    ['all passed and reviewed', marked(scored(21, 0)), 'Дальше: скажите «отчёт для заказчика».',
      ['Отчёт для заказчика', 'Повторить прогон на новой версии агента'], [`Отчёт для заказчика: agent-lab export --id ${RUN_ID} --format html`, `Повторите прогон: agent-lab repeat --id ${RUN_ID}`]],
  ];
  for (const [label, record, chat, board, cli] of vectors) {
    const v = view(record);
    assert.deepEqual(nextRows(v, 'chat'), [{ role: 'next:first', indent: 0, text: chat }], label);
    for (const [surface, steps] of [['board', board], ['cli', cli]] as const) {
      const rows = nextRows(v, surface);
      assert.deepEqual(rows[0], { role: 'heading', indent: 0, text: 'Дальше' }, `${label} ${surface}`);
      assert.deepEqual(texts(rows.slice(1)), steps, `${label} ${surface}`);
      assert.deepEqual(rows.slice(1).map(row => [row.role, row.indent]), steps.map((_, i) => [i ? 'next' : 'next:first', 2]), `${label} ${surface}: the recommended step is the accent`);
    }
  }
  for (const surface of ['chat', 'board', 'cli'] as const) assert.deepEqual(nextRows(view(run([card('a')], [], { phase: 'review' })), surface), [], `a draft offers nothing on the ${surface}`);
});

test('nextRows: the judge review agrees the verb with the count — «1 ошибка ждёт», «2 ошибки ждут», «21 ошибка ждёт»', () => {
  const board = (record: Experiment) => nextRows(view(record), 'board')[1]!.text;
  const review = (tail: string) => `Проверить, прав ли судья — ${tail}`;
  assert.equal(board(marked(scored(12, 3), { skip: ['t-f0'] })), review('1 ошибка ждёт вашего «да» или «нет»'));
  assert.equal(board(marked(scored(12, 3), { skip: ['t-f0', 't-f1'] })), review('2 ошибки ждут вашего «да» или «нет»'));
  assert.equal(board(marked(scored(12, 5), { skip: ['t-f0', 't-f1', 't-f2', 't-f3', 't-f4'] })), review('5 ошибок ждут вашего «да» или «нет»'));
  assert.equal(board(scored(0, 21)), review('21 ошибка ждёт вашего «да» или «нет»'));
  // Only sampled passes left: counted as passes; «не могу сказать» keeps a situation in the queue.
  const sampled = view(scored(13, 0)).agreement.sampledPasses;
  assert.equal(sampled.length, 3);
  assert.equal(board(marked(scored(13, 0), { skip: sampled.slice(0, 1) })), review('1 успех на перепроверку'));
  assert.equal(board(marked(scored(13, 0), { skip: sampled.slice(0, 2) })), review('2 успеха на перепроверку'));
  assert.equal(board(marked(scored(12, 3), { unsure: ['t-f0', 't-f1'] })), review('2 с ответом «не знаю»'));
});

// ---- Screens ----

test('resultScreen: head, topics, causes, then on the CLI and in the board details every error, the unmeasured and the disagreements, the run line and «Дальше» last', () => {
  const v = view(rich());
  const first = (rows: ResultRow[], label: string) => blocks(rows, label).map(block => block[0]!.text);
  // 1 of the 7 counted situations is not measured (14%, above NOT_MEASURED_WARN_ABOVE): the headline names it.
  const head = 'Точность агента: 67% — справился в 4 из 6 ситуаций, ещё 1 не измерено';
  const runText = 'Прогон сегодня в 14:05 · 7 ситуаций · $0.14';
  assert.deepEqual(first(resultScreen(v, { surface: 'board', now: NOW }), 'board'), [head, 'По темам', 'Почему ошибается', runText, 'Дальше']);
  const full = [head, 'По темам', 'Почему ошибается', 'Все ошибки', 'Не измерено', 'Вы не согласились с судьёй', runText, 'Дальше'];
  assert.deepEqual(first(resultScreen(v, { surface: 'board', details: true, now: NOW }), 'board details'), full);
  const cli = resultScreen(v, { surface: 'cli', now: NOW });
  assert.deepEqual(first(cli, 'cli'), full);
  const [, , , errors, unmeasured, disagreements] = blocks(cli, 'cli');
  assert.deepEqual(errors, [
    { role: 'heading', indent: 0, text: 'Все ошибки' },
    { role: 'failed', indent: 2, text: '✗ 1  Возврат — номер назван сразу' },
    { role: 'quote', indent: 5, text: 'Ожидалось: объяснить возврат, не спрашивая номер ещё раз · Агент: «Уточните номер терминала.»' },
    { role: 'quote', indent: 5, text: `Правило: «${RULE}»` },
    { role: 'failed', indent: 2, text: '✗ 2  Возврат — клиент повторяет номер' },
    { role: 'quote', indent: 5, text: 'Ожидалось: Не переспрашивать номер терминала · Агент: «Назовите номер терминала ещё раз.»' },
    { role: 'quote', indent: 5, text: `Правило: «${RULE}»` },
  ]);
  assert.deepEqual(unmeasured, [{ role: 'heading', indent: 0, text: 'Не измерено' }, { role: 'item:muted', indent: 2, text: `Смена тарифа — хочет дешевле: ${NOT_MEASURED_TEXT.judge_split}` }]);
  assert.deepEqual(disagreements, [
    { role: 'heading', indent: 0, text: 'Вы не согласились с судьёй' },
    { role: 'item', indent: 2, text: 'Статус заявки — просит перезвонить' },
    { role: 'muted', indent: 4, text: 'Судья: не справился → вы: справился' },
    { role: 'quote', indent: 4, text: 'Причина: «Причина владельца.»' },
  ]);
  // The board and the CLI differ only in how «Дальше» is said.
  const details = resultScreen(v, { surface: 'board', details: true, now: NOW });
  const until = (rows: ResultRow[]) => rows.slice(0, rows.findIndex(row => row.text === 'Дальше'));
  assert.deepEqual(until(details), until(cli));
  assert.notDeepEqual(details.slice(-2), cli.slice(-2));
});

test('resultScreen never doubles or trails a blank row, whatever blocks are empty', () => {
  const records: [string, Experiment][] = [
    ['черновик', run([card('a'), card('b')], [], { phase: 'review' })], ['ничего не измерено', scored(0, 0, { unmeasured: 2 })],
    ['идёт', scored(3, 1, { pending: 11 })], ['контроль', scored(3, 0, { control: 'fail' })], ['без ошибок', marked(scored(3, 0))],
    ['без причин', scored(0, 16)], ['причины', clustered()], ['всё сразу', rich()],
  ];
  for (const [label, record] of records) {
    const v = view(record);
    for (const [surface, details] of [['board', false], ['board', true], ['cli', false]] as const) blocks(resultScreen(v, { surface, details, now: NOW }), `${label} ${surface}${details ? ' details' : ''}`);
    blocks(chatBlock(v, { expanded: true }), `${label} chat`);
    blocks(chatBlock(v, { expanded: false }), `${label} chat collapsed`);
  }
  // A draft that never ran says so and offers no step: the answer and the run line.
  assert.deepEqual(texts(resultScreen(view(records[0]![1]), { surface: 'board', now: NOW })), ['Точность агента: прогон ещё не запускался', '', 'Прогон сегодня в 14:05 · 2 ситуации']);
});

test('runLine: when, the named version, the situations, the cost and the demo mark; a fingerprint is never a version', () => {
  assert.deepEqual(runLine(view({ ...rich(), targetVersion: 'baseline-v1', mode: 'demo' }), NOW), {
    role: 'muted', indent: 0, text: 'Прогон сегодня в 14:05 · версия baseline-v1 · 7 ситуаций · $0.14 · учебный пример',
    parts: ['Прогон сегодня в 14:05', 'версия baseline-v1', '7 ситуаций', '$0.14', 'учебный пример'],
  });
  assert.equal(runLine(view({ ...scored(1, 0), targetFingerprint: 'abc123' }), NOW).text, 'Прогон сегодня в 14:05 · 1 ситуация');
  assert.equal(runLine(view(scored(1, 0)), new Date(2026, 8, 24, 9, 0)).text, 'Прогон вчера в 14:05 · 1 ситуация');
});

test('chatBlock collapsed: the number, the trust line and the causes in one row — no reality line, no blank row, no «Дальше»', () => {
  const v = view(rich());
  assert.deepEqual(chatBlock(v, { expanded: false }), [
    accuracyRow(v),
    { ...headRows(v)[1]!, indent: 2 },
    { role: 'muted', indent: 2, text: 'Чаще всего: Переспрашивает номер, который клиент уже назвал (2)', parts: ['Чаще всего: Переспрашивает номер, который клиент уже назвал (2)'] },
  ]);
  // Without recorded causes: the first three failure titles and how many more.
  assert.deepEqual(chatBlock(view(scored(0, 16)), { expanded: false }).at(-1), {
    role: 'muted', indent: 2, text: 'Чаще всего: Провал 1 · Провал 2 · Провал 3 · ещё 13 ошибок', parts: ['Чаще всего: Провал 1', 'Провал 2', 'Провал 3', 'ещё 13 ошибок'],
  });
  assert.deepEqual(chatBlock(view(clustered()), { expanded: false }).at(-1)!.parts,
    ['Чаще всего: Не называет срок возврата (3)', 'Не уточняет модель терминала (1)', 'Отвечает вне инструкций (1)']);
  // Nothing failed: the honest sentence instead of the causes.
  const clean = chatBlock(view(marked(scored(3, 0))), { expanded: false });
  assert.deepEqual(clean.at(-1), { role: 'good', indent: 2, text: 'Ошибок нет. Это не гарантия для живых клиентов: проверены 3 ситуации.' });
  // The alarm and the number stay at the edge; everything under them is indented.
  const alarmed = chatBlock(view(scored(3, 1, { control: 'fail' })), { expanded: false });
  assert.deepEqual(alarmed.map(row => [row.role, row.indent]), [['alarm', 0], ['accuracy:warn', 0], ['trust:small', 2], ['muted', 2]]);
  assert.deepEqual(texts(chatBlock(view(scored(0, 0, { unmeasured: 2 })), { expanded: false })),
    ['Точность агента: нет данных — ни одна ситуация не измерена', `Не измерено 2 из 2 — ${NOT_MEASURED_TEXT.judge_split}`]);
});

test('chatBlock expanded: the head with the reality line, every cause with its example, the unmeasured situations and the chat «Дальше»', () => {
  const v = view(rich());
  const rows = chatBlock(v, { expanded: true });
  assert.deepEqual(rows.map(row => [row.role, row.indent, row.text]), [
    ['accuracy:warn', 0, 'Точность агента: 67% — справился в 4 из 6 ситуаций, ещё 1 не измерено'],
    ['trust:small', 2, trustParts(v).join(' · ')],
    ['reality', 2, 'С учётом частоты тем — около 56% (измерены темы 90% диалогов; темы известны у 10 из 12 разговоров)'],
    ['blank', 0, ''],
    ['heading', 2, 'Почему ошибается'],
    ['item', 4, '1  Переспрашивает номер, который клиент уже назвал'],
    ['muted', 7, 'Возврат — номер назван сразу'],
    ['quote', 7, 'Ожидалось: объяснить возврат, не спрашивая номер ещё раз · Агент: «Уточните номер терминала.»'],
    ['quote', 7, `Правило: «${RULE}»`],
    ['blank', 0, ''],
    ['heading', 2, 'Не измерено'],
    ['item:muted', 4, `Смена тарифа — хочет дешевле: ${NOT_MEASURED_TEXT.judge_split}`],
    ['blank', 0, ''],
    ['next:first', 2, 'Дальше: исправьте агента и скажите «повтори прогон».'],
  ]);
  assert.equal(rows[5]!.right, '2 ситуации', 'the cause keeps its counter');
  assert.ok(!texts(chatBlock(v, { expanded: false })).includes('Вы не согласились с судьёй'), 'the chat block never lists the disagreements');
});

// ---- One failure (E7) ----

test('failureRows: expected, the agent\'s words, the rule with its source and the conversation — the judge\'s question only for an unmarked failure', () => {
  const record = rich();
  const v = view(record);
  // The labels form a 16-column column; the speakers of the conversation a 9-column one.
  const label = (name: string, text: string) => `${name}${' '.repeat(16 - name.length)}${text}`;
  const turn = (name: string, text: string) => `${name}${' '.repeat(9 - name.length)}${text}`;
  assert.deepEqual(failureRows(v, record, 0), [
    { role: 'failed', indent: 0, text: '✗ 1  Возврат — номер назван сразу', right: 'ошибка 1 из 2' },
    blank,
    { role: 'item', indent: 4, text: label('Ожидалось', 'объяснить возврат, не спрашивая номер ещё раз'), hang: 16 },
    { role: 'item', indent: 4, text: label('Агент ответил', '«Уточните номер терминала.»'), hang: 16 },
    { role: 'item', indent: 4, text: label('Правило', `«${RULE}»`), hang: 16 },
    { role: 'muted', indent: 20, text: 'Правила поддержки' },
    blank,
    { role: 'heading', indent: 4, text: 'Разговор' },
    { role: 'quote', indent: 6, text: turn('Клиент', 'Номер терминала: 1234. Помогите с возвратом.'), hang: 9 },
    { role: 'quote', indent: 6, text: turn('Агент', 'Уточните номер терминала.'), hang: 9 },
  ]);
  assert.equal(failureRows(v, record, 1)[0]!.right, 'ошибка 2 из 2');
  assert.equal(failureRows(v, record, 1)[2]!.text, label('Ожидалось', 'Не переспрашивать номер терминала'));
  assert.deepEqual(failureRows(v, record, 2), [], 'past the last failure');
  // Nobody marked it: the judge asks. Without a rule and an expectation the rows say so.
  const unmarked = scored(1, 2);
  const rows = failureRows(view(unmarked), unmarked, 1);
  assert.deepEqual(texts(rows.slice(2, 5)), [label('Ожидалось', 'не записано в ситуации'), label('Агент ответил', '«Ответ агента»'), label('Правило', 'у ситуации нет правила из ваших материалов')]);
  assert.deepEqual(rows.slice(-2), [blank, { role: 'next:first', indent: 0, text: 'Судья решил: не справился. Вы согласны?' }]);
  assert.ok(!texts(failureRows(view(marked(unmarked)), marked(unmarked), 1)).includes('Судья решил: не справился. Вы согласны?'));
});

test('failureRows never quotes words the record does not hold: a citation missing from the reply is not the agent\'s answer', () => {
  const record = run([card('f0', { title: 'Возврат — номер назван сразу' })], [attempt('f0', { goal: 'fail', reply: 'Уточните номер терминала.',
    assessments: [{ ...vote('goal_attainment', 'fail'), citations: [{ seq: 1, quote: 'Возврат оформлен.' }] }, vote('reply_quality', 'pass'), vote('user_fidelity', 'pass')] })]);
  const rows = failureRows(view(record), record, 0);
  assert.equal(rows[3]!.text, 'Агент ответил   ответ не подтверждён цитатой');
  assert.ok(!texts(rows).some(text => text.includes('Возврат оформлен.')));
  // The conversation still shows what the agent really said.
  assert.ok(texts(rows).includes('Агент    Уточните номер терминала.'));
});

// ---- Layout ----

const at = (rows: ResultRow[], width: number) => fitRows(rows, width).map(line => line.text);

test('fitRows: a right counter is never cut and ends at the edge; the text before it is clipped with «…»', () => {
  const heading: ResultRow = { role: 'heading', indent: 0, text: 'По темам', right: 'справился   доля диалогов' };
  assert.deepEqual(fitRows([heading], 60), [{ role: 'heading', text: ` По темам${' '.repeat(26)}справился   доля диалогов` }]);
  const long: ResultRow = { role: 'item', indent: 2, text: '1  Переспрашивает номер, который клиент уже назвал, и ещё раз уточняет модель терминала', right: '12 ситуаций' };
  for (const width of [40, 60, 80, 100]) {
    const [line] = at([long], width);
    assert.equal(visibleWidth(line!), width, `${width}: the counter ends at the edge`);
    assert.ok(line!.endsWith('  12 ситуаций'), `${width}: «${line}»`);
    assert.ok(line!.includes('…'), `${width}: the text is clipped, not the counter`);
  }
  // Wider terminals keep the 100-column layout.
  assert.equal(MAX_WIDTH, 100);
  assert.equal(visibleWidth(at([heading], 160)[0]!), 100);
});

test('fitRows: a clipped row stays plain text — no escape code around «…» in what the CLI prints', () => {
  const row: ResultRow = { role: 'item', indent: 2, text: '1  Переспрашивает номер, который клиент уже назвал, и ещё раз уточняет модель терминала', right: '12 ситуаций' };
  for (const width of [40, 60, 100]) {
    const text = plainText([row], width);
    assert.ok(text.includes('…'), `${width}: clipped`);
    assert.equal(text, stripTerminalSequences(text), `${width}: «${JSON.stringify(text)}»`);
  }
});

test('fitRows: under 80 columns a cause row says its short counter after the text; a row without one stays aligned', () => {
  const cause: ResultRow = { role: 'item', indent: 2, text: '1  Переспрашивает номер, который клиент уже назвал', right: '2 ситуации', short: '2' };
  assert.deepEqual(at([cause], 70), ['   1  Переспрашивает номер, который клиент уже назвал — 2']);
  assert.deepEqual(at([cause], 79), ['   1  Переспрашивает номер, который клиент уже назвал — 2']);
  const [wide] = at([cause], 80);
  assert.equal(visibleWidth(wide!), 80);
  assert.ok(wide!.endsWith(`назвал${' '.repeat(17)}2 ситуации`), `«${wide}»`);
  const narrow = at([{ ...cause, text: `${cause.text}, и ещё раз уточняет модель терминала` }], 50)[0]!;
  assert.ok(narrow.endsWith('… — 2') && visibleWidth(narrow) <= 50, `«${narrow}»`);
  const plain = at([{ role: 'failed', indent: 0, text: '✗ 1  Возврат — номер назван сразу', right: 'ошибка 1 из 2' }], 60)[0]!;
  assert.equal(visibleWidth(plain), 60);
  assert.ok(plain.endsWith('ошибка 1 из 2'));
});

test('fitRows: « · » parts break only between parts, each broken line ends with «·», continuation lines indented two columns', () => {
  const parts = ['Вероятно, от 52% до 86% (95%)', 'мало данных', 'не измерено 3 — судья не ответил', 'с судьёй согласны 8 из 8', 'нестабильно 1'];
  const row: ResultRow = { role: 'trust', indent: 0, text: parts.join(' · '), parts };
  assert.deepEqual(at([row], 50), [' Вероятно, от 52% до 86% (95%) · мало данных ·', '   не измерено 3 — судья не ответил ·', '   с судьёй согласны 8 из 8 · нестабильно 1']);
  assert.deepEqual(at([{ ...row, parts: parts.slice(0, 3) }], 100), [` ${parts.slice(0, 3).join(' · ')}`], 'one line when it fits');
  assert.deepEqual(at([row], 100), [' Вероятно, от 52% до 86% (95%) · мало данных · не измерено 3 — судья не ответил ·', '   с судьёй согласны 8 из 8 · нестабильно 1']);
  // An indented row keeps its own indent and adds two for continuations.
  const indented = at([{ ...row, indent: 2 }], 50);
  assert.ok(indented[0]!.startsWith('   В') && indented.slice(1).every(line => line.startsWith('     ') && !line.startsWith('      ')), indented.join('\n'));
  assert.ok(indented.slice(0, -1).every(line => line.endsWith(' ·')));
  assert.deepEqual(fitRows([row], 50).map(line => line.role), ['trust', 'trust', 'trust']);
});

test('fitRows: a labelled row wraps under its hanging indent, a plain row under its indent, a blank row stays empty', () => {
  const quote = 'Возврат по операции оформляется через кассу: выберите операцию в журнале, нажмите «Возврат» и дождитесь ответа банка.';
  const lines = at([{ role: 'item', indent: 4, text: `Агент ответил   «${quote}»`, hang: 16 }], 60);
  assert.ok(lines.length > 1);
  assert.ok(lines[0]!.startsWith('     Агент ответил   «Возврат'), lines[0]);
  for (const line of lines.slice(1)) assert.match(line, /^ {21}\S/, 'continuations start under the value, not under the label');
  assert.equal(lines.map(line => line.trim()).join(' '), `Агент ответил   «${quote}»`, 'no word is lost');
  const plain = at([{ role: 'quote', indent: 5, text: quote }], 40);
  assert.ok(plain.length > 1 && plain.every(line => /^ {6}\S/.test(line)), plain.join('\n'));
  assert.deepEqual(fitRows([{ role: 'blank', indent: 0, text: '' }], 60), [{ role: 'blank', text: '' }]);
});

test('fitRows: no line is wider than the width, capped at 100 columns, with wide characters, on every real screen', () => {
  const wide: ResultRow[] = [
    { role: 'item', indent: 2, text: `1  ${'返金の手続き'.repeat(8)}`, right: '12 ситуаций', short: '12' },
    { role: 'trust', indent: 0, text: '', parts: ['返金の手続き について', '顧客 はすでに 番号を 伝えました 🙂🙂', 'мало данных'] },
    { role: 'item', indent: 4, text: `Агент ответил   «${'返金の手続きについて質問があります。'.repeat(6)}»`, hang: 16 },
    { role: 'quote', indent: 6, text: `Клиент   ${'返金'.repeat(80)}`, hang: 9 },
    { role: 'failed', indent: 0, text: `✗ 1  ${'顧客'.repeat(40)}`, right: 'ошибка 1 из 2' },
  ];
  const record = rich();
  const v = view(record);
  const screens: [string, ResultRow[]][] = [
    ['wide', wide], ['cli', resultScreen(v, { surface: 'cli', now: NOW })], ['board', resultScreen(v, { surface: 'board', details: true, now: NOW })],
    ['chat', chatBlock(v, { expanded: true })], ['chat collapsed', chatBlock(v, { expanded: false })], ['failure', failureRows(v, record, 0)],
  ];
  for (const width of [40, 47, 60, 79, 80, 99, 100, 101, 160]) {
    for (const [label, rows] of screens) {
      const lines = at(rows, width);
      for (const line of lines) assert.ok(visibleWidth(line) <= Math.min(width, MAX_WIDTH), `${label} ${width}: «${line}» is ${visibleWidth(line)} wide`);
      // Every right counter survives in full and, from 80 columns, ends at the edge.
      for (const row of rows.filter(item => item.right)) {
        const shown = lines.find(line => line.endsWith(width < 80 && row.short ? ` — ${row.short}` : row.right!));
        assert.ok(shown, `${label} ${width}: «${row.right}» was cut`);
        if (width >= 80 || !row.short) assert.equal(visibleWidth(shown), Math.min(width, MAX_WIDTH), `${label} ${width}: «${shown}»`);
      }
    }
  }
  // plainText is the same layout, trailing spaces removed.
  const text = plainText(resultScreen(v, { surface: 'cli', now: NOW }), 80);
  assert.deepEqual(text.split('\n'), at(resultScreen(v, { surface: 'cli', now: NOW }), 80).map(line => line.trimEnd()));
  assert.ok(text.split('\n').every(line => line === line.trimEnd()));
});

// ---- When ----

test('whenText: сегодня, вчера or the date, in local time, deterministic with `now`', () => {
  const iso = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString();
  assert.equal(whenText(iso(2026, 8, 23, 14, 5), NOW), 'сегодня в 14:05');
  assert.equal(whenText(iso(2026, 8, 23, 0, 0), NOW), 'сегодня в 00:00');
  assert.equal(whenText(iso(2026, 8, 22, 18, 22), NOW), 'вчера в 18:22');
  assert.equal(whenText(iso(2026, 8, 19, 16, 2), NOW), '19 сент. в 16:02');
  assert.equal(whenText(iso(2026, 2, 1, 9, 7), NOW), '1 марта в 09:07');
  assert.equal(whenText(iso(2026, 4, 9, 23, 59), NOW), '9 мая в 23:59');
  // Across a month and a year boundary it is still «вчера».
  assert.equal(whenText(iso(2026, 11, 31, 23, 50), new Date(2027, 0, 1, 0, 10)), 'вчера в 23:50');
  assert.equal(whenText(iso(2026, 7, 31, 12, 0), new Date(2026, 8, 1, 8, 0)), 'вчера в 12:00');
  assert.equal(whenText(iso(2026, 8, 19, 16, 2), NOW), whenText(iso(2026, 8, 19, 16, 2), NOW));
  // A stored time that is not a date is shown as it is.
  assert.equal(whenText('now', NOW), 'now');
});

// ---- Copy ----

test('every chat and board row is plain Russian, without machine words and without a cut marker', () => {
  const records: [string, Experiment][] = [
    ['18/25', scored(18, 7)], ['39/49', scored(39, 10)], ['0/9', scored(0, 9)], ['1/1', scored(1, 0)], ['черновик', run([card('a')], [], { phase: 'review' })],
    ['0/0', scored(0, 0, { unmeasured: 2 })], ['контроль не измерен', scored(0, 10, { control: 'unknown' })], ['контроль не пройден', scored(5, 2, { control: 'fail' })],
    ['оба контроля', scored(5, 2, { control: ['fail', 'unknown'] })], ['идёт', scored(3, 1, { pending: 11 })],
    ['всё отмечено', marked(scored(12, 3), { disagree: ['t-f0'] })], ['всё хорошо', marked(scored(21, 0))], ['не могу сказать', marked(scored(12, 3), { unsure: ['t-f0', 't-f1'] })],
    ['причины', clustered()], ['без причин', scored(0, 16)], ['всё сразу', rich()],
  ];
  for (const [label, record] of records) {
    const v: ResultView = view(record);
    const rows = [
      ...chatBlock(v, { expanded: false }), ...chatBlock(v, { expanded: true }), ...nextRows(v, 'chat'),
      ...resultScreen(v, { surface: 'board', now: NOW }), ...resultScreen(v, { surface: 'board', details: true, now: NOW }),
      ...v.failures.flatMap((_, i) => failureRows(v, record, i)),
    ];
    for (const row of rows) {
      for (const text of [row.text, ...(row.parts ?? []), ...(row.right ? [row.right] : [])]) {
        assertPlainCopy(text, `${label} ${row.role}`);
        assert.ok(!text.includes('…'), `${label}: a cut marker in «${text}»`);
      }
    }
  }
});

// ---- «Не измерено» never raises the number silently ----

/** `passed` situations the agent handled and `broken` ones it never answered; every decided one marked by the owner. */
function unanswered(passed: number, broken: number): Experiment {
  const cards = Array.from({ length: passed + broken }, (_, i) => card(`s${i}`, { title: `Ситуация ${i + 1}` }));
  const trials = cards.map((item, i) => i < passed ? attempt(item.id)
    : attempt(item.id, { outcome: 'invalid', invalidCause: 'agent', reason: 'Агент не ответил.', assessments: [] }));
  return marked(run(cards, trials));
}

test('eight of ten unanswered situations raise the alarm on every surface: never a quiet «100% — ошибок нет»', () => {
  const v = view(unanswered(2, 8));
  const alarm = '✗ Числу пока не верить: не измерено 8 из 10 ситуаций — агент не ответил';
  assert.equal(accuracyRow(v).text, 'Точность агента: 100% — справился в 2 из 2 ситуаций, ещё 8 не измерено', 'the number says what it measured');
  assert.deepEqual(alarmRow(v), { role: 'alarm', indent: 0, text: alarm });
  // The chat (folded and open), the board, the CLI and the lines a CI job reads all open with it.
  for (const [label, rows] of [['chat', chatBlock(v, { expanded: false })], ['chat open', chatBlock(v, { expanded: true })],
    ['board', resultScreen(v, { surface: 'board', now: NOW })], ['cli', resultScreen(v, { surface: 'cli', now: NOW })]] as const) {
    assert.deepEqual(rows[0], { role: 'alarm', indent: 0, text: alarm }, label);
    assert.ok(!texts(rows).some(text => text.startsWith('Ошибок нет')), label);
    assert.ok(!texts(rows).some(text => text.includes('Отчёт для заказчика')), `${label}: no report for a number not to be trusted`);
  }
  assert.equal(plainText(resultScreen(v, { surface: 'cli', now: NOW }), MAX_WIDTH).split('\n')[0], ` ${alarm}`);
  // Only the measured situations had no error, and the sentence says how many were not measured.
  assert.deepEqual(causeRows(v), [{ role: 'muted', indent: 0, text: 'Среди измеренных ошибок нет: проверены 2 ситуации, не измерено 8. Это не гарантия для живых клиентов.' }]);
  // Why first, then a repeat; the customer report is not offered.
  assert.deepEqual(v.next.map(step => step.kind), ['why_unmeasured', 'repeat']);
  assert.deepEqual(nextRows(v, 'chat'), [{ role: 'next:first', indent: 0, text: 'Дальше: спросите, почему ситуации не измерены.' }]);
  assert.equal(exitCodeOf(v), 2, 'the CI exit code stays «incomplete»');
});

test('from a fifth of the situations unmeasured the number is not trusted; below it the share is the trust line\'s warning', () => {
  const two = view(unanswered(8, 2));
  assert.equal(two.notMeasured.alarm, true, '2 of 10 is a fifth');
  assert.equal(alarmRow(two)?.text, '✗ Числу пока не верить: не измерено 2 из 10 ситуаций — агент не ответил');
  assert.ok(!two.next.some(step => step.kind === 'report'));
  const one = view(unanswered(9, 1));
  assert.deepEqual([one.notMeasured.alarm, alarmRow(one)], [false, null]);
  assert.deepEqual(trustSegments(one).find(part => part.text.startsWith('не измерено')), { text: 'не измерено 1 из 10 — агент не ответил', warn: true });
  // Why is always among the steps when something was not measured: after what the result offers while there is no alarm.
  assert.deepEqual(one.next.map(step => step.kind), ['report', 'repeat', 'why_unmeasured']);
  assert.equal(causeRows(one)[0]!.text, noErrorsText(9, 1));
  assert.equal(noErrorsText(9, 1), 'Среди измеренных ошибок нет: проверено 9 ситуаций, не измерено 1. Это не гарантия для живых клиентов.');
  assert.deepEqual(causeRows(view(marked(scored(3, 0)))), [{ role: 'good', indent: 0, text: 'Ошибок нет. Это не гарантия для живых клиентов: проверены 3 ситуации.' }],
    '«Ошибок нет» only when nothing was left unmeasured');
  // A failed control keeps the alarm's one row; the unmeasured share then warns in the trust line.
  const controlled = view(scored(3, 1, { unmeasured: 2, control: 'fail' }));
  assert.equal(alarmRow(controlled)?.text, '✗ Числу пока не верить: контрольная ситуация не прошла — проверьте связь с агентом');
  assert.ok(trustSegments(controlled).some(part => part.text === `не измерено 2 из 6 — ${NOT_MEASURED_TEXT.judge_split}` && part.warn));
});

test('a page for others speaks about the owner, never to «вы»; the owner\'s own screens keep «вы»', () => {
  const full = (trialId: string): HumanReview => ({ id: `h-${trialId}`, trialId, metricId: 'goal_attainment', verdict: 'fail', note: 'Проверено целиком.', createdAt: '2026-09-17T00:00:00Z' });
  const whole = (trialId: string, verdict: HumanReview['verdict']): HumanReview => ({ id: `d-${trialId}`, trialId, verdict, note: 'Прочитал разговор.', createdAt: '2026-09-17T00:00:00Z' });
  const reviewed = view({ ...scored(3, 2), humanReviews: [full('t-f0'), whole('t-f1', 'pass')] });
  assert.deepEqual(trustParts(reviewed).slice(2), ['вы проверили 2 ситуации', 'ваши отметки расходятся с итогом: 1']);
  assert.deepEqual(trustSegments(reviewed, 'others').map(part => part.text).slice(2), ['владелец агента проверил 2 ситуации', 'отметки владельца агента расходятся с итогом: 1']);
  // A conversation the owner set aside is the owner's word too.
  const invalid = view({ ...scored(9, 0), humanReviews: [whole('t-p0', 'invalid')] });
  const [reason] = invalid.notMeasured.reasons;
  assert.deepEqual([reasonLabel(reason!), reasonLabel(reason!, 'others')], ['вы отметили разговор как негодный', 'владелец агента отметил разговор как негодный']);
  assert.ok(trustSegments(invalid, 'others').some(part => part.text === 'не измерено 1 из 9 — владелец агента отметил разговор как негодный'));
  assert.equal(alarmRow(view(scored(5, 2, { control: 'fail' })), 'others')?.text, '✗ Числу пока не верить: контрольная ситуация не прошла — нужно проверить связь с агентом');
  for (const text of [...trustSegments(reviewed, 'others'), ...trustSegments(invalid, 'others')].map(part => part.text)) {
    assert.doesNotMatch(text, /(^|[\s«])(вы|вас|вам|ваш[а-я]*)([\s»,.:]|$)/iu, text);
  }
});

test('the folded chat counts the causes it does not name as causes, never as the failures left over', () => {
  const record = scored(0, 8);
  record.failureModes = [
    { id: 'a', name: 'Переспрашивает номер', description: 'd', trialIds: ['t-f0', 't-f1'] },
    { id: 'b', name: 'Не называет срок', description: 'd', trialIds: ['t-f2'] },
    { id: 'c', name: 'Обещает перезвонить', description: 'd', trialIds: ['t-f3'] },
    { id: 'd', name: 'Отвечает вне инструкций', description: 'd', trialIds: ['t-f4'] },
  ];
  const v = view(record);
  assert.deepEqual([v.topCauses.length, v.moreCauses], [3, 1]);
  assert.deepEqual(chatBlock(v, { expanded: false }).at(-1)!.parts, ['Чаще всего: Переспрашивает номер (2)', 'Не называет срок (1)', 'Обещает перезвонить (1)', 'ещё 1 причина']);
  assert.equal(causeRows(v).at(-1)!.text, 'и ещё 1 причина', 'the board says it too');
  assert.equal(view(clustered()).moreCauses, 0);
  assert.ok(!chatBlock(view(clustered()), { expanded: false }).at(-1)!.text.includes('ещё'));
});

test('a customer who never said «не знаю» adds no «0%» to the trust line', () => {
  const moves = { answer: 3, missing: 0, turn: 0, finish: 1, other: 0, blocked: [] };
  assert.equal(dunnoText({ customer: moves }), null);
  assert.equal(dunnoText({ customer: { ...moves, missing: 1 } }), 'клиент не знал ответа на 25% вопросов агента');
  assert.ok(!trustParts({ ...view(scored(3, 1)), customer: moves }).some(part => part.includes('не знал')));
});

test('a reply the judge did not point at is never the agent\'s words in a failure; the conversation still shows it', () => {
  const record = run([card('f0', { title: 'Возврат — возврат не оформлен' })], [attempt('f0', { goal: 'fail', reply: 'Спасибо за обращение, хорошего дня!',
    assessments: [{ ...vote('goal_attainment', 'fail'), evidence: [0] }, vote('reply_quality', 'pass'), vote('user_fidelity', 'pass')] })]);
  const v = view(record);
  assert.deepEqual([v.failures[0]!.said, v.failures[0]!.unsaid], [null, 'not_cited']);
  assert.equal(saidText(v.failures[0]!), 'судья не указал реплику');
  assert.ok(texts(errorListRows(v)).some(text => text.endsWith('Агент: судья не указал реплику')));
  assert.equal(failureRows(v, record, 0)[3]!.text, 'Агент ответил   судья не указал реплику');
  assert.ok(!texts([...errorListRows(v), ...causeRows(v, { examples: true }), ...failureRows(v, record, 0).slice(0, 5)]).some(text => text.includes('Спасибо за обращение')));
  assert.ok(texts(failureRows(v, record, 0)).includes('Агент    Спасибо за обращение, хорошего дня!'));
});

test('«Как считали» says the counting rule the result names, in the words of its edition', () => {
  const v = view(scored(3, 1));
  assert.equal(v.countingRules, 'goal-and-rules-v2');
  assert.deepEqual(countingLines(v), [COUNTING_RULE_TEXT['goal-and-rules-v2'], 'Не измеренные ситуации в процент не входят.']);
  assert.equal(countingLines(view(scored(3, 1, { control: 'pass' }))).at(-1),
    'Не измеренные ситуации в процент не входят. Контрольные ситуации проверяют связь с агентом и судью и в процент тоже не входят.');
  assert.deepEqual(countingLines({ ...v, countingRules: 'all-expectations-v2, goal-and-rules-v3' }).slice(0, 2), [COUNTING_RULE_TEXT['all-expectations-v2'], COUNTING_RULE_TEXT['goal-and-rules-v3']]);
  assert.deepEqual(countingLines({ ...v, countingRules: 'a-rule-no-edition-knows' }), ['Не измеренные ситуации в процент не входят.']);
});

test('fitRows never starts a line with «·»: the separator stays with the part before it, at every width, nothing lost', () => {
  const parts = ['Вероятно, от 9% до 91% (95%)', 'мало данных', 'судью ещё не проверяли', 'клиент не знал ответа на 40% вопросов агента',
    'не измерено 12 из 40 — судья не ответил — сбой связи или лимит запросов', 'нестабильно 1'];
  for (let width = 20; width <= 100; width++) {
    for (const indent of [0, 2]) {
      const lines = at([{ role: 'trust', indent, text: parts.join(' · '), parts }], width);
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `${width}: «${line}»`);
        assert.ok(!line.trimStart().startsWith('·'), `${width}/${indent}: a line starts with the separator:\n${lines.join('\n')}`);
      }
      assert.equal(lines.map(line => line.trim()).join(' '), parts.join(' · '), `${width}/${indent}`);
    }
  }
  // The parts' own text is never changed, not even a no-break space of their own before a dot.
  const own = [`итог${String.fromCharCode(0xa0)}· без переноса`, 'второй'];
  for (const width of [20, 100]) {
    assert.equal(at([{ role: 'trust', indent: 0, text: own.join(' · '), parts: own }], width).map(line => line.trim()).join(' '), own.join(' · '), `${width}`);
  }
});

test('fitRows wraps without changing the text: a long word breaks with nothing inserted, and line breaks stay', () => {
  const quote = '«https://support.example.com/refunds/terminal-1234567890/confirm?operation=refund&id=42»';
  for (const width of [30, 40, 60]) {
    const lines = at([{ role: 'item', indent: 4, text: `Агент ответил   ${quote}`, hang: 16 }], width);
    assert.equal(lines[0], '     Агент ответил');
    // Every continuation hangs under the value, and the value reads back character for character.
    assert.ok(lines.slice(1).every(line => line.startsWith(' '.repeat(21)) && visibleWidth(line) <= width), lines.join('\n'));
    assert.equal(lines.slice(1).map(line => line.slice(21)).join(''), quote);
  }
  assert.deepEqual(at([{ role: 'quote', indent: 2, text: 'первая строка\nвторая строка\nтретья строка' }], 60), ['   первая строка', '   вторая строка', '   третья строка']);
});
