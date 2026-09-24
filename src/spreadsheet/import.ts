import type { ImportBatch } from '../scenario-contracts.js';
import type { ExperimentStore } from '../store.js';
import { importTable, type TablePreview } from './dialogues.js';
import { readReadingFiles } from './files.js';
import { tableReadingSchema, type TableChoices, type TableMapping, type TableReading } from './mapping.js';
import { proposeTable, type TableProposal } from './proposal.js';
import { readTableFile, readWorkbook, tableFileOf, type TableFile } from './workbook.js';

/*
 * A spreadsheet of logs becomes an import in two steps, and the owner stands between them: Lab proposes
 * how to read the file (nothing is written), the owner confirms, and only then is the import stored — with
 * the file's hash and the mapping, so reading the same file again gives the very same conversations.
 */

/** How Lab would read the file at `path`, with the owner's choices applied. Reads only. */
export async function proposeTableImport(path: string, choices: TableChoices = {}): Promise<TableProposal> {
  const { file, bytes } = await readTableFile(path);
  return proposeTable(readWorkbook(bytes, file), file, choices);
}

/** The same proposal from bytes the caller already read within its own limits (project detection). */
export function proposeTableBytes(path: string, bytes: Buffer): TableProposal {
  const file = tableFileOf(path, bytes);
  return proposeTable(readWorkbook(bytes, file), file);
}

/** The conversations of a file read with a mapping: an ordinary import and what the owner is shown about it. */
function readWithMapping(bytes: Buffer, file: TableFile, mapping: TableMapping): { batch: ImportBatch; preview: TablePreview } {
  const source = mapping.source;
  const workbook = readWorkbook(bytes, file, source.format === 'csv' ? { delimiter: source.delimiter, encoding: source.encoding } : undefined);
  const sheet = source.format === 'xlsx' ? workbook.sheets.find(item => item.name === source.sheet) : workbook.sheets[0];
  if (!sheet) throw new Error(`В файле «${file.name}» нет листа «${source.format === 'xlsx' ? source.sheet : file.name}».`);
  return importTable(sheet, mapping);
}

/**
 * Stores the import the owner confirmed. Only the host calls this, after the owner said yes to exactly
 * this proposal: the file must still be the one the proposal was made from.
 */
export async function confirmTableImport(store: ExperimentStore, path: string, proposal: TableProposal): Promise<{ batch: ImportBatch; reading: TableReading }> {
  if (proposal.status !== 'ready') throw new Error('Как читать таблицу, ещё не решено: сначала ответьте на вопрос Lab.');
  const { file, bytes } = await readTableFile(path);
  if (file.sha256 !== proposal.file.sha256) throw new Error(`Файл «${file.name}» изменился после того, как Lab показал разметку. Посмотрите её заново.`);
  const { batch, preview } = readWithMapping(bytes, file, proposal.mapping);
  if (!batch.dialogues.length) throw new Error('Загружать нечего: ни один разговор из таблицы не подошёл.');
  const reading = tableReadingSchema.parse({ file, mapping: proposal.mapping, confirmedAt: new Date().toISOString(),
    sheet: { dialogues: preview.dialogues, usable: preview.usable, taken: preview.taken, rejected: preview.rejected } });
  return { batch: await store.writeTableImport(batch, reading), reading };
}

/**
 * The import of a spreadsheet under the reading its owner confirmed last, from the data folder `directory`.
 * The same file gives the same import; a file never confirmed is refused, never guessed.
 */
export async function readConfirmedTable(path: string, directory: string): Promise<ImportBatch> {
  const { file, bytes } = await readTableFile(path);
  const confirmed = (await readReadingFiles(directory))
    .flatMap(entry => entry.readings.filter(reading => reading.file.sha256 === file.sha256).map(reading => ({ entry, reading })))
    .sort((a, b) => b.reading.confirmedAt.localeCompare(a.reading.confirmedAt) || a.entry.importId.localeCompare(b.entry.importId))[0];
  if (!confirmed) throw new Error(`Как читать таблицу «${file.name}», ещё не подтверждено: посмотрите разметку и подтвердите её (agent-lab import --file ${path}).`);
  const { batch } = readWithMapping(bytes, file, confirmed.reading.mapping);
  if (batch.id !== confirmed.entry.importId || batch.contentHash !== confirmed.entry.contentHash) {
    throw new Error(`Таблица «${file.name}» прочиталась не так, как при подтверждении. Подтвердите разметку заново.`);
  }
  return batch;
}
