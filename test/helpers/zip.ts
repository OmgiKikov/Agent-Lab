import { crc32, deflateRawSync } from 'node:zlib';

/** Builds a plain ZIP archive (stored or deflated entries) so tests can fabricate .docx files without fixtures. */
export function zipArchive(entries: Array<{ name: string; data: string | Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const stored = entry.deflate === false ? raw : deflateRawSync(raw);
    const method = entry.deflate === false ? 0 : 8;
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, stored);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** A Word document whose whole body is an HTML chunk (word/afchunk.mht, quoted-printable) — how knowledge-base exports arrive. */
export function docxHtmlChunk(html: string): Buffer {
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:altChunk r:id="htmlChunk"/><w:sectPr/></w:body></w:document>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk"\n    Target="/word/afchunk.mht" Id="htmlChunk" />\n</Relationships>';
  const mht = ['MIME-Version: 1.0', 'Content-Type: multipart/related;', '    type="text/html";', '    boundary="----=mhtDocumentPart"', '', '',
    '------=mhtDocumentPart', 'Content-Type: text/html;', '    charset="utf-8"', 'Content-Transfer-Encoding: quoted-printable', 'Content-Location: file:///C:/fake/document.html', '',
    quotedPrintable(html), '',
    '------=mhtDocumentPart', 'Content-Type: image/jpeg', 'Content-Transfer-Encoding: base64', 'Content-Location: file:///C:/fake/image001.jpg', '', Buffer.from('not really a jpeg').toString('base64'), '',
    '------=mhtDocumentPart--', ''].join('\r\n');
  return zipArchive([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'word/document.xml', data: document },
    { name: 'word/afchunk.mht', data: mht },
    { name: 'word/_rels/document.xml.rels', data: rels },
  ]);
}

/** Quoted-printable with 76-column soft breaks, the way Word writes MHT parts. */
function quotedPrintable(text: string): string {
  let encoded = '';
  for (const byte of Buffer.from(text, 'utf8')) {
    const char = String.fromCharCode(byte);
    encoded += (byte === 0x3d || byte < 0x20 || byte > 0x7e) && byte !== 0x0a && byte !== 0x0d ? `=${byte.toString(16).toUpperCase().padStart(2, '0')}` : char;
  }
  const lines: string[] = [];
  for (const line of encoded.split(/\r?\n/)) {
    let rest = line;
    while (rest.length > 75) {
      let cut = 75;
      if (rest[cut - 1] === '=') cut -= 1; else if (rest[cut - 2] === '=') cut -= 2;
      lines.push(`${rest.slice(0, cut)}=`);
      rest = rest.slice(cut);
    }
    lines.push(rest);
  }
  return lines.join('\r\n');
}

/** A minimal Word document: each paragraph is a list of runs; a run may be text, a tab or a line break. */
export function docxFile(paragraphs: Array<Array<string | { tab: true } | { br: true }>>, options: { deflate?: boolean } = {}): Buffer {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = paragraphs.map(runs => `<w:p><w:pPr/>${runs.map(run =>
    typeof run === 'string' ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escape(run)}</w:t></w:r>`
      : 'tab' in run ? '<w:r><w:tab/></w:r>' : '<w:r><w:br/></w:r>').join('')}</w:p>`).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;
  return zipArchive([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', deflate: options.deflate },
    { name: 'word/document.xml', data: document, deflate: options.deflate },
    { name: 'word/media/image1.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), deflate: options.deflate },
  ]);
}
