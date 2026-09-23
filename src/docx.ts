import { zipEntries, zipRead } from './zip.js';

const DOCUMENT_PART = 'word/document.xml';
/** No real document part comes near this; a bigger one is an archive built to exhaust memory. */
const PART_BYTES = 64_000_000;

/**
 * Text of a .docx file without external libraries: the archive is a ZIP, the body lives in word/document.xml.
 * Paragraphs become lines, runs inside a paragraph are joined; tabs and line breaks are kept. Markup, images and styles are dropped.
 * Knowledge-base exports keep the whole body in an HTML chunk (<w:altChunk/> → word/afchunk.mht); its HTML is flattened the same way.
 */
export function docxText(file: Buffer): string {
  const xml = zipEntry(file, DOCUMENT_PART);
  if (!xml) throw new Error('Файл не является документом Word (.docx): в архиве нет word/document.xml.');
  const document = xml.toString('utf8');
  const lines = paragraphs(document);
  for (const chunk of altChunks(file, document)) lines.push(...htmlLines(chunk));
  return lines.join('\n').trim();
}

/** HTML bodies referenced by <w:altChunk r:id="…"/>, in document order; each one is an MHT part decoded to a string. */
function altChunks(file: Buffer, document: string): string[] {
  const ids = [...document.matchAll(/<w:altChunk\s[^>]*r:id="([^"]+)"/g)].map(match => match[1] ?? '');
  if (ids.length === 0) return [];
  const rels = zipEntry(file, 'word/_rels/document.xml.rels')?.toString('utf8') ?? '';
  const chunks: string[] = [];
  for (const id of ids) {
    const relationship = [...rels.matchAll(/<Relationship\s[^>]*>/g)].map(match => match[0]).find(tag => tag.includes(`Id="${id}"`));
    const target = relationship?.match(/Target="([^"]+)"/)?.[1];
    if (!target) continue;
    const part = zipEntry(file, target.startsWith('/') ? target.slice(1) : `word/${target}`);
    if (part) chunks.push(mhtHtml(part));
  }
  return chunks;
}

/** The text/html part of an MHT container, decoded per its Content-Transfer-Encoding and charset. */
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
    return new TextDecoder(charset).decode(bytes);
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
  return decodeEntities(text)
    .split('\n')
    .map(line => line.replace(/[  ]+/g, ' ').replace(/ ?\t ?/g, '\t').trim())
    .filter(line => line.length > 0);
}

function zipEntry(file: Buffer, wanted: string): Buffer | null {
  const entry = zipEntries(file)?.find(item => item.name === wanted);
  if (!entry) return null;
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`Документ Word сжат неподдерживаемым способом (${entry.method}).`);
  return zipRead(file, entry, PART_BYTES);
}

function paragraphs(xml: string): string[] {
  const lines: string[] = [];
  for (const paragraph of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    let text = '';
    for (const token of paragraph.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:t\/>|<w:tab\/>|<w:br\/>|<w:cr\/>/g) ?? []) {
      if (token === '<w:tab/>') text += '\t';
      else if (token === '<w:br/>' || token === '<w:cr/>') text += '\n';
      else if (token !== '<w:t/>') text += decodeEntities(token.slice(token.indexOf('>') + 1, token.lastIndexOf('<')));
    }
    if (text.trim()) lines.push(text);
  }
  return lines;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', laquo: '«', raquo: '»',
  hellip: '…', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', deg: '°', euro: '€',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity[0] === '#') return String.fromCodePoint(entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
    return NAMED_ENTITIES[entity] ?? whole;
  });
}
