/*
 * Scripted agreement check on stored runs: the real `/agent-lab` command, driven by scripted keys,
 * puts quick marks (`y`, `n` with a synthetic reason, `s`, and `y` on a sampled pass when the run
 * has one) on a TEMPORARY COPY of each run, then the board, the CLI summary and the Pi surfaces
 * are read back from that copy.
 *
 *   npx tsx agreement-check.mts --source <dir with stored runs> --id RUN [--id RUN…] [--debug]
 *
 * Read-only on the source: records are read through `ExperimentStore.get` (a reader, no lock) and
 * copied byte for byte; every original file is hashed before and after. The copy lives in a 0700
 * temporary folder that is deleted at the end, also on error. No run, score or reassess command is
 * invoked, so no model is called.
 *
 * Imports the extension and dist/ from the repository three levels above this file, like
 * pi-surface-check, so a snapshot checks its own build. Stored runs hold bank dialogues, so only
 * ids, counts and booleans are printed: never a title, a dialogue turn, a reason or judge wording.
 * `--debug` adds error messages on stderr (they are the lab's own messages, not record text).
 * Exit 1 on any failed expectation, 2 on a usage error.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { values } = parseArgs({ options: {
  source: { type: 'string' }, id: { type: 'string', multiple: true }, debug: { type: 'boolean', default: false },
} });
if (!values.source || !values.id?.length) {
  process.stderr.write('Usage: agreement-check.mts --source DIR --id RUN [--id RUN]\n');
  process.exit(2);
}
const source = resolve(values.source);

const agentLab = (await import(pathToFileURL(resolve(root, 'extensions/agent-lab.ts')).href)).default;
const { reviewOrder } = await import(pathToFileURL(resolve(root, 'extensions/cards.ts')).href);
const { ExperimentStore } = await import(pathToFileURL(resolve(root, 'dist/store.js')).href);
const { judgeAgreement } = await import(pathToFileURL(resolve(root, 'dist/agreement.js')).href);
const { measurementHash, resultHash } = await import(pathToFileURL(resolve(root, 'dist/experiment.js')).href);
const { stripTerminalSequences } = await import('@earendil-works/pi-tui');

const REASON = 'Проверка: судья не учёл уточнение клиента.';
const SAMPLE_LEAD = 'Проверьте и успех: судья мог ошибочно похвалить.';
const WIDTH = 120;
const BOARD_TIMEOUT_MS = 60000;

type Rec = { id: string; parentRunId?: string; assessmentOf?: string; trials: { id: string; judgeReceipt?: unknown; judgeAudit?: unknown }[];
  humanReviews?: { trialId: string; source?: string; verdict: string; judgeVerdict?: string; judge?: unknown }[] };
type Board = { render(width: number): string[]; handleInput(data: string): void; dispose?(): void };
type Step = (board: Board) => Promise<void> | void;

const sha256 = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const exists = async (path: string) => stat(path).then(() => true, () => false);
const plain = (board: Board) => stripTerminalSequences(board.render(WIDTH).join('\n')).split('\n');
/** The trimmed cells of each rendered row: the frame and the sidebar are separated by «│». */
const cellsOf = (rows: string[]) => rows.map(row => row.split('│').map(cell => cell.trim()).filter(Boolean));

/** Every stored file of one run: the record, its trace and its judge sidecars. */
async function runFiles(dir: string, id: string): Promise<string[]> {
  const files = [`${id}.json`];
  if (await exists(join(dir, `${id}.trace.jsonl`))) files.push(`${id}.trace.jsonl`);
  if (await exists(join(dir, `${id}.judge`))) {
    for (const entry of await readdir(join(dir, `${id}.judge`), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files.push(join(entry.parentPath, entry.name).slice(dir.length + 1));
    }
  }
  return files;
}

async function hashAll(dir: string, files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const file of files) parts.push(`${file}:${await sha256(join(dir, file))}`);
  return parts.join('\n');
}

/** Register the extension with a fake Pi and return the `/agent-lab` handler. */
function register() {
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  agentLab({
    registerTool: () => undefined,
    registerCommand: (name: string, options: { handler: typeof command }) => { if (name === 'agent-lab') command = options.handler; },
    on: (name: string, handler: () => Promise<void>) => { if (name === 'session_shutdown') shutdown = handler; },
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
  });
  if (!command) throw new Error('agent-lab command is not registered');
  return { command, shutdown };
}

/** A Pi `ctx` whose board runs one scripted step per opening and whose editor returns the synthetic reason. */
function scriptedContext(cwd: string, steps: Step[]) {
  const counters = { editor: 0, editorPrefilled: 0, errors: 0 };
  const ui = {
    getEditorText: () => '',
    setEditorText: () => undefined,
    setTitle: () => undefined,
    editor: async (_title: string, prefill?: string) => { counters.editor++; if (prefill) counters.editorPrefilled++; return REASON; },
    confirm: async () => false, // Never stop anything: nothing is running on the copy.
    notify: (_message: string, type?: string) => { if (type === 'error') counters.errors++; },
    custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Board) => new Promise((resolveBoard, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; component.dispose?.(); reject(new Error('board did not finish')); } }, BOARD_TIMEOUT_MS);
      const component = factory({ terminal: { rows: 400 }, requestRender() {} },
        { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text },
        {}, value => { if (settled) return; settled = true; clearTimeout(timer); component.dispose?.(); resolveBoard(value); });
      void (async () => {
        const step = steps.shift();
        if (!step) throw new Error('unexpected board');
        await step(component);
      })().catch(error => { if (settled) return; settled = true; clearTimeout(timer); component.dispose?.(); reject(error); });
    }),
  };
  return { ctx: { cwd, mode: 'tui', hasUI: true, model: undefined, ui }, counters };
}

const press = (board: Board, ...keys: string[]) => { for (const key of keys) board.handleInput(key); };

let failed = false;
for (const id of values.id) {
  const short = id.slice(0, 8);
  const reader = new ExperimentStore(source);
  let tmp: string | undefined;
  let copied: { id: string; files: string[]; before: string }[] = [];
  try {
    // 1. The copy set: the run and the runs it names; each with the sha256 of every original file.
    const original: Rec = await reader.get(id);
    const ids = [...new Set([id, original.parentRunId, original.assessmentOf].filter((v): v is string => !!v))];
    for (const runId of ids) {
      if (!await exists(join(source, `${runId}.json`))) continue;
      const files = await runFiles(source, runId);
      copied.push({ id: runId, files, before: await hashAll(source, files) });
    }

    // 2. A private temporary folder.
    process.umask(0o077);
    tmp = await mkdtemp(join(tmpdir(), 'agent-lab-agreement-'));
    await chmod(tmp, 0o700);
    const data = join(tmp, '.agent-lab');
    await mkdir(data, { mode: 0o700 });
    for (const run of copied) {
      for (const file of run.files) {
        const target = join(data, file);
        if (dirname(target) !== data) await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await copyFile(join(source, file), target);
        await chmod(target, 0o600);
      }
    }

    // 3–4. First session: y, n (synthetic reason), s on the first queued failures; y on a sampled pass.
    const before = judgeAgreement(original);
    const first = register();
    const steps: Step[] = [
      board => press(board, '3', 'y'),
      board => press(board, 'n'),
      board => press(board, 's'),
    ];
    let sampleFound = before.sampledPasses.length === 0;
    if (before.sampledPasses.length) {
      steps.push(board => {
        const limit = original.trials.length;
        for (let i = 0; i <= limit; i++) {
          if (plain(board).some(row => row.includes(SAMPLE_LEAD))) { sampleFound = true; break; }
          press(board, 'j');
        }
        // Without the lead row `y` would mark something else; close instead and let the counts fail.
        press(board, sampleFound ? 'y' : 'q');
      });
    }
    steps.push(board => press(board, 'q'));
    const session = scriptedContext(tmp, steps);
    try { await first.command(id, session.ctx); } finally { await first.shutdown?.(); }

    // 5. Second session: the agreed situation shows the mark, and the evidence comes before the verdict.
    const store = new ExperimentStore(data);
    const marked: Rec = await store.get(id);
    const quick = (marked.humanReviews ?? []).filter(r => r.source === 'quick');
    const agreedTrial = quick.find(r => r.verdict === r.judgeVerdict)?.trialId;
    let reopenShowsMark = false;
    let evidenceBeforeVerdict = false;
    if (agreedTrial) {
      const index = reviewOrder(marked).findIndex((t: { id: string }) => t.id === agreedTrial);
      const second = register();
      const view = scriptedContext(tmp, [board => {
        press(board, '3');
        for (let i = 0; i < index; i++) press(board, 'j');
        const rows = cellsOf(plain(board));
        reopenShowsMark = rows.some(cells => cells.includes('Ваша отметка: = согласен'));
        const evidence = rows.findIndex(cells => cells.some(cell => cell.startsWith('Должен был')));
        const verdict = rows.findIndex(cells => cells.some(cell => cell.startsWith('Судья: ')));
        evidenceBeforeVerdict = evidence >= 0 && verdict >= 0 && evidence < verdict;
        press(board, 'q');
      }]);
      try { await second.command(id, view.ctx); } finally { await second.shutdown?.(); }
      session.counters.errors += view.counters.errors;
    }

    // 6. What the copy holds now.
    const after: Rec = await store.get(id);
    const marks = (after.humanReviews ?? []).filter(r => r.source === 'quick');
    const agree = marks.filter(r => r.verdict === r.judgeVerdict).length;
    const unsure = marks.filter(r => r.verdict === 'unknown').length;
    const disagree = marks.length - agree - unsure;
    const withJudge = marks.filter(r => r.judge).length;
    const judgedMarks = marks.filter(r => { const t = after.trials.find(x => x.id === r.trialId); return !!(t?.judgeReceipt ?? t?.judgeAudit); }).length;
    const sameMeasurement = measurementHash(after) === measurementHash(original);
    const resultChanged = resultHash(after) !== resultHash(original);
    const agreement = judgeAgreement(after);

    // 7. CLI summary of the copy.
    const cli = spawnSync(process.execPath, [resolve(root, 'dist/cli.js'), 'summary', '--id', id, '--data-dir', data], { encoding: 'utf8' });
    const cliLines = cli.status === 0 ? cli.stdout.split('\n') : [];
    const cliAgreementRow = cliLines.some(l => l.startsWith('Согласие с судьёй: ') && l.includes(' из ')) ? 1 : 0;
    const cliDisagreementHeading = cliLines.some(l => l === 'Несогласия с судьёй (1):') ? 1 : 0;

    // 8. The phase-1 surface check on the copy, from the same root.
    const surface = spawnSync(process.execPath, ['--import', 'tsx', resolve(root, '.planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts'),
      '--cwd', tmp, '--id', id], { encoding: 'utf8', cwd: root });
    const surfacesOk = surface.status === 0 && surface.stdout.split('\n').some(l => l.startsWith('OK ') && l.includes(' disagreements=1 '));

    // 9. The originals are unchanged.
    let originalsUnchanged = true;
    for (const run of copied) if (await hashAll(source, run.files) !== run.before) originalsUnchanged = false;
    copied = [];

    // 10. One line of ids, counts and booleans.
    process.stdout.write(`check id=${short} marks=${marks.length} agree=${agree} disagree=${disagree} unsure=${unsure} `
      + `snapshot=${withJudge}/${marks.length} measurementHash=${sameMeasurement ? 'same' : 'changed'} resultHash=${resultChanged ? 'changed' : 'same'} `
      + `agreement=${agreement.agreed}/${agreement.checked} failures=${agreement.failures.agreed}/${agreement.failures.checked} `
      + `passes=${agreement.passes.agreed}/${agreement.passes.checked} sample=${agreement.sampleChecked} `
      + `reopenShowsMark=${reopenShowsMark} evidenceBeforeVerdict=${evidenceBeforeVerdict} cliAgreementRow=${cliAgreementRow} `
      + `cliDisagreementHeading=${cliDisagreementHeading} surfaces=${surfacesOk ? 'ok' : 'diff'} originalsUnchanged=${originalsUnchanged}\n`);
    const ok = reopenShowsMark && evidenceBeforeVerdict && cliAgreementRow === 1 && cliDisagreementHeading === 1 && surfacesOk
      && originalsUnchanged && sameMeasurement && resultChanged && disagree === 1 && withJudge === judgedMarks
      && sampleFound && session.counters.editor === 1 && session.counters.errors === 0;
    if (!ok) {
      failed = true;
      process.stdout.write(`detail id=${short} sampleFound=${sampleFound} editor=${session.counters.editor} prefilled=${session.counters.editorPrefilled} `
        + `errors=${session.counters.errors} judgedMarks=${judgedMarks} cliExit=${cli.status} surfaceExit=${surface.status}\n`);
    }
  } catch (error) {
    failed = true;
    process.stdout.write(`error id=${short}\n`);
    if (values.debug) process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  } finally {
    // Even on error: the originals are compared, and the copy is removed.
    for (const run of copied) {
      if (await hashAll(source, run.files).catch(() => '') !== run.before) process.stdout.write(`originalsUnchanged=false id=${short}\n`);
    }
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
