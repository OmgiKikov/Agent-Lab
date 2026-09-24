import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { findAgent, launchRun } from '../extensions/launch.ts';
import { NeedsOwner } from '../extensions/lab-ui.ts';
import type { Experiment } from '../src/contracts.js';
import { ExperimentLab } from '../src/experiment.js';
import { cardInput, cardRuntime } from './helpers/card-prep.js';

/*
 * An address alone is never connected in Lab's own contract, which the agent there does not know: it goes the way a
 * pasted curl goes (agent_lab_connect — the fields read, two test messages, the owner's word). And a connection that
 * reads a variable nobody set stops the start before any call, in the owner's words.
 */

async function folder(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-launch-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}
function owner(cwd: string, pick: (title: string, options: string[]) => string | undefined) {
  const asked: { title: string; options: string[] }[] = [];
  const ctx = { cwd, ui: { select: async (title: string, options: string[]) => { asked.push({ title, options }); return pick(title, options); } } } as unknown as ExtensionContext;
  return { ctx, asked };
}

test('an address the owner named is connected from their curl, never in Lab\'s own contract by guess', async t => {
  const cwd = await folder(t);
  const { ctx, asked } = owner(cwd, () => { throw new Error('no dialog before the curl'); });
  const start = { id: 'draft', target: { kind: 'unconnected' } } as unknown as Experiment;
  await assert.rejects(launchRun(ctx, {} as ExperimentLab, start, { target: { kind: 'http', url: 'http://localhost:8080/chat?token=abc', headersEnv: {}, timeoutMs: 60000 } }),
    (error: unknown) => error instanceof NeedsOwner && error.message.includes('agent_lab_connect')
      && error.ownerText === 'Агента по адресу http://localhost:8080/chat Lab подключает по вашему curl-запросу: пришлите команду curl, которой вы обращаетесь к нему (с телом запроса), — Lab разберёт её и проверит двумя тестовыми сообщениями.');
  assert.equal(asked.length, 0);
});

test('an address Lab found in the project is the owner\'s pick, never the plan\'s, and picking it asks for the curl', async t => {
  const cwd = await folder(t);
  await writeFile(join(cwd, 'config.yaml'), 'agent:\n  url: http://localhost:8080/chat\n');
  const { ctx, asked } = owner(cwd, (_title, options) => options[0]);
  await assert.rejects(findAgent(ctx, cwd), (error: unknown) => error instanceof NeedsOwner && !!error.ownerText?.includes('пришлите команду curl'));
  assert.equal(asked.length, 1, 'one address found is still a question');
  assert.deepEqual(asked[0]!.options, ['http://localhost:8080/chat — config.yaml: адрес http://localhost:8080/chat — подключу по вашему curl', 'Не сейчас']);
  // Nothing found: the question names both ways, a command or a module, and the curl for an address.
  const empty = await folder(t);
  await assert.rejects(findAgent(owner(empty, () => undefined).ctx, empty), (error: unknown) => error instanceof NeedsOwner
    && error.ownerText === 'Агент ещё не подключён, а в папке проекта Lab не нашёл, как его запускать. Как его запускать — команда или файл модуля? Если агент отвечает по адресу, пришлите curl-запрос, которым вы к нему обращаетесь.');
});

test('a connection that reads a variable nobody set stops the start in the owner\'s words, before any call', async t => {
  const cwd = await folder(t);
  const lab = new ExperimentLab(join(cwd, '.agent-lab'), cardRuntime());
  await lab.init();
  t.after(() => lab.close());
  const draft = await lab.create(cardInput({ target: { kind: 'unconnected' } }));
  await lab.waitForIdle();
  const prepared = await lab.get(draft.id);
  assert.equal(prepared.phase, 'review', prepared.error ?? '');
  delete process.env.AGENT_LAB_TEST_TENANT_KEY;
  const target = { kind: 'http' as const, url: 'http://127.0.0.1:9/agent', headersEnv: {}, timeoutMs: 60000,
    request: { body: { q: '{{message}}', key: '{{env:AGENT_LAB_TEST_TENANT_KEY}}' }, headers: {}, reply: '/text' } };
  const { ctx } = owner(cwd, (_title, options) => options.includes('Запустить') ? 'Запустить' : undefined);
  await assert.rejects(launchRun(ctx, lab, prepared, { target }),
    { message: 'Не задана переменная окружения AGENT_LAB_TEST_TENANT_KEY: её читает подключение агента. Задайте её и перезапустите Pi.' });
  const after = await lab.get(draft.id);
  assert.equal(after.target.kind, 'unconnected', 'nothing was connected');
  assert.deepEqual([after.phase, after.trials.length, after.usage.calls], ['review', 0, prepared.usage.calls], 'nothing ran and nothing was spent');
});
