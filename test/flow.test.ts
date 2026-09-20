import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { activeRunRows, preparationRows, progressLine } from '../extensions/flow.ts';
import { LabBoard, type BoardAction } from '../extensions/cards.ts';
import { draftHash } from '../dist/experiment.js';
import { demoEvaluateRecord } from './helpers/demo-record.js';

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };

test('the primary path confirms expectations, opens launch, then drills from result into evidence', async () => {
  const demo = await demoEvaluateRecord('agent-lab-primary-flow-');
  try {
    const record = demo.record;
    const draft = { ...structuredClone(record), phase: 'review' as const, trials: [], reviewedAt: null };
    const actions: BoardAction[] = [];
    const first = new LabBoard({ record: draft, section: 'cards' }, theme, a => actions.push(a), () => {});
    assert.match(first.render(100).join('\n'), /Enter — подтвердить ожидания/);
    first.handleInput('\r'); assert.equal(actions[0]?.type, 'accept');
    const accepted = { ...draft, acceptedDraftHash: draftHash(draft) };
    const second = new LabBoard({ record: accepted, section: 'cards' }, theme, a => actions.push(a), () => {});
    assert.match(second.render(100).join('\n'), /Enter — проверить план и запустить/);
    second.handleInput('\r'); assert.equal(actions[1]?.type, 'run');
    const result = new LabBoard({ record, section: 'agent' }, theme, a => actions.push(a), () => {}, () => 80);
    assert.match(result.render(100).join('\n'), /Enter — разобрать результаты/);
    result.handleInput('\r');
    assert.match(result.render(100).join('\n'), /Enter — открыть выбранный диалог/);
    result.handleInput('\r');
    assert.match(result.render(100).join('\n'), /ДИАЛОГ/);
    assert.match(result.render(100).join('\n'), /Enter — вернуться к объяснению/);
    result.handleInput('\x1b');
    assert.match(result.render(100).join('\n'), /Enter — открыть выбранный диалог/);
    result.dispose();
    assert.equal(actions.length, 2, 'reading and navigating do not emit write actions');
  } finally { await demo.lab.close(); await rm(demo.directory, { recursive: true, force: true }); }
});

test('progress uses recorded completion and unknown cost without invented ETA or preparing percentage', async () => {
  const demo = await demoEvaluateRecord('agent-lab-progress-flow-');
  try {
    const record = structuredClone(demo.record);
    record.mode='live';record.usage.costUsd=null;record.phase='evaluating';
    assert.match(progressLine(record), /Диалогов \d+ из \d+ · стоимость неизвестна/);
    assert.match(activeRunRows(record).map(r=>r.text).join('\n'), /работа продолжится, пока открыт Pi/);
    record.phase='preparing';record.scenarios=[];
    assert.match(progressLine(record), /собираем ожидания/);
    assert.doesNotMatch(progressLine(record), /%/);
    assert.match(preparationRows(record).map(r=>r.text).join('\n'), /Запуск агента подтверждается отдельно/);
  } finally { await demo.lab.close(); await rm(demo.directory, { recursive: true, force: true }); }
});

test('history refreshes an active run into its result and keeps the selected record', async () => {
  const demo = await demoEvaluateRecord('agent-lab-history-progress-');
  let board: LabBoard | undefined;
  try {
    const completed = demo.record;
    let refreshed!: () => void;
    const ready = new Promise<void>(resolve => { refreshed = resolve; });
    board = new LabBoard({ records: [{ ...completed, phase: 'evaluating' }],
      loadRecords: async () => [completed] }, theme, () => {}, refreshed, () => 40);
    assert.match(board.render(100).join('\n'), /ИДУТ ДИАЛОГИ/);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ready, new Promise((_, reject) => { timeout=setTimeout(()=>reject(new Error('history did not refresh')),3000); })]);
    } finally { clearTimeout(timeout); }
    assert.match(board.render(100).join('\n'), /ПРОВЕРЬТЕ РЕЗУЛЬТАТЫ/);
    assert.doesNotMatch(board.render(100).join('\n'), /ИДУТ ДИАЛОГИ/);
  } finally { board?.dispose(); await demo.lab.close(); await rm(demo.directory, { recursive: true, force: true }); }
});
