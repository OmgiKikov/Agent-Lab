import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { LabBoard, type BoardAction, type BoardOptions } from '../extensions/cards.ts';
import { logsRows, runRows, scenarioErrorText, scenarioRows } from '../extensions/scenarios.ts';
import { libraryFixture } from './helpers/scenario-library.js';
import { demoEvaluateRecord } from './helpers/demo-record.js';

const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value };

async function recordFixture() {
  const fixture = await demoEvaluateRecord('scenario-view-');
  const record = structuredClone(fixture.record);
  const library = libraryFixture();
  Object.assign(record, {
    phase: 'review', scenarios: [], trials: [], librarySnapshot: library,
    sources: library.sources, requirements: library.requirements,
    preparationProgress: { protocol: 'chronological-scenarios-v1', processed: ['terminal'], pending: ['repeated'],
      excluded: [{ dialogueId: 'broken', reason: 'Некорректная запись' }], status: 'partial' },
  });
  return { ...fixture, record };
}

test('native scenario workspace shows four stages, grouped readiness, source quote and honest import progress', async () => {
  const { lab, directory, record } = await recordFixture();
  try {
    const board = new LabBoard({ record, section: 'cards' }, theme, () => {}, () => {}, () => 42);
    const text = stripTerminalSequences(board.render(120).join('\n'));
    assert.match(text, /1 Логи.*2 Сценарии.*3 Прогон.*4 Результаты/s);
    assert.match(text, /Возврат/);
    assert.match(text, /готов|требует решения/i);
    assert.match(text, /Номер терминала: 1234/);
    assert.match(text, /цитат|источник/i);
    assert.match(text, /Получена достаточная инструкция → завершить разговор/i);
    assert.match(text, /e изменить реплику, цель, ожидание, правило или факт/i);
    assert.match(logsRows(record).map(row => row.text).join('\n'), /обработано: 1.*ожидают: 1.*исключено: 1/is);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('selection controls survive board recreation and bulk acceptance never emits a run action', async () => {
  const { lab, directory, record } = await recordFixture();
  try {
    const selectedVariantIds: string[] = [];
    const options: BoardOptions = { record, section: 'cards', selectedVariantIds };
    let action: BoardAction | undefined;
    const first = new LabBoard(options, theme, value => { action = value; }, () => {}, () => 38);
    first.handleInput(' ');
    assert.deepEqual(selectedVariantIds, ['variant_1']);
    first.handleInput('\x1b');
    assert.equal(action?.type, 'back');

    action = undefined;
    const reopened = new LabBoard(options, theme, value => { action = value; }, () => {}, () => 38);
    assert.match(stripTerminalSequences(reopened.render(110).join('\n')), /выбрано для прогона: 1/i);
    reopened.handleInput('y');
    assert.equal(action?.type, 'acceptLibrary');
    if (action?.type === 'acceptLibrary') assert.deepEqual(action.variantIds, ['variant_1']);
    assert.notEqual(action?.type, 'run');
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('uncertain grouping and stale edits give an explicit owner decision and recovery action', async () => {
  const { lab, directory, record } = await recordFixture();
  try {
    record.librarySnapshot!.businessScenarios[0]!.grouping = { status: 'uncertain', reason: 'Цели похожи, условия могут различаться' };
    const text = scenarioRows(record, 'variant_1', ['variant_1']).map(row => row.text).join('\n');
    assert.match(text, /нужно решение владельца/i);
    assert.match(text, /m объединить|s разделить/i);
    assert.match(scenarioErrorText(new Error('Библиотека изменилась: хеш устарел')), /откройте.*заново|обнов/i);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('run stage leads with accepted revision, selected count and real remaining budget', async () => {
  const { lab, directory, record } = await recordFixture();
  try {
    record.usage.calls = 10;
    record.settings.maxCalls = 20;
    record.librarySnapshot!.acceptance = undefined;
    const text = runRows(record, ['variant_1']).map(row => row.text).join('\n');
    assert.match(text, /Ревизия 1/);
    assert.match(text, /выбрано: 1/);
    assert.match(text, /использовано 10.*осталось 10/i);
    assert.match(text, /сначала принять/i);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('accepted library selection changes require reacceptance; Enter label matches native action', async () => {
  const { lab, directory, record } = await recordFixture();
  try {
    const { acceptLibrary, compileLibrary, libraryHash } = await import('../src/scenario-library.js');
    record.librarySnapshot = acceptLibrary(record.librarySnapshot!, libraryHash(record.librarySnapshot!), ['variant_1']);
    record.scenarios = compileLibrary(record.librarySnapshot);
    record.reviewedAt = null;
    let action: BoardAction | undefined;
    const board = new LabBoard({ record, section: 'cards', selectedVariantIds: ['variant_1'] }, theme, a => { action = a; }, () => {}, () => 45);
    assert.match(stripTerminalSequences(board.render(120).join('\n')), /Enter — принять выбранные варианты/);
    assert.match(stripTerminalSequences(board.render(72).join('\n')), /Карточка 1 из 2/);
    board.handleInput('\r'); assert.equal(action?.type, 'acceptLibrary');
    const pending = new LabBoard({ record, section: 'agent', selectedVariantIds: ['variant_1', 'variant_2'] }, theme, a => { action = a; }, () => {}, () => 45);
    assert.match(stripTerminalSequences(pending.render(120).join('\n')), /выбор изменён.*принять заново/is);
    action = undefined; pending.handleInput('r'); assert.equal(action, undefined);
    pending.handleInput('\r'); assert.equal(action, undefined);
    const rows = scenarioRows(record, 'variant_1', ['variant_1']).map(r => r.text).join('\n');
    assert.match(rows, /происхождение: из диалогов/); assert.doesNotMatch(rows, /происхождение: production/);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});
