import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createInputSchema } from '../src/contracts.js';

/*
 * The agents' harnesses live beside the core (harnesses/), but what they write must pass the core's contracts:
 * otherwise a mistake in them is found only on the work machine. And the core never depends on them.
 */

const root = new URL('../', import.meta.url);

test('the agent_oc skills registry is a task the current build accepts', async () => {
  const agent = await mkdtemp(join(tmpdir(), 'agent-lab-harness-'));
  const skills = join(agent, 'src/app/incass_ckr/new_agent_logic/dialogue_handler/agent/tools/read/skills');
  await mkdir(skills, { recursive: true });
  await writeFile(join(skills, 'order.md'), '# Заказ инкассации\n{{ surface }}\nКлиент заказывает выезд.\n');
  const output = join(agent, 'task-cards.json');
  await promisify(execFile)('python3', [new URL('harnesses/agent-oc/materials.py', root).pathname, '--root', agent, '--output', output]);
  const input = createInputSchema.parse(JSON.parse(await readFile(output, 'utf8')));
  assert.equal(input.target.kind, 'unconnected');
  assert.equal(input.settings.roles?.judge?.provider, 'giga');
  assert.match(input.materials[0]!.content, /## order\n# Заказ инкассации\nКлиент заказывает выезд\./);
});

test('the core and the Pi extension name no harness', async () => {
  for (const folder of ['src', 'extensions']) {
    const files = (await readdir(new URL(`${folder}/`, root), { recursive: true })).filter(name => name.endsWith('.ts') || name.endsWith('.mjs'));
    for (const file of files) assert.ok(!(await readFile(new URL(`${folder}/${file}`, root), 'utf8')).includes('harnesses/'), `${folder}/${file}`);
  }
  const shipped: string[] = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).files;
  assert.ok(!shipped.some(entry => entry.startsWith('harnesses')), 'harnesses stay outside the npm package');
});
