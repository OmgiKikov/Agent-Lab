import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyUsage, goalAttainment, replyQuality, settingsSchema, simulatorFidelity, type Experiment, type HumanReview, type MetricAssessment, type Trial } from '../src/contracts.js';
import { SPLIT_RATIONALE_PREFIX } from '../src/judge.js';
import { buildResultView, DISAGREEMENT_BOARD_TITLE, disagreementRows, SECTION_TEXT, type ResultView } from '../src/result-view.js';
import { GOOD_FROM, MIXED_FROM, nextStep, verdictBlockRows, verdictLevel, verdictLine, type VerdictRow } from '../src/verdict.js';
import { assertPlainCopy } from './helpers/copy-check.js';

/*
 * The verdict block of phase 4 (04-UI-SPEC V1, V2, B1, B2), pinned vector by vector. Every view is
 * built by `buildResultView` over a fixture record, so the block is tested on the same data the
 * surfaces see. Fixture titles are Russian because the copy scan treats record text as our copy.
 */

const world = { records: {}, writableFields: [], transientFailures: 0 };
type Card = Experiment['scenarios'][number];
type Result = MetricAssessment['result'];
const SPLIT = `${SPLIT_RATIONALE_PREFIX} pass / fail. Основания каждой оценки сохранены в judgeAudit.`;
const HEX_ID = '0123abcd-0000-4000-8000-000000000000';
const ID8 = '0123abcd';
const NO_FAILURES = 'Провалов не зарегистрировано. Это не гарантия качества в реальном трафике.';

function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id, familyId: id, title: `Ситуация ${id}`, requirementIds: [], provenance: 'production', tier: 'regression', goalObservation: 'reply',
    user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 3 }, initialState: world, checks: [],
    metrics: [{ ...goalAttainment }, { ...replyQuality }, { ...simulatorFidelity }], split: 'dev', ...overrides,
  };
}
const vote = (metricId: string, result: Result, rationale = 'Обоснование.'): MetricAssessment =>
  ({ metricId, result, rationale, evidence: result === 'unknown' ? [] : [1] });
function attempt(scenarioId: string, options: { goal?: Result; goalRationale?: string } & Partial<Trial> = {}): Trial {
  const { goal = 'pass', goalRationale, ...overrides } = options;
  return {
    id: `t-${scenarioId}`, revisionId: 'rev', scenarioId, familyId: scenarioId, repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: 'h',
    outcome: 'ungraded', reason: 'Диалог дошёл до конца.', checks: [],
    events: [{ seq: 0, type: 'user', text: 'Здравствуйте' }, { seq: 1, type: 'assistant', text: 'Ответ агента' }, { seq: 2, type: 'simulator', result: { message: '', done: true } }],
    initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 1,
    assessments: [vote('goal_attainment', goal, goalRationale), vote('reply_quality', 'pass'), vote('user_fidelity', 'pass')],
    ...overrides,
  };
}
function run(cards: Card[], trials: Trial[], overrides: Partial<Experiment> = {}): Experiment {
  return {
    schemaVersion: '1', id: HEX_ID, task: 't', mode: 'live', workflow: 'evaluate', createdAt: 'now', updatedAt: 'now', phase: 'results_review', message: '',
    sources: [], settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }),
    target: { kind: 'command', command: 'python3', args: ['agent.py'], timeoutMs: 60000 },
    requirements: [], questions: [], goldenCases: [], dialogues: [], profiles: [], notes: '', scenarios: cards, revisions: [], selectedRevisionId: null,
    manifestHash: 'h', reviewedAt: null, reviewMode: 'human', controlConsumedAt: null, acceptedTests: [], trials, comparisons: [], iterations: [],
    usage: emptyUsage(), error: null, limitations: [], humanReviews: [], ...overrides,
  };
}
/** `passed` + `failed` decided situations, `unmeasured` with a split goal vote, `pending` cards without a dialogue yet. */
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
/** Every decided situation of the record marked «согласен», except the trial ids in `skip`; `unsure` trial ids get «не могу сказать». */
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
const view = (record: Experiment) => buildResultView(record);
const texts = (rows: VerdictRow[]) => rows.map(row => row.text);
const chat = (record: Experiment) => nextStep(view(record), { runId: HEX_ID, surface: 'chat' });
const board = (record: Experiment) => nextStep(view(record), { runId: HEX_ID, surface: 'board' });
const collapsed = (v: ResultView) => verdictBlockRows(v, { expanded: false, runId: HEX_ID, surface: 'chat' });
const boardCollapsed = (v: ResultView) => verdictBlockRows(v, { expanded: false, runId: HEX_ID, surface: 'board' });
const expanded = (v: ResultView) => verdictBlockRows(v, { expanded: true, runId: HEX_ID, surface: 'chat' });

/** One passed and three failed situations with recorded clusters of 3, 1 and 1 failed situations. */
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

const PHASE4_FORBIDDEN: RegExp[] = [/\bRAG\b/, /\bdetails\b/, /\bview\b/, /\bkind\b/, /\bpartial\b/, /\bETA\b/, /токен/i, /статус/i, /рендер/i, /карточк/i];
/** The phase-2/3 scan plus the phase-4 words, no cut marker and no numbered «раздел». */
function assertPhase4Copy(text: string, label: string): void {
  assertPlainCopy(text, label);
  for (const word of PHASE4_FORBIDDEN) assert.doesNotMatch(text, word, `${label}: «${text}»`);
  assert.ok(!text.includes('…'), `${label}: обрезка в «${text}»`);
  assert.doesNotMatch(text, /раздел \d/, `${label}: «${text}»`);
}

// ---- V1 ----

test('V1: the ten locked vectors read exactly as the UI-SPEC table, with the tone of each rule', () => {
  assert.equal(GOOD_FROM, 80);
  assert.equal(MIXED_FROM, 50);
  const vectors: [Experiment, string, 'good' | 'warn' | 'bad'][] = [
    [scored(12, 3), 'Точность 80% · агент справляется хорошо: 12 из 15 ситуаций (мало данных)', 'good'],
    [scored(39, 10), 'Точность 80% · агент справляется хорошо: 39 из 49 ситуаций', 'good'],
    [scored(10, 10), 'Точность 50% · агент справляется с ошибками: 10 из 20 ситуаций', 'warn'],
    [scored(9, 4), 'Точность 69% · агент справляется с ошибками: 9 из 13 ситуаций (мало данных)', 'warn'],
    [scored(0, 9), 'Точность 0% · агент справляется плохо: 0 из 9 ситуаций (мало данных)', 'bad'],
    [scored(1, 0), 'Точность 100% · агент справляется хорошо: 1 из 1 ситуации (мало данных)', 'good'],
    [scored(21, 0), 'Точность 100% · агент справляется хорошо: 21 из 21 ситуации', 'good'],
    [scored(0, 0, { unmeasured: 2 }), 'Проверенных ситуаций нет', 'warn'],
    [scored(0, 10, { control: 'unknown' }), 'Числу пока не верить: контроль не измерен', 'bad'],
    [scored(5, 2, { control: 'fail' }), 'Числу пока не верить: контроль не пройден', 'bad'],
  ];
  for (const [record, expected, level] of vectors) {
    const v = view(record);
    assert.equal(verdictLine(v), expected);
    assert.equal(verdictLevel(v), level, expected);
  }
  // 39/49 is 79.6%: the headline prints «80%», so the word is «хорошо» next to it, never «с ошибками».
  assert.equal(view(scored(39, 10)).headline.text, 'Справился в 39 из 49 проверенных ситуаций — 80%.');
  // Both control words when one control failed and another was not measured.
  assert.equal(verdictLine(view(scored(5, 2, { control: ['fail', 'unknown'] }))), 'Числу пока не верить: контроль не пройден или не измерен');
  assert.equal(verdictLine(view(scored(5, 2, { control: 'pass' }))), 'Точность 71% · агент справляется с ошибками: 5 из 7 ситуаций (мало данных)', 'a passing control changes nothing');
  assert.ok(vectors.every(([, text]) => !text.endsWith('.')), 'a title row has no trailing period');
});

// ---- V2 ----

test('V2: the ten vectors pick the locked rule, in the order control → running → queue → number', () => {
  // 10/20, 3 failures unmarked → 2a.
  const three = scored(10, 10);
  assert.equal(chat(marked(three, { skip: ['t-f0', 't-f1', 't-f2'] })), `Дальше: попросите показать первый провал. Согласие с судьёй отмечается в /agent-lab ${ID8}.`);
  assert.equal(board(marked(three, { skip: ['t-f0', 't-f1', 't-f2'] })), 'Дальше: откройте вкладку «Провалы» и отметьте согласие с провалами.');
  // 0/9, all 9 unmarked → 2a.
  assert.equal(chat(scored(0, 9)), `Дальше: попросите показать первый провал. Согласие с судьёй отмечается в /agent-lab ${ID8}.`);
  // 3/4 with 11 dialogues still to come → 0.
  assert.equal(chat(scored(3, 1, { pending: 11 })), 'Дальше: дождитесь конца прогона.');
  assert.equal(view(scored(3, 1, { pending: 11 })).pending, 11);
  // …and a failed control while it runs → 1 wins over 0.
  assert.equal(chat(scored(3, 1, { pending: 11, control: 'fail' })), 'Дальше: проверьте судью и связь с агентом.');
  // 0/10, an unmeasured control, 5 unmarked → 1 wins over 2a.
  const unmeasuredControl = scored(0, 10, { control: 'unknown' });
  assert.equal(chat(marked(unmeasuredControl, { skip: ['t-f0', 't-f1', 't-f2', 't-f3', 't-f4'] })), 'Дальше: проверьте судью и связь с агентом.');
  assert.equal(board(unmeasuredControl), 'Дальше: проверьте судью и связь с агентом.');
  // 0/0 → 3, with the board variant naming the tab.
  assert.equal(chat(scored(0, 0, { unmeasured: 2 })), 'Дальше: спросите, почему ситуации не измерены.');
  assert.equal(board(scored(0, 0, { unmeasured: 2 })), 'Дальше: откройте вкладку «Диалоги» и посмотрите, почему ситуации не измерены.');
  // 12/15, everything marked agree or disagree → 4.
  assert.equal(chat(marked(scored(12, 3), { disagree: ['t-f0'] })), 'Дальше: повторите прогон после исправления агента.');
  assert.equal(board(marked(scored(12, 3))), 'Дальше: повторите прогон после исправления агента.');
  // 21/21, all marked → 5.
  assert.equal(chat(marked(scored(21, 0))), 'Дальше: выгрузите отчёт для заказчика.');
  assert.equal(board(marked(scored(21, 0))), 'Дальше: выгрузите отчёт для заказчика.');
});

test('V2 rule 2b: only sampled passes unmarked names the judge, not the failures', () => {
  const record = scored(13, 0);
  const sampled = view(record).agreement.sampledPasses;
  assert.equal(sampled.length, 3, 'three passes are drawn for the double-check');
  const twoLeft = marked(record, { skip: sampled.slice(0, 2) });
  assert.deepEqual(view(twoLeft).agreement.unmarked, sampled.slice(0, 2));
  assert.equal(chat(twoLeft), `Дальше: попросите показать успехи, выбранные для перепроверки. Согласие с судьёй отмечается в /agent-lab ${ID8}.`);
  assert.equal(board(twoLeft), 'Дальше: откройте вкладку «Провалы» и отметьте согласие с судьёй.');
  // A failure left unmarked next to them makes it 2a again.
  const failures = scored(13, 1);
  const sampledToo = view(failures).agreement.sampledPasses;
  assert.equal(chat(marked(failures, { skip: [...sampledToo.slice(0, 1), 't-f0'] })), `Дальше: попросите показать первый провал. Согласие с судьёй отмечается в /agent-lab ${ID8}.`);
});

test('V2 rule 2c: «не могу сказать» marks are counted in the dative and never treated as done', () => {
  const two = marked(scored(12, 3), { unsure: ['t-f0', 't-f1'] });
  assert.deepEqual(view(two).agreement.unmarked, [], 'an unsure mark is a current mark: nothing is unmarked');
  assert.equal(view(two).agreement.unsure, 2);
  assert.equal(chat(two), `Дальше: решите по 2 ситуациям, согласны ли вы с судьёй: попросите показать их. Согласие с судьёй отмечается в /agent-lab ${ID8}.`);
  assert.equal(board(two), 'Дальше: на вкладке «Провалы» решите по 2 ситуациям: y или n.');
  const one = marked(scored(12, 3), { unsure: ['t-f2'] });
  assert.equal(chat(one), `Дальше: решите по 1 ситуации, согласны ли вы с судьёй: попросите показать их. Согласие с судьёй отмечается в /agent-lab ${ID8}.`);
  assert.equal(board(one), 'Дальше: на вкладке «Провалы» решите по 1 ситуации: y или n.');
  const five = marked(scored(12, 5), { unsure: ['t-f0', 't-f1', 't-f2', 't-f3', 't-f4'] });
  assert.equal(chat(five), `Дальше: решите по 5 ситуациям, согласны ли вы с судьёй: попросите показать их. Согласие с судьёй отмечается в /agent-lab ${ID8}.`);
  // An unmarked failure still comes first (2a before 2c).
  assert.equal(chat(marked(scored(12, 3), { unsure: ['t-f0'], skip: ['t-f1'] })), `Дальше: попросите показать первый провал. Согласие с судьёй отмечается в /agent-lab ${ID8}.`);
  // A stale unsure mark (the judgment moved under it) is not K: the situation is unmarked again.
  const stale = marked(scored(12, 3), { unsure: ['t-f0'] });
  stale.humanReviews = stale.humanReviews.map(item => item.trialId === 't-f0' ? { ...item, judgeVerdict: 'pass' as const } : item);
  assert.equal(view(stale).agreement.stale, 1);
  assert.equal(chat(stale), `Дальше: попросите показать первый провал. Согласие с судьёй отмечается в /agent-lab ${ID8}.`);
});

// ---- B1 ----

test('B1: the collapsed chat block is V1 with the accuracy, the first block without «?» rows, every main cause with its explanation, then «Дальше»', () => {
  const record = marked(clustered(), { skip: ['t-f2'] });
  record.scenarios.push(card('u0', { title: 'Чек не пришёл' }));
  record.trials.push(attempt('u0', { goal: 'unknown', goalRationale: SPLIT }));
  const v = view(record);
  const rows = collapsed(v);
  const heading = rows.findIndex(row => row.role === 'heading');
  assert.deepEqual(texts(rows).slice(0, heading + 1), [
    'Точность 25% · агент справляется плохо: 1 из 4 ситуаций (мало данных)',
    'Справился в 1 из 4 проверенных ситуаций — 25%.',
    'Правил промпта в наборе нет — считается только запрос.',
    'Мало данных: реальная доля где-то от 5% до 70%.',
    'Не измерено: 1 — судья не уверен: голоса разошлись.',
    'Контроль: не задан.',
    'Согласие с судьёй: 3 из 3 проверенных · мало проверок (провалы: 2 из 2 · успехи: 1 из 1).',
    'Цель — согласие в 9 случаях из 10.',
    '',
    'ГЛАВНЫЕ ПРИЧИНЫ ПРОВАЛОВ',
  ]);
  // The end of a run explains itself: every main cause carries what was expected, what the agent said and the owner rule.
  const full = expanded(v);
  const causesOf = (block: typeof rows) => { const from = block.findIndex(row => row.role === 'heading'); return block.slice(from, block.findIndex((row, i) => i > from && row.role !== 'blank' && !['cause', 'example', 'expected', 'said', 'rule', 'more', 'violated', 'unverified'].includes(row.role))); };
  assert.deepEqual(causesOf(rows), causesOf(full), 'the chat block shows the same explained causes without a key press');
  assert.deepEqual(texts(rows).filter(text => /^\d\. /.test(text)), ['1. Не называет срок возврата — 3 ситуации', '2. Не уточняет модель терминала — 1 ситуация', '3. Отвечает вне инструкций — 1 ситуация']);
  assert.ok(rows.some(row => row.text.startsWith('Пример:')) && rows.some(row => row.text.startsWith('Должен был')), 'the explanation is in the block');
  assert.equal(texts(rows).at(-1), `Дальше: попросите показать первый провал. Согласие с судьёй отмечается в /agent-lab ${ID8}.`);
  assert.equal(rows.find(row => row.role === 'agreement-tail')?.indent, 2, 'the tail row keeps its phase-3 indent');
  assert.ok(rows.every(row => !row.text.startsWith('? ')), 'no per-situation row in the collapsed block');
  assert.ok(rows.every(row => row.role !== 'pointer'), 'the pointer waits for the expanded block');
  // The board keeps the short form: names only.
  assert.ok(boardCollapsed(v).every(row => !row.text.startsWith('Пример:')), 'no example in the collapsed board block');
  assert.equal(SECTION_TEXT.causes.board, 'ГЛАВНЫЕ ПРИЧИНЫ ПРОВАЛОВ');
});

test('B1 row 4 variants: the first three «✗» titles without clusters, the no-failures sentence, nothing when nothing was decided', () => {
  const failures = boardCollapsed(view(scored(0, 16)));
  const heading = failures.findIndex(row => row.text === 'ПРОВАЛЫ');
  assert.ok(heading > 0);
  assert.deepEqual(texts(failures).slice(heading, heading + 4), ['ПРОВАЛЫ', '✗ Провал 1', '✗ Провал 2', '✗ Провал 3']);
  assert.equal(failures[heading + 4]?.role, 'blank');
  assert.equal(failures.at(-1)?.role, 'next');
  assert.ok(failures.every(row => !row.text.startsWith('Должен был')), 'title rows only on the board');
  const explained = collapsed(view(scored(0, 16)));
  assert.deepEqual(texts(explained).filter(text => text.startsWith('✗ ')), ['✗ Провал 1', '✗ Провал 2', '✗ Провал 3'], 'the chat block explains the first three failures, not all sixteen');
  assert.ok(explained.some(row => row.text.startsWith('Должен был')), 'each of them says what was expected');

  const clean = collapsed(view(marked(scored(3, 0))));
  assert.deepEqual(texts(clean).slice(-3), [NO_FAILURES, '', 'Дальше: выгрузите отчёт для заказчика.']);
  assert.equal(clean.find(row => row.text === NO_FAILURES)?.role, 'no-failures');
  // With a control warning the warning row keeps its alarm role right under V1.
  const alarmed = collapsed(view(scored(3, 0, { control: 'fail' })));
  assert.deepEqual(alarmed.slice(0, 2).map(row => row.role), ['verdict:bad', 'alarm']);

  const nothing = collapsed(view(scored(0, 0, { unmeasured: 2 })));
  assert.deepEqual(texts(nothing), [
    'Проверенных ситуаций нет',
    'Проверенных ситуаций нет.',
    'Не измерено: 2 — судья не уверен: голоса разошлись.',
    'Контроль: не задан.',
    '',
    'Дальше: спросите, почему ситуации не измерены.',
  ]);
  for (const rows of [failures, clean, alarmed, nothing]) {
    for (let i = 1; i < rows.length; i++) assert.ok(!(rows[i]!.role === 'blank' && rows[i - 1]!.role === 'blank'), 'no double blank rows');
    assert.notEqual(rows[0]!.role, 'blank'); assert.notEqual(rows.at(-1)!.role, 'blank');
  }
});

// ---- B2 ----

test('B2: the expanded block adds the «?» rows, the full causes, the pointer, then «Дальше»', () => {
  const record = marked(clustered());
  record.scenarios.push(card('u0', { title: 'Чек не пришёл' }));
  record.trials.push(attempt('u0', { goal: 'unknown', goalRationale: SPLIT }));
  const v = view(record);
  const rows = expanded(v);
  const lines = texts(rows);
  const detail = (indent: number) => ['Должен был: ожидание не записано в ситуации.', 'Сказал (реплика #1): «Ответ агента»', 'Правило: у ситуации нет правила из ваших материалов.'].map(text => ({ indent, text }));
  assert.deepEqual(rows.map(row => ({ indent: row.indent, text: row.text })), [
    { indent: 0, text: 'Точность 25% · агент справляется плохо: 1 из 4 ситуаций (мало данных)' },
    { indent: 0, text: 'Справился в 1 из 4 проверенных ситуаций — 25%.' },
    { indent: 0, text: 'Правил промпта в наборе нет — считается только запрос.' },
    { indent: 0, text: 'Мало данных: реальная доля где-то от 5% до 70%.' },
    { indent: 0, text: 'Не измерено: 1 — судья не уверен: голоса разошлись.' },
    { indent: 2, text: '? Чек не пришёл — судья не уверен: голоса разошлись' },
    { indent: 0, text: 'Контроль: не задан.' },
    { indent: 0, text: 'Согласие с судьёй: 4 из 4 проверенных · мало проверок (провалы: 3 из 3 · успехи: 1 из 1).' },
    { indent: 2, text: 'Цель — согласие в 9 случаях из 10.' },
    { indent: 0, text: '' },
    { indent: 0, text: 'ГЛАВНЫЕ ПРИЧИНЫ ПРОВАЛОВ' },
    { indent: 0, text: '1. Не называет срок возврата — 3 ситуации' },
    { indent: 3, text: 'Пример: Провал 1' },
    ...detail(5),
    { indent: 0, text: '' },
    { indent: 0, text: '2. Не уточняет модель терминала — 1 ситуация' },
    { indent: 3, text: 'Пример: Провал 2' },
    ...detail(5),
    { indent: 0, text: '' },
    { indent: 0, text: '3. Отвечает вне инструкций — 1 ситуация' },
    { indent: 3, text: 'Пример: Провал 3' },
    ...detail(5),
    { indent: 0, text: '' },
    { indent: 0, text: `Любой провал можно открыть здесь: попросите показать его по номеру. Доска со всеми провалами — /agent-lab ${ID8}.` },
    { indent: 0, text: '' },
    { indent: 0, text: 'Дальше: повторите прогон после исправления агента.' },
  ]);
  assert.equal(rows.find(row => row.text.startsWith('Любой провал'))?.role, 'pointer');
  assert.deepEqual(rows.filter(row => row.text.startsWith('Пример:')).map(row => row.role), ['example', 'example', 'example']);
  assert.ok(!lines.some(line => /раздел \d/.test(line)), 'the old «раздел 1» pointer is never printed in the block');
  for (let i = 1; i < rows.length; i++) assert.ok(!(rows[i]!.role === 'blank' && rows[i - 1]!.role === 'blank'), 'no double blank rows');
});

test('B2: the disagreements sit under their heading between the causes and the pointer, only when the owner overturned something', () => {
  // A «не согласен» mark overturns the judge, so the headline moves too; the F7 rows are read from result-view, not retyped.
  const v = view(marked(scored(2, 2), { disagree: ['t-f1'] }));
  assert.equal(v.agreement.disagreements.length, 1);
  const rows = expanded(v);
  const lines = texts(rows);
  const at = lines.indexOf(DISAGREEMENT_BOARD_TITLE);
  assert.ok(at > 0, 'the F7 heading is printed');
  assert.equal(rows[at]?.role, 'heading');
  assert.equal(rows[at - 1]?.role, 'blank');
  const f7 = disagreementRows(v);
  assert.ok(f7.length === 3);
  assert.deepEqual(rows.slice(at + 1, at + 1 + f7.length).map(row => ({ role: row.role, indent: row.indent, text: row.text })), f7);
  assert.deepEqual(lines.slice(at + 1 + f7.length), ['', `Любой провал можно открыть здесь: попросите показать его по номеру. Доска со всеми провалами — /agent-lab ${ID8}.`, '', 'Дальше: повторите прогон после исправления агента.']);
  // The causes come before the disagreements.
  assert.ok(lines.indexOf('ПРОВАЛЫ') < at);
  // The collapsed block never shows F7.
  assert.ok(!texts(collapsed(v)).includes(DISAGREEMENT_BOARD_TITLE));
});

test('B2 without disagreements or failures prints neither section, and the pointer only when something failed', () => {
  const noDisagreement = expanded(view(marked(clustered())));
  assert.ok(!texts(noDisagreement).includes(DISAGREEMENT_BOARD_TITLE));
  assert.ok(texts(noDisagreement).includes(`Любой провал можно открыть здесь: попросите показать его по номеру. Доска со всеми провалами — /agent-lab ${ID8}.`));
  const clean = expanded(view(marked(scored(3, 0))));
  assert.ok(!texts(clean).some(line => line.startsWith('Любой провал') || line.startsWith('Все провалы')));
  assert.ok(!texts(clean).includes(DISAGREEMENT_BOARD_TITLE));
  assert.deepEqual(texts(clean).slice(-3), [NO_FAILURES, '', 'Дальше: выгрузите отчёт для заказчика.']);
  // The unmeasured detail rows of the first block appear only when expanded.
  const twoReasons = scored(2, 0, { unmeasured: 1 });
  twoReasons.scenarios.push(card('x0', { title: 'Тариф эквайринга' }));
  twoReasons.trials.push(attempt('x0', { goal: 'unknown', goalRationale: 'Нет доказательства.', assessments: [vote('goal_attainment', 'unknown', 'Нет доказательства.'), vote('reply_quality', 'pass'), vote('user_fidelity', 'fail')] }));
  const twoView = view(twoReasons);
  assert.equal(twoView.notMeasured.reasons.length, 2, 'two different reasons');
  assert.ok(texts(expanded(twoView)).includes('Не измерено по причинам:'));
  assert.ok(!texts(collapsed(twoView)).includes('Не измерено по причинам:'));
});

// ---- Copy ----

test('every verdict, next step and block row is plain Russian without the phase-4 words, «…» or a numbered раздел', () => {
  const records: [string, Experiment][] = [
    ['12/15', scored(12, 3)], ['39/49', scored(39, 10)], ['10/20', scored(10, 10)], ['0/9', scored(0, 9)], ['1/1', scored(1, 0)],
    ['0/0', scored(0, 0, { unmeasured: 2 })], ['контроль не измерен', scored(0, 10, { control: 'unknown' })], ['контроль не пройден', scored(5, 2, { control: 'fail' })],
    ['оба контроля', scored(5, 2, { control: ['fail', 'unknown'] })], ['идёт', scored(3, 1, { pending: 11 })],
    ['всё отмечено', marked(scored(12, 3), { disagree: ['t-f0'] })], ['всё хорошо', marked(scored(21, 0))], ['не могу сказать', marked(scored(12, 3), { unsure: ['t-f0', 't-f1'] })],
    ['кластеры', marked(clustered(), { disagree: ['t-f2'] })], ['без кластеров', scored(0, 16)], ['без провалов', marked(scored(3, 0))],
  ];
  for (const [label, record] of records) {
    const v = view(record);
    assertPhase4Copy(verdictLine(v), `V1 ${label}`);
    for (const surface of ['chat', 'board'] as const) assertPhase4Copy(nextStep(v, { runId: HEX_ID, surface }), `V2 ${surface} ${label}`);
    for (const row of [...collapsed(v), ...expanded(v)]) assertPhase4Copy(row.text, `блок ${label}`);
  }
});
