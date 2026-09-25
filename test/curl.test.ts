import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectionLines, proposeRequest, type ConnectionReader, type RequestField } from '../src/connect.js';
import { connectionFromCurl, parseCurl } from '../src/curl.js';
import * as template from '../src/http-template.js';
import { atPointer, renderAddress, renderRequest, requestTemplateSchema } from '../src/http-template.js';
import { connectFromCurl } from '../src/cli/connect.js';

/*
 * The owner's curl → a connection that keeps no secret: every header but the plainly harmless ones is read from the
 * environment — the owner's own $NAME as it is, a named AGENT_LAB_… variable where the curl holds the value — and so
 * are query values and body fields named like a key; the confirmation lists every header and how it is kept. A
 * substitution keeps its command's format; curls from Windows cmd or with a pipe after them read as the request.
 */

const ready = (source: string, message: string) => {
  const made = connectionFromCurl(source, { message });
  assert.ok(made.target.kind === 'http' && made.target.request);
  return { made, target: made.target, request: made.target.request };
};

test('any header but the plainly harmless ones is a secret: its value stays out of the file, and the confirmation says how each header is kept', () => {
  const { made, target, request } = ready(String.raw`curl https://agent.example.test/chat \
    -H 'Content-Type: application/json' -H 'Accept-Language: ru' -H 'Ocp-Apim-Subscription-Key: apim-secret-1' -H 'X-Auth: xauth-secret-2' \
    -H "Authorization: Bearer $MY_TOKEN" -H "X-Api-Key: ${'$'}{API_KEY}" -d '{"q":"Здравствуйте"}'`, '/q');
  assert.deepEqual(target.headersEnv, { 'Ocp-Apim-Subscription-Key': 'AGENT_LAB_OCP_APIM_SUBSCRIPTION_KEY', 'X-Auth': 'AGENT_LAB_X_AUTH', 'X-Api-Key': 'API_KEY' });
  // The owner's own variable is referenced as it is: nothing new to set, no restart where it is already set.
  assert.deepEqual(request.headers, { 'Content-Type': 'application/json', 'Accept-Language': 'ru', Authorization: 'Bearer {{env:MY_TOKEN}}' });
  const saved = JSON.stringify(target);
  for (const value of ['apim-secret-1', 'xauth-secret-2']) assert.ok(!saved.includes(value), value);
  const lines = connectionLines(made);
  for (const line of [
    'Заголовок Content-Type: application/json',
    'Заголовок Accept-Language: ru',
    'Заголовок Authorization: Bearer $MY_TOKEN — из переменной окружения MY_TOKEN, в файле только её имя',
    'Заголовок Ocp-Apim-Subscription-Key — секрет из curl: в файл не пишется, Lab прочтёт его из переменной AGENT_LAB_OCP_APIM_SUBSCRIPTION_KEY',
    'Заголовок X-Auth — секрет из curl: в файл не пишется, Lab прочтёт его из переменной AGENT_LAB_X_AUTH',
    'Заголовок X-Api-Key → из переменной окружения API_KEY, в файле только её имя',
  ]) assert.ok(lines.includes(line), `${line}\n---\n${lines.join('\n')}`);
  assert.ok(!lines.join('\n').includes('apim-secret-1'));
});

test('a login in the address is refused with its reason; a key in the query and a key in the body are read from the environment', () => {
  assert.throws(() => connectionFromCurl(`curl https://user:pass@agent.example.test/chat -d '{"q":"hi"}'`, { message: '/q' }),
    /Логин и пароль в адресе агента Lab не переносит: fetch такой адрес не принимает/);
  const { made, target, request } = ready(`curl "https://agent.example.test/chat?api_key=query-secret-3&lang=ru&key=$GOOGLE_KEY#top" -d '{"api_key":"body-secret-4","q":"hi"}'`, '/q');
  assert.equal(target.url, 'https://agent.example.test/chat?api_key={{env:AGENT_LAB_API_KEY}}&lang=ru&key={{env:GOOGLE_KEY}}');
  // One value in two places is one variable; different values would be two.
  assert.equal(atPointer(request.body, '/api_key'), '{{env:AGENT_LAB_API_KEY_2}}');
  const saved = JSON.stringify(target);
  for (const value of ['query-secret-3', 'body-secret-4', '#top']) assert.ok(!saved.includes(value), value);
  const lines = connectionLines(made);
  assert.equal(lines[0], 'Адрес: https://agent.example.test/chat?api_key=$AGENT_LAB_API_KEY&lang=ru&key=$GOOGLE_KEY');
  assert.ok(lines.includes('Параметр адреса api_key — секрет из curl: в файл не пишется, Lab прочтёт его из переменной AGENT_LAB_API_KEY'), lines.join('\n'));
  assert.ok(lines.includes('Поле api_key — секрет из curl: в файл не пишется, Lab прочтёт его из переменной AGENT_LAB_API_KEY_2'), lines.join('\n'));
  // The address is rendered at request time, the values encoded for the query.
  const previous = { a: process.env.AGENT_LAB_API_KEY, g: process.env.GOOGLE_KEY };
  process.env.AGENT_LAB_API_KEY = 'a b&c'; process.env.GOOGLE_KEY = 'g/1';
  try { assert.equal(renderAddress(target.url), 'https://agent.example.test/chat?api_key=a%20b%26c&lang=ru&key=g%2F1'); }
  finally {
    if (previous.a === undefined) delete process.env.AGENT_LAB_API_KEY; else process.env.AGENT_LAB_API_KEY = previous.a;
    if (previous.g === undefined) delete process.env.GOOGLE_KEY; else process.env.GOOGLE_KEY = previous.g;
  }
  assert.throws(() => connectionFromCurl(`curl "$AGENT_URL/chat" -d '{"q":"hi"}'`, { message: '/q' }), /Адрес агента в curl собран из переменной/);
});

test('the builder model reads the owner\'s example request with its secrets already placeholders', async () => {
  const asked = connectionFromCurl(`curl https://agent.example.test/chat -H 'X-Tenant: tenant-secret-5' -d '{"token":"body-secret-6","q":"Здравствуйте","channel":"web"}'`);
  let seen: readonly RequestField[] = [];
  const reader = { builder: {} as ConnectionReader['builder'],
    async request(input: { fields: readonly RequestField[]; candidates: readonly string[] }) { seen = input.fields; return { message: '/q', conversation: [], reason: 'Слова клиента.' }; },
    async reply() { throw new Error('not asked'); } } as ConnectionReader;
  const choice = await proposeRequest(asked, { reader, timeoutMs: 1000, signal: new AbortController().signal });
  assert.equal(choice?.message, '/q');
  const text = JSON.stringify(seen);
  assert.ok(seen.some(field => field.pointer === '/token' && field.value === '{{env:AGENT_LAB_TOKEN}}'), text);
  for (const value of ['body-secret-6', 'tenant-secret-5']) assert.ok(!text.includes(value), value);
});

test('a substitution keeps the format of its command: seconds stay seconds, an id without dashes stays without them', () => {
  const { made, request } = ready(String.raw`curl https://agent.example.test/chat -H "X-Ts: $(date +%s)" -H "X-Ms: $(date +%s%3N)" \
    -H "X-Request-Id: $(uuidgen | tr -d '-')" -H "X-Trace-Id: $(uuidgen)" -H "X-Day: $(date -u +%F)" -d '{"q":"hi"}'`, '/q');
  assert.deepEqual(request.headers, { 'X-Ts': '{{now:%s}}', 'X-Ms': '{{now:%s%3N}}', 'X-Request-Id': '{{uuid:hex}}', 'X-Trace-Id': '{{uuid}}', 'X-Day': '{{now:utc:%F}}' });
  assert.deepEqual(made.warnings, []);
  const before = Math.floor(Date.now() / 1000);
  const { headers } = renderRequest(request, { message: 'hi', conversation: 'c' });
  const seconds = Number(headers['X-Ts']);
  assert.ok(Number.isInteger(seconds) && seconds >= before && seconds <= before + 5, headers['X-Ts']);
  assert.equal(headers['X-Ms']!.length, 13);
  assert.equal(headers['X-Ms']!.slice(0, 10), headers['X-Ts']);
  assert.equal(headers['X-Request-Id']!.length, 32);
  assert.ok(!headers['X-Request-Id']!.includes('-'));
  assert.equal(headers['X-Trace-Id']!.replaceAll('-', ''), headers['X-Request-Id'], 'one id per request, in each place in its own format');
  assert.equal(headers['X-Day'], new Date().toISOString().slice(0, 10));
  // A command Lab does not know keeps the name's meaning, and says the format may differ.
  const unknown = ready(`curl https://agent.example.test/chat -H "Request-Time: $(gdate --rfc-3339=seconds)" -d '{"q":"hi"}'`, '/q');
  assert.equal(unknown.request.headers['Request-Time'], '{{now}}');
  assert.match(unknown.made.warnings[0] ?? '', /формат времени из \$\(gdate --rfc-3339=seconds\) Lab не распознал/);
  assert.equal(requestTemplateSchema.safeParse({ body: { q: '{{message}}', at: '{{now:%a %b}}' } }).success, false, 'a directive Lab does not render is refused');
});

test('a curl copied from Windows cmd or with a pipe after it reads as the request, and a wrong address is named in Russian', () => {
  const cmd = 'curl ^"http://localhost:8080/api/chat?x=1^&y=2^" ^\r\n  -H ^"content-type: application/json^" ^\r\n  --data-raw ^"^{^\\^"message^\\^":^\\^"Здравствуйте^\\^",^\\^"session_id^\\^":^\\^"s-1^\\^"^}^"\r\n';
  const fromCmd = connectionFromCurl(cmd, { message: '/message' });
  assert.ok(fromCmd.target.kind === 'http' && fromCmd.target.request);
  assert.equal(fromCmd.target.url, 'http://localhost:8080/api/chat?x=1&y=2');
  assert.deepEqual(fromCmd.target.request.body, { message: '{{message}}', session_id: '{{conversation}}' });
  const handwritten = parseCurl('curl -X POST "http://localhost:8080/chat" ^\n -H "Content-Type: application/json" ^\n -d "{\\"q\\": \\"%USERNAME% hi\\"}"');
  assert.equal(handwritten.url, 'http://localhost:8080/chat');
  assert.deepEqual(handwritten.data.map(part => part.kind === 'variable' ? `%${part.name}%` : part.kind === 'text' ? part.value : ''), ['{"q": "', '%USERNAME%', ' hi"}']);

  const piped = parseCurl(`curl -s https://agent.example.test/chat -d '{"q":"hi"}' | jq .`);
  assert.equal(piped.url, 'https://agent.example.test/chat');
  assert.match(piped.warnings[0] ?? '', /Часть команды после «\|» Lab не выполняет/);
  // Without a scheme curl means http, and so does Lab.
  assert.equal(ready(`curl localhost:8080/chat -d '{"q":"hi"}'`, '/q').target.url, 'http://localhost:8080/chat');
  assert.throws(() => parseCurl(`curl https://a.example.test/x https://b.example.test/y -d '{"q":"hi"}'`), /несколько адресов/);
  assert.throws(() => connectionFromCurl(`curl ftp://agent.example.test/x -d '{"q":"hi"}'`, { message: '/q' }), /не похож на адрес вида https/);
});

test('one confirmation for the chat and the command line: an id Lab fills per dialogue is never also said to be new per request', async t => {
  const source = String.raw`curl https://agent.example.test/chat -H 'Content-Type: application/json' -d "{\"sessionId\": \"$(uuidgen)\", \"q\": \"hi\"}"`;
  const made = connectionFromCurl(source, { message: '/q' });
  const folder = await mkdtemp(join(tmpdir(), 'agent-lab-curl-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const input = join(folder, 'request.txt');
  await writeFile(input, source);
  const printed: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { printed.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { await connectFromCurl({ curl: input, message: '/q' }); }
  finally { process.stdout.write = write; }
  const output = printed.join('');
  assert.ok(output.startsWith(connectionLines(made).join('\n')), output);
  assert.match(output, /Разговор → sessionId \(новый в каждой ситуации\)/);
  assert.doesNotMatch(output, /sessionId[^\n]*при каждом запросе/, 'the conversation id is not a per-request id as well');
});

test('one JSON pointer decoder, no invisible characters in the parser, no typed error nobody catches', async () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith('.ts'));
  const decoders = [];
  for (const file of files) {
    const text = await readFile(join(root, file), 'utf8');
    if (text.includes(".replaceAll('~1', '/')")) decoders.push(file);
  }
  assert.deepEqual(decoders, ['http-template.ts']);
  const parser = await readFile(join(root, 'curl.ts'), 'utf8');
  assert.ok(![...parser].some(char => char >= '\uE000' && char <= '\uF8FF'), 'private-use characters are written as escapes');
  assert.equal('MissingReplyText' in template, false);
});
