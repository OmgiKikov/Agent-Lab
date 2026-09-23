import { zipArchive } from './zip.js';

/*
 * Synthetic .xlsx workbooks, built part by part the way Excel writes them, so spreadsheet tests never
 * need a real export. A string cell goes to the shared-string table unless it asks to be inline.
 */

export type CellSpec = string | number | boolean | null
  | { inline: string }                  // an inline string (<is><t>…</t></is>)
  | { rich: string[]; phonetic?: string } // a shared string of formatted runs, with an optional phonetic guide
  | { raw: string };                    // the cell element as written, for damaged or unusual cells
export interface SheetSpec { name: string; rows: CellSpec[][]; merges?: string[]; hidden?: true }

const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const letter = (column: number) => column < 26 ? String.fromCharCode(65 + column) : `${String.fromCharCode(64 + Math.floor(column / 26))}${String.fromCharCode(65 + column % 26)}`;

export function xlsxFile(sheets: SheetSpec[], options: { deflate?: boolean; extra?: Array<{ name: string; data: string | Buffer }> } = {}): Buffer {
  const shared: string[] = [];
  const sharedIndex = (xml: string) => { shared.push(xml); return shared.length - 1; };
  const cell = (spec: CellSpec, ref: string): string => {
    if (spec === null) return '';
    if (typeof spec === 'number') return `<c r="${ref}"><v>${spec}</v></c>`;
    if (typeof spec === 'boolean') return `<c r="${ref}" t="b"><v>${spec ? 1 : 0}</v></c>`;
    if (typeof spec === 'string') return `<c r="${ref}" t="s"><v>${sharedIndex(`<t xml:space="preserve">${escape(spec)}</t>`)}</v></c>`;
    if ('inline' in spec) return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escape(spec.inline)}</t></is></c>`;
    if ('rich' in spec) return `<c r="${ref}" t="s"><v>${sharedIndex(spec.rich.map(run => `<r><rPr><b/></rPr><t xml:space="preserve">${escape(run)}</t></r>`).join('')
      + (spec.phonetic ? `<rPh sb="0" eb="1"><t>${escape(spec.phonetic)}</t></rPh>` : ''))}</v></c>`;
    return spec.raw;
  };
  const worksheet = (sheet: SheetSpec) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheetData>' + sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((spec, c) => cell(spec, `${letter(c)}${r + 1}`)).join('')}</row>`).join('') + '</sheetData>'
    + (sheet.merges?.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map(ref => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>` : '')
    + '</worksheet>';
  const parts = sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: worksheet(sheet) }));
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
    + sheets.map((sheet, i) => `<sheet name="${escape(sheet.name)}" sheetId="${i + 1}"${sheet.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')
    + '</sheets></workbook>';
  const relations = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`
    + '</Relationships>';
  const strings = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map(xml => `<si>${xml}</si>`).join('')}</sst>`;
  return zipArchive([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', deflate: options.deflate },
    { name: 'xl/workbook.xml', data: workbook, deflate: options.deflate },
    { name: 'xl/_rels/workbook.xml.rels', data: relations, deflate: options.deflate },
    ...parts.map(part => ({ ...part, deflate: options.deflate })),
    { name: 'xl/sharedStrings.xml', data: strings, deflate: options.deflate },
    ...(options.extra ?? []),
  ]);
}
