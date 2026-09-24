/*
 * A sheet the way both readers hand it over: a grid of cell texts exactly as the file stores them. Row 1 of
 * the file is index 0, column A is index 0, an empty cell is ''. Nothing is typed or trimmed here: what a
 * cell means is decided by the owner's confirmed mapping, not by the reader.
 */

export interface Sheet { name: string; rows: string[][] }

/** Far above any export of logged conversations; a bigger sheet is not something Lab can read in one piece. */
export const SHEET_ROWS = 100_000;
export const SHEET_COLUMNS = 1_000;

export const cellOf = (sheet: Sheet, row: number, column: number): string => sheet.rows[row]?.[column] ?? '';

/** The letters the owner sees above a column: 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let letters = '';
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) letters = String.fromCharCode(65 + (rest - 1) % 26) + letters;
  return letters;
}

/** The index of a column named by its letters (either case); undefined for anything that is not letters. */
export function columnIndex(letters: string): number | undefined {
  if (!letters || letters.length > 3) return undefined;
  let index = 0;
  for (const char of letters.toUpperCase()) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) return undefined;
    index = index * 26 + code - 64;
  }
  return index - 1;
}

export function tooManyRows(): Error { return new Error(`В листе больше ${SHEET_ROWS.toLocaleString('ru-RU')} строк — Lab такие таблицы не читает. Оставьте в выгрузке нужный период.`); }
export function tooManyColumns(): Error { return new Error(`В листе больше ${SHEET_COLUMNS.toLocaleString('ru-RU')} колонок — Lab такие таблицы не читает.`); }
