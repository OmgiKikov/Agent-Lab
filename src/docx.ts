import { decodeEntities, localName, XML_ENTITIES, xmlTokens } from './spreadsheet/xml.js';
import { ArchiveTooLarge, zipEntries, zipRead } from './zip.js';

/*
 * Text of a .docx file without external libraries: the archive is a ZIP, the body lives in word/document.xml, read by
 * the XML tokenizer the workbook reader uses (spreadsheet/xml.ts), never by patterns over the markup. The body becomes
 * lines, in document order:
 *
 *   a paragraph         its runs joined; a tab stays a tab, a line, page or column break breaks the line
 *   a text box, frame   its paragraphs are lines of their own; the paragraph it stands in keeps all its text
 *   a table             a line per row, its cells separated by tabs (a cell's paragraphs joined by spaces)
 *   an HTML chunk       <w:altChunk/> → word/afchunk.mht, how knowledge-base exports keep the whole body: flattened the
 *                       same way, block by block, in its place
 *
 * Deleted text, text moved away, field codes and the copy of a shape Word keeps for old readers (mc:Fallback) are
 * dropped, as are markup, images and styles. Every part read shares one budget of unpacked bytes.
 */

const DOCUMENT_PART = 'word/document.xml';
/** Everything the parts of one document may unpack to: no real document comes near it, a bigger one is an archive built to exhaust memory. */
const UNPACKED_BYTES = 64_000_000;
/** The namespaces of WordprocessingML, transitional and strict: their prefix names the elements read. */
const WORDPROCESSING = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);

const notWord = (why: string) => new Error(`Файл не является документом Word (.docx): ${why}.`);

export function docxText(file: Buffer): string {
  const part = partReader(file);
  const document = part(DOCUMENT_PART);
  if (!document) throw notWord('в архиве нет word/document.xml');
  let relations: Map<string, string> | undefined;
  const chunk = (id: string): string[] => {
    relations ??= relationships(part('word/_rels/document.xml.rels')?.toString('utf8') ?? '');
    const target = relations.get(id);
    const mht = target === undefined ? undefined : part(target.startsWith('/') ? target.slice(1) : `word/${target}`);
    return mht ? htmlLines(mhtHtml(mht)) : [];
  };
  return bodyLines(document.toString('utf8'), chunk).join('\n').trim();
}

/** The parts of the archive by name, each unpacked once, all of them within UNPACKED_BYTES. */
function partReader(file: Buffer): (name: string) => Buffer | undefined {
  const entries = zipEntries(file);
  if (!entries) throw notWord('это не ZIP-архив');
  let unpacked = 0;
  return name => {
    const entry = entries.find(item => item.name === name);
    if (!entry) return undefined;
    if (entry.method !== 0 && entry.method !== 8) throw new Error(`Документ Word сжат неподдерживаемым способом (${entry.method}).`);
    try {
      const data = zipRead(file, entry, UNPACKED_BYTES - unpacked);
      unpacked += data.length;
      return data;
    } catch (error) {
      if (error instanceof ArchiveTooLarge) throw new Error(`Документ Word распаковывается больше чем в ${UNPACKED_BYTES / 1_000_000} МБ — Lab такие файлы не читает.`);
      throw error;
    }
  };
}

/** The targets of the document's relationships by id; links out of the archive are not parts. */
function relationships(xml: string): Map<string, string> {
  const relations = new Map<string, string>();
  for (const token of xmlTokens(xml, 'document')) if (token.kind === 'open' && localName(token.name) === 'Relationship') {
    const id = token.attributes.get('Id'), target = token.attributes.get('Target');
    if (id && target && token.attributes.get('TargetMode') !== 'External') relations.set(id, target);
  }
  return relations;
}

/** Where the text of a paragraph goes: the lines of the body or of a text box, or the cell of a table row. */
type Frame = { kind: 'lines' } | { kind: 'row'; cells: string[] } | { kind: 'cell'; parts: string[] };

/** A cell is one field of its row's line: its own tabs and breaks become spaces. */
const inCell = (text: string): string => [...text].map(char => char === '\t' || char === '\n' ? ' ' : char).join('').trim();

/** The lines of the document body; `chunk` gives the lines of an HTML chunk by its relationship id. */
function bodyLines(xml: string, chunk: (id: string) => string[]): string[] {
  const lines: string[] = [];
  const frames: Frame[] = [{ kind: 'lines' }];
  // The open paragraphs, the innermost last, and how deep in runs each is: a tab stop in a paragraph's properties is no tab.
  const paragraphs: string[] = [], runs: number[] = [];
  let prefix = 'w', text = false, skipped = 0;
  const inRun = () => (runs.at(-1) ?? 0) > 0;
  const emit = (line: string) => {
    const frame = frames.at(-1)!;
    if (frame.kind === 'cell') { if (line.trim()) frame.parts.push(inCell(line)); }
    else if (line.trim()) lines.push(line);
  };
  const add = (value: string) => { if (paragraphs.length) paragraphs[paragraphs.length - 1] += value; };
  const close = (name: string) => {
    if (name === 'Fallback' || name === 'moveFrom') { skipped--; return; }
    if (skipped) return;
    if (name === 'r') { if (runs.length) runs[runs.length - 1]!--; }
    else if (name === 't') text = false;
    else if (name === 'p') { runs.pop(); emit(paragraphs.pop() ?? ''); }
    else if (name === 'txbxContent') frames.pop();
    else if (name === 'tc') {
      const cell = frames.pop(), row = frames.at(-1);
      if (cell?.kind === 'cell' && row?.kind === 'row') row.cells.push(cell.parts.join(' '));
    } else if (name === 'tr') {
      const row = frames.pop();
      if (row?.kind === 'row' && row.cells.some(cell => cell)) emit(row.cells.join('\t'));
    }
  };
  for (const token of xmlTokens(xml, 'document')) {
    if (token.kind === 'text') { if (text && !skipped) add(token.text); continue; }
    const [space, name] = token.name.includes(':') ? [token.name.slice(0, token.name.indexOf(':')), localName(token.name)] : ['', token.name];
    // Word's elements by the prefix the document binds to WordprocessingML; mc:Choice and mc:Fallback by their local names.
    if (token.kind === 'open' && name === 'document') {
      for (const [attribute, value] of token.attributes) if (attribute.startsWith('xmlns:') && WORDPROCESSING.has(value)) prefix = attribute.slice('xmlns:'.length);
    }
    const word = space === prefix;
    if (token.kind === 'close') { if (word || name === 'Fallback') close(name); continue; }
    if (name === 'Fallback' || word && name === 'moveFrom') { if (!token.empty) skipped++; continue; }
    if (skipped || !word) continue;
    if (name === 'p') { paragraphs.push(''); runs.push(0); }
    else if (name === 'r') { if (runs.length) runs[runs.length - 1]!++; }
    else if (name === 't') text = true;
    else if ((name === 'tab' || name === 'ptab') && inRun()) add('\t');
    else if ((name === 'br' || name === 'cr') && inRun()) add('\n');
    else if (name === 'noBreakHyphen' && inRun()) add('-');
    else if (name === 'txbxContent') frames.push({ kind: 'lines' });
    else if (name === 'tr') frames.push({ kind: 'row', cells: [] });
    else if (name === 'tc') frames.push({ kind: 'cell', parts: [] });
    else if (name === 'altChunk') { const id = [...token.attributes].find(([key]) => localName(key) === 'id')?.[1]; if (id) for (const line of chunk(id)) emit(line); }
    if (token.empty) close(name);
  }
  return lines;
}

/** The text/html part of an MHT container, decoded per its Content-Transfer-Encoding and charset (MIME structure, not text). */
function mhtHtml(part: Buffer): string {
  const raw = part.toString('latin1');
  const boundary = raw.match(/boundary="?([^"\r\n;]+)"?/)?.[1];
  const sections = boundary ? raw.split(`--${boundary}`) : [raw];
  for (const section of sections) {
    const split = section.search(/\r?\n\r?\n/);
    if (split === -1) continue;
    const headers = section.slice(0, split);
    if (!/content-type:\s*text\/html/i.test(headers)) continue;
    const body = section.slice(split).replace(/^\r?\n\r?\n/, '');
    const encoding = headers.match(/content-transfer-encoding:\s*([\w-]+)/i)?.[1]?.toLowerCase() ?? '8bit';
    const charset = headers.match(/charset="?([\w-]+)"?/i)?.[1] ?? 'utf-8';
    const bytes = encoding === 'quoted-printable' ? quotedPrintableBytes(body) : encoding === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : Buffer.from(body, 'latin1');
    let decoder: TextDecoder;
    // A charset the platform does not know: the part is read as UTF-8, what exports write.
    try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder('utf-8'); }
    return decoder.decode(bytes);
  }
  return '';
}

function quotedPrintableBytes(text: string): Buffer {
  const unfolded = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < unfolded.length; i++) {
    const char = unfolded.charCodeAt(i);
    if (char === 0x3d && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))) { bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(char & 0xff);
  }
  return Buffer.from(bytes);
}

const HTML_BLOCK = /<\/?(?:p|div|li|ul|ol|h[1-6]|section|article|table|thead|tbody|tr|blockquote|pre|header|footer|dt|dd|figure|figcaption)\b[^>]*>/gi;
/** The named entities an HTML export writes, beside the five of XML; character references are decoded by number. */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  ...XML_ENTITIES, nbsp: ' ', mdash: '—', ndash: '–', laquo: '«', raquo: '»',
  hellip: '…', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', deg: '°', euro: '€',
};

/** Visible text of an HTML document, one line per block. */
export function htmlText(html: string): string {
  return htmlLines(html).join('\n');
}

/** Lines of visible text in an HTML fragment: block boundaries break lines, cells are tab-separated, everything else is dropped. */
function htmlLines(html: string): string[] {
  const text = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>\s*(?=<t[dh]\b)/gi, '\t')
    .replace(HTML_BLOCK, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text, HTML_ENTITIES)
    .split('\n')
    .map(line => line.replace(/[  ]+/g, ' ').replace(/ ?\t ?/g, '\t').trim())
    .filter(line => line.length > 0);
}
