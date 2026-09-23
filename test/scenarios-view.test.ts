import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { LabBoard, type BoardAction } from '../extensions/cards.ts';
import { logsRows, runRows, scenarioErrorText } from '../extensions/scenarios.ts';
import { dialogueNumbers, situationViews } from '../src/card/view.js';
import { experimentSchema, settingsSchema, type Experiment } from '../src/contracts.js';
import { LibraryConflict, StaleRevisionError } from '../src/errors.js';
import { cardDraft, READY } from './helpers/card-library.js';
import { cardRun } from './helpers/cards.js';

/*
 * The situations of a draft on the board (ui-spec §4.2–4.5, §8.4), drawn by the shared projection: the list with
 * the selected situation's numbered actions, one situation open with its question, the keys that act on it, the
 * old format only read, the plan of the run and the state of the preparation.
 */

const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value };
const doubt = { status: 'needs_owner' as const, reason: 'В исходном разговоре клиент назвал номер только после вопроса агента.' };

function boardDraft() {
  const draft = cardDraft({ verdict: (claim, card) => card.number === 1 && claim.alias === 'fact_f1' ? doubt : READY });
  const record = cardRun([], [], 1, { phase: 'review', librarySnapshot: draft.library, reviewedAt: null, manifestHash: null, settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 2 }),
    preparationProgress: { protocol: 'cards-v1', inputHash: 'a'.repeat(64), status: 'partial', processed: ['late', 'known'], pending: ['third'], groundingComplete: true,
      excluded: [{ dialogueId: 'broken', reason: 'Правила владельца не решают этот разговор.' }] } });
  const situations = situationViews(record, { evidence: draft.evidence, numbers: dialogueNumbers([draft.batch]), maxTurns: 3 });
  return { record, situations };
}
function board(record: Experiment, situations: ReturnType<typeof situationViews>) {
  const actions: BoardAction[] = [];
  const shown = new LabBoard({ record, section: 'cards', situations }, theme, action => actions.push(action), () => {}, () => 60);
  return { shown, actions, text: (width = 110) => stripTerminalSequences(shown.render(width).join('\n')) };
}

test('the situations of a draft: three lines each, the selected one with its numbered answers under it', () => {
  const { record, situations } = boardDraft();
  const { text } = board(record, situations);
  const screen = text();
  assert.match(screen, /2 Ситуации 2/);
  assert.match(screen, /2 ситуации: 1 готова · 1 ждёт вашего ответа/);
  assert.match(screen, /› 1  Возврат оплаты — номер по просьбе +\? нужен ваш ответ/);
  assert.match(screen, /1 Да {2}· {2}2 Не знал {2}· {2}3 Убрать/, 'the selected situation\'s question answers sit under it');
  assert.match(screen, /2  Возврат оплаты — номер назван сразу +✓ готова/);
  assert.match(screen, /↑↓ выбрать · Enter открыть · 1–3 действие · Tab разделы/);
  assert.doesNotMatch(screen, /вариант|ревизия|Space|card_/i);
});

test('Enter opens the situation with its question; a digit answers it; Esc goes back to the list', () => {
  const { record, situations } = boardDraft();
  const { shown, actions, text } = board(record, situations);
  shown.handleInput('\r');
  const open = text();
  assert.match(open, / Клиент {2,}│[\s\S]*Хочет {4}Получить инструкцию по возврату оплаты/);
  assert.match(open, /\? Клиент знал «Номер терминала» до разговора\?/);
  assert.match(open, /1–3 ответить · a спросить Lab · d как это проверяется · Esc назад/);
  shown.handleInput('\x1b');
  assert.match(text(), /2 ситуации: 1 готова/);
  shown.handleInput('2');
  const [action] = actions;
  assert.ok(action?.type === 'situation' && action.action.kind === 'answer');
  assert.deepEqual([action.situation.number, action.action.choice.id, action.action.choice.command.kind], [1, 'b', 'set_fact_disclosure']);
});

test('a ready situation offers «Изменить · Добавить похожую · Не проверять»', () => {
  const { record, situations } = boardDraft();
  const { shown, actions } = board(record, situations);
  shown.handleInput('\x1b[B');
  shown.handleInput('3');
  const [action] = actions;
  assert.ok(action?.type === 'situation');
  assert.deepEqual([action.situation.number, action.action.kind], [2, 'remove']);
});

test('a first-format draft is only read on the board: no numbered actions, the old format named', async () => {
  const run = experimentSchema.parse(JSON.parse(await readFile(new URL('./fixtures/library-v1/run.json', import.meta.url), 'utf8')));
  const library = structuredClone(run.librarySnapshot!);
  delete library.acceptance;
  const record = { ...run, phase: 'review', trials: [], librarySnapshot: library } as Experiment;
  const { shown, actions, text } = board(record, situationViews(record, { maxTurns: 3 }));
  const screen = text();
  assert.match(screen, /Старый формат: эти ситуации можно посмотреть, но не изменить\./);
  assert.match(screen, /Номер уже в первой реплике +✓ готова/);
  assert.doesNotMatch(screen, /1 Изменить|1–3 действие/);
  shown.handleInput('1');
  assert.deepEqual(actions, [], 'a digit is not an action on a read-only draft');
  assert.match(runRows(record, situationViews(record, { maxTurns: 3 })).map(row => row.text).join('\n'), /Старый формат: утвердить эти ситуации нельзя\./);
});

test('the run plan of a card draft: the ready situations run and are accepted with it, the waiting ones stay out', () => {
  const { record, situations } = boardDraft();
  const text = runRows(record, situations).map(row => row.text).join('\n');
  assert.match(text, /1 ситуация · 2 разговора: клиента играет Lab, ответы агента оценивает судья\./);
  assert.match(text, /Судья: по 2 голоса на каждое ожидание — до 4 вызовов на попытку, всего до 8\./);
  assert.match(text, /Не войдут: 1 ждёт вашего ответа/);
  assert.match(text, /r — утвердить готовые ситуации и запустить: одно подтверждение/);
});

test('the preparation says what was read, what waits and what was left out and why', () => {
  const { record } = boardDraft();
  const text = logsRows(record).map(row => row.text).join('\n');
  assert.match(text, /Разобрано разговоров: 2 · ждут: 1 · исключено: 1/);
  assert.match(text, /u — продолжить подготовку с того же места/);
  assert.match(text, /• broken: Правила владельца не решают этот разговор\./);
  assert.equal(scenarioErrorText(new StaleRevisionError('a', 'b')), 'Ситуации изменились, пока вы смотрели: покажу свежее состояние.');
  assert.equal(scenarioErrorText(new LibraryConflict('x')), 'Ситуации изменились. Откройте их заново и повторите по свежему состоянию.');
});
