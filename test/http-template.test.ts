import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connectionFromCurl, parseCurl, shellWords } from '../src/curl.js';
import { atPointer, MissingReplyText, renderRequest, replyStructure, requestTemplateSchema } from '../src/http-template.js';
import { openExternalTarget, preflightTarget, type TemplateTarget } from '../src/targets.js';
import { checkTemplate, CONNECTION_FORMAT, readConnection, saveConnection } from '../src/connection.js';
import { doctorTemplate } from '../src/cli/connect.js';
import { fingerprint, settingsSchema, targetSchema, type Scenario, type World } from '../src/contracts.js';
import { evaluateTrial } from '../src/evaluation.js';
import type { CallContext } from '../src/runtime.js';

/* An agent in its own envelope (shape only, synthetic): it keeps each conversation by its id and answers in `result.answer.text`. */
const CURL = String.raw`curl -s -X POST 'https://agent.example.test/api/v1/chat' \
  -H 'Content-Type: application/json' \
  -H "Request-Id: $(uuidgen)" \
  -H 'System-Id: lab-fixture' \
  -H "Request-Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "X-Trace: $(trace-id --short)" \
  --data-raw '{"message":{"version":"1.0","performative":"request","sender":"lab","receiver":"agent","conversation_id":"c-1","reply_with":"r-1",
    "content":{"user_input":"Здравствуйте, это \"пример\""}},"metadata":{"channel":"web","dialog":{"dialog_id":"d-1"}}}'`;

async function envelopeAgent(options: { reply?: (turn: number, text: string) => unknown } = {}) {
  const conversations = new Map<string, string[]>();
  const requests: { body: Record<string, any>; headers: IncomingHttpHeaders }[] = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push({ body, headers: req.headers });
      const id = body.message.conversation_id as string;
      const turns = conversations.get(id) ?? [];
      turns.push(body.message.content.user_input);
      conversations.set(id, turns);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(options.reply?.(turns.length, body.message.content.user_input)
        ?? { status: 'ok', result: { answer: { text: `Ход ${turns.length}: ${turns.at(-1)}` }, intent: 'greeting' } }));
    });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/api/v1/chat`, conversations, requests,
    close: () => new Promise<void>(r => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

function templateTarget(url: string, reply: string | null = '/result/answer/text'): TemplateTarget {
  const made = connectionFromCurl(CURL, { message: '/message/content/user_input' });
  assert.equal(made.kind, 'ready');
  const target = made.kind === 'ready' ? made.target : undefined;
  assert.ok(target?.kind === 'http' && target.request);
  return { ...target, url, headersEnv: {}, request: { ...target.request, ...(reply !== null ? { reply } : {}) } };
}
const context = (): CallContext => ({ signal: new AbortController().signal, timeoutMs: 5000, beforeCall() {}, addUsage() {} });
const world = (): World => ({ records: {}, writableFields: [], transientFailures: 0 });

test('a curl command line keeps its quoting, headers and body; substitutions become placeholders by the name they stand under', () => {
  const words = shellWords(String.raw`curl 'a b' "c \"d\" $X" e\ f $'g\nh' "$(date +"%s")"`);
  assert.deepEqual(words.map(word => word.map(part => part.kind === 'text' ? part.value : part.kind === 'variable' ? `[$${part.name}]` : `[${part.value}]`).join('')),
    ['curl', 'a b', 'c "d" [$X]', 'e f', 'g\nh', '[$(date +"%s")]']);
  const request = parseCurl(CURL);
  assert.equal(request.url, 'https://agent.example.test/api/v1/chat');
  assert.deepEqual(request.headers.map(header => header.name), ['Content-Type', 'Request-Id', 'System-Id', 'Request-Time', 'Authorization', 'X-Trace']);

  const asked = connectionFromCurl(CURL);
  assert.equal(asked.kind, 'ask_message');
  assert.ok(asked.kind === 'ask_message' && asked.fields.some(field => field.pointer === '/message/content/user_input'));

  const made = connectionFromCurl(CURL, { message: '/message/content/user_input' });
  assert.ok(made.kind === 'ready' && made.target.kind === 'http' && made.target.request);
  const { request: template, headersEnv } = made.target;
  assert.deepEqual(template.headers, { 'Content-Type': 'application/json', 'Request-Id': '{{uuid}}', 'System-Id': 'lab-fixture', 'Request-Time': '{{now}}', 'X-Trace': '$(trace-id --short)' });
  // The secret never reaches the file: its header names a variable read at request time.
  assert.deepEqual(headersEnv, { Authorization: 'AGENT_LAB_AUTHORIZATION' });
  assert.ok(!JSON.stringify(made.target).includes('AGENT_TOKEN'));
  assert.equal(atPointer(template.body, '/message/content/user_input'), '{{message}}');
  assert.equal(atPointer(template.body, '/message/conversation_id'), '{{conversation}}');
  assert.equal(atPointer(template.body, '/metadata/dialog/dialog_id'), '{{conversation}}');
  assert.equal(atPointer(template.body, '/message/reply_with'), 'r-1');
  assert.ok(made.warnings.some(warning => warning.includes('AGENT_LAB_AUTHORIZATION')));
  assert.ok(made.warnings.some(warning => warning.includes('X-Trace')));
  assert.equal(template.reply, undefined);

  // A variable outside a secret header becomes {{env:NAME}}; the owner may name the conversation field himself.
  const own = connectionFromCurl(`curl https://agent.example.test/x -H "System-Id: $SYSTEM_ID" -d '{"q":"hi","thread":"t-1"}'`, { message: '/q', conversation: ['/thread'] });
  assert.ok(own.kind === 'ready' && own.target.kind === 'http');
  assert.deepEqual(own.target.request?.headers, { 'System-Id': '{{env:SYSTEM_ID}}' });
  assert.equal(atPointer(own.target.request?.body, '/thread'), '{{conversation}}');

  assert.throws(() => connectionFromCurl(`curl -X GET https://agent.example.test/x -d '{"q":"hi"}'`, { message: '/q' }), /POST/);
  assert.throws(() => connectionFromCurl(`curl https://agent.example.test/x -d @body.json`, { message: '/q' }), /из файла/);
  assert.throws(() => connectionFromCurl(`curl https://agent.example.test/x -d '{"q":"hi"}'`, { message: '/missing' }), /нет строкового поля \/missing/);
  assert.throws(() => parseCurl(`curl 'unterminated`), /не закрыта одинарная кавычка/);
});

test('a template renders every placeholder, whole-string and inline; unknown ones and a template without the message are refused', () => {
  const previous = process.env.AGENT_LAB_TEMPLATE_TEST;
  process.env.AGENT_LAB_TEMPLATE_TEST = 'sys-7';
  try {
    const template = requestTemplateSchema.parse({ body: { text: '{{message}}', meta: { id: '{{conversation}}', note: 'conv={{conversation}}; req={{uuid}}', at: '{{now}}', system: '{{env:AGENT_LAB_TEMPLATE_TEST}}' }, n: 3 },
      headers: { 'Request-Id': '{{uuid}}' } });
    const one = renderRequest(template, { message: 'Привет', conversation: 'c-42' });
    const two = renderRequest(template, { message: 'Ещё', conversation: 'c-42' });
    const body = one.body as { text: string; meta: Record<string, string>; n: number };
    assert.equal(body.text, 'Привет');
    assert.equal(body.meta.id, 'c-42');
    assert.equal(body.meta.note, `conv=c-42; req=${one.headers['Request-Id']}`, 'one uuid per request, the same in body and headers');
    assert.equal(body.meta.system, 'sys-7');
    assert.equal(body.n, 3);
    assert.ok(!Number.isNaN(Date.parse(body.meta.at!)));
    assert.notEqual(one.headers['Request-Id'], two.headers['Request-Id']);
  } finally { if (previous === undefined) delete process.env.AGENT_LAB_TEMPLATE_TEST; else process.env.AGENT_LAB_TEMPLATE_TEST = previous; }
  assert.throws(() => renderRequest(requestTemplateSchema.parse({ body: { text: '{{message}} {{env:AGENT_LAB_UNSET_FOR_TEST}}' } }), { message: 'x', conversation: 'c' }), /AGENT_LAB_UNSET_FOR_TEST/);
  assert.equal(requestTemplateSchema.safeParse({ body: { text: '{{message}} {{user}}' } }).success, false);
  assert.equal(requestTemplateSchema.safeParse({ body: { text: 'static' } }).success, false);
  assert.equal(targetSchema.safeParse({ kind: 'http', url: 'https://agent.example.test', request: { body: { q: '{{message}}' } }, promptFile: '/prompt.md' }).success, false);
});

test('an agent in its own envelope: one conversation keeps its id, a new dialogue gets a new one, the text is read by pointer', async t => {
  const api = await envelopeAgent(); t.after(api.close);
  const target = templateTarget(api.url);
  const session = await openExternalTarget({ target, sessionId: 'trial-1', scenarioId: 's', state: world(), history: () => [], ctx: context() });
  assert.equal(await session.respond('Добрый день'), 'Ход 1: Добрый день');
  assert.equal(await session.respond('А ещё?'), 'Ход 2: А ещё?');
  await session.close();
  const fresh = await openExternalTarget({ target, sessionId: 'trial-2', scenarioId: 's', state: world(), history: () => [], ctx: context() });
  assert.equal(await fresh.respond('Снова здравствуйте'), 'Ход 1: Снова здравствуйте');
  await fresh.close();
  const [first, second, third] = api.requests;
  assert.equal(first!.body.message.conversation_id, 'trial-1');
  assert.equal(first!.body.metadata.dialog.dialog_id, 'trial-1');
  assert.equal(second!.body.message.conversation_id, 'trial-1');
  assert.equal(third!.body.message.conversation_id, 'trial-2');
  // Only the new message goes out: the agent keeps its own history.
  assert.equal(second!.body.message.content.user_input, 'А ещё?');
  assert.equal(second!.body.messages, undefined);
  assert.equal(second!.body.metadata.channel, 'web');
  assert.notEqual(first!.headers['request-id'], second!.headers['request-id']);
  assert.equal(first!.headers['system-id'], 'lab-fixture');
  assert.ok(!Number.isNaN(Date.parse(String(first!.headers['request-time']))));
  assert.equal(first!.headers['content-type'], 'application/json');
});

test('a reply without text at the pointer is a typed failure; the dialogue is not measured and the agent is named', async t => {
  const api = await envelopeAgent({ reply: () => ({ status: 'ok', result: { answer: { blocks: ['x'] } } }) }); t.after(api.close);
  const target = templateTarget(api.url);
  const session = await openExternalTarget({ target, sessionId: 'trial-x', scenarioId: 's', state: world(), history: () => [], ctx: context() });
  await assert.rejects(session.respond('Здравствуйте'), (error: unknown) => error instanceof MissingReplyText && error.message.includes('/result/answer/text'));
  await session.close();
  const scenario: Scenario = { id: 'one', familyId: 'one', split: 'dev', title: 'Одно сообщение', tier: 'smoke', provenance: 'curated', requirementIds: [],
    user: { goal: 'Спросить', facts: 'Нет', behavior: 'Одно сообщение', opening: 'Здравствуйте', maxFollowUps: 0 }, initialState: world(), checks: [] };
  const spec = { name: 'fixture', instructions: 'External.', tools: [] };
  const trial = await evaluateTrial({ runtime: {}, revision: { id: fingerprint(spec), spec, parentId: null, hypothesis: 'fixture', createdAt: new Date().toISOString() },
    scenario, sources: [], requirements: [], repeat: 0, manifestHash: fingerprint(scenario), userMode: 'static', target,
    settings: settingsSchema.parse({ repeats: 1, maxTurns: 2, maxCalls: 5, userModes: ['static'], maxDurationMs: 60000 }), ctx: context() });
  assert.equal(trial.outcome, 'invalid');
  assert.equal(trial.invalidCause, 'agent');
  assert.match(trial.reason, /В ответе агента нет текста по пути \/result\/answer\/text/);
});

test('a template dialogue is judged on replies only; a target without the text path is not runnable yet', async t => {
  const api = await envelopeAgent(); t.after(api.close);
  const scenario: Scenario = { id: 'one', familyId: 'one', split: 'dev', title: 'Одно сообщение', tier: 'smoke', provenance: 'curated', requirementIds: [],
    user: { goal: 'Спросить', facts: 'Нет', behavior: 'Одно сообщение', opening: 'Здравствуйте', maxFollowUps: 0 }, initialState: world(), checks: [] };
  const spec = { name: 'fixture', instructions: 'External.', tools: [] };
  const trial = await evaluateTrial({ runtime: {}, revision: { id: fingerprint(spec), spec, parentId: null, hypothesis: 'fixture', createdAt: new Date().toISOString() },
    scenario, sources: [], requirements: [], repeat: 0, manifestHash: fingerprint(scenario), userMode: 'static', target: templateTarget(api.url),
    settings: settingsSchema.parse({ repeats: 1, maxTurns: 2, maxCalls: 5, userModes: ['static'], maxDurationMs: 60000 }), ctx: context() });
  assert.equal(trial.outcome, 'ungraded');
  assert.equal(trial.observation?.tools, 'partial');
  assert.equal(trial.observation?.resetConfirmed, undefined);
  assert.equal(trial.events.find(event => event.type === 'assistant')?.text, 'Ход 1: Здравствуйте');
  await assert.rejects(preflightTarget(templateTarget(api.url, null)), /не выбран путь к тексту ответа/);
});

test('the connection check shows the reply structure without values, then saves the chosen text path', async t => {
  const api = await envelopeAgent({ reply: turn => ({ status: 'ok', result: { answer: { text: turn === 1 ? 'Секретный ответ агента' : 'Второй' } }, trace: ['a1'] }) });
  t.after(api.close);
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-template-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const unset = templateTarget(api.url, null);
  const check = await checkTemplate(unset, undefined);
  assert.deepEqual(check.structure, [{ pointer: '/status', length: 2 }, { pointer: '/result/answer/text', length: 22 }, { pointer: '/trace/0', length: 2 }]);
  assert.equal(check.passed, false);
  assert.ok(!JSON.stringify(check).includes('Секретный'));
  assert.deepEqual(replyStructure({ a: [{ b: 'xyz' }], 'c/d': 'q' }), [{ pointer: '/a/0/b', length: 3 }, { pointer: '/c~1d', length: 1 }]);

  const file = join(directory, 'connection.json');
  await saveConnection(file, { format: CONNECTION_FORMAT, target: unset }, false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(saveConnection(file, { format: CONNECTION_FORMAT, target: unset }, false), /EEXIST/);
  const printed: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { printed.push(String(chunk)); return true; }) as typeof process.stdout.write;
  const exitCode = process.exitCode;
  try {
    const connection = await readConnection(file);
    await doctorTemplate({ connection, target: unset, file, directory, yes: true });
    assert.equal(process.exitCode, 2);
    process.exitCode = exitCode;
    await doctorTemplate({ connection, target: unset, file, directory, yes: true, reply: '/result/answer/text' });
  } finally { process.stdout.write = write; process.exitCode = exitCode; }
  const output = printed.join('');
  assert.match(output, /\/result\/answer\/text · 22 символа/);
  assert.ok(!output.includes('Секретный'), 'the structure never shows a value');
  assert.match(output, /Подключение готово/);
  const saved = await readConnection(file);
  assert.ok(saved.target.kind === 'http' && saved.target.request?.reply === '/result/answer/text');
  assert.ok(JSON.parse(await readFile(join(directory, 'connection.local.json'), 'utf8')).target.request.reply === '/result/answer/text');
  // Two turns of one conversation after the path was chosen, one before: the same id within each check.
  assert.equal(api.requests.length, 1 + 1 + 2);
  assert.equal(api.requests[2]!.body.message.conversation_id, api.requests[3]!.body.message.conversation_id);
});

test('an http target without a template is unchanged: same shape, same fingerprint, Lab\'s own contract', async t => {
  const old = { kind: 'http', url: 'https://agent.example.test/agent', headersEnv: {}, timeoutMs: 60000 };
  const parsed = targetSchema.parse(old);
  assert.deepEqual(parsed, old);
  assert.equal(fingerprint(parsed), fingerprint(old));
  const requests: Record<string, unknown>[] = [];
  const srv = createServer((req, res) => { let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => { requests.push(JSON.parse(raw)); res.end(JSON.stringify({ reply: 'ok' })); }); });
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  t.after(() => new Promise<void>(r => { srv.closeAllConnections(); srv.close(() => r()); }));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/agent`;
  const session = await openExternalTarget({ target: { kind: 'http', url, headersEnv: {}, timeoutMs: 5000 }, sessionId: 'x', scenarioId: 's', state: world(), history: () => [{ role: 'user', content: 'hi' }], ctx: context() });
  assert.equal(await session.respond('hi'), 'ok');
  assert.deepEqual(Object.keys(requests[0]!).sort(), ['initialState', 'message', 'messages', 'scenarioId', 'sessionId']);
  await session.close();
});
