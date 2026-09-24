import test from 'node:test';
import assert from 'node:assert/strict';
import { experimentSchema, fingerprint } from '../src/contracts.js';
import { importBatch, libraryHash, verifiedAcceptance, verifyAcceptedRun } from '../src/scenario-library.js';
import { libraryV1File, storedLibraryV1 } from './helpers/library-v1.js';

const rawDialogues = [
  { id: 'terminal', messages: [{ role: 'user', content: 'Нужна помощь. Номер терминала: 1234' }] },
  { id: 'repeated', messages: [
    { role: 'user', content: 'Когда будет возврат?' },
    { role: 'assistant', content: 'Возврат займёт три дня' },
    { role: 'user', content: 'Значит через три дня?' },
  ] },
];

test('import preserves rich evidence and rejects invalid records individually', () => {
  const rich = { formatVersion: 1, dialogues: [
    { id: 'rich', observation: 'partial', events: [
      { type: 'message', role: 'user', content: 'Помогите' },
      { type: 'tool', name: 'lookup', arguments: { key: 'x' }, result: { status: 'pending' } },
      { type: 'retrieval', query: 'возврат', documents: [{ text: 'правило' }] },
      { type: 'state', snapshot: { status: 'pending' } },
    ] },
    { id: 'rich', messages: [{ role: 'user', content: 'Дубль' }] },
    { id: 'empty', messages: [{ role: 'user', content: ' ' }] },
    { id: 'masked', messages: [{ role: 'user', content: '[REDACTED]' }] },
  ] };
  const batch = importBatch(rich);
  assert.equal(batch.dialogues.length, 1);
  assert.equal(batch.rejected.length, 3);
  assert.equal(batch.dialogues[0]!.events[1]!.index, 1);
  assert.deepEqual(batch.dialogues[0]!.original, rich.dialogues[0]);
  assert.equal(batch.dialogues[0]!.observation, 'partial');
  assert.equal(importBatch(structuredClone(rich)).id, batch.id);
  assert.equal(importBatch({ dialogues: rawDialogues }).id, importBatch(rawDialogues).id);
  assert.throws(() => importBatch({ formatVersion: 999, dialogues: [] }), /верси|version/i);
  assert.throws(() => importBatch(Array.from({ length: 301 }, () => rawDialogues[0])), /300/);
});

test('an import keeps every message exactly as written, whitespace included', () => {
  const raw = [{ id: 'spaced', messages: [{ role: 'user', content: '  Личный номер: 1234  ' }] }];
  const batch = importBatch(raw);
  assert.equal(batch.dialogues[0]!.events[0]!.content, '  Личный номер: 1234  ');
  assert.deepEqual(batch.dialogues[0]!.original, raw[0]);
});

test('a first-format library changed after acceptance no longer matches its receipt', () => {
  const library = storedLibraryV1();
  assert.deepEqual(verifiedAcceptance(library).variantIds, ['known_number', 'late_number']);
  const changed = structuredClone(library);
  changed.variants[0]!.userState.opening = 'Изменено после принятия';
  assert.notEqual(libraryHash(changed), libraryHash(library));
  assert.throws(() => verifiedAcceptance(changed), /изменены после утверждения/);
});

test('an accepted first-format run is checked by its stored definition hashes: a card accepted without an execution block runs as accepted, an edited one is refused', async () => {
  const record = experimentSchema.parse(await libraryV1File('run.json'));
  const { execution: _execution, ...early } = record.scenarios[0]!;
  // A card accepted before cards carried an execution block: the run's acceptance entry holds its hash.
  record.scenarios[0] = early;
  record.acceptedTests = record.acceptedTests!.map(entry => entry.scenarioId === early.id ? { ...entry, definitionHash: fingerprint(early) } : entry);
  const before = JSON.stringify(record);
  assert.doesNotThrow(() => verifyAcceptedRun(record));
  assert.equal(JSON.stringify(record), before, 'verification reads the record and never rewrites it');
  record.scenarios[0]!.user.opening = 'Изменённый вход';
  assert.throws(() => verifyAcceptedRun(record), /отличается от утверждённой/);
});
