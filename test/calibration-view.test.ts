import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostGrant } from '../src/card/commands.js';
import { exclusionsLine } from '../src/card/calibration-view.js';
import { dialogueNumbers } from '../src/card/view.js';
import type { Experiment, Trial } from '../src/contracts.js';
import { draftHash, ExperimentLab } from '../src/experiment.js';
import { wilson } from '../src/interval.js';
import { htmlReport, markdownReport } from '../src/report.js';
import { calibrationRows, chatBlock, headRows, MAX_WIDTH, plainText, resultScreen, type ResultRow } from '../src/result-text.js';
import { buildResultView } from '../src/result-view.js';
import { libraryHash } from '../src/scenario-library.js';
import { cardInput, cardRuntime } from './helpers/card-prep.js';
import { calibrated, loggedRun, refundReading, scriptedLogJudge, type LogVerdict } from './helpers/calibration.js';

/*
 * C16: the calibration as the owner reads it — one line under the number («Синтетика совпадает с продом в 13 из 15
 * ситуаций»), what was not compared and why, and each disagreement with both verdicts, a deterministic hint from the
 * customers' paths and where both conversations are. The number and every other line stay exactly as they were.
 */

const pct = (share: number) => `${Math.round(share * 100)}%`;
/** Duty А always handled; duty Б handled by the late-style cards (odd numbers) and not by the others. */
const synthetic = (number: number) => ({ e1: 'pass' as const, e2: number % 2 ? 'pass' as const : 'fail' as const });
const same = (number: number): [LogVerdict, LogVerdict] => [synthetic(number).e1, synthetic(number).e2];

/**
 * The spec's example: 19 situations from logs — 15 compared, 13 of them agree (№14 differs on duty Б, №15 on duty А);
 * the owner changed the customer of №17 and №19; the logs of №16 and №18 end before either duty.
 */
function example(versions: Parameters<typeof calibrated>[2] = {}) {
  const run = loggedRun(19, synthetic, [17, 19]);
  const record = calibrated(run, number => number === 14 ? ['pass', 'pass'] : number === 15 ? ['fail', 'pass'] : number === 16 || number === 18 ? ['not_reached', 'not_reached'] : same(number), versions);
  return { run, record };
}

test('13 of 15: the trust line with the small-sample range, and the exclusions line in the order of its reasons', () => {
  const { run, record } = example();
  const calibration = buildResultView(record).calibration!;
  const range = wilson(13, 15)!;
  assert.deepEqual([calibration.mode, calibration.versionNote, calibration.agreed, calibration.compared, calibration.range, calibration.unfinished], ['calibration', null, 13, 15, range, null]);
  assert.equal(calibration.text, `Синтетика совпадает с продом в 13 из 15 ситуаций. Мало данных: от ${pct(range[0])} до ${pct(range[1])}.`);
  const id = (number: number) => run.scenarios[number - 1]!.id;
  assert.deepEqual(calibration.excluded, [{ reason: 'situation_edited', count: 2, cardIds: [id(17), id(19)] }, { reason: 'not_exercised_in_log', count: 2, cardIds: [id(16), id(18)] }]);
  assert.equal(exclusionsLine(calibration), 'Не сравнивались: 4 — ситуация изменена (2), в логе не дошло до ожидания (2).');
  assert.deepEqual(calibration.disagreements.map(item => [item.number, item.expectations.map(row => `${row.letter} ${row.synthetic}→${row.log}`)]), [[14, ['Б fail→pass']], [15, ['А pass→fail']]]);
});

test('a situation that is not compared takes the first reason: the log\'s own before the judge\'s, the judge\'s before the synthetic side', () => {
  const run = loggedRun(6, number => number === 6 ? { e1: 'unknown', e2: 'unknown' } : { e1: 'pass', e2: 'pass' });
  const logs: Record<number, [LogVerdict, LogVerdict]> = { 1: ['channel_unobserved', 'no_agent_reply'], 2: ['split', 'not_reached'], 3: ['split', 'channel_unobserved'], 4: ['split', 'split'], 6: ['pass', 'pass'] };
  const calibration = buildResultView(calibrated(run, number => logs[number])).calibration!;
  const id = (number: number) => run.scenarios[number - 1]!.id;
  assert.deepEqual(calibration.excluded.map(item => [item.reason, item.cardIds]), [
    ['no_agent_reply', [id(1)]], ['channel_unobserved', [id(3)]], ['not_exercised_in_log', [id(2)]], ['judge_split', [id(4)]], ['synthetic_unmeasured', [id(6)]]]);
  assert.equal(calibration.compared, 0, '№5 was never judged on its log: neither compared nor excluded');
  assert.equal(calibration.text, 'С продом сравнить не удалось: ни одна ситуация из логов не решена и в синтетике, и в логе.');
  const partial = buildResultView(calibrated(run, number => number === 1 ? ['pass', 'not_reached'] : undefined)).calibration!;
  assert.deepEqual([partial.compared, partial.agreed], [1, 1], 'a situation is compared on the expectations decided on both sides');
  assert.deepEqual(partial.excluded.map(item => [item.reason, item.cardIds]), [['synthetic_unmeasured', [id(6)]]],
    'a situation unmeasured in the synthetic run is never comparable, judged on its log or not; the others merely wait for theirs');
});

test('calibration and comparison say what they are: the version note, the plural, the unfinished calibration', () => {
  const text = (versions: Parameters<typeof calibrated>[2]) => buildResultView(example(versions).record).calibration!.text;
  assert.equal(text({ logs: 'agent-v6' }), 'С записанными диалогами совпадает в 13 из 15 ситуаций. Это не калибровка: в логах agent-v6, проверяли agent-v7.');
  assert.equal(text({ logs: null }), 'С записанными диалогами совпадает в 13 из 15 ситуаций. Это не калибровка: версия логов не указана.');
  assert.equal(text({ tested: null }), 'С записанными диалогами совпадает в 13 из 15 ситуаций. Это не калибровка: версия проверяемого агента неизвестна.');
  const big = loggedRun(21, synthetic);
  assert.equal(buildResultView(calibrated(big, same)).calibration!.text, 'Синтетика совпадает с продом в 21 из 21 ситуации.', 'enough situations: no small-sample note');
  const one = loggedRun(1, synthetic);
  assert.match(buildResultView(calibrated(one, same)).calibration!.text, /^Синтетика совпадает с продом в 1 из 1 ситуации\. Мало данных: от \d+% до 100%\.$/);
  const skipped = calibrated(one, () => undefined);
  skipped.calibration!.unfinished = 'budget';
  assert.equal(buildResultView(skipped).calibration!.text, 'Сверка с продом пропущена: не хватило лимита вызовов судьи.');
  assert.deepEqual(calibrationRows(buildResultView(skipped)), [], 'the line says it all: no empty block under it');
  assert.equal(markdownReport(skipped).includes('## Сверка с продом'), false, 'nor an empty section in the report');
  const stopped = calibrated(big, number => number < 3 ? same(number) : undefined);
  stopped.calibration!.unfinished = 'stopped';
  assert.match(buildResultView(stopped).calibration!.text, /^Синтетика совпадает с продом в 2 из 2 ситуаций\. Мало данных: .*\. Сверка не завершена: прогон остановили\.$/);
});

/** Card №1 (the number named on request) and №2 (named at once), each with one attempt the controller played: the number told, then leaving. */
function played(): Experiment {
  const run = loggedRun(2, () => ({ e1: 'pass', e2: 'pass' }));
  const record = run.record;
  record.trials = record.trials.map((trial, index): Trial => ({ ...trial, events: [
    { seq: 0, type: 'user', text: record.scenarios[index]!.user.opening }, { seq: 1, type: 'assistant', text: 'Уточните номер терминала.' },
    { seq: 2, type: 'simulator', result: { protocol: 'controlled-user-v1', decision: { actionId: 'tell_f1' }, accepted: true, from: 'talk', to: 'talk' } },
    { seq: 3, type: 'user', text: `Номер терминала: ${index ? 1001 : 5000}` }, { seq: 4, type: 'assistant', text: 'Возврат возможен. Подайте заявление в поддержку.' },
    { seq: 5, type: 'simulator', result: { protocol: 'controlled-user-v1', decision: { actionId: 'leave' }, accepted: true, from: 'talk', to: 'done' } }],
    assessments: (trial.assessments ?? []).map(assessment => ({ ...assessment, evidence: [4] })) }));
  return record;
}

test('the path hint compares the customers\' moves, deterministically, and says what the difference suggests', () => {
  const run = loggedRun(2, () => ({ e1: 'pass', e2: 'pass' }));
  const record = { ...played(), calibration: calibrated(run, number => number === 1 ? ['pass', 'fail'] : ['fail', 'pass']).calibration };
  const view = buildResultView(record, { numbers: dialogueNumbers([run.batch]) });
  const [late, known] = view.calibration!.disagreements;
  assert.deepEqual(late!.path, { synthetic: ['назвал „Номер терминала“', 'ушёл'], log: ['назвал „Номер терминала“', 'ушёл'], same: true }, 'the log named the number when asked and thanked: the same moves');
  assert.equal(late!.hint, 'Клиент тот же — различается ответ агента: проверьте окружение стенда или шум судьи.');
  assert.deepEqual([late!.trialIds, late!.log], [[record.trials[0]!.id], { importId: run.batch.id, dialogueId: 'd0', number: 1 }]);
  assert.deepEqual(known!.path, { synthetic: ['назвал „Номер терминала“', 'ушёл'], log: [], same: false }, 'the real customer never wrote again after the first message');
  assert.equal(known!.hint, 'Синтетический клиент повёл себя иначе, чем реальный: в синтетике — назвал „Номер терминала“, в логе — разговор закончился. Это дрейф симулятора или ситуации.');
  assert.deepEqual(buildResultView(record, { numbers: dialogueNumbers([run.batch]) }).calibration, view.calibration, 'the same record, the same words');
  const comparison = { ...record, calibration: { ...record.calibration!, logVersions: [] } };
  assert.equal(buildResultView(comparison).calibration!.disagreements[0]!.hint, 'Клиент тот же — вероятно, изменился агент (версии различаются или неизвестны).');
  assert.equal(buildResultView(comparison).calibration!.disagreements[0]!.log.number, null, 'without the import at hand the dialogue is named without its number');
});

test('golden: a calibration adds its line and its block and changes nothing else — the number, the cards, every other row', () => {
  const { record } = example();
  const { calibration: _dropped, ...plainRecord } = record;
  const withIt = buildResultView(record), without = buildResultView(plainRecord);
  assert.equal('calibration' in without, false, 'a run without a calibration has no such field at all');
  const { calibration, ...rest } = withIt;
  assert.deepEqual(rest, without);
  assert.deepEqual(headRows(withIt), [...headRows(without), { role: 'calibration', indent: 0, text: calibration!.text }]);
  assert.ok(chatBlock(withIt, { expanded: false }).some(row => row.text === calibration!.text), 'the trust line against production stays in the folded chat block');
  const json = (rows: ResultRow[]) => rows.map(row => JSON.stringify(row));
  const screenWith = json(resultScreen(withIt, { surface: 'cli' })), screenWithout = json(resultScreen(without, { surface: 'cli' }));
  const added = new Set(json([headRows(withIt).at(-1)!, ...calibrationRows(withIt)]));
  assert.deepEqual(screenWith.filter(row => !added.has(row)).filter((row, i, rows) => !(row === rows[i - 1] && row === JSON.stringify({ role: 'blank', indent: 0, text: '' }))), screenWithout);
});

test('the CLI screen and the customer report show the line, what was not compared and each disagreement; a logged conversation is never quoted', () => {
  const { run, record } = example();
  const view = buildResultView(record, { numbers: dialogueNumbers([run.batch]) });
  const lines = plainText(resultScreen(view, { surface: 'cli' }), MAX_WIDTH).split('\n');
  assert.ok(lines.includes(` ${view.calibration!.text}`), 'under the number');
  const block = lines.indexOf(' Сверка с продом');
  assert.ok(block > 0, lines.join('\n'));
  assert.deepEqual(lines.slice(block + 1, block + 6), [
    '   Не сравнивались: 4 — ситуация изменена (2), в логе не дошло до ожидания (2).',
    `   №14  ${run.scenarios[13]!.title}`,
    '      Б · объяснить, как оформить возврат — в синтетике: нет, в проде: выполнил',
    `      ${view.calibration!.disagreements[0]!.hint}`,
    '      Разговоры: попытка в этом прогоне · диалог №14 из логов']);
  assert.ok(lines.some(line => line.includes('С обеих сторон судит один и тот же судья')), 'what agreement does not prove');

  const bundle = { record, view, warnings: [], traceJournal: '' };
  const markdown = markdownReport(bundle), html = htmlReport(bundle);
  for (const text of [view.calibration!.text, 'Не сравнивались: 4 — ситуация изменена \\(2\\), в логе не дошло до ожидания \\(2\\).', '## Сверка с продом', '### ≠ 14. ', 'диалог №14 из логов']) assert.ok(markdown.includes(text), text);
  assert.ok(html.includes('Сверка с продом') && html.includes('≠ 14'));
  for (const report of [markdown, html]) assert.equal(report.includes('Спасибо!'), false, 'the logged customer\'s words stay in the logs');
});

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
async function summary(directory: string, id: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, 'summary', '--id', id, '--data-dir', directory]);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  return { code: await new Promise<number | null>(resolve => child.on('close', resolve)), stdout, stderr };
}

test('a run whose log disagrees reaches the CLI summary: the calibration line, the disagreement and the dialogue\'s number in its import', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-calibration-cli-'));
  const lab = new ExperimentLab(directory, { ...cardRuntime(), logJudge: scriptedLogJudge(data => data.scenario.execution.expectations[0]!.id === 'e2' && refundReading(data) === 'pass' ? 'fail' : refundReading(data)) });
  try {
    await lab.init();
    const draft = await lab.create(cardInput(), { cards: true });
    await lab.waitForIdle();
    const prepared = await lab.prepareLogVersion({ kind: 'declare_log_version', importId: (await lab.get(draft.id)).originalImport!.id, version: 'demo-baseline-v1' }, { via: 'cli-yes' });
    await lab.applyLogVersion(prepared, hostGrant(prepared, 'confirmed'));
    const { library } = await lab.readCards(draft.id);
    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    await lab.start(draft.id, { approved: true, expectedHash: draftHash(accepted.experiment) });
    await lab.waitForIdle();
    await lab.close();
    const { code, stdout, stderr } = await summary(directory, draft.id);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Синтетика совпадает с продом в 1 из 2 ситуаций\. Мало данных: от \d+% до \d+%\./);
    assert.match(stdout, /Б · объяснить, как оформить возврат — в синтетике: выполнил, в проде: нет/);
    assert.match(stdout, /Клиент тот же — различается ответ агента: проверьте окружение стенда или шум судьи\./);
    assert.match(stdout, /Разговоры: попытка в этом прогоне · диалог №1 из логов/);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});
