import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { settingsSchema } from '../src/contracts.js';
import { createPiRuntime, getPiStatus } from '../src/pi.js';

/*
 * The personal model gateway as Lab's own runtimes meet it within one process: connected once and then shared, never
 * waited on by a run that does not use it, never hiding the other providers, and named by its own reason when a run
 * needs it. Pi's files and the gateway settings live in temporary folders; OpenRouter counts as configured by a test
 * key and is never called.
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
// Self-signed, test-only, loopback-only: the gateway's pair, its CA and the owner's certificate at once.
const certPath = join(fixtures, 'tls-loopback-cert.pem');
const keyPath = join(fixtures, 'tls-loopback-key.pem');
const openRouter = { provider: 'openrouter', model: 'openai/gpt-5.6-sol' };
const gigaModel = { provider: 'giga', model: 'GigaChat-3-Pro' };

const changed = ['PI_CODING_AGENT_DIR', 'OPENROUTER_API_KEY', ...Object.keys(process.env).filter(name => name.startsWith('AGENT_LAB_GATEWAY_'))];
const previous = Object.fromEntries(changed.map(name => [name, process.env[name]]));
let home: string;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-lab-giga-runtime-'));
  for (const name of changed) delete process.env[name];
  process.env.PI_CODING_AGENT_DIR = join(home, 'pi');
  process.env.OPENROUTER_API_KEY = 'test-key-never-sent';
});
after(() => {
  for (const name of [...changed, 'AGENT_LAB_GATEWAY_FILE']) {
    const value = previous[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

/** The owner's remembered gateway at `url`, with the loopback pair as certificate, key and CA. */
async function useGateway(url: string): Promise<void> {
  const file = join(home, `gateway-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify({ format: 'agent-lab-gateway-1', url, certPath, keyPath, caPath: certPath }));
  process.env.AGENT_LAB_GATEWAY_FILE = file;
}

function listening(server: Server | ReturnType<typeof createHttpsServer>): Promise<string> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve(`https://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`);
  }));
}

/** A loopback gateway that counts the connections it is asked for; `handle` decides what each gets. */
async function counting(handle: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createNetServer(socket => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    handle(socket);
  });
  const url = await listening(server);
  return { url, connections: () => connections, close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}

test('a run on another provider never waits on a gateway that does not answer', { timeout: 60000 }, async () => {
  const silent = await counting(() => { /* accepts the connection and never answers */ });
  try {
    await useGateway(silent.url);
    await createPiRuntime(settingsSchema.parse(openRouter));
    // A giga judge that the owner overrode by role is not used either.
    await createPiRuntime(settingsSchema.parse({ ...openRouter, judge: gigaModel, roles: { judge: openRouter } }));
    assert.equal(silent.connections(), 0);
  } finally { silent.close(); }
});

test('the status lists the other providers\' models and says apart why the gateway did not connect', { timeout: 60000 }, async () => {
  const silent = await counting(() => { /* accepts the connection and never answers */ });
  try {
    await useGateway(silent.url);
    const status = await getPiStatus();
    assert.ok(status.models.some(model => model.provider === openRouter.provider && model.id === openRouter.model), 'OpenRouter is listed');
    assert.equal(status.error, undefined, 'no advice to log in');
    assert.deepEqual([status.giga.configured, status.giga.registered, status.giga.failure, status.giga.reason],
      [true, false, { kind: 'timeout' }, 'шлюз не отвечает. Проверьте VPN и адрес.']);
  } finally { silent.close(); }
});

test('a run on giga models is refused with the gateway\'s own reason, and the process asks the gateway once', { timeout: 60000 }, async () => {
  // The gateway refuses the owner's certificate with a TLS alert (certificate expired) on every connection.
  const refusing = await counting(socket => socket.once('data', () => socket.end(Buffer.from([21, 3, 3, 0, 2, 2, 45]))));
  try {
    await useGateway(refusing.url);
    const reason = 'Модели giga недоступны — шлюз моделей не подключился: шлюз не принял ваш сертификат: срок его действия истёк. Нужен новый сертификат. '
      + 'В Pi его подключает заново /agent-lab gateway.';
    await assert.rejects(createPiRuntime(settingsSchema.parse(gigaModel)), { message: reason });
    await assert.rejects(createPiRuntime(settingsSchema.parse(gigaModel)), { message: reason });
    // A judge on the gateway needs it as much as the run's own model does.
    await assert.rejects(createPiRuntime(settingsSchema.parse({ ...openRouter, judge: gigaModel })), { message: reason });
    assert.equal(refusing.connections(), 1);
  } finally { refusing.close(); }
  process.env.AGENT_LAB_GATEWAY_FILE = join(home, 'never-saved.json');
  await assert.rejects(createPiRuntime(settingsSchema.parse(gigaModel)),
    { message: 'Модели giga недоступны: шлюз моделей не настроен. В Pi его подключает /agent-lab gateway.' });
});

test('a connected gateway serves every runtime and the status of the process from one catalog read', { timeout: 60000 }, async () => {
  let reads = 0;
  const server = createHttpsServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, (request, response) => {
    if (request.url === '/v1/models') reads += 1;
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: gigaModel.model, type: 'chat' }] }));
  });
  const url = await listening(server);
  try {
    await useGateway(url);
    await createPiRuntime(settingsSchema.parse(gigaModel));
    await createPiRuntime(settingsSchema.parse({ ...openRouter, judge: gigaModel }));
    const status = await getPiStatus();
    assert.deepEqual([reads, status.giga.registered, status.giga.failure], [1, true, undefined]);
    assert.ok(status.models.some(model => model.provider === gigaModel.provider && model.id === gigaModel.model));
  } finally { server.closeAllConnections(); server.close(); }
});
