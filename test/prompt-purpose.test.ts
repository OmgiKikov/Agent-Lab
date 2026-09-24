import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { choosePrompts, choosePromptsWithLab, promptOption, proposeOption } from '../extensions/prompt-choice.ts';
import { detectProject } from '../src/detect.js';
import { ExperimentLab } from '../src/experiment.js';
import { StructuredTaskError } from '../src/llm/structured.js';
import type { PromptCandidate } from '../src/prompt-candidates.js';
import {
  HEAD_CHARS, proposedPrompts, proposePurposes, purposeBatches, purposeKey, purposeLine, purposeTask, type PurposeProposal, type PurposeReader,
} from '../src/prompt-purpose.js';
import { callContext, fixture } from './helpers/pi-fixture.js';

/*
 * Lab proposes which of the agent's prompts write the reply to the customer (chunk W1b): one builder task per batch,
 * exactly one answer per listed prompt, customer_reply ticked in advance, the owner's pick is what becomes materials.
 * The proposal is cached by the prompts' ids and texts and the model. Synthetic prompts only; no paid call.
 */

const candidate = (id: string, text: string): PromptCandidate => ({ id, file: id.split('#')[0]!, identifier: id.split('#')[1], origin: 'code', chars: text.length, text });
const answer = candidate('app/answer.py#SYSTEM_PROMPT', 'Ты — ассистент эквайринга. Отвечай клиенту вежливо и только по статьям базы знаний.');
const intent = candidate('app/intent.py#INTENT_PROMPT', 'Определи намерение клиента и верни одно слово из списка: refund, status, other.');
const guard = candidate('app/guard.py#CHECK_PROMPT', 'Проверь черновик ответа перед отправкой: нет ли в нём внутренних систем банка.');
const verdicts = { p1: { purpose: 'classifier', reason: 'Возвращает одно слово-намерение, клиент его не читает.' },
  p2: { purpose: 'customer_reply', reason: 'Задаёт роль ассистента и тон ответа клиенту.' }, p3: { purpose: 'validation', reason: 'Проверяет черновик ответа перед отправкой.' } };
/** The proposal the scripted model makes for [intent, answer, guard]. */
const proposalOf = (builder = { provider: 'p', id: 'm' }): PurposeProposal => ({ formatVersion: 1, key: purposeKey([intent, answer, guard], builder), model: `${builder.provider}/${builder.id}`,
  version: 'a'.repeat(64), verdicts: [{ id: intent.id, ...verdicts.p1 }, { id: answer.id, ...verdicts.p2 }, { id: guard.id, ...verdicts.p3 }] as PurposeProposal['verdicts'],
  usage: { calls: 1, costUsd: null }, createdAt: new Date().toISOString() });

async function folder(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-lab-purpose-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('the answer names every listed prompt exactly once: a missing key and an invented one are both rejected', () => {
  const { output } = purposeTask(['p1', 'p2']);
  const ok = { purposes: { p1: verdicts.p1, p2: verdicts.p2 } };
  assert.equal(output.safeParse(ok).success, true);
  assert.equal(output.safeParse({ purposes: { p1: verdicts.p1 } }).success, false, 'a prompt cannot be skipped');
  assert.equal(output.safeParse({ purposes: { ...ok.purposes, p9: verdicts.p1 } }).success, false, 'a prompt cannot be invented');
  assert.equal(output.safeParse({ purposes: { ...ok.purposes, p2: { purpose: 'answer', reason: 'x' } } }).success, false, 'the purpose is one of five words');
  assert.equal(output.safeParse({ purposes: { ...ok.purposes, p2: { purpose: 'other', reason: 'я'.repeat(161) } } }).success, false, 'the reason is one short line');
});

test('a missing or an unknown prompt goes back to the model with the key named, and the repaired answer is read by candidate id', async t => {
  const replies = [
    JSON.stringify({ purposes: { p1: verdicts.p1, p2: verdicts.p2 } }), JSON.stringify({ purposes: verdicts }),
    JSON.stringify({ purposes: { ...verdicts, p4: verdicts.p1 } }), JSON.stringify({ purposes: verdicts }),
  ];
  const model = await fixture((_request, index) => replies[index]!);
  t.after(() => model.close());
  const reader = model.adapter.promptPurposes!;
  const expected = [[intent.id, verdicts.p1], [answer.id, verdicts.p2], [guard.id, verdicts.p3]];
  assert.deepEqual([...(await reader.read([intent, answer, guard], callContext().ctx)).entries()], expected);
  const request = JSON.parse(String((model.requests[0]!.messages[0] as { content: unknown }).content)) as { prompts: { key: string; id: string; head: string }[] };
  assert.deepEqual(request.prompts.map(item => [item.key, item.id]), [['p1', intent.id], ['p2', answer.id], ['p3', guard.id]]);
  assert.equal(request.prompts[1]!.head, answer.text, 'the beginning is verbatim');
  assert.match(JSON.stringify(model.requests[1]!.messages.at(-1)), /rejected.*purposes\.p3/, 'the missing prompt is named');
  assert.deepEqual([...(await reader.read([intent, answer, guard], callContext().ctx)).entries()], expected);
  assert.match(JSON.stringify(model.requests[3]!.messages.at(-1)), /rejected.*p4/, 'the invented prompt is named');
  assert.equal(model.requests.length, 4, 'one answer and one repair per batch');
});

test('long prompts are read by their beginning and batched under a byte cap; a batch that never passes stays undetermined', async () => {
  const many = Array.from({ length: 60 }, (_, i) => candidate(`app/m${i}.py#P${i}_PROMPT`, 'я'.repeat(4000)));
  const batches = purposeBatches(many);
  assert.ok(batches.length > 1 && batches.length < 10, `${batches.length} batches`);
  assert.deepEqual(batches.flat().map(item => item.id), many.map(item => item.id), 'every prompt once, in order');
  assert.equal(HEAD_CHARS, 1500);
  let call = 0;
  const reader: PurposeReader = { builder: { provider: 'p', id: 'm' }, async read(batch, ctx) {
    ctx.beforeCall();
    if (call++ === 0) throw new StructuredTaskError('Назначение промптов: модель 2 раза подряд вернула ответ, который не проходит проверку.');
    return new Map(batch.map(item => [item.id, { purpose: 'other' as const, reason: 'Служебный промпт.' }]));
  } };
  const proposal = await proposePurposes(many, reader, { timeoutMs: 1000 });
  assert.equal(proposal.verdicts.length, many.length - batches[0]!.length);
  assert.match(proposal.failure!, /не проходит проверку/);
  const shown = proposedPrompts(many, proposal);
  assert.equal(purposeLine(shown.at(-1)!), 'назначение не определено', 'undetermined prompts come last, in the owner\'s words');
  assert.equal(proposal.usage.calls, batches.length);
});

test('Lab proposes customer_reply first and ticks only those; the owner\'s words say purpose and reason on one line', () => {
  const shown = proposedPrompts([intent, answer, guard], proposalOf());
  assert.deepEqual(shown.map(item => [item.candidate.id, item.suggested]), [[answer.id, true], [intent.id, false], [guard.id, false]]);
  assert.equal(purposeLine(shown[0]!), 'ответ клиенту · Задаёт роль ассистента и тон ответа клиенту.');
  assert.equal(purposeLine(shown[1]!), 'классификатор · Возвращает одно слово-намерение, клиент его не читает.');
  assert.ok(!purposeLine({ ...shown[2]!, verdict: { purpose: 'validation', reason: 'строка\nвторая' } }).includes('\n'));
  assert.deepEqual(proposedPrompts([intent, answer], undefined).map(item => item.suggested), [false, false], 'without a proposal nothing is ticked');
});

test('the proposal is cached privately by the prompts\' texts and the model; a changed prompt or another model finds nothing', async t => {
  const root = await folder(t);
  const lab = new ExperimentLab(root, {});
  await lab.init();
  t.after(() => lab.close());
  const store = lab.store;
  const proposal = proposalOf();
  await store.writePromptPurposes(proposal);
  assert.deepEqual(await store.readPromptPurposes(purposeKey([intent, answer, guard], { provider: 'p', id: 'm' })), proposal);
  const [file] = await readdir(join(root, 'prompts'));
  assert.equal((await stat(join(root, 'prompts', file!))).mode & 0o777, 0o600);
  const edited = { ...answer, text: `${answer.text} Не обещай сроки.` };
  assert.equal(await store.readPromptPurposes(purposeKey([intent, edited, guard], { provider: 'p', id: 'm' })), undefined, 'a changed text invalidates it');
  assert.equal(await store.readPromptPurposes(purposeKey([intent, answer, guard], { provider: 'p', id: 'other' })), undefined, 'another model proposes afresh');
});

/** A native list scripted by `picks`, recording every title and its options. */
const ui = (picks: (string | ((options: string[]) => string))[]) => {
  const asked: { title: string; options: string[] }[] = [];
  return { asked, ctx: { ui: { select: async (title: string, options: string[]) => {
    asked.push({ title, options });
    const pick = picks.shift();
    return typeof pick === 'function' ? pick(options) : pick;
  } } } as unknown as Pick<ExtensionContext, 'ui'> };
};

test('in the chat the list offers the proposal once; after it the customer_reply prompts are ticked with their reasons and the owner still decides', async () => {
  let proposed = 0;
  const { ctx, asked } = ui([options => options[1]!, options => options.find(option => option.includes(intent.id))!, options => options[0]!]);
  const picked = await choosePrompts(ctx, [intent, answer, guard], { propose: async () => { proposed++; return proposalOf(); } });
  assert.equal(proposed, 1);
  assert.equal(asked[0]!.options[1], proposeOption([intent, answer, guard]));
  assert.match(asked[0]!.title, /Lab может прочитать начало 3 промптов своей моделью и отметить те, что пишут ответ клиенту: ≈1 вызов\./);
  const shown = proposedPrompts([intent, answer, guard], proposalOf());
  assert.deepEqual(asked[1]!.options, ['Готово — взять отмеченные: 1', ...shown.map((item, index) => promptOption(item.candidate, index, item.suggested, item)), 'Не сейчас'],
    'no second offer; customer_reply first and ticked');
  assert.ok(asked[1]!.options[1]!.startsWith(`✓ 1. ${answer.id} — строка в коде`), asked[1]!.options[1]);
  assert.ok(asked[1]!.options[1]!.endsWith(' — ответ клиенту · Задаёт роль ассистента и тон ответа клиенту.'), asked[1]!.options[1]);
  assert.deepEqual(picked, [answer, intent], 'the owner added the classifier: their pick is what becomes materials');
});

test('without a model nothing is ticked and nothing is offered; a stored proposal opens the list with its ticks for free', async t => {
  const root = await folder(t);
  const offline = new ExperimentLab(join(root, 'offline'), {});
  await offline.init();
  t.after(() => offline.close());
  const plain = ui([options => options[0]!]);
  assert.deepEqual(await choosePromptsWithLab({ ...plain.ctx, model: { provider: 'fixture', id: 'fixture-model' } } as never, offline, [intent, answer], new AbortController().signal), []);
  assert.deepEqual(plain.asked[0]!.options, ['Без промптов — только база знаний', promptOption(intent, 0, false), promptOption(answer, 1, false), 'Не сейчас']);

  const model = await fixture(() => JSON.stringify({ purposes: verdicts }));
  t.after(() => model.close());
  const opened = async () => { const lab = new ExperimentLab(join(root, 'lab'), model.adapter); await lab.init(); return lab; };
  const first = await opened();
  const asking = ui([options => options[1]!, options => options[0]!]);
  assert.deepEqual(await choosePromptsWithLab({ ...asking.ctx, model: { provider: 'fixture', id: 'fixture-model' } } as never, first, [intent, answer, guard], new AbortController().signal), [answer]);
  await first.close();
  assert.equal(model.requests.length, 1);
  const again = await opened();
  t.after(() => again.close());
  const cached = ui([options => options[0]!]);
  assert.deepEqual(await choosePromptsWithLab({ ...cached.ctx, model: { provider: 'fixture', id: 'fixture-model' } } as never, again, [intent, answer, guard], new AbortController().signal), [answer]);
  assert.equal(model.requests.length, 1, 'the second look costs no call');
  assert.ok(!cached.asked[0]!.options.some(option => option.startsWith('Пусть Lab')), 'nothing to offer: the proposal is there');
  assert.match(cached.asked[0]!.title, /Lab отметил ✓ промпты/);
});

test('agent-lab build --prompts-from: without --yes the cost is named and nothing is written; --prompts suggested takes the cached customer_reply prompts without a call', { timeout: 30000 }, async t => {
  const root = await folder(t);
  for (const [file, name, text] of [['app/intent.py', 'INTENT_PROMPT', intent.text], ['app/answer.py', 'SYSTEM_PROMPT', answer.text], ['app/guard.py', 'CHECK_PROMPT', guard.text]] as const) {
    await mkdir(join(root, dirname(file)), { recursive: true });
    await writeFile(join(root, file), `${name} = "${text}"\n`);
  }
  const task = join(root, 'task.json');
  await writeFile(task, JSON.stringify({ task: 'Проверить ответы эквайринга', mode: 'live', target: { kind: 'unconnected' }, materials: [], settings: { provider: 'p', model: 'm' } }));
  const data = join(root, '.agent-lab');
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const call = async (args: string[]) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, 'build', '--data-dir', data, '--input', task, '--prompts-from', root, ...args], { env: { ...process.env, AGENT_LAB_SESSION: '' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    return { code, stdout, stderr };
  };
  const listed = await call([]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /Lab может прочитать начало 3 промптов своей моделью и отметить те, что пишут ответ клиенту: ≈1 вызов\. Повторите с --yes\./);
  assert.match(listed.stdout, /ничего не записано и не потрачено/);
  assert.equal(await stat(data).then(() => true, () => false), false, 'nothing is written');
  const early = await call(['--prompts', 'suggested']);
  assert.equal(early.code, 1);
  assert.match(early.stderr, /Lab ещё не предлагал, какие промпты .* пишут ответ клиенту.*--yes/);

  // The proposal a --yes paid for, as it is stored: the same prompts, the task's model.
  const found = (await detectProject(root)).prompts;
  const stored = proposalOf();
  const writer = new ExperimentLab(data, {});
  await writer.init();
  try { await writer.store.writePromptPurposes({ ...stored, key: purposeKey(found, { provider: 'p', id: 'm' }) }); } finally { await writer.close(); }
  const shown = await call([]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.ok(shown.stdout.includes(`  ✓ ${answer.id} — строка в коде`), shown.stdout);
  assert.ok(shown.stdout.includes('      ответ клиенту · Задаёт роль ассистента и тон ответа клиенту.'), shown.stdout);
  assert.match(shown.stdout, /Взять отмеченные \(1\): та же команда с --prompts suggested/);
  const taken = await call(['--prompts', 'suggested']);
  assert.equal(taken.code, 0, taken.stderr);
  assert.match(taken.stderr, /Промпты агента: app\/answer\.py#SYSTEM_PROMPT\./, 'the ticked prompt, and no model was called for it');
  assert.match(taken.stdout, /Собрать: та же команда с --yes/);
  // A changed prompt is a new set: the stored proposal no longer applies.
  await writeFile(join(root, 'app/answer.py'), `SYSTEM_PROMPT = "${answer.text} Не обещай сроки."\n`);
  assert.match((await call(['--prompts', 'suggested'])).stderr, /Lab ещё не предлагал/);
});
