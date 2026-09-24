import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import type { Experiment } from '../src/contracts.js';
import { demoInput } from '../src/demo.js';

/*
 * The command line takes the owner's word as --yes: `build` shows what it would prepare and what it may spend, and
 * prepares only on --yes; inside an Agent Lab chat no command takes --yes, because there the chat asks itself.
 * The task file is the built-in teaching example, so preparing calls no model.
 */

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
async function agentLab(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], { env: { ...process.env, AGENT_LAB_SESSION: '', ...env } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout, stderr };
}
async function folder(t: TestContext): Promise<{ task: string; data: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-lab-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = join(root, 'task.json');
  await writeFile(task, JSON.stringify(demoInput()));
  return { task, data: join(root, 'data') };
}

test('build shows the consent in the owner\'s words and writes nothing; --yes prepares at most the situations it promised', { timeout: 60000 }, async t => {
  const { task, data } = await folder(t);
  const shown = await agentLab(['build', '--input', task, '--situations', '1', '--data-dir', data]);
  assert.equal(shown.code, 0, shown.stderr);
  const lines = shown.stdout.split('\n');
  assert.equal(lines[0], 'Собрать 1 ситуацию из task.json?');
  assert.ok(lines.includes('В логах 2 разговора, подходят 2. Ситуаций будет не больше 1 — по одной на разговор, из всех тем логов.'), shown.stdout);
  assert.ok(lines.some(line => /^Расход — не больше \d+ вызовов модели на всю подготовку/.test(line)), shown.stdout);
  assert.ok(lines.includes('Собрать: та же команда с --yes. Без него ничего не записано и не потрачено.'), shown.stdout);
  await assert.rejects(readdir(data), { code: 'ENOENT' }, 'nothing is written before --yes');

  const wrong = await agentLab(['build', '--input', task, '--situations', '0', '--data-dir', data]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /Число ситуаций — целое от 1 до 200\./);

  const prepared = await agentLab(['build', '--input', task, '--situations', '1', '--yes', '--data-dir', data]);
  assert.equal(prepared.code, 0, prepared.stderr);
  const record = JSON.parse(prepared.stdout) as Experiment;
  assert.equal(record.phase, 'review');
  assert.equal(record.librarySnapshot?.formatVersion, 2);
  assert.equal(record.librarySnapshot?.formatVersion === 2 ? record.librarySnapshot.cards.length : undefined, 1, 'the count the consent promised is the most the preparation makes');
});

test('inside an Agent Lab chat no command takes --yes: the chat asks the owner itself, and nothing is written or spent', { timeout: 60000 }, async t => {
  const { task, data } = await folder(t);
  const chat = { AGENT_LAB_SESSION: '1' };
  for (const args of [['build', '--input', task, '--yes'], ['run', '--id', 'draft', '--yes'], ['reassess', '--id', 'run', '--yes'],
    ['evaluate', '--input', task, '--yes'], ['cards', '--id', 'draft', '--accept', '--yes'], ['logs', '--id', 'run', '--unknown', '--yes']]) {
    const refused = await agentLab([...args, '--data-dir', data], chat);
    assert.notEqual(refused.code, 0, args.join(' '));
    assert.equal(refused.stderr, 'Agent Lab: Из чата Agent Lab команда с --yes не выполняется: в чате согласие на расход и решения спрашивает сам чат. '
      + 'Скажите обычными словами, что сделать, — Lab спросит вас. Ничего не записано и не потрачено.\n', args.join(' '));
  }
  await assert.rejects(readdir(data), { code: 'ENOENT' }, 'no refused command opened the data folder');
  const shown = await agentLab(['build', '--input', task, '--data-dir', data], chat);
  assert.equal(shown.code, 0, 'reading what a preparation would cost is not a decision');
  assert.match(shown.stdout, /^Собрать 2 ситуации из task\.json\?/);
});
