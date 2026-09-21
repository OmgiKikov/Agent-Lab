/*
 * Read-only width check: the `/agent-lab` board must fit every terminal it is given, and an
 * explanation row must keep every word at every width — nothing truncated, no «…» invented.
 *
 *   npx tsx board-width-check.mts --cwd <dir containing .agent-lab> --id RUN [--id RUN…]
 *
 * For each run the board is rendered at 40, 60, 80, 110 and 160 columns, collapsed and after
 * Enter, and the explanation and «?» rows of its view are wrapped at the matching inner widths.
 *
 * Stored runs hold bank dialogues, so only ids, widths, counts and theme token names are printed:
 * never a card title, a dialogue turn, a rule quote or a judge rationale.
 *
 * Imports the extension from the repository three levels above this file, like pi-surface-check,
 * so a snapshot checks its own dist/. Exit 1 on any finding, 2 on a usage error.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { values } = parseArgs({ options: { cwd: { type: 'string' }, id: { type: 'string', multiple: true } } });
if (!values.cwd || !values.id?.length) {
  process.stderr.write('Usage: board-width-check.mts --cwd DIR --id RUN [--id RUN]\n');
  process.exit(2);
}
const dataDir = resolve(resolve(values.cwd), '.agent-lab');

const { LabBoard, wrapRows } = await import(pathToFileURL(resolve(root, 'extensions/cards.ts')).href);
const { ExperimentStore } = await import(pathToFileURL(resolve(root, 'dist/store.js')).href);
const { buildResultView, resultViewRows, failureListRows, causeSection } =
  await import(pathToFileURL(resolve(root, 'dist/result-view.js')).href);
const { stripTerminalSequences, visibleWidth } = await import('@earendil-works/pi-tui');

// A reader: ExperimentStore.get never takes the writer lock.
const store = new ExperimentStore(dataDir);

/** The only theme tokens a result surface may use (UI-SPEC «Row role → token»). */
const ALLOWED = ['accent', 'borderMuted', 'dim', 'error', 'muted', 'success', 'text', 'warning'];
const WIDTHS = [40, 60, 80, 110, 160];
/** The board's inner width at each of the checked terminal widths: frame borders take four columns. */
const INNERS = WIDTHS.map(width => width - 4);

type Row = { text: string; indent?: number };
const words = (rows: Row[]) => rows.map(row => row.text).join(' ').split(/\s+/).filter(Boolean).join(' ');
const ellipses = (rows: Row[]) => rows.reduce((n, row) => n + (row.text.match(/…/g)?.length ?? 0), 0);

let failed = false;
for (const id of values.id) {
  const short = id.slice(0, 8);
  const record = await store.get(id);

  for (const width of WIDTHS) {
    // A theme that records the token of every painted row instead of coloring it.
    const seen = new Set<string>();
    const theme = { fg: (color: string, text: string) => { seen.add(color); return text; }, bold: (text: string) => text };
    // Tall enough that the whole board is one screen: scrolling would hide rows from the check.
    const board = new LabBoard({ record, section: 'agent' }, theme, () => {}, () => {}, () => 3000);
    for (const expanded of [0, 1]) {
      if (expanded) board.handleInput('\r');
      seen.clear();
      const rows: string[] = board.render(width).map((row: string) => stripTerminalSequences(row));
      const over = rows.filter(row => visibleWidth(row) > width).length;
      const tokens = [...seen].sort();
      const unknown = tokens.filter(token => !ALLOWED.includes(token));
      process.stdout.write(`${short} width=${width} expanded=${expanded} rows=${rows.length} over=${over} tokens=${tokens.join(',')}\n`);
      if (over > 0 || unknown.length) {
        process.stdout.write(`FINDING ${short} width=${width} expanded=${expanded} over=${over} unknownTokens=${unknown.join(',')}\n`);
        failed = true;
      }
    }
    board.dispose();
  }

  // The rows a reader must be able to read in full: the «?» rows of the block, the cause section
  // and every failure under «ВСЕ ПРОВАЛЫ».
  const view = buildResultView(record);
  const section = causeSection(view);
  const content: Row[] = [
    ...resultViewRows(view).filter((row: { role: string }) => row.role === 'situation' || row.role === 'detail'),
    ...(section ? section.rows : []),
    ...failureListRows(view),
  ];
  for (const inner of INNERS) {
    const wrapped: Row[] = wrapRows(content, inner);
    const over = wrapped.filter(row => visibleWidth(row.text) > inner).length;
    const ellipsis = ellipses(wrapped) - ellipses(content);
    const same = words(wrapped) === words(content);
    process.stdout.write(`wrap ${short} inner=${inner} rows=${wrapped.length} over=${over} ellipsis=${ellipsis} words=${same ? 'equal' : 'different'}\n`);
    if (over > 0 || ellipsis > 0 || !same) {
      process.stdout.write(`FINDING ${short} inner=${inner} over=${over} ellipsis=${ellipsis} words=${same ? 'equal' : 'different'}\n`);
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);
