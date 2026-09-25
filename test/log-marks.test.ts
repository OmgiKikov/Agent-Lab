import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { TOOL } from '../extensions/steps.ts';
import { hostGrant } from '../src/card/commands.js';
import { calibrationSchema } from '../src/card/calibration.js';
import { logAnswerOf, logRefusal, logTargets } from '../src/card/calibration-view.js';
import type { Experiment } from '../src/contracts.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash, resultHash } from '../src/lab/record.js';
import { buildResultView } from '../src/result-view.js';
import { libraryHash } from '../src/scenario-library.js';
import { cardInput, cardRuntime } from './helpers/card-prep.js';
import { calibrated, loggedRun, logReceipt, refundReading, scriptedLogJudge } from './helpers/calibration.js';
import { CLOSE, KEY, noticeOf, output, registered, workspaceSession } from './helpers/pi-session.js';
import { openWorkspace } from './helpers/workspace.js';

/*
 * The owner's word on the judge's reading of a logged conversation (docs/design/card-v2-spec.md §10.3, `log:{key}`): the
 * calibration's hint sends the owner to check the judge on the log, and the answer is recorded — by the engine beside the
 * log judge's receipt, never over it — from the chat's native dialog, the board's key and the command line's --yes. What
 * the owner was shown goes with the answer; only the comparison with production moves, never the number. Invented data.
 */

/** Duty Б as the log judge reads it here: failed wherever the refund reading passes it — the logged agent explained the refund. */
const strictOnB = scriptedLogJudge(data => data.scenario.execution.expectations[0]!.id === 'e2' && refundReading(data) === 'pass' ? 'fail' : refundReading(data));
const REASON = 'В логе агент объяснил, как оформить возврат.';

/**
 * A finished run of the two refund situations whose logs are declared the tested version: №1 disagrees with its logged
 * conversation on duty Б (the synthetic agent explained the refund, the log judge says the logged one did not).
 */
async function disagreeing(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-log-marks-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = join(cwd, '.agent-lab');
  const lab = new ExperimentLab(directory, { ...cardRuntime(), logJudge: strictOnB });
  await lab.init();
  try {
    const draft = await lab.create(cardInput());
    await lab.waitForIdle();
    const prepared = await lab.prepareLogVersion({ kind: 'declare_log_version', importId: (await lab.get(draft.id)).originalImport!.id, version: 'demo-baseline-v1' }, { via: 'cli-yes' });
    await lab.applyLogVersion(prepared, hostGrant(prepared, 'confirmed'));
    const { library } = await lab.readCards(draft.id);
    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    await lab.start(draft.id, { approved: true, reviewer: 'expectations', expectedHash: draftHash(accepted.experiment) });
    await lab.waitForIdle();
    const record = await lab.get(draft.id);
    const [differs] = buildResultView(record).calibration!.disagreements;
    assert.ok(differs, 'the fixture disagrees with its log');
    return { cwd, directory, record, cardId: differs.cardId, read: () => new ExperimentLab(directory).get(record.id) };
  } finally { await lab.close(); }
}

test('the engine keeps the owner\'s word beside the log judge\'s receipt: what the owner saw is read from it, the latest word holds, the number and the review stay', async t => {
  const folder = await disagreeing(t);
  const lab = new ExperimentLab(folder.directory);
  await lab.init();
  t.after(() => lab.close());
  const before = await lab.get(folder.record.id);
  const view = buildResultView(before);
  const targets = logTargets(before, folder.cardId);
  assert.deepEqual(targets.map(target => [target.letter, target.judge]), [['А', 'pass'], ['Б', 'fail']], 'both duties of №1 the judge decided on its log');
  const b = targets[1]!;
  const entry = before.calibration!.entries.find(item => item.key === b.key)!;
  await assert.rejects(lab.addLogReview(before.id, { key: b.key, verdict: 'pass', note: REASON, source: 'quick', judgeVerdict: 'pass' }), /изменилась, пока вы смотрели/,
    'the owner was shown another verdict than the receipt holds');
  await assert.rejects(lab.addLogReview(before.id, { key: 'f'.repeat(64), verdict: 'pass', note: REASON, source: 'quick' }), /Такой оценки судьи по разговору из логов/);
  assert.equal((await lab.get(before.id)).calibration!.reviews, undefined, 'a refused answer writes nothing');

  const after = await lab.addLogReview(before.id, { key: b.key, verdict: 'pass', note: REASON, source: 'quick', judgeVerdict: 'fail' });
  const stored = after.calibration!.reviews!.at(-1)!;
  assert.deepEqual([stored.key, stored.verdict, stored.source, stored.judgeVerdict, stored.judge, stored.note],
    [b.key, 'pass', 'quick', 'fail', { protocolHash: entry.protocolHash, inputHash: entry.inputHash }, REASON]);
  assert.deepEqual(calibrationSchema.parse(JSON.parse(JSON.stringify(after.calibration))), after.calibration, 'stored as the calibration contract holds it');
  const moved = buildResultView(after);
  assert.deepEqual([moved.calibration!.agreed, moved.calibration!.disagreements.length], [view.calibration!.agreed + 1, 0], 'the log side is the owner\'s now, and it agrees');
  assert.deepEqual([moved.headline, after.phase, resultHash(after)], [view.headline, before.phase, resultHash(before)], 'the number, the phase and the results\' hash never move');
  // A one-key «не знаю» leaves the judge's verdict standing; the latest word replaces the earlier one.
  await lab.addLogReview(before.id, { key: b.key, verdict: 'unknown', note: 'Быстрая отметка: не могу сказать.', source: 'quick', judgeVerdict: 'fail' });
  assert.equal(buildResultView(await lab.get(before.id)).calibration!.disagreements.length, 1, 'the doubt put the judge\'s verdict back');
});

test('the engine refuses what cannot be answered: a log the judge never read, a judge that decided nothing, a run not finished', async t => {
  const run = loggedRun(2, () => ({ e1: 'pass', e2: 'pass' }));
  const record: Experiment = calibrated(run, number => number === 1 ? ['no_agent_reply', 'split'] : ['pass', 'fail']);
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-log-refusals-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lab = new ExperimentLab(directory);
  await lab.init();
  t.after(() => lab.close());
  await lab.store.save(record);
  const skipped = logReceipt(run, 1, 'e1', 'no_agent_reply'), split = logReceipt(run, 1, 'e2', 'split');
  await assert.rejects(lab.addLogReview(record.id, { key: skipped.key, verdict: 'pass', note: REASON }), /Судья не читал этот разговор/);
  await assert.rejects(lab.addLogReview(record.id, { key: split.key, verdict: 'pass', note: REASON, source: 'quick' }), /соглашаться не с чем/);
  // A considered verdict decides where the judge could not: the owner read the log themselves.
  const decided = await lab.addLogReview(record.id, { key: split.key, verdict: 'pass', note: REASON });
  assert.equal(decided.calibration!.reviews!.at(-1)!.judgeVerdict, 'unknown', 'what the owner saw is the judge\'s undecided verdict, read from the receipt');
  assert.equal(logRefusal(record, run.scenarios[0]!.id), 'Судья не вынес решения по разговору из логов этой ситуации — соглашаться не с чем.');
  assert.equal(logRefusal({ ...record, calibration: undefined } as Experiment, run.scenarios[0]!.id), 'У этого прогона нет сверки с продом: судья не читал разговоры из логов.');
  await lab.store.save({ ...record, phase: 'evaluating' });
  await assert.rejects(lab.addLogReview(record.id, { key: logReceipt(run, 2, 'e2', 'fail').key, verdict: 'pass', note: REASON, source: 'quick' }), /только по завершённому прогону/);
});

/** A Pi terminal whose native dialogs answer as scripted: `picks` for the selects, `texts` for the editors. */
function terminal(cwd: string, picks: ((options: string[]) => string | undefined)[], texts: (string | undefined)[]) {
  const selects: { title: string; options: string[] }[] = [], editors: { title: string; prefill: string }[] = [];
  const ctx = { cwd, mode: 'tui', hasUI: true, ui: {
    select: async (title: string, options: string[]) => { selects.push({ title, options }); return picks.shift()?.(options); },
    editor: async (title: string, prefill: string) => { editors.push({ title, prefill }); return texts.shift(); },
    notify() {}, setStatus() {}, setWidget() {} } } as unknown as ExtensionContext;
  return { ctx, selects, editors };
}

test('in the chat the owner answers about the judge\'s reading of the log natively: the verdicts asked, the duty disputed, the reason in their words', { timeout: 60000 }, async t => {
  const folder = await disagreeing(t);
  const { tools, shutdown } = registered();
  t.after(shutdown);
  const agree = async (params: Record<string, unknown>, ctx: ExtensionContext) => output(await tools.get(TOOL.agree)!.execute('agree', params, undefined, undefined, ctx));
  // Closing the question writes nothing.
  const closed = terminal(folder.cwd, [() => undefined], []);
  assert.deepEqual(await agree({ situation: 1, log: true }, closed.ctx), { run: folder.record.id, log: true, marked: false });
  assert.match(closed.selects[0]!.title, /^«Возврат оплаты — номер по просьбе»\. Судья по логу решил: А — выполнил, Б — не выполнил\. Вы согласны\?$/);
  assert.equal((await folder.read()).calibration!.reviews, undefined);

  const answered = terminal(folder.cwd, [options => options[1], options => options.find(option => option.startsWith('Б — '))], [REASON]);
  const result = await agree({ situation: 1, log: true }, answered.ctx);
  assert.deepEqual(answered.selects[1]!.options, ['А — не запрашивать номер терминала повторно, если клиент его уже назвал: агент этого не сделал',
    'Б — объяснить, как оформить возврат: агент это сделал', 'Со всеми: судья по логу ошибся в каждом'], 'which of the judge\'s verdicts the owner disputes');
  assert.equal(answered.editors[0]!.title, 'Почему судья по разговору из логов ошибся? Коротко, своими словами.');
  assert.equal(result.answer, 'disagree');
  assert.match(result.calibration, /^Синтетика совпадает с продом в 2 из 2 ситуаций/);
  const reviews = (await folder.read()).calibration!.reviews!;
  assert.deepEqual(reviews.map(review => [review.verdict, review.judgeVerdict, review.source, review.note]),
    [['pass', 'pass', 'quick', 'Быстрая отметка: согласен с судьёй.'], ['pass', 'fail', 'quick', REASON]], 'disputing Б is agreeing with А');

  // The same answer again writes nothing.
  const again = terminal(folder.cwd, [options => options[1], options => options.find(option => option.startsWith('Б — '))], [REASON]);
  await agree({ situation: 1, log: true }, again.ctx);
  assert.equal((await folder.read()).calibration!.reviews!.length, 2, 'the same disagreement is not written twice');
});

test('on the board a disagreement of «Сверка с продом» opens the logged conversation and takes 1–3; the answer is the owner\'s native reason', { timeout: 60000 }, async t => {
  const folder = await disagreeing(t);
  const board = await openWorkspace(folder.directory);
  board.press('d');
  // The cursor walks the causes, then the situations that disagree with production, then «Дальше».
  let screen = board.screen();
  for (let step = 0; step < 12 && !screen.includes('› №1'); step++) screen = board.press(KEY.down);
  assert.match(screen, /› №1 {2}Возврат оплаты — номер по просьбе/, screen);
  screen = board.press(KEY.enter);
  for (const text of ['≠ №1  Возврат оплаты — номер по просьбе', 'Б · объяснить, как оформить возврат — в синтетике: выполнил, в проде: нет', 'Разговор из логов',
    'Судья по логу решил: А — выполнил, Б — не выполнил. Вы согласны?   1 да · 2 нет · 3 не знаю']) assert.ok(screen.includes(text), `${text}\n${screen}`);
  board.press('2');
  const targets = logTargets(folder.record, folder.cardId);
  assert.deepEqual(board.actions, [{ type: 'mark_log', runId: folder.record.id, cardId: folder.cardId, answer: 'disagree', seen: Object.fromEntries(targets.map(target => [target.key, target.judge])) }]);

  // The command records it through the same helper as the chat, the owner's reason from the native editor.
  const { command, shutdown } = registered();
  t.after(shutdown);
  const session = workspaceSession(folder.cwd);
  session.state.reason = REASON;
  session.state.choice = (_title, options) => options.find(option => option.startsWith('Б — '));
  session.state.steps = [{ action: board.actions[0]! as unknown as Record<string, unknown> }, CLOSE];
  await command('', session.ctx);
  assert.equal(noticeOf(session.screens[1]!), 'Отмечено по разговору из логов: не согласен с судьёй · «Возврат оплаты — номер по просьбе». Теперь ситуация совпадает с продом.');
  const record = await folder.read();
  assert.equal(logAnswerOf(record, targets), 'disagree');
  assert.equal(buildResultView(record).calibration!.disagreements.length, 0);
  // A verdict the owner was shown that the receipt no longer says is refused, never recorded.
  const stale = workspaceSession(folder.cwd);
  stale.state.steps = [{ action: { ...board.actions[0]!, seen: Object.fromEntries(targets.map(target => [target.key, 'pass'])) } as unknown as Record<string, unknown> }, CLOSE];
  await command('', stale.ctx);
  assert.match(noticeOf(stale.screens[1]!), /изменилась, пока вы смотрели/);
  assert.equal((await folder.read()).calibration!.reviews!.length, 2);
});

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
async function cli(directory: string, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // A shell outside the chat: the owner's --yes is theirs to give.
  const env = { ...process.env };
  delete env.AGENT_LAB_SESSION;
  const child = spawn(process.execPath, [CLI, ...args, '--data-dir', directory], { env });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  return { code: await new Promise<number | null>(resolve => child.on('close', resolve)), stdout, stderr };
}

test('on the command line `calibration` shows the disagreements and takes the owner\'s word: previewed without --yes, written with it', { timeout: 60000 }, async t => {
  const folder = await disagreeing(t);
  const id = folder.record.id;
  const listed = await cli(folder.directory, 'calibration', '--id', id);
  assert.equal(listed.code, 0, listed.stderr);
  for (const text of ['Синтетика совпадает с продом в 1 из 2 ситуаций', 'Сверка с продом', '№1  Возврат оплаты — номер по просьбе',
    `agent-lab calibration --id ${id} --card 1 --choice agree|disagree|unsure`]) assert.ok(listed.stdout.includes(text), `${text}\n${listed.stdout}`);
  const unasked = await cli(folder.directory, 'calibration', '--id', id, '--card', '1', '--expectation', 'б');
  assert.equal(unasked.code, 1);
  assert.match(unasked.stderr, /Судья по логу решил: Б — не выполнил\. Вы согласны\? Ответ: --choice agree/);
  const reasonless = await cli(folder.directory, 'calibration', '--id', id, '--card', '1', '--expectation', 'Б', '--choice', 'disagree', '--yes');
  assert.match(reasonless.stderr, /напишите, почему судья ошибся: --text/);
  const preview = await cli(folder.directory, 'calibration', '--id', id, '--card', '1', '--expectation', 'Б', '--choice', 'disagree', '--text', REASON);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(preview.stdout, `Судья по логу решил: Б — не выполнил. Вы согласны?\nВаш ответ: нет, судья ошибся — «${REASON}».\n`
    + 'Записать: та же команда с --yes. Число не изменится: ответ меняет только сверку с продом.\n');
  assert.equal((await folder.read()).calibration!.reviews, undefined, 'without --yes nothing is written');
  const written = await cli(folder.directory, 'calibration', '--id', id, '--card', '1', '--expectation', 'Б', '--choice', 'disagree', '--text', REASON, '--yes');
  assert.equal(written.code, 0, written.stderr);
  assert.match(written.stdout, /Записано\. Синтетика совпадает с продом в 2 из 2 ситуаций/);
  assert.deepEqual((await folder.read()).calibration!.reviews!.map(review => [review.verdict, review.judgeVerdict, review.note]), [['pass', 'fail', REASON]]);
  const chat = spawn(process.execPath, [CLI, 'calibration', '--id', id, '--card', '1', '--choice', 'agree', '--yes', '--data-dir', folder.directory], { env: { ...process.env, AGENT_LAB_SESSION: '1' } });
  let refused = '';
  chat.stderr.on('data', data => { refused += data; });
  assert.equal(await new Promise(resolve => chat.on('close', resolve)), 1);
  assert.match(refused, /Из чата Agent Lab команда с --yes не выполняется/);
});
