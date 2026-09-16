/*
 * Read-only cross-surface check: for each stored run, the CLI summary block, the Pi tool payload
 * `viewLines` and the collapsed Pi tool result must open with the same lines.
 *
 *   npx tsx pi-surface-check.mts --cwd <dir containing .agent-lab> --id RUN [--id RUN…]
 *
 * Imports the extension from the repository three levels above this file, so a snapshot checks
 * its own dist/. Prints only ids and counts: never a line of the record (bank dialogues).
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { values } = parseArgs({ options: { cwd: { type: 'string' }, id: { type: 'string', multiple: true } } });
if (!values.cwd || !values.id?.length) {
  process.stderr.write('Usage: pi-surface-check.mts --cwd DIR --id RUN [--id RUN]\n');
  process.exit(2);
}
const cwd = resolve(values.cwd);
const dataDir = resolve(cwd, '.agent-lab');

const agentLab = (await import(pathToFileURL(resolve(root, 'extensions/agent-lab.ts')).href)).default;
type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: { type: string; text: string }[] }>;
  renderResult: (result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: unknown) => { render(width: number): string[] } };
const tools = new Map<string, Tool>();
let shutdown: (() => Promise<void>) | undefined;
agentLab({
  registerTool: (tool: Tool) => tools.set(tool.name, tool),
  registerCommand: () => undefined,
  on: (name: string, handler: () => Promise<void>) => { if (name === 'session_shutdown') shutdown = handler; },
  sendMessage: () => undefined,
  sendUserMessage: () => undefined,
});
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const inspect = tools.get('agent_lab_inspect');
if (!inspect) throw new Error('agent_lab_inspect is not registered');

/** Index of the first differing line, or -1 when both lists are equal. */
function firstDiff(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i;
  return -1;
}

let failed = false;
for (const id of values.id) {
  const short = id.slice(0, 8);
  // (a) CLI summary block: lines before the first blank line, minus the per-reason detail lines.
  const cli = spawnSync(process.execPath, [resolve(root, 'dist/cli.js'), 'summary', '--id', id, '--data-dir', dataDir], { encoding: 'utf8' });
  if (cli.status !== 0) { process.stdout.write(`DIFF id=${short} surface=cli line=-1\n`); failed = true; continue; }
  const all = cli.stdout.split('\n');
  let cliBlock = all.slice(0, all.indexOf(''));
  const details = cliBlock.indexOf('Не измерено по причинам:');
  if (details >= 0) cliBlock = cliBlock.slice(0, details);

  // (b) Pi tool payload.
  const result = await inspect.execute('surface-check', { id }, undefined, undefined, { cwd, hasUI: false, mode: 'print' });
  const payload = JSON.parse(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
  const payloadBlock: string[] = Array.isArray(payload.viewLines) ? payload.viewLines : [];

  // (c) Collapsed Pi tool result: its leading lines.
  const rendered = inspect.renderResult(result, { expanded: false, isPartial: false }, theme).render(1000).map(entry => entry.trimEnd());
  const start = rendered.findIndex(entry => entry.trim() !== '');
  const renderBlock = rendered.slice(start, start + cliBlock.length).map(entry => entry.trim());

  const surfaces: [string, string[]][] = [['payload', payloadBlock], ['render', renderBlock]];
  let ok = cliBlock.length > 0;
  if (!ok) process.stdout.write(`DIFF id=${short} surface=cli line=0\n`);
  for (const [name, lines] of surfaces) {
    const at = firstDiff(cliBlock, lines);
    if (at >= 0) { process.stdout.write(`DIFF id=${short} surface=${name} line=${at}\n`); ok = false; }
  }
  if (ok) process.stdout.write(`OK surfaces=${surfaces.length} lines=${cliBlock.length} id=${short}\n`);
  else failed = true;
}
await shutdown?.();
process.exit(failed ? 1 : 0);
