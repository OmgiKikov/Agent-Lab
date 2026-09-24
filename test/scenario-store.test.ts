import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hostGrant } from '../src/card/commands.js';
import { acceptLibraryV2 } from '../src/card/library.js';
import { libraryV2Schema } from '../src/card/schema.js';
import { fingerprint } from '../src/contracts.js';
import { createDemoRuntime, demoInput } from '../src/demo.js';
import { ExperimentLab } from '../src/experiment.js';
import { ExperimentStore } from '../src/store.js';
import { libraryHash } from '../src/scenario-library.js';
import { cardDraft } from './helpers/card-library.js';
import { storedLibraryV1 } from './helpers/library-v1.js';

test('library writes share writer ownership, atomic readers and same-hash CAS admits one winner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-store-'));
  const writer = new ExperimentStore(directory), reader = new ExperimentStore(directory);
  try {
    await writer.init();
    const { library, batch } = cardDraft();
    await assert.rejects(() => reader.writeLibrary(library), /писател/);
    await writer.writeLibrary(library);
    assert.equal((await reader.readLibrary(library.id)).revision, library.revision);
    const changed = libraryV2Schema.parse({ ...library, revision: library.revision + 1, cards: library.cards.slice(0, 1) });
    const concurrent = await Promise.allSettled([writer.writeLibrary(changed, libraryHash(library)), writer.writeLibrary(changed, libraryHash(library))]);
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    await assert.rejects(() => writer.writeLibrary(changed, 'stale'), /измен|хеш/i);
    assert.equal((await reader.readLibrary(library.id)).revision, changed.revision);
    assert.equal((await reader.readLibrary(library.id, libraryHash(library))).revision, library.revision);
    assert.deepEqual(await reader.list(), []);
    assert.equal((await stat(join(directory, 'libraries'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'libraries', library.id, 'current.json'))).mode & 0o777, 0o600);
    await writer.writeImport(batch);
    const original = await writer.readImport(batch.id);
    await writer.writeImport({ ...batch, createdAt: '2026-09-21T00:00:00.000Z' });
    assert.deepEqual(await writer.readImport(batch.id), original, 'same content preserves first import timestamp');
  } finally { await writer.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a stored first-format library is kept by its hash as it is, with the import batches it carries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-first-format-'));
  const store = new ExperimentStore(directory);
  try {
    await store.init();
    const library = storedLibraryV1();
    await store.writeLibrary(library);
    assert.equal(fingerprint(await store.readLibrary(library.id, libraryHash(library))), fingerprint(library));
    const batch = library.imports[0]!;
    assert.deepEqual(await store.readImport(batch.id), batch, 'the batches of a first-format library are kept next to every other import');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('invalid experiment publication is rejected before any library pointer advances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-publish-'));
  const store = new ExperimentStore(directory);
  try {
    await store.init();
    const { library } = cardDraft();
    await assert.rejects(() => store.publishLibrary({ id: 'bad-record' } as never, library));
    await assert.rejects(() => store.readLibrary(library.id), /ENOENT/);
    await assert.rejects(() => store.get('bad-record'), /ENOENT/);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('immutable import rejects a caller reusing its identity for different evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-immutable-'));
  const store = new ExperimentStore(directory);
  try {
    await store.init();
    const { batch } = cardDraft();
    await store.writeImport(batch);
    const altered = structuredClone(batch); altered.dialogues[0]!.events[0]!.content = 'Changed evidence';
    await assert.rejects(() => store.writeImport(altered), /неизмен|содержим|хеш/i);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('accepted revision cannot be replaced in place or published with a stale acceptance receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-frozen-'));
  const store = new ExperimentStore(directory);
  try {
    await store.init();
    const { library, evidence } = cardDraft();
    const accepted = acceptLibraryV2(library, libraryHash(library), library.cards.map(card => card.id), { evidence, maxTurns: 3 }).library;
    await store.writeLibrary(accepted);
    const modified = structuredClone(accepted); modified.cards[0]!.title = 'Изменено';
    delete modified.acceptance;
    await assert.rejects(() => store.writeLibrary(modified, libraryHash(accepted)), /ревизи|Ревизи/);
    const forged = structuredClone(accepted); forged.revision++;
    await assert.rejects(() => store.writeLibrary(forged, libraryHash(accepted)), /изменены после утверждения/);
    assert.deepEqual(await store.readLibrary(accepted.id), accepted);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('reopening completes a journaled library publication after a one-shot record write failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-recovery-'));
  const lab = new ExperimentLab(directory, createDemoRuntime());
  const reopened = new ExperimentLab(directory, createDemoRuntime());
  try {
    await lab.init(); const draft = await lab.create(demoInput()); await lab.waitForIdle();
    const before = await lab.readCards(draft.id);
    const store = lab.store as unknown as { saveRecord: (...args: unknown[]) => Promise<void> }, save = store.saveRecord.bind(store);
    let fail = true;
    store.saveRecord = async (...args: unknown[]) => {
      if (fail) { fail = false; throw Object.assign(new Error('one-shot experiment write failure'), { code: 'EIO' }); }
      return save(...args);
    };
    const remove = await lab.prepareCardCommand(draft.id, { kind: 'remove_card', cardId: before.library.cards[1]!.id }, { via: 'cli-yes' });
    await assert.rejects(() => lab.applyCardCommand(draft.id, remove, hostGrant(remove, 'confirmed')), /one-shot/);
    assert.equal((await lab.store.readLibrary(before.library.id)).revision, before.library.revision + 1, 'the library pointer moved');
    assert.equal((await lab.readCards(draft.id)).library.cards.length, 2, 'the record did not');
    await lab.close(); await reopened.init();
    const recovered = await reopened.readCards(draft.id);
    assert.equal(recovered.library.cards.length, 1, 'the journaled publication finishes when the store is opened again');
    await assert.rejects(() => reopened.applyCardCommand(draft.id, remove, hostGrant(remove, 'confirmed')), /измен|хеш|устарел/i, 'a command prepared on the old revision is refused');
    const next = await reopened.prepareCardCommand(draft.id, { kind: 'remove_card', cardId: recovered.library.cards[0]!.id }, { via: 'cli-yes' });
    assert.equal((await reopened.applyCardCommand(draft.id, next, hostGrant(next, 'confirmed'))).library.cards.length, 0);
  } finally { await lab.close(); await reopened.close(); await rm(directory, { recursive: true, force: true }); }
});
