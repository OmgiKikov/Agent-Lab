import { crc32, inflateRawSync } from 'node:zlib';

/*
 * Files out of a ZIP archive — the container of .docx and .xlsx — with node:zlib alone. Only what office
 * files use: stored and deflated entries, no encryption, no ZIP64. The central directory is the authority
 * (a local header may leave its sizes to a data descriptor), every entry is checked against its CRC, and
 * every read is capped: a small archive must not unpack into gigabytes.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
/** A size or offset field set to this value moves to a ZIP64 record. */
const ZIP64_MARK = 0xffffffff;

/** An entry unpacks to more than the caller allows; the caller words the refusal for its own file kind. */
export class ArchiveTooLarge extends Error {
  constructor(readonly maxBytes: number) { super(`Файл в архиве распаковывается больше чем в ${Math.round(maxBytes / 1_000_000)} МБ — Lab такие файлы не читает.`); }
}

/** One file of the archive as its central directory describes it. */
export interface ZipEntry { name: string; method: number; flags: number; crc: number; compressedSize: number; size: number; localOffset: number }

/** The archive's table of contents, or null when the bytes are not a ZIP archive. */
export function zipEntries(file: Buffer): ZipEntry[] | null {
  const end = endOfCentralDirectory(file);
  if (end === -1) return null;
  const count = file.readUInt16LE(end + 10);
  const offset = file.readUInt32LE(end + 16);
  if (count === 0xffff || offset === ZIP64_MARK) throw new Error('Архив в формате ZIP64 — Lab его не читает. Сохраните файл заново, он станет обычным ZIP.');
  const entries: ZipEntry[] = [];
  let cursor = offset;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > file.length || file.readUInt32LE(cursor) !== CENTRAL_HEADER) throw damaged();
    const nameLength = file.readUInt16LE(cursor + 28);
    entries.push({
      name: file.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'),
      flags: file.readUInt16LE(cursor + 8), method: file.readUInt16LE(cursor + 10), crc: file.readUInt32LE(cursor + 16),
      compressedSize: file.readUInt32LE(cursor + 20), size: file.readUInt32LE(cursor + 24), localOffset: file.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameLength + file.readUInt16LE(cursor + 30) + file.readUInt16LE(cursor + 32);
  }
  return entries;
}

/** The uncompressed bytes of one entry; more than `maxBytes` is refused whatever the entry declares. */
export function zipRead(file: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  if (entry.flags & 1) throw new Error('Файл зашифрован паролем — Lab его не читает. Снимите пароль и сохраните файл заново.');
  if (entry.size === ZIP64_MARK || entry.compressedSize === ZIP64_MARK || entry.localOffset === ZIP64_MARK) throw new Error('Архив в формате ZIP64 — Lab его не читает. Сохраните файл заново, он станет обычным ZIP.');
  if (entry.size > maxBytes) throw new ArchiveTooLarge(maxBytes);
  const local = entry.localOffset;
  if (local + 30 > file.length || file.readUInt32LE(local) !== LOCAL_HEADER) throw damaged();
  const start = local + 30 + file.readUInt16LE(local + 26) + file.readUInt16LE(local + 28);
  if (start + entry.compressedSize > file.length) throw damaged();
  const stored = file.subarray(start, start + entry.compressedSize);
  let data: Buffer;
  if (entry.method === 0) data = stored;
  else if (entry.method === 8) {
    try { data = inflateRawSync(stored, { maxOutputLength: maxBytes }); }
    catch (error) { throw (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? new ArchiveTooLarge(maxBytes) : damaged(); }
  } else throw new Error(`Файл в архиве сжат неподдерживаемым способом (${entry.method}).`);
  if (data.length > maxBytes) throw new ArchiveTooLarge(maxBytes);
  if (crc32(data) !== entry.crc) throw damaged();
  return data;
}

const damaged = () => new Error('Архив повреждён: часть файла не читается. Сохраните файл заново.');

function endOfCentralDirectory(file: Buffer): number {
  const floor = Math.max(0, file.length - 22 - 65535);
  for (let i = file.length - 22; i >= floor; i--) if (file.readUInt32LE(i) === END_OF_CENTRAL) return i;
  return -1;
}
