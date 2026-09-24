import { parseOrder } from './dialogues.js';
import { HEADER_SCAN, columnLabel, type ColumnInfo } from './mapping.js';
import { cellOf, columnLetter, type Sheet } from './sheet.js';

/*
 * A sheet as both readings see it — the proposal of Lab's model (reading-task.ts) and Lab's own fallback
 * (proposal.ts): where the header is, which rows hold anything, and each column's trimmed cells.
 */

export interface SheetAnalysis {
  sheet: Sheet;
  /** The header row, counted from 0. */
  header: number;
  /** Rows below the header with anything in them. */
  rows: number[];
  columns: ColumnInfo[];
  /** Trimmed cells of each column, one per row of `rows`. */
  values: string[][];
}

/** Numbers or dates in nearly every filled cell: a column of positions or times, never of messages or roles. */
const NUMERIC = 0.9;

/** The header is the first row, among the first HEADER_SCAN, with two or more distinct names; a title above the table is skipped. */
export function analyzeSheet(sheet: Sheet): SheetAnalysis {
  let header = 0;
  for (let row = 0; row < Math.min(sheet.rows.length, HEADER_SCAN); row++) {
    const names = (sheet.rows[row] ?? []).map(cell => cell.trim()).filter(Boolean);
    if (names.length >= 2 && new Set(names).size === names.length) { header = row; break; }
  }
  const rows: number[] = [];
  let width = sheet.rows[header]?.length ?? 0;
  for (let row = header + 1; row < sheet.rows.length; row++) if (sheet.rows[row]!.some(cell => cell.trim())) { rows.push(row); width = Math.max(width, sheet.rows[row]!.length); }
  const values = Array.from({ length: width }, (_, column) => rows.map(row => cellOf(sheet, row, column).trim()));
  const columns = values.map((cells, index) => {
    const filled = cells.filter(Boolean);
    return { index, letter: columnLetter(index), header: cellOf(sheet, header, index).trim(), filled: filled.length, distinct: new Set(filled).size };
  });
  return { sheet, header, rows, columns, values };
}

export const filledValues = (a: SheetAnalysis, column: ColumnInfo): string[] => a.values[column.index]!.filter(Boolean);
export const isNumeric = (a: SheetAnalysis, column: ColumnInfo): boolean => filledValues(a, column).filter(value => parseOrder(value)).length >= column.filled * NUMERIC;

/**
 * One name per column that tells it apart from every other column of the sheet: the header, the letter when the
 * header is empty, «header (C)» when two columns share a header. A reading names its columns by these.
 */
export function columnNames(columns: readonly ColumnInfo[]): Map<string, ColumnInfo> {
  const labels = columns.map(columnLabel);
  return new Map(columns.map((column, i) => [labels.indexOf(labels[i]!) === labels.lastIndexOf(labels[i]!) ? labels[i]! : `${labels[i]} (${column.letter})`, column]));
}
