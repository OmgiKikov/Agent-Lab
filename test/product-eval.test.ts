import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { TOOL } from '../extensions/steps.ts';
import { buildFixture, CASES, score, type EvalCase, type Fixture } from './live/product-eval-cases.ts';
import { playCase } from './live/product-eval-session.ts';
import { fixture } from './helpers/pi-fixture.js';
import { registered } from './helpers/pi-session.js';

/*
 * The product eval runs against a real model only on purpose (test/live/product-eval.ts). What CI keeps true: every
 * phrase names a tool that exists, every project it is said in can be built, and the scorer tells a right answer
 * from a wrong one — so the eval is ready whenever a model is.
 */

test('every eval phrase expects a registered tool, and the phrases cover every step of the owner\'s path', () => {
  const { tools } = registered();
  const ids = CASES.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'each case has its own id');
  for (const item of CASES) {
    assert.ok(tools.has(item.expect.tool), `${item.id}: ${item.expect.tool} is not a registered tool`);
    assert.match(item.phrase, /[а-яё]/i, `${item.id}: the owner speaks Russian`);
  }
  const expected = new Set(CASES.map(item => item.expect.tool));
  for (const tool of [TOOL.prepare, TOOL.cards, TOOL.edit, TOOL.decide, TOOL.run, TOOL.results, TOOL.explain, TOOL.agree]) assert.ok(expected.has(tool), `no phrase for ${tool}`);
});

test('the scorer: reads may come first, a change before the expected tool fails, so do other arguments and an unchanged project', async () => {
  const item: EvalCase = { id: 'probe', phrase: 'Запусти готовые.', fixture: 'draft', expect: { tool: TOOL.run, args: args => args.action === undefined },
    state: async () => undefined };
  assert.deepEqual(await score(item, [{ name: TOOL.status, args: {} }, { name: TOOL.cards, args: {} }, { name: TOOL.run, args: {} }], '/nowhere'), { passed: true, notes: [] });
  assert.equal((await score(item, [{ name: TOOL.edit, args: {} }, { name: TOOL.run, args: {} }], '/nowhere')).passed, false, 'a change before the asked action');
  assert.equal((await score(item, [{ name: TOOL.run, args: { action: 'stop' } }], '/nowhere')).passed, false, 'the tool with another meaning');
  assert.equal((await score(item, [], '/nowhere')).passed, false, 'nothing called');
  assert.deepEqual(await score({ ...item, state: async () => 'nothing ran' }, [{ name: TOOL.run, args: {} }], '/nowhere'), { passed: false, notes: ['nothing ran'] });
});

test('every eval project builds from invented data, and a state check sees that nothing happened on it untouched', { timeout: 120000 }, async () => {
  const built = new Map<Fixture, string>();
  try {
    for (const fixture of new Set(CASES.map(item => item.fixture))) built.set(fixture, await buildFixture(fixture));
    // The declined consent is the one case whose state is the untouched project; every other asks for a change.
    for (const item of CASES.filter(candidate => candidate.state && candidate.id !== 'check-the-agent')) {
      assert.ok(await item.state!(built.get(item.fixture)!), `${item.id}: its state check passes on a project where nothing happened`);
    }
    assert.equal(await CASES.find(item => item.id === 'check-the-agent')!.state!(built.get('folder')!), undefined);
  } finally { for (const cwd of built.values()) await rm(cwd, { recursive: true, force: true }); }
});

test('the eval plays a phrase through a real Pi session: the model\'s tool call, the scripted owner\'s answer in the native dialog, the verdict', { timeout: 120000 }, async () => {
  // An offline model that calls the tool it is told to, then answers in words: the session, the extension and the owner are real.
  const script: Record<string, string> = { 'show-situations': 'agent_lab_cards', 'run-ready': 'agent_lab_run' };
  let current = '';
  const offline = await fixture((_request, index) => index % 2 === 0 ? [{ type: 'toolCall', id: `call_${index}`, name: script[current]!, arguments: {} }] : 'Готово.');
  try {
    const model = offline.runtime.getModel('agent-lab-test', 'test-model')!;
    for (const id of Object.keys(script)) {
      current = id;
      const item = CASES.find(candidate => candidate.id === id)!;
      const played = await playCase(item, { runtime: offline.runtime, model, agentDir: offline.directory });
      assert.deepEqual([played.passed, played.notes, played.calls.map(call => call.name)], [true, [], [script[id]]], id);
      if (id === 'run-ready') assert.deepEqual(played.dialogs, ['Принять 1 ситуацию и запустить?'], 'the owner answered the one run dialog');
    }
    // The model saw only the tools of the step — a draft of situations has no results to read yet — next to Pi's own tools,
    // and the one instruction source in its system prompt.
    const first = offline.requests[0] as { tools?: { name: string }[]; systemPrompt?: string };
    const offered = first.tools?.map(tool => tool.name) ?? [];
    assert.deepEqual(offered.filter(name => name.startsWith('agent_lab_')), [TOOL.status, TOOL.prepare, TOOL.connect, TOOL.cards, TOOL.edit, TOOL.decide, TOOL.run]);
    assert.ok(offered.includes('read') && offered.includes('bash'), offered.join(', '));
    assert.match(first.systemPrompt ?? '', /Вы — Agent Lab в проекте владельца/);
  } finally { await rm(offline.directory, { recursive: true, force: true }); }
});
