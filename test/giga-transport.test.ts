import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clientCertificateAlert, createGigaTransport, forgetGatewaySettings, gatewayEnvironment, gatewaySettingsSchema, gatewayStatus, GigaTransportError,
  readGigaConfig, requestOptions, saveGatewaySettings, type GatewaySettings, type GigaConfig,
} from '../src/giga-transport.js';

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

/** A loopback HTTPS gateway whose every answer is `respond`'s. */
function startHttpsServer(respond: Parameters<typeof createHttpsServer>[1]): Promise<{ port: number; server: HttpsServer; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = createHttpsServer({ cert: serverCert, key: serverKey }, respond);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0, server,
        close: () => { server.closeAllConnections(); return new Promise(done => server.close(() => done())); },
      });
    });
  });
}

function testConfig(port: number): GigaConfig {
  // Verification is off, as AGENT_LAB_GATEWAY_INSECURE=1 sets it, so the self-signed loopback fixture is accepted
  // without a matching CA.
  return { baseUrl: `https://127.0.0.1:${port}`, cert: serverCert, key: serverKey, rejectUnauthorized: false };
}

const failedWith = (kind: string) => (error: unknown) => error instanceof GigaTransportError && error.kind === kind;

// The limit tells «hangs forever» from «answered»: speed is not measured here. Under the load of the full suite a local
// TLS handshake takes seconds, and a three-second limit failed with nothing broken.
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
    await assert.rejects(transport('/v1/models', undefined, { signal: controller.signal }), failedWith('aborted'));
  } finally { await close(); }
});

test('a signal that aborts while the gateway is still thinking stops the request', { timeout: 15000 }, async () => {
  const { port, close } = await startHttpsServer(() => { /* deliberately never responds */ });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(createGigaTransport(testConfig(port))('/v2/chat/completions', { model: 'm' }, { signal: controller.signal }), failedWith('aborted'));
  } finally { await close(); }
});

test('the caller\'s deadline bounds the whole exchange: a slow answer inside it arrives, one past it fails as a timeout', { timeout: 30000 }, async () => {
  // The gateway does not stream: the socket stays silent until the whole answer is ready.
  const { port, close } = await startHttpsServer((_request, response) => {
    setTimeout(() => response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}'), 1500);
  });
  try {
    // The transport's own default is a second; the caller allows ten, and the answer comes after one and a half.
    const transport = createGigaTransport(testConfig(port), { timeoutMs: 1000 });
    assert.deepEqual(await transport('/v2/chat/completions', { model: 'm' }, { timeoutMs: 10_000 }), { status: 200, text: '{"ok":true}' });
    // A caller that allows less than the answer takes gets a typed timeout, not a hang.
    await assert.rejects(transport('/v2/chat/completions', { model: 'm' }, { timeoutMs: 300 }), failedWith('timeout'));
    // Without a deadline of the caller's own, the transport's default applies.
    await assert.rejects(transport('/v2/chat/completions', { model: 'm' }), failedWith('timeout'));
  } finally { await close(); }
});

test('the socket may stay idle as long as the deadline allows, never less', () => {
  const options = requestOptions(testConfig(443), '/v2/chat/completions', '{}', 600_000);
  assert.equal(options.timeout, 600_000);
});

test('a response over the size cap is refused with a typed error, whether its length is declared or streamed', { timeout: 30000 }, async () => {
  const body = 'x'.repeat(3_000_000);
  const { port, close } = await startHttpsServer((request, response) => {
    if (request.url === '/declared') response.writeHead(200, { 'Content-Length': Buffer.byteLength(body) }).end(body);
    else { response.writeHead(200); response.write(body.slice(0, 1_500_000)); response.end(body.slice(1_500_000)); }
  });
  try {
    const transport = createGigaTransport(testConfig(port));
    await assert.rejects(transport('/declared'), failedWith('too large'));
    await assert.rejects(transport('/streamed'), failedWith('too large'));
    // A response inside the cap is read whole.
    assert.equal((await createGigaTransport(testConfig(port), { maxResponseBytes: 4_000_000 })('/declared')).text.length, 3_000_000);
  } finally { await close(); }
});

test('the alert a gateway refused the owner\'s certificate with is read from Node\'s code or, over TLS 1.2, from OpenSSL\'s record', () => {
  const error = (code: string, message = 'x') => Object.assign(new Error(message), { code });
  const record = (packed: string, reason: string) => `write EPROTO C0CCA8EAF37F0000:error:${packed}:SSL routines:ssl3_read_bytes:${reason}:../deps/openssl/openssl/ssl/record/rec_layer_s3.c:918:SSL alert number 45\n`;
  assert.deepEqual([
    clientCertificateAlert(error('ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_EXPIRED')), clientCertificateAlert(error('ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED')),
    clientCertificateAlert(error('ERR_SSL_TLSV1_ALERT_UNKNOWN_CA')), clientCertificateAlert(error('ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED')),
    clientCertificateAlert(error('EPROTO', record('0A000415', 'ssl/tls alert certificate expired'))),
  ], [45, 45, 48, 116, 45]);
  // Neither the gateway's own certificate nor a TLS failure that names no certificate is an alert about the owner's.
  assert.deepEqual([
    clientCertificateAlert(error('CERT_HAS_EXPIRED')), clientCertificateAlert(error('ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE')),
    clientCertificateAlert(error('EPROTO', record('0A000410', 'ssl/tls alert handshake failure'))),
    clientCertificateAlert(error('EPROTO', record('0A0000C6', 'packet length too long'))), clientCertificateAlert(error('EPROTO', 'write EPROTO')),
    clientCertificateAlert(new Error('no code')),
  ], [undefined, undefined, undefined, undefined, undefined, undefined]);
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
