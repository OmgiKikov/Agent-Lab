import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { IMPORT_FILE_BYTES } from '../limits.js';
import { readCsv, type CsvDialect } from './csv.js';
import type { Sheet } from './sheet.js';
import { readXlsx } from './xlsx.js';

/*
 * A spreadsheet export of logged conversations, read whole: the same size limit as a JSON import. The
 * bytes are hashed as read, so a confirmed mapping stays tied to the exact file it was confirmed on.
 */

export const TABLE_FORMATS = ['xlsx', 'csv'] as const;
export type TableFormat = typeof TABLE_FORMATS[number];
/** Extensions Lab reads as a table of conversations; project detection looks for the same ones. */
export const TABLE_EXTENSIONS: ReadonlyMap<string, TableFormat> = new Map([['.xlsx', 'xlsx'], ['.csv', 'csv']]);
/** Formats an owner may have, each with the way to a readable one. */
const OTHER_FORMATS: Readonly<Record<string, string>> = {
  '.xls': 'книгу Excel 97–2003 (.xls)', '.xlsm': 'книгу Excel с макросами (.xlsm)', '.xlsb': 'двоичную книгу Excel (.xlsb)',
  '.ods': 'таблицу OpenDocument (.ods)', '.numbers': 'таблицу Numbers', '.tsv': 'файл .tsv',
};

export interface TableFile { name: string; bytes: number; sha256: string; format: TableFormat }
export interface Workbook { format: TableFormat; sheets: Sheet[]; csv?: CsvDialect }

/** The format of a file by its extension, or a refusal that says how to get a readable one. */
export function tableFormat(path: string): TableFormat {
  const extension = extname(path).toLowerCase();
  const format = TABLE_EXTENSIONS.get(extension);
  if (format) return format;
  // Logs in JSON need no reading confirmed: they are read as written when situations are built from them.
  if (extension === '.json' || extension === '.jsonl') throw new Error(`Логи в JSON Lab читает сам, без разметки: agent-lab build --input задача.json --dialogues-file ${basename(path)}. Роли, которых Lab не знает, — флагом --roles client=клиент,operator=агент.`);
  const other = OTHER_FORMATS[extension];
  throw new Error(other ? `Lab читает таблицы .xlsx и .csv; ${other} сохраните как .xlsx или .csv.` : `Файл «${basename(path)}» — не таблица: Lab читает таблицы .xlsx и .csv.`);
}

/** What identifies a table file: its name, size, format and the hash of its bytes. */
export const tableFileOf = (path: string, bytes: Buffer): TableFile =>
  ({ name: basename(path), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), format: tableFormat(path) });

/** The file's bytes within the import limit, and what identifies them. */
export async function readTableFile(path: string): Promise<{ file: TableFile; bytes: Buffer }> {
  tableFormat(path);
  if ((await stat(path)).size > IMPORT_FILE_BYTES) throw new Error(`Файл больше ${IMPORT_FILE_BYTES / 1_000_000} МБ. Выгрузите меньший период или оставьте в таблице только нужные колонки.`);
  const bytes = await readFile(path);
  return { file: tableFileOf(path, bytes), bytes };
}

/** The sheets of a workbook; a CSV file is one sheet named after the file. A confirmed CSV dialect — or the part the owner named — is used as given. */
export function readWorkbook(bytes: Buffer, file: Pick<TableFile, 'name' | 'format'>, dialect?: Partial<CsvDialect>): Workbook {
  if (file.format === 'xlsx') return { format: 'xlsx', sheets: readXlsx(bytes) };
  const { rows, dialect: read } = readCsv(bytes, dialect);
  return { format: 'csv', sheets: [{ name: basename(file.name, extname(file.name)), rows }], csv: read };
}
