// Run with: node --import tsx docs/reviews/2026-09-25/reproduce-provider-retry.mjs /absolute/path/to/review-checkout
// Local HTTP only. Exit 0 means the experiment completed, not that the behavior is correct.
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const root = resolve(process.argv[2] ?? '.');
const { callModel } = await import(pathToFileURL(join(root, 'src/llm/model-call.ts')));
const { callContext } = await import(pathToFileURL(join(root, 'test/helpers/pi-fixture.ts')));
const dir = await mkdtemp(join(tmpdir(), 'lab-review-network-'));
let accepted = 0;
const server = createServer(async (req) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (JSON.parse(body).messages.length) accepted++;
  // The request has arrived. The client cannot know what processing happened before the socket broke.
  req.socket.destroy();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
try {
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(dir, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('local-audit', { api: 'openai-completions', apiKey: 'local-test',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'test-model', name: 'local',
      reasoning: false, input: ['text'], cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      contextWindow: 200000, maxTokens: 16384 }] });
  const { ctx, usage } = callContext({ limit: 1, timeoutMs: 2000 });
  try {
    await callModel(runtime, runtime.getModel('local-audit', 'test-model'), { system: 'test',
      messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }], maxTokens: 10 }, ctx);
  } catch (error) {
    console.log(JSON.stringify({ acceptedRequests: accepted, usage, kind: error.kind,
      delivery: error.delivery, message: error.message }));
  }
} finally {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
