import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import type { SourceKind } from './contracts.js';
import { docxText, htmlText } from './docx.js';
import { MATERIAL_CHARS, MATERIAL_LIMIT, MATERIAL_PART_CHARS } from './limits.js';
import type { PromptCandidate } from './prompt-candidates.js';
import { textEncoding } from './spreadsheet/csv.js';

interface FileMaterial { name: string; content: string; kind: SourceKind; file: string }
interface MaterialsReport { materials: FileMaterial[]; skipped: Array<{ file: string; reason: string }> }

/**
 * The text of a plain document in the encoding its bytes are written in (spreadsheet/csv.ts textEncoding): UTF-8,
 * UTF-16 by its byte order mark, else Windows-1251, which Notepad and Word save in a Russian locale. A text that
 * would hold replacement characters or zero bytes is refused: garbled words must never become the agent's rules.
 */
function documentText(bytes: Buffer): string {
  const encoding = textEncoding(bytes);
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: encoding !== 'windows-1251' && encoding !== 'windows-1252' }).decode(bytes); }
  catch { throw new Error(`текст не читается в кодировке ${encoding === 'utf-8' ? 'UTF-8' : 'UTF-16'} — сохраните файл заново в UTF-8`); }
  if (text.includes('�')) throw new Error('в тексте испорченные знаки «�» — сохраните файл заново в UTF-8 из исходного документа');
  if (text.includes('\u0000')) throw new Error('это не текст: в файле нулевые байты — сохраните его как текст в UTF-8');
  return text;
}

const READERS: Record<string, (file: Buffer) => string> = {
  '.docx': docxText,
  '.md': documentText,
  '.txt': documentText,
  '.html': file => htmlText(documentText(file)),
  '.htm': file => htmlText(documentText(file)),
};
/** The document types Lab reads as materials; project detection proposes only these. */
export const MATERIAL_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(READERS));
/** The text of a document Lab reads as a material, from its bytes; undefined for another type or a file it cannot read. */
export function materialText(file: string, bytes: Buffer): string | undefined {
  const read = READERS[extname(file).toLowerCase()];
  try { return read?.(bytes).trim(); } catch { return undefined; }
}
const SUPPORTED = 'формат не поддерживается: только .docx, .md, .txt, .html';
const MIN_CHARS = 40;

/**
 * Reads owner materials from files and folders so nothing passes through a model's hands on the way in:
 * the whole article, verbatim, named after its file. Folders are walked; identical texts are kept once.
 */
export async function readMaterialFiles(paths: string[], kind: SourceKind): Promise<MaterialsReport> {
  const files: string[] = [];
  for (const path of paths) files.push(...await listFiles(resolve(path)));
  const title = (file: string) => basename(file, extname(file));
  files.sort((a, b) => title(a).localeCompare(title(b), 'ru') || a.localeCompare(b, 'ru'));
  const materials: FileMaterial[] = [], skipped: MaterialsReport['skipped'] = [], seen = new Map<string, string>();
  for (const file of files) {
    const read = READERS[extname(file).toLowerCase()];
    if (!read) { skipped.push({ file, reason: SUPPORTED }); continue; }
    let content: string;
    try { content = read(await readFile(file)).trim(); }
    catch (error) { skipped.push({ file, reason: error instanceof Error ? error.message : String(error) }); continue; }
    if (content.length < MIN_CHARS) { skipped.push({ file, reason: 'нет текста' }); continue; }
    if (content.length > MATERIAL_CHARS) { skipped.push({ file, reason: `больше ${MATERIAL_CHARS.toLocaleString('ru-RU')} знаков` }); continue; }
    const name = basename(file, extname(file));
    const duplicate = seen.get(content);
    if (duplicate) { skipped.push({ file, reason: `дубликат «${duplicate}»` }); continue; }
    if (materials.length >= MATERIAL_LIMIT) { skipped.push({ file, reason: `больше ${MATERIAL_LIMIT} материалов` }); continue; }
    seen.set(content, name);
    const parts = splitParts(content, MATERIAL_PART_CHARS);
    if (parts.length === 1) materials.push({ name, content, kind, file });
    else parts.forEach((part, index) => materials.push({ name: `${name} · часть ${index + 1}/${parts.length}`, content: part, kind, file }));
  }
  return { materials, skipped };
}

/** Cuts a text into parts of at most `limit` characters at paragraph breaks (then line breaks); the parts joined by the break are the text. */
function splitParts(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit / 4) cut = window.lastIndexOf('\n');
    if (cut < limit / 4) cut = window.lastIndexOf(' ');
    if (cut < limit / 4) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

async function listFiles(path: string): Promise<string[]> {
  const info = await stat(path).catch(() => null);
  if (!info) throw new Error(`Путь не найден: ${path}`);
  if (info.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/**
 * Prompts the owner chose among those found in the code and JSON of the project (prompt-candidates.ts): materials of kind
 * `prompt`, verbatim, named by the file and the constant or field, a long one in parts like any other material.
 */
export function promptMaterials(chosen: readonly Pick<PromptCandidate, 'file' | 'identifier' | 'text'>[]): FileMaterial[] {
  return chosen.flatMap(candidate => {
    const whole = candidate.identifier ? `${candidate.file} · ${candidate.identifier}` : candidate.file;
    // A material's name holds 180 characters; the end names the prompt, so a long path loses its beginning.
    const name = whole.length > 160 ? `…${whole.slice(-159)}` : whole;
    const content = candidate.text.trim();
    const parts = splitParts(content, MATERIAL_PART_CHARS);
    return parts.map((part, index) => ({ name: parts.length === 1 ? name : `${name} · часть ${index + 1}/${parts.length}`, content: part, kind: 'prompt' as const, file: candidate.file }));
  });
}

interface MaterialPaths { materials?: Array<{ name: string; content: string; kind?: SourceKind }>; materialFiles?: string[]; promptFiles?: string[] }

/** Inline materials first, then articles read from materialFiles and prompts from promptFiles, both resolved against baseDir. */
export async function expandMaterials<T extends MaterialPaths>(input: T, baseDir: string): Promise<{ materials: Array<{ name: string; content: string; kind?: SourceKind }>; skipped: MaterialsReport['skipped']; read: number }> {
  const inline = input.materials ?? [];
  const knowledge = input.materialFiles?.length ? await readMaterialFiles(input.materialFiles.map(path => resolve(baseDir, path)), 'knowledge') : { materials: [], skipped: [] };
  const prompts = input.promptFiles?.length ? await readMaterialFiles(input.promptFiles.map(path => resolve(baseDir, path)), 'prompt') : { materials: [], skipped: [] };
  const fromFiles = [...knowledge.materials, ...prompts.materials].map(({ name, content, kind }) => ({ name, content, kind }));
  return { materials: [...inline, ...fromFiles], skipped: [...knowledge.skipped, ...prompts.skipped], read: fromFiles.length };
}
