import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { codeFacts, languageOf } from '../src/source-facts.js';

const factory = (source: string) => codeFacts(source, 'node').factory;

test('codeFacts sees every way a module exports createSession, and only under that name', () => {
  for (const source of [
    'export function createSession(input) { return { respond: m => m }; }',
    'export async function createSession({ initialState }) {}',
    'export const createSession = input => ({ respond: async m => m });',
    'export const createSession: Factory = make;',
    'function make() {}\nexport { other, make as createSession };',
    'exports.createSession = function (input) {};',
    'module.exports.createSession = make;',
    'module.exports = { version: 1, createSession, close() {} };',
    'module.exports = { createSession: make };',
  ]) assert.equal(factory(source), true, source);
  for (const source of [
    'module.exports = { factory: createSession };',
    'export { createSession as default };',
    'export default function createSession() {}',
    'function createSession() {}',
    'export function createSessionLater() {}',
  ]) assert.equal(factory(source), false, source);
});

test('codeFacts never reads comments, strings, template literals or regular expressions as code', () => {
  for (const source of [
    '// export function createSession() {}',
    '/* export const createSession = 1 */',
    "const example = 'export function createSession() {}';",
    'const example = "exports.createSession = make";',
    'const example = `export const createSession = ${1}`;',
    'const pattern = /export function createSession/u;',
    'if (ok) return /export const createSession/.test(text);',
  ]) assert.equal(factory(source), false, source);
  // A division is not a regular expression: the export after it is still seen.
  assert.equal(factory('const half = total / 2; const slash = "/";\nexport function createSession() {}'), true);
  assert.equal(factory('const ratio = (a + b) / c / d;\nexport function createSession() {}'), true);
});

test('codeFacts recognises a JSON-lines loop over stdin and the Agent Lab request fields, in Python and in Node', () => {
  const python = 'import json, sys\nfor line in sys.stdin:\n    request = json.loads(line)\n    print(json.dumps({"reply": request["message"], "sessionId": request.get("sessionId")}))\n';
  assert.deepEqual(codeFacts(python, 'python'), { factory: false, jsonLines: true, protocol: true });
  const generic = 'import json, sys\nfor line in sys.stdin:\n    print(json.dumps({"answer": json.loads(line)["question"]}))\n';
  assert.deepEqual(codeFacts(generic, 'python'), { factory: false, jsonLines: true, protocol: false });
  const node = "import { createInterface } from 'node:readline';\n"
    + 'for await (const line of createInterface({ input: process.stdin })) {\n'
    + '  const request = JSON.parse(line);\n  process.stdout.write(JSON.stringify({ reply: request.message, state: request.initialState }) + "\\n");\n}\n';
  assert.deepEqual(codeFacts(node, 'node'), { factory: false, jsonLines: true, protocol: true });
});

test('codeFacts ignores what a Python file only mentions in comments and docstrings', () => {
  const described = '"""Reads sys.stdin, json.loads each line and answers with json.dumps; sessionId and initialState."""\n'
    + '# for line in sys.stdin: json.loads(line); json.dumps(reply)\n'
    + "def createSession():\n    return 'initialState'.upper()\n";
  assert.deepEqual(codeFacts(described, 'python'), { factory: false, jsonLines: false, protocol: true });
  assert.equal(codeFacts('"""Keeps the sessionId of each request."""\nx = 1\n', 'python').protocol, false);
});

test('the shipped example adapters show the contract they document', async () => {
  const source = (file: string) => readFile(new URL(`../examples/${file}`, import.meta.url), 'utf8');
  assert.deepEqual(codeFacts(await source('echo-agent.py'), 'python'), { factory: false, jsonLines: true, protocol: true });
  assert.equal(codeFacts(await source('echo-agent.mjs'), 'node').factory, true);
});

test('languageOf names the programs Lab can start and nothing else', () => {
  assert.equal(languageOf('agent.py'), 'python');
  assert.equal(languageOf('src/Agent.MJS'), 'node');
  assert.equal(languageOf('adapter.mts'), 'node');
  assert.equal(languageOf('types.d.ts'), undefined);
  assert.equal(languageOf('bot.rb'), undefined);
});
