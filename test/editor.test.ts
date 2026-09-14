import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { editDraft, inputError } from '../extensions/editor.ts';
import { ExperimentLab, draftHash } from '../src/experiment.js';
import { demoEvaluationInput } from '../src/demo.js';
import { previewCriteria } from '../src/preview.js';

test('the native example editor invokes the semantic judge and shows both verdicts after confirmation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-semantic-editor-'));
  const lab = new ExperimentLab(directory); await lab.init();
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  const created = await lab.create(demoEvaluationInput()); await lab.waitForIdle(); const record = await lab.get(created.id);
  const answers = ['A good answer', 'A bad answer']; let calls = 0; let output = '';
  const ctx = { signal: new AbortController().signal, ui: {
    select: async (title: string) => { if (title.startsWith('Что изменить')) return 'Проверить ожидание на примерах'; output = title; return 'Закрыть'; },
    editor: async () => answers.shift(), confirm: async () => true,
  } } as unknown as ExtensionContext;
  await editDraft(ctx, { type: 'edit', record, section: 'cards', selected: 0 }, undefined,
    (id, examples) => previewCriteria(record, id, examples, { directory, runtime: { async assess({ scenario, trial }, context) {
      calls++; context.beforeCall();
      return scenario.metrics.map(m => ({ metricId: m.id, result: trial.events.at(-1).text.includes('good') ? 'pass' : 'fail', evidence: [1], rationale: 'Semantic fixture result' }));
    } } as never }));
  assert.equal(calls, 2); assert.match(output, /pass ·/); assert.match(output, /fail ·/); assert.match(output, /Semantic fixture result/);
  assert.match(output, /версии и расход сохранены/);
});

test('native editor retains invalid input, validates the correction and changes only the selected card', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-editor-'));
  const lab = new ExperimentLab(directory);
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  await lab.init();
  const created = await lab.create(demoEvaluationInput());
  await lab.waitForIdle();
  const record = await lab.get(created.id);
  const inputs = ['abc', '16', '2'];
  const seen: { title: string; input: string }[] = [];
  const ctx = { ui: {
    select: async () => 'Максимум ответов после первой реплики',
    editor: async (title: string, input: string) => { seen.push({ title, input }); return inputs.shift(); },
  } } as unknown as ExtensionContext;
  const patch = await editDraft(ctx, { type: 'edit', record, section: 'cards', selected: 1 });
  assert.equal(patch?.scenarios?.length, 1);
  assert.equal(patch?.scenarios?.[0]?.user.maxFollowUps, 2);
  assert.deepEqual(seen.slice(1).map(s => s.input), ['abc', '16']);
  assert.ok(seen.slice(1).every(s => /Введите целое число от 0 до 15/.test(s.title)));
  assert.deepEqual((await lab.get(record.id)).scenarios, record.scenarios, 'editor does not save unfinished input');
  const changed = await lab.updateDraft(record.id, draftHash(record), patch!);
  assert.equal(changed.scenarios.length, 3);
  assert.deepEqual(changed.scenarios[0], record.scenarios[0]);
  assert.deepEqual(changed.scenarios[2], record.scenarios[2]);

  const jsonInputs = ['{broken', undefined];
  seen.length = 0;
  ctx.ui.select = async () => 'Точные проверки · JSON';
  ctx.ui.editor = async (title, input) => { seen.push({ title, input: input ?? '' }); return jsonInputs.shift(); };
  assert.equal(await editDraft(ctx, { type: 'edit', record: changed, section: 'cards', selected: 0 }), undefined);
  assert.match(seen[1]!.title, /Некорректный JSON/);
  assert.equal(seen[1]!.input, '{broken');
  assert.deepEqual((await lab.get(record.id)).scenarios, changed.scenarios, 'cancelling a malformed JSON edit changes nothing');

  const contradictory = JSON.stringify([
    { id: 'includes', kind: 'answer_contains', description: 'Обязательный текст', value: 'same' },
    { id: 'excludes', kind: 'answer_omits', description: 'Запрещённый текст', value: 'same' },
  ]);
  const domainInputs = [contradictory, undefined];
  seen.length = 0;
  ctx.ui.editor = async (title, input) => { seen.push({ title, input: input ?? '' }); return domainInputs.shift(); };
  await editDraft(ctx, { type: 'edit', record: changed, section: 'cards', selected: 0 }, async patch => {
    await lab.updateDraft(changed.id, draftHash(changed), patch);
  });
  assert.equal(seen[1]!.input, contradictory, 'canonical validation failure also retains the entered text');
  assert.match(seen[1]!.title, /Ошибка:/);
  assert.deepEqual((await lab.get(record.id)).scenarios, changed.scenarios);
  const malicious = z.strictObject({}).safeParse({ ['bad\x1b[2Jkey']: true });
  assert.equal(malicious.success, false);
  assert.doesNotMatch(inputError(malicious.error), /\x1b/);
});

test('native connection fields preserve argv boundaries, validate changes and retain advanced options', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-connection-'));
  const lab = new ExperimentLab(directory); await lab.init();
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  const created = await lab.create(demoEvaluationInput()); await lab.waitForIdle();
  const record = await lab.get(created.id);
  record.target = { kind: 'command', command: 'python3', args: ['/tmp/agent with spaces.py'], cwd: '/tmp', timeoutMs: 12000 };
  const choices = ['Подключение агента', 'Аргументы · по одному в строке'];
  const ctx = { ui: {
    select: async () => choices.shift(),
    editor: async (_title: string, input: string) => { assert.equal(input, '/tmp/agent with spaces.py'); return '/tmp/agent with spaces.py\n--fixed\n$(not-a-shell-command)'; },
  } } as unknown as ExtensionContext;
  const action = { type: 'edit' as const, record, section: 'agent' as const, selected: 0 };
  const patch = await editDraft(ctx, action);
  assert.deepEqual(patch?.target, { ...record.target, args: ['/tmp/agent with spaces.py', '--fixed', '$(not-a-shell-command)'] });
  record.target = { kind: 'http', url: 'https://example.com/agent', headersEnv: { Authorization: 'TEST_TOKEN' }, timeoutMs: 4000 };
  choices.push('Подключение агента', 'URL агента');
  const inputs = ['invalid url', 'https://example.com/v2']; const titles: string[] = [];
  ctx.ui.editor = async (title) => { titles.push(title); return inputs.shift(); };
  assert.deepEqual((await editDraft(ctx, action))?.target, { ...record.target, url: 'https://example.com/v2' });
  assert.match(titles[1]!, /Ошибка:/);
  record.target = { kind: 'command', command: 'python3', args: [''], timeoutMs: 4000 };
  choices.push('Подключение агента', 'Аргументы · по одному в строке');
  ctx.ui.editor = async (title, input) => { assert.match(title, /JSON/); assert.deepEqual(JSON.parse(input!).args, ['']); return undefined; };
  assert.equal(await editDraft(ctx, action), undefined, 'unsupported text representations fall back without changing argv');
});

test('expectations can be edited as fields and previewed without JSON while other criteria survive', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-expectation-'));
  const lab = new ExperimentLab(directory); await lab.init();
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  const created = await lab.create(demoEvaluationInput()); await lab.waitForIdle();
  const record = await lab.get(created.id);
  const original = record.scenarios[0]!;
  const choices = ['Критерий успеха', 'Добавить ожидание', 'Нет фразы'];
  const fields = ['Не раскрывать секрет', 'internal_key'];
  const ctx = { ui: { select: async () => choices.shift(), editor: async () => fields.shift() } } as unknown as ExtensionContext;
  const patch = await editDraft(ctx, { type: 'edit', record, section: 'cards', selected: 0 });
  const changed = await lab.updateDraft(record.id, draftHash(record), patch!);
  assert.deepEqual(changed.scenarios[0]!.checks.slice(0, -1), original.checks);
  assert.deepEqual(changed.scenarios[0]!.metrics, original.metrics);
  assert.equal(changed.scenarios[0]!.checks.at(-1)?.kind, 'answer_omits');
  assert.match(changed.scenarios[0]!.successCriteria!, /Не раскрывать секрет/);
  const previews: string[] = []; const replies = ['Safe answer', 'internal_key']; let selections = 0;
  ctx.ui.select = async title => { if (++selections === 1) return 'Проверить ожидание на примерах'; previews.push(title); return 'Закрыть'; };
  ctx.ui.editor = async () => replies.shift();
  await editDraft(ctx, { type: 'edit', record: changed, section: 'cards', selected: 0 });
  assert.match(previews[0]!, /✓ Не раскрывать секрет/); assert.match(previews[0]!, /✕ Не раскрывать секрет/);
  assert.match(previews[0]!, /Нужны трасса или судья/);
  let roles = await lab.updateDraft(changed.id, draftHash(changed), { settings: { roles: { builder: { provider: 'fixture', model: 'builder' } } } });
  roles = await lab.updateDraft(roles.id, draftHash(roles), { settings: { roles: { judge: { provider: 'fixture', model: 'judge' } } } });
  assert.equal(roles.settings.roles.builder?.model, 'builder');
  roles = await lab.updateDraft(roles.id, draftHash(roles), { settings: { roles: { judge: null } } });
  assert.equal(roles.settings.roles.judge, undefined); assert.equal(roles.settings.roles.builder?.model, 'builder');
});

test('user state and the external world are editable as plain fields without touching other card fields', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-user-state-'));
  const lab = new ExperimentLab(directory); await lab.init();
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  const created = await lab.create(demoEvaluationInput()); await lab.waitForIdle();
  let record = await lab.get(created.id);
  const original = structuredClone(record.scenarios[0]!);
  const edit = async (label: string, text: string) => {
    const choices = ['Расширенные настройки', label];
    const ctx = { ui: { select: async () => choices.shift(), editor: async () => text } } as unknown as ExtensionContext;
    const patch = await editDraft(ctx, { type: 'edit', record, section: 'cards', selected: 0 });
    record = await lab.updateDraft(record.id, draftHash(record), patch!);
    return record.scenarios[0]!;
  };
  assert.deepEqual((await edit('Что знает пользователь · по одному в строке', 'Appointment ID A101\nDesired time 14:00\n')).user.knows, ['Appointment ID A101', 'Desired time 14:00']);
  assert.deepEqual((await edit('Чего пользователь не может знать · по одному в строке', 'Backend reason')).user.cannotKnow, ['Backend reason']);
  assert.deepEqual((await edit('Ответы на уточнения · JSON', '[{"ifAsked":"ID","reply":"A101"}]')).user.answers, [{ ifAsked: 'ID', reply: 'A101' }]);
  assert.deepEqual((await edit('Внешнее состояние · JSON · пусто = убрать', '{"cards":[{"id":"c1"}]}')).initialState.external, { cards: [{ id: 'c1' }] });
  const cleared = await edit('Внешнее состояние · JSON · пусто = убрать', '');
  assert.equal(cleared.initialState.external, undefined);
  assert.equal((await edit('Что знает пользователь · по одному в строке', '\n')).user.knows, undefined, 'an emptied list is removed, not stored as []');
  assert.deepEqual(cleared.checks, original.checks); assert.equal(cleared.user.opening, original.user.opening);
  assert.deepEqual(record.scenarios.slice(1), (await lab.get(record.id)).scenarios.slice(1), 'other cards are untouched');
  // Opening an absent external world shows an empty editor, so saving it unchanged cannot create `{}` that an adapter would have to confirm.
  const opened: string[] = [];
  const peek = ['Расширенные настройки', 'Внешнее состояние · JSON · пусто = убрать'];
  await editDraft({ ui: { select: async () => peek.shift(), editor: async (_title: string, initial: string) => { opened.push(initial); return undefined; } } } as unknown as ExtensionContext, { type: 'edit', record, section: 'cards', selected: 0 });
  assert.deepEqual(opened, ['']);
  const rejected = ['Расширенные настройки', 'Ответы на уточнения · JSON'];
  const attempts = ['not json', '[{"ifAsked":"ID","reply":"A101"}]']; const titles: string[] = [];
  const ctx = { ui: { select: async () => rejected.shift(), editor: async (title: string) => { titles.push(title); return attempts.shift(); } } } as unknown as ExtensionContext;
  await editDraft(ctx, { type: 'edit', record, section: 'cards', selected: 0 });
  assert.match(titles[1]!, /Некорректный JSON/);
});
