import { SHEET_COLUMNS, SHEET_ROWS, tooManyColumns, tooManyRows } from './sheet.js';

/*
 * CSV per RFC 4180: fields separated by the delimiter, records by CRLF (a bare LF or CR is accepted too),
 * a field in double quotes may hold delimiters, line breaks and doubled quotes. Spreadsheet programs vary
 * where the RFC is silent, so the reading is told, not guessed, once the owner has confirmed it: the
 * delimiter and the encoding are part of the confirmed mapping. Detection only proposes them; the owner may
 * name either.
 */

export const DELIMITERS = [',', ';', '\t'] as const;
export type Delimiter = typeof DELIMITERS[number];
/**
 * Excel in a Russian locale saves «CSV» in Windows-1251 and «Unicode text» in UTF-16, in a Western locale in
 * Windows-1252; everything else writes UTF-8. Values are only ever appended: a confirmed mapping names one.
 */
export const ENCODINGS = ['utf-8', 'utf-16le', 'windows-1251', 'windows-1252'] as const;
export type Encoding = typeof ENCODINGS[number];
export interface CsvDialect { delimiter: Delimiter; encoding: Encoding }
/** Single-byte encodings read every byte: there is no invalid text in them to refuse. */
const SINGLE_BYTE: ReadonlySet<Encoding> = new Set(['windows-1251', 'windows-1252']);

/** Detection reads the beginning of the file; the whole file is parsed once, with the chosen delimiter. */
const SAMPLE_CHARS = 65_536;

/** The rows of a CSV file and the dialect they were read in: the one given, part by part, or the one detected. */
export function readCsv(bytes: Buffer, given?: Partial<CsvDialect>): { rows: string[][]; dialect: CsvDialect } {
  const encoding = given?.encoding ?? detectEncoding(bytes);
  const text = decode(bytes, encoding);
  const delimiter = given?.delimiter ?? detectDelimiter(text);
  return { rows: records(text, delimiter, false), dialect: { delimiter, encoding } };
}

/**
 * How text bytes are written: UTF-16 by its byte order mark, UTF-8 when every byte reads as UTF-8, else one of the two
 * single-byte encodings Excel and Notepad save in, told apart by where the letters 0xC0–0xFF stand (singleByte).
 * Documents are read the same way (materials.ts).
 */
export function textEncoding(bytes: Uint8Array): Encoding | 'utf-16be' {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return 'utf-8'; } catch { return singleByte(bytes); }
}

const high = (byte: number | undefined): boolean => byte !== undefined && byte >= 0xc0;
const latin = (byte: number | undefined): boolean => byte !== undefined && (byte >= 0x41 && byte <= 0x5a || byte >= 0x61 && byte <= 0x7a);
/**
 * Windows-1251 or Windows-1252, by the structure of the bytes 0xC0–0xFF — letters in both. In Windows-1251 they are
 * the Cyrillic alphabet: a Russian word is a run of them. In Windows-1252 they are accented Latin letters, one here and
 * there inside a word of plain Latin letters («Café», «naïve»). Whichever neighbour most of them have decides.
 */
function singleByte(bytes: Uint8Array): Encoding {
  let cyrillic = 0, western = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (!high(bytes[i])) continue;
    if (high(bytes[i - 1]) || high(bytes[i + 1])) cyrillic++;
    else if (latin(bytes[i - 1]) || latin(bytes[i + 1])) western++;
  }
  return western > cyrillic ? 'windows-1252' : 'windows-1251';
}

function detectEncoding(bytes: Buffer): Encoding {
  const encoding = textEncoding(bytes);
  if (encoding === 'utf-16be') throw new Error('Файл в кодировке UTF-16 BE — Lab её не читает. Сохраните таблицу как CSV в UTF-8.');
  return encoding;
}

function decode(bytes: Buffer, encoding: Encoding): string {
  // TextDecoder drops the byte order mark of UTF-8 and UTF-16 itself.
  try { return new TextDecoder(encoding, { fatal: !SINGLE_BYTE.has(encoding) }).decode(bytes); }
  catch { throw new Error(`Файл не читается в кодировке ${encoding === 'utf-8' ? 'UTF-8' : 'UTF-16'}. Сохраните таблицу как CSV в UTF-8.`); }
}

/** The delimiter that splits the most records into as many fields as the header has; a tie keeps the order of DELIMITERS. */
function detectDelimiter(text: string): Delimiter {
  const sample = text.slice(0, SAMPLE_CHARS);
  let best: { delimiter: Delimiter; score: number; width: number } = { delimiter: ',', score: -1, width: 0 };
  for (const delimiter of DELIMITERS) {
    const rows = records(sample, delimiter, true);
    // The last record of a cut sample may be cut too.
    if (sample.length < text.length) rows.pop();
    const width = rows[0]?.length ?? 0;
    const score = width < 2 ? 0 : rows.filter(row => row.length === width).length;
    if (score > best.score || score === best.score && width > best.width) best = { delimiter, score, width };
  }
  return best.delimiter;
}

/** Records of `text`; a quote left open at the end is a broken file unless the text is a cut sample (`partial`). */
function records(text: string, delimiter: string, partial: boolean): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, fieldStart = true, at = 0;
  const endRow = () => {
    row.push(field);
    if (row.length > SHEET_COLUMNS) throw tooManyColumns();
    rows.push(row);
    if (rows.length > SHEET_ROWS) throw tooManyRows();
    row = []; field = ''; fieldStart = true;
  };
  while (at < text.length) {
    if (quoted) {
      const quote = text.indexOf('"', at);
      if (quote === -1) { if (partial) { field += text.slice(at); at = text.length; break; } throw new Error(`CSV повреждён: в строке ${rows.length + 1} не закрыта кавычка.`); }
      field += text.slice(at, quote);
      if (text[quote + 1] === '"') { field += '"'; at = quote + 2; } else { quoted = false; at = quote + 1; }
      continue;
    }
    const char = text[at]!;
    if (char === '"' && fieldStart) { quoted = true; fieldStart = false; at++; continue; }
    if (char === delimiter) { row.push(field); field = ''; fieldStart = true; at++; continue; }
    if (char === '\r' || char === '\n') { endRow(); at += char === '\r' && text[at + 1] === '\n' ? 2 : 1; continue; }
    // Text after a closing quote, or a quote inside an unquoted field, is kept as written.
    let end = at + 1;
    while (end < text.length && text[end] !== delimiter && text[end] !== '\r' && text[end] !== '\n') end++;
    field += text.slice(at, end); fieldStart = false; at = end;
  }
  if (field !== '' || row.length > 0 || !fieldStart) endRow();
  return rows;
}
