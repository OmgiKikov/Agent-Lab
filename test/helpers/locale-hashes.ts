import { readFile } from 'node:fs/promises';
import { importBatch, libraryHash, snapshotDigest, verifiedImport } from '../../src/scenario-library.js';
import type { LibraryV1 } from '../../src/scenario-contracts.js';

/*
 * Started by scenario-library.test.ts in a process of its own, once per locale: prints the hashes a store keeps as
 * this process computes them — the stored first-format library's body, its receipt and its import, and a spreadsheet
 * import whose kept columns mix Cyrillic and Latin headers — and the collation the process runs with.
 */

const library = JSON.parse(await readFile(new URL('../fixtures/library-v1/library.json', import.meta.url), 'utf8')) as LibraryV1;
const spreadsheet = importBatch([{ id: 'd1', row: 2, columns: { 'Дата': '09.09.2026', agentCode: 'ACQUIRING_AGENT', 'Канал': 'чат', channel: 'web' },
  messages: [{ role: 'user', content: 'Помогите с возвратом.' }, { role: 'assistant', content: 'Назовите номер терминала.' }] }]);
process.stdout.write(JSON.stringify({ collation: new Intl.Collator().resolvedOptions().locale, library: libraryHash(library),
  receipt: snapshotDigest(library, library.acceptance!), import: verifiedImport(library.imports[0]).contentHash, spreadsheet: spreadsheet.id }));
