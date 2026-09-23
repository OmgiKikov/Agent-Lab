import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fingerprint } from '../contracts.js';
import { writeFileAtomic } from '../fs-atomic.js';
import { isIdentifier } from '../ids.js';
import { topicMapProgressSchema, topicMapSchema, type TopicMap, type TopicMapKey, type TopicMapProgress } from './topic-map.js';

/*
 * A topic map lives next to its import — `imports/<importId>.topics-<key digest>.json` — one file per key (the
 * import, its content, the builder model, the prompt version), so maps of the same logs by different models never
 * overwrite each other. The file holds the build in progress after every step and the finished map at the end.
 * Only the store's writer writes it, atomically and 0600; anyone reads it. Whatever the file holds is checked
 * against the import before it is used (topic-map.ts): a damaged file reads as none, and the map is built again.
 */

function fileOf(directory: string, key: TopicMapKey): string {
  if (!isIdentifier(key.importId)) throw new Error('Некорректный идентификатор импорта');
  const { importId, contentHash, model, promptVersion } = key;
  return join(directory, 'imports', `${importId}.topics-${fingerprint({ importId, contentHash, model, promptVersion })}.json`);
}

/** The stored map or build in progress under `key`, as stored; undefined when there is none or it is not JSON. */
export async function readTopicMapFile(directory: string, key: TopicMapKey): Promise<unknown> {
  try { return JSON.parse(await readFile(fileOf(directory, key), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** Replaces the stored state of a map's build under the map's own key: a finished map, or the progress of one. */
export async function writeTopicMapFile(directory: string, value: TopicMap | TopicMapProgress): Promise<void> {
  const parsed = 'excluded' in value ? topicMapSchema.parse(value) : topicMapProgressSchema.parse(value);
  await mkdir(join(directory, 'imports'), { recursive: true, mode: 0o700 });
  await writeFileAtomic(fileOf(directory, parsed), JSON.stringify(parsed));
}
