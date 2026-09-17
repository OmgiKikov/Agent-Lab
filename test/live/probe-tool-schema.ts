// Diagnostic only: which tool declaration does the gateway actually accept?
//   node --import tsx test/live/probe-tool-schema.ts MODEL
// Normal runs hide the gateway's own error behind a sanitized message, so this sends the
// variants directly and prints the HTTP status with the gateway's reply. Needs the same
// GIGACHAT_* variables as the other live scripts (docs/REFERENCE.md).
import assert from 'node:assert/strict';
import { createGigaTransport, readGigaConfig } from '../../src/giga-transport.js';

interface Specification { name: string; description: string; parameters: Record<string, unknown> }

const model = process.argv[2];
assert(model, 'Usage: node --import tsx test/live/probe-tool-schema.ts MODEL');
const config = readGigaConfig();
assert(config, 'Set GIGACHAT_URL, GIGACHAT_CERT_PATH and GIGACHAT_KEY_PATH first');
const transport = createGigaTransport(config, 60000);

const recordId = { type: 'string', minLength: 1, maxLength: 1000 };
const lookup: Specification = {
  name: 'lookup_record', description: 'Read an existing sandbox record by its exact ID.',
  parameters: { type: 'object', properties: { recordId }, required: ['recordId'], additionalProperties: false },
};
// Exactly what src/sandbox.ts declares today, including the union type and the property counts.
const changesAsSentToday = { type: 'object', minProperties: 1, maxProperties: 16, additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } };
const update = (changes: Record<string, unknown>): Specification => ({
  name: 'update_record', description: 'Update existing, explicitly writable fields in an existing record.',
  parameters: { type: 'object', properties: { recordId, changes }, required: ['recordId', 'changes'], additionalProperties: false },
});

const variants: { name: string; specifications: Specification[] }[] = [
  { name: 'one spec: lookup_record', specifications: [lookup] },
  { name: 'one spec: update_record as sent today', specifications: [update(changesAsSentToday)] },
  { name: 'two specs as sent today', specifications: [lookup, update(changesAsSentToday)] },
  { name: 'two specs, changes with a single type instead of a union', specifications: [lookup, update({ type: 'object', minProperties: 1, maxProperties: 16, additionalProperties: { type: 'string' } })] },
  { name: 'two specs, changes without minProperties/maxProperties', specifications: [lookup, update({ type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } })] },
  { name: 'two specs, changes as a bare object', specifications: [lookup, update({ type: 'object' })] },
];

for (const variant of variants) {
  const body = {
    model,
    messages: [{ role: 'user', content: [{ text: 'What is the status of order A-1024?' }] }],
    model_options: { max_tokens: 64 },
    tools: [{ functions: { specifications: variant.specifications } }],
  };
  try {
    const response = await transport('/v2/chat/completions', body);
    console.log(JSON.stringify({ variant: variant.name, status: response.status, reply: response.text.slice(0, 300) }));
  } catch (error) {
    console.log(JSON.stringify({ variant: variant.name, error: error instanceof Error ? error.message : String(error) }));
  }
}
