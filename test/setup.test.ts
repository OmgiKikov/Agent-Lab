import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ProviderConfig, ToolDefinition } from '@earendil-works/pi-coding-agent';
import agentLab from '../extensions/agent-lab.ts';
import { gatewayFailureText, ownerPath } from '../extensions/setup.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
// Self-signed, test-only, loopback-only: the same pair serves as the gateway and as the client certificate.
const certPath = join(fixtures, 'tls-loopback-cert.pem');
const keyPath = join(fixtures, 'tls-loopback-key.pem');
const catalog = JSON.stringify({ data: [{ id: 'GigaChat-3-Ultra', type: 'chat' }, { id: 'Embeddings', type: 'embeddings' }] });

/** The settings file stays pointed at the test directory for the whole test: the owner's real one is never touched. */
async function lab(settingsFile: string) {
  const previous = process.env.AGENT_LAB_GATEWAY_FILE;
  process.env.AGENT_LAB_GATEWAY_FILE = settingsFile;
  const tools = new Map<string, ToolDefinition>();
  const providers = new Map<string, ProviderConfig>();
  let shutdown: (() => Promise<void>) | undefined;
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  await agentLab({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
    registerProvider: (name: string, config: ProviderConfig) => providers.set(name, config),
    unregisterProvider: (name: string) => providers.delete(name),
    on: (name: string, handler: () => Promise<void>) => { if (name === 'session_shutdown') shutdown = handler; },
    sendMessage: () => undefined, sendUserMessage: () => undefined,
  } as unknown as ExtensionAPI);
  const call = async (name: string, params: object, cwd: string, confirmed?: boolean) => {
    const ui = confirmed === undefined ? { hasUI: false } : { hasUI: true, ui: { confirm: async () => confirmed } };
    const result = await tools.get(name)!.execute(name, params, undefined, undefined, { cwd, mode: 'print', ...ui } as unknown as ExtensionContext);
    return JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
  };
  const close = async () => {
    await shutdown?.();
    if (previous === undefined) delete process.env.AGENT_LAB_GATEWAY_FILE; else process.env.AGENT_LAB_GATEWAY_FILE = previous;
  };
  /** The owner types each answer into Pi's own prompts; no model is involved. */
  const typed = async (answers: string[], confirmed: boolean, cwd: string) => {
    const notes: { message: string; type?: string }[] = [];
    const ui = { input: async () => answers.shift(), confirm: async () => confirmed, notify: (message: string, type?: string) => notes.push({ message, type }), setWidget: () => undefined };
    await command('gateway', { cwd, hasUI: true, mode: 'tui', ui } as unknown as ExtensionCommandContext);
    return notes;
  };
  return { call, typed, providers, shutdown: close };
}

function gateway(requireClientCertificate: boolean): Promise<{ url: string; server: Server }> {
  return new Promise(resolve => {
    const server = createServer({ cert: readFileSync(certPath), key: readFileSync(keyPath), requestCert: requireClientCertificate, rejectUnauthorized: false }, (request, response) => {
      const presented = (request.socket as import('node:tls').TLSSocket).getPeerCertificate();
      if (requireClientCertificate && !presented?.raw) { response.writeHead(403).end(); return; }
      if (request.url !== '/v1/models') { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(catalog);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ url: `https://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`, server });
    });
  });
}

const workspace = () => mkdtemp(join(tmpdir(), 'agent-lab-setup-'));

test('the owner connects the gateway from the conversation and it is usable at once', { timeout: 20000 }, async () => {
  const cwd = await workspace();
  const settingsFile = join(cwd, 'home', 'gateway.json');
  const { url, server } = await gateway(true);
  const { call, providers, shutdown } = await lab(settingsFile);
  try {
    const saved = await call('agent_lab_gateway', { action: 'save', url, certPath, keyPath, insecure: true }, cwd);
    assert.deepEqual([saved.connected, saved.models, providers.get('giga')?.models?.map(model => model.id)], [true, ['GigaChat-3-Ultra'], ['GigaChat-3-Ultra']]);
  } finally { server.close(); await shutdown(); }
});

test('the gateway paths are remembered, not the certificate itself', { timeout: 20000 }, async () => {
  const cwd = await workspace();
  const settingsFile = join(cwd, 'home', 'gateway.json');
  const { url, server } = await gateway(true);
  const { call, shutdown } = await lab(settingsFile);
  try {
    await call('agent_lab_gateway', { action: 'save', url, certPath, keyPath, insecure: true }, cwd);
    const stored = await readFile(settingsFile, 'utf8');
    assert.deepEqual([JSON.parse(stored).keyPath, stored.includes('PRIVATE KEY'), (await stat(settingsFile)).mode & 0o777], [keyPath, false, 0o600]);
  } finally { server.close(); await shutdown(); }
});

test('a remembered gateway connects in the next conversation without being asked', { timeout: 20000 }, async () => {
  const cwd = await workspace();
  const settingsFile = join(cwd, 'home', 'gateway.json');
  const { url, server } = await gateway(true);
  const first = await lab(settingsFile);
  await first.call('agent_lab_gateway', { action: 'save', url, certPath, keyPath, insecure: true }, cwd);
  await first.shutdown();
  const next = await lab(settingsFile);
  try {
    assert.equal(next.providers.get('giga')?.models?.[0]?.id, 'GigaChat-3-Ultra');
  } finally { server.close(); await next.shutdown(); }
});

test('an unreachable gateway is explained and nothing is remembered', { timeout: 20000 }, async () => {
  const cwd = await workspace();
  const settingsFile = join(cwd, 'home', 'gateway.json');
  const { url, server } = await gateway(true);
  server.close();
  const { call, providers, shutdown } = await lab(settingsFile);
  try {
    await assert.rejects(call('agent_lab_gateway', { action: 'save', url, certPath, keyPath, insecure: true }, cwd), /ничего не сохранено: шлюз не отвечает/);
    assert.deepEqual([existsSync(settingsFile), providers.has('giga')], [false, false]);
  } finally { await shutdown(); }
});

test('a certificate path that does not open is named before any request', async () => {
  const cwd = await workspace();
  const { call, shutdown } = await lab(join(cwd, 'gateway.json'));
  try {
    await assert.rejects(call('agent_lab_gateway', { action: 'save', url: 'https://gateway.example', certPath, keyPath: join(cwd, 'missing.key') }, cwd), /Не читается: ключ/);
  } finally { await shutdown(); }
});

test('forgetting the gateway removes its models from the choice', { timeout: 20000 }, async () => {
  const cwd = await workspace();
  const settingsFile = join(cwd, 'home', 'gateway.json');
  const { url, server } = await gateway(true);
  const { call, providers, shutdown } = await lab(settingsFile);
  try {
    await call('agent_lab_gateway', { action: 'save', url, certPath, keyPath, insecure: true }, cwd);
    await call('agent_lab_gateway', { action: 'forget' }, cwd, true);
    assert.deepEqual([existsSync(settingsFile), providers.has('giga')], [false, false]);
  } finally { server.close(); await shutdown(); }
});

test('without the owner in Pi the gateway is not switched off', { timeout: 20000 }, async () => {
  const cwd = await workspace();
  const settingsFile = join(cwd, 'home', 'gateway.json');
  const { url, server } = await gateway(true);
  const { call, providers, shutdown } = await lab(settingsFile);
  try {
    await call('agent_lab_gateway', { action: 'save', url, certPath, keyPath, insecure: true }, cwd);
    await assert.rejects(call('agent_lab_gateway', { action: 'forget' }, cwd), /подтверждается владельцем/);
    assert.deepEqual([existsSync(settingsFile), providers.has('giga')], [true, true]);
  } finally { server.close(); await shutdown(); }
});

test('without any model the owner connects the gateway with /agent-lab gateway', { timeout: 20000 }, async () => {
  const cwd = await workspace();
  const settingsFile = join(cwd, 'home', 'gateway.json');
  const { url, server } = await gateway(true);
  const { typed, providers, shutdown } = await lab(settingsFile);
  try {
    // The loopback gateway certificate is self-signed: the first check fails and the owner agrees to skip it.
    const notes = await typed([url, certPath, keyPath, ''], true, cwd);
    assert.deepEqual([notes.at(-1)?.type, providers.has('giga'), JSON.parse(await readFile(settingsFile, 'utf8')).insecure], ['info', true, true]);
  } finally { server.close(); await shutdown(); }
});

test('an owner who keeps the gateway certificate check gets the reason and nothing is saved', { timeout: 20000 }, async () => {
  const cwd = await workspace();
  const settingsFile = join(cwd, 'home', 'gateway.json');
  const { url, server } = await gateway(true);
  const { typed, providers, shutdown } = await lab(settingsFile);
  try {
    const notes = await typed([url, certPath, keyPath, ''], false, cwd);
    assert.deepEqual([notes.at(-1)?.type, /сертификат самого шлюза/.test(notes.at(-1)?.message ?? ''), existsSync(settingsFile), providers.has('giga')], ['error', true, false, false]);
  } finally { server.close(); await shutdown(); }
});

test('the status names what is missing in the owner words', async () => {
  const cwd = await workspace();
  const { call, shutdown } = await lab(join(cwd, 'gateway.json'));
  const saved = { url: process.env.AGENT_LAB_GATEWAY_URL, cert: process.env.AGENT_LAB_GATEWAY_CERT_PATH, key: process.env.AGENT_LAB_GATEWAY_KEY_PATH };
  delete process.env.AGENT_LAB_GATEWAY_URL; delete process.env.AGENT_LAB_GATEWAY_CERT_PATH; delete process.env.AGENT_LAB_GATEWAY_KEY_PATH;
  try {
    const status = await call('agent_lab_gateway', { action: 'status' }, cwd);
    assert.deepEqual([status.connected, status.missing], [false, 'адрес шлюза, сертификат, ключ']);
  } finally {
    if (saved.url) process.env.AGENT_LAB_GATEWAY_URL = saved.url;
    if (saved.cert) process.env.AGENT_LAB_GATEWAY_CERT_PATH = saved.cert;
    if (saved.key) process.env.AGENT_LAB_GATEWAY_KEY_PATH = saved.key;
    await shutdown();
  }
});

test('gateway failures are translated into what to fix', () => {
  const texts = ['connection ENOTFOUND', 'connection UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'HTTP 403', 'HTTP 404'].map(gatewayFailureText);
  assert.deepEqual(texts.map(text => text.split(' ').slice(0, 3).join(' ')), ['адрес шлюза не', 'не удалось проверить', 'шлюз не принял', 'по этому адресу']);
});

test('paths are taken the way the owner types them', () => {
  assert.deepEqual([ownerPath('certs/a.pem', '/work'), ownerPath('/abs/a.pem', '/work'), ownerPath('~/a.pem', '/work').endsWith('/a.pem')], ['/work/certs/a.pem', '/abs/a.pem', true]);
});

const hasOpenpyxl = spawnSync('python3', ['-c', 'import openpyxl']).status === 0;

async function workbook(cwd: string): Promise<string> {
  const file = join(cwd, 'размеченные логи.xlsx');
  const script = `import openpyxl,sys
wb=openpyxl.Workbook(); ws=wb.active; ws.title='GIGAASS'
ws.append(['conversation_id','dialogue_history','status_code'])
ws.append(['c-1','client: "Где мой договор?"\\nagent: "Уточните номер."\\nclient: "4321"','200'])
ws.append(['c-2','client: "Привет"','404'])
wb.save(sys.argv[1])`;
  assert.equal(spawnSync('python3', ['-c', script, file]).status, 0);
  return file;
}

test('a labelled .xlsx export becomes dialogues for building scenarios', { skip: !hasOpenpyxl && 'python3 with openpyxl is not available', timeout: 30000 }, async () => {
  const cwd = await workspace();
  await workbook(cwd);
  const { call, shutdown } = await lab(join(cwd, 'gateway.json'));
  try {
    const imported = await call('agent_lab_import', { kind: 'dialogues', file: 'размеченные логи.xlsx', multiTurnOnly: true }, cwd);
    const dialogues = (await readFile(join(cwd, imported.dialoguesFile), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(dialogues.map(dialogue => [dialogue.id, dialogue.messages.length, dialogue.outcome]), [['GIGAASS-c-1', 3, 'success']]);
  } finally { await shutdown(); }
});

test('imported production dialogues stay private to the owner', { skip: !hasOpenpyxl && 'python3 with openpyxl is not available', timeout: 30000 }, async () => {
  const cwd = await workspace();
  await workbook(cwd);
  const { call, shutdown } = await lab(join(cwd, 'gateway.json'));
  try {
    const imported = await call('agent_lab_import', { kind: 'dialogues', file: 'размеченные логи.xlsx' }, cwd);
    assert.deepEqual([imported.dialoguesFile.startsWith('.agent-lab/imports/'), (await stat(join(cwd, imported.dialoguesFile))).mode & 0o777], [true, 0o600]);
  } finally { await shutdown(); }
});

test('only .xlsx goes through the import; JSON goes to the build directly', async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, 'logs.jsonl'), '{}\n');
  const { call, shutdown } = await lab(join(cwd, 'gateway.json'));
  try {
    await assert.rejects(call('agent_lab_import', { kind: 'dialogues', file: 'logs.jsonl' }, cwd), /Нужен файл \.xlsx/);
  } finally { await shutdown(); }
});
