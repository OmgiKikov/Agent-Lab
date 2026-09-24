import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig } from '@earendil-works/pi-coding-agent';
import agentLab from '../extensions/agent-lab.ts';
import { ownerPath } from '../extensions/gateway.ts';
import { gatewayFailureText } from '../src/giga-provider.js';

/*
 * The personal model gateway inside Pi: `/agent-lab gateway` connects it with native dialogs and no model, remembers
 * only the paths, and a remembered gateway connects by itself in the next session. The gateway is a loopback HTTPS
 * server that requires a client certificate; the owner's real settings file is never touched.
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
// Self-signed, test-only, loopback-only: the same pair serves as the gateway and as the client certificate.
const certPath = join(fixtures, 'tls-loopback-cert.pem');
const keyPath = join(fixtures, 'tls-loopback-key.pem');
// Test-only: a client certificate the loopback pair issued, expired since 2020-01-02.
const expiredCertPath = join(fixtures, 'tls-client-expired-cert.pem');
const expiredKeyPath = join(fixtures, 'tls-client-expired-key.pem');
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
  /** The owner's confirmations, in order: what Pi asked, and the text it showed. */
  const asked: { title: string; message: string }[] = [];
  /** The owner types each answer into Pi's own prompts and picks `choice` when asked; no model is involved. */
  const typed = async (args: string, answers: string[], confirmed: boolean, cwd: string, choice?: string) => {
    const notes: { message: string; type?: string }[] = [];
    const ui = { input: async () => answers.shift(), select: async () => choice, setWidget: () => undefined,
      confirm: async (title: string, message: string) => { asked.push({ title, message }); return confirmed; },
      notify: (message: string, type?: string) => notes.push({ message, ...(type ? { type } : {}) }) };
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
  return { typed, asked, started, providers, shutdown: async () => { await shutdown?.(); } };
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

/**
 * openssl s_server as the gateway: unlike Node's TLS server, it refuses a client certificate it does not accept with
 * the TLS alert, as a real gateway does. Nothing when OpenSSL's own s_server is not installed (LibreSSL's differs).
 */
function openSslGateway(args: string[]): Promise<{ url: string; close: () => void } | undefined> {
  const version = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  if (version.status !== 0 || !version.stdout.startsWith('OpenSSL ')) return Promise.resolve(undefined);
  return new Promise(resolve => {
    const child = spawn('openssl', ['s_server', '-accept', '127.0.0.1:0', '-cert', certPath, '-key', keyPath, '-www', ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    let printed = '';
    const timer = setTimeout(() => { child.kill(); resolve(undefined); }, 10_000);
    const gone = () => { clearTimeout(timer); resolve(undefined); };
    child.on('error', gone);
    child.on('exit', gone);
    child.stdout.on('data', (chunk: Buffer) => {
      printed += chunk.toString();
      // s_server prints «ACCEPT 127.0.0.1:<port>» once it listens.
      const line = printed.split('\n').find(candidate => candidate.startsWith('ACCEPT '));
      if (!line) return;
      clearTimeout(timer);
      const port = Number(line.slice(line.lastIndexOf(':') + 1).trim());
      if (!Number.isInteger(port) || port <= 0) { child.kill(); resolve(undefined); return; }
      resolve({ url: `https://127.0.0.1:${port}`, close: () => child.kill() });
    });
  });
}

/**
 * A gateway that answers the first message of a TLS connection with one fatal alert: a TLS 1.2 gateway refuses a client
 * certificate this way, and Node reports it the same way (EPROTO carrying OpenSSL's record of the alert).
 */
function alertingGateway(alert: number): Promise<{ url: string; server: NetServer }> {
  return new Promise(resolve => {
    const server = createNetServer(socket => socket.once('data', () => socket.end(Buffer.from([21, 3, 3, 0, 2, 2, alert]))));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ url: `https://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, server });
    });
  });
}

const workspace = () => mkdtemp(join(tmpdir(), 'agent-lab-gateway-'));

test('without any model the owner connects the gateway with /agent-lab gateway; only the paths are remembered', { timeout: 20000 }, async () => {
  const cwd = await workspace();
  const file = join(cwd, 'home', 'gateway.json');
  const { url, server } = await gateway();
  const { typed, asked, providers, shutdown } = await session(file);
  try {
    // The loopback gateway certificate is self-signed: the first check fails and the owner agrees to skip it.
    const notes = await typed('gateway', [url, certPath, keyPath, ''], true, cwd);
    assert.deepEqual(asked.map(question => question.title), ['Сертификат шлюза не проверяется']);
    assert.match(asked[0]?.message ?? '', /^Не удалось проверить сертификат самого шлюза\./);
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

test('a gateway that refuses the owner\'s certificate says what is wrong with it and never offers to skip its own check', { timeout: 30000 }, async () => {
  const cwd = await workspace();
  const file = join(cwd, 'home', 'gateway.json');
  const { typed, asked, providers, shutdown } = await session(file);
  const cases = [
    { alert: 45, reason: 'шлюз не принял ваш сертификат: срок его действия истёк. Нужен новый сертификат.' },
    { alert: 44, reason: 'шлюз не принял ваш сертификат: он отозван. Нужен новый сертификат.' },
    { alert: 48, reason: 'шлюз не принял ваш сертификат: его выдал удостоверяющий центр (CA), которому шлюз не доверяет. Нужен сертификат, выпущенный для этого шлюза.' },
    { alert: 42, reason: 'шлюз не принял ваш сертификат. Проверьте, что это сертификат, выпущенный для этого шлюза.' },
  ];
  try {
    for (const { alert, reason } of cases) {
      const { url, server } = await alertingGateway(alert);
      try {
        const notes = await typed('gateway', [url, certPath, keyPath, ''], true, cwd);
        assert.deepEqual(notes, [{ message: `Шлюз не подключён, ничего не сохранено: ${reason}`, type: 'error' }], `alert ${alert}`);
      } finally { server.close(); }
    }
    // A key that is not the certificate's pair: Node sends no certificate, and the gateway says it received none.
    const { url, server } = await alertingGateway(116);
    try {
      const notes = await typed('gateway', [url, certPath, expiredKeyPath, ''], true, cwd);
      assert.deepEqual(notes, [{ message: 'Шлюз не подключён, ничего не сохранено: сертификат и ключ не подходят друг к другу: укажите ваш сертификат и ключ из одной пары.', type: 'error' }]);
    } finally { server.close(); }
    assert.deepEqual([asked, existsSync(file), providers.has('giga')], [[], false, false]);
  } finally { await shutdown(); }
});

test('against openssl s_server: an expired certificate of the owner\'s is named as such over TLS 1.3 and 1.2', { timeout: 60000 }, async t => {
  const cwd = await workspace();
  const file = join(cwd, 'home', 'gateway.json');
  const trusting = ['-CAfile', certPath, '-Verify', '1', '-verify_return_error'];
  const probe = await openSslGateway(trusting);
  if (!probe) { t.skip('openssl s_server is not available'); return; }
  probe.close();
  const { typed, asked, providers, shutdown } = await session(file);
  try {
    for (const version of [[], ['-tls1_2']]) {
      const server = await openSslGateway([...trusting, ...version]);
      assert.ok(server);
      try {
        // The owner names the gateway's CA, so the gateway's own certificate verifies; the gateway refuses the owner's.
        const notes = await typed('gateway', [server.url, expiredCertPath, expiredKeyPath, certPath], true, cwd);
        assert.deepEqual(notes, [{ message: 'Шлюз не подключён, ничего не сохранено: шлюз не принял ваш сертификат: срок его действия истёк. Нужен новый сертификат.', type: 'error' }],
          version.join(' ') || 'TLS 1.3');
      } finally { server.close(); }
    }
    assert.equal(asked.length, 0, 'a refused certificate of the owner\'s never leads to skipping the gateway\'s own check');
    // Both refusals in one connection: the gateway's self-signed certificate is skipped by the owner's decision, and the
    // owner's expired certificate is still refused, so nothing is remembered, not even that decision.
    const server = await openSslGateway(trusting);
    assert.ok(server);
    try {
      const notes = await typed('gateway', [server.url, expiredCertPath, expiredKeyPath, ''], true, cwd);
      assert.deepEqual(asked.map(question => question.title), ['Сертификат шлюза не проверяется']);
      assert.deepEqual(notes, [{ message: 'Шлюз не подключён, ничего не сохранено: шлюз не принял ваш сертификат: срок его действия истёк. Нужен новый сертификат.', type: 'error' }]);
    } finally { server.close(); }
    assert.deepEqual([existsSync(file), providers.has('giga')], [false, false]);
  } finally { await shutdown(); }
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
  const texts = [
    { kind: 'connection', code: 'ENOTFOUND' }, { kind: 'gateway certificate', code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', problem: 'chain' },
    { kind: 'gateway certificate', code: 'CERT_HAS_EXPIRED', problem: 'dates' }, { kind: 'gateway certificate', code: 'ERR_TLS_CERT_ALTNAME_INVALID', problem: 'name' },
    { kind: 'client certificate', code: 'ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_EXPIRED', alert: 45 }, { kind: 'connection', code: 'EPROTO' },
    { kind: 'unusable file', file: 'key' }, { kind: 'http', status: 403 }, { kind: 'http', status: 404 }, { kind: 'http', status: 500 },
  ] as const;
  assert.deepEqual(texts.map(gatewayFailureText), ['адрес шлюза не найден в сети. Проверьте адрес и VPN.',
    'не удалось проверить сертификат самого шлюза. Укажите цепочку CA или, осознанно, отключите проверку.',
    'сертификат самого шлюза просрочен или ещё не действует. Проверьте дату и время на компьютере или, осознанно, отключите проверку.',
    'сертификат самого шлюза выписан на другой адрес. Проверьте адрес шлюза или, осознанно, отключите проверку.',
    'шлюз не принял ваш сертификат: срок его действия истёк. Нужен новый сертификат.',
    'защищённое соединение со шлюзом не установилось. Проверьте, что адрес ведёт на сам шлюз по https, а сертификат и ключ выпущены для него.',
    'файл вашего ключа не читается как ключ: нужен формат PEM, без пароля.',
    'шлюз не принял сертификат: у него нет доступа.', 'по этому адресу нет каталога моделей. Нужен корень шлюза, без /api.', 'шлюз ответил ошибкой (HTTP 500).']);
});

test('paths are taken the way the owner types them', () => {
  assert.deepEqual([ownerPath('certs/a.pem', '/work'), ownerPath('/abs/a.pem', '/work'), ownerPath('~/a.pem', '/work').endsWith('/a.pem')], ['/work/certs/a.pem', '/abs/a.pem', true]);
});
