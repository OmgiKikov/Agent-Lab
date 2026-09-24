import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrationSchema } from '../src/card/calibration.js';
import { hostGrant } from '../src/card/commands.js';
import { CALIBRATION_CAVEATS, conversationsText, disagreementText, exclusionsLine } from '../src/card/calibration-view.js';
import { dialogueNumbers } from '../src/card/view.js';
import { fingerprint, type Experiment, type Trial } from '../src/contracts.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { wilson } from '../src/interval.js';
import { htmlReport, markdownReport } from '../src/report.js';
import { calibrationRows, chatBlock, headRows, MAX_WIDTH, plainText, resultScreen, type ResultRow } from '../src/result-text.js';
import { buildResultView } from '../src/result-view.js';
import { libraryHash } from '../src/scenario-library.js';
import { cardInput, cardRuntime } from './helpers/card-prep.js';
import { calibrated, controllerMove, loggedAttempt, loggedRun, logReview, refundReading, scriptedLogJudge, type LogVerdict } from './helpers/calibration.js';

/*
 * C16: the calibration as the owner reads it — one line under the number («Синтетика совпадает с продом в 13 из 15
 * ситуаций, расходится в 2: мягче прода в 1, строже в 1»), what was not compared and why, and each disagreement with
 * both verdicts and whose they are, a deterministic hint from the customers' paths and where both conversations are.
 * One synthetic conversation is set against one logged conversation, so the repeats never move the agreement; an
 * agreement where nothing varied says it proves nothing. The number and every other line stay exactly as they were.
 */

const pct = (share: number) => `${Math.round(share * 100)}%`;
/** Duty А always handled; duty Б handled by the late-style cards (odd numbers) and not by the others. */
const synthetic = (number: number) => ({ e1: 'pass' as const, e2: number % 2 ? 'pass' as const : 'fail' as const });
const same = (number: number): [LogVerdict, LogVerdict] => [synthetic(number).e1, synthetic(number).e2];
/** Drawn rows read as one line: where a long row wraps depends on the width. */
const unwrapped = (lines: string[]) => lines.map(line => line.trim()).filter(Boolean).join(' ');
const range = (agreed: number, compared: number) => { const [lo, hi] = wilson(agreed, compared)!; return `от ${pct(lo)} до ${pct(hi)}`; };
const SAME_CUSTOMER = 'Клиент тот же — различается ответ агента: проверьте окружение стенда или шум судьи.';

/**
 * The spec's example: 19 situations from logs — 15 compared, 13 of them agree (№14 differs on duty Б, №15 on duty А);
 * the owner changed the customer of №17 and №19; the logs of №16 and №18 end before either duty.
 */
function example(versions: Parameters<typeof calibrated>[2] = {}) {
  const run = loggedRun(19, synthetic, [17, 19]);
  const record = calibrated(run, number => number === 14 ? ['pass', 'pass'] : number === 15 ? ['fail', 'pass'] : number === 16 || number === 18 ? ['not_reached', 'not_reached'] : same(number), versions);
  return { run, record };
}

test('13 of 15: the trust line with how the others lean and the small-sample range, and the exclusions line in the order of its reasons', () => {
  const { run, record } = example();
  const calibration = buildResultView(record).calibration!;
  const interval = wilson(13, 15)!;
  assert.deepEqual([calibration.mode, calibration.versionNote, calibration.agreed, calibration.compared, calibration.range, calibration.unfinished], ['calibration', null, 13, 15, interval, null]);
  assert.deepEqual([calibration.leaning, calibration.degenerate, calibration.masked], [{ softer: 1, stricter: 1, both: 0 }, null, 0]);
  assert.equal(calibration.text, `Синтетика совпадает с продом в 13 из 15 ситуаций, расходится в 2: мягче прода в 1, строже в 1. Мало данных: ${range(13, 15)}.`);
  const id = (number: number) => run.scenarios[number - 1]!.id;
  assert.deepEqual(calibration.excluded, [{ reason: 'situation_edited', count: 2, cardIds: [id(17), id(19)] }, { reason: 'not_exercised_in_log', count: 2, cardIds: [id(16), id(18)] }]);
  assert.equal(exclusionsLine(calibration), 'Не сравнивались: 4 — ситуация изменена (2), в логе не дошло до ожидания (2).');
  assert.deepEqual(calibration.disagreements.map(item => [item.number, item.leaning, item.expectations.map(row => `${row.letter} ${row.synthetic}→${row.log}`)]),
    [[14, 'stricter', ['Б fail→pass']], [15, 'softer', ['А pass→fail']]], 'stricter: the synthetic side failed what the log passed; softer: the other way');
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

test('the log side says why it decided nothing in its own words: a judge that gave no answer, no evidence, no decision, a record that does not stand', () => {
  const run = loggedRun(6, () => ({ e1: 'pass', e2: 'pass' }));
  const logs: Record<number, [LogVerdict, LogVerdict]> = { 1: ['failed', 'failed'], 2: ['unsupported', 'unsupported'], 3: ['unclear', 'unclear'], 4: ['split', 'unclear'],
    5: ['foreign', 'foreign'], 6: ['pass', 'fail'] };
  const calibration = buildResultView(calibrated(run, number => logs[number])).calibration!;
  const id = (number: number) => run.scenarios[number - 1]!.id;
  assert.deepEqual(calibration.excluded.map(item => [item.reason, item.cardIds]), [
    ['receipt_invalid', [id(5)]], ['judge_failed', [id(1)]], ['judge_split', [id(4)]], ['no_evidence', [id(2)]], ['judge_unclear', [id(3)]]],
    'a failed request, a verdict without an event of its channel and a judge that could not tell are not «the judge split»');
  assert.equal(exclusionsLine(calibration), 'Не сравнивались: 5 — запись судьи по логу не сходится (1), ответа судьи по логу нет (1), оценки судьи по логу разошлись (1), '
    + 'в логе нет доказательства (1), судья не смог решить по логу (1).');
  assert.deepEqual([calibration.agreed, calibration.compared], [0, 1], 'only №6 was decided on both sides');
});

test('calibration and comparison say what they are: the version note, the plural, the unfinished calibration and why', () => {
  const text = (versions: Parameters<typeof calibrated>[2]) => buildResultView(example(versions).record).calibration!.text;
  assert.equal(text({ logs: 'agent-v6' }), 'С записанными диалогами совпадает в 13 из 15 ситуаций, расходится в 2: мягче логов в 1, строже в 1. Это не калибровка: в логах agent-v6, проверяли agent-v7.');
  assert.equal(text({ logs: null }), 'С записанными диалогами совпадает в 13 из 15 ситуаций, расходится в 2: мягче логов в 1, строже в 1. Это не калибровка: версия логов не указана.');
  assert.equal(text({ tested: null }), 'С записанными диалогами совпадает в 13 из 15 ситуаций, расходится в 2: мягче логов в 1, строже в 1. Это не калибровка: версия проверяемого агента неизвестна.');
  const big = loggedRun(21, synthetic);
  assert.equal(buildResultView(calibrated(big, same)).calibration!.text, 'Синтетика совпадает с продом в 21 из 21 ситуации.', 'enough situations: no small-sample note');
  assert.equal(buildResultView(calibrated(big, number => number === 2 ? ['pass', 'pass'] : same(number))).calibration!.text,
    'Синтетика совпадает с продом в 20 из 21 ситуации, расходится в 1 — строже прода.', 'one way only: said once');
  const two = loggedRun(2, synthetic);
  assert.equal(buildResultView(calibrated(two, number => number === 2 ? same(2) : undefined)).calibration!.text, `Синтетика совпадает с продом в 1 из 1 ситуации. Мало данных: ${range(1, 1)}.`);
  const skipped = calibrated(two, () => undefined);
  skipped.calibration!.unfinished = 'budget';
  assert.equal(buildResultView(skipped).calibration!.text, 'Сверка с продом пропущена: не хватило лимита вызовов судьи.');
  assert.deepEqual(calibrationRows(buildResultView(skipped)), [], 'the line says it all: no empty block under it');
  assert.equal(markdownReport(skipped).includes('## Сверка с продом'), false, 'nor an empty section in the report');
  skipped.calibration!.unfinished = 'logs';
  assert.equal(buildResultView(skipped).calibration!.text, 'Сверка с продом пропущена: логи недоступны или изменились после подготовки ситуаций.', 'a broken import is not a stopped run');
  skipped.calibration!.unfinished = 'failed';
  assert.equal(buildResultView(skipped).calibration!.text, 'Сверка с продом прервалась из-за сбоя раньше, чем удалось что-то сравнить.');
  const stopped = calibrated(big, number => number < 3 ? same(number) : undefined);
  stopped.calibration!.unfinished = 'stopped';
  assert.equal(buildResultView(stopped).calibration!.text, `Синтетика совпадает с продом в 2 из 2 ситуаций. Мало данных: ${range(2, 2)}. Сверка не завершена: прогон остановили.`);
  stopped.calibration!.unfinished = 'logs';
  assert.match(buildResultView(stopped).calibration!.text, /Сверка не завершена: логи недоступны или изменились после подготовки ситуаций\.$/);
});

test('an agreement where the agent passed, or failed, everything on both sides proves nothing about the customer, and the line says so', () => {
  const passing = loggedRun(4, () => ({ e1: 'pass', e2: 'pass' }));
  const all = buildResultView(calibrated(passing, () => ['pass', 'pass'])).calibration!;
  assert.deepEqual([all.agreed, all.compared, all.degenerate], [4, 4, 'all_pass']);
  assert.equal(all.text, 'Синтетика совпадает с продом в 4 из 4 ситуаций, но это ничего не доказывает: и в синтетике, и в проде агент справился везде — так совпал бы любой клиент.',
    'no interval either: there is nothing it would measure');
  const failing = loggedRun(4, () => ({ e1: 'fail', e2: 'fail' }));
  const none = buildResultView(calibrated(failing, () => ['fail', 'fail'], { logs: 'agent-v6' })).calibration!;
  assert.deepEqual([none.agreed, none.degenerate], [4, 'all_fail']);
  assert.equal(none.text, 'С записанными диалогами совпадает в 4 из 4 ситуаций, но это ничего не доказывает: и в синтетике, и в логах агент не справился нигде — так совпал бы любой клиент. '
    + 'Это не калибровка: в логах agent-v6, проверяли agent-v7.');
  const varied = buildResultView(calibrated(passing, number => number === 4 ? ['pass', 'fail'] : ['pass', 'pass'])).calibration!;
  assert.deepEqual([varied.degenerate, varied.text], [null, `Синтетика совпадает с продом в 3 из 4 ситуаций, расходится в 1 — мягче прода. Мало данных: ${range(3, 4)}.`],
    'once a side varies the agreement is evidence again, and its lean is named');
});

test('one conversation against one: more repeats neither make the synthetic side stricter nor move the agreement; the first usable repeat is compared', () => {
  const run = loggedRun(4, () => ({ e1: 'pass', e2: 'pass' }));
  const once = calibrated(run, number => number === 4 ? ['fail', 'pass'] : ['pass', 'pass']);
  // The same agent and customer played twice more: duty Б failed in the second repeat of every situation, as a flaky agent's does.
  const thrice: Experiment = { ...once, settings: { ...once.settings, repeats: 3 }, trials: [...once.trials, ...run.scenarios.flatMap((scenario, index) => [
    loggedAttempt(`attempt_${index + 1}_2`, scenario, { e1: 'pass', e2: 'fail' }, 1), loggedAttempt(`attempt_${index + 1}_3`, scenario, { e1: 'pass', e2: 'pass' }, 2)])] };
  const one = buildResultView(once), three = buildResultView(thrice);
  assert.deepEqual([one.headline.passed, three.headline.passed], [4, 0], 'the number reads every repeat, fail first');
  const read = (view: typeof one) => { const { agreed, compared, leaning, text } = view.calibration!; return { agreed, compared, leaning, text }; };
  assert.deepEqual(read(three), read(one), 'the calibration compares one repeat of each situation with its log: the same agreement whatever the repeats');
  assert.deepEqual([read(one).agreed, read(one).compared, read(one).leaning], [3, 4, { softer: 1, stricter: 0, both: 0 }]);
  assert.equal(three.calibration!.disagreements[0]!.trialIds[0], 'attempt_4', 'the first repeat of №4');
  assert.equal(conversationsText(three.calibration!.disagreements[0]!), 'Разговоры: попытка 1 в этом прогоне · исходный разговор из логов');

  // The first repeat of №1 broke: the first usable one stands in, and the owner is told which.
  const broken: Experiment = { ...thrice, trials: thrice.trials.map((trial): Trial => trial.id === 'attempt_1' ? { ...trial, outcome: 'invalid', invalidCause: 'agent' } : trial) };
  const standIn = buildResultView(broken, { numbers: dialogueNumbers([run.batch]) }).calibration!;
  const first = standIn.disagreements.find(item => item.number === 1)!;
  assert.deepEqual([first.trialIds, first.attempt, first.leaning], [['attempt_1_2'], 2, 'stricter'], 'repeat 2 failed duty Б, the log passed it');
  assert.equal(conversationsText(first), 'Разговоры: попытка 2 в этом прогоне · диалог №1 из логов');
});

/** Card №1 (the number named on request) and №2 (named at once), each with one attempt: the agent asks for the number, then `moves(number)`. */
function played(moves: (number: number) => unknown[] = () => [controllerMove('tell_f1'), controllerMove('leave')]): Experiment {
  const run = loggedRun(2, () => ({ e1: 'pass', e2: 'pass' }));
  const record = run.record;
  record.trials = record.trials.map((trial, index): Trial => {
    const events: Trial['events'] = [{ seq: 0, type: 'user', text: record.scenarios[index]!.user.opening }, { seq: 1, type: 'assistant', text: 'Уточните номер терминала.' }];
    moves(index + 1).forEach((result, move, all) => {
      events.push({ seq: events.length, type: 'simulator', result });
      if (move < all.length - 1) events.push({ seq: events.length, type: 'user', text: `Номер терминала: ${index ? 1001 : 5000}` },
        { seq: events.length + 1, type: 'assistant', text: 'Возврат возможен. Подайте заявление в поддержку.' });
    });
    const reply = events.filter(event => event.type === 'assistant').at(-1)!.seq;
    return { ...trial, events, assessments: (trial.assessments ?? []).map(assessment => ({ ...assessment, evidence: [reply] })) };
  });
  return record;
}

test('the path hint compares the moves both logs and the controller can record, read the same way, and says what the difference suggests', () => {
  const run = loggedRun(2, () => ({ e1: 'pass', e2: 'pass' }));
  const { calibration } = calibrated(run, number => number === 1 ? ['pass', 'fail'] : ['fail', 'pass']);
  const record = { ...played(), calibration };
  const view = buildResultView(record, { numbers: dialogueNumbers([run.batch]) });
  const [late, known] = view.calibration!.disagreements;
  assert.deepEqual(late!.path, { synthetic: ['назвал „Номер терминала“', 'ушёл'], log: ['назвал „Номер терминала“', 'ушёл'], same: true }, 'the log named the number when asked and thanked: the same moves');
  assert.equal(late!.hint, SAME_CUSTOMER);
  assert.deepEqual([late!.trialIds, late!.log], [[record.trials[0]!.id], { importId: run.batch.id, dialogueId: 'd0', number: 1 }]);
  // The number was in the first message: the synthetic customer said it again only because the agent asked again — a message the
  // card's account of a log records as nothing. The real customer never wrote again: nothing new on either side.
  assert.deepEqual(known!.path, { synthetic: ['ушёл'], log: [], same: true }, 'answering the agent\'s repeated question is not another customer');
  assert.equal(known!.hint, SAME_CUSTOMER);
  // «Этого я не знаю» to a question the card has no answer to: the card's account of a log holds no such move either.
  const unanswered = { ...played(number => number === 2 ? [controllerMove('dunno_other'), controllerMove('leave')] : [controllerMove('tell_f1'), controllerMove('leave')]), calibration };
  assert.deepEqual(buildResultView(unanswered).calibration!.disagreements[1]!.path, { synthetic: ['ушёл'], log: [], same: true });
  // A real difference is still one: the synthetic customer left without the number the logged one named.
  const leaving = { ...played(number => number === 1 ? [controllerMove('leave')] : [controllerMove('tell_f1'), controllerMove('leave')]), calibration };
  const [left] = buildResultView(leaving).calibration!.disagreements;
  assert.deepEqual(left!.path, { synthetic: ['ушёл'], log: ['назвал „Номер терминала“', 'ушёл'], same: false });
  assert.equal(left!.hint, 'Синтетический клиент повёл себя иначе, чем реальный: в синтетике — разговор закончился, в логе — назвал „Номер терминала“. Это дрейф симулятора или ситуации.');
  assert.deepEqual(buildResultView(record, { numbers: dialogueNumbers([run.batch]) }).calibration, view.calibration, 'the same record, the same words');
  const comparison = { ...record, calibration: { ...record.calibration!, logVersions: [] } };
  assert.equal(buildResultView(comparison).calibration!.disagreements[0]!.hint, 'Клиент тот же — вероятно, изменился агент (версии различаются или неизвестны).');
  assert.equal(buildResultView(comparison).calibration!.disagreements[0]!.log.number, null, 'without the import at hand the dialogue is named without its number');
});

test('a move recorded in a form the calibration does not know leaves the path unread — never «the same customer»', () => {
  const run = loggedRun(2, () => ({ e1: 'pass', e2: 'pass' }));
  const { calibration } = calibrated(run, number => number === 1 ? ['pass', 'fail'] : ['fail', 'pass']);
  const known = (first: unknown) => buildResultView({ ...played(number => number === 2 ? [first, controllerMove('leave')] : [controllerMove('tell_f1'), controllerMove('leave')]), calibration })
    .calibration!.disagreements[1]!;
  const unread = 'Путь клиента сравнить не удалось: сравните оба разговора сами.';
  for (const [move, why] of [[{ protocol: 'controlled-user-v2', move: { id: 'tell_f1' } }, 'another form of the record'], [{ decision: { actionId: 'tell_f1' }, accepted: true }, 'no protocol'],
    [controllerMove('tell_f9'), 'an action the definition does not declare']] as const) {
    const disagreement = known(move);
    assert.deepEqual([disagreement.path, disagreement.hint], [null, unread], why);
  }
  assert.deepEqual(known(controllerMove('tell_f1')).path, { synthetic: ['ушёл'], log: [], same: true }, 'the known form reads as before');
});

test('the owner\'s word counts on the side it was given — a verdict on the attempt, `log:{key}` on the log — and each side says whose it is', () => {
  const run = loggedRun(2, () => ({ e1: 'pass', e2: 'pass' }));
  const base = calibrated(run, number => number === 1 ? ['pass', 'pass'] : ['pass', 'fail']);
  assert.equal(buildResultView(base).calibration!.agreed, 1);
  // The owner read the attempt of №1: the agent did not explain the refund, although the judge said it did — as it said on the log.
  const marked: Experiment = { ...base, humanReviews: [{ id: 'review_1', createdAt: 'now', trialId: 'attempt_1', metricId: 'e2', verdict: 'fail', note: 'Агент не объяснил возврат.' }] };
  const one = buildResultView(marked).calibration!;
  const [first] = one.disagreements;
  assert.deepEqual([first!.number, first!.leaning, first!.expectations.map(row => row.decidedBy)], [1, 'stricter', [{ synthetic: 'owner', log: 'judge' }]]);
  assert.equal(disagreementText(first!.expectations[0]!), 'Б · объяснить, как оформить возврат — в синтетике: нет (ваша отметка), в проде: выполнил');
  assert.equal(first!.hint, 'В попытке решение ваше, по логу — судьи: проверьте, прав ли судья по логу.', 'not a drift of the customer: the judge may be as wrong on the log');
  assert.ok(CALIBRATION_CAVEATS[0].startsWith('Где вы не поправляли судью, обе стороны оценивает один и тот же судья'), 'the caveat no longer claims one judge where the owner corrected it');

  // The owner reads the log too.
  const receipt = marked.calibration!.entries.find(entry => entry.cardId === run.scenarios[0]!.id && entry.expectationId === 'e2')!;
  const withMarks = (...reviews: ReturnType<typeof logReview>[]): Experiment => ({ ...marked, calibration: { ...marked.calibration!, reviews } });
  const both = buildResultView(withMarks(logReview(receipt, 'fail'))).calibration!;
  assert.deepEqual([both.agreed, both.compared, both.disagreements.map(item => item.number)], [1, 2, [2]], 'both sides are the owner\'s word now, and they agree');
  const onLog = buildResultView({ ...base, calibration: { ...base.calibration!, reviews: [logReview(receipt, 'fail')] } }).calibration!.disagreements[0]!;
  assert.deepEqual([onLog.number, onLog.expectations[0]!.decidedBy, onLog.hint], [1, { synthetic: 'judge', log: 'owner' }, 'По логу решение ваше, в попытке — судьи: проверьте, прав ли судья в попытке.']);
  assert.equal(disagreementText(onLog.expectations[0]!), 'Б · объяснить, как оформить возврат — в синтетике: выполнил, в проде: нет (ваша отметка)');
  // A one-key «не знаю» leaves the judge's verdict in place; a considered one takes the log side out; the latest word holds.
  assert.deepEqual(buildResultView(withMarks(logReview(receipt, 'unknown', 'quick'))).calibration!.disagreements[0]!.expectations[0]!.decidedBy, { synthetic: 'owner', log: 'judge' });
  const e1 = marked.calibration!.entries.find(entry => entry.cardId === run.scenarios[0]!.id && entry.expectationId === 'e1')!;
  assert.deepEqual(buildResultView(withMarks(logReview(receipt, 'unknown'), logReview(e1, 'unknown'))).calibration!.excluded.map(item => [item.reason, item.count]), [['owner_unknown', 1]]);
  assert.deepEqual(buildResultView(withMarks(logReview(receipt, 'pass'), logReview(receipt, 'fail'))).calibration!.agreed, 1, 'the later verdict replaces the earlier');

  // Stored as it was given: a record with the owner's verdicts on the log parses unchanged, and one written before them too.
  const stored = withMarks(logReview(receipt, 'fail')).calibration!;
  assert.deepEqual(calibrationSchema.parse(JSON.parse(JSON.stringify(stored))), stored);
  assert.equal(fingerprint(calibrationSchema.parse(base.calibration)), fingerprint(base.calibration), 'no field is added to a calibration without them');
});

test('a situation whose masked values Lab filled is compared with its log, and the line says the logs hid them', () => {
  const run = loggedRun(4, () => ({ e1: 'pass', e2: 'pass' }));
  const record = calibrated(run, number => number === 4 ? ['pass', 'fail'] : ['pass', 'pass']);
  const library = record.librarySnapshot;
  assert.ok(library?.formatVersion === 2);
  // Lab wrote a plausible value over a mark in the first message of №1 and №2: every message and fact is still the log's.
  const filled: Experiment = { ...record, librarySnapshot: { ...library, cards: library.cards.map(card => card.number > 2 ? card
    : { ...card, filled: [{ event: { batchId: run.batch.id, dialogueId: `d${card.number - 1}`, eventIndex: 0 }, span: 0, mark: '#', kind: 'count' as const, value: '3' }] }) } };
  const view = buildResultView(filled).calibration!;
  assert.deepEqual([view.compared, view.masked, view.excluded], [4, 2, []], 'not «situation edited»');
  assert.equal(view.text, `Синтетика совпадает с продом в 3 из 4 ситуаций, расходится в 1 — мягче прода. В 2 из них значения в логах скрыты, в синтетике — подставлены Lab. Мало данных: ${range(3, 4)}.`);
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
  assert.ok(unwrapped(lines).includes(view.calibration!.text), 'under the number');
  const block = lines.indexOf(' Сверка с продом');
  assert.ok(block > 0, lines.join('\n'));
  assert.deepEqual(lines.slice(block + 1, block + 6), [
    '   Не сравнивались: 4 — ситуация изменена (2), в логе не дошло до ожидания (2).',
    `   №14  ${run.scenarios[13]!.title}`,
    '      Б · объяснить, как оформить возврат — в синтетике: нет, в проде: выполнил',
    `      ${SAME_CUSTOMER}`,
    '      Разговоры: попытка в этом прогоне · диалог №14 из логов']);
  assert.ok(unwrapped(lines).includes(CALIBRATION_CAVEATS[0]), 'what agreement does not prove');

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
    const draft = await lab.create(cardInput());
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
    const text = unwrapped(stdout.split('\n'));
    assert.match(text, /Синтетика совпадает с продом в 1 из 2 ситуаций, расходится в 1 — мягче прода\. Мало данных: от \d+% до \d+%\./);
    assert.match(text, /Б · объяснить, как оформить возврат — в синтетике: выполнил, в проде: нет/);
    assert.match(text, /Клиент тот же — различается ответ агента: проверьте окружение стенда или шум судьи\./);
    assert.match(text, /Разговоры: попытка в этом прогоне · диалог №1 из логов/);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});
