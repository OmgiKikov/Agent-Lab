import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostGrant } from '../src/card/commands.js';
import { rulebookOf, withKind } from '../src/card/rulebook.js';
import type { Experiment } from '../src/contracts.js';
import { createDemoRuntime } from '../src/demo.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { acceptedDemoDraft } from './helpers/demo-record.js';

/*
 * An owner command over a finished run shows its preview on a fresh draft that is not written: the draft is written
 * only with the change the owner applies — the CLI's --yes, «Записать» on the board or in the chat, «Запустить» for a
 * repeat. A preview the owner declines leaves the folder as it was. The teaching example; no model is called.
 */

const records = async (directory: string) => (await readdir(directory)).filter(name => /^[\w-]+\.json$/.test(name)).length;

async function finishedDemo(t: TestContext): Promise<{ lab: ExperimentLab; directory: string; run: Experiment }> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-preview-'));
  const lab = new ExperimentLab(directory, createDemoRuntime());
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  await lab.init();
  const draft = await acceptedDemoDraft(lab);
  await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) });
  await lab.waitForIdle();
  const run = await lab.get(draft.id);
  assert.equal(run.phase, 'results_review', run.error ?? '');
  return { lab, directory, run };
}

test('a change of a finished run is previewed on a fresh draft that is written only when the owner applies it', async t => {
  const { lab, directory, run } = await finishedDemo(t);
  const before = await records(directory);
  const target = await lab.editableCards(run.id);
  assert.deepEqual([target.copiedFrom, target.preview], [run.id, true]);
  assert.notEqual(target.id, run.id);
  const { library } = await lab.cardContext(target.id);
  const command = { kind: 'set_rulebook' as const, rulebook: withKind(rulebookOf(library), 'operator_procedure', true) };
  const prepared = await lab.prepareCardCommand(target.id, command, { via: 'board' });
  assert.ok(prepared.rulebook, 'the owner sees the change');
  // The owner says «Не менять»: nothing of the preview is written.
  assert.equal(await records(directory), before, 'a preview writes nothing');
  assert.ok(!(await lab.list()).some(record => record.id === target.id), 'and is never listed');
  await assert.rejects(lab.store.get(target.id), { code: 'ENOENT' });
  // The owner confirms: the fresh draft is written with the change, and the run stays as it was.
  const applied = await lab.applyCardCommand(target.id, prepared, hostGrant(prepared, 'confirmed'));
  assert.equal(await records(directory), before + 1);
  const written = await lab.store.get(target.id);
  assert.deepEqual([written.phase, written.parentRunId, written.librarySnapshot], ['review', run.id, applied.library]);
  assert.deepEqual(await lab.store.get(run.id), run, 'the finished run never changes');
});

test('a repeat shown in the run dialog is written only by «Запустить»; «Не сейчас» leaves nothing behind', async t => {
  const { lab, directory, run } = await finishedDemo(t);
  const before = await records(directory);
  const preview = await lab.repeat(run.id, undefined, undefined, { preview: true });
  assert.equal(await records(directory), before, 'the owner is looking at the plan: nothing is written');
  assert.equal((await lab.get(preview.id)).phase, 'review');
  // «Запустить»: the expectations are confirmed on the draft the owner saw, which writes it, and the run starts.
  await lab.acceptDraft(preview.id, draftHash(preview));
  assert.equal(await records(directory), before + 1);
  await lab.start(preview.id, { approved: true, reviewer: 'expectations', expectedHash: draftHash(preview), requireAccepted: true });
  await lab.waitForIdle();
  assert.equal((await lab.get(preview.id)).phase, 'results_review');
});

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
async function agentLab(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { AGENT_LAB_SESSION: _chat, ...outside } = process.env;
  const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], { env: outside });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout, stderr };
}

test('agent-lab cards over a finished run without --yes only shows the change: no draft is written', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lab-preview-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  const demo = await agentLab(['demo', '--json', '--data-dir', data]);
  const run = JSON.parse(demo.stdout) as { id: string; phase: string };
  assert.equal(run.phase, 'results_review', demo.stderr);
  const before = await records(data);
  const shown = await agentLab(['cards', '--id', run.id, '--operator-rules', 'on', '--data-dir', data]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /Записать: та же команда с --yes\./);
  assert.match(shown.stderr, /правка пойдёт в новый черновик того же набора/);
  assert.equal(await records(data), before, 'the preview wrote no draft');
  const applied = await agentLab(['cards', '--id', run.id, '--operator-rules', 'on', '--yes', '--data-dir', data]);
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stderr, /Правка записана в новый черновик /);
  assert.equal(await records(data), before + 1, '--yes writes the one draft that holds the change');
});
