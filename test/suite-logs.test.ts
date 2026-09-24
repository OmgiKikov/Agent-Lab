import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logJudgmentComplete } from '../src/card/log-judge.js';
import { cardStatuses } from '../src/card/status.js';
import { situationViews } from '../src/card/view.js';
import type { Experiment } from '../src/contracts.js';
import type { Runtime } from '../src/runtime.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { situationCoverage } from '../src/miner/cards.js';
import { buildTopicMap } from '../src/miner/topic-map.js';
import { buildResultView } from '../src/result-view.js';
import { importBatch, libraryHash } from '../src/scenario-library.js';
import { refundReading, scriptedLogJudge } from './helpers/calibration.js';
import { cardInput, cardRuntime, dialogues } from './helpers/card-prep.js';
import { scriptedRunner } from './helpers/miner.js';

/*
 * Chunk T2: a card run saved as a suite carries the logs its situations are made from. In a fresh data folder its
 * situations read their statuses, «из диалога №N» and topic coverage, run, and are calibrated on those very logs —
 * nothing else of the folder they were prepared in is needed. A damaged suite is refused before anything is written.
 */

/** The model of cardInput's settings: it builds the topic map, in which both refund conversations are one topic. */
const BUILDER = { provider: 'deterministic', id: 'fixture' };
function runtime(judged: { count: number }): Runtime {
  const topics = scriptedRunner(dialogues.map(item => ({ id: item.id, customer: item.messages.filter(message => message.role === 'user').map(message => message.content), topic: 'Возврат оплаты' })));
  return { ...cardRuntime(), logJudge: scriptedLogJudge(refundReading, judged),
    topicMap: { builder: BUILDER, build: (plan, ctx, onProgress) => buildTopicMap(plan, { builder: BUILDER, ctx, onProgress, run: topics.run }) } };
}

/** Two data folders and the suite between them; everything is removed after the test, the labs closed first. */
async function folders(work: (paths: { root: string; source: ExperimentLab; fresh: ExperimentLab; judged: { count: number } }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-lab-suite-'));
  const judged = { count: 0 };
  const source = new ExperimentLab(join(root, 'source'), runtime(judged)), fresh = new ExperimentLab(join(root, 'fresh'), runtime(judged));
  try { await source.init(); await fresh.init(); await work({ root, source, fresh, judged }); }
  finally { await source.close(); await fresh.close(); await rm(root, { recursive: true, force: true }); }
}

/** The refund cards of card-prep.ts prepared from their logs, accepted, run and calibrated. */
async function calibratedRun(lab: ExperimentLab): Promise<Experiment> {
  const draft = await lab.create(cardInput());
  await lab.waitForIdle();
  const { library } = await lab.readCards(draft.id);
  const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
  await lab.start(draft.id, { approved: true, expectedHash: draftHash(accepted.experiment), requireAccepted: true });
  await lab.waitForIdle();
  const run = await lab.get(draft.id);
  assert.equal(run.phase, 'results_review', run.error ?? '');
  return run;
}

/** What the owner reads of a card draft or run: every situation with its status and source line, and the coverage of the logs' topics. */
async function situations(lab: ExperimentLab, id: string) {
  const { experiment, library, evidence, numbers } = await lab.cardContext(id);
  const maxTurns = experiment.settings.maxTurns;
  return { views: situationViews(experiment, { evidence, numbers, maxTurns }), coverage: situationCoverage(library, cardStatuses({ library, evidence, maxTurns })) };
}

const calibration = (run: Experiment) => run.calibration!.entries.map(entry => [entry.key, entry.dialogueId, entry.expectationId, entry.result]);

test('a card run saved as a suite carries its logs: a fresh data folder reads its statuses, runs it and calibrates it', async () => {
  await folders(async ({ root, source, fresh, judged }) => {
    const run = await calibratedRun(source);
    const before = await situations(source, run.id);
    assert.deepEqual(before.views.map(view => view.status), ['ready', 'ready']);
    assert.ok(before.coverage?.line, 'the logs\' topics travel in the library');
    assert.equal(run.calibration!.entries.length, 4);

    const file = await source.saveSuite(run.id, join(root, '.evals', 'refunds.json'));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const suite = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(suite.imports, [await source.store.readImport(run.originalImport!.id)], 'the batch its cards cite, verbatim');

    const loaded = await fresh.loadSuite(file);
    const stored = await readdir(join(root, 'fresh', 'imports'));
    assert.deepEqual(stored, [`${run.originalImport!.id}.json`]);
    for (const name of stored) assert.equal((await stat(join(root, 'fresh', 'imports', name))).mode & 0o777, 0o600, name);
    assert.deepEqual(await situations(fresh, loaded.id), before, 'statuses, «из диалога №N» and topic coverage read as in the folder they were made in');

    const paid = judged.count;
    await fresh.start(loaded.id, { approved: true, expectedHash: draftHash(loaded) });
    await fresh.waitForIdle();
    const rerun = await fresh.get(loaded.id);
    assert.equal(rerun.phase, 'results_review', rerun.error ?? '');
    const headline = (value: Experiment) => [buildResultView(value).headline.passed, buildResultView(value).headline.decided];
    assert.deepEqual(headline(rerun), headline(run));
    assert.deepEqual(calibration(rerun), calibration(run), 'calibrated on the same logged conversations, under the same keys');
    assert.equal(judged.count - paid, 8, 'judged anew on the carried logs: the run they came from stays in the other folder');
    for (const entry of rerun.calibration!.entries) assert.equal(logJudgmentComplete(entry, rerun, { audit: await fresh.store.readCalibrationAudit(rerun.id, entry.key) }), true, entry.key);
  });
});

test('a damaged suite is refused before anything is written; a suite saved before suites carried logs loads as it did; no suite is saved without its logs', async () => {
  await folders(async ({ root, source, fresh }) => {
    const run = await calibratedRun(source);
    const suite = JSON.parse(await readFile(await source.saveSuite(run.id, join(root, 'suite.json')), 'utf8'));
    const saved = async (name: string, value: unknown) => { const path = join(root, name); await writeFile(path, JSON.stringify(value)); return path; };

    const edited = structuredClone(suite);
    edited.imports[0].dialogues[0].original.messages[0].content = 'Верните деньги немедленно.';
    await assert.rejects(fresh.loadSuite(await saved('edited.json', edited)), /^Error: Логи повреждены: разговоры в них не совпадают с их хешем\.$/);
    await assert.rejects(fresh.loadSuite(await saved('without.json', { ...suite, imports: [] })), /Набор повреждён: в нём нет логов, из которых сделаны ситуации\. Сохраните его заново\./);
    const other = importBatch([{ id: 'other', messages: [{ role: 'user', content: 'Где мой заказ?' }, { role: 'assistant', content: 'Проверяю.' }] }]);
    await assert.rejects(fresh.loadSuite(await saved('stray.json', { ...suite, imports: [...suite.imports, other] })), /Набор повреждён: в нём логи, на которые не ссылается ни одна ситуация\./);
    assert.deepEqual(await fresh.list(), [], 'no draft was written');
    await assert.rejects(readdir(join(root, 'fresh', 'imports')), { code: 'ENOENT' }, 'and no logs');

    // A suite saved before suites carried their logs: in the folder that holds them it loads and reads as it always did.
    const { imports: _carried, ...earlier } = suite;
    const loaded = await source.loadSuite(await saved('earlier.json', earlier));
    assert.deepEqual((await situations(source, loaded.id)).views.map(view => view.status), ['ready', 'ready']);

    await rm(join(root, 'source', 'imports', `${run.originalImport!.id}.json`));
    await assert.rejects(source.saveSuite(run.id, join(root, 'lost.json')), /Логов, из которых сделаны ситуации, в этой папке нет: без них набор не сохранить\./);
    await assert.rejects(stat(join(root, 'lost.json')), { code: 'ENOENT' });
  });
});
