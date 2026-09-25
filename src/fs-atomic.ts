import { randomUUID } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { link, open, rename, unlink } from 'node:fs/promises';

/**
 * Replaces `path` so a reader sees either the old file or the whole new one: the text goes to a
 * private temporary file (0600, created exclusively, flushed to disk) that is renamed over the target.
 */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Codes of a file system without hard links: there the file is created exclusively and written at once. */
const NO_LINKS = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'];

/**
 * Creates `path` holding `text` unless something is there already, and says whether it did. A reader finds either no
 * file or the whole text, never an empty one: the text is written to a private temporary file first and linked in
 * place, which fails when the name is taken. Where the file system has no hard links, the file is created exclusively
 * and written at once, as before.
 */
export async function createFileExclusive(path: string, text: string): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    try { await link(temporary, path); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') return false;
      if (!NO_LINKS.includes(code)) throw error;
    }
    let created;
    try { created = await open(path, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    try { await created.writeFile(text); await created.sync(); }
    catch (error) { await created.close(); await unlink(path); throw error; }
    await created.close();
    return true;
  } finally { await unlink(temporary).catch(() => {}); }
}

/** The synchronous twin, for a write that must be on disk before the caller returns (a judge audit on a crash path). */
export function writeFileAtomicSync(path: string, text: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* never created, or already renamed */ }
    throw error;
  }
}
