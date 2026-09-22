import { randomUUID } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';

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
