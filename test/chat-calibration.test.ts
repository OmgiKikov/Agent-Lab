import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { TOOL } from '../extensions/steps.ts';
import { draftHash, ExperimentLab } from '../src/experiment.js';
import { decisions } from '../src/inbox.js';
import { buildResultView } from '../src/result-view.js';
import { libraryHash } from '../src/scenario-library.js';
import { calibrated, loggedRun, refundReading, scriptedLogJudge } from './helpers/calibration.js';
import { cardInput, cardRuntime } from './helpers/card-prep.js';
import { CLOSE, noticeOf, output, registered, workspaceSession } from './helpers/pi-session.js';

/*
 * The logs' agent version (card-v2 §10.2) as the owner's decision: a run that compared its situations with logs of an
 * undeclared version asks which agent wrote them — one decision in the workspace's queue and one step in the chat —
 * and the answer is recorded only from the owner's pick. The run keeps what it used; the next comparison reads it.
 */

const both = (number: number) => ({ e1: 'pass' as const, e2: number % 2 ? 'pass' as const : 'fail' as const });

test('a calibrated run whose logs have no version asks which agent wrote them; a named version, an older snapshot or no calibration asks nothing', () => {
  const run = loggedRun(4, both);
  const record = calibrated(run, () => ['pass', 'pass'], { logs: null, tested: 'agent-v7' });
  const input = (logs: { importId: string; declared: boolean }[], at = record) => decisions({ run: { record: at, view: buildResultView(at) }, logs });
  const [asked] = input([{ importId: run.batch.id, declared: false }]);
  assert.equal(asked!.key, `logs:${run.batch.id}`);
  assert.match(asked!.subject, /^Сверка с продом · прогон /);
  assert.equal(asked!.text, 'Какая версия агента записала логи? Пока она не названа, совпадение с продом — только сравнение, а не калибровка.');
  assert.deepEqual(asked!.choices.map(choice => [choice.label, choice.action]), [
    ['Та же, что проверяли — agent-v7', { kind: 'declare_log_version', importId: run.batch.id, version: 'agent-v7' }],
    ['Назвать версию', { kind: 'name_log_version', importId: run.batch.id }],
    ['Неизвестна', { kind: 'declare_log_version', importId: run.batch.id, version: null }]]);
  assert.deepEqual(input([{ importId: run.batch.id, declared: true }]), [], 'named since the run: the next comparison reads it');
  assert.deepEqual(input([{ importId: run.batch.id, declared: false }], calibrated(run, () => ['pass', 'pass'], { logs: 'agent-v6' })), [], 'the run already used a named version');
  assert.deepEqual(input([{ importId: run.batch.id, declared: false }], run.record), [], 'no calibration, nothing to name');
  const untested = input([{ importId: run.batch.id, declared: false }], calibrated(run, () => ['pass', 'pass'], { logs: null, tested: null }));
  assert.deepEqual(untested[0]!.choices.map(choice => choice.label), ['Назвать версию', 'Неизвестна'], 'no version was tested: nothing to offer as the same');
  assert.deepEqual(decisions({ run: { record, view: buildResultView(record) } }), [], 'a surface that read no journal derives no decision');
});

/** A finished run of the refund fixtures, compared with its logs by a scripted log judge; no version was ever declared. */
async function calibratedFolder(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-log-version-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const lab = new ExperimentLab(join(cwd, '.agent-lab'), { ...cardRuntime(), logJudge: scriptedLogJudge(refundReading) });
  await lab.init();
  try {
    const draft = await lab.create(cardInput());
    await lab.waitForIdle();
    const { library } = await lab.readCards(draft.id);
    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    await lab.start(draft.id, { approved: true, expectedHash: draftHash(accepted.experiment) });
    await lab.waitForIdle();
    const record = await lab.get(draft.id);
    assert.ok(record.calibration, 'the run compared its situations with the logs');
    assert.deepEqual(record.calibration.logVersions, [], 'nobody named the logs\' version');
    assert.equal(buildResultView(record).calibration?.versionNote, 'версия логов не указана');
    return { cwd, record, importId: record.originalImport!.id, journal: () => lab.store.readLogVersions(record.originalImport!.id) };
  } finally { await lab.close(); }
}

test('in the chat the logs\' version is one decision: the owner picks «the same as tested», and only that pick is recorded', { timeout: 60000 }, async t => {
  const folder = await calibratedFolder(t);
  const { tools, shutdown } = registered();
  t.after(shutdown);
  const asked: { title: string; options: string[] }[] = [];
  const ctx = { cwd: folder.cwd, mode: 'tui', hasUI: true, ui: { select: async (title: string, options: string[]) => { asked.push({ title, options }); return options[0]; },
    editor: async () => undefined, notify() {}, setStatus() {}, setWidget() {} } } as unknown as ExtensionContext;
  const decide = async (params: Record<string, unknown>) => output(await tools.get(TOOL.decide)!.execute('decide', params, undefined, undefined, ctx));
  const listed = await decide({});
  const logs = listed.decisions.find((decision: { key: string }) => decision.key === `logs:${folder.importId}`);
  assert.deepEqual(logs.answers.map((answer: { number: number; label: string }) => `${answer.number} ${answer.label}`),
    ['1 Та же, что проверяли — demo-baseline-v1', '2 Назвать версию', '3 Неизвестна']);
  const result = await decide({ decision: logs.key, choice: 1 });
  assert.match(asked[0]!.title, /^Сверка с продом · прогон .+\n\nКакая версия агента записала логи\?[^\n]+\n\nВ разговоре вы ответили: «Та же, что проверяли — demo-baseline-v1»$/);
  assert.equal(result.notice, 'Записано: логи записал агент версии «demo-baseline-v1». Это учтёт следующая сверка с продом — в новом прогоне или при переоценке этого.');
  const journal = await folder.journal();
  assert.deepEqual(journal?.declarations.map(item => [item.via, item.command.version]), [['pi-confirm', 'demo-baseline-v1']]);
  assert.ok(!result.left.some((decision: { key: string }) => decision.key.startsWith('logs:')), 'the answered decision leaves the queue');
  assert.deepEqual((await folder.journal())?.declarations.length, 1);
});

test('in the chat the owner may name the version in their own words, in the native editor; closing it records nothing', { timeout: 60000 }, async t => {
  const folder = await calibratedFolder(t);
  const { tools, shutdown } = registered();
  t.after(shutdown);
  const texts: (string | undefined)[] = [undefined, 'prod-2026-09-09'];
  const editors: { title: string; prefill: string }[] = [];
  const ctx = { cwd: folder.cwd, mode: 'tui', hasUI: true, ui: { select: async (_title: string, options: string[]) => options.find(option => option.includes('Назвать версию')),
    editor: async (title: string, prefill: string) => { editors.push({ title, prefill }); return texts.shift(); }, notify() {}, setStatus() {}, setWidget() {} } } as unknown as ExtensionContext;
  const decide = async (params: Record<string, unknown>) => output(await tools.get(TOOL.decide)!.execute('decide', params, undefined, undefined, ctx));
  const closed = await decide({ decision: `logs:${folder.importId}`, text: 'prod-2026-09-09' });
  assert.equal(closed.decided, false); assert.equal(await folder.journal(), undefined);
  assert.deepEqual(editors[0], { title: 'Какая версия агента записала логи · как вы её называете', prefill: 'prod-2026-09-09' }, 'what the owner said is prefilled, the owner confirms it');
  const named = await decide({ decision: `logs:${folder.importId}` });
  assert.equal(named.decided, true);
  assert.deepEqual((await folder.journal())?.declarations.map(item => [item.via, item.command.version]), [['pi-confirm', 'prod-2026-09-09']]);
});

test('in the workspace the logs\' version is one inbox decision: the owner names it and the receipt says the workspace', { timeout: 60000 }, async t => {
  const folder = await calibratedFolder(t);
  const { command, shutdown } = registered();
  t.after(shutdown);
  const session = workspaceSession(folder.cwd);
  session.state.reason = 'prod-2026-09-09';
  const choice = { label: 'Назвать версию', action: { kind: 'name_log_version' as const, importId: folder.importId }, settles: true };
  session.state.steps = [{ action: { type: 'decide', choice } }, CLOSE];
  // The workspace opens on what waits for the owner: the decision about the logs.
  await command('', session.ctx);
  assert.match(session.screens[0]!, /Нужно ваше решение: 1/); assert.match(session.screens[0]!, /Сверка с продом · прогон/);
  assert.equal(noticeOf(session.screens[1]!), 'Записано: логи записал агент версии «prod-2026-09-09». Это учтёт следующая сверка с продом — в новом прогоне или при переоценке этого.');
  assert.deepEqual((await folder.journal())?.declarations.map(item => [item.via, item.command.version]), [['board', 'prod-2026-09-09']]);
  assert.equal(session.editorCalls.at(-1)!.title, 'Какая версия агента записала логи · как вы её называете');
});
