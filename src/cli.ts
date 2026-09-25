#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { ExperimentLab } from './experiment.js';
import type { CreateOptions, PreparationOptions } from './lab/library.js';
import { draftHash } from './lab/record.js';
import { demoInput } from './demo.js';
import { createInputSchema, isRunnable, materialSources, SCENARIO_LIMIT, settingsSchema, type CreateInput, type Settings } from './contracts.js';
import { compareRuns } from './comparison.js';
import { doctor, listSuites, readConnection, rememberedConnection, rememberConnection } from './connection.js';
import { detectionLines, detectProject, promptLine } from './detect.js';
import { readDialogueImport, importDialogues } from './imports.js';
import { expandMaterials, promptMaterials } from './materials.js';
import type { PromptCandidate } from './prompt-candidates.js';
import { proposedPrompts, proposePurposes, purposeConsentLine, purposeKey, purposeLine, type PurposeProposal } from './prompt-purpose.js';
import { createPiRuntime, getPiStatus } from './pi.js';
import { htmlReport, jsonReport, markdownReport } from './report.js';
import { expectationSheet, testPlanLines, trialProofLines } from './quality.js';
import { ExperimentStore } from './store.js';
import { buildResultView, exitCodeOf, type ResultView } from './result-view.js';
import { judgeCheckText, MAX_WIDTH, plainText, resultScreen, type ResultRow } from './result-text.js';
import { judgeCheckPlan, judgeCheckSummary } from './judge-check.js';
import { evidenceBundle, exportArtifacts, importNumbers, readJudgeCheck, resolveVerified } from './artifacts.js';
import { libraryHash } from './scenario-library.js';
import { hostGrant, requiredAuthority, wordsOf } from './card/commands.js';
import { conversionText } from './card/convert.js';
import { cardCommandSchema, type CardCommand, type LibraryV2 } from './card/schema.js';
import { rulebookChangeLines, rulebookLines, rulebookOf, shownRulebook, withKind, withRules } from './card/rulebook.js';
import { actionRow, briefRows, changeText, countsText, detailRows, formatNote, listRows, plainSituationText, situationActions, situationData, situationViews, type SituationView } from './card/view.js';
import { safeLine } from './text.js';
import { countText } from './plural.js';
import { logImports } from './card/calibration-scope.js';
import { confirmTableImport, planTableReading, proposeReading, proposeTableImport, readingConsent } from './spreadsheet/import.js';
import type { TableProposal } from './spreadsheet/proposal.js';
import { READING_CALLS } from './spreadsheet/reading-task.js';
import { importedLine, proposalLines } from './spreadsheet/lines.js';
import { importHints, tableChoicesOf } from './cli/import-flags.js';
import { connectFromCurl, doctorTemplate } from './cli/connect.js';
import { preparationBudget, preparationCeiling } from './card/budget.js';
import { builderOf, consentText, preparationConsent, rulesConsentText, situationCount } from './miner/plan.js';

/*
 * `agent-lab`: one table of commands over the operations Pi's tools use (experiment.ts). A command that writes or
 * spends opens the data folder as its one writer and takes the owner's word as --yes, where the chat asks natively;
 * a command that only reads never takes the writer's lock, so it may run beside a live run. `chat` — and no command
 * in a terminal — opens Pi with the Agent Lab extension.
 *
 * Inside that chat the owner's word belongs to the chat: `agent-lab chat` gives Pi AGENT_LAB_SESSION, Pi's shell
 * passes its whole environment to every command it runs, and the chat asks each consent and decision in a native
 * dialog. A command run from the chat's shell — by the model or by the owner's `!` — therefore refuses --yes, unless
 * that shell drops the variable, which nothing here can prevent (IN_CHAT).
 */

const FLAGS = {
  'data-dir': { type: 'string' }, input: { type: 'string' }, id: { type: 'string' }, output: { type: 'string' },
  task: { type: 'string' }, operation: { type: 'string' }, 'expected-hash': { type: 'string' },
  before: { type: 'string' }, after: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  format: { type: 'string', default: 'json' }, json: { type: 'boolean' },
  connection: { type: 'string' }, directory: { type: 'string' }, 'code-only': { type: 'boolean' },
  'dialogues-file': { type: 'string' }, trial: { type: 'string', multiple: true },
  yes: { type: 'boolean' }, case: { type: 'string', multiple: true }, control: { type: 'string', multiple: true }, parallel: { type: 'string' },
  card: { type: 'string' }, choice: { type: 'string' }, text: { type: 'string' }, check: { type: 'boolean' }, resume: { type: 'boolean' }, accept: { type: 'boolean' }, convert: { type: 'boolean' },
  'agent-version': { type: 'string' }, unknown: { type: 'boolean' }, import: { type: 'string' },
  file: { type: 'string' }, sheet: { type: 'string' }, 'id-column': { type: 'string' }, 'text-column': { type: 'string' }, separator: { type: 'string' },
  markers: { type: 'string' }, 'role-column': { type: 'string' }, roles: { type: 'string' }, 'order-column': { type: 'string' }, 'row-order': { type: 'boolean' },
  where: { type: 'string' }, 'no-separator': { type: 'boolean' }, 'collapse-repeats': { type: 'boolean' }, 'keep-repeats': { type: 'boolean' },
  situations: { type: 'string' }, 'prompts-from': { type: 'string' }, prompt: { type: 'string', multiple: true }, prompts: { type: 'string' },
  planted: { type: 'string' }, controls: { type: 'string' },
  curl: { type: 'string' }, message: { type: 'string' }, conversation: { type: 'string', multiple: true }, reply: { type: 'string' },
  'operator-rules': { type: 'string' }, 'bind-rule': { type: 'string', multiple: true }, 'unbind-rule': { type: 'string', multiple: true },
} as const;
type Flags = ReturnType<typeof parseArgs<{ options: typeof FLAGS; allowPositionals: true }>>['values'];

/** What a command gets: the owner's flags and the data folder they point at. */
interface CommandInput { values: Flags; directory: string }
interface Command {
  /** What `agent-lab --help` says about the command, in the owner's words. */
  help: readonly string[];
  run(input: CommandInput): Promise<void>;
}

/**
 * The rows of the result screen with every text made safe for a terminal before layout: titles, quotes
 * and the owner's reasons come from records, and the layout must measure what will actually be printed.
 */
const cliRows = (view: ResultView): ResultRow[] => resultScreen(view, { surface: 'cli' }).map(row => ({ ...row, text: safeLine(row.text),
  ...(row.right === undefined ? {} : { right: safeLine(row.right) }), ...(row.short === undefined ? {} : { short: safeLine(row.short) }),
  ...(row.parts ? { parts: row.parts.map(safeLine) } : {}) }));
/** The result screen as the terminal shows it: the same rows as the board, wrapped to the terminal width. */
const screenText = (view: ResultView, warnings: string[]) => [plainText(cliRows(view), process.stdout.columns ?? MAX_WIDTH),
  ...warnings.map(warning => `Внимание: ${safeLine(warning)}`), ''].join('\n');
/** What `evaluate`, `run` and `reassess` print for a script: the one view, its exit code and the screen lines. */
const machineResult = (view: ResultView) => ({ view, exitCode: exitCodeOf(view), lines: plainText(cliRows(view), MAX_WIDTH).split('\n') });
const writeStdout = (value: string): Promise<void> => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (error?: Error | null) => {
    if (settled) return;
    settled = true;
    process.stdout.off('error', onError);
    if (error) reject(error); else resolve();
  };
  const onError = (error: Error) => finish(error);
  process.stdout.once('error', onError);
  process.stdout.write(value, finish);
});

/**
 * Set by `agent-lab chat` for Pi, and so present in every command Pi's shell runs in that chat. Any value counts, an
 * empty one too: `AGENT_LAB_SESSION= agent-lab run --yes` is still a command from the chat. This only keeps the chat's
 * model from consenting for the owner by accident; a shell without limits can always drop the variable
 * (`env -u AGENT_LAB_SESSION …`), so the real guard is Pi asking the owner before it runs a shell command.
 */
const IN_CHAT = process.env.AGENT_LAB_SESSION !== undefined;
const CHAT_ASKS = 'Из чата Agent Lab команда с --yes не выполняется: в чате согласие на расход и решения спрашивает сам чат. '
  + 'Скажите обычными словами, что сделать, — Lab спросит вас. Ничего не записано и не потрачено.';

/** Opens the data folder as its one writer for `work`; Ctrl+C closes it, and the work going on stops with its evidence kept. */
async function asWriter(directory: string, work: (lab: ExperimentLab) => Promise<void>): Promise<void> {
  const lab = new ExperimentLab(directory);
  await lab.init();
  const cancel = () => { void lab.close().catch(error => { process.stderr.write(`${safeLine(error.message)}\n`); process.exitCode = 1; }); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { await work(lab); } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    await lab.close();
  }
}

/** Pi with the Agent Lab extension, in this terminal. */
async function chat(args: string[]): Promise<void> {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
  // Pi's session files keep every tool result, and Lab's results quote the customers' messages word for word: whatever
  // Pi writes in this chat is the owner's alone (0600 files, 0700 folders), as the records in .agent-lab are. The child
  // inherits the mask; this process only waits for it.
  process.umask(0o077);
  // The Agent Lab session gets the agent-builder skill's text as its instructions (extensions/agent-lab.ts); listed
  // as a skill as well, it would only invite the model to read the same text twice.
  const child = spawn(process.execPath, [resolve(piRoot, 'dist/bundle/cli.js'), '--no-extensions', '--no-skills', '-e', resolve(root, 'extensions/agent-lab.ts'), ...args],
    { stdio: 'inherit', env: { ...process.env, AGENT_LAB_SESSION: '1' } });
  process.exitCode = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1))); });
}

async function detect({ values }: CommandInput): Promise<void> {
  // Read-only: nothing is started, imported or written; a .env file contributes variable names only.
  const detection = await detectProject(values.directory ?? process.cwd());
  await writeStdout(values.json ? `${JSON.stringify(detection, null, 2)}\n` : `${detectionLines(detection).map(safeLine).join('\n')}\n`);
}

/** The settings of the task file `input`: its builder model reads tables, as it prepares the situations from them. */
async function taskSettings(input: string): Promise<Settings> {
  const raw = JSON.parse(await readFile(input, 'utf8')) as { settings?: unknown };
  const settings = settingsSchema.parse(raw.settings ?? {});
  if (!settings.provider || !settings.model) throw new Error(`В ${basename(input)} не выбрана модель: укажите settings.provider и settings.model.`);
  return settings;
}

async function importTable({ values, directory }: CommandInput): Promise<void> {
  if (!values.file) throw new Error('Укажите таблицу: agent-lab import --file логи.xlsx');
  const file = values.file, choices = tableChoicesOf(values);
  const show = async (proposal: TableProposal, next: string[]) => writeStdout(values.json ? `${JSON.stringify(proposal, null, 2)}\n`
    : `${[...proposalLines(proposal), '', ...next].map(line => safeLine(line)).join('\n')}\n`);
  // The model of the task file (--input) proposes the reading: a paid step, asked like the others. Its proposal is kept, so what
  // the owner saw is what --yes stores. Without a task file Lab reads the table by itself and says so.
  const settings = values.input ? await taskSettings(values.input) : undefined;
  const plan = settings && await planTableReading(file, builderOf(settings));
  let proposed = plan && await new ExperimentStore(directory).readProposedReading(plan.key);
  if (settings && plan && !proposed) {
    const consent = readingConsent(plan);
    if (!values.yes) {
      await writeStdout(values.json ? `${JSON.stringify({ question: consent.question, lines: consent.lines, rows: plan.rows, calls: READING_CALLS }, null, 2)}\n`
        : `${[consent.question, '', ...consent.lines, '', 'Предложить: та же команда с --yes. Без него ничего не записано и не потрачено.'].map(line => safeLine(line)).join('\n')}\n`);
      return;
    }
    const { tableReading } = await createPiRuntime(settings);
    if (!tableReading) throw new Error('Модель задачи не предлагает разметку таблиц.');
    await asWriter(directory, async lab => {
      proposed = await proposeReading(plan, tableReading, { timeoutMs: settings.timeoutMs });
      await lab.store.writeProposedReading(proposed);
    });
    // A reading the owner has not seen yet is never stored by the same --yes that paid for it.
    const fresh = await proposeTableImport(file, choices, proposed);
    await show(fresh, importHints(fresh));
    process.exitCode = 1;
    return;
  }
  // Reads only, until the owner says --yes to a complete proposal; the answer to a question is a flag of the same command.
  const proposal = await proposeTableImport(file, choices, proposed);
  if (proposal.status !== 'ready' || !values.yes) {
    await show(proposal, importHints(proposal));
    if (proposal.status === 'refused' || values.yes) process.exitCode = 1;
    return;
  }
  const lab = new ExperimentLab(directory);
  await lab.init();
  try {
    const { batch } = await confirmTableImport(lab.store, file, proposal);
    await writeStdout(values.json ? `${JSON.stringify({ importId: batch.id, dialogues: batch.dialogues.length, proposal }, null, 2)}\n`
      : `${[...proposalLines(proposal), '', importedLine(batch), `Дальше: agent-lab build --input ${values.input ?? 'задача.json'} --dialogues-file ${file}`].map(line => safeLine(line)).join('\n')}\n`);
  } finally { await lab.close(); }
}

async function cards({ values, directory }: CommandInput): Promise<void> {
  if (!values.id) throw new Error('Укажите --id RUN.');
  const lab = new ExperimentLab(directory);
  const situations = async (id: string) => {
    const record = await lab.get(id);
    if (record.librarySnapshot?.formatVersion !== 2) return { record, views: situationViews(record, { maxTurns: record.settings.maxTurns }) };
    const context = await lab.cardContext(id);
    return { record: context.experiment, views: situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns }),
      rulebook: shownRulebook(context.library) };
  };
  /** The list, or one situation with its question and its actions — the same rows the chat and the board draw. JSON carries each situation's id: a command file names its card by it. */
  const show = async (id: string, changes: string[] = []) => {
    const { record, views, rulebook } = await situations(id);
    const number = values.card === undefined ? undefined : Number(values.card);
    const view = number === undefined ? undefined : views.find(item => item.number === number);
    if (number !== undefined && !view) throw new Error(`Ситуации №${values.card} нет. Есть: ${views.map(item => item.number).join(', ')}.`);
    if (values.json) { await writeStdout(`${JSON.stringify({ runId: id, counts: countsText(views), ...(changes.length ? { changes } : {}), ...(view ? { situation: { id: view.id, ...situationData(view), details: view.details } } : { situations: views.map(item => ({ id: item.id, ...situationData(item) })), ...(rulebook ? { rulebook } : {}) }) }, null, 2)}\n`); return; }
    const actions = view && !view.question ? situationActions(view) : [];
    const rows = view ? [...briefRows(view), ...(actions.length ? [{ role: 'blank' as const, indent: 0, text: '' }, actionRow(actions)] : []), { role: 'blank' as const, indent: 0, text: '' }, ...detailRows(view)]
      : views.flatMap(item => listRows(item));
    const head = view ? [] : [countsText(views), ...(formatNote(record) ? [formatNote(record)!] : []), '', ...(rulebook ? [...rulebookLines(rulebook), ''] : [])];
    await writeStdout(`${[...changes, ...(changes.length ? [''] : []), ...head.map(line => line && ` ${safeLine(line)}`), plainSituationText(rows.map(row => ({ ...row, text: safeLine(row.text) })), process.stdout.columns ?? 100)].join('\n')}\n`);
  };
  if (values.convert) {
    // Free and deterministic: the new draft's situations wait for a check the owner starts with --check --yes.
    await lab.init();
    try {
      const converted = await lab.convertV1Draft(values.id);
      const text = conversionText(converted);
      if (values.json) { await writeStdout(`${JSON.stringify({ runId: converted.experiment.id, convertedFrom: values.id, left: converted.left, checkCalls: converted.calls }, null, 2)}\n`); return; }
      await writeStdout(`${[text.summary, ...text.left, text.check, `Проверить: agent-lab cards --id ${converted.experiment.id} --check --yes`, ''].map(line => safeLine(line)).join('\n')}\n`);
      await show(converted.experiment.id);
    } finally { await lab.close(); }
    return;
  }
  const rulebookFlags = values['operator-rules'] !== undefined || !!values['bind-rule']?.length || !!values['unbind-rule']?.length;
  if (!values.input && !values.choice && !values.check && !values.resume && !values.accept && !rulebookFlags) { await show(values.id); return; }
  await lab.init();
  try {
    const target: { id: string; preview?: true } = values.check || values.resume || values.accept ? { id: values.id } : await lab.editableCards(values.id);
    // A fresh copy of a finished run is only previewed: without --yes nothing is written, so it has no id to name yet.
    if (target.preview) process.stderr.write(`Прогон ${values.id} уже выполнен и не меняется: правка пойдёт в новый черновик того же набора.\n`);
    else if (target.id !== values.id) process.stderr.write(`Прогон ${values.id} уже выполнен и не меняется: правка идёт в черновик ${target.id}.\n`);
    if (values.resume || values.check || values.accept) {
      // The ceiling the owner agreed to covers the whole preparation: continuing past it is their word too, the number stated.
      const budget = values.resume ? preparationBudget(await lab.get(target.id)) : undefined;
      const raise = budget && budget.resume > budget.ceiling ? budget.resume : undefined;
      if (!values.yes) throw new Error(values.accept ? 'Утверждение фиксирует готовые ситуации для прогона; укажите --yes. Агент не запускается.'
        : raise !== undefined ? `Подготовка потратила ${budget!.spent} из ${budget!.ceiling} согласованных вызовов модели; с --yes потолок всей подготовки станет ${raise}. Агент не запускается.`
        : 'Это расходует вызовы модели в пределах лимита; укажите --yes.');
      const { record, views } = await situations(target.id);
      if (values.resume) {
        if (!record.librarySnapshot) throw new Error('Продолжать нечего.');
        await lab.resumePreparation(target.id, libraryHash(record.librarySnapshot), { ...preparationFlags(values), ...(raise !== undefined ? { callCeiling: raise } : {}) }); await lab.waitForIdle();
      }
      else if (values.check) { await lab.recheckCards(target.id, { explicit: true }); await lab.waitForIdle(); }
      else {
        const ready = views.filter(view => view.status === 'ready');
        if (!ready.length) throw new Error('Утверждать нечего: ни одна ситуация не готова.');
        await lab.acceptCards(target.id, libraryHash((await lab.cardContext(target.id)).library), ready.map(view => view.id));
      }
      await show(target.id); return;
    }
    let command: ReturnType<typeof cardCommandSchema.parse>;
    if (values.choice) {
      const view: SituationView | undefined = (await situations(target.id)).views.find(item => item.number === Number(values.card));
      if (!view?.question?.id) throw new Error(`У ситуации ${values.card ?? '(укажите --card N)'} нет открытого вопроса.`);
      if (!['a', 'b', 'c'].includes(values.choice)) throw new Error('--choice: a, b или c — ответ из списка вопроса.');
      command = { kind: 'answer_question', cardId: view.id, questionId: view.question.id, choice: values.choice as 'a' | 'b' | 'c', ...(values.text ? { text: values.text } : {}) };
    } else if (rulebookFlags) command = rulebookCommand((await lab.cardContext(target.id)).library, values);
    else command = cardCommandSchema.parse(JSON.parse(await readFile(values.input!, 'utf8')));
    // The command file and the text on the command line are the owner's own: their words, confirmed by --yes.
    const words = wordsOf(command).join('\n');
    const prepared = await lab.prepareCardCommand(target.id, command, { via: 'cli-yes', ...(words && words.length <= 1000 ? { ownerWords: words } : {}) });
    const changes = [...prepared.diff.flatMap(item => item.changes.map(change => `${item.number}  ${changeText(change)}`)),
      ...(prepared.rulebook ? rulebookChangeLines(prepared.rulebook.before, prepared.rulebook.after, prepared.next.requirements, prepared.rulebook.flagged) : [])];
    if (!values.yes) {
      await writeStdout(`${[...changes, '', ...(prepared.recheck.length ? ['После записи Lab проверит изменённое заново.'] : []), 'Записать: та же команда с --yes.'].map(line => safeLine(line)).join('\n')}\n`);
      return;
    }
    await lab.applyCardCommand(target.id, prepared, hostGrant(prepared, requiredAuthority(prepared.command) === 'owner-words' && words ? 'words' : 'confirmed'));
    if (target.preview) process.stderr.write(`Правка записана в новый черновик ${target.id}.\n`);
    const check = await lab.recheckCards(target.id);
    if (check.decision.action === 'run') await lab.waitForIdle();
    await show(target.id, changes.map(line => safeLine(line)));
  } finally { await lab.close(); }
}

/** The rulebook command of `cards --operator-rules on|off --bind-rule ID --unbind-rule ID`: the current rulebook with the owner's changes. */
function rulebookCommand(library: LibraryV2, values: Flags): CardCommand {
  const operators = values['operator-rules'];
  if (operators !== undefined && operators !== 'on' && operators !== 'off') throw new Error('--operator-rules: on — инструкции для операторов входят в свод правил, off — не входят.');
  const current = rulebookOf(library);
  const kinds = operators === undefined ? current : withKind(current, 'operator_procedure', operators === 'on');
  return { kind: 'set_rulebook', rulebook: withRules(kinds, { include: values['bind-rule'] ?? [], exclude: values['unbind-rule'] ?? [] }) };
}

async function logs({ values, directory }: CommandInput): Promise<void> {
  if (!values.id) throw new Error('Укажите --id RUN.');
  if (values['agent-version'] !== undefined && values.unknown) throw new Error('Либо --agent-version, либо --unknown.');
  const lab = new ExperimentLab(directory);
  const importIds = logImports(await lab.get(values.id));
  const said = (version: string | null | undefined) => version === undefined ? 'не указана' : version ?? 'неизвестна';
  if (values['agent-version'] === undefined && !values.unknown) {
    const rows = await Promise.all(importIds.map(async id => `${id} · ${countText((await lab.store.readImport(id)).dialogues.length, ['разговор', 'разговора', 'разговоров'])}`
      + ` · версия агента: ${said((await lab.store.readLogVersions(id))?.declarations.at(-1)?.command.version)}`));
    await writeStdout(`${[...rows.length ? rows : ['У этого прогона нет логов.'], '', 'Указать версию: agent-lab logs --id RUN --agent-version ВЕРСИЯ --yes (или --unknown)'].map(line => safeLine(line)).join('\n')}\n`);
    return;
  }
  const importId = values.import ?? (importIds.length === 1 ? importIds[0] : undefined);
  if (!importId || !importIds.includes(importId)) throw new Error(`Укажите --import: ${importIds.join(', ') || 'у этого прогона нет логов'}.`);
  const prepared = await lab.prepareLogVersion({ kind: 'declare_log_version', importId, version: values.unknown ? null : values['agent-version']! }, { via: 'cli-yes' });
  const change = `Версия агента в логах: было «${said(prepared.change.before)}», стало «${said(prepared.change.after)}».`;
  if (!values.yes) { await writeStdout(`${safeLine(change)}\nЗаписать: та же команда с --yes.\n`); return; }
  await lab.init();
  try { await lab.applyLogVersion(prepared, hostGrant(prepared, 'confirmed')); } finally { await lab.close(); }
  await writeStdout(`${safeLine(change)} Записано: следующая сверка с продом прочтёт её.\n`);
}

async function checkConnection({ values, directory }: CommandInput): Promise<void> {
  const connection = values.connection ? await readConnection(values.connection) : await rememberedConnection(directory);
  const target = connection?.target;
  if (connection && target?.kind === 'http' && target.request) {
    await doctorTemplate({ connection, target: { ...target, request: target.request }, directory, yes: values.yes, file: values.connection && resolve(values.connection), reply: values.reply });
    return;
  }
  if (!connection?.probe) throw new Error('Укажите --connection с probe.write/read/reset и initialState.');
  if (!values.yes) { process.stdout.write(JSON.stringify({ target: connection.target, probe: connection.probe, requests: 3 }, null, 2) + '\n'); throw new Error('Для трёх пробных запросов укажите --yes.'); }
  const result = await doctor(connection);
  if (result.passed) await rememberConnection(directory, connection);
  if (values.output) await writeFile(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = result.passed ? 0 : 2;
}

async function summary({ values, directory }: CommandInput): Promise<void> {
  if (!values.id) throw new Error('Укажите --id RUN');
  // Reading an atomic snapshot never takes the writer lock or marks another process interrupted.
  const store = new ExperimentStore(directory);
  const record = await store.get(values.id);
  // The source run is read-only context for stability; the same verified path as Pi and the exports:
  // receipts checked against sidecars, source resolved once. The trace journal is not needed here.
  const verified = await resolveVerified(record, store, record.assessmentOf ?? record.parentRunId);
  const numbers = verified.record.calibration?.entries.length ? await importNumbers(verified.record, importId => store.readImport(importId)) : undefined;
  const judgeCheck = await readJudgeCheck(store, record.id, verified.warnings);
  const view = buildResultView(verified.record, { before: verified.before, ...(numbers ? { numbers } : {}), judgeCheck });
  if (values.json) { process.stdout.write(`${JSON.stringify({ ...machineResult(view), warnings: verified.warnings }, null, 2)}\n`); return; }
  process.stdout.write(screenText(view, verified.warnings));
}

async function exportRun({ values, directory }: CommandInput): Promise<void> {
  if (!values.id) throw new Error('Укажите прогон: --id EXPERIMENT_ID');
  if (!['json', 'html', 'markdown'].includes(values.format!)) throw new Error('Формат экспорта: json, html или markdown.');
  const store = new ExperimentStore(directory);
  const bundle = await evidenceBundle(await store.get(values.id), store, values.before);
  const content = values.format === 'html' ? htmlReport(bundle) : values.format === 'markdown' ? markdownReport(bundle) : jsonReport(bundle);
  if (values.output) await writeFile(values.output, content, { mode: 0o600 }); else process.stdout.write(`${content}\n`);
}

async function diff({ values, directory }: CommandInput): Promise<void> {
  if (!values.before || !values.after) throw new Error('Укажите два прогона: --before RUN_ID --after RUN_ID');
  const store = new ExperimentStore(directory);
  const [before, after] = await Promise.all([store.get(values.before), store.get(values.after)]);
  const compared = compareRuns(before, after);
  if (values.json) process.stdout.write(`${JSON.stringify(compared, null, 2)}\n`);
  else process.stdout.write([
    compared.headline, '',
    ...(compared.regressed.length ? ['Сломалось:', ...compared.regressed.map(r => `  ✗ ${safeLine(r.title)}`), ''] : []),
    ...(compared.fixed.length ? ['Исправлено:', ...compared.fixed.map(r => `  ✓ ${safeLine(r.title)}`), ''] : []),
    ...(compared.incomparable.length ? ['Несравнимо:', ...compared.incomparable.map(r => `  ? ${safeLine(r.title)} (попытка ${r.repeat + 1}): ${safeLine(r.reason)}`), ''] : []),
    ...(compared.notes.length ? ['Оговорки:', ...compared.notes.map(n => `  · ${safeLine(n)}`), ''] : []),
  ].join('\n') + '\n');
  if (!compared.comparable) process.exitCode = 2;
}

/** A draft of a set made before libraries: its expectations as one sheet, or one test's definition; --yes confirms them. */
async function accept({ values, directory }: CommandInput): Promise<void> {
  await asWriter(directory, async lab => {
    const id = values.id;
    if (!id) throw new Error('Укажите --id RUN.');
    const record = await lab.get(id);
    if (record.scenarios.length > 1) {
      const sheet = expectationSheet(record);
      await writeStdout(values.json
        ? `${JSON.stringify({ type: 'test_proposal', text: sheet.lines.join('\n'), lines: sheet.lines, draftHash: sheet.draftHash })}\n`
        : `${sheet.lines.map(safeLine).join('\n')}\n`);
      if (!values.yes) {
        await writeStdout(values.json
          ? `${JSON.stringify({ type: 'next_step', command: `agent-lab accept --id ${id} --yes` })}\n`
          : `\nПодтвердить все ожидания: agent-lab accept --id ${id} --yes\n`);
        return;
      }
      const confirmed = await lab.acceptDraft(id, sheet.draftHash);
      await writeStdout(values.json
        ? `${JSON.stringify({ type: 'accepted', id: confirmed.id, acceptedDraftHash: confirmed.acceptedDraftHash, agentRun: false })}\n`
        : `\nОжидания подтверждены: ${sheet.countText}.\n`);
      return;
    }
    const projection = testPlanLines(record);
    await writeStdout(values.json
      ? `${JSON.stringify({ type: 'test_proposal', text: projection.lines.join('\n'), lines: projection.lines, draftHash: projection.draftHash })}\n`
      : `${projection.lines.join('\n')}\n`);
    if (!values.yes) {
      await writeStdout(values.json
        ? `${JSON.stringify({ type: 'next_step', command: `agent-lab accept --id ${id} --yes` })}\n`
        : `\nЧтобы принять этот тест: agent-lab accept --id ${id} --yes\n`);
      return;
    }
    const accepted = await lab.acceptDraft(id, projection.draftHash);
    await writeStdout(values.json
      ? `${JSON.stringify({ type: 'accepted', id: accepted.id, acceptedDraftHash: accepted.acceptedDraftHash, agentRun: false })}\n`
      : `\nТест принят: ${accepted.acceptedDraftHash}. Агент не запускался.\n`);
  });
}

async function reassess({ values, directory }: CommandInput): Promise<void> {
  await asWriter(directory, async lab => {
    const id = values.id;
    if (!id || (!values.yes && !values['code-only'])) throw new Error('Укажите --id RUN и --yes (модель) или --code-only (без модели).');
    const patch = values.input ? JSON.parse(await readFile(values.input, 'utf8')) : {};
    const draft = await lab.reassess(id, { ...patch, ...(values.trial ? { trialIds: values.trial } : {}), ...(values['code-only'] ? { codeOnly: true } : {}) });
    await lab.waitForIdle();
    const record = await lab.get(draft.id);
    const bundle = await evidenceBundle(record, lab.store);
    const result = machineResult(bundle.view);
    process.stdout.write(JSON.stringify({ id: record.id, phase: record.phase, assessmentOf: record.assessmentOf,
      evaluatorVersion: record.evaluatorVersion, artifacts: await exportArtifacts(bundle, directory), ...result }, null, 2) + '\n');
    process.exitCode = result.exitCode;
  });
}

/**
 * Checks the judge of a finished run without a person: planted errors in copies of its dialogues and untouched
 * controls. Without --yes it says what it would sample and the call ceiling, and spends nothing.
 */
async function checkJudgeCommand({ values, directory }: CommandInput): Promise<void> {
  const id = values.id;
  if (!id) throw new Error('Укажите прогон: --id RUN');
  const options = { ...(values.planted ? { planted: Number(values.planted) } : {}), ...(values.controls ? { controls: Number(values.controls) } : {}) };
  if (!values.yes) {
    const plan = judgeCheckPlan(await new ExperimentStore(directory).get(id), options);
    process.stdout.write(`${[
      `Проверка судьи: ${countText(plan.planted.length, ['подброшенная ошибка', 'подброшенные ошибки', 'подброшенных ошибок'])} и ${countText(plan.controls.length, ['контрольная копия', 'контрольные копии', 'контрольных копий'])} разговоров, которые судья засчитал.`,
      `Не больше ${countText(plan.calls, ['вызова', 'вызовов', 'вызовов'])} модели: ошибку пишет модель задачи, оценивает судья прогона. Агент и клиент не запускаются, прогон не меняется.`,
      'Чтобы проверить, повторите с --yes.'].join('\n')}\n`);
    return;
  }
  await asWriter(directory, async lab => {
    const check = await lab.checkJudge(id, options);
    const text = judgeCheckText({ judgeCheck: judgeCheckSummary(check, { id })! })!;
    process.stdout.write(values.json ? `${JSON.stringify(check, null, 2)}\n`
      : `${[safeLine(text.text), ...check.items.filter(item => item.kind === 'planted' && item.result !== null && item.result !== 'fail')
        .map(item => `  пропущено: ${safeLine(item.whatWasBroken ?? '')}`), `Вызовов модели: ${check.usage.calls}.`].join('\n')}\n`);
  });
}

async function saveSuite({ values, directory }: CommandInput): Promise<void> {
  await asWriter(directory, async lab => {
    if (!values.id || !values.output) throw new Error('Укажите --id RUN --output .evals/regression.json.');
    process.stdout.write(`${await lab.saveSuite(values.id, values.output, values.case)}\n`);
  });
}

async function evaluate({ values, directory }: CommandInput): Promise<void> {
  if (!values.input || !values.yes) throw new Error('Для запуска сохранённых тестов укажите --input suite.json --yes. Лимиты и подключение берутся из файла.');
  const input = values.input;
  await asWriter(directory, async lab => {
    const draft = await lab.loadSuite(input, values.case, values.connection ? await readConnection(values.connection) : undefined);
    await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft), ...(values.parallel ? { parallel: Number(values.parallel) } : {}) });
    await lab.waitForIdle();
    const record = await lab.get(draft.id);
    const bundle = await evidenceBundle(record, lab.store, values.before);
    const artifacts = await exportArtifacts(bundle, lab.store.directory);
    const result = machineResult(bundle.view);
    process.exitCode = result.exitCode;
    process.stdout.write(JSON.stringify({ id: record.id, ...result, comparison: bundle.comparison, artifacts }, null, 2) + '\n');
  });
}

/** A new draft's input from a task file: the materials read whole, the connection, the logs as an import. Reads only. */
async function taskInput(values: Flags, directory: string): Promise<{ input: CreateInput; logs: string }> {
  if (!values.input) throw new Error('Укажите задачу: agent-lab build --input задача.json');
  let raw = JSON.parse(await readFile(values.input, 'utf8'));
  if (raw.materialFiles || raw.promptFiles) {
    // Articles and prompts named by path are read by Lab itself: whole files, no model in between, no item limit of a tool call.
    const { materialFiles, promptFiles, ...task } = raw;
    const expanded = await expandMaterials({ materials: task.materials, materialFiles, promptFiles }, dirname(resolve(values.input)));
    for (const item of expanded.skipped) process.stderr.write(`Пропущен ${item.file}: ${item.reason}\n`);
    process.stderr.write(`Прочитано материалов из файлов: ${expanded.read}.\n`);
    raw = { ...task, materials: expanded.materials };
  }
  if (values.prompt?.length || values.prompts !== undefined) {
    // The prompts the owner picked among those Lab finds in the project folder — named one by one, or the ones Lab's
    // stored proposal ticked — verbatim, as materials of the agent's prompt.
    const folder = values['prompts-from'] ?? process.cwd();
    const named = values.prompt?.length ? await pickedPrompts(folder, values.prompt) : [];
    const suggested = values.prompts === undefined ? [] : await suggestedPrompts(folder, values.prompts, settingsSchema.parse(raw.settings ?? {}), directory);
    const chosen = [...named, ...suggested.filter(prompt => !named.some(item => item.id === prompt.id))];
    process.stderr.write(`Промпты агента: ${chosen.map(prompt => prompt.id).join(', ')}.\n`);
    raw = { ...raw, materials: [...raw.materials ?? [], ...promptMaterials(chosen).map(({ name, content, kind }) => ({ name, content, kind }))] };
  }
  const connection = values.connection ? await readConnection(values.connection) : !raw.target ? await rememberedConnection(directory) : undefined;
  const libraryImport = values['dialogues-file'] ? await readDialogueImport(values['dialogues-file'], { directory }) : raw.dialogues ? importDialogues(raw.dialogues) : undefined;
  // From the rules alone, --situations is the number of situations the rules are written into.
  const rules = !libraryImport && values.situations !== undefined ? Number(values.situations) : undefined;
  if (rules !== undefined && !(Number.isInteger(rules) && rules >= 1 && rules <= SCENARIO_LIMIT)) throw new Error(`По правилам без логов Lab готовит от 1 до ${SCENARIO_LIMIT} ситуаций за раз.`);
  const input = createInputSchema.parse({ ...raw, ...(connection ? { target: connection.target, targetVersion: connection.targetVersion } : {}),
    ...(libraryImport ? { originalImport: libraryImport.originalImport, dialogues: libraryImport.dialogues.slice(0, 200) } : {}),
    ...(rules !== undefined ? { scenarioCount: rules } : {}) });
  return { input, logs: basename(values['dialogues-file'] ?? values.input) };
}

/** The candidates named by `ids` among the prompts Lab finds in `folder`; an id it does not find is refused with those it does. */
async function pickedPrompts(folder: string, ids: readonly string[]) {
  const { prompts } = await detectProject(folder);
  return ids.map(id => {
    const found = prompts.find(prompt => prompt.id === id);
    if (!found) throw new Error(`Промпта ${id} в ${folder} нет.${prompts.length ? ` Есть: ${prompts.slice(0, 10).map(prompt => prompt.id).join(', ')}${prompts.length > 10 ? ' …' : ''}.` : ' Lab не нашёл в этой папке ни одного промпта.'}`);
    return found;
  });
}

/**
 * `--prompts suggested`: the prompts Lab's stored proposal marked «ответ клиенту», for the same prompts and the same builder
 * model. It never proposes anew: a proposal is paid for only by `build --prompts-from` with --yes, which the owner saw.
 */
async function suggestedPrompts(folder: string, word: string, settings: Settings, directory: string): Promise<PromptCandidate[]> {
  if (word !== 'suggested') throw new Error('--prompts принимает одно слово: suggested — промпты, которые Lab отметил как ответ клиенту.');
  const { prompts } = await detectProject(folder);
  const proposal = settings.provider && settings.model ? await new ExperimentStore(directory).readPromptPurposes(purposeKey(prompts, builderOf(settings))) : undefined;
  if (!proposal) throw new Error(`Lab ещё не предлагал, какие промпты в ${folder} пишут ответ клиенту, или они изменились с тех пор. Сначала: agent-lab build --input задача.json --prompts-from ${folder} --yes.`);
  const picked = proposedPrompts(prompts, proposal).filter(item => item.suggested).map(item => item.candidate);
  if (!picked.length) throw new Error('Ни один промпт Lab не отметил как ответ клиенту. Выберите сами: --prompt ФАЙЛ#ИМЯ.');
  return picked;
}

/**
 * `build --prompts-from` without `--prompt`: the prompts Lab found, for the owner to pick. With a model in the task file
 * Lab offers to read their beginnings and mark the ones that write the reply to the customer; --yes pays for exactly
 * that proposal and stores it, so the next look and `--prompts suggested` are free. Nothing else is written or spent.
 */
async function promptChoice(folder: string, values: Flags, directory: string): Promise<string[]> {
  const { prompts } = await detectProject(folder);
  if (!prompts.length) return [`В ${folder} Lab не нашёл промптов агента: ни файлов с «prompt» в имени, ни строк-промптов в коде, ни полей промптов в JSON.`];
  const raw = values.input ? JSON.parse(await readFile(values.input, 'utf8')) as { settings?: unknown } : {};
  const parsed = settingsSchema.parse(raw.settings ?? {});
  const settings = parsed.provider && parsed.model ? parsed : undefined;
  const key = settings && purposeKey(prompts, builderOf(settings));
  let proposal: PurposeProposal | undefined = key ? await new ExperimentStore(directory).readPromptPurposes(key) : undefined;
  if (settings && !proposal && values.yes) {
    const reader = (await createPiRuntime(settings)).promptPurposes;
    if (!reader) throw new Error('Модель задачи не определяет назначение промптов.');
    await asWriter(directory, async lab => {
      proposal = await proposePurposes(prompts, reader, { timeoutMs: settings.timeoutMs });
      await lab.store.writePromptPurposes(proposal);
    });
  }
  if (!proposal) return ['Промпты агента в папке — какие из них задают, что и как бот отвечает клиенту, выбираете вы:', '',
    ...prompts.map(prompt => `  ${promptLine(prompt)}`), '',
    ...(settings ? [`${purposeConsentLine(prompts)} Повторите с --yes.`] : []),
    'Взять выбранные: та же команда с --prompt ФАЙЛ#ИМЯ (флаг повторяется). Они станут правилами поведения бота; ничего не записано и не потрачено.'];
  const proposed = proposedPrompts(prompts, proposal);
  const ticked = proposed.filter(item => item.suggested).length;
  return ['Промпты агента в папке — Lab отметил ✓ те, что пишут ответ клиенту; решаете вы:', '',
    ...proposed.flatMap(item => [`  ${item.suggested ? '✓' : '○'} ${promptLine(item.candidate)}`, `      ${purposeLine(item)}`]), '',
    ...(proposal.failure ? ['Часть промптов модель не разобрала: их назначение не определено.'] : []),
    ticked ? `Взять отмеченные (${ticked}): та же команда с --prompts suggested. Выбрать самим: --prompt ФАЙЛ#ИМЯ (флаг повторяется).`
      : 'Ни один промпт не отмечен как ответ клиенту. Выбрать самим: та же команда с --prompt ФАЙЛ#ИМЯ (флаг повторяется).',
    'Выбранные станут правилами поведения бота. Кроме этого предложения, ничего не записано и не потрачено.'];
}

/**
 * What a preparation promises and may spend — the consent the chat asks natively, in the same words: how many
 * situations at most, what is left out and why, the ceiling of the spending. The ceiling goes to the preparation
 * with the owner's --yes, so the number agreed to is the number it stops at.
 */
async function buildConsent(input: CreateInput, logs: string, directory: string, values: Flags): Promise<{ question: string; lines: string[]; situations: number; callCeiling: number }> {
  if (input.originalImport) {
    const consent = await preparationConsent(new ExperimentStore(directory), { input, situations: situationCount(values.situations === undefined ? undefined : Number(values.situations)) });
    return { ...consentText(consent, logs), situations: consent.promised, callCeiling: consent.callCeiling };
  }
  const situations = input.scenarioCount || 1;
  const callCeiling = preparationCeiling({ task: input.task, sources: materialSources(input.materials), situations, fromLogs: false });
  return { ...rulesConsentText(situations, callCeiling, isRunnable(input.target)), situations, callCeiling };
}

/** How many situations are prepared at once (`--parallel`); the same draft whatever the number. */
function preparationFlags(values: Flags): PreparationOptions {
  return values.parallel === undefined ? {} : { parallel: Number(values.parallel) };
}

/** Prepares `input` to the end, the same way the chat prepares it, within the consent's count and ceiling when there is one. */
async function prepareDraft(lab: ExperimentLab, input: CreateInput, options: CreateOptions = {}): Promise<string> {
  const prepared = await lab.create(input, options); await lab.waitForIdle();
  const current = await lab.get(prepared.id);
  if (current.phase !== 'review') throw new Error(current.error ?? 'Подготовка не завершилась.');
  return current.id;
}

/** `build`: the consent in the owner's words; only --yes prepares, within the count and the ceiling it states. */
async function prepare({ values, directory }: CommandInput): Promise<void> {
  if (values['prompts-from'] && !values.prompt?.length && values.prompts === undefined) {
    await writeStdout(`${(await promptChoice(values['prompts-from'], values, directory)).map(line => safeLine(line)).join('\n')}\n`); return;
  }
  const { input, logs } = await taskInput(values, directory);
  const consent = await buildConsent(input, logs, directory, values);
  if (!values.yes) {
    await writeStdout(values.json ? `${JSON.stringify({ question: consent.question, lines: consent.lines, situations: consent.situations, callCeiling: consent.callCeiling }, null, 2)}\n`
      : `${[consent.question, '', ...consent.lines, '', 'Собрать: та же команда с --yes. Без него ничего не записано и не потрачено.'].map(line => safeLine(line)).join('\n')}\n`);
    return;
  }
  await asWriter(directory, async lab => {
    const id = await prepareDraft(lab, input, { situations: consent.situations, callCeiling: consent.callCeiling, ...preparationFlags(values) });
    process.stdout.write(`${JSON.stringify(await lab.get(id), null, 2)}\n`);
  });
}

/** Runs an accepted draft to its result, as a script reads it: the view, its exit code and the proof of every dialogue. */
async function runDraft(lab: ExperimentLab, id: string, values: Flags): Promise<void> {
  const draft = await lab.get(id);
  await lab.start(id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft), ...(values.parallel ? { parallel: Number(values.parallel) } : {}) }); await lab.waitForIdle();
  const result = await lab.get(id);
  // The source run is read-only context for stability, as in `summary`.
  const verified = await resolveVerified(result, lab.store, result.parentRunId);
  const view = buildResultView(verified.record, { before: verified.before });
  process.stdout.write(`${JSON.stringify({ id, phase: result.phase, mode: result.mode, reviewMode: result.reviewMode,
    ...(result.workflow === 'evaluate' ? { ...machineResult(view), proofs: result.trials.map(trial => trialProofLines(result, trial.id)) } : { view }),
    comparison: result.comparisons.at(-1), ...(verified.warnings.length ? { warnings: verified.warnings } : {}), artifact: resolve(lab.store.directory, `${id}.json`) }, null, 2)}\n`);
  if (result.workflow === 'evaluate') process.exitCode = exitCodeOf(view);
  if (!['complete', 'results_review'].includes(result.phase)) throw new Error(result.error ?? 'Experiment did not complete');
}

async function demo({ values, directory }: CommandInput): Promise<void> {
  await asWriter(directory, async lab => {
    // Free: no model, no keys — the teaching example needs no consent.
    const id = await prepareDraft(lab, demoInput());
    // The teaching example takes the owner's path: answer its one question («Да» — the customer knew the number), then accept every ready situation.
    const context = await lab.cardContext(id);
    for (const view of situationViews(context.experiment, { evidence: context.evidence, maxTurns: context.experiment.settings.maxTurns })) if (view.question?.id) {
      const answer = await lab.prepareCardCommand(id, { kind: 'answer_question', cardId: view.id, questionId: view.question.id, choice: 'a' }, { via: 'cli-yes' });
      await lab.applyCardCommand(id, answer, hostGrant(answer, 'confirmed'));
    }
    const answered = await lab.cardContext(id);
    const ready = situationViews(answered.experiment, { evidence: answered.evidence, maxTurns: answered.experiment.settings.maxTurns }).filter(view => view.status === 'ready');
    await lab.acceptCards(id, libraryHash(answered.library), ready.map(view => view.id));
    await runDraft(lab, id, values);
  });
}

async function run({ values, directory }: CommandInput): Promise<void> {
  await asWriter(directory, async lab => {
    if (!values.id) throw new Error('Укажите прогон: --id EXPERIMENT_ID');
    if (!values.yes) throw new Error('Для запуска согласованных тестов укажите --yes.');
    await runDraft(lab, values.id, values);
  });
}

async function repeat({ values, directory }: CommandInput): Promise<void> {
  await asWriter(directory, async lab => {
    if (!values.id) throw new Error('Укажите прогон: --id EXPERIMENT_ID');
    const record = await lab.repeat(values.id, values.case, values.control);
    process.stdout.write(`${JSON.stringify({ id: record.id, phase: record.phase, parentRunId: record.parentRunId, targetVersion: record.targetVersion,
      positiveControlScenarioIds: record.positiveControlScenarioIds, nextStep: 'Откройте /agent-lab в Pi, проверьте версию агента и подтвердите запуск.' }, null, 2)}\n`);
  });
}

/** Every command in the order `--help` lists them: first the owner's path, then what scripts and CI use. */
const COMMANDS: Readonly<Record<string, Command>> = {
  detect: { help: ['agent-lab detect [--directory ПАПКА] [--json]   Что Lab нашёл в папке проекта: агента, логи, материалы, промпт'], run: detect },
  import: { help: ['agent-lab import --file логи.xlsx [--input задача.json] [--where "КОЛОНКА=ЗНАЧЕНИЕ"] [--collapse-repeats] [--yes] [--json]   Как читать таблицу логов (.xlsx, .csv): с --input разметку предлагает модель задачи, Lab проверяет каждую строку; --yes — сначала на вызов модели, затем на загрузку'], run: importTable },
  build: { help: ['agent-lab build --input задача.json [--dialogues-file логи.jsonl|.xlsx] [--situations N] [--connection подключение.json] [--parallel 4] [--yes]   Сколько ситуаций Lab подготовит и сколько вызовов модели это может стоить; --yes готовит их',
    'agent-lab build --input задача.json --prompts-from ПАПКА [--yes]   Промпты агента из его кода и JSON на выбор; с --yes модель задачи отметит те, что пишут ответ клиенту',
    'agent-lab build --input задача.json --prompts-from ПАПКА --prompt ФАЙЛ#ИМЯ ... | --prompts suggested [--yes]   Выбранные промпты (или отмеченные Lab) станут правилами поведения бота'], run: prepare },
  prepare: { help: [], run: prepare },
  cards: { help: [
    'agent-lab cards --id RUN [--card N] [--json]   Ситуации: что пишет и знает клиент, что должен агент, статус и вопрос',
    'agent-lab cards --id RUN --card N --choice a|b|c [--text «…»] --yes   Ответ на вопрос ситуации',
    'agent-lab cards --id RUN --input команда.json [--yes]   Команда владельца; без --yes — только «было → стало»',
    'agent-lab cards --id RUN --check|--resume|--accept --yes [--parallel 4]   Проверить ситуации · продолжить подготовку · утвердить готовые',
    'agent-lab cards --id RUN [--operator-rules on|off] [--bind-rule ID] [--unbind-rule ID] [--yes]   Свод правил: входят ли инструкции для операторов, отдельные правила, обязательные для бота',
    'agent-lab cards --id RUN --convert   Черновик старого формата — продолжить в новом формате; старый останется как есть'], run: cards },
  accept: { help: ['agent-lab accept --id RUN [--yes]   Что агент должен сделать в каждой ситуации; --yes подтверждает все ожидания'], run: accept },
  run: { help: ['agent-lab run --id RUN --yes [--parallel 4]   Прогнать утверждённые ситуации'], run },
  repeat: { help: ['agent-lab repeat --id RUN [--case SCENARIO_ID] [--control SCENARIO_ID]   Новый черновик тех же ситуаций'], run: repeat },
  demo: { help: ['agent-lab demo   Учебный пример целиком, без модели и ключей'], run: demo },
  summary: { help: ['agent-lab summary --id RUN [--json]   Сколько ситуаций агент прошёл, что не измерено и почему'], run: summary },
  logs: { help: ['agent-lab logs --id RUN [--agent-version ВЕРСИЯ | --unknown] [--yes]   Какая версия агента записала логи: только тогда сверка с продом — калибровка'], run: logs },
  reassess: { help: ['agent-lab reassess --id RUN [--input criteria.json] --yes | --code-only   Оценить записанные разговоры заново: судьёй или только точными проверками'], run: reassess },
  'check-judge': { help: ['agent-lab check-judge --id RUN [--planted 10] [--controls 10] [--yes]   Проверить судью без человека: поймает ли он подброшенные ошибки; без --yes — только сколько вызовов'], run: checkJudgeCommand },
  export: { help: ['agent-lab export --id RUN --format html|markdown|json [--output отчёт.html]   Отчёт для заказчика'], run: exportRun },
  diff: { help: ['agent-lab diff --before RUN --after RUN [--json]   Что сломалось и что исправилось между двумя прогонами'], run: diff },
  'save-suite': { help: ['agent-lab save-suite --id RUN --output .evals/regression.json [--case ID]   Сохранить набор ситуаций в файл'], run: saveSuite },
  evaluate: { help: ['agent-lab evaluate --input .evals/regression.json --yes [--case ID] [--parallel 4] [--connection подключение.json]   Прогнать сохранённый набор (CI)'], run: evaluate },
  suites: { help: ['agent-lab suites [--directory .evals]   Сохранённые наборы'], run: async ({ values }) => { process.stdout.write(JSON.stringify(await listSuites(values.directory ?? '.evals'), null, 2) + '\n'); } },
  connect: { help: ['agent-lab connect --curl запрос.txt|- [--message /путь] [--conversation /путь] [--output connection.json] [--yes]   Подключение агента в его собственном формате из команды curl'],
    run: ({ values }) => connectFromCurl(values) },
  doctor: { help: ['agent-lab doctor --connection подключение.json --yes   Три пробных запроса к агенту: запись, чтение, сброс',
    'agent-lab doctor --connection подключение.json [--reply /путь] --yes   Агент в своём формате: строение ответа, затем два хода одного разговора'], run: checkConnection },
  status: { help: ['agent-lab status   Модели и ключи, которые видит Pi'], run: async () => { process.stdout.write(`${JSON.stringify(await getPiStatus(), null, 2)}\n`); } },
};

const HELP = [
  'Agent Lab — насколько хорош ваш агент: точность на ситуациях из реальных логов и причины провалов.', '',
  '  agent-lab                         Диалог в текущем проекте',
  '  agent-lab chat [опции Pi]          Напишите задачу обычными словами', '',
  ...Object.values(COMMANDS).flatMap(command => command.help.map(line => `  ${line}`)), '',
  'evaluate, run и reassess: 0 — все оценки пройдены; 1 — зарегистрирован провал; 2 — ошибка теста/среды или неполные данные.',
  '--yes разрешает расход в пределах сохранённых лимитов; ручной оценкой ожиданий это не считается. Из чата Agent Lab --yes не принимается: там согласие спрашивает сам чат.', '',
].join('\n');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'chat' || (!args.length && process.stdin.isTTY)) { await chat(args.slice(args[0] === 'chat' ? 1 : 0)); return; }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: FLAGS });
  const name = positionals[0];
  if (values.help || !name) { process.stdout.write(HELP); return; }
  if (values.yes && IN_CHAT) throw new Error(CHAT_ASKS);
  const command = COMMANDS[name];
  if (!command) throw new Error(`Unknown command: ${name}`);
  await command.run({ values, directory: values['data-dir'] ?? resolve('.agent-lab') });
}
void main().catch(error => { process.stderr.write(`Agent Lab: ${safeLine(error instanceof Error ? error.message : String(error))}\n`); process.exitCode = process.argv[2] === 'evaluate' ? 2 : 1; });
