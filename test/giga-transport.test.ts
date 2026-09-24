import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGigaTransport, forgetGatewaySettings, gatewayEnvironment, gatewaySettingsSchema, gatewayStatus, readGigaConfig, saveGatewaySettings, type GatewaySettings, type GigaConfig } from '../src/giga-transport.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
// Self-signed, test-only, loopback-only: never a real gateway certificate.
const serverCert = readFileSync(join(fixtures, 'tls-loopback-cert.pem'));
const serverKey = readFileSync(join(fixtures, 'tls-loopback-key.pem'));

function startTlsServer(onConnection: (socket: TLSSocket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = createTlsServer({ cert: serverCert, key: serverKey }, onConnection);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

function testConfig(port: number): GigaConfig {
  // Verification is off, like a real deployment would set with GIGACHAT_INSECURE, so the
  // self-signed loopback fixture is accepted without a matching CA.
  return { baseUrl: `https://127.0.0.1:${port}`, cert: serverCert, key: serverKey, rejectUnauthorized: false };
}

// Лимит отделяет «завис навсегда» от «ответил»: скорость тут не проверяется. Под нагрузкой полного
// набора локальное TLS-рукопожатие занимает секунды, и трёхсекундный лимит падал без поломки.
test('a response cut off mid-body rejects instead of hanging forever', { timeout: 15000 }, async () => {
  // A raw socket, not a real http.Server: promises a 100-byte body, writes far fewer bytes,
  // then closes cleanly (FIN, not RST) — exactly what a proxy/gateway does mid-stream.
  const { port, close } = await startTlsServer(socket => {
    socket.on('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"data":[');
      socket.end();
    });
  });
  try {
    const transport = createGigaTransport(testConfig(port));
    await assert.rejects(transport('/v1/models'));
  } finally { await close(); }
});

test('an already aborted signal rejects immediately instead of waiting for a response', { timeout: 3000 }, async () => {
  const { port, close } = await startTlsServer(() => { /* deliberately never responds */ });
  try {
    const transport = createGigaTransport(testConfig(port));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(transport('/v1/models', undefined, controller.signal));
  } finally { await close(); }
});

async function settingsDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-gateway-'));
  await writeFile(join(directory, 'cert.pem'), 'cert');
  await writeFile(join(directory, 'key.pem'), 'key');
  return directory;
}
const personal = (directory: string): GatewaySettings => ({ format: 'agent-lab-gateway-1', url: 'https://gateway.example/v1',
  certPath: join(directory, 'cert.pem'), keyPath: join(directory, 'key.pem') });

test('the personal settings file configures the gateway without any variable', async () => {
  const directory = await settingsDirectory();
  const file = join(directory, 'gateway.json');
  await saveGatewaySettings(personal(directory), file);
  const config = readGigaConfig(gatewayEnvironment({}, file));
  assert.equal(config?.baseUrl, 'https://gateway.example');
  assert.equal(config?.cert.toString(), 'cert');
});

test('a variable overrides only its own field of the personal settings', async () => {
  const directory = await settingsDirectory();
  const file = join(directory, 'gateway.json');
  await saveGatewaySettings(personal(directory), file);
  const merged = gatewayEnvironment({ AGENT_LAB_GATEWAY_URL: 'https://other.example' }, file);
  assert.deepEqual([merged.AGENT_LAB_GATEWAY_URL, merged.AGENT_LAB_GATEWAY_KEY_PATH], ['https://other.example', join(directory, 'key.pem')]);
});

test('personal settings are readable by the owner only', async () => {
  const directory = await settingsDirectory();
  const file = join(directory, 'nested', 'gateway.json');
  await saveGatewaySettings(personal(directory), file);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('without a personal settings file only the variables count', () => {
  assert.deepEqual(gatewayEnvironment({ HOME: '/x', AGENT_LAB_GATEWAY_URL: 'https://g' }, '/nonexistent/gateway.json'), { AGENT_LAB_GATEWAY_URL: 'https://g' });
});

test('a damaged settings file is reported by the status instead of crashing it', async () => {
  const directory = await settingsDirectory();
  const file = join(directory, 'gateway.json');
  await writeFile(file, '{not json');
  const status = gatewayStatus({ AGENT_LAB_GATEWAY_FILE: file });
  assert.deepEqual([status.configured, /повреждён/.test(status.settingsError ?? '')], [false, true]);
});

test('relative certificate paths are not accepted into the personal settings', () => {
  assert.equal(gatewaySettingsSchema.safeParse({ format: 'agent-lab-gateway-1', url: 'https://g', certPath: 'cert.pem', keyPath: '/key.pem' }).success, false);
});

test('forgetting settings removes the file and tolerates its absence', async () => {
  const directory = await settingsDirectory();
  const file = join(directory, 'gateway.json');
  await saveGatewaySettings(personal(directory), file);
  assert.deepEqual([await forgetGatewaySettings(file), await forgetGatewaySettings(file)], [true, false]);
});
