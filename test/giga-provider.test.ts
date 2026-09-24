import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  createGigaTransport, GigaTransportError, missingGigaVariables, readGigaConfig, requestOptions, unreadableGigaFiles, type GigaConfig, type GigaRequestOptions,
} from '../src/giga-transport.js';
import { connectGateway, createGigaProvider, failureLabel, GigaRequestError, registerGigaProvider } from '../src/giga-provider.js';
import type { GigaModel } from '../src/giga-protocol.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
// Test-only, loopback-only: the self-signed pair serves as the gateway, as its CA and as the owner's certificate.
const loopbackCertPath = join(fixtures, 'tls-loopback-cert.pem');
const loopbackKeyPath = join(fixtures, 'tls-loopback-key.pem');
// Test-only: the key of a client certificate the loopback pair issued; it is not the loopback certificate's pair.
const foreignKeyPath = join(fixtures, 'tls-client-expired-key.pem');

const catalogBody = JSON.stringify({ data: [
  { id: 'GigaChat-3-Pro', type: 'chat' }, { id: 'glm-5.2', type: 'chat' }, { id: 'Embeddings', type: 'embeddings' },
] });

const answerBody = JSON.stringify({
  model: 'GigaChat-3-Pro:3.1.0', created_at: 1789463335, finish_reason: 'stop',
  messages: [{ role: 'assistant', content: [{ text: 'Hello' }] }],
  usage: { input_tokens: 17, input_tokens_details: { cached_tokens: 2 }, output_tokens: 3, total_tokens: 20 },
});

async function providerWith(replies: { status: number; text: string }[]) {
  const sent: { path: string; body?: unknown }[] = [];
  const provider = await createGigaProvider({}, async (path, body) => {
    sent.push({ path, body });
    return replies[sent.length - 1] ?? { status: 500, text: 'no reply configured' };
  });
  return { provider: provider!, sent };
}

async function certDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-giga-'));
  await writeFile(join(directory, 'cert.pem'), 'test-cert');
  await writeFile(join(directory, 'key.pem'), 'test-key');
  await writeFile(join(directory, 'ca.pem'), 'test-ca');
  return directory;
}

test('returns a complete configuration with a normalized url when all required variables are set', async () => {
  const directory = await certDirectory();
  const complete = {
    AGENT_LAB_GATEWAY_URL: 'https://gateway.example/v1/',
    AGENT_LAB_GATEWAY_CERT_PATH: join(directory, 'cert.pem'),
    AGENT_LAB_GATEWAY_KEY_PATH: join(directory, 'key.pem'),
  };
  const config = readGigaConfig(complete);
  assert.equal(config?.baseUrl, 'https://gateway.example');
  assert.equal(config?.cert.toString(), 'test-cert');
  assert.equal(config?.key.toString(), 'test-key');
  assert.equal(config?.ca, undefined);
  assert.equal(config?.rejectUnauthorized, true);

  const urlNormalizationCases: Array<{ label: string; url: string; expected: string }> = [
    { label: 'v1 suffix with trailing slash', url: 'https://gateway.example/v1/', expected: 'https://gateway.example' },
    { label: 'v2 suffix', url: 'https://gateway.example/v2', expected: 'https://gateway.example' },
    { label: 'bare host without a version', url: 'https://gateway.example', expected: 'https://gateway.example' },
    { label: 'host with only a trailing slash', url: 'https://gateway.example/', expected: 'https://gateway.example' },
  ];
  for (const { label, url, expected } of urlNormalizationCases) {
    const cased = readGigaConfig({ ...complete, AGENT_LAB_GATEWAY_URL: url });
    assert.equal(cased?.baseUrl, expected, label);
  }
});

test('returns undefined when a required variable is missing', async () => {
  const directory = await certDirectory();
  const complete = {
    AGENT_LAB_GATEWAY_URL: 'https://gateway.example/v1/',
    AGENT_LAB_GATEWAY_CERT_PATH: join(directory, 'cert.pem'),
    AGENT_LAB_GATEWAY_KEY_PATH: join(directory, 'key.pem'),
  };
  for (const missing of ['AGENT_LAB_GATEWAY_URL', 'AGENT_LAB_GATEWAY_CERT_PATH', 'AGENT_LAB_GATEWAY_KEY_PATH'] as const) {
    assert.equal(readGigaConfig({ ...complete, [missing]: undefined }), undefined, `${missing} is required`);
  }
});

test('loads an optional CA and disables certificate verification when insecure mode is set', async () => {
  const directory = await certDirectory();
  const complete = {
    AGENT_LAB_GATEWAY_URL: 'https://gateway.example/v1/',
    AGENT_LAB_GATEWAY_CERT_PATH: join(directory, 'cert.pem'),
    AGENT_LAB_GATEWAY_KEY_PATH: join(directory, 'key.pem'),
  };
  const relaxed = readGigaConfig({ ...complete, AGENT_LAB_GATEWAY_CA_PATH: join(directory, 'ca.pem'), AGENT_LAB_GATEWAY_INSECURE: '1' });
  assert.equal(relaxed?.ca?.toString(), 'test-ca');
  assert.equal(relaxed?.rejectUnauthorized, false);
});

test('ignores the GigaChat variables that belong to the agent under test', () => {
  // The agent under test reaches GigaChat with its own certificates and keeps them in GIGACHAT_*. Agent Lab starts it as
  // a child process, so both pairs live in one environment: picking up the other's values would mean reaching Lab's own
  // gateway with the wrong certificate.
  assert.equal(readGigaConfig({
    GIGACHAT_URL: 'https://other-service.example',
    GIGACHAT_CERT_PATH: '/agent/cert.pem',
    GIGACHAT_KEY: '/agent/key.pem',
    GIGACHAT_VERIFY_PATH: '/agent/chain.pem',
  }), undefined);
});

test('names the variables that keep the gateway unconfigured', () => {
  // Without this list a missing provider looks like Pi's general refusal to authorize, and it is unclear whether to fix
  // the environment or the access to the models.
  assert.deepEqual(missingGigaVariables({}), ['AGENT_LAB_GATEWAY_URL', 'AGENT_LAB_GATEWAY_CERT_PATH', 'AGENT_LAB_GATEWAY_KEY_PATH']);
  assert.deepEqual(missingGigaVariables({ AGENT_LAB_GATEWAY_URL: 'https://gateway.example', AGENT_LAB_GATEWAY_KEY_PATH: '/key.pem' }), ['AGENT_LAB_GATEWAY_CERT_PATH']);
  assert.deepEqual(missingGigaVariables({
    AGENT_LAB_GATEWAY_URL: 'https://gateway.example', AGENT_LAB_GATEWAY_CERT_PATH: '/cert.pem', AGENT_LAB_GATEWAY_KEY_PATH: '/key.pem',
  }), []);
});

test('names the configured files it cannot read', async () => {
  // Internal projects write certificate paths relative to their repository's root; Agent Lab started from another folder
  // does not find them, and that has to be said plainly.
  const directory = await certDirectory();
  assert.deepEqual(unreadableGigaFiles({
    AGENT_LAB_GATEWAY_URL: 'https://gateway.example',
    AGENT_LAB_GATEWAY_CERT_PATH: join(directory, 'cert.pem'),
    AGENT_LAB_GATEWAY_KEY_PATH: 'certs/tls.key',
    AGENT_LAB_GATEWAY_CA_PATH: join(directory, 'ca.pem'),
  }), ['AGENT_LAB_GATEWAY_KEY_PATH']);
  assert.deepEqual(unreadableGigaFiles({}), []);
});

test('a configured but unreadable certificate path fails loudly', async () => {
  const directory = await certDirectory();
  assert.throws(() => readGigaConfig({
    AGENT_LAB_GATEWAY_URL: 'https://gateway.example',
    AGENT_LAB_GATEWAY_CERT_PATH: join(directory, 'absent.pem'),
    AGENT_LAB_GATEWAY_KEY_PATH: join(directory, 'key.pem'),
  }), /absent\.pem/);
});

test('request options carry the client certificate and honour the verification switch', async () => {
  const directory = await certDirectory();
  const config = readGigaConfig({
    AGENT_LAB_GATEWAY_URL: 'https://gateway.example/v1',
    AGENT_LAB_GATEWAY_CERT_PATH: join(directory, 'cert.pem'),
    AGENT_LAB_GATEWAY_KEY_PATH: join(directory, 'key.pem'),
    AGENT_LAB_GATEWAY_CA_PATH: join(directory, 'ca.pem'),
  })!;

  const post = requestOptions(config, '/v2/chat/completions', '{"model":"x"}', 60000);
  assert.equal(post.hostname, 'gateway.example');
  assert.equal(post.path, '/v2/chat/completions');
  assert.equal(post.method, 'POST');
  assert.equal(post.rejectUnauthorized, true);
  assert.equal(post.cert?.toString(), 'test-cert');
  assert.equal(post.key?.toString(), 'test-key');
  assert.equal(post.ca?.toString(), 'test-ca');
  assert.equal((post.headers as Record<string, unknown> | undefined)?.['Content-Type'], 'application/json');
  // The transport authenticates: there must be no authorization header.
  assert.equal(Object.keys(post.headers ?? {}).some(name => name.toLowerCase() === 'authorization'), false);

  const get = requestOptions(config, '/v1/models', undefined, 60000);
  assert.equal(get.method, 'GET');
  assert.deepEqual(get.headers, {});
});

test('the catalog of the gateway becomes the model list', async () => {
  const paths: string[] = [];
  const provider = await createGigaProvider({}, async path => { paths.push(path); return { status: 200, text: catalogBody }; });
  assert.deepEqual(paths, ['/v1/models']);
  assert.deepEqual(provider?.models?.map(model => model.id), ['GigaChat-3-Pro', 'glm-5.2']);
  // The judge is fixed at 16384 output tokens; a lower limit would cut a verdict silently.
  assert.ok((provider?.models?.[0]?.maxTokens ?? 0) >= 16384);
  assert.deepEqual(provider?.models?.[0]?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('an unreadable certificate path degrades to no provider instead of crashing the run', async () => {
  const directory = await certDirectory();
  const env = {
    AGENT_LAB_GATEWAY_URL: 'https://gateway.example',
    AGENT_LAB_GATEWAY_CERT_PATH: join(directory, 'absent.pem'),
    AGENT_LAB_GATEWAY_KEY_PATH: join(directory, 'key.pem'),
  };
  await assert.doesNotReject(createGigaProvider(env));
  assert.equal(await createGigaProvider(env), undefined);
});

test('the catalog request carries a short deadline of its own even without a run signal', async () => {
  let captured: GigaRequestOptions | undefined;
  await createGigaProvider({}, async (_path, _body, options) => { captured = options; return { status: 200, text: catalogBody }; });
  assert.equal(captured?.signal, undefined);
  assert.ok((captured?.timeoutMs ?? Infinity) <= 10_000);
});

test('an already aborted run signal is honoured by the catalog request', async () => {
  const controller = new AbortController();
  controller.abort();
  let captured: GigaRequestOptions | undefined;
  await createGigaProvider({}, async (_path, _body, options) => { captured = options; return { status: 200, text: catalogBody }; }, controller.signal);
  assert.equal(captured?.signal?.aborted, true);
});

test('without configuration or with an unusable catalog no provider is produced', async () => {
  assert.equal(await createGigaProvider({}), undefined);
  assert.equal(await createGigaProvider({}, async () => ({ status: 403, text: 'denied' })), undefined);
  assert.equal(await createGigaProvider({}, async () => ({ status: 200, text: 'not json' })), undefined);
  assert.equal(await createGigaProvider({}, async () => ({ status: 200, text: '{"data":[]}' })), undefined);
  assert.equal(await createGigaProvider({}, async () => { throw new Error('network down'); }), undefined);
});

test('a refused connection says whose certificate failed, from the exact codes Node reports', async () => {
  const failureOf = async (error: unknown) => {
    const connection = await connectGateway({}, async () => { throw error; });
    return 'failure' in connection ? connection.failure : undefined;
  };
  const coded = (code: string, message = 'x') => Object.assign(new Error(message), { code });
  // A TLS 1.2 gateway's alert reaches Node only as EPROTO with OpenSSL's record of it.
  const record = (packed: string, reason: string) => `write EPROTO C0CCA8EAF37F0000:error:${packed}:SSL routines:ssl3_read_bytes:${reason}:../deps/openssl/openssl/ssl/record/rec_layer_s3.c:918:\n`;
  assert.deepEqual(await Promise.all([
    failureOf(coded('DEPTH_ZERO_SELF_SIGNED_CERT')), failureOf(coded('CERT_HAS_EXPIRED')), failureOf(coded('ERR_TLS_CERT_ALTNAME_INVALID')),
    failureOf(coded('ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_EXPIRED')), failureOf(coded('ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED')),
    failureOf(coded('ERR_SSL_TLSV1_ALERT_UNKNOWN_CA')), failureOf(coded('EPROTO', record('0A000415', 'ssl/tls alert certificate expired'))),
    failureOf(coded('EPROTO', record('0A0000C6', 'packet length too long'))), failureOf(coded('ECONNREFUSED')),
    failureOf(new GigaTransportError('timeout', 'late')), failureOf(new Error('no code')),
  ]), [
    { kind: 'gateway certificate', code: 'DEPTH_ZERO_SELF_SIGNED_CERT', problem: 'chain' },
    { kind: 'gateway certificate', code: 'CERT_HAS_EXPIRED', problem: 'dates' },
    { kind: 'gateway certificate', code: 'ERR_TLS_CERT_ALTNAME_INVALID', problem: 'name' },
    // The owner's own certificate expired: an alert from the gateway, whatever words its code happens to contain.
    { kind: 'client certificate', code: 'ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_EXPIRED', alert: 45 },
    { kind: 'client certificate', code: 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED', alert: 45 },
    { kind: 'client certificate', code: 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA', alert: 48 },
    { kind: 'client certificate', code: 'EPROTO', alert: 45 },
    { kind: 'connection', code: 'EPROTO' }, { kind: 'connection', code: 'ECONNREFUSED' }, { kind: 'timeout' }, { kind: 'request failed' },
  ]);
});

/** A loopback HTTPS gateway: the self-signed loopback pair, `respond` for every request. */
function loopbackGateway(respond: Parameters<typeof createHttpsServer>[1]): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = createHttpsServer({ cert: readFileSync(loopbackCertPath), key: readFileSync(loopbackKeyPath) }, respond);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ url: `https://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
        close: () => { server.closeAllConnections(); return new Promise(done => server.close(() => done())); } });
    });
  });
}

test('which of the owner\'s files is wrong is named from the files themselves', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-giga-files-'));
  const garbage = join(directory, 'garbage.pem');
  await writeFile(garbage, 'not a certificate');
  const env = (paths: { cert?: string; key?: string; ca?: string }, url = 'https://127.0.0.1:9') => ({ AGENT_LAB_GATEWAY_URL: url,
    AGENT_LAB_GATEWAY_CERT_PATH: paths.cert ?? loopbackCertPath, AGENT_LAB_GATEWAY_KEY_PATH: paths.key ?? loopbackKeyPath, AGENT_LAB_GATEWAY_CA_PATH: paths.ca });
  const failureOf = async (environment: Record<string, string | undefined>) => {
    const connection = await connectGateway(environment);
    return 'failure' in connection ? connection.failure : undefined;
  };
  // A certificate or a key TLS cannot take fails before any request leaves.
  assert.deepEqual(await failureOf(env({ cert: garbage })), { kind: 'unusable file', file: 'certificate' });
  assert.deepEqual(await failureOf(env({ key: garbage })), { kind: 'unusable file', file: 'key' });
  // A CA file that is not a certificate is ignored by TLS; the gateway's chain then fails, and the file is named, not the chain.
  const selfSigned = await loopbackGateway((_request, response) => response.end());
  try {
    assert.deepEqual(await failureOf(env({ ca: garbage }, selfSigned.url)), { kind: 'unusable file', file: 'ca' });
    assert.deepEqual(await failureOf(env({}, selfSigned.url)), { kind: 'gateway certificate', code: 'DEPTH_ZERO_SELF_SIGNED_CERT', problem: 'chain' });
  } finally { await selfSigned.close(); }
  // A key that is not the certificate's pair: Node sends no certificate, and the gateway says it got none (alert 116).
  const alerting = createNetServer(socket => socket.once('data', () => socket.end(Buffer.from([21, 3, 3, 0, 2, 2, 116]))));
  await new Promise<void>(resolve => alerting.listen(0, '127.0.0.1', resolve));
  const address = alerting.address();
  const alertingUrl = `https://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    assert.deepEqual(await failureOf(env({ key: foreignKeyPath }, alertingUrl)), { kind: 'key mismatch' });
    assert.deepEqual(await failureOf(env({}, alertingUrl)), { kind: 'client certificate', code: 'EPROTO', alert: 116 });
  } finally { alerting.close(); }
});

test('a chat answer slower than the transport\'s default arrives within the caller\'s deadline', { timeout: 30000 }, async () => {
  // The gateway does not stream: nothing crosses the socket until the whole answer is ready, here after 1.5 s.
  const gateway = await loopbackGateway((request, response) => {
    if (request.url === '/v1/models') { response.writeHead(200).end(catalogBody); return; }
    setTimeout(() => response.writeHead(200).end(answerBody), 1500);
  });
  try {
    const config: GigaConfig = { baseUrl: gateway.url, cert: readFileSync(loopbackCertPath), key: readFileSync(loopbackKeyPath), ca: readFileSync(loopbackCertPath), rejectUnauthorized: true };
    const provider = await createGigaProvider({}, createGigaTransport(config, { timeoutMs: 1000 }));
    const model = { id: 'GigaChat-3-Pro', api: 'giga-v2', provider: 'giga' } as GigaModel;
    const context = { messages: [{ role: 'user' as const, content: 'Hi', timestamp: 1 }] };
    // Preparation allows a proposal minutes; the gateway's silence while it generates is not a failure.
    const message = await provider!.streamSimple!(model, context, { timeoutMs: 10_000 }).result();
    assert.deepEqual(message.content, [{ type: 'text', text: 'Hello' }]);
    // And a caller's shorter deadline is kept: the call fails as a timeout, not later.
    const lines = await capturedStderr(async () => {
      await assert.rejects(provider!.streamSimple!(model, context, { timeoutMs: 300 }).result(), (error: unknown) => error instanceof GigaTransportError && error.kind === 'timeout');
    });
    assert.deepEqual(lines, ['giga: запрос к модели GigaChat-3-Pro не прошёл (timeout)\n']);
  } finally { await gateway.close(); }
});

async function capturedStderr(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { await run(); } finally { process.stderr.write = original; }
  return lines;
}

test('each catalog failure is reported to stderr by category only, never a path or a response body', async () => {
  const cases: { category: string; run: () => Promise<unknown> }[] = [
    { category: 'bad configuration', run: () => createGigaProvider({
      AGENT_LAB_GATEWAY_URL: 'https://gateway.example', AGENT_LAB_GATEWAY_CERT_PATH: '/no/such/cert.pem', AGENT_LAB_GATEWAY_KEY_PATH: '/no/such/key.pem',
    }) },
    { category: 'connection UNABLE_TO_VERIFY_LEAF_SIGNATURE', run: () => createGigaProvider({}, async () => {
      throw Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
    }) },
    { category: 'connection ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_EXPIRED', run: () => createGigaProvider({}, async () => {
      throw Object.assign(new Error('ssl/tls alert certificate expired'), { code: 'ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_EXPIRED' });
    }) },
    { category: 'timeout', run: () => createGigaProvider({}, async () => { throw new GigaTransportError('timeout', 'Giga gateway did not answer within 10 s'); }) },
    { category: 'too large', run: () => createGigaProvider({}, async () => { throw new GigaTransportError('too large', 'Giga gateway response exceeds 2000000 bytes'); }) },
    { category: 'HTTP 403', run: () => createGigaProvider({}, async () => ({ status: 403, text: 'top secret denial body' })) },
    { category: 'bad JSON', run: () => createGigaProvider({}, async () => ({ status: 200, text: 'not json' })) },
    { category: 'empty catalog', run: () => createGigaProvider({}, async () => ({ status: 200, text: '{"data":[]}' })) },
  ];
  for (const { category, run } of cases) {
    const lines = await capturedStderr(run);
    assert.equal(lines.length, 1, category);
    assert.match(lines[0]!, new RegExp(`\\(${category}\\)`), category);
    assert.doesNotMatch(lines[0]!, /top secret|no\/such|cert\.pem|first certificate|alert certificate|Giga gateway/, category);
  }
});

test('a completed answer is delivered as start and done events', async () => {
  const { provider, sent } = await providerWith([{ status: 200, text: catalogBody }, { status: 200, text: answerBody }]);
  const model = { id: 'GigaChat-3-Pro', api: 'giga-v2', provider: 'giga' } as GigaModel;
  const stream = provider.streamSimple!(model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, { temperature: 0 });

  const events: string[] = [];
  for await (const event of stream) events.push(event.type);
  assert.deepEqual(events, ['start', 'done']);

  const message = await stream.result();
  assert.deepEqual(message.content, [{ type: 'text', text: 'Hello' }]);
  assert.equal(message.usage.input, 15);
  assert.equal(sent[1]?.path, '/v2/chat/completions');
  assert.deepEqual(sent[1]?.body, { model: 'GigaChat-3-Pro', messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
    model_options: { temperature: 0, reasoning: { effort: 'off' } } });
});

test('the judge payload hook is applied and normalized into model options', async () => {
  const { provider, sent } = await providerWith([{ status: 200, text: catalogBody }, { status: 200, text: answerBody }]);
  const model = { id: 'GigaChat-3-Pro', api: 'giga-v2', provider: 'giga' } as GigaModel;
  const options = {
    onPayload: (payload: Record<string, unknown>) => ({ ...payload, response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: { type: 'object' } } } }),
  } as never;
  await provider.streamSimple!(model, { messages: [{ role: 'user', content: 'grade', timestamp: 1 }] }, options).result();

  // The judge's schema lands next to the reasoning switch instead of replacing model_options.
  assert.deepEqual((sent[1]?.body as { model_options?: unknown }).model_options,
    { reasoning: { effort: 'off' }, response_format: { type: 'json_schema', schema: { type: 'object' }, strict: true } });
});

test('a gateway error surfaces as a failed model call, not as a parse error', async () => {
  const { provider } = await providerWith([{ status: 200, text: catalogBody }, { status: 429, text: '{"status":429,"message":"Too many requests"}' }]);
  const model = { id: 'GigaChat-3-Pro', api: 'giga-v2', provider: 'giga' } as GigaModel;
  await assert.rejects(
    provider.streamSimple!(model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, {}).result(),
    /429/,
  );
});

test('a gateway error message carries the status but never the response body', async () => {
  const { provider } = await providerWith([{ status: 200, text: catalogBody }, { status: 500, text: 'echo of the secret prompt' }]);
  const model = { id: 'GigaChat-3-Pro', api: 'giga-v2', provider: 'giga' } as GigaModel;
  await assert.rejects(
    provider.streamSimple!(model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, {}).result(),
    (error: Error) => /HTTP 500/.test(error.message) && !/secret prompt/.test(error.message),
  );
});

test('a failed model request names its category on stderr, because src/llm/model-call.ts sanitizes the error itself', async () => {
  const model = { id: 'GigaChat-3-Pro', api: 'giga-v2', provider: 'giga' } as GigaModel;
  const statusLines = await capturedStderr(async () => {
    const { provider } = await providerWith([{ status: 200, text: catalogBody }, { status: 500, text: 'echo of the secret prompt' }]);
    await provider.streamSimple!(model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, {}).result().catch(() => {});
  });
  assert.deepEqual(statusLines, ['giga: запрос к модели GigaChat-3-Pro не прошёл (HTTP 500)\n']);

  const timeoutLines = await capturedStderr(async () => {
    const provider = await createGigaProvider({}, async path =>
      path === '/v1/models' ? { status: 200, text: catalogBody } : Promise.reject(new GigaTransportError('timeout', 'Giga gateway did not answer within 120 s')));
    await provider!.streamSimple!(model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, {}).result().catch(() => {});
  });
  // A timeout reads as "access revoked" through model-call.ts's generic message; the category says otherwise.
  assert.deepEqual(timeoutLines, ['giga: запрос к модели GigaChat-3-Pro не прошёл (timeout)\n']);
});

test('a request the gateway rejects as asked (422) is named as a rejected request, not as an outage', async () => {
  const model = { id: 'glm-5.2', api: 'giga-v2', provider: 'giga' } as GigaModel;
  let failure: unknown;
  const lines = await capturedStderr(async () => {
    const { provider } = await providerWith([{ status: 200, text: catalogBody }, { status: 422, text: '{"detail":"echo of the secret prompt"}' }]);
    failure = await provider.streamSimple!(model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, {}).result().catch((error: unknown) => error);
  });
  assert.deepEqual(lines, ['giga: запрос к модели glm-5.2 не прошёл (HTTP 422: шлюз отверг параметры запроса)\n']);
  assert.ok(failure instanceof GigaRequestError);
  assert.deepEqual([failure.status, failure.rejected, /rejected the request with HTTP 422/.test(failure.message), /secret prompt/.test(failure.message)], [422, true, true, false]);
  // A status of a gateway that failed to serve is not a rejection.
  assert.deepEqual([new GigaRequestError(500).rejected, new GigaRequestError(429).rejected], [false, false]);
});

test('a successful status with a non-JSON body fails cleanly without echoing the body', async () => {
  const { provider } = await providerWith([{ status: 200, text: catalogBody }, { status: 200, text: '<html>secret proxy page</html>' }]);
  const model = { id: 'GigaChat-3-Pro', api: 'giga-v2', provider: 'giga' } as GigaModel;
  await assert.rejects(
    provider.streamSimple!(model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, {}).result(),
    (error: Error) => /non-JSON/.test(error.message) && !/secret proxy page/.test(error.message),
  );
});

test('a registered provider exposes its models through the Pi runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-giga-runtime-'));
  const runtime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'), modelsPath: null,
    modelsStorePath: join(directory, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false,
  });
  try {
    await registerGigaProvider(runtime, {}, async () => ({ status: 200, text: catalogBody }));
    assert.equal(runtime.getModel('giga', 'GigaChat-3-Pro')?.id, 'GigaChat-3-Pro');
    assert.deepEqual((await runtime.getAvailable('giga')).map(model => model.id), ['GigaChat-3-Pro', 'glm-5.2']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('registration is silent when the gateway is not configured', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-giga-empty-'));
  const runtime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'), modelsPath: null,
    modelsStorePath: join(directory, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false,
  });
  try {
    await registerGigaProvider(runtime, {});
    assert.equal(runtime.getModel('giga', 'GigaChat-3-Pro'), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('connecting names why the gateway is unavailable', async () => {
  const outcomes = await Promise.all([
    connectGateway({}),
    connectGateway({}, async () => ({ status: 403, text: 'denied' })),
    connectGateway({}, async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); }),
  ]);
  assert.deepEqual(outcomes.map(outcome => 'failure' in outcome ? outcome.failure : 'connected'),
    [{ kind: 'not configured' }, { kind: 'http', status: 403 }, { kind: 'connection', code: 'ENOTFOUND' }]);
  assert.deepEqual(outcomes.map(outcome => 'failure' in outcome ? failureLabel(outcome.failure) : 'connected'), ['not configured', 'HTTP 403', 'connection ENOTFOUND']);
});

test('a connected gateway lists its chat models', async () => {
  const connection = await connectGateway({}, async () => ({ status: 200, text: catalogBody }));
  assert.deepEqual('models' in connection ? connection.models : [], ['GigaChat-3-Pro', 'glm-5.2']);
});
