import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { stepTools, TOOL } from '../extensions/steps.ts';
import { rememberedConnection, readConnection } from '../src/connection.js';
import { connectionLines, proposeRequest, requestFields, requestTask } from '../src/connect.js';
import { connectionFromCurl } from '../src/curl.js';
import { ExperimentLab } from '../src/experiment.js';
import { fixture } from './helpers/pi-fixture.js';
import { output, registered } from './helpers/pi-session.js';

/*
 * The owner pastes a curl into the Pi chat and Lab connects the agent (chunk CONNECT): the builder model reads which
 * field is the customer's message and where the agent's text is, the owner confirms both in native dialogs, two test
 * messages go to a local agent in an envelope like the owner's, and the checked connection is saved where the next
 * preparation finds it. Synthetic envelope and hosts only (example.test, rewritten to localhost); no paid call.
 */

const CURL = String.raw`curl -s -X POST 'https://agent.example.test/api/v1/chat' \
  -H 'Content-Type: application/json' \
  -H "Request-Id: $(uuidgen)" \
  -H "Request-Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  --data-raw '{"message":{"version":"1.0","performative":"request","sender":"lab","conversation_id":"c-1","reply_with":"r-1",
    "content":{"user_input":"Здравствуйте, как вернуть оплату?"}},"metadata":{"channel":"web","dialog":{"dialog_id":"d-1"}}}'`;
const MESSAGE = '/message/content/user_input';
const REPLY = '/result/answer/text';

/** An agent in its own envelope: it keeps each conversation by its id and answers in result.answer.text; `status` fails every request. */
async function envelopeAgent(t: TestContext, status = 200) {
  const requests: { body: Record<string, any>; authorization?: string }[] = [];
  const turns = new Map<string, number>();
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push({ body, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
      if (status !== 200) { res.statusCode = status; res.end('{}'); return; }
      const id = body.message.conversation_id as string;
      turns.set(id, (turns.get(id) ?? 0) + 1);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', result: { answer: { text: `Здравствуйте! Ход ${turns.get(id)}: помогу с возвратом и статусом платежа.` }, intent: 'greeting' } }));
    });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  t.after(() => new Promise<void>(r => { srv.closeAllConnections(); srv.close(() => r()); }));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/v1/chat`;
  return { url, curl: CURL.replace('https://agent.example.test/api/v1/chat', url), requests };
}

async function project(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-connect-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

/** The owner's own variable the curl's Authorization header names ($AGENT_TOKEN), set as it is in the owner's shell. */
function secret(t: TestContext): void {
  const previous = process.env.AGENT_TOKEN;
  process.env.AGENT_TOKEN = 'fixture-token';
  t.after(() => { if (previous === undefined) delete process.env.AGENT_TOKEN; else process.env.AGENT_TOKEN = previous; });
}

/** A scripted owner in Pi's terminal: `answer` picks from each native list; every list is kept. */
function owner(cwd: string, answer: (title: string, options: string[]) => string | undefined, model?: { provider: string; id: string }) {
  const dialogs: { title: string; options: string[] }[] = [];
  const ctx = { cwd, mode: 'tui', hasUI: true, model,
    ui: { select: async (title: string, options: string[]) => { dialogs.push({ title, options }); return answer(title, options); }, editor: async () => undefined, notify() {}, setStatus() {}, setWidget() {} } } as unknown as ExtensionContext;
  return { ctx, dialogs };
}
const starting = (options: string[], prefix: string) => options.find(option => option.startsWith(prefix));
const saved = (cwd: string) => access(join(cwd, 'connection.json')).then(() => true, () => false);

test('the builder reads the request: the message is an enum of the fields that can carry words, the conversation is never the message', () => {
  const asked = connectionFromCurl(CURL);
  const fields = requestFields(asked);
  assert.ok(fields.some(field => field.pointer === MESSAGE));
  assert.ok(!fields.some(field => field.pointer === '/message/conversation_id' || field.pointer === '/metadata/dialog/dialog_id'), 'the key names already show the conversation');
  const task = requestTask(asked.fields.map(field => ({ pointer: field.pointer, keys: [], value: String(field.value) })), fields.map(field => field.pointer));
  assert.equal(task.role, 'builder');
  assert.equal(task.output.safeParse({ message: MESSAGE, conversation: [], reason: 'Текст клиента.' }).success, true);
  assert.equal(task.output.safeParse({ message: '/message/conversation_id', conversation: [], reason: 'x' }).success, false, 'not a field that can carry words');
  assert.equal(task.output.safeParse({ message: '/invented', conversation: [], reason: 'x' }).success, false);
  assert.match(task.check!({ message: MESSAGE, conversation: [MESSAGE], reason: 'x' }) ?? '', /both the message and the conversation/);

  const made = connectionFromCurl(CURL, { message: MESSAGE });
  const lines = connectionLines(made, 'поле с текстом клиента');
  assert.deepEqual(lines.slice(0, 3), ['Адрес: https://agent.example.test/api/v1/chat', 'Сообщение клиента → message.content.user_input (поле с текстом клиента)',
    'Разговор → message.conversation_id, metadata.dialog.dialog_id (новый в каждой ситуации)']);
  // Every saved header, and how it is kept: its value, or the variable it is read from — the owner's own $AGENT_TOKEN as it is.
  for (const line of ['Заголовок Content-Type: application/json', 'Заголовок Request-Id: новый id — подставляется при каждом запросе',
    'Заголовок Request-Time: текущее время — подставляется при каждом запросе',
    'Заголовок Authorization: Bearer $AGENT_TOKEN — из переменной окружения AGENT_TOKEN, в файле только её имя']) assert.ok(lines.includes(line), `${line}\n---\n${lines.join('\n')}`);
  assert.ok(!made.warnings.some(warning => warning.includes('Request-Time')), 'the date command keeps its own format, nothing to warn about');
});

test('one text field left is the message without a model call; no text field is refused in plain words', async () => {
  const signal = new AbortController().signal;
  const only = connectionFromCurl(`curl https://agent.example.test/x -d '{"session_id":"s-1","q":"Здравствуйте"}'`);
  assert.deepEqual(await proposeRequest(only, { timeoutMs: 1000, signal }), { message: '/q', conversation: ['/session_id'] });
  const none = connectionFromCurl(`curl https://agent.example.test/x -d '{"session_id":"s-1","n":1}'`);
  await assert.rejects(proposeRequest(none, { timeoutMs: 1000, signal }), /нет текстового поля для сообщения клиента/);
});

test('a pasted curl in the chat: the builder picks the fields, the owner confirms natively, two test messages pass, connection.json is saved 0600 and the next preparation uses it', { timeout: 60000 }, async t => {
  const agent = await envelopeAgent(t);
  const cwd = await project(t);
  secret(t);
  const replies = [JSON.stringify({ message: MESSAGE, conversation: [], reason: 'Ключ user_input несёт слова клиента.' }),
    JSON.stringify({ reply: REPLY, reason: 'Текст ответа клиенту в result.answer.text.' })];
  const model = await fixture((_request, index) => replies[index]!);
  t.after(() => model.close());
  const { tools, shutdown } = registered(undefined, { createLab: directory => new ExperimentLab(directory, model.adapter) });
  t.after(shutdown);
  const { ctx, dialogs } = owner(cwd, (title, options) =>
    title.startsWith('Так подключить агента?') ? 'Да' : title.startsWith('Отправить агенту 2 тестовых сообщения?') ? 'Отправить'
      : title.startsWith('Агент ответил:') ? 'Да' : 'Не сейчас', { provider: 'agent-lab-test', id: 'test-model' });
  const result = output(await tools.get(TOOL.connect)!.execute('connect', { curl: agent.curl }, undefined, undefined, ctx));
  assert.equal(result.connected, true, JSON.stringify(result));
  assert.equal(result.reply, 'result.answer.text');

  // Two confirmations and the consent, in the owner's words; no path was typed by the owner.
  assert.deepEqual(dialogs.map(dialog => dialog.title.split('\n')[0]), ['Так подключить агента?', 'Отправить агенту 2 тестовых сообщения?',
    'Агент ответил: «Здравствуйте! Ход 1: помогу с возвратом и статусом платежа.» — это ответ?']);
  assert.match(dialogs[0]!.title, /Сообщение клиента → message\.content\.user_input \(Ключ user_input несёт слова клиента\.\)/);
  assert.match(dialogs[0]!.title, /Разговор → message\.conversation_id, metadata\.dialog\.dialog_id \(новый в каждой ситуации\)/);
  assert.deepEqual(dialogs[0]!.options, ['Да', 'Нет, поправить']);

  // The builder read the owner's example request and the reply to Lab's test phrase — the message candidates are an enum.
  assert.equal(model.requests.length, 2);
  const read = JSON.parse(String((model.requests[0]!.messages[0] as { content: unknown }).content)) as { messageCandidates: string[]; fields: { pointer: string; value: string }[] };
  assert.ok(read.messageCandidates.includes(MESSAGE) && !read.messageCandidates.includes('/message/conversation_id'));
  assert.ok(read.fields.some(field => field.value === 'Здравствуйте, как вернуть оплату?'));

  // Two messages of one conversation, the owner's own variable read from the environment, the ids fresh.
  assert.equal(agent.requests.length, 2);
  const [first, second] = agent.requests;
  assert.equal(first!.body.message.conversation_id, second!.body.message.conversation_id);
  assert.equal(first!.body.metadata.dialog.dialog_id, first!.body.message.conversation_id);
  assert.notEqual(first!.body.message.conversation_id, 'c-1');
  assert.equal(first!.authorization, 'Bearer fixture-token');
  // The agent does not name the conversation in its reply: Lab cannot see it keep the first message, and says so.
  assert.match(String(result.warnings?.[0]), /не называет разговор в ответе/);

  const file = join(cwd, 'connection.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const text = await readFile(file, 'utf8');
  assert.ok(!text.includes('fixture-token'), 'no secret in the file');
  const connection = await readConnection(file);
  assert.ok(connection.target.kind === 'http' && connection.target.request?.reply === REPLY);
  assert.deepEqual(connection.target.headersEnv, {});
  assert.equal(connection.target.request?.headers.Authorization, 'Bearer {{env:AGENT_TOKEN}}', 'the owner\'s variable is read as it is: no new variable, no restart');
  const remembered = await rememberedConnection(join(cwd, '.agent-lab'));
  assert.ok(remembered?.target.kind === 'http' && remembered.target.url === agent.url);

  // The next preparation proposes this agent in its one consent; declining it spends nothing.
  const prepare = owner(cwd, () => 'Не сейчас', { provider: 'agent-lab-test', id: 'test-model' });
  const prepared = output(await tools.get(TOOL.prepare)!.execute('prepare', { task: 'Агент эквайринга отвечает о возвратах.', withoutLogs: true, rules: 'Возврат оформляется в течение 30 дней.' },
    undefined, undefined, prepare.ctx));
  assert.equal(prepared.cancelled, true);
  assert.ok(prepare.dialogs.at(-1)!.title.includes(`Агент: ${agent.url}.`), prepare.dialogs.at(-1)!.title);
  assert.equal(model.requests.length, 2, 'the declined preparation called no model');
});

test('without a model the owner picks from the same lists, corrects the reading once and replaces the old connection.json', { timeout: 60000 }, async t => {
  const agent = await envelopeAgent(t);
  const cwd = await project(t);
  secret(t);
  await writeFile(join(cwd, 'connection.json'), '{"format":"agent-lab-connection-1","target":{"kind":"http","url":"https://old.example.test/agent"}}\n');
  const { tools, shutdown } = registered();
  t.after(shutdown);
  let confirmations = 0;
  const { ctx, dialogs } = owner(cwd, (title, options) => {
    if (title.startsWith('Какое поле запроса')) return starting(options, 'message.content.user_input');
    if (title.startsWith('Какие поля')) return starting(options, 'Готово');
    if (title.startsWith('Так подключить агента?')) return confirmations++ ? 'Да' : 'Нет, поправить';
    if (title.startsWith('Отправить агенту')) return 'Отправить';
    if (title.startsWith('Где в ответе агента')) return starting(options, 'result.answer.text');
    if (title.startsWith('Агент ответил:')) return 'Да';
    if (title.startsWith('В папке проекта уже есть connection.json')) return 'Заменить';
    return undefined;
  });
  const result = output(await tools.get(TOOL.connect)!.execute('connect', { curl: agent.curl }, undefined, undefined, ctx));
  assert.equal(result.connected, true, JSON.stringify(result));
  const titles = dialogs.map(dialog => dialog.title.split('\n')[0]);
  assert.deepEqual(titles, ['Какое поле запроса — сообщение клиента?', 'Какие поля — идентификатор разговора?', 'Так подключить агента?',
    'Какое поле запроса — сообщение клиента?', 'Какие поля — идентификатор разговора?', 'Так подключить агента?',
    'Отправить агенту 2 тестовых сообщения?', 'Где в ответе агента его текст клиенту?', titles[8], 'В папке проекта уже есть connection.json. Заменить его этим подключением?']);
  // The conversation fields the key names show are ticked in advance; the reply list shows each field's length.
  assert.ok(dialogs[1]!.options.includes('✓ message.conversation_id · «c-1»'), dialogs[1]!.options.join('\n'));
  assert.ok(dialogs[1]!.options[0]!.startsWith('Готово — разговор: message.conversation_id, metadata.dialog.dialog_id'));
  assert.ok(dialogs[7]!.options.some(option => option.startsWith('result.answer.text · 59 символов')), dialogs[7]!.options.join('\n'));
  const connection = await readConnection(join(cwd, 'connection.json'));
  assert.ok(connection.target.kind === 'http' && connection.target.url === agent.url && connection.target.request?.reply === REPLY);
});

test('a failed test call, a step back, a missing secret or text that is not curl save nothing and say why', { timeout: 60000 }, async t => {
  const cwd = await project(t);
  const { tools, shutdown } = registered();
  t.after(shutdown);
  const agree = (title: string, options: string[]) => title.startsWith('Какое поле запроса') ? starting(options, 'message.content.user_input')
    : title.startsWith('Какие поля') ? starting(options, 'Готово') : title.startsWith('Так подключить') ? 'Да' : title.startsWith('Отправить') ? 'Отправить' : undefined;
  const connect = async (curl: string, answer = agree) => output(await tools.get(TOOL.connect)!.execute('c', { curl }, undefined, undefined, owner(cwd, answer).ctx));

  const notCurl = await connect('вот ручка агента: https://agent.example.test/chat');
  assert.equal(notCurl.connected, false);
  assert.match(notCurl.reason, /Ожидается команда curl/);

  // The variable the curl names is not set: nothing is sent.
  const missing = await envelopeAgent(t);
  delete process.env.AGENT_TOKEN;
  const unset = await connect(missing.curl);
  assert.match(unset.reason, /AGENT_TOKEN \(её называет ваш curl\)/);
  assert.equal(missing.requests.length, 0);

  secret(t);
  const failing = await envelopeAgent(t, 500);
  const broken = await connect(failing.curl);
  assert.match(broken.reason, /^Агент ответил ошибкой 500 на своей стороне/);
  assert.equal(failing.requests.length, 1);

  const denied = await envelopeAgent(t, 403);
  assert.match((await connect(denied.curl)).reason, /отказал в доступе \(403\)/);

  const closed = await envelopeAgent(t);
  const declined = await connect(closed.curl, (title, options) => title.startsWith('Отправить') ? 'Не сейчас' : agree(title, options));
  assert.equal(declined.cancelled, true);
  assert.equal(closed.requests.length, 0, 'no consent, no test message');

  assert.equal(await saved(cwd), false);
  assert.equal(await rememberedConnection(join(cwd, '.agent-lab')), undefined);

  const headless = output(await tools.get(TOOL.connect)!.execute('c', { curl: closed.curl }, undefined, undefined, { cwd, hasUI: false, mode: 'print' } as ExtensionContext));
  assert.match(headless.reason, /интерактивном терминале Pi/);
});

test('connecting is open at every step, and the model never sees more than ten Lab tools', () => {
  const steps = [stepTools([]), stepTools([{ trials: [] }]), stepTools([{ trials: [{} as never] }])];
  for (const tools of steps) {
    assert.ok(tools.includes(TOOL.connect));
    assert.ok(tools.length <= 10, `${tools.length} tools`);
  }
  assert.equal(steps.at(-1)!.length, 10);
});
