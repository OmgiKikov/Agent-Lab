import { z } from 'zod';
import type { Experiment } from './contracts.js';
import type { ImportBatch } from './scenario-contracts.js';
import { verifiedImport } from './scenario-library.js';
import type { ExperimentStore } from './store.js';

/*
 * A saved suite (`save-suite`): the definition of a run and, for a card library, the logs its situations are made
 * from. A card library cites its import batches by id and content hash and never copies them (card/schema.ts), so
 * without them another data folder can neither show the situations' statuses nor check or calibrate them. The
 * suite carries every batch its definition cites, verbatim; a load verifies each against its own content and
 * against the citation the accepted library sealed before the store keeps it. The topics of the logs travel in
 * the library itself (its traffic). A first-format library carries its batches inside itself, and a suite saved
 * before card suites carried their logs has none to verify: both load as they always did.
 *
 *   { format: 'agent-lab-suite-1', definition, imports?: ImportBatch[] }
 */

export const SUITE_FORMAT = 'agent-lab-suite-1';

type Citation = { id: string; contentHash: string };

/** The imports a card-format definition cites: its library's, and the one its preparation read. The other formats cite none here. */
function citations(record: Pick<Experiment, 'librarySnapshot' | 'originalImport'>): Citation[] {
  const library = record.librarySnapshot;
  if (library?.formatVersion !== 2) return [];
  const cited = [...library.imports, ...record.originalImport ? [record.originalImport] : []];
  return cited.filter((item, index) => cited.findIndex(other => other.id === item.id) === index);
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * The suite file of `definition` with its connection written relative to the file (`target`, connection.ts
 * portableTarget); the batches it cites come from `store`, each the very one the definition cites.
 */
export async function suiteText(store: Pick<ExperimentStore, 'readImport'>, definition: Experiment, target: unknown): Promise<string> {
  const imports: ImportBatch[] = [];
  for (const cited of citations(definition)) {
    const batch = await store.readImport(cited.id).catch(error => {
      if (missing(error)) throw new Error('Логов, из которых сделаны ситуации, в этой папке нет: без них набор не сохранить. Сохраните его из папки, где ситуации готовили.');
      throw error;
    });
    if (batch.contentHash !== cited.contentHash) throw new Error('Логи в этой папке не те, из которых сделаны ситуации: набор не сохранён.');
    imports.push(batch);
  }
  return `${JSON.stringify({ format: SUITE_FORMAT, definition: { ...definition, target }, ...imports.length ? { imports } : {} }, null, 2)}\n`;
}

/**
 * The batches a suite file carries, verified before anything is written: each is what its own rows hash to, every
 * batch the definition cites is there under the cited hash, and nothing else is. A file without `imports` carries none.
 */
export function carriedImports(raw: { imports?: unknown }, record: Pick<Experiment, 'librarySnapshot' | 'originalImport'>): ImportBatch[] {
  if (raw.imports === undefined) return [];
  const list = z.array(z.unknown()).max(30).safeParse(raw.imports);
  if (!list.success) throw new Error('Набор повреждён: логи в нём не читаются.');
  const carried = list.data.map(verifiedImport);
  const cited = citations(record);
  if (carried.some(batch => !cited.some(item => item.id === batch.id))) throw new Error('Набор повреждён: в нём логи, на которые не ссылается ни одна ситуация.');
  return cited.map(item => {
    const batch = carried.find(candidate => candidate.id === item.id);
    if (!batch || batch.contentHash !== item.contentHash) throw new Error('Набор повреждён: в нём нет логов, из которых сделаны ситуации. Сохраните его заново.');
    return batch;
  });
}
