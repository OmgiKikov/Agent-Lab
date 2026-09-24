import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { initTheme, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';
import { preparedAnswer } from '../extensions/background.ts';
import { inputError, recordErrorText, UNKNOWN_ERROR } from '../extensions/lab-ui.ts';
import { plainInputError } from '../extensions/prepare-tool.ts';
import { TOOL } from '../extensions/steps.ts';
import { importTable } from '../extensions/table-import.ts';
import { hostGrant } from '../src/card/commands.js';
import { settingsSchema, type Experiment } from '../src/contracts.js';
import { LockedError, Stopped } from '../src/errors.js';
import { ExperimentLab } from '../src/experiment.js';
import { ExperimentStore } from '../src/store.js';
import { suiteHoldsLogs, suiteSavedText } from '../src/suite.js';
import { dialogues, policy } from './helpers/card-prep.js';
import { cardNumbered, chatAgent, chatSession, gatedRuntime, holdReplies, json, seedDraft, shown, terminal, until } from './helpers/chat-session.js';
import { xlsxFile, type CellSpec } from './helpers/xlsx.js';

/*
 * The owner's consent in the chat, read back from the 0600 store after every call: work Pi's session replacement
 * would have dropped goes on and reports to the next session; a run cut short says why; «судья прав?» asks about the
 * judge's own decision; nothing is asked whose answer could not be written; whatever goes wrong reaches the owner in
 * their words; a suite of the logs stays out of Git; the owner's table never paints the terminal. Invented data only.
 */

before(() => { initTheme('dark', false); });
const prepareRequest = { task: 'Проверить возвраты', logs: 'logs.jsonl', rules: policy };

test('a session Pi replaces (/new, /resume, /fork, /reload) does not stop the run: the next session draws its row, holds the folder and gets the result', { timeout: 90000 }, async () => {
  const { runtime } = gatedRuntime();
  const fixture = await seedDraft('chat-switch-', runtime);
  const release = await holdReplies();
  const first = chatSession(runtime, { inlineRunMs: 0 });
  let second: ReturnType<typeof chatSession> | undefined;
  try {
    const old = terminal(fixture.cwd, ['Запусти готовые'], { picks: ['Запустить'] });
    assert.equal(json(await first.call(TOOL.run, 'run', {}, old.ctx)).background, true);
    await until(async () => (await fixture.read()).phase === 'evaluating');
    await first.end('new');
    assert.equal(old.widgets.at(-1), undefined, 'the row of the session that ended is cleared while it can still draw');
    assert.equal((await fixture.read()).phase, 'evaluating', 'the run goes on: nothing paid for is dropped');
    second = chatSession(runtime);
    const next = terminal(fixture.cwd, ['Что с прогоном?']);
    await second.start(next.ctx, 'new');
    assert.deepEqual(next.notes, ['Прогон продолжается — итог придёт сюда сообщением.']);
    await until(() => next.widgets.some(lines => !!lines?.[0]?.includes('Прогон: 0 из 2 разговоров')));
    // The next session holds the run: a change waits for it, as in the session that started it.
    const change = await second.call(TOOL.edit, 'edit', { situation: 1, changes: [{ kind: 'remove' }] }, next.ctx).catch(error => error as Error);
    assert.match(change instanceof Error ? change.message : '', /^Сейчас идёт прогон\./);
    await release();
    await until(() => second!.sent.length > 0);
    assert.equal(second.sent[0]!.message.customType, 'agent-lab-run');
    assert.equal((second.sent[0]!.message.details as { kind: string }).kind, 'agent-lab/verdict');
    assert.equal(first.sent.length, 0, 'nothing goes to the session that ended');
    assert.equal((await fixture.read()).phase, 'results_review');
    await until(() => next.widgets.at(-1) === undefined);
  } finally { await release(); await second?.end(); await first.end(); await fixture.cleanup(); }
});

test('a run that ends while Pi is between sessions reports to the next one; quitting Pi still stops the work, with what it recorded kept', { timeout: 90000 }, async () => {
  const { runtime } = gatedRuntime();
  const fixture = await seedDraft('chat-reload-', runtime);
  const release = await holdReplies();
  const first = chatSession(runtime, { inlineRunMs: 0 });
  const second = chatSession(runtime, { inlineRunMs: 0 });
  try {
    assert.equal(json(await first.call(TOOL.run, 'run', {}, terminal(fixture.cwd, ['Запусти'], { picks: ['Запустить'] }).ctx)).background, true);
    await until(async () => (await fixture.read()).phase === 'evaluating');
    await first.end('reload');
    await release();
    await until(async () => (await fixture.read()).phase === 'results_review');
    const next = terminal(fixture.cwd, []);
    await second.start(next.ctx, 'reload');
    await until(() => second.sent.length > 0);
    assert.equal(second.sent[0]!.message.customType, 'agent-lab-run');
    assert.deepEqual([first.sent.length, JSON.parse(second.sent[0]!.message.content).run], [0, fixture.id]);
    // Quitting: the work of the session ends with it, and its record says what was kept.
    const hold = await holdReplies();
    try {
      assert.equal(json(await second.call(TOOL.run, 'again', {}, terminal(fixture.cwd, ['Запусти ещё раз'], { picks: ['Запустить'] }).ctx)).background, true);
      const repeat = (await fixture.list()).find(record => record.id !== fixture.id)!;
      await until(async () => (await new ExperimentStore(join(fixture.cwd, '.agent-lab')).get(repeat.id)).phase === 'evaluating');
      await second.end('quit');
      assert.equal((await new ExperimentStore(join(fixture.cwd, '.agent-lab')).get(repeat.id)).phase, 'cancelled');
    } finally { await hold(); }
  } finally { await release(); await second.end(); await first.end(); await fixture.cleanup(); }
});

test('a run the release hook cut short answers with its cause and what was saved, in its row and as a message; never «no data», never «the accuracy is shown»', { timeout: 90000 }, async () => {
  const { runtime } = gatedRuntime();
  const fixture = await seedDraft('chat-run-failed-', runtime, { ...chatAgent, release: { command: process.execPath, args: ['-e', 'process.exit(3)'] } });
  const session = chatSession(runtime);
  const background = chatSession(runtime, { inlineRunMs: 0 });
  try {
    const result = await session.call(TOOL.run, 'run', {}, terminal(fixture.cwd, ['Запусти готовые'], { picks: ['Запустить'] }).ctx);
    assert.equal((await fixture.read()).phase, 'error');
    const output = json(result);
    assert.deepEqual([output.result, output.failed, output.saved, output.planned, output.shownToOwner], [null, true, 0, 2, undefined]);
    assert.match(output.reason, /^Хук выпуска завершился с кодом 3/); assert.match(output.instruction, /no accuracy was shown/);
    const row = shown(session.tools.get(TOOL.run)!, result);
    assert.match(row, /Прогон прервался до результата: Хук выпуска завершился с кодом 3/);
    assert.match(row, /Записано 0 из 2 разговоров; точность не посчитана\./);
    assert.doesNotMatch(row, /нет данных|не измерен/);
    // The same run again, now long enough to go on in the background: its message says the same.
    assert.equal(json(await background.call(TOOL.run, 'again', {}, terminal(fixture.cwd, ['Запусти ещё раз'], { picks: ['Запустить'] }).ctx)).background, true);
    await until(() => background.sent.length > 0);
    const message = JSON.parse(background.sent[0]!.message.content);
    assert.deepEqual([background.sent[0]!.message.customType, message.failed, message.result, message.shownToOwner], ['agent-lab-run', true, null, undefined]);
    assert.match(message.reason, /^Хук выпуска завершился с кодом 3/);
  } finally { await background.end(); await session.end(); await fixture.cleanup(); }
});

test('«судья прав?» asks about the judge\'s own decision and carries it with the answer; nothing to agree with, or work that holds the folder, is said before any question', { timeout: 120000 }, async () => {
  const { runtime, hold } = gatedRuntime();
  const fixture = await seedDraft('chat-agree-', runtime);
  // A duty's words come from the record; one of them carries a bidi override that must never reach the terminal.
  const seed = new ExperimentLab(join(fixture.cwd, '.agent-lab'), runtime);
  await seed.init();
  try {
    const card = cardNumbered(await seed.get(fixture.id), 2);
    const prepared = await seed.prepareCardCommand(fixture.id, { kind: 'edit_expectation', cardId: card.id, expectationId: 'e1', text: 'не запрашивать\u202e номер повторно' }, { via: 'pi-confirm' });
    await seed.applyCardCommand(fixture.id, prepared, hostGrant(prepared, 'confirmed'));
    await seed.recheckCards(fixture.id); await seed.waitForIdle();
  } finally { await seed.close(); }
  const session = chatSession(runtime, { inlineBuildMs: 0 });
  try {
    await session.call(TOOL.run, 'run', {}, terminal(fixture.cwd, ['Запусти'], { picks: ['Запустить'] }).ctx);
    assert.equal((await fixture.read()).phase, 'results_review');
    // «Нет» on both duties of situation 2: the owner's marks now read it «справился».
    const disputed = terminal(fixture.cwd, ['Судья ошибся во второй ситуации'], { picks: ['Нет, судья ошибся', options => options.at(-1)], texts: ['Агент не переспрашивал номер.'] });
    assert.equal(json(await session.call(TOOL.agree, 'no', { situation: 2 }, disputed.ctx)).answer, 'disagree');
    assert.match(disputed.selects[0]!.title, /судья решил: не справился\. Судья прав\?$/);
    assert.equal(disputed.selects[1]!.title, 'С чем вы не согласны?');
    assert.ok(disputed.selects[1]!.options.every(option => !option.includes('\u202e')), 'the options are escaped at the terminal boundary');
    assert.ok(disputed.selects[1]!.options.some(option => option.includes('не запрашивать номер повторно')), disputed.selects[1]!.options.join(' | '));
    // Asked again, the question names what the judge decided — «не справился» — never what the owner's marks made of it.
    const again = terminal(fixture.cwd, ['Всё же судья прав'], { picks: ['Да, судья прав'] });
    assert.equal(json(await session.call(TOOL.agree, 'yes', { situation: 2 }, again.ctx)).answer, 'agree');
    assert.match(again.selects[0]!.title, /судья решил: не справился\. Судья прав\?$/);
    const marks = (await fixture.read()).humanReviews.slice(-2);
    assert.deepEqual(marks.map(mark => [mark.verdict, mark.judgeVerdict]), [['fail', 'fail'], ['fail', 'fail']], '«да» agrees with what the judge decided');
    // A situation with nothing measured: said before any question.
    const store = new ExperimentStore(join(fixture.cwd, '.agent-lab'));
    await store.init();
    try {
      const record = await store.get(fixture.id);
      const late = cardNumbered(record, 1).id;
      for (const trial of record.trials.filter(item => item.scenarioId === late)) trial.assessmentError = 'Model call budget exhausted.';
      await store.save(record);
    } finally { await store.close(); }
    const unmeasured = terminal(fixture.cwd, ['А первая?'], { picks: ['Да, судья прав'] });
    const refused = json(await session.call(TOOL.agree, 'unmeasured', { situation: 1 }, unmeasured.ctx));
    assert.deepEqual([refused.marked, refused.reason, unmeasured.selects.length], [false, 'Ситуация не измерена — соглашаться не с чем.', 0]);
    // Work of this session holds the folder: the owner is not asked a question whose answer could not be written.
    await fixture.writeLogs();
    const releaseBuild = hold();
    try {
      assert.equal(json(await session.call(TOOL.prepare, 'prepare', prepareRequest, terminal(fixture.cwd, ['Собери ещё'], { picks: ['Собрать ситуации'] }).ctx)).background, true);
      const during = terminal(fixture.cwd, ['Да, судья прав'], { picks: ['Да, судья прав'] });
      const busy = await session.call(TOOL.agree, 'busy', { run: fixture.id, situation: 2 }, during.ctx).catch(error => error as Error);
      assert.match(busy instanceof Error ? busy.message : '', /^Сейчас идёт подготовка ситуаций\./);
      assert.equal(during.selects.length, 0, 'asked nothing');
    } finally { releaseBuild(); }
    await until(() => session.sent.length > 0);
  } finally { await session.end(); await fixture.cleanup(); }
});

test('a decision is not asked while this session\'s work holds the folder; once the work has ended it is asked and written', { timeout: 90000 }, async () => {
  const { runtime, hold } = gatedRuntime(true);
  const fixture = await seedDraft('chat-decide-busy-', runtime);
  await fixture.writeLogs();
  const session = chatSession(runtime, { inlineBuildMs: 0 });
  try {
    const owner = terminal(fixture.cwd, ['Собери ситуации по логам', 'Да, клиент знал номер'], { picks: ['Собрать ситуации', '1  Да'] });
    const [waiting] = json(await session.call(TOOL.decide, 'list', {}, owner.ctx)).decisions;
    assert.ok(waiting, 'a situation waits for the owner\'s answer');
    const releaseBuild = hold();
    try {
      assert.equal(json(await session.call(TOOL.prepare, 'prepare', prepareRequest, owner.ctx)).background, true);
      const busy = await session.call(TOOL.decide, 'answer', { decision: waiting.key, choice: 1 }, owner.ctx).catch(error => error as Error);
      assert.match(busy instanceof Error ? busy.message : '', /^Сейчас идёт подготовка ситуаций\./);
      assert.equal(owner.selects.length, 1, 'only the consent of the preparation was asked');
    } finally { releaseBuild(); }
    await until(() => session.sent.length > 0);
    const [fresh] = json(await session.call(TOOL.decide, 'list-again', {}, owner.ctx)).decisions;
    assert.equal(json(await session.call(TOOL.decide, 'answer-again', { decision: fresh.key, choice: 1 }, owner.ctx)).decided, true);
    assert.equal(owner.selects.length, 2);
  } finally { await session.end(); await fixture.cleanup(); }
});

test('one translator: typed errors in the owner\'s words with the way on, a zod error as the field and the problem, anything else a neutral phrase with its original on stderr', () => {
  assert.equal(inputError(new LockedError()), 'Другая сессия Pi сейчас ведёт работу в этой папке. Смотреть можно здесь; изменения и запуск — после её завершения.');
  assert.match(inputError(new Stopped('budget', 'Model call budget exhausted.')), /^Закончился лимит вызовов модели; сделанное сохранено\. Поднять лимит — ваше решение/);
  const zod = settingsSchema.safeParse({ provider: 'x', model: 'y', maxCalls: 3007 }).error!;
  assert.equal(inputError(zod), 'Не получилось: лимит вызовов модели — не больше 3000. Ничего не записано.');
  assert.equal(inputError(new Error('Сейчас идёт прогон.')), 'Сейчас идёт прогон.', 'the engine\'s own refusal is the owner\'s words already');
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    assert.equal(inputError(new TypeError('Cannot read properties of undefined (reading \'id\')')), UNKNOWN_ERROR);
    assert.equal(inputError(new Error('The approved evaluation conditions changed. Create a fresh reviewed run.')), UNKNOWN_ERROR, 'an English diagnostic never reaches the owner');
  } finally { process.stderr.write = write; }
  assert.match(written.join(''), /TypeError: Cannot read properties of undefined/); assert.match(written.join(''), /The approved evaluation conditions changed/);
  // What a record keeps of a stop reads back in the owner's words.
  assert.equal(recordErrorText('Model call budget exhausted.'), inputError(new Stopped('budget', 'Model call budget exhausted.')));
  assert.equal(recordErrorText('Хук выпуска завершился с кодом 3: без вывода'), 'Хук выпуска завершился с кодом 3: без вывода');
  assert.equal(recordErrorText('Judge response rejected; original responses and errors are preserved in judgeAudit'), 'Работа прервалась из-за внутренней ошибки Agent Lab; сделанное сохранено.');
  // More situations than one preparation can hold: a refusal in the owner's words before anything is written.
  const overflow = plainInputError(zod).message;
  assert.match(overflow, /^Столько ситуаций за один раз не подготовить: на них не хватит предельного лимита вызовов модели \(3000\)\. Назовите меньше ситуаций/);
  assert.doesNotMatch(overflow, /Too big|maxCalls|<=/);
});

test('a preparation cut short says why in the owner\'s words', async () => {
  const record = { id: 'run_1', phase: 'error', error: 'Model call budget exhausted.', message: 'Model call budget exhausted.', createdAt: '2026-09-24T10:00:00.000Z' } as unknown as Experiment;
  const answer = await preparedAnswer(undefined as unknown as ExperimentLab, record, true);
  assert.deepEqual(answer.feed?.rows.map(item => item.text), ['Подготовка не завершена: Закончился лимит вызовов модели; сделанное сохранено. Поднять лимит — ваше решение: скажите «подними лимит».']);
  assert.equal(answer.output.error, 'Закончился лимит вызовов модели; сделанное сохранено. Поднять лимит — ваше решение: скажите «подними лимит».');
});

test('what a tool throws reaches the owner and the model in the owner\'s words: another session\'s lock, a raw zod issue, an unknown reference, an internal failure', { timeout: 60000 }, async () => {
  const { runtime } = gatedRuntime();
  const fixture = await seedDraft('chat-errors-', runtime);
  const session = chatSession(runtime);
  const owner = terminal(fixture.cwd, ['Убери вторую ситуацию'], { picks: ['Записать'] });
  try {
    const other = new ExperimentLab(join(fixture.cwd, '.agent-lab'), runtime);
    await other.init();
    try {
      const locked = await session.call(TOOL.edit, 'locked', { situation: 2, changes: [{ kind: 'remove' }] }, owner.ctx).catch(error => error as Error);
      assert.equal(locked instanceof Error ? locked.message : '', 'Другая сессия Pi сейчас ведёт работу в этой папке. Смотреть можно здесь; изменения и запуск — после её завершения.');
    } finally { await other.close(); }
    // A rule id the stored shape does not allow never reaches the command: the schema holds it; a reserved one is refused in words.
    const edit = session.tools.get(TOOL.edit)!;
    assert.equal(Value.Check(edit.parameters, { changes: [{ kind: 'rules', bind: ['правило 1'] }] }), false);
    assert.equal(Value.Check(edit.parameters, { changes: [{ kind: 'rules', bind: ['req_1'] }] }), true);
    const reserved = await session.call(TOOL.edit, 'reserved', { changes: [{ kind: 'rules', bind: ['constructor'] }] }, owner.ctx).catch(error => error as Error);
    assert.equal(reserved instanceof Error ? reserved.message : '', 'Не получилось: правила свода — не проходит проверку. Ничего не записано.');
    // A fact the situation does not have: the model reads what there is by id, the owner reads a question without ids.
    const missing = await session.call(TOOL.edit, 'missing', { situation: 1, changes: [{ kind: 'fact', fact: 'f7', when: 'unknown' }] }, owner.ctx);
    assert.deepEqual(json(missing).options, ['f1 Номер терминала']);
    assert.equal(shown(edit, missing), '└ У этой ситуации нет такого факта — какой вы имели в виду?');
    assert.equal(owner.selects.length, 0, 'nothing was asked or written');
  } finally { await session.end(); await fixture.cleanup(); }
  const broken = chatSession(runtime, { createLab: () => { throw new TypeError('boom from the test'); } });
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const failed = await broken.call(TOOL.status, 'status', {}, owner.ctx).catch(error => error as Error);
    assert.equal(failed instanceof Error ? failed.message : '', UNKNOWN_ERROR);
  } finally { process.stderr.write = write; }
  assert.match(written.join(''), /boom from the test/, 'the original goes to stderr, for whoever reads the terminal\'s errors');
});

test('a suite saved from the logs warns in the owner\'s words to keep it out of Git; the model is never handed a command line with --yes', { timeout: 60000 }, async () => {
  const { runtime } = gatedRuntime();
  const fixture = await seedDraft('chat-suite-', runtime);
  const session = chatSession(runtime);
  try {
    await session.call(TOOL.run, 'run', {}, terminal(fixture.cwd, ['Запусти'], { picks: ['Запустить'] }).ctx);
    const result = await session.call(TOOL.results, 'save', { save: '.evals/regression.json' }, terminal(fixture.cwd, ['Сохрани набор']).ctx);
    const output = json(result);
    assert.equal(output.holdsLogs, true);
    assert.doesNotMatch(JSON.stringify(output), /--yes/);
    const row = shown(session.tools.get(TOOL.results)!, result);
    assert.match(row, /Набор сохранён: \.evals\/regression\.json/);
    assert.match(row, /В наборе — разговоры клиентов из ваших логов: не добавляйте его в Git и не пересылайте\./);
    assert.doesNotMatch(row, /можно добавить в Git/);
    assert.equal(((await stat(join(fixture.cwd, '.evals', 'regression.json'))).mode & 0o777).toString(8), '600');
  } finally { await session.end(); await fixture.cleanup(); }
  // The same words wherever a suite is saved; a suite of the owner's rules alone may live in Git.
  const fromRules = { librarySnapshot: undefined, originalImport: undefined, dialogues: [], scenarios: [{ provenance: 'synthetic' }] } as unknown as Experiment;
  const fromLogs = { ...fromRules, dialogues: dialogues.map(item => ({ ...item, outcome: 'unknown' })) } as unknown as Experiment;
  assert.deepEqual([suiteHoldsLogs(fromRules), suiteHoldsLogs(fromLogs)], [false, true]);
  assert.equal(suiteSavedText(fromRules), 'Его можно добавить в Git и запускать после каждой правки агента.');
  assert.match(suiteSavedText(fromLogs), /^В наборе — разговоры клиентов из ваших логов: не добавляйте его в Git и не пересылайте\. Храните его там же, где логи/);
});

test('an answer quoting the owner\'s table crosses the terminal boundary: its option carries no control or bidi character, and the pick still lands', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'chat-table-escape-'));
  const store = new ExperimentStore(join(cwd, '.agent-lab'));
  try {
    const talk = (...messages: string[]) => messages.join(' ` ');
    const rows: CellSpec[][] = [['Id диалога', 'Текст', 'agentCode'], ...dialogues.map((item, index): CellSpec[] => [item.id,
      talk(...item.messages.map(message => `${message.role === 'user' ? 'CLIENT' : 'AGENT'} ${message.content}`)), index ? 'OTHER' : 'SUPPORT\u202eTROPPUS'])];
    await writeFile(join(cwd, 'logs.xlsx'), xlsxFile([{ name: 'Данные', rows }]));
    await store.init();
    const asked: { title: string; options: string[] }[] = [];
    const ctx = { ui: { select: async (title: string, options: string[]) => { asked.push({ title, options }); return options.find(option => option.includes('SUPPORT')) ?? options[0]; } } } as unknown as ExtensionContext;
    const imported = await importTable(ctx, store, join(cwd, 'logs.xlsx'), { where: { column: 'agentCode' } });
    assert.ok(asked[0]!.options.every(option => !option.includes('\u202e')), asked[0]!.options.join(' | '));
    assert.ok(asked[0]!.options.some(option => option.includes('SUPPORTTROPPUS')));
    assert.ok('batch' in imported, JSON.stringify(imported));
    assert.equal(imported.batch.dialogues.length, 1, 'the owner\'s pick selected the conversation it named');
  } finally { await store.close(); await rm(cwd, { recursive: true, force: true }); }
});
