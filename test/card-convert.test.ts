import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hostGrant } from '../src/card/commands.js';
import { conversionText, convertV1Library } from '../src/card/convert.js';
import type { LibraryV2 } from '../src/card/schema.js';
import { situationViews } from '../src/card/view.js';
import type { Experiment } from '../src/contracts.js';
import { createDemoRuntime, demoInput } from '../src/demo.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { decisions } from '../src/inbox.js';
import { automaticTrialResult } from '../src/outcomes.js';
import type { LibraryV1 } from '../src/scenario-contracts.js';
import { libraryHash } from '../src/scenario-library.js';
import { ExperimentStore } from '../src/store.js';
import { firstFormatDraft, libraryV1Run, storedLibraryV1, storedRunV1 } from './helpers/library-v1.js';
import { CLOSE, noticeOf, output, registered, workspaceSession } from './helpers/pi-session.js';
import { openWorkspace } from './helpers/workspace.js';

/*
 * «Продолжить в новом формате»: a first-format draft goes on as a new draft of cards. The fixture is the frozen
 * first-format library (test/fixtures/library-v1) before its acceptance: «known_number» names the terminal number in
 * its first message; «late_number» names it when asked, a fact the owner once confirmed in the old editor.
 */

const draftLibrary = (): LibraryV1 => {
  const library = storedLibraryV1();
  delete library.acceptance;
  return library;
};
const run = storedRunV1();
const convert = (library: LibraryV1) => convertV1Library(library, { id: 'library_converted', createdAt: '2026-09-24T10:00:00.000Z', sources: run.sources, requirements: run.requirements });
const views = async (lab: ExperimentLab, id: string) => {
  const context = await lab.cardContext(id);
  return situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns });
};

test('each variant becomes one card that says what the variant said: the logged opening, its facts with their messages, its duties with their rules', () => {
  const v1 = draftLibrary();
  const { library, units, left, calls } = convert(v1);
  assert.deepEqual(left, []);
  assert.equal(calls, 2, 'one review call a card: no receipt of the old checker crosses over');
  assert.deepEqual(library.claims, []); assert.deepEqual(library.receipts, []);
  assert.deepEqual(library.imports, v1.imports.map(({ id, contentHash }) => ({ id, contentHash })));
  const [known, late] = library.cards;
  const batchId = v1.imports[0]!.id;
  assert.deepEqual(units, [{ unit: 'known', cardId: known!.id }, { unit: 'late', cardId: late!.id }]);
  assert.deepEqual(library.cards.map(card => [card.number, card.title, card.topic]), [[1, 'Номер уже в первой реплике', 'Возврат оплаты'], [2, 'Номер раскрывается по просьбе', 'Возврат оплаты']]);
  // The opening is the customer's logged message; a fact it says is vouched for by it.
  assert.deepEqual(known!.origin, { kind: 'dialogue', batchId, dialogueId: 'known' });
  assert.equal(known!.client.writes, 'Номер терминала: 1234. Помогите с возвратом.');
  assert.deepEqual(known!.client.writesSource, { kind: 'dialogue', event: { batchId, dialogueId: 'known', eventIndex: 0 } });
  assert.deepEqual(known!.client.knows, [{ id: 'f1', label: 'Номер терминала: 1234', disclosure: 'initial', source: { kind: 'dialogue', event: { batchId, dialogueId: 'known', eventIndex: 0 } } }],
    'the statement already says the value, so the customer says the statement');
  // Each duty the checkpoint judge decided is one expectation, word for word, with its rule and its condition.
  const checkpoints = v1.variants[0]!.evaluationSpec.checkpoints;
  assert.deepEqual(known!.agentMust, checkpoints.map((checkpoint, index) => ({ id: `e${index + 1}`, text: checkpoint.rule, requirementIds: [checkpoint.requirementId],
    appliesWhen: checkpoint.applicability, observation: checkpoint.observation })));
  assert.equal(known!.client.leaves, v1.variants[0]!.behaviorPolicy.transitions[0]!.when);
  // A fact the owner confirmed in the old editor waits for the owner again: no receipt of theirs is made up.
  assert.deepEqual(late!.client.knows, [{ id: 'f1', label: 'Номер терминала: 5678', disclosure: 'on_request', askedAs: 'Агент просит номер терминала', source: { kind: 'unconfirmed' } }]);
  assert.deepEqual(late!.coverage, [{ event: { batchId, dialogueId: 'late', eventIndex: 2 }, as: 'ignored', reason: v1.variants[1]!.sourceCoverage![0]!.reason }]);
  assert.deepEqual(library.readingManifest, [{ dialogueId: 'known', batchId, sourceIds: ['source-1'], cardIds: [known!.id] }, { dialogueId: 'late', batchId, sourceIds: ['source-1'], cardIds: [late!.id] }]);
  assert.deepEqual(convert(draftLibrary()).library.cards, library.cards, 'the conversion is deterministic');
  assert.deepEqual(conversionText({ library, left, calls }), { summary: 'В новый формат перенесены 2 ситуации. Старый черновик остался как есть.', left: [],
    check: 'Новые ситуации ещё не проверены: проверка — до 2 вызовов модели.' });
});

test('what a card cannot hold leaves the variant out with the reason; nothing is cut or reworded to fit', () => {
  const cases: [string, (library: LibraryV1) => void, RegExp][] = [
    ['an exact check of the state', library => { library.variants[0]!.evaluationSpec.checkpoints[0]!.check = { id: 'literal', kind: 'answer_equals', description: 'Точная инструкция', value: 'Инструкция' }; }, /точная проверка состояния системы/],
    ['more duties than a card holds', library => { const [first] = library.variants[0]!.evaluationSpec.checkpoints; library.variants[0]!.evaluationSpec.checkpoints.push({ ...first!, id: 'third' }, { ...first!, id: 'fourth' }); }, /4 обязанности агента, а в ситуации нового формата их не больше трёх/],
    ['a duty longer than its field', library => { library.variants[0]!.evaluationSpec.checkpoints[0]!.rule = 'р'.repeat(301); }, /обязанность агента в ней описана длиннее 300 знаков/],
    ['an opening that is no logged message', library => { library.variants[0]!.userState.opening = 'Здравствуйте, нужен возврат'; }, /первая реплика не совпадает ни с одной репликой клиента в логах/],
    ['a seeded environment', library => { library.variants[0]!.environmentFixture = { mode: 'managed', initialState: { records: { item: { status: 'pending' } }, writableFields: [], transientFailures: 0 } }; }, /задаёт состояние системы агента/],
    ['two late turns', library => { library.variants[0]!.behaviorPolicy.actions.push({ id: 'change', kind: 'change_intent', factIds: [], payload: 'Лучше отмена' }, { id: 'see', kind: 'observe', factIds: [], payload: 'Вижу ошибку' }); }, /поворачивает разговор не один раз/],
    ['a dialogue missing from the logs', library => { library.variants[0]!.sourceDialogues = [{ batchId: library.imports[0]!.id, dialogueId: 'absent' }]; }, /её разговора нет в логах этого набора/],
  ];
  for (const [name, mutate, reason] of cases) {
    const library = draftLibrary();
    mutate(library);
    const converted = convert(library);
    assert.deepEqual(converted.left.map(item => item.variantId), ['known_number'], name);
    assert.match(converted.left[0]!.reason, reason, name);
    assert.deepEqual(converted.library.cards.map(card => [card.number, card.origin.kind === 'dialogue' && card.origin.dialogueId]), [[1, 'late']], `${name}: the other variant still goes over, numbered from 1`);
  }
  const text = conversionText(convert((() => { const library = draftLibrary(); library.variants[0]!.userState.opening = 'Иначе'; return library; })()));
  assert.match(text.summary, /^В новый формат перенесена 1 ситуация, не перенесена 1\./);
  assert.match(text.left[0]!, /^«Номер уже в первой реплике» не перенесена: её первая реплика не совпадает/);
});

test('a first-format draft goes on as a new card draft that is checked, answered, accepted and run like any other; the old draft stays as it was', { timeout: 60000 }, async t => {
  const { lab, directory, record } = await firstFormatDraft();
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  const stored = join(lab.store.directory, `${record.id}.json`), before = await readFile(stored, 'utf8');
  const converted = await lab.convertV1Draft(record.id);
  assert.equal(await readFile(stored, 'utf8'), before, 'the old draft is not touched');
  const draft = converted.experiment;
  assert.notEqual(draft.id, record.id);
  assert.equal(draft.phase, 'review'); assert.equal(draft.usage.calls, 0); assert.deepEqual(draft.scenarios, []); assert.deepEqual(draft.trials, []);
  assert.deepEqual([draft.task, draft.sources, draft.requirements, draft.originalImport], [record.task, record.sources, record.requirements, record.originalImport]);
  assert.equal(draft.preparationProgress?.protocol, 'cards-v2', 'the converted draft is this Lab\'s own'); assert.equal(draft.preparationProgress?.status, 'complete');
  assert.equal((draft.librarySnapshot as LibraryV2).cards.length, 2);
  assert.deepEqual((await views(lab, draft.id)).map(view => view.status), ['checking', 'checking'], 'nothing is ready before the reviewer has read the new cards');
  // The paid check is its own step, on the owner's word.
  const check = await lab.recheckCards(draft.id, { explicit: true });
  assert.equal(check.decision.action, 'run'); await lab.waitForIdle();
  let now = await views(lab, draft.id);
  assert.deepEqual(now.map(view => view.status), ['ready', 'needs_owner']);
  assert.equal(now[1]!.question?.text, 'Клиент знает «Номер терминала: 5678»?');
  const answer = await lab.prepareCardCommand(draft.id, { kind: 'answer_question', cardId: now[1]!.id, questionId: now[1]!.question!.id!, choice: 'a' }, { via: 'cli-yes' });
  await lab.applyCardCommand(draft.id, answer, hostGrant(answer, 'confirmed'));
  if ((await lab.recheckCards(draft.id)).decision.action === 'run') await lab.waitForIdle();
  now = await views(lab, draft.id);
  assert.deepEqual(now.map(view => view.status), ['ready', 'ready']);
  const accepted = await lab.acceptCards(draft.id, libraryHash((await lab.readCards(draft.id)).library), now.map(view => view.id));
  await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(accepted.experiment) }); await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.equal(result.phase, 'results_review', result.error ?? '');
  const verdicts = result.trials.map(trial => `${trial.scenarioId === now[0]!.id ? 'known' : 'late'}:${automaticTrialResult(result.scenarios.find(item => item.id === trial.scenarioId), trial, result.humanReviews)}`).sort();
  assert.deepEqual(verdicts, ['known:fail', 'known:fail', 'late:pass', 'late:pass'], 'the teaching agent still asks again for a number it was given, as in the old run');
  assert.ok(result.trials.every(trial => trial.checkpoints === undefined && trial.assessments?.map(item => item.metricId).join() === 'e1,e2'));
});

test('only a draft goes on in the new format: a run of the old format, a card draft and an old preparation are refused', async t => {
  const { lab, directory, record } = await libraryV1Run();
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(lab.convertV1Draft(record.id), /Прогон старого формата не переносится/);
  const cards = new ExperimentLab(join(directory, 'cards'), createDemoRuntime());
  t.after(() => cards.close());
  await cards.init();
  const created = await cards.create(demoInput()); await cards.waitForIdle();
  await assert.rejects(cards.convertV1Draft(created.id), /не черновик старого формата/);
  const old = await firstFormatDraft();
  t.after(async () => { await old.lab.close(); await rm(old.directory, { recursive: true, force: true }); });
  const stopped: Experiment = { ...old.record, preparationProgress: { ...old.record.preparationProgress!, pending: ['late'], processed: ['known'], status: 'partial' } as Experiment['preparationProgress'] };
  await old.lab.store.save(stopped);
  await assert.rejects(old.lab.resumePreparation(stopped.id, libraryHash(stopped.librarySnapshot!)), /подготовка старого формата: её не продолжить/);
  const nothing = { ...draftLibrary(), variants: draftLibrary().variants.map(variant => ({ ...variant, userState: { ...variant.userState, opening: 'Иначе' } })) };
  await old.lab.store.save({ ...old.record, id: 'nothing_to_convert', librarySnapshot: nothing });
  await assert.rejects(old.lab.convertV1Draft('nothing_to_convert'), /Ни одну ситуацию этого черновика не перенести: её первая реплика не совпадает/);
});

test('the inbox offers the new format for a first-format draft that can neither change nor run, and the workspace carries it over', { timeout: 60000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-convert-board-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const data = join(cwd, '.agent-lab');
  const old = await firstFormatDraft({ data });
  await old.lab.close();
  await rm(old.directory, { recursive: true, force: true });
  const queue = decisions({ draft: { record: old.record, views: situationViews(old.record, { maxTurns: 3 }), pendingCalls: 0 } });
  assert.deepEqual(queue.map(decision => [decision.subject, decision.choices.map(choice => choice.label)]), [['Ситуации старого формата', ['Продолжить в новом формате', 'Открыть ситуации']]]);
  assert.deepEqual(queue[0]!.choices[0]!.action, { kind: 'convert_draft', runId: old.record.id });
  // An accepted draft of the old format still runs as it is: nothing waits for the owner.
  assert.deepEqual(decisions({ draft: { record: { ...old.record, librarySnapshot: storedLibraryV1() }, views: [], pendingCalls: 0 } }), []);
  const { screen } = await openWorkspace(data, state => { state.area = 'inbox'; });
  assert.match(screen(100), /Ситуации старого формата\n {4}Их можно посмотреть, но не изменить и не утвердить для прогона\. В новом формате — можно; старый\s+черновик останется как есть\.\n {4}1 Продолжить в новом формате {2}· {2}2 Открыть ситуации/);
  const { command, shutdown } = registered(), session = workspaceSession(cwd);
  session.state.steps = [{ action: { type: 'decide', choice: queue[0]!.choices[0]! } }, CLOSE];
  try {
    await command(old.record.id, session.ctx);
    assert.equal(noticeOf(session.screens[1]!), 'В новый формат перенесены 2 ситуации. Старый черновик остался как есть. Новые ситуации ещё не проверены: проверка — до 2 вызовов модели.');
    const records = await new ExperimentStore(data).list();
    assert.deepEqual(records.map(record => record.librarySnapshot?.formatVersion).sort(), [1, 2]);
  } finally { await shutdown(); }
});

test('the chat and the CLI carry a first-format draft over, say what did not go over and what the check costs, and never start it', { timeout: 60000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-convert-chat-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const data = join(cwd, '.agent-lab');
  const old = await firstFormatDraft({ data });
  const late = (old.record.librarySnapshot as LibraryV1).variants[1]!;
  await old.lab.store.save({ ...old.record, id: 'second_draft' });
  await old.lab.close();
  await rm(old.directory, { recursive: true, force: true });
  const { tools, shutdown } = registered();
  // The chat carries a draft over as the owner's decision: listed with its one answer, picked in a native dialog.
  const picked: string[] = [];
  const ctx = { cwd, hasUI: true, mode: 'tui', ui: { select: async (title: string, options: string[]) => { picked.push(title); return options[0]; } } } as never;
  const decide = tools.get('agent_lab_decide')!;
  try {
    const listed = output(await decide.execute('list', {}, undefined, undefined, ctx));
    const convert = listed.decisions.find((decision: { key: string }) => decision.key.startsWith('convert:'));
    assert.deepEqual(convert.answers.map((answer: { label: string }) => answer.label), ['Продолжить в новом формате'], 'opening the situations is not a decision');
    const answer = output(await decide.execute('convert', { decision: convert.key }, undefined, undefined, ctx));
    assert.equal(answer.decided, true);
    assert.equal(answer.notice, 'В новый формат перенесены 2 ситуации. Старый черновик остался как есть. Новые ситуации ещё не проверены: проверка — до 2 вызовов модели.');
    assert.match(picked[0]!, /^Ситуации старого формата\n\nИх можно посмотреть, но не изменить/);
    // The new draft is what the project works on now: its situations wait for the check, which is the owner's next decision.
    assert.ok(answer.left.some((decision: { key: string }) => decision.key.startsWith('check:')), JSON.stringify(answer.left));
    assert.ok(!answer.left.some((decision: { key: string }) => decision.key.startsWith('convert:')), 'nothing of the old format is offered again for the new draft');
  } finally { await shutdown(); }
  // The CLI: the same words, and the check is the owner's next command.
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', cli, 'cards', '--id', 'second_draft', '--convert', '--data-dir', data]);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  assert.equal(await new Promise<number | null>(resolve => child.on('close', resolve)), 0, stderr);
  const lines = stdout.split('\n');
  assert.equal(lines[0], 'В новый формат перенесены 2 ситуации. Старый черновик остался как есть.');
  assert.equal(lines[1], 'Новые ситуации ещё не проверены: проверка — до 2 вызовов модели.');
  assert.match(lines[2]!, /^Проверить: agent-lab cards --id [0-9a-f-]{36} --check --yes$/);
  assert.match(stdout, new RegExp(late.title));
  const stored = await new ExperimentStore(data).list();
  assert.equal(stored.filter(record => record.librarySnapshot?.formatVersion === 2).length, 2);
  assert.ok(stored.every(record => record.usage.calls === 0 && !record.trials.length), 'nothing was checked or run');
});
