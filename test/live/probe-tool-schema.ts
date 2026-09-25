// Diagnostic only: which tool declaration does the gateway actually accept?
//   node --import tsx test/live/probe-tool-schema.ts MODEL
// Normal runs hide the gateway's own error behind a sanitized message, so this sends the
// variants directly and prints the HTTP status with the gateway's reply. Needs the same
// AGENT_LAB_GATEWAY_* variables as the other live scripts (docs/REFERENCE.md).
//
// Step 0 uses the gateway's own POST /v1/functions/validate endpoint (from the official
// GigaChat B2Bank OpenAPI spec): it checks one function description against GigaChat's JSON
// Schema subset and returns explicit errors/warnings with a schema_location, no model call
// spent. Step 1 still sends the variants through real chat completions, because validate only
// checks a single function in isolation, not how the gateway behaves with two declared at once.
import assert from 'node:assert/strict';
import { createGigaTransport, readGigaConfig } from '../../src/giga-transport.js';

interface Specification { name: string; description: string; parameters: Record<string, unknown> }

const model = process.argv[2];
assert(model, 'Usage: node --import tsx test/live/probe-tool-schema.ts MODEL');
const config = readGigaConfig();
assert(config, 'Set AGENT_LAB_GATEWAY_URL, AGENT_LAB_GATEWAY_CERT_PATH and AGENT_LAB_GATEWAY_KEY_PATH first');
const transport = createGigaTransport(config, 60000);

// GigaChat's functions/validate errors (a live run, quoted verbatim):
//   "Property 'properties' does not match the schema" at #/properties/parameters
//   "Property 'recordId' does not match the pattern schema" at #/patternProperties/recordId
//   "Required property 'description' is missing"
//   chat/completions 422: "Field 'properties.changes.properties' is missing"
// Read together: every object-typed property needs its OWN nested `properties`, recursively;
// extra JSON-Schema keys (minLength/maxLength/required/additionalProperties) are not tolerated;
// every property needs a description. update_record's `changes` is a dynamic map (the set of
// writable fields differs per record), which cannot list its properties in advance — so these
// variants test encoding it as a plain string instead of a nested object schema.
const recordId = { type: 'string', description: 'The exact record ID.' };
const lookupBare: Specification = {
  name: 'lookup_record', description: 'Read an existing sandbox record by its exact ID.',
  parameters: { properties: { recordId } },
};
const lookupWithType: Specification = {
  name: 'lookup_record', description: 'Read an existing sandbox record by its exact ID.',
  parameters: { type: 'object', properties: { recordId }, required: ['recordId'] },
};
const update = (changes: Record<string, unknown>): Specification => ({
  name: 'update_record', description: 'Update existing, explicitly writable fields in an existing record.',
  parameters: { properties: { recordId, changes } },
});

const variants: { name: string; specifications: Specification[] }[] = [
  { name: 'lookup_record: bare properties, described, no type/required', specifications: [lookupBare] },
  { name: 'lookup_record: with type object and required (today\'s shape, minus min/maxLength)', specifications: [lookupWithType] },
  { name: 'update_record: changes as a described string instead of a nested object', specifications: [update({ type: 'string', description: 'A JSON object of field:value pairs to change, encoded as a string, e.g. {"status":"delivered"}.' })] },
  { name: 'update_record: changes as a bare described object (no nested properties)', specifications: [update({ type: 'object', description: 'A map of field:value pairs to change.' })] },
];

console.log('--- step 0: POST /v1/functions/validate on each function alone ---');
const bySpecName = new Map<string, Specification>();
for (const variant of variants) for (const spec of variant.specifications) bySpecName.set(spec.name, spec);
for (const spec of bySpecName.values()) {
  try {
    const response = await transport('/v1/functions/validate', spec);
    console.log(JSON.stringify({ function: spec.name, status: response.status, reply: response.text.slice(0, 500) }));
  } catch (error) {
    console.log(JSON.stringify({ function: spec.name, error: error instanceof Error ? error.message : String(error) }));
  }
}

console.log('--- step 1: full chat/completions with each tool declaration ---');
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
