import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth, stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui';
import { LabBoard, resultEntries, reviewOrder, safeText, wrapRows, type BoardAction, type BoardOptions } from '../extensions/cards.ts';
// Phase-3 chrome (F11, footer tiers) is read through the namespace, so a missing export fails an assertion, not the module link.
import * as cards from '../extensions/cards.ts';
import { agreementSample, judgeAgreement } from '../src/agreement.js';
import { primaryMetricId } from '../src/outcomes.js';
import { demoEvaluateRecord } from './helpers/demo-record.js';
import { assertPlainCopy } from './helpers/copy-check.js';
import { rm } from 'node:fs/promises';
import { htmlReport } from '../src/report.js';
import { createDemoRuntime, demoInput } from '../src/demo.js';
import { emptyUsage, fingerprint, type Experiment } from '../src/contracts.js';
import { compareRuns } from '../src/comparison.js';
import { evidenceBundle } from '../src/artifacts.js';
import { markdownReport } from '../src/report.js';
import { buildResultView, causeSection, failureListRows, resultViewLines, SECTION_TEXT, type ResultView } from '../src/result-view.js';
import { expectationSheet } from '../src/quality.js';

const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value };

test('a quick agreement mark includes time spent reading the selected dialogue', async () => {
  const record = await judgedFixture('timed', 'fail');
  let action: BoardAction | undefined;
  const reviewTimes = new Map([[`${record.id}|timed`, 100]]);
  const board = new LabBoard({ record, section: 'results', reviewTimes }, theme, value => { action = value; }, () => {});
  board.render(120);
  await new Promise(resolve => setTimeout(resolve, 20));
  board.handleInput('n');
  assert.equal(action?.type, 'agree');
  if (action?.type === 'agree') {
    assert.equal(action.answer, 'disagree');
    assert.equal(action.trialId, 'timed');
    assert.equal(action.metricId, 'goal');
    assert.equal(action.judgeVerdict, 'fail');
    assert.ok(action.reviewMs! >= 115);
  }
});

test('coincident replies with different scores are visible in Pi and exported reports', async () => {
  const before = await fixture();
  before.id = 'before'; before.phase = 'results_review';
  before.settings.userModes = ['reactive']; before.settings.repeats = 1;
  before.scenarios = [before.scenarios[0]!];
  const card = before.scenarios[0]!;
  card.checks = [];
  card.metrics = [{ id: 'goal', name: 'Goal', subject: 'agent', description: 'd', passCriteria: 'p', failCriteria: 'f' }];
  before.trials = [{ id: 'before_trial', revisionId: 'revision-1', scenarioId: card.id, familyId: card.familyId,
    repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: 'hash', outcome: 'ungraded', reason: '', checks: [],
    events: [{ seq: 0, type: 'assistant', text: 'The same instruction.' }], initialState: card.initialState, finalState: card.initialState,
    elapsedMs: 1, usage: emptyUsage(), assessments: [{ metricId: 'goal', result: 'fail', rationale: 'r', evidence: [0] }] }];
  const after = structuredClone(before); after.id = 'after'; after.parentRunId = before.id;
  after.trials[0]!.id = 'after_trial'; after.trials[0]!.assessments![0]!.result = 'pass';
  const bundle = await evidenceBundle(after, { get: async () => before, traceJournal: async () => '' });
  const board = new LabBoard({ record: after, before, comparison: bundle.comparison, section: 'agent' }, theme, () => {}, () => {}, () => 40);
  try {
    const overview = board.render(120).join('\n');
    assert.match(overview, /Общих оценённых карточек нет/);
    assert.match(overview, /совпавшими ответами.*1/is);
    assert.doesNotMatch(overview, /Исправлено 1/);
    for (const text of [htmlReport(bundle), markdownReport(bundle)]) {
      assert.match(text, /Ответы агента совпали/);
      assert.doesNotMatch(text, /Исправлено 1/);
    }
  } finally { board.dispose(); }
});

test('a confirmed draft says the owner confirmed the expectations, never that a human checked the cards', async () => {
  const record = await fixture();
  record.phase = 'results_review'; record.reviewedAt = '2026-09-17T00:00:00.000Z'; record.reviewMode = 'expectations';
  const bundle = await evidenceBundle(record, { get: async () => record, traceJournal: async () => '' });
  const markdown = markdownReport(bundle);
  assert.match(markdown, /Проверка карточек: ожидания подтверждены владельцем\./);
  assert.doesNotMatch(markdown, /Проверка карточек: человеком/);

  const board = new LabBoard({ record, section: 'agent' }, theme, () => {}, () => {}, () => 120);
  const text = stripTerminalSequences(board.render(120).join('\n'));
  assert.match(text, /Карточки: ожидания подтверждены владельцем/);
  assert.doesNotMatch(text, /Карточки: подтверждены человеком/);
  board.dispose();

  // A person who really reviewed the card definitions still gets the stronger word.
  const reviewed = new LabBoard({ record: { ...record, reviewMode: 'human' }, section: 'agent' }, theme, () => {}, () => {}, () => 120);
  assert.match(stripTerminalSequences(reviewed.render(120).join('\n')), /Карточки: подтверждены человеком/);
  reviewed.dispose();
});

test('an unverified reply is a status line in the exported report, never a quotation', async () => {
  const record = await fixture();
  record.phase = 'results_review';
  record.scenarios = [record.scenarios[0]!];
  const card = record.scenarios[0]!;
  card.checks = [];
  card.metrics = [{ id: 'goal', name: 'Goal', subject: 'agent', description: 'd', passCriteria: 'p', failCriteria: 'f' }];
  // The judge cites words the stored reply does not contain, so the record cannot show what the agent said.
  record.trials = [{ id: 'unverified_trial', revisionId: 'revision-1', scenarioId: card.id, familyId: card.familyId,
    repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: 'hash', outcome: 'ungraded', reason: '', checks: [],
    events: [{ seq: 0, type: 'user', text: 'Вопрос' }, { seq: 1, type: 'assistant', text: 'Ответ агента.' }],
    initialState: card.initialState, finalState: card.initialState, elapsedMs: 1, usage: emptyUsage(),
    assessments: [{ metricId: 'goal', result: 'fail', rationale: 'Обоснование судьи.', evidence: [1],
      citations: [{ seq: 1, quote: 'этих слов в ответе нет' }] }] }];
  record.failureModes = [{ id: 'cluster', name: 'Причина', description: 'Описание.', trialIds: ['unverified_trial'] }];
  record.settings.userModes = ['reactive']; record.settings.repeats = 1;

  const bundle = await evidenceBundle(record, { get: async () => record, traceJournal: async () => '' });
  const html = htmlReport(record);
  const markdown = markdownReport(bundle);
  const whyHtml = html.match(/<section id="why">[\s\S]*?<\/section>/)?.[0] ?? '';
  const whyMarkdown = markdown.split('### Почему не справился')[1]?.split('\n###')[0] ?? '';
  for (const why of [whyHtml, markdown && whyMarkdown]) {
    assert.ok(why, 'the cause list is exported');
    assert.match(why, /реплика агента не подтверждена цитатой/);
    // The customer reads this list first: quoting the sentinel would say the agent uttered it.
    assert.doesNotMatch(why, /«реплика агента не подтверждена цитатой»/);
    assert.doesNotMatch(why, /Обоснование судьи/, 'the judge rationale is never the cause quote');
  }
});

async function fixture(): Promise<Experiment> {
  const input = demoInput();
  const sources = input.materials.map((m, i) => ({ ...m, id: `source-${i + 1}`, hash: fingerprint(m.content) }));
  const prepared = await createDemoRuntime().prepare({ task: input.task, sources, workflow: 'evaluate', scenarioCount: 2 }, {
    signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {},
  });
  return {
    schemaVersion: '1', id: 'cards-test', task: input.task, mode: 'demo', workflow: 'evaluate',
    createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z', phase: 'review', message: 'Карточки готовы.',
    sources, settings: input.settings, requirements: prepared.requirements, questions: [],
    scenarios: prepared.scenarios.map(s => ({ ...s, split: 'dev' })),
    revisions: [{ id: 'revision-1', spec: prepared.agent, parentId: null, hypothesis: '', createdAt: '2026-09-08' }],
    selectedRevisionId: 'revision-1', manifestHash: null, reviewedAt: null, reviewMode: null, controlConsumedAt: null,
    trials: [], comparisons: [], iterations: [], usage: emptyUsage(), error: null, limitations: [], humanReviews: [], target: { kind: 'sandbox' }, goldenCases: [], dialogues: [], profiles: [],
  };
}

/**
 * A finished evaluation whose only situation carries one recorded judge verdict on its main
 * question — the shape the agreement keys need (UI-SPEC F10: «главная оценка ситуации»).
 */
async function judgedFixture(trialId: string, result: 'pass' | 'fail'): Promise<Experiment> {
  const record = await fixture();
  record.phase = 'results_review'; record.reviewedAt = new Date().toISOString();
  const scenario = record.scenarios[0]!;
  scenario.metrics = [{ id: 'goal', name: 'Цель достигнута', subject: 'agent', description: 'Клиент получил то, что просил', passCriteria: 'Получил', failCriteria: 'Не получил' }];
  record.trials = [{ id: trialId, revisionId: 'revision-1', scenarioId: scenario.id, familyId: scenario.familyId,
    repeat: 0, userMode: 'static', split: 'dev', manifestHash: 'hash', outcome: result, reason: '',
    checks: [{ id: 'time', description: 'Запись переставлена', passed: result === 'pass', evidence: 'e' }],
    events: [{ seq: 0, type: 'assistant', text: 'Recorded answer' }], initialState: scenario.initialState,
    finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 10,
    assessments: [{ metricId: 'goal', result, rationale: 'Обоснование судьи', evidence: [0] }] }];
  return record;
}

test('80×24 shows the opening and first reply before metadata, with visible feedback and scroll position', async () => {
  const record = await fixture();
  const scenario = record.scenarios[0]!;
  scenario.title = 'Перенос записи'; scenario.user.opening = 'Перенесите запись на 14:00.';
  scenario.user.goal = 'Изменить время записи'; scenario.successCriteria = 'Время изменилось на 14:00.';
  const cards = new LabBoard({ record, notice: { kind: 'info', message: 'Изменена 1 карточка, остальные сохранены.' } }, theme, () => {}, () => {}, () => 24);
  // Раздел 2 черновика открывается листом ожиданий; первая реплика и остальная карточка — по Enter.
  assert.match(cards.render(80).join('\n'), /Ситуация: Изменить время записи/);
  cards.handleInput('\r');
  const cardText = cards.render(80).join('\n');
  assert.match(cardText, /Перенесите запись на 14:00/);
  assert.match(cardText, /Изменена 1 карточка/);
  cards.dispose();
  record.phase = 'results_review';
  record.trials = [{ id: 'readable', revisionId: 'revision-1', scenarioId: scenario.id, familyId: scenario.familyId,
    repeat: 0, userMode: 'static', split: 'dev', manifestHash: 'hash', outcome: 'ungraded', reason: 'Оценено по рубрикам.',
    checks: [], events: [{ seq: 0, type: 'user', text: scenario.user.opening }, { seq: 1, type: 'assistant', text: 'Запись перенесена на 14:00.' }],
    initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 20 }];
  const results = new LabBoard({ record, section: 'results' }, theme, () => {}, () => {}, () => 24);
  const text = results.render(80).join('\n');
  assert.match(text, /Перенесите запись на 14:00/);
  assert.match(text, /Запись перенесена на 14:00/);
  assert.match(text, /ПО РУБРИКАМ/);
  assert.match(text, /\d+–\d+\/\d+/);
  results.dispose();
  record.phase = 'evaluating'; record.trials = []; record.message = 'Карточка 1/2: ждём ответ агента';
  const running = new LabBoard({ record, section: 'results' }, theme, () => {}, () => {}, () => 24);
  assert.match(running.render(80).join('\n'), /ДИАЛОГ ВЫПОЛНЯЕТСЯ/);
  assert.doesNotMatch(running.render(80).join('\n'), /Затем нажмите r|r для запуска/);
  running.dispose();
});

test('a finished repeat refreshes the comparison headline in the overview', async t => {
  const before = await fixture();
  before.id = 'before'; before.phase = 'results_review'; before.reviewedAt = before.createdAt;
  before.settings.repeats = 2;
  before.scenarios.forEach(s => { s.metrics = []; });
  before.trials = before.scenarios.flatMap((s, i) => [0, 1].map(repeat => ({
    id: `before-${i}-${repeat}`, revisionId: 'revision-1', scenarioId: s.id, familyId: s.familyId, repeat,
    userMode: 'reactive', split: 'dev', manifestHash: 'hash', outcome: i || repeat ? 'pass' : 'fail', reason: '',
    checks: s.checks.map((c, j) => ({ id: c.id, description: c.description, evidence: 'fixture', passed: i > 0 || repeat > 0 || j > 0 })),
    events: [{ seq: 0, type: 'assistant', text: 'Раньше не мог изменить запись.' }], initialState: s.initialState, finalState: s.initialState,
    elapsedMs: 1, usage: emptyUsage(),
  })));
  const after = structuredClone(before); after.id = 'after'; after.parentRunId = before.id;
  for (const trial of after.trials) {
    trial.id = trial.id.replace('before', 'after'); trial.outcome = 'pass';
    trial.checks.forEach(c => { c.passed = true; });
    trial.events[0]!.text = 'Теперь запись изменена.';
  }
  const running = { ...after, phase: 'evaluating' as const, trials: [] };
  let rendered!: () => void;
  const refreshed = new Promise<void>(resolve => { rendered = resolve; });
  const actions: BoardAction[] = [];
  const board = new LabBoard({ record: running, before, comparison: compareRuns(before, running), section: 'agent',
    warnings: ['Прогон ещё идёт.'], reportPath: '/fixture/partial.html', notice: { kind: 'info', message: 'Промежуточный отчёт сохранён.' },
    load: async () => ({ record: after, before, comparison: compareRuns(before, after), warnings: [] }) }, theme, a => actions.push(a), rendered, () => 40);
  let timer: ReturnType<typeof setTimeout>;
  t.after(() => { clearTimeout(timer); board.dispose(); });
  await Promise.race([refreshed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('board did not refresh')), 3000); })]);
  const text = board.render(120).join('\n');
  assert.match(text, /Исправлено 1, сломалось 0/);
  assert.match(text, /После исправления/);
  assert.doesNotMatch(text, /4 Статистика|5 Сравнение/);
  assert.doesNotMatch(text, /Прогон ещё идёт|Промежуточный отчёт|o Открыть отчёт/);
  board.handleInput('o');
  assert.deepEqual(actions, []);
});

test('native cards sanitize terminal escapes, preserve readable Unicode, and fit narrow or wide terminals', async () => {
  const record = await fixture();
  record.scenarios[0]!.title = '\x1b]52;c;malicious\x07\x1b[2JПерсона 👩🏽‍💻 中文 e\u0301 ' + 'длинный'.repeat(80);
  record.scenarios[0]!.user.persona = '\u202eРазворот\u2066\x00\x9bПолезный текст';
  const board = new LabBoard({ record }, theme, () => {}, () => {}, () => 36);
  for (const width of [1, 2, 5, 16, 40, 80, 132]) {
    const lines = board.render(width);
    assert.ok(lines.length <= 36);
    for (const value of lines) {
      assert.ok(visibleWidth(value) <= width, `overflow ${width}: ${value}`);
      assert.doesNotMatch(stripTerminalSequences(value), /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
      assert.doesNotMatch(value, /\x1b\]|\x1b\[2J/);
    }
  }
  assert.match(board.render(100).join('\n'), /Персона|ПОЛЬЗОВАТЕЛЬ/);
  assert.equal(safeText('\x1b]8;;https://invalid\x1b\\текст\x1b]8;;\x1b\\\n👩🏽‍💻'), 'текст\n👩🏽‍💻');
  board.dispose();
});

test('keyboard navigation exposes complete card details and only phase-appropriate human actions', async () => {
  const record = await fixture();
  const actions: BoardAction[] = [];
  const board = new LabBoard({ record }, theme, a => actions.push(a), () => {}, () => 28);
  board.handleInput('\r'); // Expand full source grounding and state.
  board.render(90);
  board.handleInput('\x1b[F'); // End, no content silently discarded.
  assert.match(board.render(90).join('\n'), /ТОЧНЫЕ ПРОВЕРКИ|state_equals|tool_called|answer_contains/);
  board.handleInput('r');
  assert.equal(actions[0]?.type, 'run');
  assert.equal(actions.length, 1);
  board.handleInput('r');
  assert.equal(actions.length, 1, 'disposed board cannot submit consent twice');

  for (const r of [{ ...record, workflow: 'compare' as const }, { ...record, questions: ['Уточнить правило'] }, { ...record, phase: 'complete' as const }]) {
    const forbidden: BoardAction[] = [];
    const blocked = new LabBoard({ record: r }, theme, a => forbidden.push(a), () => {});
    blocked.handleInput('r');
    assert.equal(forbidden.length, 0);
    blocked.dispose();
  }
});

test('result cards keep model grades, missing grades, traces and human annotations distinct', async () => {
  const record = await fixture();
  record.phase = 'results_review';
  const scenario = record.scenarios[0]!;
  scenario.metrics = [{ id: 'm1', name: 'Точность', subject: 'agent', description: 'Точность ответа', passCriteria: 'Верно', failCriteria: 'Ошибка' }, { id: 'm2', name: 'Реалистичность', subject: 'simulator', description: 'Естественность', passCriteria: 'Уместно', failCriteria: 'Невозможно' }];
  record.trials = [{ id: 'trial1', revisionId: 'revision-1', scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0, split: 'dev', manifestHash: 'hash', outcome: 'pass', reason: 'Objective pass only',
    checks: [], events: [{ seq: 0, type: 'user', text: 'Реплика пользователя' }, { seq: 1, type: 'assistant', text: 'Ответ агента' }], initialState: scenario.initialState, finalState: scenario.initialState, usage: { ...emptyUsage(), costUsd: null }, elapsedMs: 12,
    assessments: [{ metricId: 'm1', result: 'unknown', rationale: 'Недостаточно данных', evidence: [1] }] }];
  record.humanReviews = [{ id: 'h1', trialId: 'trial1', verdict: 'fail', note: 'Ошибка в реплике #1', createdAt: record.createdAt }];
  const board = new LabBoard({ record, section: 'results' }, theme, () => {}, () => {}, () => 120);
  const text = stripTerminalSequences(board.render(120).join('\n'));
  assert.match(text, /Агент · Точность: НЕЯСНО/);
  assert.match(text, /Симулятор · Реалистичность: НЕТ ОЦЕНКИ/);
  assert.match(text, /стоимость неизвестна/);
  assert.match(text, /ОТДЕЛЬНАЯ ПРОВЕРКА ЧЕЛОВЕКОМ/);
  assert.match(text, /СЦЕНАРНАЯ ОЦЕНКА ДЕМО/);
  assert.doesNotMatch(text, /ОЦЕНКА МОДЕЛЬЮ/);
  assert.match(text, /Ошибка в реплике #1/);
  assert.match(text, /#1  АГЕНТ/);
  assert.match(text, /Ответ агента/);
  board.dispose();
  scenario.checks = []; record.trials[0]!.outcome = 'ungraded';
  record.trials[0]!.assessments = [
    { metricId: 'm2', result: 'fail', rationale: 'SIMULATOR_FAILURE_SENTINEL', evidence: [0] },
    { metricId: 'm1', result: 'fail', rationale: 'AGENT_FAILURE_SENTINEL', evidence: [1] },
  ];
  const overview = new LabBoard({ record }, theme, () => {}, () => {}, () => 120);
  const overviewText = overview.render(120).join('\n');
  // The overview explains only decided failures, with verified text: no judge rationale reaches it.
  assert.doesNotMatch(overviewText, /AGENT_FAILURE_SENTINEL/); assert.doesNotMatch(overviewText, /SIMULATOR_FAILURE_SENTINEL/);
  assert.match(stripTerminalSequences(overviewText), /Не измерено: 2/); overview.dispose();
  const html = htmlReport(record);
  // The simulator rubric failed, so the agent grade is not a usable measurement yet: the first screen says «—», not 0%, and queues one dialogue for a human.
  assert.match(html, /Точность · судья, предварительно<\/h3><strong>—<\/strong>/); assert.match(html, /неясно 1/);
  assert.match(html, /Разметить человеку<\/h3><strong>1<\/strong>/); assert.match(html, /пометок симулятора 1/);
  assert.match(html, /Почему не справился/); assert.match(html, /AGENT_FAILURE_SENTINEL/);
  assert.doesNotMatch(html.match(/<section id="why">[\s\S]*?<\/section>/)?.[0] ?? '', /SIMULATOR_FAILURE_SENTINEL/);
  record.phase = 'complete'; record.resultsReviewedAt = record.updatedAt; record.humanReviews = [];
  const reviewed = new LabBoard({ record, section: 'results' }, theme, () => {}, () => {}, () => 120);
  // UI-SPEC F10: the judge decided the main question, so the agreement block carries the keys and
  // the «Вердикта человека нет» row is left out.
  assert.match(reviewed.render(120).join('\n'), /y — согласен · n — не согласен · s — не могу сказать/);
  assert.doesNotMatch(reviewed.render(120).join('\n'), /Вердикта человека нет/);
  assert.doesNotMatch(reviewed.render(120).join('\n'), /Набор проверен человеком|Разбор набора завершён/);
  reviewed.dispose();
});

test('разбор начинается с провалов без вердикта, счётчик их считает, согласие с судьёй ставится одной клавишей', async () => {
  const record = await fixture();
  record.phase = 'results_review';
  const scenario = record.scenarios[0]!;
  const trial = (id: string, outcome: 'pass' | 'fail') => ({
    id, revisionId: 'revision-1', scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0, split: 'dev' as const,
    manifestHash: 'hash', outcome, reason: outcome === 'pass' ? 'Все объективные проверки пройдены.' : 'Часть объективных проверок провалена.',
    checks: [{ id: 'time', description: 'Запись переставлена', passed: outcome === 'pass', evidence: 'e' }],
    events: [{ seq: 0, type: 'assistant' as const, text: 'Ответ агента' }], initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1,
    assessments: [{ metricId: 'demo_task_state', result: outcome, rationale: 'Обоснование судьи', evidence: [0] }],
  });
  // Порядок в записи нарочно неудобный: пройденный первым, провалы за ним.
  record.trials = [trial('t_pass', 'pass'), trial('t_done', 'fail'), trial('t_pending', 'fail')];
  record.humanReviews = [{ id: 'h1', trialId: 't_done', verdict: 'fail', note: 'разобрано', createdAt: record.createdAt }];

  const actions: BoardAction[] = [];
  const board = new LabBoard({ record, section: 'results' }, theme, a => actions.push(a), () => {}, () => 40);
  const text = stripTerminalSequences(board.render(120).join('\n'));
  // UI-SPEC F11: заголовок считает провалы и успехи очереди; вердикт по диалогу целиком — не отметка согласия.
  assert.ok(boardCells(board, 120).includes('Проверено провалов: 0 из 2 · успехов: 0 из 1'));
  assert.match(text, /Запись переставлена/, 'первым открыт тот диалог, который ждёт человека');
  // UI-SPEC F12: очередь согласия ведёт список. Вердикт по диалогу целиком у t_done — не отметка
  // согласия, поэтому провал остаётся неразобранным и стоит первым по порядку записи.
  assert.deepEqual(reviewOrder(record).map(t => t.id), ['t_done', 't_pending', 't_pass']);

  // UI-D-02: быстрая `p` в разделе результатов снята; вердикт по диалогу целиком остаётся на `v`.
  board.handleInput('p');
  assert.deepEqual(actions, []);
  board.handleInput('y');
  const agreed = actions[0];
  assert.equal(agreed?.type, 'agree');
  assert.equal(agreed.type === 'agree' && agreed.answer, 'agree');
  assert.equal(agreed.type === 'agree' && agreed.judgeVerdict, 'fail');
  assert.equal(agreed.type === 'agree' && agreed.metricId, 'demo_task_state');
  assert.equal(agreed.type === 'agree' && agreed.trialId, 't_done');
  assert.equal(agreed.type === 'agree' && reviewOrder(record)[agreed.selected]?.id, 't_done');
  board.dispose();

  const failing: BoardAction[] = [];
  const second = new LabBoard({ record, section: 'results' }, theme, a => failing.push(a), () => {}, () => 40);
  second.handleInput('n');
  assert.equal(failing[0]?.type === 'agree' && failing[0].answer, 'disagree');
  second.handleInput('s');
  assert.equal(failing.length, 1, 'закрытая доска второй ответ не отправляет');
  second.dispose();

  const unsure: BoardAction[] = [];
  const third = new LabBoard({ record, section: 'results' }, theme, a => unsure.push(a), () => {}, () => 40);
  third.handleInput('s');
  assert.equal(unsure[0]?.type === 'agree' && unsure[0].answer, 'unsure');
  third.dispose();

  // Пока диалоги идут, соглашаться не с чем.
  const running: BoardAction[] = [];
  const active = new LabBoard({ record: { ...record, phase: 'evaluating' }, section: 'results' }, theme, a => running.push(a), () => {}, () => 40);
  for (const key of ['y', 'n', 's', 'p']) active.handleInput(key);
  assert.deepEqual(running, []);
  active.dispose();

  const reviewed = { ...record, humanReviews: [...record.humanReviews, { id: 'h2', trialId: 't_pending', verdict: 'pass' as const, note: 'ok', createdAt: record.createdAt }] };
  // Замечания человека больше не стоят в заголовке раздела 3: там только ход проверки судьи.
  const reviewedCells = boardCells(new LabBoard({ record: reviewed, section: 'results' }, theme, () => {}, () => {}, () => 40), 120);
  assert.ok(reviewedCells.includes('Проверено провалов: 0 из 2 · успехов: 0 из 1'));
  assert.ok(!reviewedCells.some(cell => cell.startsWith('Замечания человека:')));
});

test('live polling stops on dispose and never applies a late response to a closed board', async () => {
  const record = await fixture();
  record.phase = 'evaluating';
  let loads = 0;
  let renders = 0;
  let resolveLoad!: (value: Awaited<ReturnType<NonNullable<BoardOptions['load']>>>) => void;
  const board = new LabBoard({ record, load: () => { loads++; return new Promise(resolve => { resolveLoad = resolve; }); } }, theme, () => {}, () => { renders++; });
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(loads, 1);
  board.dispose();
  resolveLoad({ record: { ...record, phase: 'results_review' }, warnings: [] });
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(loads, 1);
  assert.equal(renders, 0);
});

test('the board leads with a plain verdict once dialogues exist and has only three screens', async () => {
  const record = await fixture();
  record.phase = 'results_review';
  const scenario = record.scenarios[0]!;
  record.trials = [0, 1, 2].map(i => ({ id: `t${i}`, revisionId: 'revision-1', scenarioId: scenario.id, familyId: scenario.familyId, repeat: i, userMode: 'reactive' as const, split: 'dev' as const, manifestHash: 'hash',
    outcome: i === 0 ? 'fail' as const : 'pass' as const, reason: '', checks: [{ id: 'time', description: 'Время изменено', passed: i !== 0, evidence: '' }],
    events: [{ seq: 0, type: 'user' as const, text: 'hi' }, { seq: 1, type: 'assistant' as const, text: 'ok' }], initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1 }));
  const board = new LabBoard({ record, section: 'agent' }, theme, () => {}, () => {}, () => 40);
  const text = stripTerminalSequences(board.render(120).join('\n'));
  assert.match(text, /ИТОГ/);
  // Other scores leave the first block and stay below it as metric bars.
  assert.match(text, /Точные проверки · код · 2\/3/);
  assert.ok(text.includes(resultViewLines(buildResultView(record))[0]!));
  assert.match(text, /спорных 0/);
  // The failed repeat leaves the card unstable, so it is named as not measured, not as a failure.
  assert.match(text, /Провалов не зарегистрировано/);
  assert.match(text, /Дальше/);
  assert.doesNotMatch(text, /TPR/);
  assert.match(text, /1 Обзор.*2 Ситуации.*3 Диалоги/);
  assert.doesNotMatch(text, /4 Статистика|5 Сравнение/);
  for (const width of [16, 40, 80]) for (const line of board.render(width)) assert.ok(visibleWidth(line) <= width, `overflow at ${width}`);
  board.dispose();
  const results = new LabBoard({ record }, theme, () => {}, () => {}, () => 40);
  assert.doesNotMatch(results.render(120).join('\n'), /ЧТО ТРЕБУЕТ ВНИМАНИЯ/);
  assert.ok(stripTerminalSequences(results.render(120).join('\n')).includes(`Итог: ${buildResultView(record).headline.text} · 1 подробнее`));
  results.dispose();
});

test('filtered review targets the visible trial ID and help cannot accidentally submit a mark', async () => {
  const record = await fixture(); record.phase = 'results_review';
  record.trials = record.scenarios.map((s, i) => ({ id: `trial-${i}`, scenarioId: s.id, revisionId: 'r', familyId: s.familyId, repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: 'h', outcome: 'fail', reason: '', checks: [{ id: 'c', passed: false, evidence: '', description: 'c' }], events: [{ seq: 0, type: 'assistant', text: 'Ответ агента' }], initialState: s.initialState, finalState: s.initialState, elapsedMs: 1, usage: emptyUsage(), assessments: [{ metricId: 'demo_task_state', result: 'fail', rationale: 'Обоснование судьи', evidence: [0] }] }));
  record.scenarios[0]!.title = 'Первый'; record.scenarios[1]!.title = 'Возврат';
  const actions: BoardAction[] = [];
  const board = new LabBoard({ record, section: 'results' }, theme, a => actions.push(a), () => {}, () => 30);
  board.handleInput('?'); board.handleInput('n'); assert.equal(actions.length, 0); board.handleInput('?');
  board.handleInput('/'); board.handleInput('Возврат'); board.handleInput('\r');
  const lines = board.render(120);
  assert.ok(lines.at(-1)?.endsWith('╯'), 'footer fits the terminal');
  assert.match(lines.join('\n'), /Возврат/);
  board.handleInput('n');
  assert.equal(actions[0]?.type === 'agree' && actions[0].trialId, 'trial-1');
  const discussion = new LabBoard({ record, section: 'cards', query: 'Возврат' }, theme, a => actions.push(a), () => {});
  discussion.handleInput('a');
  assert.equal(actions[1]?.type === 'discuss' && record.scenarios[actions[1].selected]?.id, record.scenarios[1]!.id);
  const empty = new LabBoard({ records: [] }, theme, a => actions.push(a), () => {});
  empty.handleInput('n'); assert.equal(actions[2]?.type, 'new');
});

test('y, n и s отвечают судье только там, где судья вынес решение по главному вопросу', async () => {
  const record = await judgedFixture('judged', 'fail');
  const press = (options: BoardOptions, keys: string[]) => {
    const actions: BoardAction[] = [];
    const board = new LabBoard(options, theme, a => actions.push(a), () => {}, () => 40);
    for (const key of keys) board.handleInput(key);
    board.dispose();
    return actions;
  };

  // В области действия каждая клавиша — один ответ, и ответ несёт то решение судьи, на которое отвечает.
  for (const [key, answer] of [['y', 'agree'], ['n', 'disagree'], ['s', 'unsure']] as const) {
    const action = press({ record, section: 'results' }, [key])[0];
    assert.equal(action?.type, 'agree', `клавиша ${key}`);
    assert.equal(action?.type === 'agree' && action.answer, answer);
    assert.equal(action?.type === 'agree' && action.judgeVerdict, 'fail');
    assert.equal(action?.type === 'agree' && action.metricId, 'goal');
    assert.equal(action?.type === 'agree' && action.trialId, 'judged');
  }

  const control = structuredClone(record); control.positiveControlScenarioIds = [control.scenarios[0]!.id];
  const undecided = structuredClone(record); undecided.trials[0]!.assessments = [{ metricId: 'goal', result: 'unknown', rationale: 'Судья не решил', evidence: [0] }];
  const noRubric = structuredClone(record); delete noRubric.trials[0]!.assessments;
  const cases: [string, BoardOptions][] = [
    ['раздел 1', { record, section: 'agent' }],
    ['раздел 2', { record, section: 'cards' }],
    ['сравнение', { record: { ...record, workflow: 'compare' }, section: 'results' }],
    ['идут диалоги', { record: { ...record, phase: 'evaluating' }, section: 'results' }],
    ['контрольная ситуация', { record: control, section: 'results' }],
    ['судья не решил', { record: undecided, section: 'results' }],
    ['судья не оценивал', { record: noRubric, section: 'results' }],
  ];
  for (const [label, options] of cases) assert.deepEqual(press(options, ['y', 'n', 's', 'p']), [], label);

  // Во время поиска буквы набираются, а не отвечают судье.
  const searching: BoardAction[] = [];
  const search = new LabBoard({ record, section: 'results' }, theme, a => searching.push(a), () => {}, () => 40);
  search.handleInput('/'); search.handleInput('y'); search.handleInput('n'); search.handleInput('s');
  assert.deepEqual(searching, []);
  assert.match(stripTerminalSequences(search.render(120).join('\n')), /Поиск: yns/);
  search.dispose();

  // При открытой справке доска не отправляет ответ.
  assert.deepEqual(press({ record, section: 'results' }, ['?', 'y', 'n', 's']), []);
  // В списке прогонов `n` по-прежнему начинает новую проверку.
  assert.equal(press({ records: [record] }, ['n'])[0]?.type, 'new');
});

/**
 * A finished evaluation with named situations: `failures` the judge failed, `passes` it passed and
 * — when asked — one dialogue still waiting for a verdict on the simulator. The record order
 * interleaves passes and failures on purpose, so a list that claims the queue comes first has to
 * prove it against the record order.
 */
async function queueFixture(failures: number, passes: number, withPending = true): Promise<Experiment> {
  const record = await fixture();
  record.phase = 'results_review'; record.reviewedAt = new Date().toISOString();
  const base = record.scenarios[0]!;
  const goal = { id: 'goal', name: 'Цель достигнута', subject: 'agent' as const, description: 'Клиент получил то, что просил', passCriteria: 'Получил', failCriteria: 'Не получил' };
  const card = (id: string, title: string, agent: boolean) => ({ ...structuredClone(base), id, familyId: id, title, metrics: agent ? [goal] : [] });
  const trial = (id: string, result: 'pass' | 'fail') => ({
    id, revisionId: 'revision-1', scenarioId: id, familyId: id, repeat: 0, userMode: 'reactive' as const,
    split: 'dev' as const, manifestHash: 'hash', outcome: result, reason: '',
    checks: [{ id: 'time', description: 'Запись переставлена', passed: result === 'pass', evidence: 'e' }],
    events: [{ seq: 0, type: 'assistant' as const, text: 'Ответ агента' }],
    initialState: base.initialState, finalState: base.initialState, usage: emptyUsage(), elapsedMs: 1,
    assessments: [{ metricId: 'goal', result, rationale: 'Обоснование судьи', evidence: [0] }],
  });
  const failIds = Array.from({ length: failures }, (_, i) => `F${i + 1}`);
  const passIds = Array.from({ length: passes }, (_, i) => `P${i + 1}`);
  record.scenarios = [
    ...failIds.map((id, i) => card(id, `Провал ${i + 1}`, true)),
    ...passIds.map((id, i) => card(id, `Успех ${i + 1}`, true)),
    ...(withPending ? [card('sim', 'Симулятор отклонился', false)] : []),
  ] as typeof record.scenarios;
  const pending = {
    ...trial('sim', 'pass'), assessments: [],
    simulatorChecks: [{ id: 'simulator_leak' as const, description: 'Симулятор выдал лишнее', passed: false, evidence: 'e', heuristic: false }],
    events: [{ seq: 0, type: 'simulator' as const, text: '', result: { done: false, message: 'ещё' } }, { seq: 1, type: 'assistant' as const, text: 'Ответ агента' }],
  };
  const order: Experiment['trials'] = [];
  for (let i = 0; i < Math.max(failures, passes); i++) {
    if (passIds[i]) order.push(trial(passIds[i]!, 'pass') as Experiment['trials'][number]);
    if (failIds[i]) order.push(trial(failIds[i]!, 'fail') as Experiment['trials'][number]);
    if (i === 0 && withPending) order.push(pending as unknown as Experiment['trials'][number]);
  }
  record.trials = order;
  record.humanReviews = [];
  return record;
}

/** One saved answer to the judge, exactly as the board writes it (`source: 'quick'`). */
const quickMark = (trialId: string, verdict: 'pass' | 'fail' | 'unknown', judgeVerdict: 'pass' | 'fail', note: string) =>
  ({ id: `h-${trialId}-${verdict}`, trialId, metricId: 'goal', source: 'quick' as const, verdict, judgeVerdict, note, createdAt: '2026-09-17T00:00:00.000Z' });

test('очередь разбора ведёт неотмеченными провалами, затем проверяемыми успехами, и каждая строка говорит, где ситуация стоит', async () => {
  const record = await queueFixture(2, 4);
  const sample = agreementSample(record);
  assert.equal(sample.length, 3, 'из четырёх успехов на проверку берутся три');
  const recordOrder = record.trials.map(t => t.id);
  const sampled = recordOrder.filter(id => sample.includes(id));
  const spare = ['P1', 'P2', 'P3', 'P4'].filter(id => !sample.includes(id));
  assert.deepEqual(reviewOrder(record).map(t => t.id), ['F1', 'F2', ...sampled, 'sim', ...spare],
    `порядок записи: ${recordOrder.join(', ')}`);

  const rows = () => new Map(resultEntries(record).map(entry => [entry.id, entry.text]));
  assert.equal(rows().get('F2'), '● ПРОВЕРЬТЕ ПРОВАЛ · Провал 2 · reactive #1');
  const successTitle = record.scenarios.find(card => card.id === sampled[0])!.title;
  assert.equal(rows().get(sampled[0]!), `● ПРОВЕРЬТЕ И УСПЕХ · ${successTitle} · reactive #1`);

  // Ответ уводит ситуацию из очереди, и та же позиция списка показывает следующую.
  record.humanReviews.push(quickMark('F1', 'fail', 'fail', 'Быстрая отметка: согласен с судьёй.'));
  assert.equal(reviewOrder(record)[0]?.id, 'F2');
  assert.equal(rows().get('F1'), 'НЕ ПРОЙДЕНО · Провал 1 · reactive #1 · = согласен');

  record.humanReviews.push(quickMark('F2', 'pass', 'fail', 'Судья не учёл уточнение клиента.'));
  assert.equal(rows().get('F2'), 'НЕСОГЛАСИЕ С СУДЬЁЙ · Провал 2 · reactive #1');

  record.humanReviews.push(quickMark(sampled[0]!, 'unknown', 'pass', 'Быстрая отметка: не могу сказать.'));
  assert.equal(rows().get(sampled[0]!), `● ПРОЙДЕНО · ${successTitle} · reactive #1 · ~ не могу сказать`);

  // «Только неразобранные» держит непроверенные успехи и всё, что ещё ждёт человека.
  const waiting = resultEntries(record).filter(entry => entry.waiting).map(entry => entry.id);
  assert.deepEqual(waiting, [...sampled.slice(1), 'sim']);

  for (const id of sampled.slice(1)) record.humanReviews.push(quickMark(id, 'pass', 'pass', 'Быстрая отметка: согласен с судьёй.'));
  assert.equal(reviewOrder(record)[0]?.id, 'sim');
  assert.deepEqual(resultEntries(record).filter(entry => entry.waiting).map(entry => entry.id), ['sim']);
});

test('при тринадцати провалах и одном проверяемом успехе успех стоит четырнадцатым', async () => {
  const record = await queueFixture(13, 1, false);
  const entries = resultEntries(record);
  assert.deepEqual(entries.slice(0, 13).map(entry => entry.id), Array.from({ length: 13 }, (_, i) => `F${i + 1}`));
  assert.equal(entries[13]?.text, '● ПРОВЕРЬТЕ И УСПЕХ · Успех 1 · reactive #1');
});

test('управляющая последовательность в названии ситуации не доходит до терминала', async () => {
  const record = await queueFixture(1, 1, false);
  record.scenarios[0]!.title = 'Возврат[31m платежа';
  const board = new LabBoard({ record, section: 'results' }, theme, () => {}, () => {}, () => 40);
  const raw = board.render(140).join('\n');
  assert.doesNotMatch(raw, /\[31m/, 'ни список, ни боковая колонка не печатают управляющую последовательность');
  assert.match(raw, /ПРОВЕРЬТЕ ПРОВАЛ · Возврат/);
  board.dispose();
});

/** The F11 header of a record, as the board would choose it at `inner` columns. */
function headerOf(record: Experiment, inner: number, agreement?: ReturnType<typeof judgeAgreement>) {
  assert.equal(typeof cards.reviewHeader, 'function', 'cards.ts exports reviewHeader (UI-SPEC F11)');
  return cards.reviewHeader(record, inner, agreement);
}

test('после настоящей отметки заголовок раздела 3 говорит, сколько провалов и успехов проверено', async () => {
  const demo = await demoEvaluateRecord('agent-lab-review-header-');
  try {
    const source = demo.record;
    const decided = source.trials.flatMap(trial => {
      const scenario = source.scenarios.find(item => item.id === trial.scenarioId);
      const metricId = scenario && primaryMetricId(scenario, trial);
      const result = metricId ? trial.assessments?.find(item => item.metricId === metricId)?.result : undefined;
      return metricId && (result === 'pass' || result === 'fail') ? [{ trial, metricId, result }] : [];
    })[0];
    assert.ok(decided, 'в демо-прогоне судья решил хотя бы одну ситуацию');
    await demo.lab.addHumanReview(source.id, { trialId: decided.trial.id, metricId: decided.metricId, source: 'quick',
      verdict: decided.result, note: 'Быстрая отметка: согласен с судьёй.' });
    const record = await demo.lab.get(source.id);
    const agreement = judgeAgreement(record);
    const Q = agreement.queueFailures.length;
    const S = agreement.sampledPasses.length;
    const expected = decided.result === 'fail'
      ? S ? `Проверено провалов: 1 из ${Q} · успехов: 0 из ${S}` : `Проверено провалов: 1 из ${Q} · успехов нет`
      : Q ? `Проверено провалов: 0 из ${Q} · успехов: 1 из ${S}` : `Проверено успехов: 1 из ${S} · провалов нет`;
    const recording = { fg: (color: string, value: string) => `<${color}>${value}</${color}>`, bold: (value: string) => value };
    const board = new LabBoard({ record, section: 'results' }, recording, () => {}, () => {}, () => 40);
    // At 120 columns the sidebar takes 35, so the header is chosen for the wide tier (inner 81).
    const painted = board.render(120).join('\n');
    board.dispose();
    assert.ok(painted.includes(`<warning>${expected}</warning>`), `заголовок «${expected}» в цвете warning`);
    assert.deepEqual(headerOf(record, 81), { text: expected, color: 'warning' });
  } finally {
    await demo.lab.close();
    await rm(demo.directory, { recursive: true, force: true });
  }
});

test('заголовок раздела 3 выбирает состояние и ширину по UI-SPEC F11 и не считает сомнения проверенными', async () => {
  const at = (record: Experiment, mark?: (r: Experiment) => void) => { const copy = structuredClone(record); mark?.(copy); return copy; };
  const both = await queueFixture(1, 1, false);
  const agreeF1 = (r: Experiment) => r.humanReviews.push(quickMark('F1', 'fail', 'fail', 'Быстрая отметка: согласен с судьёй.'));
  const unsureF1 = (r: Experiment) => r.humanReviews.push(quickMark('F1', 'unknown', 'fail', 'Быстрая отметка: не могу сказать.'));
  const disagreeP1 = (r: Experiment) => r.humanReviews.push(quickMark('P1', 'fail', 'pass', 'Судья зря похвалил.'));
  const undecided = await judgedFixture('undecided', 'fail');
  undecided.trials[0]!.assessments = [{ metricId: 'goal', result: 'unknown', rationale: 'Судья не решил', evidence: [0] }];
  const cases: [string, Experiment, string, string, 'warning' | 'success' | 'muted'][] = [
    ['обе группы', both, 'Проверено провалов: 0 из 1 · успехов: 0 из 1', 'Провалы 0 из 1 · успехи 0 из 1', 'warning'],
    ['согласие считается', at(both, agreeF1), 'Проверено провалов: 1 из 1 · успехов: 0 из 1', 'Провалы 1 из 1 · успехи 0 из 1', 'warning'],
    ['сомнение не считается', at(both, unsureF1), 'Проверено провалов: 0 из 1 · успехов: 0 из 1', 'Провалы 0 из 1 · успехи 0 из 1', 'warning'],
    ['успехов нет', await queueFixture(1, 0, false), 'Проверено провалов: 0 из 1 · успехов нет', 'Провалы 0 из 1 · успехов нет', 'warning'],
    ['провалов нет', await queueFixture(0, 1, false), 'Проверено успехов: 0 из 1 · провалов нет', 'Успехи 0 из 1 · провалов нет', 'warning'],
    ['остались сомнения', at(both, r => { unsureF1(r); disagreeP1(r); }), 'Не решено: 1. y или n — чтобы завершить разбор.', 'Не решено: 1. Нажмите y или n.', 'warning'],
    ['всё решено, разбор открыт', at(both, r => { agreeF1(r); disagreeP1(r); }), 'Проверка окончена. f — завершить разбор.', 'Всё проверено. f — завершить.', 'success'],
    ['всё решено, прогон завершён', at(both, r => { agreeF1(r); disagreeP1(r); r.phase = 'complete'; }), 'Проверка окончена.', 'Всё проверено.', 'muted'],
    ['очередь пуста', undecided, 'Проверять нечего: судья не вынес решений.', 'Судья не вынес решений.', 'muted'],
  ];
  for (const [label, record, wide, narrow, color] of cases) {
    assert.deepEqual(headerOf(record, 48), { text: wide, color }, `${label}: широкий`);
    assert.deepEqual(headerOf(record, 156), { text: wide, color }, `${label}: широкий 156`);
    assert.deepEqual(headerOf(record, 47), { text: narrow, color }, `${label}: узкий 47`);
    assert.deepEqual(headerOf(record, 36), { text: narrow, color }, `${label}: узкий 36`);
  }

  // Пустая очередь: y, n и s ничего не делают, а доска говорит, что проверять нечего.
  const actions: BoardAction[] = [];
  const empty = new LabBoard({ record: undecided, section: 'results' }, theme, a => actions.push(a), () => {}, () => 40);
  for (const key of ['y', 'n', 's']) empty.handleInput(key);
  assert.deepEqual(actions, []);
  assert.ok(boardCells(empty, 120).includes('Проверять нечего: судья не вынес решений.'));
  assert.ok(boardCells(empty, 40).includes('Судья не вынес решений.'));
  empty.dispose();

  // Худший случай — каждое число 99 (в прогоне не больше 20 ситуаций): широкий текст ≤ 48, узкий ≤ 34.
  const nines = await queueFixture(99, 0, false);
  for (const id of nines.trials.map(t => t.id)) nines.humanReviews.push(quickMark(id, 'unknown', 'fail', 'Быстрая отметка: не могу сказать.'));
  assert.equal(headerOf(nines, 36).text, 'Не решено: 99. Нажмите y или n.');
  const real = judgeAgreement(nines);
  const ids = Array.from({ length: 99 }, (_, i) => `id${i}`);
  const worst = (patch: Partial<typeof real>) => ({ ...real, queueFailures: ids, sampledPasses: ids, unmarked: [], unsure: 0, failures: { agreed: 99, checked: 99 }, sampleChecked: 99, ...patch });
  const states = [
    worst({ unmarked: ['id0'] }), worst({ unmarked: ['id0'], sampledPasses: [] }), worst({ unmarked: ['id0'], queueFailures: [] }),
    worst({ unsure: 99 }), worst({}), worst({ queueFailures: [], sampledPasses: [] }),
  ];
  const seen = new Set<string>();
  for (const phase of ['results_review', 'complete'] as const) for (const agreement of states) {
    const record = { ...nines, phase };
    const wide = headerOf(record, 48, agreement).text;
    const narrow = headerOf(record, 36, agreement).text;
    seen.add(wide); seen.add(narrow);
    assert.ok(visibleWidth(wide) <= 48, `«${wide}» шире 48`);
    assert.ok(visibleWidth(narrow) <= 34, `«${narrow}» шире 34`);
  }
  assert.ok(seen.has('Проверено провалов: 99 из 99 · успехов: 99 из 99'));
  assert.ok(seen.has('Провалы 99 из 99 · успехи 99 из 99'));
  assert.ok(seen.has('Не решено: 99. y или n — чтобы завершить разбор.'));
  assert.equal(seen.size, 14, 'все семь состояний в двух ширинах');
});

/** Key Map Registry, footer tiers of section 3 (UI-SPEC C-90), with their measured widths. */
const FOOTER = {
  results_review: [
    'a Обсудить · y Согласен с судьёй · n Не согласен · s Не могу сказать · v Оценить подробно · f Завершить разбор',
    'y Согласен с судьёй · n Не согласен · s Не могу сказать · v Оценить подробно · f Завершить разбор',
    'y Согласен · n Не согласен · s Не могу сказать · f Завершить разбор',
    'y Согласен · n Не согласен · s Не могу сказать',
    'y · n · s — согласие с судьёй',
  ],
  complete: [
    'y Согласен с судьёй · n Не согласен · s Не могу сказать · r Повторить прогон · x Экспортировать',
    'y Согласен · n Не согласен · s Не могу сказать · r Повторить прогон',
    'y Согласен · n Не согласен · s Не могу сказать',
    'y · n · s — согласие с судьёй',
  ],
} as const;
const REPORT = 'o Открыть отчёт · ';
const BOUNDARIES = [36, 46, 47, 64, 66, 67, 84, 85, 94, 95, 96, 97, 109, 110, 115, 128, 156];

function footerOf(phase: 'results_review' | 'complete', inner: number, hasReport: boolean): string {
  assert.equal(typeof cards.resultsFooter, 'function', 'cards.ts exports resultsFooter (Key Map Registry)');
  return cards.resultsFooter(phase, inner, hasReport);
}

test('подвал раздела 3 выбирает первую влезающую ступень и печатает отчёт только там, где он влезает', () => {
  assert.deepEqual(FOOTER.results_review.map(visibleWidth), [110, 97, 67, 46, 29]);
  assert.deepEqual(FOOTER.complete.map(visibleWidth), [95, 67, 46, 29]);
  assert.equal(visibleWidth(REPORT), 18);
  const [R1, R2, R3, R4, R5] = FOOTER.results_review;
  const [C1, C2, C3, C4] = FOOTER.complete;
  const cases: ['results_review' | 'complete', number, boolean, string][] = [
    ['results_review', 110, false, R1], ['results_review', 109, false, R2], ['results_review', 97, false, R2],
    ['results_review', 96, false, R3], ['results_review', 67, false, R3], ['results_review', 66, false, R4],
    ['results_review', 46, false, R4], ['results_review', 36, false, R5],
    ['results_review', 128, true, REPORT + R1], ['results_review', 127, true, REPORT + R2], ['results_review', 85, true, REPORT + R3],
    ['results_review', 84, true, REPORT + R4], ['results_review', 64, true, REPORT + R4], ['results_review', 47, true, REPORT + R5],
    // Ни одна ступень не влезает вместе с отчётом: ссылка на отчёт уходит, клавиша o продолжает работать.
    ['results_review', 46, true, R4], ['results_review', 36, true, R5],
    ['complete', 95, false, C1], ['complete', 94, false, C2], ['complete', 67, false, C2],
    ['complete', 66, false, C3], ['complete', 46, false, C3], ['complete', 36, false, C4],
    ['complete', 113, true, REPORT + C1], ['complete', 112, true, REPORT + C2], ['complete', 85, true, REPORT + C2],
    ['complete', 84, true, REPORT + C3], ['complete', 64, true, REPORT + C3], ['complete', 63, true, REPORT + C4],
    ['complete', 47, true, REPORT + C4], ['complete', 46, true, C3], ['complete', 36, true, C4],
  ];
  for (const [phase, inner, report, expected] of cases) assert.equal(footerOf(phase, inner, report), expected, `${phase} ${inner}${report ? ' с отчётом' : ''}`);

  for (const phase of ['results_review', 'complete'] as const) for (const inner of BOUNDARIES) for (const report of [false, true]) {
    const row = footerOf(phase, inner, report);
    assert.ok(visibleWidth(row) <= inner, `${phase} ${inner}${report ? ' с отчётом' : ''}: «${row}» шире ${inner}`);
    assert.ok(!row.includes('…'), `${phase} ${inner}: подвал обрезан`);
    assert.ok((FOOTER[phase] as readonly string[]).includes(row.replace(REPORT, '')), `${phase} ${inner}: «${row}» — не ступень из таблицы`);
    assertPlainCopy(row, 'подвал');
  }
});

test('доска печатает в разделе 3 ту же ступень подвала, не повторяет отчёт и не трогает другие разделы', async () => {
  const width = (w: number, sidebar: boolean) => w - 4 - (sidebar ? 35 : 0);
  for (const phase of ['results_review', 'complete'] as const) for (const report of [false, true]) {
    const record = await queueFixture(2, 2, false);
    record.phase = phase;
    const options = { record, section: 'results' as const, ...(report ? { reportPath: '/tmp/agent-lab-report.html' } : {}) };
    const board = new LabBoard(options, theme, () => {}, () => {}, () => 3000);
    for (const w of [40, 60, 80, 110, 160]) {
      const rows = board.render(w);
      for (const row of rows) assert.ok(visibleWidth(row) <= w, `${phase} ${w}: строка шире доски`);
      const footer = stripTerminalSequences(rows.at(-3)!).split('│')[1]!.trim();
      const expected = footerOf(phase, width(w, w >= 110), report);
      assert.equal(footer, expected, `${phase} ${w}${report ? ' с отчётом' : ''}`);
      assert.ok(footer.indexOf(REPORT) === footer.lastIndexOf(REPORT), 'отчёт назван не больше одного раза');
      // Вторая строка подвала прежняя, вместе с прежним сокращением рамкой на узкой доске.
      const second = width(w, w >= 110) < 80 ? '↑↓ Выбор · ←→ Текст · Enter Детали · / Поиск · ? Помощь'
        : '↑↓ Выбор · PgUp/PgDn Текст · Enter Подробнее · / Поиск · u Неразобранные · ? Помощь';
      assert.equal(stripTerminalSequences(rows.at(-2)!).split('│')[1]!.trim(), stripTerminalSequences(truncateToWidth(second, w - 4, '…')));
    }
    board.dispose();
  }
  const record = await queueFixture(2, 2, false);
  const wide = new LabBoard({ record, section: 'results' }, theme, () => {}, () => {}, () => 3000);
  assert.equal(stripTerminalSequences(wide.render(160).at(-3)!).split('│')[1]!.trim(), FOOTER.results_review[0]);
  assert.equal(stripTerminalSequences(wide.render(40).at(-3)!).split('│')[1]!.trim(), FOOTER.results_review[4]);
  wide.dispose();

  // Разделы 1 и 2 сохраняют свои подвалы.
  const footerIn = (r: Experiment, section: 'agent' | 'cards', reportPath?: string) => {
    const board = new LabBoard({ record: r, section, ...(reportPath ? { reportPath } : {}) }, theme, () => {}, () => {}, () => 3000);
    try { return stripTerminalSequences(board.render(160).at(-3)!).split('│')[1]!.trim(); } finally { board.dispose(); }
  };
  assert.equal(footerIn(record, 'agent'), 'a Обсудить · 3 Диалоги · f Завершить · r Повторить · x Экспорт');
  assert.equal(footerIn(record, 'cards', '/tmp/r.html'), 'o Открыть отчёт · a Обсудить · 3 Диалоги · f Завершить · r Повторить · x Экспорт');
  const finished = { ...record, phase: 'complete' as const };
  assert.equal(footerIn(finished, 'agent'), 'a Обсудить результат · r Повторить · x Экспорт');
  assert.equal(footerIn(finished, 'cards', '/tmp/r.html'), 'o Открыть отчёт · a Обсудить результат · r Повторить · x Экспорт');
});

test('справка и подробности диалога называют новые клавиши и не называют снятую p', async () => {
  const record = await judgedFixture('open', 'fail');
  const board = new LabBoard({ record, section: 'results' }, theme, () => {}, () => {}, () => 3000);
  board.handleInput('?');
  const rows = boardCells(board, 200);
  const help = rows.join('\n');
  board.dispose();
  const at = (text: string) => rows.findIndex(row => row.includes(text));
  const recording = { fg: (color: string, value: string) => `<${color}>${value}</${color}>`, bold: (value: string) => value };
  const painted = new LabBoard({ record, section: 'results' }, recording, () => {}, () => {}, () => 3000);
  painted.handleInput('?');
  const colored = painted.render(300).join('\n');
  painted.dispose();
  assert.ok(rows.includes('y / n / s — согласен с судьёй / не согласен / не могу сказать'), 'строка C-87');
  assert.equal(at('n — спросит причину · v — оценить критерий или весь диалог') - at('y / n / s — согласен с судьёй'), 1, 'C-88 сразу за C-87');
  assert.ok(at('a — правка или разбор словами с Pi · n в списке — новая проверка') >= 0, 'строка про a не изменилась');
  const latin = at('Клавиши — латинские буквы: переключите раскладку, если буквы не срабатывают.');
  const last = at('Все оценки и подтверждения относятся к показанной версии.');
  assert.ok(latin >= 0, 'строка C-89');
  assert.equal(last - latin, 1, 'C-89 стоит прямо перед последней приглушённой строкой');
  assert.ok(colored.includes('<muted>Клавиши — латинские буквы: переключите раскладку, если буквы не срабатывают.</muted>'), 'C-89 приглушённая');
  assert.doesNotMatch(help, /p \/ n|\bp — |\bp Пройдено/);
  for (const text of ['y / n / s — согласен с судьёй / не согласен / не могу сказать', 'n — спросит причину · v — оценить критерий или весь диалог',
    'Клавиши — латинские буквы: переключите раскладку, если буквы не срабатывают.']) assertPlainCopy(text, 'справка');

  const open = cards.trialLines(record.trials[0]!, record, false);
  const hint = open.find(row => row.text.startsWith('Вердикта человека нет'));
  assert.equal(hint?.text, 'Вердикта человека нет. v — оценить критерий или весь диалог.');
  assert.equal(hint?.color, 'muted');
  const done = await judgedFixture('done', 'pass');
  done.phase = 'complete'; done.resultsReviewedAt = done.updatedAt;
  const closed = cards.trialLines(done.trials[0]!, done, true);
  assert.ok(closed.some(row => row.text === 'Разбор набора завершён; у этого диалога отдельного вердикта нет. v — оценить подробно.'));
  for (const row of [...open, ...closed]) assert.doesNotMatch(row.text, /\bp — |p \/ n|\bn — не пройдено/);
  for (const row of [hint!.text, 'Разбор набора завершён; у этого диалога отдельного вердикта нет. v — оценить подробно.']) assertPlainCopy(row, 'подробности');
});

test('HTML reports escape untrusted text and remain self-contained with explicit evidence limits', async () => {
  const record = await fixture();
  record.task = '<script>alert(1)</script> & "тест"';
  const html = htmlReport(record);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<iframe|<img|<link|<form/i);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /lang="ru"/);
  assert.match(html, /Аудит не завершён/);
  assert.match(html, /Сценарное демо/);
  record.profiles = [{ id: 'p', source: 'observed', persona: '<img src=x>', characteristics: ['Original trait'], evidenceDialogueIds: ['d1'], draftOverride: { persona: null, characteristics: ['<script>override</script>'] } }];
  record.scenarios[0]!.profileId = 'p'; delete record.scenarios[0]!.user.persona;
  const profiles = htmlReport(record);
  assert.match(profiles, /&lt;img src=x&gt;/); assert.match(profiles, /&lt;script&gt;override&lt;\/script&gt;/);
  assert.match(profiles, /Правка черновика/); assert.match(profiles, /Персона: убрана/);
  assert.doesNotMatch(profiles, /<img/i);
  record.workflow = 'compare'; record.scenarios[1]!.split = 'control'; record.scenarios[1]!.title = 'CONTROL_CARD_SENTINEL';
  assert.doesNotMatch(htmlReport(record), /CONTROL_CARD_SENTINEL/);
  record.controlConsumedAt = 'now'; record.phase = 'control';
  assert.doesNotMatch(htmlReport(record), /CONTROL_CARD_SENTINEL/);
  record.phase = 'complete'; assert.match(htmlReport(record), /CONTROL_CARD_SENTINEL/);
});

test('the board keeps simulator checks in the dialogue and the repeat headline in the overview', async () => {
  const record = await fixture(); record.phase = 'results_review'; record.reviewedAt = '2026-09-14T00:00:00.000Z';
  record.settings.userModes = ['static', 'reactive']; record.settings.repeats = 1;
  record.scenarios = [record.scenarios[0]!];
  const card = record.scenarios[0]!;
  card.metrics = card.metrics?.filter(m => m.subject === 'agent');
  const events = [{ seq: 0, type: 'user' as const, text: card.user.opening }, { seq: 1, type: 'assistant' as const, text: 'Which appointment?' },
    { seq: 2, type: 'simulator' as const, result: { message: 'Appointment A777', done: false } }, { seq: 3, type: 'user' as const, text: 'Appointment A777' }, { seq: 4, type: 'assistant' as const, text: 'Done.' }];
  const base = { revisionId: 'revision-1', scenarioId: card.id, familyId: card.familyId, repeat: 0, split: 'dev' as const, manifestHash: 'hash', reason: '', initialState: card.initialState, finalState: card.initialState, usage: emptyUsage(), elapsedMs: 1 };
  // The demo card carries the agent rubric demo_task_state; without an assessment its automatic result is unknown and mode value cannot resolve.
  const assessed = (result: 'pass' | 'fail') => [{ metricId: 'demo_task_state', result, rationale: 'fixture', evidence: [1] }];
  record.trials = [
    { ...base, id: 'reactive', userMode: 'reactive', outcome: 'fail', checks: card.checks.map(c => ({ id: c.id, description: c.description, passed: false, evidence: 'e' })), events, assessments: assessed('fail'),
      simulatorChecks: [{ id: 'simulator_fabrication', description: 'Пользователь не называет значения, которых нет в карточке (эвристика)', passed: false, evidence: 'Подозрение: реплика #3 содержит значение «a777»', seq: 3, heuristic: true }] },
    { ...base, id: 'static', userMode: 'static', outcome: 'pass', checks: card.checks.map(c => ({ id: c.id, description: c.description, passed: true, evidence: 'e' })), events: events.slice(0, 2), assessments: assessed('pass') },
  ];
  const results = new LabBoard({ record, section: 'results' }, theme, () => {}, () => {}, () => 60);
  try {
    for (const width of [80, 132]) for (const row of results.render(width)) assert.ok(visibleWidth(row) <= width, `overflow at ${width}`);
    const dialogue = stripTerminalSequences(results.render(132).join('\n'));
    assert.match(dialogue, /ПРОВЕРКИ СИМУЛЯТОРА · эвристики/); assert.match(dialogue, /\? .*эвристика/); assert.match(dialogue, /Подозрение: реплика #3/);
    // The static dialogue never involved the simulator, so its checks block is absent rather than "not applied".
    results.handleInput('\u001b[B');
    const staticView = stripTerminalSequences(results.render(132).join('\n'));
    assert.doesNotMatch(staticView.split('ДЕТЕРМИНИРОВАННЫЕ ПРОВЕРКИ').at(-1) ?? '', /Не применялись/);
  } finally { results.dispose(); }
  const before = structuredClone(record); before.id = 'before'; before.settings.userModes = ['static']; before.trials = [before.trials[1]!];
  before.trials[0]!.outcome = 'fail'; before.trials[0]!.checks = before.trials[0]!.checks.map(c => ({ ...c, passed: false })); before.trials[0]!.assessments = assessed('fail');
  const after = structuredClone(before); after.id = 'after'; after.parentRunId = 'before'; after.trials[0]!.id = 'after_static'; after.trials[0]!.outcome = 'pass'; after.trials[0]!.checks = after.trials[0]!.checks.map(c => ({ ...c, passed: true })); after.trials[0]!.assessments = assessed('pass');
  after.trials[0]!.events[1]!.text = 'Moved to 14:00.'; // a changed agent reply: identical replies with flipped scores would be sent to review instead
  const bundle = await evidenceBundle(after, { get: async () => before, traceJournal: async () => '' });
  const comparison = new LabBoard({ record: after, before, comparison: bundle.comparison, section: 'agent' }, theme, () => {}, () => {}, () => 40);
  try {
    const text = stripTerminalSequences(comparison.render(120).join('\n'));
    assert.match(text, /После исправления: .*Оценка выросла/iu);
    assert.doesNotMatch(text, /Парная дельта|Ценность режимов/);
  } finally { comparison.dispose(); }
});

/** A finished record with three attempts on one card and one broken attempt on the other. */
async function finishedWithInvalid(): Promise<Experiment> {
  const record = await fixture();
  record.phase = 'results_review';
  const [first, second] = [record.scenarios[0]!, record.scenarios[1]!];
  const attempt = (id: string, scenario: typeof first, repeat: number, outcome: 'pass' | 'fail' | 'invalid') => ({ id, revisionId: 'revision-1', scenarioId: scenario.id, familyId: scenario.familyId,
    repeat, userMode: 'reactive' as const, split: 'dev' as const, manifestHash: 'hash', outcome, reason: outcome === 'invalid' ? 'ОДИНОЧНЫЙ СБОЙ' : '',
    checks: outcome === 'invalid' ? [] : [{ id: 'time', description: 'Время изменено', passed: outcome === 'pass', evidence: '' }],
    events: [{ seq: 0, type: 'user' as const, text: 'hi' }, { seq: 1, type: 'assistant' as const, text: 'ok' }], initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1 });
  record.trials = [attempt('t0', first, 0, 'fail'), attempt('t1', first, 1, 'pass'), attempt('t2', first, 2, 'pass'), attempt('t3', second, 0, 'invalid')];
  return record;
}
/** Board text split into cells: frame and sidebar separators removed, each cell trimmed. */
function boardCells(board: LabBoard, width = 200): string[] {
  return stripTerminalSequences(board.render(width).join('\n')).split('\n')
    .flatMap(row => row.split('│')).map(cell => cell.trim()).filter(Boolean);
}

test('the board overview shows the ResultView block verbatim and no private not-measured count', async () => {
  const record = await finishedWithInvalid();
  const view = buildResultView(record);
  const board = new LabBoard({ record }, theme, () => {}, () => {}, () => 80);
  const cells = boardCells(board);
  // Board cells are trimmed; the indented rows under «Не измерено» are compared without their indent.
  for (const expected of resultViewLines(view)) assert.ok(cells.includes(expected.trim()), `board misses block line: ${expected}`);
  assert.ok(!cells.includes('НЕ ИЗМЕРЕНО'), 'the single-trial not-measured header is gone');
  const broken = record.scenarios.find(scenario => scenario.id === record.trials.find(trial => trial.outcome === 'invalid')?.scenarioId)!;
  assert.ok(!cells.includes(`${broken.title}: ОДИНОЧНЫЙ СБОЙ`), 'the first invalid trial is not picked on its own');
  assert.ok(cells.includes(`Итог: ${view.headline.text} · 1 подробнее`));
  board.dispose();
});

test('the board uses a supplied view only for the same run', async () => {
  const record = await finishedWithInvalid();
  const view = buildResultView(record);
  const marked = (runId: string, text: string): ResultView => ({ ...view, runId, headline: { ...view.headline, text } });
  const own = new LabBoard({ record, view: marked(record.id, 'СВОЙ ИТОГ') }, theme, () => {}, () => {}, () => 80);
  const ownCells = boardCells(own);
  assert.ok(ownCells.includes('СВОЙ ИТОГ'));
  assert.ok(ownCells.includes('Итог: СВОЙ ИТОГ · 1 подробнее'));
  own.dispose();
  const stale = new LabBoard({ record, view: marked('another-run', 'ЧУЖОЙ ИТОГ') }, theme, () => {}, () => {}, () => 80);
  const staleCells = boardCells(stale);
  assert.ok(!staleCells.some(cell => cell.includes('ЧУЖОЙ ИТОГ')), 'a view of another run is ignored');
  assert.ok(staleCells.includes(view.headline.text));
  stale.dispose();
});

test('after refresh the board shows the refreshed bundle view', async () => {
  const finished = await finishedWithInvalid();
  const running = { ...structuredClone(finished), phase: 'evaluating' as const };
  const refreshedView: ResultView = { ...buildResultView(finished), headline: { ...buildResultView(finished).headline, text: 'ОБНОВЛЁННЫЙ ИТОГ' } };
  let renders = 0;
  const board = new LabBoard({ record: running, section: 'agent',
    load: async () => ({ record: finished, warnings: [], view: refreshedView }) }, theme, () => {}, () => { renders++; }, () => 80);
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.ok(renders > 0);
  const cells = boardCells(board);
  assert.ok(cells.includes('ОБНОВЛЁННЫЙ ИТОГ'));
  assert.ok(cells.includes('Итог: ОБНОВЛЁННЫЙ ИТОГ · 1 подробнее'));
  board.dispose();
});

/** Decided failures with a recorded cluster, so every surface has failures to explain. */
async function failedCard(cards = 1): Promise<Experiment> {
  const record = await fixture();
  record.phase = 'complete'; record.reviewedAt = record.createdAt; record.resultsReviewedAt = record.updatedAt;
  // One planned attempt per card, so the card with its single failed attempt is decided, not «запись неполная».
  record.settings = { ...record.settings, userModes: ['static'], repeats: 1 };
  const scenario = record.scenarios[0]!;
  scenario.successCriteria = 'Время изменилось на 14:00.';
  scenario.metrics = [{ id: 'goal_attainment', name: 'Достижение цели', subject: 'agent',
    description: 'Задача пользователя решена.', passCriteria: 'Время изменено.', failCriteria: 'Время не изменено.' }];
  record.trials = [{ id: 'f0', revisionId: 'revision-1', scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0,
    userMode: 'static' as const, split: 'dev' as const, manifestHash: 'hash', outcome: 'fail' as const, reason: 'Время не изменилось.',
    checks: [{ id: 'time', description: 'Время изменено', passed: false, evidence: 'В состоянии осталось 12:00' }],
    events: [{ seq: 0, type: 'user' as const, text: 'Перенесите запись на 14:00.' }, { seq: 1, type: 'assistant' as const, text: 'Ничего менять не буду.' }],
    initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1,
    assessments: [{ metricId: 'goal_attainment', result: 'fail' as const, rationale: 'CLIPPED_JUDGE_RATIONALE',
      evidence: [1], citations: [{ seq: 1, quote: 'Ничего менять не буду.' }] }] }];
  if (cards > 1) {
    const second = record.scenarios[1]!;
    second.successCriteria = 'Клиент получил условия тарифа.';
    second.metrics = scenario.metrics;
    record.trials.push({ ...record.trials[0]!, id: 'f1', scenarioId: second.id, familyId: second.familyId,
      events: [{ seq: 0, type: 'user' as const, text: 'Какой тариф?' }, { seq: 1, type: 'assistant' as const, text: 'Не знаю, уточните в отделении.' }],
      assessments: [{ metricId: 'goal_attainment', result: 'fail' as const, rationale: 'CLIPPED_JUDGE_RATIONALE',
        evidence: [1], citations: [{ seq: 1, quote: 'Не знаю, уточните в отделении.' }] }] });
  }
  record.failureModes = [{ name: 'Агент отказывается решать задачу', description: 'Агент не выполняет просьбу и отправляет клиента в отделение.',
    trialIds: record.trials.map(trial => trial.id), promptQuotes: [] }];
  return record;
}

test('the board overview shows the failure section of result-view, with the pointer and no clipped quote', async () => {
  const record = await failedCard();
  const view = buildResultView(record);
  const section = causeSection(view);
  assert.ok(section, 'the fixture has a failed situation to explain');
  const board = new LabBoard({ record }, theme, () => {}, () => {}, () => 200);
  const cells = boardCells(board);
  assert.ok(cells.includes(SECTION_TEXT[section.kind].board), `board misses the heading ${SECTION_TEXT[section.kind].board}`);
  for (const row of section.rows) {
    if (!row.text.trim()) continue;
    assert.ok(cells.includes(row.text.trim()), `board misses the section row: ${row.text}`);
  }
  assert.ok(cells.includes(SECTION_TEXT.all.hint));
  assert.ok(!cells.includes('ЧТО ТРЕБУЕТ ВНИМАНИЯ'), 'the old block with a clipped quote is gone');
  assert.ok(!cells.some(cell => cell.endsWith('…')), 'nothing on the overview is clipped');
  assert.ok(!cells.some(cell => cell.includes('CLIPPED_JUDGE_RATIONALE')), 'the judge rationale never reaches the overview');
  board.dispose();
});

test('with nothing failed the overview says so and shows no failure heading', async () => {
  const record = await failedCard();
  const view: ResultView = { ...buildResultView(record), failures: [], topCauses: [] };
  const board = new LabBoard({ record, view }, theme, () => {}, () => {}, () => 200);
  const cells = boardCells(board);
  assert.ok(cells.includes('Провалов не зарегистрировано. Это не гарантия качества в реальном трафике.'));
  assert.ok(!cells.includes(SECTION_TEXT.causes.board) && !cells.includes(SECTION_TEXT.failures.board));
  assert.ok(!cells.includes(SECTION_TEXT.all.hint));
  board.dispose();
});

const LONG_TITLE = 'Клиент просит перенести запись на другое время и ждёт подтверждения от агента банка';
const LONG_QUOTE = 'Возврат выполняется через меню терминала в течение тридцати дней с момента покупки, '.repeat(7);
const LONG_REPLY = 'Ничего менять не буду, обратитесь в отделение банка по месту обслуживания вашей организации. '.repeat(3);

test('wrapRows keeps every word of a long explanation inside the board at any width', () => {
  const rows = [
    { text: `✗ ${LONG_TITLE}`, indent: 0 },
    { text: `Должен был: ${LONG_TITLE}`, indent: 2 },
    { text: `Сказал (реплика #1): «${LONG_REPLY}»`, indent: 2 },
    { text: `Правило 3 · Возврат покупки: «${LONG_QUOTE}»`, indent: 5 },
  ];
  const words = (value: string) => value.split(/\s+/).filter(Boolean);
  for (const width of [36, 56, 76, 106, 156]) {
    const wrapped = wrapRows(rows, width);
    for (const row of wrapped) assert.ok(visibleWidth(row.text) <= width, `width ${width}: ${visibleWidth(row.text)} > ${width}`);
    assert.ok(!wrapped.some(row => row.text.includes('…')), `width ${width}: a row was clipped`);
    for (const source of rows.filter(row => row.indent > 0)) {
      const own = wrapRows([source], width);
      assert.ok(own[0]!.text.startsWith(`${' '.repeat(source.indent)}${source.text.slice(0, 1)}`), `width ${width}: the first line lost its indent`);
      for (const row of own.slice(1)) assert.ok(row.text.startsWith(' '.repeat(source.indent + 2)) && row.text[source.indent + 2] !== ' ',
        `width ${width}: continuation lost its hanging indent`);
    }
    assert.deepEqual(words(wrapped.map(row => row.text).join(' ')), words(rows.map(row => row.text).join(' ')), `width ${width}: words changed`);
  }
});

test('Enter on the overview lists every failure in full, before today details', async () => {
  const record = await failedCard(2);
  const view = buildResultView(record);
  assert.equal(view.failures.length, 2);
  const board = new LabBoard({ record }, theme, () => {}, () => {}, () => 3000);
  board.handleInput('\r');
  const cells = boardCells(board, 400);
  assert.equal(cells.filter(cell => cell === SECTION_TEXT.all.board).length, 1);
  const titles = view.failures.map(item => `✗ ${item.title}`);
  const shown = cells.filter(cell => titles.includes(cell));
  assert.deepEqual(shown, titles, 'every failure title appears once, in record order');
  for (const row of failureListRows(view)) if (row.text.trim()) assert.ok(cells.includes(row.text.trim()), `missing: ${row.text}`);
  assert.ok(!cells.some(cell => cell.includes('CLIPPED_JUDGE_RATIONALE')), 'the raw rationale example block is gone');
  assert.ok(cells.some(cell => cell.startsWith('Карточки: синтетических')), 'today provenance rows still follow');
  assert.ok(cells.some(cell => cell.startsWith('Что дальше:')));
  board.dispose();
});

test('every board row keeps one color by its role and fits widths 40 to 160', async () => {
  const record = await failedCard();
  const recording = { fg: (color: string, value: string) => `<${color}>${value}</${color}>`, bold: (value: string) => value };
  const board = new LabBoard({ record }, recording, () => {}, () => {}, () => 3000);
  const painted = board.render(300).join('\n');
  assert.match(painted, /<text>\s*Пример: /, 'the cause example keeps the text token');
  assert.match(painted, /<accent>\s*1\. /, 'the cause name is accent');
  assert.match(painted, /<warning>\s*\? /, 'a not-measured situation is warning');
  assert.match(painted, /<muted>\s*(Правило|и ещё)/, 'rule rows are muted');
  board.handleInput('\r');
  const expanded = board.render(300).join('\n');
  assert.match(expanded, /<error>\s*✗ /, 'a failure title is error');
  board.dispose();
  const wide = new LabBoard({ record }, theme, () => {}, () => {}, () => 3000);
  for (const width of [40, 60, 80, 110, 160]) {
    for (const row of wide.render(width)) assert.ok(visibleWidth(row) <= width, `overflow at ${width}`);
  }
  wide.dispose();
});

test('раздел 2 черновика показывает лист ожиданий, а y и e работают только в его границах', async () => {
  const record = await fixture();
  const recording = { fg: (color: string, value: string) => `<${color}>${value}</${color}>`, bold: (value: string) => value };
  const actions: BoardAction[] = [];
  const board = new LabBoard({ record, section: 'cards' }, theme, a => actions.push(a), () => {}, () => 120);
  const text = stripTerminalSequences(board.render(120).join('\n'));
  assert.match(text, /ЧТО АГЕНТ ДОЛЖЕН СДЕЛАТЬ/);
  assert.match(text, /2 ситуации · номер правила — порядок в ваших материалах/);
  assert.equal(text.match(/Ситуация:/g)?.length, 2, 'обе ситуации на одном листе');
  assert.match(text, /▸\s+1\. Ситуация:/, 'выбранная ситуация помечена гаттером');
  assert.match(text, /\s{2}2\. Ситуация:/, 'невыбранная — двумя пробелами');
  assert.match(text, new RegExp(`Версия ожиданий: ${expectationSheet(record).draftHash.slice(0, 12)}`));
  assert.match(text, /Проверьте ожидания: 2 ситуации\. y — подтвердить все · e — поправить выбранную\./);
  assert.match(text, /\[2 Ситуации 2\]/);
  // Первая строка подвала — четыре ступени по ширине (UI-SPEC «Footer, first line»).
  assert.match(text, /y Подтвердить всё · e Поправить ожидание · r Запустить прогон/, 'inner 81 → средняя ступень');
  assert.match(stripTerminalSequences(board.render(160).join('\n')), /a Правка словами · y Подтвердить ожидания · e Поправить ожидание · r Запустить прогон/);
  assert.match(stripTerminalSequences(board.render(60).join('\n')), /y Подтвердить всё · e Поправить ожидание/);
  assert.match(stripTerminalSequences(board.render(40).join('\n')), /y Подтвердить всё · e Изменить одно/);
  const colored = new LabBoard({ record, section: 'cards' }, recording, () => {}, () => {}, () => 3000);
  const painted = colored.render(300).join('\n');
  assert.match(painted, /<accent>ЧТО АГЕНТ ДОЛЖЕН СДЕЛАТЬ<\/accent>/, 'заголовок листа — accent');
  assert.match(painted, /<warning>Проверьте ожидания/, 'неподтверждённые ожидания — warning');
  assert.match(painted, /<accent>▸ 1\. Ситуация:/, 'выбранная ситуация — accent');
  assert.match(painted, /<text>  2\. Ситуация:/, 'невыбранная — text');
  assert.match(painted, /<muted>\s+Правило 1 · /, 'правила — muted');
  assert.match(painted, /<text>\s+Должен: /, 'ожидание — text');
  colored.dispose();
  board.handleInput('y');
  assert.equal(actions[0]?.type, 'accept');
  assert.equal(actions.length, 1);
  board.handleInput('y');
  assert.equal(actions.length, 1, 'закрытая доска не подтверждает дважды');

  const second = new LabBoard({ record, section: 'cards' }, theme, a => actions.push(a), () => {}, () => 120);
  second.render(120);
  second.handleInput('j');
  second.handleInput('e');
  assert.equal(actions[1]?.type, 'expect');
  if (actions[1]?.type === 'expect') assert.equal(actions[1].scenarioId, record.scenarios[1]!.id);

  // Вне границ листа обе клавиши молчат: другой раздел, сравнение, вопросы, завершённый прогон, поиск, помощь.
  const outside: { record: Experiment; section?: 'agent' | 'cards' | 'results'; keys: string[] }[] = [
    { record, section: 'agent', keys: ['y', 'e'] },
    { record: { ...record, workflow: 'compare' as const }, section: 'cards', keys: ['y', 'e'] },
    { record: { ...record, questions: ['Уточнить правило'] }, section: 'cards', keys: ['y', 'e'] },
    { record: { ...record, phase: 'complete' as const, reviewedAt: record.createdAt }, section: 'cards', keys: ['y', 'e'] },
    { record: { ...record, scenarios: [] }, section: 'cards', keys: ['y', 'e'] },
  ];
  for (const item of outside) {
    const silent: BoardAction[] = [];
    const blocked = new LabBoard({ record: item.record, section: item.section }, theme, a => silent.push(a), () => {}, () => 120);
    blocked.render(120);
    for (const key of item.keys) blocked.handleInput(key);
    assert.equal(silent.length, 0, `клавиши сработали вне области: ${item.record.workflow} ${item.record.phase} ${item.section}`);
    blocked.dispose();
  }
  const searching: BoardAction[] = [];
  const typed = new LabBoard({ record, section: 'cards' }, theme, a => searching.push(a), () => {}, () => 120);
  typed.handleInput('/'); typed.handleInput('y'); typed.handleInput('e');
  assert.equal(searching.length, 0);
  assert.match(stripTerminalSequences(typed.render(120).join('\n')), /Поиск: ye/);
  typed.dispose();
  const helped: BoardAction[] = [];
  const helpBoard = new LabBoard({ record, section: 'cards' }, theme, a => helped.push(a), () => {}, () => 120);
  helpBoard.handleInput('?'); helpBoard.handleInput('y'); helpBoard.handleInput('e');
  assert.equal(helped.length, 0);
  assert.match(stripTerminalSequences(helpBoard.render(120).join('\n')), /y — подтвердить все ожидания · e — поправить ожидание выбранной ситуации/);
  helpBoard.dispose();
  board.dispose(); second.dispose();
});

test('заголовок черновика различает неподтверждённые, подтверждённые и изменённые ожидания, а уведомления — три вида', async () => {
  const record = await fixture();
  const hash = expectationSheet(record).draftHash;
  const recording = { fg: (color: string, value: string) => `<${color}>${value}</${color}>`, bold: (value: string) => value };
  const confirmed = new LabBoard({ record: { ...record, acceptedDraftHash: hash }, section: 'cards' }, recording, () => {}, () => {}, () => 3000);
  assert.match(confirmed.render(300).join('\n'), /<success>Ожидания подтверждены\. r — запуск\./);
  confirmed.dispose();
  const sealed = record.scenarios.map((scenario, index) => ({ testId: `t${index}`, scenarioId: scenario.id,
    definitionHash: fingerprint(scenario), acceptedAt: '2026-09-17T00:00:00Z' }));
  const staleRecord = { ...record, acceptedDraftHash: 'a'.repeat(64), ownerExpectationScenarioIds: [record.scenarios[0]!.id],
    acceptedTests: sealed.map((test, index) => index ? test : { ...test, definitionHash: 'b'.repeat(64) }) };
  const stale = new LabBoard({ record: staleRecord, section: 'cards' }, recording, () => {}, () => {}, () => 3000);
  const staleText = stale.render(300).join('\n');
  assert.match(staleText, /<warning>Ожидание изменено после подтверждения\. y — подтвердить снова\./);
  assert.match(staleText, /<warning>\s+Ожидание изменено владельцем — с прошлыми прогонами не сравнивается\./);
  stale.dispose();
  // The draft hash also covers the judge model, the target fingerprint, the materials and the
  // settings. When every card is still sealed exactly as confirmed, no expectation moved, and the
  // header must not say one did.
  const elsewhere = new LabBoard({ record: { ...record, acceptedDraftHash: 'a'.repeat(64), acceptedTests: sealed }, section: 'cards' },
    recording, () => {}, () => {}, () => 3000);
  const elsewhereText = elsewhere.render(300).join('\n');
  assert.match(elsewhereText, /<warning>Черновик изменился после подтверждения\. y — подтвердить снова\./);
  assert.doesNotMatch(elsewhereText, /Ожидание изменено после подтверждения/);
  elsewhere.dispose();
  const list = new LabBoard({ record: staleRecord, section: 'cards' }, theme, () => {}, () => {}, () => 120);
  assert.match(stripTerminalSequences(list.render(100).join('\n')), / · ожидание изменено/);
  list.dispose();
  for (const [kind, token] of [['success', 'success'], ['info', 'text'], ['error', 'error']] as const) {
    const noticed = new LabBoard({ record, section: 'cards', notice: { message: `УВЕДОМЛЕНИЕ_${kind}`, kind } }, recording, () => {}, () => {}, () => 3000);
    assert.match(noticed.render(300).join('\n'), new RegExp(`<${token}>УВЕДОМЛЕНИЕ_${kind}</${token}>`));
    noticed.dispose();
  }
});

test('лист из 13 ситуаций с 11 правилами прокручивается, держит выбранную наверху и ничего не режет', async () => {
  const record = await fixture();
  const base = record.scenarios[0]!;
  const quote = 'Возврат выполняется через меню терминала «Отмена/Возврат» в течение тридцати календарных дней с даты покупки, если операция не отправлена в клиринг.';
  record.requirements = Array.from({ length: 11 }, (_, i) => ({ id: `rule_${i + 1}`, text: `Правило владельца ${i + 1}`,
    sourceId: record.sources[0]!.id, quote: `${quote} Пункт ${i + 1}.`, critical: true }));
  record.sources[0]!.content = record.requirements.map(r => r.quote).join('\n');
  record.scenarios = Array.from({ length: 13 }, (_, i) => ({ ...structuredClone(base), id: `case_${i + 1}`, familyId: `case_${i + 1}`,
    title: `Ситуация возврата номер ${i + 1} с длинным названием на русском языке`,
    requirementIds: i === 0 ? record.requirements.map(r => r.id) : ['rule_1'],
    user: { ...structuredClone(base.user), goal: `Вернуть деньги по операции номер ${i + 1} на терминале в торговой точке` },
    successCriteria: `Объяснить порядок возврата по операции ${i + 1} и назвать срок зачисления средств на карту клиента.` }));
  const board = new LabBoard({ record, section: 'cards' }, theme, () => {}, () => {}, () => 30);
  for (let step = 0; step < 4; step++) board.handleInput('j');
  for (const width of [40, 60, 80, 110, 160]) {
    const rendered = board.render(width);
    for (const row of rendered) {
      assert.ok(visibleWidth(row) <= width, `шире экрана при ${width}: ${row}`);
      // Рамка режет только заголовок и боковой список; сами строки листа — никогда (UI-SPEC).
      const cell = stripTerminalSequences(row).split('│').at(-2) ?? '';
      if (/Ситуация:|Должен:|Правило|Версия ожиданий|ЧТО АГЕНТ ДОЛЖЕН СДЕЛАТЬ/.test(cell)) {
        assert.doesNotMatch(cell, /…/, `обрезано при ${width}: ${row}`);
      }
    }
    // Первая строка тела — первая строка выбранной ситуации (UI-SPEC F5, прокрутка за выбором).
    const separator = rendered.findIndex(row => /^│ ─+ │$/.test(row));
    assert.ok(separator > 0, `нет разделителя при ${width}`);
    assert.match(rendered[separator + 1]!, /▸\s+5\. Ситуация: Вернуть/, `выбранная ситуация не наверху при ${width}`);
  }
  board.dispose();
  // Все правила первой ситуации попадают на лист целиком: ни одно не свёрнуто в «и ещё K».
  const sheet = expectationSheet(record);
  const shown = sheet.cards[0]!.details.filter(detail => detail.role === 'rule').length;
  assert.ok(shown >= 2, 'у первой ситуации есть правила владельца');
  const tall = new LabBoard({ record, section: 'cards' }, theme, () => {}, () => {}, () => 3000);
  const full = stripTerminalSequences(tall.render(80).join('\n'));
  assert.equal(full.match(/Правило \d+ · /g)?.length, sheet.cards.reduce((sum, card) => sum + card.details.filter(d => d.role === 'rule').length, 0),
    'все правила всех ситуаций на листе');
  assert.doesNotMatch(full, /и ещё \d+ правил/, 'полный лист не сворачивает правила');
  assert.match(full, /Версия ожиданий: /);
  tall.dispose();
});

/** Distinct SGR colors per theme token: the frame measures them as zero-width, so nothing is cut. */
const SGR: Record<string, number> = { accent: 31, error: 32, text: 33, muted: 34, success: 35, warning: 36, borderMuted: 37, dim: 90 };
const sgrTheme = { fg: (color: string, value: string) => `\x1b[${SGR[color] ?? 97}m${value}\x1b[39m`, bold: (value: string) => `\x1b[1m${value}\x1b[22m` };
const painted = (color: string, text: string, bold = false) => `\x1b[${SGR[color]}m${bold ? `\x1b[1m${text}\x1b[22m` : text}\x1b[39m`;
/** The detail pane of a board, one trimmed cell per row: the last cell before the right border. */
function bodyCells(board: LabBoard, width: number): string[] {
  return stripTerminalSequences(board.render(width).join('\n')).split('\n').map(row => (row.split('│').at(-2) ?? '').trim());
}
function blockOf(record: Experiment, trialId = record.trials[0]!.id) {
  assert.equal(typeof cards.agreementBlockLines, 'function', 'cards.ts exports agreementBlockLines (UI-SPEC F10)');
  return cards.agreementBlockLines(record, record.trials.find(trial => trial.id === trialId)!);
}
const KEYS = 'y — согласен · n — не согласен · s — не могу сказать';

test('в разделе 3 провал читается с доказательства, потом «Судья: ✗ не справился», потом клавиши', async () => {
  const record = await failedCard();
  const title = record.scenarios[0]!.title;
  const block = blockOf(record);
  assert.ok(block.length > 0, 'a failed situation with a recorded judge verdict shows the block');
  const board = new LabBoard({ record, section: 'results' }, theme, () => {}, () => {}, () => 3000);
  const cells = bodyCells(board, 120);
  board.dispose();
  const at = (text: string, from = 0) => cells.findIndex((cell, i) => i >= from && cell.startsWith(text));
  const head = at('ПРОВЕРКА СУДЬИ');
  assert.ok(head >= 0, 'the block heading is on the board');
  assert.equal(cells[head + 1], title, 'the title follows the heading, with no verdict glyph');
  assert.equal(cells[head + 2], 'Проверьте провал: сначала прочитайте доказательство.');
  const expected = at('Должен был:', head);
  const said = at('Сказал (реплика #1):', head);
  const judge = at('Судья: ✗ не справился', head);
  const keys = at(KEYS, head);
  assert.ok(expected > head + 2 && said > expected, 'the evidence rows come right after the lead row');
  assert.ok(expected < judge && said < judge, 'the evidence is read before the judge verdict');
  assert.ok(judge < keys, 'the keys come after the verdict');
  assert.equal(cells[keys + 1], '', 'one blank row closes the block');
  assert.ok(at(title, keys) > keys, "today's dialogue rows follow the block");
  assert.ok(!cells.slice(head, keys + 1).some(cell => cell.includes('✗') && !cell.startsWith('Судья:')), 'no ✗ before or beside the title');

  const colored = new LabBoard({ record, section: 'results' }, sgrTheme, () => {}, () => {}, () => 3000);
  const rows = colored.render(120).join('\n');
  colored.dispose();
  assert.ok(rows.includes(painted('accent', 'ПРОВЕРКА СУДЬИ', true)), 'the heading is accent and bold');
  assert.ok(rows.includes(painted('text', title, true)), 'the title is text and bold');
  assert.ok(rows.includes(painted('muted', 'Проверьте провал: сначала прочитайте доказательство.')), 'the lead row is muted');
  assert.ok(rows.includes(painted('error', 'Судья: ✗ не справился')), 'the judge row is error');
  assert.ok(rows.includes(painted('accent', KEYS)), 'the key row is accent, not bold');
  assert.ok(rows.includes(painted('text', '  Должен был: Время изменилось на 14:00.')), 'an expectation row keeps the phase-2 text token');
});

/** A block row by its text start; the block is read as the board gets it, before wrapping. */
const rowOf = (rows: ReturnType<typeof blockOf>, start: string) => rows.find(row => row.text.startsWith(start));
const STALE = 'Ваша отметка устарела: судья сменился. Отметьте заново: y · n · s';
const CHANGE = 'Изменить отметку: y согласен · n не согласен · s не могу сказать';

test('успех из выборки и вне её, отметки и устаревшие отметки дают свои строки блока', async () => {
  const passes = await queueFixture(0, 4, false);
  const sample = agreementSample(passes);
  const spare = passes.trials.find(trial => !sample.includes(trial.id))!.id;
  const sampled = blockOf(passes, sample[0]);
  assert.equal(rowOf(sampled, 'Проверьте')?.text, 'Проверьте и успех: судья мог ошибочно похвалить.');
  assert.deepEqual([rowOf(sampled, 'Судья:')?.text, rowOf(sampled, 'Судья:')?.color], ['Судья: ✓ справился', 'success']);
  assert.ok(!sampled.some(row => row.text.includes('Нарушено правило')));
  assert.ok(sampled.findIndex(row => row.text.startsWith('Сказал')) < sampled.findIndex(row => row.text.startsWith('Судья:')));
  assert.equal(blockOf(passes, spare)[2]?.text, 'Судья счёл ситуацию успешной. Проверьте, если сомневаетесь.');

  const record = await judgedFixture('m', 'fail');
  const withMark = (verdict: 'pass' | 'fail' | 'unknown', note: string, extra: object = {}) => {
    const copy = structuredClone(record); copy.humanReviews = [{ ...quickMark('m', verdict, 'fail', note), ...extra }]; return blockOf(copy);
  };
  const fresh = blockOf(record);
  assert.deepEqual([rowOf(fresh, 'y — ')?.text, rowOf(fresh, 'y — ')?.color], [KEYS, 'accent']);
  assert.ok(!rowOf(fresh, 'Ваша отметка'));

  const agreed = withMark('fail', 'Быстрая отметка: согласен с судьёй.');
  assert.deepEqual([rowOf(agreed, 'Изменить')?.text, rowOf(agreed, 'Изменить')?.color], [CHANGE, 'muted']);
  assert.deepEqual([rowOf(agreed, 'Ваша отметка')?.text, rowOf(agreed, 'Ваша отметка')?.color], ['Ваша отметка: = согласен', 'success']);
  assert.ok(!rowOf(agreed, 'y — ') && !rowOf(agreed, 'Причина'), 'an agree mark has no reason row and no first-time keys');
  assert.ok(!agreed.some(row => row.text.includes('Быстрая отметка')), 'the stored note of a quick mark is never shown');

  const disagreed = withMark('pass', 'Судья   не учёл\n  уточнение клиента.');
  assert.deepEqual([rowOf(disagreed, 'Ваша отметка')?.text, rowOf(disagreed, 'Ваша отметка')?.color], ['Ваша отметка: ! не согласен', 'warning']);
  const reason = rowOf(disagreed, 'Причина');
  assert.deepEqual([reason?.text, reason?.color, reason?.indent], ['Причина: «Судья не учёл уточнение клиента.»', 'text', 2]);
  assert.equal(disagreed.indexOf(reason!) - disagreed.indexOf(rowOf(disagreed, 'Ваша отметка')!), 1, 'the reason sits under the mark');
  assert.ok(rowOf(disagreed, 'Изменить'));

  const unsure = withMark('unknown', 'Быстрая отметка: не могу сказать.');
  assert.deepEqual([rowOf(unsure, 'Ваша отметка')?.text, rowOf(unsure, 'Ваша отметка')?.color], ['Ваша отметка: ~ не могу сказать', 'muted']);
  assert.ok(rowOf(unsure, 'Изменить'));

  const tampered = withMark('pass', 'Судья не учёл уточнение клиента.', { judge: { protocolHash: 'old-protocol', inputHash: 'old-input' } });
  const carried = structuredClone(record);
  carried.sourceEvidence = { runId: 'source-run', trials: structuredClone(record.trials), humanReviews: [quickMark('m', 'fail', 'fail', 'Быстрая отметка: согласен с судьёй.')] };
  for (const [label, stale] of [['judge hash', tampered], ['source run', blockOf(carried)]] as const) {
    assert.deepEqual([rowOf(stale, 'Ваша отметка устарела')?.text, rowOf(stale, 'Ваша отметка устарела')?.color], [STALE, 'warning'], label);
    assert.ok(!rowOf(stale, 'y — ') && !rowOf(stale, 'Изменить') && !rowOf(stale, 'Ваша отметка:') && !rowOf(stale, 'Причина'), `${label}: the stale row replaces keys and mark`);
    assert.ok(stale.findIndex(row => row.text.startsWith('Судья:')) < stale.findIndex(row => row.text === STALE));
  }

  // Role → token (UI-SPEC «Row role → token»).
  assert.deepEqual([fresh[0]?.color, fresh[0]?.bold, fresh[1]?.color, fresh[1]?.bold, fresh[2]?.color], ['accent', true, 'text', true, 'muted']);
  assert.equal(fresh.at(-1)?.text, '', 'one blank row closes the block');
  assert.ok(!rowOf(fresh, 'y — ')?.bold, 'the key row is not bold');
});

test('контрольная ситуация и ситуация без решения судьи показывают одну приглушённую строку и не отвечают на y, n, s', async () => {
  const record = await judgedFixture('c', 'fail');
  const control = structuredClone(record); control.positiveControlScenarioIds = [control.scenarios[0]!.id];
  const undecided = structuredClone(record); undecided.trials[0]!.assessments = [{ metricId: 'goal', result: 'unknown', rationale: 'Судья не решил', evidence: [0] }];
  const unjudged = structuredClone(record); delete unjudged.trials[0]!.assessments;
  const cases: [Experiment, string][] = [
    [control, 'Контрольная ситуация — в согласие с судьёй не входит.'],
    [undecided, 'Судья не вынес решения — отметка согласия не нужна.'],
    [unjudged, 'Судья не вынес решения — отметка согласия не нужна.'],
  ];
  for (const [subject, text] of cases) {
    assert.deepEqual(blockOf(subject).map(row => [row.text, row.color]), [[text, 'muted']], text);
    const actions: BoardAction[] = [];
    const board = new LabBoard({ record: subject, section: 'results' }, theme, a => actions.push(a), () => {}, () => 3000);
    const cells = bodyCells(board, 100);
    const first = cells.findIndex(cell => cell.startsWith(text));
    assert.ok(first >= 0 && cells.findIndex(cell => cell === subject.scenarios[0]!.title) > first, 'the row opens the detail pane');
    assert.ok(!cells.includes('ПРОВЕРКА СУДЬИ'));
    assert.ok(cells.some(cell => cell.startsWith('Вердикта человека нет')), 'without the block the row that names v stays');
    for (const key of ['y', 'n', 's']) board.handleInput(key);
    assert.deepEqual(actions, [], text);
    board.dispose();
  }
});

test('быстрая отметка не повторяется под ОТДЕЛЬНОЙ ПРОВЕРКОЙ ЧЕЛОВЕКОМ, а доказательство после несогласия то же', async () => {
  const record = await judgedFixture('q', 'fail');
  record.humanReviews = [quickMark('q', 'fail', 'fail', 'Быстрая отметка: согласен с судьёй.'),
    { id: 'h-full', trialId: 'q', checkId: 'time', verdict: 'fail', note: 'Полная проверка: запись не переставлена.', createdAt: '2026-09-17T00:00:00.000Z' }];
  const board = new LabBoard({ record, section: 'results' }, theme, () => {}, () => {}, () => 3000);
  const cells = bodyCells(board, 100);
  board.dispose();
  const human = cells.indexOf('ОТДЕЛЬНАЯ ПРОВЕРКА ЧЕЛОВЕКОМ');
  assert.ok(human >= 0);
  assert.deepEqual(cells.slice(human + 1, human + 3), ['НЕ ПРОЙДЕНО · проверка time', 'Полная проверка: запись не переставлена.']);
  assert.ok(!cells.includes('Быстрая отметка: согласен с судьёй.'), 'the quick mark is shown by the block only');
  assert.ok(!cells.some(cell => cell.startsWith('Вердикта человека нет')));
  const trial = record.trials[0]!;
  assert.ok(cards.trialLines(trial, record, false).some(row => row.text === 'Быстрая отметка: согласен с судьёй.'), 'other callers still list every review');
  const bare = structuredClone(record); bare.humanReviews = [];
  assert.ok(cards.trialLines(bare.trials[0]!, bare, false).some(row => row.text.startsWith('Вердикта человека нет')));
  assert.ok(!cards.trialLines(bare.trials[0]!, bare, false, true).some(row => row.text.startsWith('Вердикта человека нет')));

  const failed = await failedCard();
  const evidence = (rows: ReturnType<typeof blockOf>) => rows.slice(3, rows.findIndex(row => row.text.startsWith('Судья:'))).map(row => row.text);
  const before = evidence(blockOf(failed));
  assert.ok(before.length >= 2);
  failed.humanReviews = [{ id: 'q-dis', trialId: 'f0', metricId: 'goal_attainment', source: 'quick', verdict: 'pass', judgeVerdict: 'fail',
    note: 'Агент поступил верно.', createdAt: '2026-09-17T00:00:00.000Z' }];
  const after = blockOf(failed);
  assert.equal(rowOf(after, 'Ваша отметка')?.text, 'Ваша отметка: ! не согласен');
  assert.deepEqual(evidence(after), before, 'the owner judged the same evidence that is shown after the mark');
});

test('блок согласия с длинной причиной и управляющей последовательностью помещается в 36–156 колонок без обрезки', async () => {
  const record = await failedCard();
  record.scenarios[0]!.title = LONG_TITLE;
  record.trials[0]!.events[1]!.text = LONG_REPLY;
  record.trials[0]!.assessments![0]!.citations = [{ seq: 1, quote: LONG_REPLY.trim() }];
  const reason = `${'Судья не заметил, что агент предложил клиенту перенос записи и дождался подтверждения. '.repeat(3)}\n\n`
    + `Второй абзац:\x1b[31m ${'клиент получил ответ по существу, и это видно из реплики. '.repeat(3)}`;
  assert.ok(reason.length > 400);
  record.humanReviews = [{ id: 'q-long', trialId: 'f0', metricId: 'goal_attainment', source: 'quick', verdict: 'pass', judgeVerdict: 'fail',
    note: reason, createdAt: '2026-09-17T00:00:00.000Z' }];
  const block = blockOf(record);
  const unmarked = structuredClone(record); unmarked.humanReviews = [];
  const keyRow = rowOf(blockOf(unmarked), 'y — ');
  assert.ok(keyRow, 'an unmarked situation shows the key row');
  const words = (value: string) => value.split(/\s+/).filter(Boolean);
  const reasonRow = rowOf(block, 'Причина');
  assert.ok(reasonRow, 'a disagreement shows its reason in the block');
  assert.deepEqual(words(reasonRow.text), words(`Причина: «${reason.replace('\x1b[31m', '').trim()}»`), 'every word of the reason, in order');
  for (const width of [36, 56, 76, 106, 156]) {
    const wrapped = wrapRows(block, width);
    for (const row of wrapped) assert.ok(visibleWidth(row.text) <= width, `width ${width}: ${visibleWidth(row.text)} > ${width}`);
    assert.ok(!wrapped.some(row => row.text.includes('…')), `width ${width}: a row was clipped`);
    assert.ok(!wrapped.some(row => row.text.includes('\x1b')), `width ${width}: an escape byte reached the board`);
    assert.deepEqual(words(wrapped.map(row => row.text).join(' ')), words(block.map(row => row.text).join(' ')), `width ${width}: words changed`);
    for (const source of block.filter(row => (row.indent ?? 0) > 0)) {
      for (const row of wrapRows([source], width).slice(1)) {
        assert.ok(row.text.startsWith(' '.repeat(source.indent! + 2)) && row.text[source.indent! + 2] !== ' ', `width ${width}: hanging indent lost in «${source.text.slice(0, 20)}»`);
      }
    }
    // The key row sits at column 0, continues at column 2 and breaks only at «·».
    const keys = wrapRows([keyRow], width);
    assert.equal(keys.length, width >= 52 ? 1 : 2, `width ${width}: key row lines`);
    for (const row of keys.slice(1)) assert.match(row.text, /^ {2}[yns] — /, `width ${width}: key row continuation`);
    for (const row of keys) assert.match(row.text.trim(), /^[yns] — .*[^·\s]( ·)?$/, `width ${width}: key row breaks at «·»`);
  }
  const change = structuredClone(record); change.humanReviews[0]!.verdict = 'fail';
  for (const row of wrapRows([rowOf(blockOf(change), 'Изменить')!], 36).slice(1)) assert.match(row.text, /^ {2}[ns] /, 'the change hint breaks at «·» too');
});
