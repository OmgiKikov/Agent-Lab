import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth, stripTerminalSequences } from '@earendil-works/pi-tui';
import { LabBoard, reviewOrder, safeText, wrapRows, type BoardAction, type BoardOptions } from '../extensions/cards.ts';
import { htmlReport } from '../src/report.js';
import { createDemoRuntime, demoInput } from '../src/demo.js';
import { emptyUsage, fingerprint, type Experiment } from '../src/contracts.js';
import { compareRuns } from '../src/comparison.js';
import { evidenceBundle } from '../src/artifacts.js';
import { markdownReport } from '../src/report.js';
import { buildResultView, causeSection, failureListRows, resultViewLines, SECTION_TEXT, type ResultView } from '../src/result-view.js';
import { expectationSheet } from '../src/quality.js';

const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value };

test('a quick verdict includes time spent reading the selected dialogue', async () => {
  const record = await fixture(); record.phase = 'results_review'; record.reviewedAt = new Date().toISOString();
  const scenario = record.scenarios[0]!;
  record.trials = [{ id: 'timed', revisionId: 'revision-1', scenarioId: scenario.id, familyId: scenario.familyId,
    repeat: 0, userMode: 'static', split: 'dev', manifestHash: 'hash', outcome: 'ungraded', reason: '', checks: [],
    events: [{ seq: 0, type: 'assistant', text: 'Recorded answer' }], initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 10 }];
  let action: BoardAction | undefined;
  const reviewTimes = new Map([[`${record.id}|timed`, 100]]);
  const board = new LabBoard({ record, section: 'results', reviewTimes }, theme, value => { action = value; }, () => {});
  board.render(120);
  await new Promise(resolve => setTimeout(resolve, 20));
  board.handleInput('n');
  assert.equal(action?.type, 'verdict');
  if (action?.type === 'verdict') { assert.equal(action.trialId, 'timed'); assert.ok(action.reviewMs! >= 115); }
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
  assert.match(reviewed.render(120).join('\n'), /Вердикта человека нет/);
  assert.doesNotMatch(reviewed.render(120).join('\n'), /Набор проверен человеком|Разбор набора завершён/);
  reviewed.dispose();
});

test('разбор начинается с провалов без вердикта, счётчик их считает, вердикт ставится одной клавишей', async () => {
  const record = await fixture();
  record.phase = 'results_review';
  const scenario = record.scenarios[0]!;
  const trial = (id: string, outcome: 'pass' | 'fail') => ({
    id, revisionId: 'revision-1', scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0, split: 'dev' as const,
    manifestHash: 'hash', outcome, reason: outcome === 'pass' ? 'Все объективные проверки пройдены.' : 'Часть объективных проверок провалена.',
    checks: [{ id: 'time', description: 'Запись переставлена', passed: outcome === 'pass', evidence: 'e' }],
    events: [], initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1,
  });
  // Порядок в записи нарочно неудобный: пройденный первым, неразобранный провал последним.
  record.trials = [trial('t_pass', 'pass'), trial('t_done', 'fail'), trial('t_pending', 'fail')];
  record.humanReviews = [{ id: 'h1', trialId: 't_done', verdict: 'fail', note: 'разобрано', createdAt: record.createdAt }];

  const actions: BoardAction[] = [];
  const board = new LabBoard({ record, section: 'results' }, theme, a => actions.push(a), () => {}, () => 40);
  const text = stripTerminalSequences(board.render(120).join('\n'));
  assert.match(text, /Разбор: осталось 1 провал\(ов\) из 2/);
  assert.match(text, /Запись переставлена/, 'первым открыт тот диалог, который ждёт человека');

  board.handleInput('p');
  const verdict = actions[0];
  assert.equal(verdict?.type, 'verdict');
  assert.equal(verdict.type === 'verdict' && verdict.verdict, 'pass');
  assert.equal(verdict.type === 'verdict' && reviewOrder(record)[verdict.selected]?.id, 't_pending');
  board.dispose();

  const failing: BoardAction[] = [];
  const second = new LabBoard({ record, section: 'results' }, theme, a => failing.push(a), () => {}, () => 40);
  second.handleInput('n');
  assert.equal(failing[0]?.type === 'verdict' && failing[0].verdict, 'fail');
  second.dispose();

  // Пока диалоги идут, вердикт ставить не по чему.
  const running: BoardAction[] = [];
  const active = new LabBoard({ record: { ...record, phase: 'evaluating' }, section: 'results' }, theme, a => running.push(a), () => {}, () => 40);
  active.handleInput('p');
  assert.deepEqual(running, []);
  active.dispose();

  const reviewed = { ...record, humanReviews: [...record.humanReviews, { id: 'h2', trialId: 't_pending', verdict: 'pass' as const, note: 'ok', createdAt: record.createdAt }] };
  assert.match(stripTerminalSequences(new LabBoard({ record: reviewed, section: 'results' }, theme, () => {}, () => {}, () => 40).render(120).join('\n')),
    /Замечания человека: 1 диалогов · расхождения оценок: 1/);
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

test('filtered review targets the visible trial ID and help cannot accidentally submit a verdict', async () => {
  const record = await fixture(); record.phase = 'results_review';
  record.trials = record.scenarios.map((s, i) => ({ id: `trial-${i}`, scenarioId: s.id, revisionId: 'r', familyId: s.familyId, repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: 'h', outcome: 'fail', reason: '', checks: [{ id: 'c', passed: false, evidence: '', description: 'c' }], events: [], initialState: s.initialState, finalState: s.initialState, elapsedMs: 1, usage: emptyUsage() }));
  record.scenarios[0]!.title = 'Первый'; record.scenarios[1]!.title = 'Возврат';
  const actions: BoardAction[] = [];
  const board = new LabBoard({ record, section: 'results' }, theme, a => actions.push(a), () => {}, () => 30);
  board.handleInput('?'); board.handleInput('n'); assert.equal(actions.length, 0); board.handleInput('?');
  board.handleInput('/'); board.handleInput('Возврат'); board.handleInput('\r');
  const lines = board.render(120);
  assert.ok(lines.at(-1)?.endsWith('╯'), 'footer fits the terminal');
  assert.match(lines.join('\n'), /Возврат/);
  board.handleInput('n');
  assert.equal(actions[0]?.type === 'verdict' && actions[0].trialId, 'trial-1');
  const discussion = new LabBoard({ record, section: 'cards', query: 'Возврат' }, theme, a => actions.push(a), () => {});
  discussion.handleInput('a');
  assert.equal(actions[1]?.type === 'discuss' && record.scenarios[actions[1].selected]?.id, record.scenarios[1]!.id);
  const empty = new LabBoard({ records: [] }, theme, a => actions.push(a), () => {});
  empty.handleInput('n'); assert.equal(actions[2]?.type, 'new');
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
  const staleRecord = { ...record, acceptedDraftHash: 'a'.repeat(64), ownerExpectationScenarioIds: [record.scenarios[0]!.id] };
  const stale = new LabBoard({ record: staleRecord, section: 'cards' }, recording, () => {}, () => {}, () => 3000);
  const staleText = stale.render(300).join('\n');
  assert.match(staleText, /<warning>Ожидание изменено после подтверждения\. y — подтвердить снова\./);
  assert.match(staleText, /<warning>\s+Ожидание изменено владельцем — с прошлыми прогонами не сравнивается\./);
  stale.dispose();
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
