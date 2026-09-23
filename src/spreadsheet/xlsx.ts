import { posix } from 'node:path';
import { ArchiveTooLarge, zipEntries, zipRead } from '../zip.js';
import { localName, xmlTokens } from './xml.js';
import { SHEET_COLUMNS, SHEET_ROWS, columnIndex, tooManyColumns, tooManyRows, type Sheet } from './sheet.js';

/*
 * The worksheets of an .xlsx workbook: the archive's workbook part names the sheets, its relationships
 * say which part holds each one, the shared-string table holds most texts. A cell keeps the text the file
 * stores — the shared or inline string, the number as written, TRUE/FALSE — without number formats:
 * a date stays Excel's day count, which still orders correctly. A merged range shows its value in every
 * cell it covers, as the owner sees it on screen.
 */

/** Everything the parts of one workbook may unpack to; a 4 MB workbook of text unpacks to a few tens of megabytes. */
const XML_BYTES = 64_000_000;
/** The first bytes of an OLE compound file: an .xls book, or an .xlsx that Excel encrypted with a password. */
const COMPOUND_FILE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

const damaged = (what: string) => new Error(`Таблица повреждена: ${what}. Сохраните файл заново.`);

export function readXlsx(file: Buffer): Sheet[] {
  const entries = zipEntries(file);
  if (!entries) throw new Error(file.subarray(0, 4).equals(COMPOUND_FILE)
    ? 'Это книга Excel старого формата (.xls) или файл под паролем. Сохраните таблицу как .xlsx без пароля или как .csv.'
    : 'Файл не похож на таблицу Excel (.xlsx): это не ZIP-архив.');
  let unpacked = 0;
  const part = (name: string): string | undefined => {
    const entry = entries.find(item => item.name.toLowerCase() === name.toLowerCase());
    if (!entry) return undefined;
    try {
      const data = zipRead(file, entry, XML_BYTES - unpacked);
      unpacked += data.length;
      return data.toString('utf8');
    } catch (error) {
      if (error instanceof ArchiveTooLarge) throw new Error(`Таблица распаковывается больше чем в ${XML_BYTES / 1_000_000} МБ — Lab такие файлы не читает.`);
      throw error;
    }
  };
  const workbook = part('xl/workbook.xml');
  if (workbook === undefined) throw new Error('Файл не похож на таблицу Excel (.xlsx): в архиве нет xl/workbook.xml.');
  const relations = relationships(part('xl/_rels/workbook.xml.rels') ?? '');
  const sharedTarget = [...relations.values()].find(relation => relation.type.endsWith('/sharedStrings'))?.target;
  const shared = sharedStrings(part(sharedTarget ? partPath(sharedTarget) : 'xl/sharedStrings.xml') ?? '');
  return workbookSheets(workbook).flatMap(sheet => {
    const relation = relations.get(sheet.relation);
    // Chart and dialog sheets have no cells.
    if (!relation?.type.endsWith('/worksheet')) return [];
    const xml = part(partPath(relation.target));
    if (xml === undefined) throw damaged(`нет листа «${sheet.name}»`);
    return [{ name: sheet.name, rows: worksheetRows(xml, shared) }];
  });
}

/** A relationship target is relative to the workbook's folder, or absolute within the archive. */
const partPath = (target: string): string => target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target));

function relationships(xml: string): Map<string, { type: string; target: string }> {
  const relations = new Map<string, { type: string; target: string }>();
  for (const token of xmlTokens(xml)) if (token.kind === 'open' && localName(token.name) === 'Relationship') {
    const id = token.attributes.get('Id'), target = token.attributes.get('Target');
    if (id && target && token.attributes.get('TargetMode') !== 'External') relations.set(id, { type: token.attributes.get('Type') ?? '', target });
  }
  return relations;
}

/** Sheets in the workbook's order; each names its part through a relationship id (`r:id`, whatever the prefix). */
function workbookSheets(xml: string): { name: string; relation: string }[] {
  const sheets: { name: string; relation: string }[] = [];
  for (const token of xmlTokens(xml)) if (token.kind === 'open' && localName(token.name) === 'sheet') {
    const name = token.attributes.get('name');
    const relation = [...token.attributes].find(([key]) => key.includes(':') && localName(key) === 'id')?.[1];
    if (name && relation) sheets.push({ name, relation });
  }
  return sheets;
}

/** The shared-string table: plain or rich text (runs joined), without the phonetic guides some locales add. */
function sharedStrings(xml: string): string[] {
  const strings: string[] = [];
  let current: string | undefined, text = false, phonetic = 0;
  for (const token of xmlTokens(xml)) {
    if (token.kind === 'text') { if (text && current !== undefined && !phonetic) current += token.text; continue; }
    const name = localName(token.name);
    if (token.kind === 'open') {
      if (name === 'si') { if (token.empty) strings.push(''); else current = ''; }
      else if (name === 'rPh' && !token.empty) phonetic++;
      else if (name === 't') text = !token.empty;
    } else if (name === 'si' && current !== undefined) { strings.push(unescapeText(current)); current = undefined; }
    else if (name === 'rPh') phonetic--;
    else if (name === 't') text = false;
  }
  return strings;
}

interface OpenCell { row: number; column: number; type: string; value: string; inline: string }

function worksheetRows(xml: string, shared: readonly string[]): string[][] {
  const cells = new Map<number, Map<number, string>>();
  const merges: string[] = [];
  let row = -1, column = -1, phonetic = 0;
  let cell: OpenCell | undefined, collecting: 'v' | 't' | undefined;
  for (const token of xmlTokens(xml)) {
    if (token.kind === 'text') {
      if (cell && collecting === 'v') cell.value += token.text;
      else if (cell && collecting === 't' && !phonetic) cell.inline += token.text;
      continue;
    }
    const name = localName(token.name);
    if (token.kind === 'close') {
      if (name === 'v' || name === 't') collecting = undefined;
      else if (name === 'rPh') phonetic--;
      else if (name === 'c' && cell) { put(cells, cell.row, cell.column, cellText(cell, shared)); cell = undefined; }
      continue;
    }
    if (name === 'row') { row = rowIndex(token.attributes.get('r')) ?? row + 1; column = -1; }
    else if (name === 'c') {
      const reference = cellReference(token.attributes.get('r'));
      if (reference) { row = reference.row; column = reference.column; } else column++;
      cell = token.empty ? undefined : { row, column, type: token.attributes.get('t') ?? 'n', value: '', inline: '' };
    } else if ((name === 'v' || name === 't') && cell && !token.empty) collecting = name;
    else if (name === 'rPh' && !token.empty) phonetic++;
    else if (name === 'mergeCell') { const range = token.attributes.get('ref'); if (range) merges.push(range); }
  }
  return grid(cells, merges);
}

function cellText(cell: OpenCell, shared: readonly string[]): string {
  if (cell.type !== 'inlineStr' && cell.value === '') return '';
  switch (cell.type) {
    case 's': {
      const text = shared[Number(cell.value.trim())];
      if (text === undefined) throw damaged('ячейка ссылается на строку, которой нет');
      return text;
    }
    case 'inlineStr': return unescapeText(cell.inline);
    case 'b': return cell.value.trim() === '1' ? 'TRUE' : cell.value.trim() === '0' ? 'FALSE' : cell.value;
    // A number, a formula's cached text (str), an error (#N/A) or an ISO date (d), as written.
    default: return cell.value;
  }
}

function put(cells: Map<number, Map<number, string>>, row: number, column: number, text: string): void {
  if (text === '') return;
  if (row >= SHEET_ROWS) throw tooManyRows();
  if (column >= SHEET_COLUMNS) throw tooManyColumns();
  let columns = cells.get(row);
  if (!columns) cells.set(row, columns = new Map());
  columns.set(column, text);
}

/** Dense rows up to the last row with a value; each merged range repeats its top-left value over the cells it covers inside the data. */
function grid(cells: Map<number, Map<number, string>>, merges: string[]): string[][] {
  const last = largest(cells.keys());
  const rows: string[][] = Array.from({ length: last + 1 }, (_, row) => {
    const columns = cells.get(row);
    return Array.from({ length: columns ? largest(columns.keys()) + 1 : 0 }, (_, column) => columns?.get(column) ?? '');
  });
  for (const range of merges) {
    const [from, to] = range.split(':').map(cellReference);
    const value = from && rows[from.row]?.[from.column];
    if (!from || !to || !value) continue;
    for (let row = from.row; row <= Math.min(to.row, last); row++) {
      const cellsOfRow = rows[row]!;
      for (let column = from.column; column <= Math.min(to.column, SHEET_COLUMNS - 1); column++) {
        while (cellsOfRow.length <= column) cellsOfRow.push('');
        if (cellsOfRow[column] === '') cellsOfRow[column] = value;
      }
    }
  }
  return rows;
}

const largest = (values: Iterable<number>): number => { let most = -1; for (const value of values) if (value > most) most = value; return most; };

function rowIndex(text: string | undefined): number | undefined {
  const number = text === undefined ? NaN : Number(text);
  return Number.isInteger(number) && number >= 1 ? number - 1 : undefined;
}

/** `B12` → row 11, column 1; `$B$12` is the same cell. */
function cellReference(text: string | undefined): { row: number; column: number } | undefined {
  const plain = text?.replaceAll('$', '') ?? '';
  let split = 0;
  while (split < plain.length && columnIndex(plain.slice(0, split + 1)) !== undefined) split++;
  const column = columnIndex(plain.slice(0, split)), row = rowIndex(plain.slice(split));
  return column === undefined || row === undefined ? undefined : { row, column };
}

/** Office escapes characters XML cannot carry as `_xHHHH_` (`_x000D_` is a carriage return); `_x005F_` escapes the underscore itself. */
function unescapeText(text: string): string {
  if (!text.includes('_x')) return text;
  let result = '', at = 0;
  for (;;) {
    const start = text.indexOf('_x', at);
    if (start === -1) return result + text.slice(at);
    const hex = text.slice(start + 2, start + 6);
    const escaped = text[start + 6] === '_' && hex.length === 4 && [...hex].every(char => '0123456789abcdefABCDEF'.includes(char));
    result += text.slice(at, start) + (escaped ? String.fromCharCode(parseInt(hex, 16)) : '_x');
    at = escaped ? start + 7 : start + 2;
  }
}
