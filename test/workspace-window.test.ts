import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { workspaceView } from '../extensions/board-command.ts';
import { LabWorkspace, newState, type WorkspaceAction, type WorkspaceState, type WorkspaceView } from '../extensions/workspace.ts';
import { judgedScreen, type SpaceData } from '../extensions/workspace-screens.ts';
import { ExperimentLab } from '../src/experiment.js';
import { plainText, resultScreen } from '../src/result-text.js';
import { buildResultView } from '../src/result-view.js';
import { agentSpaces } from '../src/workspace.js';
import { calibrated, loggedRun } from './helpers/calibration.js';
import { demoFolder, KEYS, openWorkspace, richFolder } from './helpers/workspace.js';

/*
 * The workspace's window and what it points at (docs/design/ui-spec.md §5, §6, §8): the selection never hides behind
 * «↓ ещё N» and the end of a long screen can be reached; an object that is gone closes and a cursor stays on its
 * list; the work going on is named for what it is; the header gives way by the widths of §6 and never cuts a label;
 * the result on the board is the CLI's own rows; the time a conversation is read reaches the answer.
 */

let rich: Awaited<ReturnType<typeof richFolder>>;
before(async () => { rich = await richFolder(); });
after(async () => { await rm(rich.cwd, { recursive: true, force: true }); });

const plain = { fg: (_tone: string, text: string) => text, bold: (text: string) => text } as never;

/** A workspace drawn on `view` at `rows` terminal rows: `screen()` what the owner sees, `press` keys the way Pi sends them. */
function board(view: WorkspaceView, state: WorkspaceState, rows: number, width = 100) {
  const actions: WorkspaceAction[] = [];
  const component = new LabWorkspace(view, state, plain, action => actions.push(action), () => {}, () => rows);
  const screen = () => component.render(width).map(line => stripTerminalSequences(line)).join('\n');
  const press = (...keys: string[]) => { for (const key of keys) { component.render(width); component.handleInput(key); } return screen(); };
  return { component, actions, screen, press };
}

/** The state of an agent's workspace open on `area`. */
function at(data: SpaceData, setup: (state: WorkspaceState) => void): WorkspaceState {
  const state = newState(data.space.key);
  setup(state);
  return state;
}

const selected = (screen: string) => screen.split('\n').filter(line => line.startsWith(' › '));

test('«Все прогоны» at 16 rows: the selected run is always on screen, «↓ ещё N» counts every run below it, and the last run is reached', async () => {
  const { view } = await openWorkspace(rich.directory);
  const data = view.data!;
  // Twelve runs of the same agent, an hour apart: more than 16 rows can hold.
  const runs = Array.from({ length: 12 }, (_, index) => {
    const base = data.runs[index % data.runs.length]!;
    return { record: { ...base.record, id: `${base.record.id}-${index}`, createdAt: new Date(Date.parse(base.record.createdAt) - index * 3_600_000).toISOString() }, view: base.view };
  });
  const many: WorkspaceView = { ...view, data: { ...data, runs } };
  const seventh = board(many, at(data, state => { state.area = 'runs'; state.stack = [{ kind: 'allRuns' }]; state.selected.allRuns = 6; }), 16);
  const shown = seventh.screen();
  assert.equal(selected(shown).length, 1, `the seventh run is selected and on screen:\n${shown}`);
  const hidden = runs.length - 7;
  assert.match(shown, new RegExp(`↓ ещё ${hidden}$`, 'm'), `the five runs under it are counted:\n${shown}`);
  // ↓ walks every run; the selection never goes under the mark.
  const walk = board(many, at(data, state => { state.area = 'runs'; state.stack = [{ kind: 'allRuns' }]; }), 16);
  for (let index = 1; index < runs.length; index++) assert.equal(selected(walk.press(KEYS.down)).length, 1, `run ${index + 1}:\n${walk.screen()}`);
  assert.doesNotMatch(walk.screen(), /↓ ещё/, 'at the last run nothing is below');
});

test('«Ситуации» at 16 and 24 rows: the selected situation keeps its row of actions on screen, whichever it is', async () => {
  const { view } = await openWorkspace(rich.directory);
  const data = view.data!;
  for (const rows of [16, 24]) {
    const walk = board(view, at(data, state => { state.area = 'situations'; }), rows);
    for (let index = 0; index < data.set!.views.length; index++) {
      const shown = index ? walk.press(KEYS.down) : walk.screen();
      const lines = shown.split('\n');
      const at = lines.findIndex(line => line.startsWith(' › '));
      assert.ok(at >= 0, `${rows} rows, situation ${index + 1}: no selection on screen:\n${shown}`);
      // Under the selected situation: its two lines, its question when it has one, then «1 …» — never the mark instead.
      assert.ok(lines.slice(at + 1, at + 5).some(line => /^ {6}1 \S/.test(line)), `${rows} rows, situation ${index + 1}: its actions are hidden:\n${shown}`);
    }
  }
});

test('the result with its details at 24 rows: End shows the tail and PgUp/PgDn move freely, until ↑↓ bring the selection back into view', async () => {
  const { view } = await openWorkspace(rich.directory);
  const data = view.data!;
  const result = board(view, at(data, state => { state.area = 'runs'; }), 24);
  result.press('d');
  const tail = result.press('\x1b[F');
  assert.match(tail, /^ 1 Отчёт для заказчика {2}· {2}2 Запустить снова/m, `End reaches the actions under the result:\n${tail}`);
  assert.doesNotMatch(tail, /↓ ещё|↓ ниже/, 'nothing is below the end');
  const up = result.press('\x1b[5~');
  assert.notEqual(up, tail, 'PgUp moves the window');
  assert.match(result.press('\x1b[6~', '\x1b[6~', '\x1b[6~'), /^ 1 Отчёт для заказчика/m, 'PgDn reaches the end again');
  // ↓ moves the selection to the next cause, and the window follows it again.
  assert.equal(selected(result.press(KEYS.down)).length, 1);
  // Every row the cursor can stand on is reached, each on screen.
  const walk = board(view, at(data, state => { state.area = 'runs'; state.details = true; }), 16);
  for (let step = 0; step < 6; step++) assert.equal(selected(step ? walk.press(KEYS.down) : walk.screen()).length, 1, `step ${step}:\n${walk.screen()}`);
});

test('a situation taken out of the draft closes where it was open: the list is back, and its keys work at once', async () => {
  const { view } = await openWorkspace(rich.directory);
  const data = view.data!;
  const [, removed, next] = data.set!.views;
  const state = at(data, value => { value.area = 'situations'; value.stack = [{ kind: 'situation', id: removed!.id }]; value.selected['area:situations'] = 1; });
  const gone: WorkspaceView = { ...view, data: { ...data, set: { ...data.set!, views: data.set!.views.filter(item => item.id !== removed!.id) } } };
  const opened = board(gone, state, 44);
  assert.deepEqual(state.stack, [], 'the removed situation is no longer open');
  assert.match(opened.screen(), new RegExp(`^ › ${next!.number} `, 'm'), 'the cursor stands on the situation that took its place');
  opened.press('1');
  const [action] = opened.actions;
  assert.ok(action?.type === 'situation' && action.view.id === next!.id, JSON.stringify(action?.type));
});

test('the last decision answered: the cursor stays on the queue, the one left is selected and its digits answer it', async () => {
  const { view } = await openWorkspace(rich.directory);
  const data = view.data!;
  assert.equal(data.decisions.length, 2);
  const state = at(data, value => { value.area = 'inbox'; value.selected['area:inbox'] = 1; });
  const left: WorkspaceView = { ...view, data: { ...data, decisions: data.decisions.slice(0, 1) } };
  const queue = board(left, state, 44);
  assert.equal(selected(queue.screen()).length, 1, queue.screen());
  queue.press('1');
  const [action] = queue.actions;
  assert.ok(action?.type === 'decide' && action.choice === data.decisions[0]!.choices[0], JSON.stringify(action));
});

test('the work going on is named for what it is: a preparation stays with the situations, a check has no bar, a run goes on its own step', async t => {
  const demo = await demoFolder();
  t.after(() => rm(demo.cwd, { recursive: true, force: true }));
  const quiet = await workspaceView(new ExperimentLab(demo.directory), newState(), undefined);
  const going = (kind: 'preparation' | 'check' | 'run', share: number | null): WorkspaceView => ({ ...quiet, data: { ...quiet.data!,
    progress: { kind, text: kind === 'run' ? 'Прогон: 1 из 2 разговоров' : kind === 'check' ? 'Проверяю изменённые ситуации' : 'Готовлю ситуации: разобрано 1 из 2 разговоров', share, stoppable: true } } });
  // A preparation: the workspace opens on the situations, whose step says they are being prepared; nothing says «прогон».
  let reads = 0;
  const state = newState(quiet.data!.space.key);
  const views = [quiet];
  const component = new LabWorkspace(going('preparation', 0.5), state, plain, () => {}, () => {}, () => 44, async () => views[reads++] ?? quiet, () => () => {});
  t.after(() => component.dispose());
  // A hint may wrap: its words are read across the line it wraps at.
  const screen = () => component.render(100).map(line => stripTerminalSequences(line)).join('\n');
  const words = (text: string) => text.replace(/\s+/g, ' ');
  assert.equal(state.step, 'situations');
  const preparing = screen();
  assert.match(preparing, /^ Ситуации готовятся {2}› {2}Прогон {2}› {2}Результат$/m);
  assert.match(preparing, /Готовлю ситуации: разобрано 1 из 2 разговоров/);
  assert.match(words(preparing), /Готовые ситуации появляются здесь по ходу подготовки\. Доску можно закрыть — подготовка продолжится\./);
  assert.doesNotMatch(preparing, /Прогон идёт|Первые ответы/);
  // Its step of the run says when a run can start, and Enter there stops the preparation.
  const actions: WorkspaceAction[] = [];
  const step = new LabWorkspace(going('preparation', 0.5), newState(quiet.data!.space.key), plain, action => actions.push(action), () => {}, () => 44);
  step.render(100); step.handleInput(KEYS.right);
  const run = step.render(100).map(line => stripTerminalSequences(line)).join('\n');
  assert.match(run, /^ Запустить можно, когда подготовка закончится\.$/m);
  assert.match(words(run), /Готовые ситуации появляются в «Ситуациях» по ходу подготовки\./);
  assert.doesNotMatch(run, /Прогон идёт|Первые ответы/);
  step.handleInput(KEYS.enter);
  assert.deepEqual(actions, [{ type: 'stop' }]);
  // The preparation ends: the owner stays with the situations it made — there is no result to show.
  (component as unknown as { changed(): void }).changed();
  for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.step, 'situations');
  assert.doesNotMatch(screen(), /готовятся/);
  // A check draws no bar: how far it got is not known.
  const check = new LabWorkspace(going('check', null), newState(quiet.data!.space.key), plain, () => {}, () => {}, () => 44).render(100).map(line => stripTerminalSequences(line)).join('\n');
  assert.match(check, /^ Ситуации проверяются {2}› {2}Прогон {2}› {2}Результат$/m);
  assert.match(check, /^ \S Проверяю изменённые ситуации$/m, 'the row ends with its words: no bar');
  assert.doesNotMatch(check, /━/);
  // A run before the first result goes on its own step, with its own words.
  const runState = newState(quiet.data!.space.key);
  const running = new LabWorkspace(going('run', 0.5), runState, plain, () => {}, () => {}, () => 44).render(100).map(line => stripTerminalSequences(line)).join('\n');
  assert.equal(runState.step, 'run');
  assert.match(running, /^ Ситуации 1\/2 {2}› {2}Прогон идёт {2}› {2}Результат$/m);
  assert.match(words(running), /Первые ответы уже видны в «Результате»\. Доску можно закрыть — прогон продолжится\./);
});

test('the kind of work another process does is read from its record: a draft with its situations being checked, a preparation, a run', async t => {
  const demo = await demoFolder();
  t.after(() => rm(demo.cwd, { recursive: true, force: true }));
  const lab = new ExperimentLab(demo.directory);
  await lab.init();
  t.after(() => lab.close());
  const draft = await lab.get(demo.id);
  const kindOf = async (record: typeof draft) => {
    await lab.store.save(record);
    return (await workspaceView(new ExperimentLab(demo.directory), newState(), undefined)).data?.progress?.kind;
  };
  assert.equal(await kindOf({ ...draft, phase: 'preparing' }), 'check', 'a draft that holds its situations and has nothing left to read is being checked');
  assert.equal(await kindOf({ ...draft, phase: 'preparing', librarySnapshot: undefined }), 'preparation');
  assert.equal(await kindOf({ ...draft, phase: 'evaluating' }), 'run');
});

test('the header gives way by the widths of §6: the current place is always whole, the version label only from 100 columns, and below 50 only the place and «? клавиши · Esc»', async () => {
  for (const area of ['inbox', 'situations', 'rules', 'runs', 'problems'] as const) {
    const { screen } = await openWorkspace(rich.directory, state => { state.area = area; });
    const label = { inbox: 'Нужно ваше решение: 2', situations: 'Ситуации 13', rules: 'Свод правил', runs: 'Прогоны 2', problems: 'Проблемы 2' }[area];
    for (const width of [40, 50, 60, 70, 80, 100, 160]) {
      const lines = screen(width).split('\n');
      const head = lines.slice(1, lines.indexOf('', 1));
      const foot = lines.at(-2)!;
      assert.equal(head.length, width < 50 ? 1 : 2, `${area} ${width}: ${head.join(' ⏎ ')}`);
      assert.ok(head.at(-1)!.includes(label), `${area} ${width}: the current area «${label}» is not whole in «${head.at(-1)}»`);
      for (const line of [...head, foot]) assert.ok(!line.includes('…'), `${area} ${width}: «${line}» is cut`);
      assert.equal(head[0]!.includes('версия baseline-v1'), width >= 100, `${area} ${width}: ${head[0]}`);
      assert.ok(foot.trimEnd().endsWith('? клавиши') || width < 50, `${area} ${width}: «${foot}»`);
      if (width < 50) assert.equal(foot.trim(), '? клавиши · Esc закрыть', `${area} ${width}`);
      // Every area has room from 80 columns: none is left out there.
      if (width >= 80) for (const name of ['Нужно ваше решение: 2', 'Ситуации 13', 'Свод правил', 'Прогоны 2', 'Проблемы 2']) assert.ok(head.at(-1)!.includes(name), `${area} ${width}: ${name}`);
    }
  }
  // Before the first result the steps give way the same way: at 40 columns the current step and the others, counters dropped.
  const demo = await demoFolder();
  try {
    const { screen } = await openWorkspace(demo.directory);
    assert.match(screen(40), /^ Ситуации 1\/2 {2}› {2}Прогон {2}› {2}Результат$/m);
    // Narrower still, a step that does not fit is left out whole; the current one never is.
    assert.match(screen(30), /^ Ситуации 1\/2 › Прогон$/m);
  } finally { await rm(demo.cwd, { recursive: true, force: true }); }
});

test('the result on the board is the CLI\'s own rows (result-text.ts), details and all: the rules the number was measured by, every error, «Дальше»', async () => {
  const { view } = await openWorkspace(rich.directory);
  const data = view.data!;
  const run = data.runs[0]!;
  for (const details of [false, true]) {
    const drawn = board(view, at(data, state => { state.area = 'runs'; state.details = details; }), 400).screen().split('\n');
    const expected = plainText(resultScreen(run.view, { surface: 'board', details, now: data.now }), 100).split('\n');
    // The board's own additions: the cursor's mark, how the run before did, the numbered actions under it all.
    const body = drawn.slice(4, 4 + expected.length).map(line => line.replace(/^ › /, '   ').replace(/ · было \d+% \([^)]*\)$/, '').trimEnd());
    assert.deepEqual(body, expected.map(line => line.trimEnd()), `details ${details}`);
    assert.match(drawn.join('\n'), /^ Оценка по правилам: /m, 'the rules the number was measured by');
  }
  // «Сверка с продом» of a calibrated run reaches the board's details, as the CLI summary prints it.
  const logged = calibrated(loggedRun(4, () => ({ e1: 'pass', e2: 'pass' })), number => number === 2 ? ['fail', 'pass'] : ['pass', 'pass']);
  const space = agentSpaces([logged])[0]!;
  const calibratedView: WorkspaceView = { agents: [{ space, result: null, decisions: 0 }], data: { space, runs: [{ record: logged, view: buildResultView(logged) }], decisions: [], problems: [], now: new Date() } };
  const summary = plainText(resultScreen(buildResultView(logged), { surface: 'cli' }), 100);
  assert.match(summary, /^ Сверка с продом$/m);
  const shown = board(calibratedView, (() => { const state = newState(space.key); state.area = 'runs'; state.details = true; return state; })(), 400).screen();
  assert.match(shown, /^ Сверка с продом$/m, shown);
});

test('a judged conversation reads as one explanation: never two blank rows in a row', async () => {
  const { view } = await openWorkspace(rich.directory);
  const run = view.data!.runs[0]!;
  for (const failure of run.view.failures) {
    const screen = judgedScreen(run, failure.trialId, undefined, undefined, 100);
    const lines = screen.body.map(line => line.map(part => part.text).join('').trimEnd());
    lines.forEach((line, index) => assert.ok(line || lines[index + 1], `two blank rows at ${index}:\n${lines.join('\n')}`));
    assert.match(lines.join('\n'), /\n\n Судья решил: не справился\. Вы согласны\? +1 да · 2 нет · 3 не знаю$/);
  }
});

test('the time a judged conversation stays on screen reaches the answer, drawn again or not', async () => {
  const { component, press, actions } = board((await openWorkspace(rich.directory)).view, at((await openWorkspace(rich.directory)).view.data!, state => { state.area = 'runs'; }), 44);
  press(KEYS.enter);
  // Pi draws the conversation once when it opens and not again while it stands still.
  component.render(100);
  await new Promise(resolve => setTimeout(resolve, 150));
  component.handleInput('1');
  const [mark] = actions;
  assert.ok(mark?.type === 'mark', JSON.stringify(mark));
  assert.ok(mark.readingMs >= 120, `read for ${mark.readingMs} ms`);
});
