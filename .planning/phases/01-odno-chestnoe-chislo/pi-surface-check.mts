/*
 * Read-only cross-surface check: for each stored run, the CLI summary block, the Pi tool payload
 * `viewLines` and the collapsed Pi tool result must open with the same lines, and the collapsed
 * `/agent-lab` board must show every one of those lines as a whole line. The failure section
 * (top causes, or the first failures) is compared the same way.
 *
 * The board and the collapsed render indent their rows, so both sides of those two comparisons
 * are trimmed; the payload is compared verbatim.
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
const { LabBoard } = await import(pathToFileURL(resolve(root, 'extensions/cards.ts')).href);
const { ExperimentStore } = await import(pathToFileURL(resolve(root, 'dist/store.js')).href);
const { evidenceBundle } = await import(pathToFileURL(resolve(root, 'dist/artifacts.js')).href);
const { stripTerminalSequences } = await import('@earendil-works/pi-tui');
// A reader: ExperimentStore.get never takes the writer lock.
const store = new ExperimentStore(dataDir);
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

/** The CLI headings of the failure section; SECTION_TEXT keeps the board forms in upper case. */
const HEADINGS = ['Главные причины провалов:', 'Провалы:'];
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
  const trimmedBlock = cliBlock.map(entry => entry.trim());

  // (d) The collapsed /agent-lab board for the same record: each block line must be a whole cell.
  // As `/agent-lab` does: the board gets the bundle view, so a repeat shows its stability against the parent run.
  const record = await store.get(id);
  const bundle = await evidenceBundle(record, store);
  // Wide and tall enough that nothing wraps or scrolls: every row must be one whole cell.
  const board = new LabBoard({ record, view: bundle.view, comparison: bundle.comparison, before: bundle.before, warnings: bundle.warnings },
    theme, () => {}, () => {}, () => 3000);
  const cells = new Set<string>(stripTerminalSequences(board.render(5000).join('\n')).split('\n')
    .flatMap((row: string) => row.split('│')).map((cell: string) => cell.trim()).filter(Boolean));
  board.dispose();
  // An equal list means every block line was found; a missing one is reported by its index.
  const boardBlock = trimmedBlock.map(entry => cells.has(entry) ? entry : '\u0000missing');

  const surfaces: [string, string[], string[]][] = [['payload', cliBlock, payloadBlock], ['render', trimmedBlock, renderBlock], ['board', trimmedBlock, boardBlock]];
  let ok = cliBlock.length > 0;
  if (!ok) process.stdout.write(`DIFF id=${short} surface=cli line=0\n`);
  for (const [name, expected, lines] of surfaces) {
    const at = firstDiff(expected, lines);
    if (at >= 0) { process.stdout.write(`DIFF id=${short} surface=${name} line=${at}\n`); ok = false; }
  }

  // (e) The failure section: heading and rows, the same on the CLI, in the payload and on the board.
  const clean = (lines: string[]) => lines.map(entry => entry.trim()).filter(Boolean);
  const headingAt = all.findIndex(entry => HEADINGS.includes(entry.trim()));
  const endAt = all.findIndex(entry => entry.trimStart().startsWith('Все провалы ('));
  const cliSection = headingAt < 0 ? [] : clean(all.slice(headingAt, endAt > headingAt ? endAt : all.length));
  const paySection = clean((Array.isArray(payload.failureLines) ? payload.failureLines : [])
    .filter((entry: string) => !entry.trimStart().startsWith('Все провалы — ')));
  const atPayload = firstDiff(cliSection, paySection);
  if (atPayload >= 0) { process.stdout.write(`DIFF id=${short} surface=payload-section line=${atPayload}\n`); ok = false; }
  if (cliSection.length) {
    // The board heading is the upper-case form of the CLI one; the rows below it are the same rows.
    const boardSection = [cliSection[0]!.replace(/:$/, '').toLocaleUpperCase('ru-RU'), ...cliSection.slice(1)];
    const atBoard = boardSection.findIndex(entry => !cells.has(entry));
    if (atBoard >= 0) { process.stdout.write(`DIFF id=${short} surface=board-section line=${atBoard}\n`); ok = false; }
  }
  if (ok) process.stdout.write(`OK surfaces=${surfaces.length} lines=${cliBlock.length} sections=${cliSection.length} id=${short}\n`);
  else failed = true;
}
await shutdown?.();
process.exit(failed ? 1 : 0);
