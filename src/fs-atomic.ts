import { randomUUID } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { link, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/*
 * A write is durable when its bytes and its name are: the file is flushed before it is renamed or linked into place, and
 * the folder that names it is flushed after, so a power loss leaves the old file or the whole new one — never a name
 * pointing at nothing, or a checkpoint that vanished after it was announced. A system that cannot flush a folder
 * (Windows opens none, some network file systems refuse) keeps the rename's own guarantee. Measured on a Mac (APFS), a
 * flush takes about 4.5 ms: a teaching run, which makes some seventy writes and no model call, takes 0.3 s longer; a
 * checkpoint of a live run, whose dialogues wait seconds on models, does not notice it.
 */

/** Codes of a folder that cannot be opened or flushed here. */
const NO_FOLDER_SYNC = ['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF'];

/** Flushes `directory`, so a rename or a link into it survives a power loss. */
export async function syncDirectory(directory: string): Promise<void> {
  let folder;
  try { folder = await open(directory, 'r'); }
  catch (error) { if (NO_FOLDER_SYNC.includes((error as NodeJS.ErrnoException).code ?? '')) return; throw error; }
  try { await folder.sync(); }
  catch (error) { if (!NO_FOLDER_SYNC.includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  finally { await folder.close(); }
}


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
    await syncDirectory(dirname(path));
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
    try { await link(temporary, path); await syncDirectory(dirname(path)); return true; }
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
    await syncDirectory(dirname(path));
    return true;
  } finally { await unlink(temporary).catch(() => {}); }
}

/**
 * The synchronous twin, for a write that must be on disk before the caller returns (a judge audit on a crash path). It
 * is called many times a dialogue, so it does not flush its folder: its caller does, at its next checkpoint (store.ts).
 */
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
