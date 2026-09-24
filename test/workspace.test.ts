import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { judgedScreen } from '../extensions/workspace-screens.ts';
import { workspaceView } from '../extensions/board-command.ts';
import { LabWorkspace, newState, type WorkspaceView } from '../extensions/workspace.ts';
import { launchRun } from '../extensions/launch.ts';
import { NeedsOwner } from '../extensions/lab-ui.ts';
import { EXTERNAL_AGENT } from '../src/card/prepare.js';
import { hostGrant } from '../src/card/commands.js';
import { situationViews } from '../src/card/view.js';
import { createInputSchema, runnableTarget, UNCONNECTED, type Experiment } from '../src/contracts.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { decisions } from '../src/inbox.js';
import { consentText, type PreparationConsent } from '../src/miner/plan.js';
import { recurringProblems } from '../src/problems.js';
import { buildResultView } from '../src/result-view.js';
import { agentName, agentSpaces } from '../src/workspace.js';
import { cardInput, cardRuntime } from './helpers/card-prep.js';
import { demoFolder, KEYS, openWorkspace, richFolder, storedFolder } from './helpers/workspace.js';

/*
 * The agent's workspace (docs/design/ui-spec.md §8) on synthetic folders: it opens on what needs the owner, says everything in the
 * owner's words — no ids, hashes or JSON —, fits every width, keeps five keys in its footer, and its decisions, problems
 * and agents are derived from the records alone. Stored first-format runs open through the same screens.
 */

let rich: Awaited<ReturnType<typeof richFolder>>;
before(async () => { rich = await richFolder(); });
after(async () => { await rm(rich.cwd, { recursive: true, force: true }); });

/** Every record id of a folder long enough to be told from words (a fixture may title a situation after its short id): none may reach the screen. */
async function idsOf(directory: string): Promise<string[]> {
  const records = await new ExperimentLab(directory).list();
  return records.flatMap(record => [record.id, ...record.trials.map(trial => trial.id), ...record.scenarios.map(scenario => scenario.id)]).filter(id => id.length >= 8);
}

/** The footer of a drawn screen: the line above the closing frame. */
const footerOf = (screen: string) => screen.split('\n').at(-2)!.trim();

/**
 * What any workspace screen must hold to: the width, the owner's words, at most five keys. Only «d — как это
 * проверяется», the developer's view of a situation, names its record by id and version (docs/design/ui-spec.md §3.5).
 */
function assertClean(screen: string, width: number, ids: readonly string[], where: string, developer = false): void {
  for (const line of screen.split('\n')) assert.ok(visibleWidth(line) <= width, `${where} at ${width}: «${line}» is wider than the terminal`);
  if (!developer) for (const id of ids) assert.ok(!screen.includes(id), `${where}: the record id ${id} is on screen`);
  if (!developer) assert.doesNotMatch(screen, /\b[0-9a-f]{12,}\b/, `${where}: a hash is on screen`);
  assert.doesNotMatch(screen, /[{[]"|"[}\]]/, `${where}: JSON is on screen`);
  const keys = footerOf(screen).split(' · ').length;
  assert.ok(keys <= 5, `${where}: ${keys} keys in the footer`);
}

test('the workspace opens on the decisions that wait for the owner: one phrase and the actions under each, the queue counted in the header', async () => {
  const { screen, press, actions } = await openWorkspace(rich.directory);
  const text = screen(100);
  assert.match(text, /^ Агент: агент поддержки +версия baseline-v1$/m);
  assert.match(text, /^ Нужно ваше решение: 2 {2}· {2}Ситуации 13 {2}· {2}Прогоны 2 {2}· {2}Проблемы 2$/m);
  assert.match(text, /^ 2 решения ждут вас\. Запуску готовых ситуаций они не мешают\.$/m);
  // The unusable situation first — it spoils the measurement —, then the question about another one.
  assert.match(text, /^ › Ситуация \d+ · Подключение терминала — нет сети\n {4}В ваших материалах нет правила о подключении терминала — судье не с чем сравнить ответ\.\n {4}1 Добавить правило {2}· {2}2 Исключить из запуска$/m);
  assert.match(text, /^ {3}Ситуация \d+ · Возврат оплаты — покупка вчера$/m);
  assert.equal(footerOf(text), '↑↓ выбрать · 1–3 решить · Enter открыть · ←→ области · ? клавиши');
  // A digit takes the decision's choice; the one that settles it goes to the command, which asks natively.
  press(KEYS.down, '1');
  const [action] = actions;
  assert.ok(action?.type === 'decide' && action.choice.action.kind === 'answer', JSON.stringify(action));
  assert.equal(action.choice.label, 'Да');
});

test('the areas go by ←→: the situations lead with the coverage of the logs, the runs with the number, the problems with what repeats', async () => {
  const { press } = await openWorkspace(rich.directory);
  const situations = press(KEYS.right);
  assert.match(situations, /^ 11 ситуаций покрывают 5 из 5 тем — 100% диалогов$/m);
  assert.match(situations, /^ Ситуации прогона .+; изменения пойдут в новый черновик, прогон не меняется\.$/m);
  assert.match(situations, /^ › 1 {2}.+ +✓ готова\n {6}Клиент: «.+»\n {6}Агент должен: .+\n {6}1 Изменить {2}· {2}2 Добавить похожую {2}· {2}3 Не проверять$/m);
  const runs = press(KEYS.right);
  assert.match(runs, /^ Точность агента: 64% — справился в 7 из 11 ситуаций$/m);
  assert.match(runs, /^ По темам +справился +доля диалогов$/m);
  assert.match(runs, /^ › 1 {2}Переспрашивает номер вместо ответа по заявке +3 ситуации$/m);
  assert.match(runs, /^ {3}Проверить, прав ли судья — 4 ошибки ждут вашего «да» или «нет», 3 успеха на перепроверку$/m);
  assert.match(runs, /· было 64% \(/, 'the run line names the run before it');
  const problems = press(KEYS.right);
  assert.match(problems, /^ 2 повторяющиеся проблемы: 2 в агенте$/m);
  assert.match(problems, /^ › 1 {2}Переспрашивает номер вместо ответа по заявке +3 ситуации · 2 прогона подряд$/m);
  const problem = press(KEYS.enter);
  assert.match(problem, /^ {4}«Уточните номер терминала\.» — ситуация «Статус заявки — .+»$/m, 'the agent\'s own words, checked against the recorded reply');
  assert.match(footerOf(problem), /^1–3 действие · a спросить Lab · ↑↓ листать · Esc назад$/);
  // Back to the queue: ←→ go round.
  assert.match(press(KEYS.escape, KEYS.right), /^ 2 решения ждут вас/m);
});

test('every main screen of the workspace fits 40 to 160 columns, keeps five keys in its footer and shows no id, hash or JSON', async () => {
  const ids = await idsOf(rich.directory);
  const screens: [string, (state: import('../extensions/workspace.ts').WorkspaceState) => void, string[]][] = [
    ['inbox', () => {}, []],
    ['situations', state => { state.area = 'situations'; }, []],
    ['situation', state => { state.area = 'situations'; }, [KEYS.enter]],
    ['situation details', state => { state.area = 'situations'; }, [KEYS.enter, 'd']],
    ['question', state => { state.area = 'inbox'; state.selected['area:inbox'] = 1; }, [KEYS.enter]],
    ['unusable', state => { state.area = 'inbox'; }, [KEYS.enter]],
    ['runs', state => { state.area = 'runs'; }, []],
    ['runs details', state => { state.area = 'runs'; }, ['d']],
    ['all runs', state => { state.area = 'runs'; }, ['3']],
    ['failure', state => { state.area = 'runs'; }, [KEYS.enter]],
    ['judge review', state => { state.area = 'runs'; }, [KEYS.down, KEYS.down, KEYS.enter]],
    ['problems', state => { state.area = 'problems'; }, []],
    ['problem', state => { state.area = 'problems'; }, [KEYS.enter]],
    ['help', () => {}, ['?']],
  ];
  for (const [name, setup, keys] of screens) {
    const { press, screen, board } = await openWorkspace(rich.directory, setup);
    press(...keys);
    for (const width of [40, 60, 70, 100, 140, 160]) assertClean(screen(width), width, ids, name, name === 'situation details');
    board.dispose();
  }
});

test('a judged conversation asks one question with three answers; the answer carries the decision it was about', async () => {
  const { press, actions } = await openWorkspace(rich.directory, state => { state.area = 'runs'; });
  const failure = press(KEYS.enter);
  assert.match(failure, /^ ✗ 1 {2}Статус заявки — .+ +ошибка 1 из \d+$/m);
  assert.match(failure, /^ +Агент ответил +«Уточните номер терминала\.»$/m);
  assert.match(failure, /^ Судья решил: не справился\. Вы согласны\? +1 да · 2 нет · 3 не знаю$/m);
  press('2');
  const [mark] = actions;
  assert.ok(mark?.type === 'mark');
  assert.deepEqual([mark.answer, mark.seen], ['disagree', 'fail']);
  // The judge's review walks its queue: failures first, then the passes drawn for a double-check.
  const review = await openWorkspace(rich.directory, state => { state.area = 'runs'; });
  assert.match(review.press(KEYS.down, KEYS.down, KEYS.enter), /^ Проверка судьи: 1 из 7$/m);
});

test('a conversation the judge could not decide or a control carries no question: the screen says why and the digits do nothing', async () => {
  const stored = await storedFolder('legacy-demo-run');
  try {
    const record = (await new ExperimentLab(stored.directory).list())[0]!;
    const run = { record, view: buildResultView(record) };
    const trial = record.trials[0]!;
    const control = judgedScreen({ ...run, record: { ...record, positiveControlScenarioIds: [trial.scenarioId] } }, trial.id, undefined, undefined, 100);
    const text = control.body.map(line => line.map(part => part.text).join('')).join('\n');
    assert.match(text, /Контрольная ситуация: в проверку судьи не входит\./);
    assert.doesNotMatch(text, /Вы согласны\?/);
    assert.ok(!control.foot.some(hint => hint.key === '1–3'), 'no answers are offered');
  } finally { await rm(stored.cwd, { recursive: true, force: true }); }
});

test('before the first result the workspace walks Ситуации › Прогон › Результат, and the plan says what runs and what stays out', async () => {
  const demo = await demoFolder();
  try {
    const { screen, press, actions } = await openWorkspace(demo.directory);
    const situations = screen(100);
    assert.match(situations, /^ Agent Lab · Учебный агент возвратов +учебный пример$/m);
    assert.match(situations, /^ Ситуации 1\/2 {2}› {2}Прогон {2}› {2}Результат$/m);
    assert.match(situations, /^ 2 ситуации: 1 готова · 1 ждёт вашего ответа$/m);
    assert.match(situations, /^ Готовые можно запускать уже сейчас; остальные войдут, когда ответите\.$/m);
    const plan = press(KEYS.right);
    assert.match(plan, /^ Готово к запуску: 1 ситуация, 2 разговора$/m);
    assert.match(plan, /^ {4}Не войдут {3}1 ждёт вашего ответа$/m);
    assert.match(plan, /^ {4}Расход {6}без модели и оплаты — учебный пример$/m);
    assert.equal(footerOf(plan), 'Enter запустить · ← ситуации · Esc закрыть');
    // There is no result yet, so → goes no further; Enter asks the command to run the ready situations.
    assert.match(press(KEYS.right), /Готово к запуску/);
    press(KEYS.enter);
    assert.deepEqual(actions, [{ type: 'run' }]);
  } finally { await rm(demo.cwd, { recursive: true, force: true }); }
});

test('while work goes on the workspace follows it: a reported change reads it again, no timer does, and the end of the work ends the following', async t => {
  const folder = await demoFolder();
  t.after(() => rm(folder.cwd, { recursive: true, force: true }));
  const state = newState();
  const quiet = await workspaceView(new ExperimentLab(folder.directory), state, undefined);
  // The same folder as it looks while a run goes on: its records with the progress row of the work.
  const going: WorkspaceView = { ...quiet, data: { ...quiet.data!, progress: { text: 'Прогон: 1 из 4 разговоров', share: 0.25, stoppable: false } } };
  const views = [going, going, quiet];
  let reads = 0, stops = 0;
  let report: (() => void) | undefined;
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const plain = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
  let draws = 0;
  const board = new LabWorkspace(going, state, plain as never, () => {}, () => { draws++; }, () => 44, async () => views[reads++] ?? quiet,
    changed => { report = changed; return () => { stops++; }; });
  const spinner = () => board.render(100).map(line => stripTerminalSequences(line)).find(line => line.includes('Прогон: 1 из 4 разговоров'))!.trim()[0];
  const settled = async () => { for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve)); };
  const before = spinner();
  t.mock.timers.tick(80);
  assert.notEqual(spinner(), before, 'the spinner turns on its own clock, the pace of Pi\'s Loader');
  t.mock.timers.tick(60_000);
  await settled();
  assert.equal(reads, 0, 'a minute without a change reads nothing: the clock only draws, no timer asks again and again');
  report!(); report!();
  await settled();
  assert.deepEqual([reads, stops], [2, 0], 'a change reported during a read is read once more after it — never lost, never read twice at once; the work still goes on');
  report!();
  await settled();
  assert.deepEqual([reads, stops], [3, 1], 'the work is over: the workspace stops following');
  const drawn = draws;
  t.mock.timers.tick(60_000);
  assert.equal(draws, drawn, 'and its spinner stops with it');
  board.dispose();
});

test('stored first-format runs open on their result, their situations only read, their failures explained the same way', async () => {
  for (const fixture of ['recorded-run', 'legacy-demo-run'] as const) {
    const stored = await storedFolder(fixture);
    try {
      const ids = await idsOf(stored.directory);
      const { screen, press } = await openWorkspace(stored.directory);
      const runs = screen(100);
      assert.match(runs, /^ Агент: .+$/m);
      assert.match(runs, /^ Точность агента: /m, fixture);
      assertClean(runs, 100, ids, `${fixture} runs`);
      // A failure, when the run has one, opens on its evidence.
      assertClean(press(KEYS.enter), 100, ids, `${fixture} failure`);
      const situations = (await openWorkspace(stored.directory, state => { state.area = 'situations'; })).screen(70);
      assert.match(situations, /Старый формат: эти ситуации можно посмотреть, но не изменить\./, fixture);
      assert.doesNotMatch(situations, /1 Изменить|1–3 действие/, 'a stored run offers nothing to change');
      assertClean(situations, 70, ids, `${fixture} situations`);
    } finally { await rm(stored.cwd, { recursive: true, force: true }); }
  }
});

test('the queue of decisions is derived from the records: an answered question leaves it, and disputed situations never block the ready ones', async () => {
  const lab = new ExperimentLab(rich.directory);
  await lab.init();
  try {
    const newest = (await lab.list()).filter(record => record.trials.length).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
    const draft = await lab.editableCards(newest.id);
    const context = await lab.cardContext(draft.id);
    const views = situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: 3 });
    const before = decisions({ draft: { record: context.experiment, views, pendingCalls: 0 } });
    assert.deepEqual(before.map(item => item.choices.map(choice => choice.label)), [['Добавить правило', 'Исключить из запуска'], ['Да', 'Сказать иначе']]);
    assert.ok(views.filter(view => view.status === 'ready').length >= 11, 'the ready situations stay runnable while two wait');
    // The owner answers the question: the decision is gone the next time the records are read.
    const asked = views.find(view => view.status === 'needs_owner')!;
    const choice = asked.question!.choices[0]!;
    const prepared = await lab.prepareCardCommand(draft.id, { kind: 'answer_question', cardId: asked.id, questionId: asked.question!.id!, choice: choice.id }, { via: 'board' });
    await lab.applyCardCommand(draft.id, prepared, hostGrant(prepared, 'confirmed'));
    const after = await lab.cardContext(draft.id);
    const now = situationViews(after.experiment, { evidence: after.evidence, numbers: after.numbers, maxTurns: 3 });
    const left = decisions({ draft: { record: after.experiment, views: now, pendingCalls: 0 } });
    assert.ok(!left.some(item => item.key.startsWith(`question:${asked.id}`)), JSON.stringify(left.map(item => item.key)));
  } finally { await lab.close(); }
});

test('problems are what repeats: a cause in several situations or a failure run after run, with the agent\'s own words', async () => {
  const records = (await new ExperimentLab(rich.directory).list()).filter(record => record.trials.length).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const runs = records.map(record => ({ record, view: buildResultView(record) }));
  const problems = recurringProblems(runs);
  assert.deepEqual(problems.map(problem => [problem.side, problem.title, problem.situations.length, problem.runsInRow]),
    [['agent', 'Переспрашивает номер вместо ответа по заявке', 3, 2], ['agent', 'Переспрашивает номер, который клиент уже назвал', 1, 2]]);
  assert.ok(problems.every(problem => problem.observations.every(item => item.quote === 'Уточните номер терминала.')));
  // One run alone: a cause of a single situation is a one-off error, not a problem.
  assert.deepEqual(recurringProblems(runs.slice(0, 1)).map(problem => problem.title), ['Переспрашивает номер вместо ответа по заявке']);
});

test('the agents of a folder are grouped by how they are reached; situations prepared before the agent was connected belong to the one agent', async () => {
  const records = await new ExperimentLab(rich.directory).list();
  const connected = records[0]!;
  const waiting = { ...structuredClone(connected), id: 'waiting-draft', phase: 'review', trials: [], target: { kind: 'unconnected' }, createdAt: '2030-01-01T00:00:00.000Z' } as Experiment;
  const [space] = agentSpaces([...records, waiting]);
  assert.equal(agentSpaces([...records, waiting]).length, 1);
  assert.equal(space!.name, 'агент поддержки');
  assert.equal(space!.draft?.id, 'waiting-draft', 'the newest draft is the set being worked on');
  // Two connected agents: the waiting draft stays apart, named for what it is.
  const other = { ...structuredClone(connected), id: 'other-run', target: { kind: 'command', command: 'node', args: ['bot.js'], cwd: '/project', timeoutMs: 60000 } } as Experiment;
  assert.equal(agentSpaces([...records, other, waiting]).length, 3);
  assert.equal(agentName(waiting), 'агент поддержки', 'the owner\'s own name comes first');
  // The placeholder of an unnamed external agent says nothing: such an agent is named by how it is started.
  const unnamed = { ...other, revisions: [{ ...other.revisions[0]!, spec: EXTERNAL_AGENT }] } as Experiment;
  assert.equal(agentName(unnamed, '/project'), 'node bot.js');
  assert.equal(agentName({ ...unnamed, target: { kind: 'unconnected' } } as Experiment), 'агент ещё не подключён');
});

test('situations can be prepared before the agent is connected; Lab finds it in the folder and connects it only with «Запустить»', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-unconnected-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  assert.equal(createInputSchema.parse(cardInput({ target: { kind: 'unconnected' } })).target.kind, 'unconnected');
  assert.throws(() => runnableTarget({ kind: 'unconnected' }), new RegExp(UNCONNECTED.slice(0, 30)));
  const lab = new ExperimentLab(join(cwd, '.agent-lab'), cardRuntime());
  await lab.init();
  try {
    const draft = await lab.create(cardInput({ target: { kind: 'unconnected' } }));
    await lab.waitForIdle();
    const prepared = await lab.get(draft.id);
    assert.equal(prepared.phase, 'review', prepared.error ?? '');
    const asked: { title: string; options: string[] }[] = [];
    const ctx = (pick: (options: string[]) => string | undefined) => ({ cwd, ui: { select: async (title: string, options: string[]) => { asked.push({ title, options }); return pick(options); } } }) as unknown as ExtensionContext;
    // Nothing in the folder says how to start the agent: the owner is asked in words, nothing runs.
    await assert.rejects(launchRun(ctx(options => options[0]), lab, prepared), (error: unknown) => error instanceof NeedsOwner
      && error.ownerText === 'Агент ещё не подключён, а в папке проекта Lab не нашёл, как его запускать. Как его запускать — команда, файл модуля или адрес?');
    // A module that declares Lab's contract is surely the agent: it goes straight into the plan, and a declined plan connects nothing.
    await writeFile(join(cwd, 'agent.mjs'), 'export async function createSession({ initialState }) {\n  return { async respond(message) { return { reply: message, records: initialState.records }; } };\n}\n');
    assert.equal(await launchRun(ctx(options => options.includes('Запустить') ? 'Не сейчас' : options[0]), lab, prepared), undefined);
    const plan = asked.at(-1)!;
    assert.match(plan.title, /^Принять \d+ ситуаци[юи] и запустить\?/);
    assert.match(plan.title, /\nАгент: модуль agent\.mjs\nLab нашёл его в папке проекта: agent\.mjs: объявляет createSession/);
    assert.equal(asked.length, 1, 'one sure agent needs no question of its own');
    assert.equal((await lab.get(draft.id)).target.kind, 'unconnected', 'a declined plan connects nothing');
    // Several ways to start an agent: the owner picks one first; stepping back connects nothing.
    await writeFile(join(cwd, 'bot.mjs'), 'export function createSession() { return { async respond() { return { reply: \'ok\' }; } }; }\n');
    assert.equal(await launchRun(ctx(() => undefined), lab, prepared), undefined);
    const pick = asked.at(-1)!;
    assert.match(pick.title, /^Как запустить агента\?\n\nСитуации готовы, а агент ещё не подключён\. Lab нашёл в папке проекта — ничего не запускал и не менял:$/);
    assert.deepEqual(pick.options.at(-1), 'Не сейчас');
    // The pick and «Запустить»: the connection becomes part of what the owner confirmed, and the run starts on it.
    const started = await launchRun(ctx(options => options.includes('Запустить') ? 'Запустить' : options.find(option => option.startsWith('модуль agent.mjs'))), lab, prepared);
    assert.ok(started);
    await lab.waitForIdle();
    const connected = await lab.get(draft.id);
    assert.equal(connected.target.kind === 'module' && connected.target.path, join(cwd, 'agent.mjs'));
    assert.notEqual(draftHash(connected), draftHash(prepared), 'the connection is part of what is confirmed');
    assert.ok(connected.trials.length > 0);
  } finally { await lab.close(); }
});

test('the consent to prepare from logs says what is read, what is left out and why, and the ceiling of the spending', () => {
  const consent: PreparationConsent = { conversations: 40, usable: 36, promised: 15, topicMapCalls: 3, promptCalls: 0, callCeiling: 140,
    excluded: [{ dialogueId: 'd1', kind: 'masked', reason: '' }, { dialogueId: 'd2', kind: 'masked', reason: '' }, { dialogueId: 'd3', kind: 'unreadable', reason: '' },
      { dialogueId: 'd4', kind: 'length', reason: '' }] };
  const text = consentText(consent, 'logs.jsonl');
  assert.equal(text.question, 'Собрать 15 ситуаций из logs.jsonl?');
  assert.deepEqual(text.lines, [
    'В логах 40 разговоров, подходят 36. Ситуаций будет не больше 15 — по одной на разговор, из всех тем логов.',
    'Не войдут 4 разговора: реплика клиента скрыта обезличиванием — 2 · запись не читается — 1 · нет реплик клиента или их больше 16 — 1.',
    'Расход — не больше 140 вызовов модели на всю подготовку, из них 3 — на разметку тем. Это потолок, а не прогноз; агент не запускается.',
  ]);
});
