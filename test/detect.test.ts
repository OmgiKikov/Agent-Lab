import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectionLines, detectProject, envFileNames, evidenceText, targetLabel } from '../src/detect.js';
import { xlsxFile } from './helpers/xlsx.js';

/** A temporary project folder with the given files; removed after the test. */
async function project(t: TestContext, files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'detect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return root;
}
const dialogue = (id: string, text = 'Здравствуйте, верните деньги за заказ') =>
  ({ id, messages: [{ role: 'user', content: text }, { role: 'assistant', content: 'Проверю заказ.' }] });
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const exists = (file: string) => access(file).then(() => true, () => false);

const PYTHON_AGENT = [
  'import json',
  'import sys',
  '',
  'open("ran.txt", "w").write("ran")  # appears only if something runs this file',
  '',
  'for line in sys.stdin:',
  '    request = json.loads(line)',
  '    if request.get("type") == "close":',
  '        break',
  '    state = request["initialState"]',
  '    sys.stdout.write(json.dumps({"reply": "Проверю заказ.", "sessionId": request.get("sessionId")}) + "\\n")',
  '',
].join('\n');
const FACTORY_MODULE = "import { writeFileSync } from 'node:fs';\nwriteFileSync('ran.txt', 'ran');\nexport function createSession() { return { respond: async () => 'ok' }; }\n";

/** A support bot the way an owner keeps it: start script, Python agent, logs, a knowledge folder, a prompt, secrets in .env. */
async function supportBot(t: TestContext): Promise<string> {
  const root = await project(t, {
    'package.json': JSON.stringify({ name: 'support-bot', scripts: { start: 'python agent.py', test: 'pytest', build: 'tsc && node dist/x.js' } }),
    'agent.py': PYTHON_AGENT,
    'README.md': '# Support bot\n',
    '.env': 'OPENAI_API_KEY=sk-live-secret\nexport BOT_TOKEN="tg-secret"\n# COMMENTED=x\n\nnot a variable\n',
    'config.yaml': 'agent:\n  url: "http://user:pw@localhost:8080/chat?token=abc#top"\n  public: https://example.com/api\n',
    'logs/support.jsonl': jsonl([dialogue('d1'), dialogue('d2'), dialogue('d3'), { id: 'bad id!', messages: [] }]),
    'data/export.json': JSON.stringify({ formatVersion: 1, dialogues: [{ id: 'e1', events: [{ type: 'message', role: 'user', content: 'Где мой возврат?' }] }] }),
    'data/settings.json': JSON.stringify({ theme: 'dark', retries: 3 }),
    'docs/kb/refund.md': '# Возврат\nВозврат оформляется за 30 дней.\n',
    'docs/kb/tariffs.md': '# Тарифы\nКомиссия зависит от оборота.\n',
    'docs/intro.txt': 'Как устроена поддержка.\n',
    'knowledge/faq.docx': 'not really a docx; detection counts documents without opening them',
    'prompts/system.md': 'Ты — агент поддержки.\n',
    // Never part of the proposal: dependencies, builds, tests, Lab's private data.
    'node_modules/pkg/index.mjs': FACTORY_MODULE,
    'dist/agent.mjs': FACTORY_MODULE,
    'tests/fixture.mjs': FACTORY_MODULE,
    '.agent-lab/runs.jsonl': jsonl([dialogue('private1')]),
    '.context/bank.jsonl': jsonl([dialogue('private2')]),
  });
  // A link out of the folder is not followed, whatever it points to.
  const outside = await project(t, { 'adapter.mjs': FACTORY_MODULE, 'logs.jsonl': jsonl([dialogue('outside')]) });
  await symlink(outside, join(root, 'outside'));
  return root;
}

test('detectProject proposes the start script\'s agent, the logs, the knowledge folders and the prompt — reading only, never running', async t => {
  const root = await supportBot(t);
  const before = (await readdir(root, { recursive: true })).sort();
  const detection = await detectProject(root);

  assert.equal(detection.root, root);
  assert.deepEqual(detection.agents.map(agent => ({ target: agent.target, confidence: agent.confidence, evidence: agent.evidence })), [
    { target: { kind: 'command', command: 'python', args: ['agent.py'], cwd: root, timeoutMs: 60000 }, confidence: 'high', evidence: [
      { kind: 'script', file: 'package.json', name: 'start', command: 'python agent.py' },
      { kind: 'json_lines', file: 'agent.py' }, { kind: 'protocol_fields', file: 'agent.py' }] },
    // Credentials, query and fragment of a configured address never leave the file.
    { target: { kind: 'http', url: 'http://localhost:8080/chat', headersEnv: {}, timeoutMs: 60000 }, confidence: 'low',
      evidence: [{ kind: 'url', file: 'config.yaml', url: 'http://localhost:8080/chat' }] },
  ]);
  assert.deepEqual(detection.logs, [
    { file: join('logs', 'support.jsonl'), dialogues: 3, rejected: 1, complete: true },
    { file: join('data', 'export.json'), dialogues: 1, rejected: 0, complete: true },
  ]);
  assert.deepEqual(detection.materials, [{ folder: 'docs', documents: 3 }, { folder: 'knowledge', documents: 1 }]);
  assert.deepEqual(detection.prompts, [{ id: join('prompts', 'system.md'), file: join('prompts', 'system.md'), origin: 'file', chars: 21, text: 'Ты — агент поддержки.' }]);
  assert.deepEqual(detection.env, { files: ['.env'], names: ['BOT_TOKEN', 'OPENAI_API_KEY'] });
  assert.equal(detection.truncated, false);

  const serialized = JSON.stringify(detection) + detectionLines(detection).join('\n');
  for (const secret of ['sk-live-secret', 'tg-secret', 'user:pw', 'token=abc', '#top']) assert.ok(!serialized.includes(secret), secret);
  assert.equal(await exists(join(root, 'ran.txt')), false);
  assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
});

test('a saved connection is proposed once, together with what the file it starts shows; a module is found by its createSession export', async t => {
  const root = await project(t, {
    'connection.json': JSON.stringify({ format: 'agent-lab-connection-1', target: { kind: 'command', command: 'python3', args: ['bot/agent.py'], cwd: '.' } }),
    'bot/agent.py': PYTHON_AGENT,
    'lab/adapter.mjs': 'export async function createSession({ initialState }) {\n  return { async respond(message) { return { reply: message, records: initialState.records }; } };\n}\n',
    'lab/notes.mjs': "// export function createSession() {}\nexport const help = 'export function createSession() {}';\n",
  });
  const { agents } = await detectProject(root);
  assert.deepEqual(agents.map(agent => [agent.target, agent.confidence, agent.evidence.map(item => item.kind)]), [
    [{ kind: 'command', command: 'python3', args: ['bot/agent.py'], cwd: root, timeoutMs: 60000 }, 'high', ['connection', 'json_lines', 'protocol_fields']],
    [{ kind: 'module', path: join(root, 'lab', 'adapter.mjs'), exportName: 'createSession' }, 'high', ['factory', 'protocol_fields']],
  ]);
});

test('a Python agent is started with the project\'s own environment when the project keeps one; nothing is run to find it', async t => {
  const root = await project(t, {
    'package.json': JSON.stringify({ scripts: { start: 'python agent.py' } }),
    'agent.py': PYTHON_AGENT,
    'local/lab_target.py': PYTHON_AGENT,
    // The interpreter itself is only looked at: a file that would say «ran» if anything executed it.
    '.venv/bin/python': '#!/bin/sh\necho ran > ran.txt\n',
  });
  const detection = await detectProject(root);
  const python = join(root, '.venv', 'bin', 'python');
  assert.deepEqual(detection.agents.map(agent => [agent.target.kind === 'command' && [agent.target.command, ...agent.target.args], agent.confidence]), [
    [[python, 'agent.py'], 'high'], [[python, join('local', 'lab_target.py')], 'high']]);
  assert.deepEqual(detection.agents[0]!.evidence, [{ kind: 'script', file: 'package.json', name: 'start', command: 'python agent.py' },
    { kind: 'json_lines', file: 'agent.py' }, { kind: 'protocol_fields', file: 'agent.py' }, { kind: 'interpreter', file: '.venv/bin/python' }]);
  assert.equal(evidenceText(detection.agents[0]!.evidence[3]!), '.venv/bin/python: окружение Python проекта — агент запустится с его пакетами');
  // How the owner recognises it: the files from the project, never a chain of «../».
  assert.equal(targetLabel(detection.agents[0]!.target, root), '.venv/bin/python agent.py');
  assert.equal(targetLabel({ kind: 'module', path: '/elsewhere/agent.mjs', exportName: 'createSession' }, root), 'модуль /elsewhere/agent.mjs');
  assert.equal(targetLabel({ kind: 'module', path: '/elsewhere/agent.mjs', exportName: 'createSession' }, '/'), 'модуль /elsewhere/agent.mjs', 'the filesystem root is no project folder');
  assert.equal(await exists(join(root, 'ran.txt')), false);
});

test('a start script is offered even when its file shows no protocol, with low confidence; tools and shell chains are not agents', async t => {
  const root = await project(t, {
    'package.json': JSON.stringify({ scripts: { lint: 'node scripts/lint.js', start: 'node server.js', dev: 'tsx watch src/index.ts', ci: 'npm run build && node agent.js' } }),
    'server.js': "import { createServer } from 'node:http';\ncreateServer((request, response) => response.end('ok')).listen(3000);\n",
    'scripts/lint.js': "console.log('lint');\n",
  });
  const { agents } = await detectProject(root);
  assert.deepEqual(agents.map(agent => [agent.target, agent.confidence]), [[{ kind: 'command', command: 'node', args: ['server.js'], cwd: root, timeoutMs: 60000 }, 'low']]);
  assert.equal(evidenceText(agents[0]!.evidence[0]!), 'package.json: scripts.start = node server.js');
});

test('a log longer than one import is counted batch by batch; a file too big to import is counted from its beginning, as a lower bound', async t => {
  // Equal-length rows, so the beginning of the big file holds an exact number of whole lines.
  const row = (i: number) => dialogue(`d${String(i).padStart(5, '0')}`, `Question ${'x'.repeat(4000)}`);
  const lineBytes = Buffer.byteLength(JSON.stringify(row(0))) + 1;
  const root = await project(t, {
    'logs/many.jsonl': jsonl(Array.from({ length: 350 }, (_, i) => row(i))),
    'logs/huge.jsonl': jsonl(Array.from({ length: Math.ceil(4_100_000 / lineBytes) }, (_, i) => row(i))),
    'logs/broken.jsonl': `${JSON.stringify(dialogue('ok'))}\n{"id": "cut`,
  });
  const { logs } = await detectProject(root);
  assert.deepEqual(logs, [
    { file: join('logs', 'many.jsonl'), dialogues: 350, rejected: 0, complete: true },
    { file: join('logs', 'huge.jsonl'), dialogues: Math.floor(1_000_000 / lineBytes), rejected: 0, complete: false },
  ]);
});

test('spreadsheet logs are found and counted under the reading Lab would propose; a table without conversations is not a log', async t => {
  const talk = (...messages: string[]) => messages.join(' ` ');
  const root = await project(t, {
    'exports/logs.xlsx': xlsxFile([{ name: 'Данные', rows: [['Id диалога', 'Текст'],
      ...Array.from({ length: 6 }, (_, i) => [`d${i + 1}`, talk(`CLIENT Вопрос ${i + 1}`, 'AGENT Отвечаю на вопрос')]), ['d7', 'без меток']] }]),
    'exports/operator.xlsx': xlsxFile([{ name: 'Лист1', rows: [['id', 'dialog'],
      ...Array.from({ length: 4 }, (_, i) => [`o${i + 1}`, talk('CLIENT Позовите человека', 'AGENT Перевожу', 'OPERATOR Слушаю вас')])] }]),
    'exports/chats.csv': 'session,author,message\ns1,client,Добрый день\ns1,bot,Здравствуйте! Чем помочь?\ns2,client,Где мой заказ?\ns2,bot,Проверяю статус\n',
    'data/prices.csv': 'товар,цена\nТерминал,12000\nРидер,3000\n',
    'data/broken.xlsx': 'not really a workbook',
  });
  const detection = await detectProject(root);
  assert.deepEqual(detection.logs, [
    { file: join('exports', 'logs.xlsx'), dialogues: 6, rejected: 1, complete: true, table: 'ready' },
    { file: join('exports', 'operator.xlsx'), dialogues: 4, rejected: 0, complete: true, table: 'question' },
    { file: join('exports', 'chats.csv'), dialogues: 2, rejected: 0, complete: true, table: 'ready' },
  ]);
  const lines = detectionLines(detection);
  for (const line of [
    `  ${join('exports', 'logs.xlsx')} — таблица, 6 разговоров, 1 запись не подошла; как её читать, Lab покажет перед загрузкой`,
    `  ${join('exports', 'operator.xlsx')} — таблица, 4 разговора; перед загрузкой Lab спросит, как её читать`,
    `  ${join('exports', 'chats.csv')} — таблица, 2 разговора; как её читать, Lab покажет перед загрузкой`,
  ]) assert.ok(lines.includes(line), `${line}\n---\n${lines.join('\n')}`);
});

test('an empty folder yields an empty proposal, and every section says what is missing', async t => {
  const root = await project(t, {});
  const detection = await detectProject(root);
  assert.deepEqual({ ...detection, root: '' }, { root: '', agents: [], logs: [], materials: [], prompts: [], env: { files: [], names: [] }, truncated: false });
  const lines = detectionLines(detection);
  for (const line of ['  не нашёл — Lab спросит, как запускать агента', '  не нашёл файлов с разговорами (JSON, JSONL, XLSX, CSV)', '  не нашёл папок с документами'])
    assert.ok(lines.includes(line), line);
  // A mistyped folder is an error, not an empty project.
  await assert.rejects(detectProject(join(root, 'missing')), { message: `Папка проекта не найдена: ${join(root, 'missing')}` });
});

test('agent-lab detect prints the proposal in plain Russian; --json returns the detection itself', { timeout: 30000 }, async t => {
  const root = await supportBot(t);
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const call = async (args: string[]) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, 'detect', '--directory', root, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    return { code, stdout, stderr };
  };
  const text = await call([]);
  assert.equal(text.code, 0, text.stderr);
  const lines = text.stdout.split('\n');
  for (const line of [
    'Агент', '  ✓ python agent.py', '      package.json: scripts.start = python agent.py', '      agent.py: читает запросы из stdin построчно и отвечает JSON',
    '  ? http://localhost:8080/chat — возможно, агент; подключу по вашему curl-запросу к нему',
    `  ${join('logs', 'support.jsonl')} — 3 разговора, 1 запись не подошла`, `  ${join('data', 'export.json')} — 1 разговор`,
    '  docs — 3 документа', '  knowledge — 1 документ', `  ${join('prompts', 'system.md')} — файл, 21 знак`,
    'Переменные из .env: BOT_TOKEN, OPENAI_API_KEY — значения Lab не читает.',
  ]) assert.ok(lines.includes(line), `${line}\n---\n${text.stdout}`);
  for (const secret of ['sk-live-secret', 'tg-secret']) assert.ok(!text.stdout.includes(secret), secret);
  const json = await call(['--json']);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), await detectProject(root));
});

/** An agent the way a LangChain team keeps it: prompts as Python constants of its chains, an MLS cache of JSON prompts, a prompt file. */
async function chainsAgent(t: TestContext): Promise<string> {
  return project(t, {
    'app/chains/answer_chain.py': [
      'from langchain_core.prompts import ChatPromptTemplate',
      'from app.prompts import SHARED_RULES',
      'open("ran.txt", "w").write("ran")  # appears only if something runs this file',
      '',
      'SYSTEM_PROMPT = f"""Ты — ассистент эквайринга. Отвечай клиенту только по статьям: {articles}.',
      'Не называй внутренние системы банка."""',
      'PROMPT_VERSION = "v2"',
      '',
      'def chain():',
      '    return ChatPromptTemplate.from_messages([("system", SYSTEM_PROMPT), ("system", SHARED_RULES), ("human", "{question}")])',
      '',
    ].join('\n'),
    'app/prompts.py': 'SHARED_RULES = (\n    "Отвечай на «вы», коротко и по делу. "\n    "Никогда не обещай сроки подключения."\n)\n',
    'app/classify.py': 'DOC_TYPE_PROMPT: str = \'Определи тип документа клиента и верни одно слово: счёт, договор или акт.\'\n',
    'app/answer.ts': "export const answerPrompt = `Ты отвечаешь клиентам банка. Используй ${ctx} и не выдумывай тарифы.`;\nconst messages = [{ role: 'system', content: 'Ты проверяешь ответ ассистента перед отправкой клиенту: без внутренних систем.' }];\n",
    'local/mls_cache/agent_doc_type_prompt_v2.json': JSON.stringify({ version: 3, prompt: 'Классифицируй обращение клиента по типу документа. Верни только код.' }),
    'config/llm.json': JSON.stringify({ model: 'gigachat', system: 'Ты — вежливый ассистент банка, который отвечает клиентам эквайринга.', retries: 2 }),
    'prompts/answer.md': 'Отвечай клиенту по статьям базы знаний.\n',
    // Over the reading cap of a source file: not read at all, so nothing of it is proposed.
    'app/huge.py': `HUGE_PROMPT = """${'а'.repeat(300_000)}"""\n`,
  });
}

test('prompts are found where an agent keeps them: constants of its code, the system role of its chains, prompt fields of its JSON — verbatim, by stable ids, never run', async t => {
  const root = await chainsAgent(t);
  const detection = await detectProject(root);
  const shown = detection.prompts.map(prompt => [prompt.id, prompt.origin, prompt.system ?? false]);
  assert.deepEqual(shown, [
    [join('app', 'answer.ts') + '#answerPrompt', 'code', false],
    [join('app', 'answer.ts') + '#messages:system', 'code', true],
    [join('app', 'classify.py') + '#DOC_TYPE_PROMPT', 'code', false],
    [join('app', 'prompts.py') + '#SHARED_RULES', 'code', true],
    [join('config', 'llm.json') + '#system', 'json', false],
    [join('prompts', 'answer.md'), 'file', false],
    [join('app', 'chains', 'answer_chain.py') + '#SYSTEM_PROMPT', 'code', true],
    [join('local', 'mls_cache', 'agent_doc_type_prompt_v2.json') + '#prompt', 'json', false],
  ]);
  const text = (id: string) => detection.prompts.find(prompt => prompt.id === id)!.text;
  assert.equal(text(join('app', 'chains', 'answer_chain.py') + '#SYSTEM_PROMPT'), 'Ты — ассистент эквайринга. Отвечай клиенту только по статьям: {articles}.\nНе называй внутренние системы банка.', 'an f-string keeps its placeholders');
  assert.equal(text(join('app', 'prompts.py') + '#SHARED_RULES'), 'Отвечай на «вы», коротко и по делу. Никогда не обещай сроки подключения.', 'adjacent literals are one prompt');
  assert.equal(text(join('app', 'answer.ts') + '#answerPrompt'), 'Ты отвечаешь клиентам банка. Используй ${ctx} и не выдумывай тарифы.');
  assert.ok(!detection.prompts.some(prompt => prompt.id.includes('PROMPT_VERSION') || prompt.id.includes('HUGE')), 'a version tag and an unread file are not prompts');
  assert.equal(await exists(join(root, 'ran.txt')), false, 'no code ran');
  assert.deepEqual((await detectProject(root)).prompts.map(prompt => prompt.id), shown.map(([id]) => id), 'ids are stable');
  const lines = detectionLines(detection);
  assert.ok(lines.includes(`  ${join('app', 'chains', 'answer_chain.py')}#SYSTEM_PROMPT — строка в коде, задаёт роль system, 110 знаков`), lines.join('\n'));
  assert.ok(lines.includes('  Какие из них задают, что и как бот отвечает клиенту, выбираете вы: они станут правилами поведения бота.'));
});

test('agent-lab build --prompts-from lists the prompts to pick; --prompt takes exactly the ones named and refuses an unknown one', { timeout: 30000 }, async t => {
  const root = await chainsAgent(t);
  const task = join(root, 'task.json');
  await writeFile(task, JSON.stringify({ task: 'Проверить ответы эквайринга', mode: 'live', target: { kind: 'unconnected' }, materials: [], settings: { provider: 'p', model: 'm' } }));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const call = async (args: string[]) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, 'build', '--data-dir', join(root, '.agent-lab'), '--input', task, '--prompts-from', root, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    return { code, stdout, stderr };
  };
  const list = await call([]);
  assert.equal(list.code, 0, list.stderr);
  assert.ok(list.stdout.includes(`  ${join('app', 'prompts.py')}#SHARED_RULES — строка в коде, задаёт роль system, 72 знака`), list.stdout);
  assert.match(list.stdout, /ничего не записано и не потрачено/);
  const unknown = await call(['--prompt', 'app/missing.py#NOPE']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Промпта app\/missing\.py#NOPE в .* нет\. Есть: /);
  const picked = await call(['--prompt', `${join('app', 'chains', 'answer_chain.py')}#SYSTEM_PROMPT`]);
  assert.equal(picked.code, 0, picked.stderr);
  assert.match(picked.stderr, /Промпты агента: app\/chains\/answer_chain\.py#SYSTEM_PROMPT\./);
  assert.match(picked.stdout, /Собрать: та же команда с --yes/);
  assert.equal(await exists(join(root, 'ran.txt')), false);
});

test('a module is the agent only by its contract, and a local address only under a key naming the agent — never a model server\'s', async t => {
  const root = await project(t, {
    // A Next.js login keeps a createSession of its own: a user's session, no session that answers.
    'app/lib/session.ts': "import 'server-only';\nexport async function createSession(userId: string) {\n  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);\n"
      + "  const sessionId = await db.insert({ userId, expiresAt });\n  cookies().set('session', sessionId, { httpOnly: true });\n}\n",
    // The contract without Lab's request fields: maybe the agent — the owner says.
    'bot/agent.mjs': "export function createSession() { return { async respond(message) { return 'Ответ: ' + message; } }; }\n",
    'config.yaml': ['llm:', '  base_url: http://localhost:11434', 'ollama_url: "http://127.0.0.1:11434/api/chat"', 'lmstudio: http://localhost:1234/v1/chat/completions',
      'openai_base: http://localhost:8000/v1', 'bot_url: http://localhost:1234/', 'agent_llm: http://localhost:8081/', 'service:', '  url: http://localhost:5432/db',
      'agent:', '  endpoint: http://localhost:8080/chat # the bot itself', ''].join('\n'),
    'package.json': JSON.stringify({ name: 'web', proxy: 'http://localhost:3000', scripts: { dev: 'next dev' } }),
    'settings.json': JSON.stringify({ assistant: { url: 'http://localhost:9000/api/message' }, embeddings: { url: 'http://localhost:9001/embed' }, agent: { model: { url: 'http://localhost:9002/' } } }),
    'app.toml': '[agent]\nurl = "http://localhost:7000/v1/chat/completions"\n[server]\nagent_url = "http://localhost:7001/hook"\n',
  });
  const { agents } = await detectProject(root);
  assert.deepEqual(agents.map(agent => [agent.target.kind === 'module' ? agent.target.path : agent.target.kind === 'http' ? agent.target.url : agent.target.kind, agent.confidence]), [
    [join(root, 'bot', 'agent.mjs'), 'medium'],
    ['http://localhost:7001/hook', 'low'],
    ['http://localhost:8080/chat', 'low'],
    ['http://localhost:9000/api/message', 'low'],
  ]);
  const lines = detectionLines(await detectProject(root));
  assert.ok(lines.includes('  ? http://localhost:8080/chat — возможно, агент; подключу по вашему curl-запросу к нему'), lines.join('\n'));
  assert.ok(!lines.some(line => line.includes('11434') || line.includes('1234') || line.includes('session.ts')), lines.join('\n'));
});

test('a .env file yields variable names only, whatever its values span: quotes over lines, a key without quotes, escapes, comments', async t => {
  const pem = ['-----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7', 'TAIL_OF_KEY=abc', 'dGhpcyBpcyBub3QgYSByZWFsIGtleQ==', '-----END PRIVATE KEY-----'];
  const text = [
    'OPENAI_API_KEY=sk-live-secret',
    `PRIVATE_KEY="${pem.join('\n')}"`,
    `RAW_KEY=${pem.join('\n')}`,
    "SINGLE='first line",
    "INNER_NAME=inside single quotes'",
    'export QUOTED="value with \\" quote and',
    'NOT_A_NAME=still inside"',
    '# COMMENTED=x',
    '  SPACED = value ',
    '1BAD=x',
    'bad-name=x',
    'LAST=1',
  ].join('\n');
  const names = ['LAST', 'OPENAI_API_KEY', 'PRIVATE_KEY', 'QUOTED', 'RAW_KEY', 'SINGLE', 'SPACED'];
  assert.deepEqual(envFileNames(text).sort(), names);
  const root = await project(t, { '.env': text, '.env.local': 'LOCAL_ONLY="a\nb=c"\n' });
  const detection = await detectProject(root);
  assert.deepEqual(detection.env.names, [...names, 'LOCAL_ONLY'].sort());
  const shown = JSON.stringify(detection) + detectionLines(detection).join('\n');
  for (const secret of ['MIIEv', 'TAIL_OF_KEY', 'dGhpcy', 'NOT_A_NAME', 'INNER_NAME', 'sk-live']) assert.ok(!shown.includes(secret), secret);
});
