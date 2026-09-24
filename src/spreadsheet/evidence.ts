import { analyzeSheet, columnNames, filledValues, isNumeric, type SheetAnalysis } from './analysis.js';
import { FILTER_VALUES, VALUE_CHARS, type ColumnInfo } from './mapping.js';
import { candidateTokens, type CandidateToken } from './markers.js';
import { cellOf } from './sheet.js';
import type { Workbook } from './workbook.js';

/*
 * What Lab's model reads of a spreadsheet to propose how to read it: the fewest rows that decide the reading, and
 * the rest as counts over every row. For each sheet, its columns — how full, how many distinct values, how long a
 * cell is; the most frequent values of a column of categories (who writes, which agent, which channel); the words a
 * column of texts could mark messages with. Then a few rows as written: the first ones, and for each such word not
 * yet in them the first row that holds it — each cell cut at CELL_CHARS, all of them within SAMPLE_BYTES. These are
 * the logs preparation sends to the same builder model anyway; the owner is told how many rows went.
 */

/** Bumped whenever what the model is shown changes: a reading proposed from other evidence is proposed again. */
export const EVIDENCE_VERSION = 1;
const SHEETS = 10;
const COLUMNS = 60;
/** Rows shown from the top of a sheet; rows that show a marker not seen in them come on top, up to SAMPLE_ROWS. */
const FIRST_ROWS = 4;
const SAMPLE_ROWS = 8;
/** Enough of a conversation's cell to see how its messages are marked and separated; the rest is counted, not shown. */
const CELL_CHARS = 1200;
const SAMPLE_BYTES = 24_000;
/** Candidate markers per column of texts, the most frequent first: the export's own tags are among the most frequent words. */
const CANDIDATES = 20;
/** The owner's words about which conversations to evaluate. */
export const REQUEST_CHARS = 500;

export interface ColumnEvidence {
  /** The name a reading uses for the column (analysis.ts columnNames). */
  name: string;
  letter: string;
  filled: number;
  distinct: number;
  /** Characters in a filled cell, on average and at most. */
  chars: { mean: number; longest: number };
  /** `numbers`: numbers or dates; `categories`: short values several rows share; `text`: anything else. */
  kind: 'numbers' | 'categories' | 'text';
  /** Categories: the most frequent values, each with its rows; `moreValues` are not listed. */
  values?: { value: string; rows: number }[];
  moreValues?: number;
  /** Text: the words that could mark messages, with how often each stands at a word boundary and in how many cells. */
  markers?: CandidateToken[];
}
export interface SampleRow {
  /** The row as the owner counts rows (1 is the first). */
  row: number;
  /** The filled cells by column name, as written; a cell longer than CELL_CHARS is cut, and named in `cut`. */
  cells: Record<string, string>;
  cut?: string[];
}
export interface SheetEvidence { name: string; headerRow: number; rows: number; columns: ColumnEvidence[]; sample: SampleRow[] }
export interface TableEvidence { sheets: SheetEvidence[]; ownerRequest?: string }

const byCount = <T extends { key: string; count: number }>(a: T, b: T) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function describe(a: SheetAnalysis, column: ColumnInfo, name: string): ColumnEvidence {
  const cells = filledValues(a, column);
  const total = cells.reduce((sum, cell) => sum + cell.length, 0), longest = cells.reduce((most, cell) => Math.max(most, cell.length), 0);
  const base = { name, letter: column.letter, filled: column.filled, distinct: column.distinct, chars: { mean: Math.round(total / Math.max(1, cells.length)), longest } };
  if (isNumeric(a, column)) return { ...base, kind: 'numbers' };
  if (column.distinct >= 2 && column.distinct < column.filled && longest <= VALUE_CHARS) {
    const counts = new Map<string, number>();
    for (const cell of cells) counts.set(cell, (counts.get(cell) ?? 0) + 1);
    const values = [...counts].map(([key, count]) => ({ key, count })).sort(byCount);
    return { ...base, kind: 'categories', values: values.slice(0, FILTER_VALUES).map(item => ({ value: item.key, rows: item.count })),
      ...values.length > FILTER_VALUES ? { moreValues: values.length - FILTER_VALUES } : {} };
  }
  const markers = candidateTokens(cells, CANDIDATES);
  return { ...base, kind: 'text', ...markers.length ? { markers } : {} };
}

/** The first rows of the sheet, then the first row holding each candidate marker not yet shown, in the order of the sheet. */
function sampleOf(a: SheetAnalysis, columns: readonly { info: ColumnInfo; evidence: ColumnEvidence }[]): SampleRow[] {
  const picked = new Set(a.rows.slice(0, FIRST_ROWS));
  for (const { info, evidence } of columns) for (const marker of evidence.markers ?? []) {
    if (picked.size >= SAMPLE_ROWS) break;
    if ([...picked].some(row => cellOf(a.sheet, row, info.index).includes(marker.token))) continue;
    const row = a.rows.find(candidate => cellOf(a.sheet, candidate, info.index).includes(marker.token));
    if (row !== undefined) picked.add(row);
  }
  return [...picked].sort((x, y) => x - y).map(row => {
    const cells: Record<string, string> = {}, cut: string[] = [];
    for (const { info, evidence } of columns) {
      const cell = cellOf(a.sheet, row, info.index);
      if (!cell.trim()) continue;
      cells[evidence.name] = cell.length > CELL_CHARS ? cell.slice(0, CELL_CHARS) : cell;
      if (cell.length > CELL_CHARS) cut.push(evidence.name);
    }
    return { row: row + 1, cells, ...cut.length ? { cut } : {} };
  });
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** What the model is shown of `workbook`, and the owner's words about which conversations to evaluate, when they said any. */
export function tableEvidence(workbook: Workbook, ownerRequest?: string): TableEvidence {
  const sheets = workbook.sheets.slice(0, SHEETS).map(sheet => {
    const a = analyzeSheet(sheet);
    const columns = [...columnNames(a.columns)].filter(([, info]) => info.filled).slice(0, COLUMNS)
      .map(([name, info]) => ({ info, evidence: describe(a, info, name) }));
    return { name: sheet.name, headerRow: a.header + 1, rows: a.rows.length, columns: columns.map(item => item.evidence), sample: sampleOf(a, columns) };
  }).filter(sheet => sheet.rows > 0);
  // Over the cap, the sheet with the most rows shown gives up its last one, a row at a time; every sheet keeps one while it can.
  while (bytes(sheets.map(sheet => sheet.sample)) > SAMPLE_BYTES) {
    const fullest = sheets.reduce((most, sheet) => sheet.sample.length >= most.sample.length ? sheet : most, sheets[0]!);
    if (!fullest.sample.length) break;
    fullest.sample.pop();
  }
  const words = ownerRequest?.trim().slice(0, REQUEST_CHARS);
  return { sheets, ...words ? { ownerRequest: words } : {} };
}

/** How many rows of the table the model is shown. */
export const rowsShown = (evidence: TableEvidence): number => evidence.sheets.reduce((sum, sheet) => sum + sheet.sample.length, 0);
