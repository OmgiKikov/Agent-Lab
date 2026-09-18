// Diagnostic only: does the gateway accept the tools the Agent Lab conversation declares?
//   node --import tsx test/live/probe-conversation-tools.ts MODEL
//
// The outer conversation sends Pi's own tools plus the agent_lab_* tools. Their schemas are far
// richer than the sandbox's three tools (unions, $defs, length limits), and the gateway rejected the
// whole request with HTTP 422. This sends exactly what the provider would send, after its schema
// cleanup, and prints the gateway's own reply: normal runs hide it behind a sanitized message.
//
// Step 1 checks each declaration alone with POST /v1/functions/validate (no model call). It is
// stricter than chat completions: it also flags `required`, which live chat requests accept.
// Step 2 is decisive: one real chat request with every tool declared at once, as the conversation
// does. Needs the AGENT_LAB_GATEWAY_* variables (README).
import assert from 'node:assert/strict';
import { buildChatRequest } from '../../src/giga-protocol.js';
import { createGigaTransport, readGigaConfig } from '../../src/giga-transport.js';
import { conversationTools } from './conversation-tools.js';

const model = process.argv[2];
assert(model, 'Usage: node --import tsx test/live/probe-conversation-tools.ts MODEL');
const config = readGigaConfig();
assert(config, 'Set AGENT_LAB_GATEWAY_URL, AGENT_LAB_GATEWAY_CERT_PATH and AGENT_LAB_GATEWAY_KEY_PATH first');
const transport = createGigaTransport(config, 120000);

const tools = await conversationTools();
const request = buildChatRequest(model, {
  systemPrompt: 'You are a test harness. Do not call any tool.',
  messages: [{ role: 'user', content: 'Ответь одним словом: готово', timestamp: Date.now() }],
  tools,
} as never, { maxTokens: 32 });
const specifications = request.tools?.[0]?.functions.specifications ?? [];

console.log(`--- step 1: POST /v1/functions/validate, ${specifications.length} declarations ---`);
for (const spec of specifications) {
  try {
    const response = await transport('/v1/functions/validate', spec);
    console.log(JSON.stringify({ function: spec.name, status: response.status, reply: response.text.slice(0, 600) }));
  } catch (error) {
    console.log(JSON.stringify({ function: spec.name, error: error instanceof Error ? error.message : String(error) }));
  }
}

console.log(`--- step 2: POST /v2/chat/completions with all ${specifications.length} tools (decisive) ---`);
try {
  const response = await transport('/v2/chat/completions', request);
  console.log(JSON.stringify({ status: response.status, reply: response.text.slice(0, 2000) }));
  console.log(response.status === 200 ? 'OK: шлюз принял инструменты разговора.' : 'ОТКАЗ: причина — в reply выше.');
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
