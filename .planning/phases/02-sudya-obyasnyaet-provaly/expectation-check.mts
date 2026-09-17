/*
 * The expectation sheet on a real draft: read-only unless `--apply`.
 *
 *   npx tsx expectation-check.mts --cwd <dir containing .agent-lab> --draft ID
 *   npx tsx expectation-check.mts --cwd DIR --draft ID --apply --scenario ID --text-file PATH
 *
 * Default mode (reader, no writer lock): counts the sheet's rows, renders the `/agent-lab` board
 * section 2 at 40, 60, 80, 110 and 160 columns, and feeds `y` and `e` to two fresh boards.
 * `--apply` (writer, through ExperimentLab) replaces one situation's expectation with the text of
 * a file and checks that the owner's words reached the stored criterion and the judge input.
 *
 * Stored drafts hold bank dialogues, so only ids, counts, hashes and booleans are printed: never a
 * card title, a situation goal, a dialogue turn, a rule quote or the owner text itself.
 *
 * Imports the extension from the repository three levels above this file, like board-width-check,
 * so a snapshot checks its own dist/. Exit 1 on any finding, 2 on a usage error.
 */
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { values } = parseArgs({
  options: {
    cwd: { type: 'string' }, draft: { type: 'string' }, apply: { type: 'boolean' },
    scenario: { type: 'string' }, 'text-file': { type: 'string' },
  },
});
if (!values.cwd || !values.draft || (values.apply && (!values.scenario || !values['text-file']))) {
  process.stderr.write('Usage: expectation-check.mts --cwd DIR --draft ID [--apply --scenario ID --text-file PATH]\n');
  process.exit(2);
}
const dataDir = resolve(resolve(values.cwd), '.agent-lab');

const { LabBoard } = await import(pathToFileURL(resolve(root, 'extensions/cards.ts')).href);
const { ExperimentStore } = await import(pathToFileURL(resolve(root, 'dist/store.js')).href);
const { ExperimentLab, draftHash } = await import(pathToFileURL(resolve(root, 'dist/experiment.js')).href);
const { expectationSheet } = await import(pathToFileURL(resolve(root, 'dist/quality.js')).href);
const { judgeInput, observableSources } = await import(pathToFileURL(resolve(root, 'dist/judge.js')).href);
const { stripTerminalSequences, visibleWidth } = await import('@earendil-works/pi-tui');

const WIDTHS = [40, 60, 80, 110, 160];
/** A theme that returns the text unchanged, so a render is a checkable list of rows. */
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const short = values.draft.slice(0, 8);
let failed = false;

// A reader: ExperimentStore.get never takes the writer lock.
const store = new ExperimentStore(dataDir);

/** The judge input of one situation, over a minimal trial of that situation: no model is called. */
const judgeInputText = (record: any, scenario: any): string => JSON.stringify(judgeInput({
  scenario,
  sources: observableSources(record.sources, record.requirements),
  trial: { userMode: 'scripted', events: [], initialState: scenario.initialState ?? {}, finalState: null },
}));

if (values.apply) {
  const text = (await readFile(resolve(values['text-file']!), 'utf8')).trim();
  const lab = new ExperimentLab(dataDir);
  await lab.init();
  try {
    const before = await lab.get(values.draft);
    await lab.setExpectation(values.draft, draftHash(before), values.scenario, text);
  } finally {
    await lab.close();
  }
  const record = await store.get(values.draft);
  const scenario = record.scenarios.find((s: any) => s.id === values.scenario);
  if (!scenario) { process.stderr.write(`No such situation in the draft: ${values.scenario}\n`); process.exit(2); }
  const marker = (record.ownerExpectationScenarioIds ?? []).includes(values.scenario);
  const criteria = (scenario.successCriteria ?? '') === text ? 'verbatim' : 'different';
  const goal = scenario.metrics?.find((m: any) => m.id === 'goal_attainment');
  const passCriteria = !goal ? 'none' : goal.passCriteria === text ? 'verbatim' : 'different';
  const inInput = judgeInputText(record, scenario).includes(JSON.stringify(text).slice(1, -1));
  process.stdout.write(`applied ${short} marker=${marker} criteria=${criteria} passCriteria=${passCriteria} judgeInput=${inInput}\n`);
  if (!marker || criteria !== 'verbatim' || passCriteria === 'different' || !inInput) {
    process.stdout.write(`FINDING ${short} the owner text did not reach the stored criterion or the judge input\n`);
    failed = true;
  }
  process.exit(failed ? 1 : 0);
}

const record = await store.get(values.draft);
const sheet = expectationSheet(record);
const details = sheet.cards.flatMap((card: any) => card.details);
const count = (role: string) => details.filter((row: any) => row.role === role).length;
const hash = draftHash(record);
const versionOk = sheet.draftHash === hash;
const confirmed = record.acceptedDraftHash === hash;
process.stdout.write(`sheet ${short} situations=${sheet.count} goalRows=${count('expected')} ruleRows=${count('rule')}`
  + ` unverifiedRows=${count('unverified')} markers=${count('marker')} versionOk=${versionOk} confirmed=${confirmed}\n`);
if (!versionOk) { process.stdout.write(`FINDING ${short} the sheet's version row does not match the draft hash\n`); failed = true; }

for (const width of WIDTHS) {
  // Tall enough that the whole sheet is one screen: scrolling would hide rows from the check.
  const board = new LabBoard({ record, section: 'cards' }, theme, () => {}, () => {}, () => 3000);
  const rows: string[] = board.render(width).map((row: string) => stripTerminalSequences(row));
  board.dispose();
  const over = rows.filter(row => visibleWidth(row) > width).length;
  const head = rows.some(row => row.includes(sheet.boardHead[0]));
  const selected = rows.some(row => row.includes('▸ '));
  process.stdout.write(`board ${short} width=${width} over=${over} head=${head} selected=${selected}\n`);
  if (over > 0 || !head || !selected) {
    process.stdout.write(`FINDING ${short} width=${width} over=${over} head=${head} selected=${selected}\n`);
    failed = true;
  }
}

/** One key on a fresh board: the board disposes itself when it finishes, so each press is isolated. */
const press = (key: string): any => {
  let action: any;
  const board = new LabBoard({ record, section: 'cards' }, theme, (result: any) => { action = result; }, () => {}, () => 3000);
  board.render(80);
  board.handleInput(key);
  board.dispose();
  return action;
};
const accept = press('y');
const expect = press('e');
const firstId = record.scenarios[0]?.id;
const keys = `y=${accept?.type ?? 'none'} e=${expect?.type ?? 'none'} scenario=${expect?.scenarioId === firstId && !!firstId}`;
process.stdout.write(`keys ${keys}\n`);
if (keys !== 'y=accept e=expect scenario=true') {
  process.stdout.write(`FINDING ${short} the sheet keys did not map to accept and expect\n`);
  failed = true;
}

process.exit(failed ? 1 : 0);
