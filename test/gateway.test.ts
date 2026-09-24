import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig } from '@earendil-works/pi-coding-agent';
import agentLab from '../extensions/agent-lab.ts';
import { gatewayFailureText, ownerPath } from '../extensions/gateway.ts';

/*
 * The personal model gateway inside Pi: `/agent-lab gateway` connects it with native dialogs and no model, remembers
 * only the paths, and a remembered gateway connects by itself in the next session. The gateway is a loopback HTTPS
 * server that requires a client certificate; the owner's real settings file is never touched.
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
// Self-signed, test-only, loopback-only: the same pair serves as the gateway and as the client certificate.
const certPath = join(fixtures, 'tls-loopback-cert.pem');
const keyPath = join(fixtures, 'tls-loopback-key.pem');
const catalog = JSON.stringify({ data: [{ id: 'GigaChat-3-Ultra', type: 'chat' }, { id: 'Embeddings', type: 'embeddings' }] });

async function session(file: string) {
  const providers = new Map<string, ProviderConfig>();
  let shutdown: (() => Promise<void>) | undefined;
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const widgets: (string[] | undefined)[] = [];
  let sessionStart!: (event: unknown, ctx: unknown) => Promise<void>;
  await agentLab({
    registerTool: () => undefined, registerMessageRenderer: () => undefined,
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
    registerProvider: (name: string, config: ProviderConfig) => providers.set(name, config),
    unregisterProvider: (name: string) => providers.delete(name),
    on: (name: string, handler: () => Promise<void>) => {
      if (name === 'session_shutdown') shutdown = handler;
      if (name === 'session_start') sessionStart = handler as typeof sessionStart;
    },
    sendMessage: () => undefined, sendUserMessage: () => undefined, getActiveTools: () => [], setActiveTools: () => undefined,
  } as unknown as ExtensionAPI, { gateway: { file } });
  /** The owner types each answer into Pi's own prompts and picks `choice` when asked; no model is involved. */
  const typed = async (args: string, answers: string[], confirmed: boolean, cwd: string, choice?: string) => {
    const notes: { message: string; type?: string }[] = [];
    const ui = { input: async () => answers.shift(), confirm: async () => confirmed, select: async () => choice,
      notify: (message: string, type?: string) => notes.push({ message, ...(type ? { type } : {}) }), setWidget: () => undefined };
    await command(args, { cwd, hasUI: true, mode: 'tui', ui } as unknown as ExtensionCommandContext);
    return notes;
  };
  /** The start widget of an Agent Lab session. */
  const started = async (cwd: string) => {
    const previous = process.env.AGENT_LAB_SESSION;
    process.env.AGENT_LAB_SESSION = '1';
    try {
      await sessionStart({}, { cwd, hasUI: true, mode: 'tui', ui: { setTitle: () => undefined, setHeader: () => undefined, setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines) } });
    } finally { if (previous === undefined) delete process.env.AGENT_LAB_SESSION; else process.env.AGENT_LAB_SESSION = previous; }
    return widgets.at(-1) ?? [];
  };
  return { typed, started, providers, shutdown: async () => { await shutdown?.(); } };
}

function gateway(): Promise<{ url: string; server: Server }> {
  return new Promise(resolve => {
    const server = createServer({ cert: readFileSync(certPath), key: readFileSync(keyPath), requestCert: true, rejectUnauthorized: false }, (request, response) => {
      const presented = (request.socket as import('node:tls').TLSSocket).getPeerCertificate();
      if (!presented?.raw) { response.writeHead(403).end(); return; }
      if (request.url !== '/v1/models') { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(catalog);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ url: `https://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`, server });
    });
  });
}

const workspace = () => mkdtemp(join(tmpdir(), 'agent-lab-gateway-'));

test('without any model the owner connects the gateway with /agent-lab gateway; only the paths are remembered', { timeout: 20000 }, async () => {
  const cwd = await workspace();
  const file = join(cwd, 'home', 'gateway.json');
  const { url, server } = await gateway();
  const { typed, providers, shutdown } = await session(file);
  try {
    // The loopback gateway certificate is self-signed: the first check fails and the owner agrees to skip it.
    const notes = await typed('gateway', [url, certPath, keyPath, ''], true, cwd);
    assert.equal(notes.at(-1)?.type, 'info');
    assert.match(notes.at(-1)?.message ?? '', /моделей 1\. Выберите модель: \/model → giga/);
    assert.deepEqual(providers.get('giga')?.models?.map(model => model.id), ['GigaChat-3-Ultra']);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(saved, { format: 'agent-lab-gateway-1', url, certPath, keyPath, insecure: true });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally { server.close(); await shutdown(); }
});

test('a remembered gateway connects in the next session without being asked; off forgets it', { timeout: 20000 }, async () => {
  const cwd = await workspace();
  const file = join(cwd, 'home', 'gateway.json');
  const { url, server } = await gateway();
  try {
    const first = await session(file);
    await first.typed('gateway', [url, certPath, keyPath, ''], true, cwd);
    await first.shutdown();
    const next = await session(file);
    assert.ok(next.providers.has('giga'), 'the startup connection is settled before the factory returns');
    assert.deepEqual(await next.started(cwd), ['Напишите обычными словами, например: «проверь агента в этой папке, логи — logs.xlsx».',
      '/agent-lab — рабочее пространство агента · /agent-lab demo — учебный пример без модели и ключей.']);
    const notes = await next.typed('gateway off', [], true, cwd);
    assert.match(notes.at(-1)?.message ?? '', /Шлюз моделей отключён/);
    assert.deepEqual([next.providers.has('giga'), existsSync(file)], [false, false]);
    await next.shutdown();
  } finally { server.close(); }
});

test('an owner who keeps the gateway certificate check gets the reason and nothing is saved', { timeout: 20000 }, async () => {
  const cwd = await workspace();
  const file = join(cwd, 'home', 'gateway.json');
  const { url, server } = await gateway();
  const { typed, providers, shutdown } = await session(file);
  try {
    const notes = await typed('gateway', [url, certPath, keyPath, ''], false, cwd);
    assert.equal(notes.at(-1)?.type, 'error');
    assert.match(notes.at(-1)?.message ?? '', /ничего не сохранено: не удалось проверить сертификат самого шлюза/);
    assert.deepEqual([existsSync(file), providers.has('giga')], [false, false]);
  } finally { server.close(); await shutdown(); }
});

test('a path that does not open is named before any request, and an unreachable gateway is explained at start', { timeout: 20000 }, async () => {
  const cwd = await workspace();
  const file = join(cwd, 'home', 'gateway.json');
  const { typed, shutdown } = await session(file);
  try {
    const notes = await typed('gateway', ['https://gateway.example', certPath, join(cwd, 'missing.key'), ''], true, cwd);
    assert.deepEqual(notes, [{ message: 'Не читается: ключ. Проверьте путь.', type: 'error' }]);
  } finally { await shutdown(); }
  // A gateway remembered earlier that no longer answers: the start says why and how to fix it, nothing is registered.
  const { url, server } = await gateway();
  const first = await session(file);
  await first.typed('gateway', [url, certPath, keyPath, ''], true, cwd);
  await first.shutdown();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const next = await session(file);
  try {
    assert.equal(next.providers.has('giga'), false);
    assert.equal((await next.started(cwd)).at(-1), 'Шлюз моделей не подключился: шлюз не отвечает. Проверьте VPN и адрес. /agent-lab gateway настроит его заново.');
  } finally { await next.shutdown(); }
});

test('gateway failures are translated into what to fix', () => {
  const texts = ['connection ENOTFOUND', 'connection UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'connection EPROTO', 'HTTP 403', 'HTTP 404', 'HTTP 500'].map(gatewayFailureText);
  assert.deepEqual(texts, ['адрес шлюза не найден в сети. Проверьте адрес и VPN.',
    'не удалось проверить сертификат самого шлюза. Укажите цепочку CA или, осознанно, отключите проверку.',
    'сертификат и ключ не подходят друг к другу или к шлюзу.', 'шлюз не принял сертификат: у него нет доступа.',
    'по этому адресу нет каталога моделей. Нужен корень шлюза, без /api.', 'шлюз ответил ошибкой (HTTP 500).']);
});

test('paths are taken the way the owner types them', () => {
  assert.deepEqual([ownerPath('certs/a.pem', '/work'), ownerPath('/abs/a.pem', '/work'), ownerPath('~/a.pem', '/work').endsWith('/a.pem')], ['/work/certs/a.pem', '/abs/a.pem', true]);
});
