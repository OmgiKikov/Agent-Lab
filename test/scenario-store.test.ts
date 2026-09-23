import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ExperimentStore } from '../src/store.js';
import { libraryFixture } from './helpers/scenario-library.js';
import { acceptLibrary, editLibrary, libraryHash } from '../src/scenario-library.js';

test('library writes share writer ownership, atomic readers and same-hash CAS admits one winner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-store-'));
  const writer = new ExperimentStore(directory), reader = new ExperimentStore(directory);
  try {
    await writer.init();
    assert.equal(typeof writer.writeLibrary, 'function', 'ExperimentStore owns library writes');
    const library = libraryFixture();
    await assert.rejects(() => reader.writeLibrary(library), /писател/);
    await writer.writeLibrary(library);
    assert.equal((await reader.readLibrary(library.id)).revision, 1);
    const changed = editLibrary(library, libraryHash(library), { kind: 'remove_variant', variantId: 'variant_2', reason: 'Выбран первый' });
    const concurrent = await Promise.allSettled([writer.writeLibrary(changed, libraryHash(library)), writer.writeLibrary(changed, libraryHash(library))]);
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    await assert.rejects(() => writer.writeLibrary(changed, 'stale'), /измен|хеш/i);
    assert.equal((await reader.readLibrary(library.id)).revision, 2);
    assert.equal((await reader.readLibrary(library.id, libraryHash(library))).revision, 1);
    assert.deepEqual(await reader.list(), []);
    assert.equal((await stat(join(directory, 'libraries'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'libraries', library.id, 'current.json'))).mode & 0o777, 0o600);
    const batch = library.imports[0]!;
    await writer.writeImport(batch);
    const original = await writer.readImport(batch.id);
    await writer.writeImport({ ...batch, createdAt: '2026-09-21T00:00:00.000Z' });
    assert.deepEqual(await writer.readImport(batch.id), original, 'same content preserves first import timestamp');
  } finally { await writer.close(); await rm(directory, { recursive: true, force: true }); }
});

test('invalid experiment publication is rejected before any library pointer advances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-publish-'));
  const store = new ExperimentStore(directory);
  try {
    await store.init();
    const library = libraryFixture();
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
    const batch = libraryFixture().imports[0]!;
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
    const draft = libraryFixture(), accepted = acceptLibrary(draft, libraryHash(draft), ['variant_1']);
    await store.writeLibrary(accepted);
    const modified = structuredClone(accepted); modified.variants[0]!.title = 'Изменено';
    delete modified.acceptance;
    await assert.rejects(() => store.writeLibrary(modified, libraryHash(accepted)), /ревизи|Ревизи/);
    const forged = structuredClone(accepted); forged.revision++;
    await assert.rejects(() => store.writeLibrary(forged, libraryHash(accepted)), /изменены после утверждения/);
    assert.deepEqual(await store.readLibrary(accepted.id), accepted);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
