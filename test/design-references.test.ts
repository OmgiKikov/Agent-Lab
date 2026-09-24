import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * Comments give their reason by citing the design specifications as a file and a section,
 * `docs/design/ui-spec.md §4.10`: each citation must name a file of the repository and a heading in it,
 * so a reader of the code can follow it. The citations are read from our own sources, never from data.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const CITATION = /docs\/design\/([a-z0-9-]+\.md) §(\d+(?:\.\d+)?)(?:–(\d+(?:\.\d+)?))?/g;

/** The numbered headings of a spec: «## 4. Макеты» is §4, «### 4.10 Лента чата» is §4.10. */
async function sections(file: string): Promise<Set<string>> {
  const text = await readFile(join(root, 'docs', 'design', file), 'utf8');
  return new Set(text.split('\n').flatMap(line => {
    const heading = /^#{2,4} (\d+(?:\.\d+)*)\.? /.exec(line);
    return heading ? [heading[1]!] : [];
  }));
}

test('every design citation in the code names a file of docs/design and one of its sections', async () => {
  const files = (await Promise.all(['src', 'extensions', 'test'].map(async folder =>
    (await readdir(join(root, folder), { recursive: true })).filter(name => /\.(?:ts|mjs)$/.test(name)).map(name => join(folder, name))))).flat();
  const specs = new Map<string, Set<string>>();
  let cited = 0;
  for (const file of files) {
    for (const [, spec, first, last] of (await readFile(join(root, file), 'utf8')).matchAll(CITATION)) {
      if (!specs.has(spec!)) specs.set(spec!, await sections(spec!));
      for (const section of [first!, ...(last ? [last] : [])]) assert.ok(specs.get(spec!)!.has(section), `${file}: ${spec} has no §${section}`);
      cited++;
    }
  }
  assert.deepEqual([...specs.keys()].sort(), ['card-v2-spec.md', 'ui-spec.md']);
  assert.ok(cited >= 80, `${cited} citations`);
});
