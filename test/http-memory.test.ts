import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { checkTemplate } from '../src/connection.js';
import { connectionLines, proposeRequest } from '../src/connect.js';
import { connectionFromCurl } from '../src/curl.js';
import { atPointer } from '../src/http-template.js';
import { openExternalTarget, type TemplateTarget } from '../src/targets.js';
import type { CallContext } from '../src/runtime.js';

/*
 * How an agent in its own format keeps a conversation is read from the owner's curl and checked by structure on the
 * second test turn. Local agents in the shapes of the common APIs: an OpenAI-style one without memory that takes the
 * whole `messages` list, one that names the conversation itself (Dify), one answering with an array of bubbles
 * (Rasa), one numbering its sessions. What cannot be decided is a warning, never a silent pass.
 */

type Handler = (body: any) => { status?: number; reply: unknown };
async function agent(t: TestContext, handler: Handler) {
  const requests: any[] = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const { status = 200, reply } = handler(body);
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  t.after(() => new Promise<void>(r => { srv.closeAllConnections(); srv.close(() => r()); }));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/agent`, requests };
}
const target = (made: ReturnType<typeof connectionFromCurl>): TemplateTarget => {
  assert.ok(made.kind === 'ready' && made.target.kind === 'http' && made.target.request);
  return { ...made.target, request: made.target.request };
};
const context = (): CallContext => ({ signal: new AbortController().signal, timeoutMs: 5000, beforeCall() {}, addUsage() {} });
const world = () => ({ records: {}, writableFields: [], transientFailures: 0 });

test('an API without memory that takes the conversation as `messages` gets the whole history, roles mapped, every turn', async t => {
  // It remembers nothing: it answers with how many turns it was sent.
  const api = await agent(t, body => ({ reply: { choices: [{ message: { role: 'assistant', content: `Вижу ${body.messages.length}: ${body.messages.map((m: any) => m.role).join(',')}` } }] } }));
  const curl = `curl ${api.url} -H 'Content-Type: application/json' -d '{"model":"support","messages":[{"role":"system","content":"Ты агент поддержки."},{"role":"user","content":"Здравствуйте"}],"stream":false}'`;
  const asked = connectionFromCurl(curl);
  assert.equal(asked.lastTurn, '/messages/1/content', 'the last turn is the customer\'s message: no model is asked');
  const choice = await proposeRequest(asked, { timeoutMs: 1000, signal: new AbortController().signal });
  const made = connectionFromCurl(curl, { message: choice!.message });
  assert.ok(made.kind === 'ready');
  assert.deepEqual(made.history, { at: '/messages', roles: { user: 'user', assistant: 'assistant' }, withMessage: true, fixed: 1 });
  assert.ok(connectionLines(made).includes('Разговор → messages: в каждом запросе вся история разговора, реплики клиента — с ролью user, агента — assistant; инструкции из curl остаются первыми'),
    connectionLines(made).join('\n'));

  const check = await checkTemplate(target(made), '/choices/0/message/content');
  assert.equal(check.passed, true, check.failure);
  assert.deepEqual(check.memory, { claim: 'history', shown: true });
  assert.deepEqual(check.warnings, []);
  const [first, second] = api.requests;
  assert.deepEqual(first.messages.map((m: any) => m.role), ['system', 'user']);
  assert.deepEqual(second.messages.map((m: any) => m.role), ['system', 'user', 'assistant', 'user'], 'the second turn carries the first exchange');
  assert.equal(second.messages[2].content, 'Вижу 2: system,user', 'the agent\'s own first answer, read at its path');
  assert.equal(second.model, 'support');

  // A run's dialogue: the same history every turn, the agent's replies included.
  const session = await openExternalTarget({ target: { ...target(made), request: check.request! }, sessionId: 'trial-h', scenarioId: 's', state: world(),
    history: () => [], ctx: context() });
  assert.equal(await session.respond('Первый вопрос'), 'Вижу 2: system,user');
  await session.close();
});

test('the conversation as earlier turns beside the message: the turns before it go, the new message in its own field', async t => {
  const api = await agent(t, body => ({ reply: { answer: `История: ${body.history.length}` } }));
  const curl = `curl ${api.url} -d '{"message":"Здравствуйте","history":[{"role":"user","content":"Раньше"},{"role":"assistant","content":"Ответ"}]}'`;
  const made = connectionFromCurl(curl, { message: '/message' });
  assert.ok(made.kind === 'ready');
  assert.deepEqual(made.history, { at: '/history', roles: { user: 'user', assistant: 'assistant' }, withMessage: false, fixed: 0 });
  const check = await checkTemplate(target(made), '/answer');
  assert.equal(check.passed, true, check.failure);
  assert.deepEqual(api.requests[0].history, [], 'the curl\'s example turns never go');
  assert.deepEqual(api.requests[1].history.map((m: any) => m.role), ['user', 'assistant']);
  assert.equal(api.requests[1].message, 'Спасибо! А что ещё вы можете подсказать?');
});

test('an agent that names the conversation itself: the empty id of the curl opens it, the id from its reply goes back, a new one each turn fails', async t => {
  // Dify-like: an empty conversation_id opens one; a known id continues it; any other is 404.
  let opened = 0;
  const known = new Set<string>();
  const dify = await agent(t, body => {
    if (body.conversation_id === '') { const id = `conv-${++opened}`; known.add(id); return { reply: { answer: 'Новый разговор.', conversation_id: id } }; }
    return known.has(body.conversation_id) ? { reply: { answer: 'Продолжаю.', conversation_id: body.conversation_id } } : { status: 404, reply: { message: 'Conversation Not Exists.' } };
  });
  const curl = (url: string) => `curl ${url} -d '{"inputs":{},"query":"Здравствуйте","conversation_id":"","user":"lab"}'`;
  const made = connectionFromCurl(curl(dify.url), { message: '/query' });
  assert.ok(made.kind === 'ready');
  assert.deepEqual(made.conversation, ['/conversation_id']);
  assert.ok(connectionLines(made).includes('Разговор → conversation_id: в первом сообщении пусто, как в curl, дальше — идентификатор, который назовёт агент'));
  const check = await checkTemplate(target(made), '/answer');
  assert.equal(check.passed, true, check.failure);
  assert.deepEqual(check.memory, { claim: 'session', shown: true });
  assert.deepEqual(dify.requests.map(request => request.conversation_id), ['', 'conv-1'], 'the id from the first reply goes in the second request');
  assert.deepEqual(check.request?.session, { first: '', reply: '/conversation_id' });

  // The saved template carries it through a run's dialogue too.
  const session = await openExternalTarget({ target: { ...target(made), request: check.request! }, sessionId: 'trial-s', scenarioId: 's', state: world(), history: () => [], ctx: context() });
  assert.equal(await session.respond('Раз'), 'Новый разговор.');
  assert.equal(await session.respond('Два'), 'Продолжаю.');
  await session.close();
  assert.deepEqual(dify.requests.slice(2).map(request => request.conversation_id), ['', 'conv-2']);

  // An agent that opens a new conversation for every message keeps none: never a silent pass.
  let fresh = 0;
  const forgetful = await agent(t, () => ({ reply: { answer: 'Здравствуйте!', conversation_id: `new-${++fresh}` } }));
  const failed = await checkTemplate(target(connectionFromCurl(curl(forgetful.url), { message: '/query' })), '/answer');
  assert.equal(failed.passed, false);
  assert.match(failed.failure ?? '', /открыл новый разговор/);
});

test('an agent that replaces Lab\'s id with its own gets its own back; one that echoes Lab\'s id is shown keeping it', async t => {
  const own = await agent(t, body => ({ reply: { text: 'Ок', sessionId: body.sessionId.startsWith('srv-') ? body.sessionId : 'srv-7' } }));
  const replaced = await checkTemplate(target(connectionFromCurl(`curl ${own.url} -d '{"question":"hi","sessionId":"s-1"}'`, { message: '/question' })), '/text');
  assert.equal(replaced.passed, true, replaced.failure);
  assert.equal(replaced.memory?.claim, 'session');
  assert.notEqual(own.requests[0].sessionId, 's-1');
  assert.equal(own.requests[1].sessionId, 'srv-7');
  assert.deepEqual(replaced.request?.session, { first: '{{conversation}}', reply: '/sessionId' });

  const echo = await agent(t, body => ({ reply: { text: 'Ок', sessionId: body.sessionId } }));
  const kept = await checkTemplate(target(connectionFromCurl(`curl ${echo.url} -d '{"question":"hi","sessionId":"s-1"}'`, { message: '/question' })), '/text');
  assert.deepEqual([kept.passed, kept.memory, kept.warnings], [true, { claim: 'conversation', shown: true }, []]);
});

test('a numbered session stays a number: the same in every turn of a dialogue, another in the next dialogue', async t => {
  const api = await agent(t, () => ({ reply: { text: 'Ок' } }));
  const made = connectionFromCurl(`curl ${api.url} -d '{"session_id":12345,"text":"hi"}'`, { message: '/text' });
  assert.ok(made.kind === 'ready');
  assert.equal(atPointer(target(made).request.body, '/session_id'), '{{conversation:number}}');
  assert.ok(connectionLines(made).includes('Разговор → session_id (новый в каждой ситуации, числом, как в curl)'));
  const withReply = { ...target(made), request: { ...target(made).request, reply: '/text' } };
  for (const id of ['trial-a', 'trial-b']) {
    const session = await openExternalTarget({ target: withReply, sessionId: id, scenarioId: 's', state: world(), history: () => [], ctx: context() });
    await session.respond('Раз'); await session.respond('Два');
    await session.close();
  }
  const ids = api.requests.map(request => request.session_id);
  assert.ok(ids.every(id => typeof id === 'number' && Number.isInteger(id) && id > 0), JSON.stringify(ids));
  assert.equal(ids[0], ids[1]);
  assert.equal(ids[2], ids[3]);
  assert.notEqual(ids[0], ids[2]);
  assert.ok(!ids.includes(12345), 'the curl\'s own session is never reused');
});

test('an answer in several bubbles is read whole; a request that shows no way to keep the conversation is a warning, not a pass in silence', async t => {
  const rasa = await agent(t, () => ({ reply: [{ recipient_id: 'u', text: 'Первое сообщение.' }, { recipient_id: 'u', image: 'https://example.test/i.png' }, { recipient_id: 'u', text: 'Второе сообщение.' }] }));
  const made = connectionFromCurl(`curl ${rasa.url} -d '{"sender":"u-1","message":"hi"}'`, { message: '/message', conversation: ['/sender'] });
  const check = await checkTemplate(target(made), '/0/text');
  assert.equal(check.reply, '/-/text');
  assert.equal(check.turns[0], 'Первое сообщение.\n\nВторое сообщение.'.length);
  const session = await openExternalTarget({ target: { ...target(made), request: check.request! }, sessionId: 'trial-b', scenarioId: 's', state: world(), history: () => [], ctx: context() });
  assert.equal(await session.respond('Здравствуйте'), 'Первое сообщение.\n\nВторое сообщение.');
  await session.close();
  // The customer's own words echoed first are not the agent's.
  const echoing = await agent(t, body => ({ reply: { messages: [{ role: 'user', content: body.q }, { role: 'assistant', content: 'А.' }, { role: 'assistant', content: 'Б.' }] } }));
  const echoed = await checkTemplate(target(connectionFromCurl(`curl ${echoing.url} -d '{"q":"hi","chat_id":"c"}'`, { message: '/q' })), '/messages/1/content');
  assert.equal(echoed.reply, '/messages/-/content');
  assert.equal(echoed.turns[0], 'А.\n\nБ.'.length);

  const stateless = await agent(t, () => ({ reply: { text: 'Ок' } }));
  const unknown = await checkTemplate(target(connectionFromCurl(`curl ${stateless.url} -d '{"q":"hi"}'`, { message: '/q' })), '/text');
  assert.equal(unknown.passed, true);
  assert.deepEqual(unknown.memory, { claim: 'none', shown: false });
  assert.match(unknown.warnings[0] ?? '', /нет ни идентификатора разговора, ни истории сообщений/);
  const silent = await checkTemplate(target(connectionFromCurl(`curl ${stateless.url} -d '{"q":"hi","chat_id":"c-1"}'`, { message: '/q' })), '/text');
  assert.deepEqual(silent.memory, { claim: 'conversation', shown: false });
  assert.match(silent.warnings[0] ?? '', /не называет разговор в ответе/);
});
