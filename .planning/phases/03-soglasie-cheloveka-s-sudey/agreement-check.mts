/*
 * Scripted agreement check on stored runs: the real `/agent-lab` command, driven by scripted keys,
 * puts quick marks (`y`, `n` with a synthetic reason, `s`, and `y` on a sampled pass when the run
 * has one) on a TEMPORARY COPY of each run, then the board, the CLI summary and the Pi surfaces
 * are read back from that copy.
 *
 * Under the counting rule `goal-and-rules-v2` (03.1) one key answers every metric that decided the
 * situation: `n` on a double failure answers the native select «С чем вы не согласны?» with the
 * scripted choice, so the check also counts marks per situation, the stamped counting rule on every
 * mark, the notices «Итог пересчитан» / «Ситуация остаётся «не справился»» (counted, never printed),
 * the invariant «agreement queue = decided − passed of the headline», the headline of the copy after
 * the marks, and — when the run has a positive control — that `y`, `n`, `s` stay inert on it.
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
const { buildResultView, COUNTING_RULES } = await import(pathToFileURL(resolve(root, 'dist/result-view.js')).href);
const { stripTerminalSequences } = await import('@earendil-works/pi-tui');

const REASON = 'Проверка: судья не учёл уточнение клиента.';
const SAMPLE_LEAD = 'Проверьте и успех: судья мог ошибочно похвалить.';
const SELECT_TITLE = 'С чем вы не согласны?';
const CHOICE_RULES = 'Правила промпта соблюдены — судья ошибся';
const CHOICE_BOTH = 'С обоими: запрос выполнен и правила соблюдены';
const RECOUNT_NOTICE = 'Итог пересчитан с учётом вашей отметки.';
const KEPT_NOTICE = 'Ситуация остаётся «не справился»';
const CONTROL_ROW = 'Контрольная ситуация — в согласие с судьёй не входит.';
const MARK_ROW: Record<string, string> = { agree: 'Ваша отметка: = согласен', disagree: 'Ваша отметка: ! не согласен', unsure: 'Ваша отметка: ~ не могу сказать' };
const WIDTH = 120;
/** Header rows are truncated, not wrapped, so the notice is scanned on a render too wide to cut its tail after a long title. */
const NOTICE_WIDTH = 600;
const BOARD_TIMEOUT_MS = 60000;

type Rec = { id: string; parentRunId?: string; assessmentOf?: string; positiveControlScenarioIds?: string[];
  trials: { id: string; scenarioId: string; judgeReceipt?: unknown; judgeAudit?: unknown }[];
  humanReviews?: { trialId: string; source?: string; verdict: string; judgeVerdict?: string; judge?: unknown; countingRules?: string }[] };
type Board = { render(width: number): string[]; handleInput(data: string): void; dispose?(): void };
/** `opened.closed` turns true when the board finishes (emits an action) during this opening. */
type Step = (board: Board, opened: { closed: boolean }) => Promise<void> | void;

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

/**
 * A Pi `ctx` whose board runs one scripted step per opening, whose editor returns the synthetic
 * reason and whose select answers «С чем вы не согласны?» with `choice` (anything else is Esc).
 * Before each step the board is rendered once and the notice of the previous answer is counted:
 * `recount` for «Итог пересчитан…», `kept` for «Ситуация остаётся «не справился»…» — counted only.
 */
function scriptedContext(cwd: string, steps: Step[], choice?: string) {
  const counters = { editor: 0, editorPrefilled: 0, errors: 0, select: 0, recount: 0, kept: 0 };
  const ui = {
    getEditorText: () => '',
    setEditorText: () => undefined,
    setTitle: () => undefined,
    editor: async (_title: string, prefill?: string) => { counters.editor++; if (prefill) counters.editorPrefilled++; return REASON; },
    select: async (title: string, options: string[]) => { counters.select++; return title === SELECT_TITLE ? options.find(option => option === choice) : undefined; },
    confirm: async () => false, // Never stop anything: nothing is running on the copy.
    notify: (_message: string, type?: string) => { if (type === 'error') counters.errors++; },
    custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Board) => new Promise((resolveBoard, reject) => {
      let settled = false;
      const opened = { closed: false };
      const timer = setTimeout(() => { if (!settled) { settled = true; component.dispose?.(); reject(new Error('board did not finish')); } }, BOARD_TIMEOUT_MS);
      const component = factory({ terminal: { rows: 400 }, requestRender() {} },
        { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text },
        {}, value => { opened.closed = true; if (settled) return; settled = true; clearTimeout(timer); component.dispose?.(); resolveBoard(value); });
      void (async () => {
        const step = steps.shift();
        if (!step) throw new Error('unexpected board');
        for (const row of stripTerminalSequences(component.render(NOTICE_WIDTH).join('\n')).split('\n')) {
          if (row.includes(RECOUNT_NOTICE)) counters.recount++;
          if (row.includes(KEPT_NOTICE)) counters.kept++;
        }
        await step(component, opened);
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

    // 3. Before writing: the queue equals the failures the headline decides (CR-01, 03.1-02 D7).
    const before = judgeAgreement(original);
    const view0 = buildResultView(original);
    const queue: number = before.queueFailures.length;
    const decided: number = view0.headline.decided;
    const invariant = queue === view0.headline.decided - view0.headline.passed;

    // 4. First session, by queue size: y, n (the scripted select choice + the synthetic reason), s
    //    on the first queued failures; y on a sampled pass when the run has one; then q.
    const first = register();
    const steps: Step[] = [];
    let choice: string | undefined;
    let sampleFound = before.sampledPasses.length === 0;
    if (queue >= 3) {
      steps.push(board => press(board, '3', 'y'), board => press(board, 'n'), board => press(board, 's'));
      choice = CHOICE_RULES;
    } else if (queue === 2) {
      steps.push(board => press(board, '3', 'y'), board => press(board, 'n'));
      choice = CHOICE_RULES;
    } else if (queue === 1) {
      steps.push(board => press(board, '3', 'n'));
      choice = CHOICE_BOTH;
    }
    if (queue >= 3 && before.sampledPasses.length) {
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
    const session = scriptedContext(tmp, steps, choice);
    try { await first.command(id, session.ctx); } finally { await first.shutdown?.(); }

    // 5. Second session: the first marked situation shows its combined answer, the evidence comes
    //    before the verdict, and on a positive control the agreement keys do nothing.
    const store = new ExperimentStore(data);
    const marked: Rec = await store.get(id);
    const quick = (marked.humanReviews ?? []).filter(r => r.source === 'quick');
    const firstTrial = quick[0]?.trialId;
    const controls = new Set(marked.positiveControlScenarioIds ?? []);
    const controlTrial = marked.trials.find(t => controls.has(t.scenarioId))?.id;
    let reopenShowsMark = false;
    let evidenceBeforeVerdict = false;
    let controlInert: 'true' | 'false' | 'none' = controlTrial ? 'false' : 'none';
    if (firstTrial) {
      const order: { id: string }[] = reviewOrder(marked);
      const index = order.findIndex(t => t.id === firstTrial);
      const expectedRow = MARK_ROW[judgeAgreement(marked).marks.find((m: { trialId: string }) => m.trialId === firstTrial)?.answer ?? ''];
      const second = register();
      const view = scriptedContext(tmp, [(board, opened) => {
        press(board, '3');
        for (let i = 0; i < index; i++) press(board, 'j');
        const rows = cellsOf(plain(board));
        reopenShowsMark = !!expectedRow && rows.some(cells => cells.includes(expectedRow));
        const evidence = rows.findIndex(cells => cells.some(cell => cell.startsWith('Должен был')));
        const verdict = rows.findIndex(cells => cells.some(cell => cell.startsWith('Судья: ')));
        evidenceBeforeVerdict = evidence >= 0 && verdict >= 0 && evidence < verdict;
        if (controlTrial) {
          const controlIndex = order.findIndex(t => t.id === controlTrial);
          const distance = controlIndex - index;
          for (let i = 0; i < Math.abs(distance); i++) press(board, distance > 0 ? 'j' : 'k');
          const controlRow = cellsOf(plain(board)).some(cells => cells.includes(CONTROL_ROW));
          press(board, 'y', 'n', 's');
          controlInert = controlRow && !opened.closed ? 'true' : 'false';
        }
        press(board, 'q');
      }]);
      try { await second.command(id, view.ctx); } finally { await second.shutdown?.(); }
      session.counters.errors += view.counters.errors;
    }

    // 6. What the copy holds now.
    const after: Rec = await store.get(id);
    const marks = (after.humanReviews ?? []).filter(r => r.source === 'quick');
    const situations = new Set(marks.map(r => r.trialId)).size;
    const agree = marks.filter(r => r.verdict === r.judgeVerdict).length;
    const unsure = marks.filter(r => r.verdict === 'unknown').length;
    const disagree = marks.length - agree - unsure;
    const stamped = marks.filter(r => r.countingRules === COUNTING_RULES).length;
    const withJudge = marks.filter(r => r.judge).length;
    const judgedMarks = marks.filter(r => { const t = after.trials.find(x => x.id === r.trialId); return !!(t?.judgeReceipt ?? t?.judgeAudit); }).length;
    const sameMeasurement = measurementHash(after) === measurementHash(original);
    const resultChanged = resultHash(after) !== resultHash(original);
    const agreement = judgeAgreement(after);
    const headline = buildResultView(after).headline;
    const staleRule: number = agreement.staleRule;
    const disagreements: number = agreement.disagreements.length;

    // 7. CLI summary of the copy.
    const cli = spawnSync(process.execPath, [resolve(root, 'dist/cli.js'), 'summary', '--id', id, '--data-dir', data], { encoding: 'utf8' });
    const cliLines = cli.status === 0 ? cli.stdout.split('\n') : [];
    const cliAgreementRow = cliLines.some(l => l.startsWith('Согласие с судьёй: ') && l.includes(' из ')) ? 1 : 0;
    const cliDisagreementHeading = cliLines.some(l => l === 'Несогласия с судьёй (1):') ? 1 : 0;

    // 8. The phase-1 surface check on the copy, from the same root.
    const surface = spawnSync(process.execPath, ['--import', 'tsx', resolve(root, '.planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts'),
      '--cwd', tmp, '--id', id], { encoding: 'utf8', cwd: root });
    const surfacesOk = surface.status === 0 && surface.stdout.split('\n').some(l => l.startsWith('OK ') && l.includes(' disagreements=1 '));
    // The surface check prints only ids and counts (OK / DIFF lines), so its stdout is safe to echo under --debug.
    if (values.debug && !surfacesOk) process.stderr.write(`surface id=${short} exit=${surface.status}\n${surface.stdout}`);

    // 9. The originals are unchanged.
    let originalsUnchanged = true;
    for (const run of copied) if (await hashAll(source, run.files) !== run.before) originalsUnchanged = false;
    copied = [];

    // 10. One line of ids, counts and booleans.
    process.stdout.write(`check id=${short} situations=${situations} marks=${marks.length} agree=${agree} disagree=${disagree} unsure=${unsure} `
      + `select=${session.counters.select} stamped=${stamped}/${marks.length} snapshot=${withJudge}/${marks.length} `
      + `measurementHash=${sameMeasurement ? 'same' : 'changed'} resultHash=${resultChanged ? 'changed' : 'same'} `
      + `agreement=${agreement.agreed}/${agreement.checked} failures=${agreement.failures.agreed}/${agreement.failures.checked} `
      + `passes=${agreement.passes.agreed}/${agreement.passes.checked} sample=${agreement.sampleChecked} staleRule=${staleRule} `
      + `queue=${queue} decided=${decided} invariant=${invariant} headline=${headline.passed}/${headline.decided} `
      + `recount=${session.counters.recount} kept=${session.counters.kept} `
      + `reopenShowsMark=${reopenShowsMark} evidenceBeforeVerdict=${evidenceBeforeVerdict} controlInert=${controlInert} `
      + `cliAgreementRow=${cliAgreementRow} cliDisagreementHeading=${cliDisagreementHeading} surfaces=${surfacesOk ? 'ok' : 'diff'} originalsUnchanged=${originalsUnchanged}\n`);
    const ok = reopenShowsMark && evidenceBeforeVerdict && invariant && controlInert !== 'false'
      && cliAgreementRow === 1 && cliDisagreementHeading === 1 && surfacesOk
      && originalsUnchanged && sameMeasurement && resultChanged && disagreements === 1
      && stamped === marks.length && withJudge === judgedMarks && staleRule === 0
      && sampleFound && session.counters.editor === 1 && session.counters.select === 1 && session.counters.errors === 0;
    if (!ok) {
      failed = true;
      process.stdout.write(`detail id=${short} sampleFound=${sampleFound} editor=${session.counters.editor} prefilled=${session.counters.editorPrefilled} `
        + `select=${session.counters.select} errors=${session.counters.errors} judgedMarks=${judgedMarks} disagreements=${disagreements} `
        + `cliExit=${cli.status} surfaceExit=${surface.status}\n`);
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
