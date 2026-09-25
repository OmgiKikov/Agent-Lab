#!/usr/bin/env node
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { ExperimentLab } from './experiment.js';
import type { CreateOptions, PreparationOptions } from './lab/library.js';
import { draftHash } from './lab/record.js';
import { demoInput } from './demo.js';
import { createInputSchema, isRunnable, materialSources, runnableTarget, SCENARIO_LIMIT, settingsSchema, type CreateInput, type Experiment, type Settings } from './contracts.js';
import { compareRuns } from './comparison.js';
import { doctor, listSuites, readConnection, rememberedConnection, rememberConnection, type Connection } from './connection.js';
import { examConnection, examLines } from './exam.js';
import { planLines, variationLine, variationsWithout } from './card/plan.js';
import { gapsLine } from './miner/cards.js';
import { detectionLines, detectProject, promptLine } from './detect.js';
import { readDialogueImport, importDialogues } from './imports.js';
import { expandMaterials, promptMaterials } from './materials.js';
import type { PromptCandidate } from './prompt-candidates.js';
import { proposedPrompts, proposePurposes, purposeConsentLine, purposeKey, purposeLine, type PurposeProposal } from './prompt-purpose.js';
import { createPiRuntime, getPiStatus } from './pi.js';
import { chatArguments } from './instructions.js';
import { htmlReport, jsonReport, markdownReport } from './report.js';
import { expectationSheet, testPlanLines, trialProofLines } from './quality.js';
import { ExperimentStore } from './store.js';
import { buildResultView, exitCodeOf, type ResultView } from './result-view.js';
import { ANSWER_TEXT, calibrationRows, comparisonRows, judgeCheckText, logQuestionText, MAX_WIDTH, plainText, resultScreen, type ResultRow } from './result-text.js';
import { judgeCheckPlan, judgeCheckSummary } from './judge-check.js';
import { evidenceBundle, exportArtifacts, importNumbers, readJudgeCheck, resolveVerified } from './artifacts.js';
import { libraryHash } from './scenario-library.js';
import { hostGrant, preparedLines, requiredAuthority, wordsOf } from './card/commands.js';
import { conversionText } from './card/convert.js';
import { cardCommandSchema, type CardCommand, type LibraryV2 } from './card/schema.js';
import { rulebookLines, rulebookOf, shownRulebook, withKind, withRules, type RulebookView } from './card/rulebook.js';
import { briefRows, countsText, detailRows, formatNote, listRows, plainSituationText, situationData, situationNumber, situationViews, type SituationView } from './card/view.js';
import { logAnswerOf, logAnswerReviews, logRefusal, logTargets, logVerdictsText, NO_CALIBRATION } from './card/calibration-view.js';
import { safeLine, wrapHanging } from './text.js';
import { countText } from './plural.js';
import { logImports } from './card/calibration-scope.js';
import { confirmTableImport, planTableReading, proposeReading, proposeTableImport, readingConsent } from './spreadsheet/import.js';
import type { TableProposal } from './spreadsheet/proposal.js';
import { READING_CALLS } from './spreadsheet/reading-task.js';
import { importedLine, proposalLines } from './spreadsheet/lines.js';
import { importHints, tableChoicesOf } from './cli/import-flags.js';
import { connectFromCurl, doctorTemplate } from './cli/connect.js';
import { commandOf, readCommandLine, type Flag, type Flags } from './cli/args.js';
import { errorText, stopText } from './cli/errors.js';
import { preparationBudget, preparationCeiling } from './card/budget.js';
import { builderOf, consentText, preparationConsent, rulesConsentText, situationCount } from './miner/plan.js';

/*
 * `agent-lab`: one table of commands over the operations Pi's tools use (experiment.ts). A command that writes or
 * spends opens the data folder as its one writer and takes the owner's word as --yes, where the chat asks natively;
 * a command that only reads never takes the writer's lock, so it may run beside a live run. `chat` — and no command
 * in a terminal — opens Pi with the Agent Lab extension.
 *
 * Each command names the flags it takes (cli/args.ts refuses the others in the owner's words) and the exit code of its
 * failure: 2 for what a CI reads, where 1 means an agent that failed. Every failure reaches the owner through
 * cli/errors.ts: what is wrong and what to type instead, never an English diagnostic alone.
 *
 * Inside that chat the owner's word belongs to the chat: `agent-lab chat` gives Pi AGENT_LAB_SESSION, Pi's shell
 * passes its whole environment to every command it runs, and the chat asks each consent and decision in a native
 * dialog. A command run from the chat's shell — by the model or by the owner's `!` — therefore refuses --yes, unless
 * that shell drops the variable, which nothing here can prevent (IN_CHAT).
 */

/** What a command gets: the owner's flags and the data folder they point at. */
interface CommandInput { values: Flags; directory: string }
interface Command {
  /** What `agent-lab --help` says about the command: how it is typed, then what it does, in the owner's words. */
  help: readonly (readonly [usage: string, text: string])[];
  /** The flags it takes besides --data-dir and --help; any other is refused. */
  flags: readonly Flag[];
  /**
   * The exit code when the command cannot do what it was asked. 2 for the commands a CI reads — `evaluate`, `run`,
   * `reassess` —, where 1 is reserved for an agent that failed: a test or a place that could not be measured is 2.
   */
  failure?: 2;
  run(input: CommandInput): Promise<void>;
}

/**
 * Rows of result-text.ts with every text made safe for a terminal before layout: titles, quotes and the owner's reasons
 * come from records, and the layout must measure what will actually be printed.
 */
const safeRows = (rows: readonly ResultRow[]): ResultRow[] => rows.map(row => ({ ...row, text: safeLine(row.text),
  ...(row.right === undefined ? {} : { right: safeLine(row.right) }), ...(row.short === undefined ? {} : { short: safeLine(row.short) }),
  ...(row.parts ? { parts: row.parts.map(safeLine) } : {}) }));
/** The rows of the result screen, safe for a terminal. */
const cliRows = (view: ResultView): ResultRow[] => safeRows(resultScreen(view, { surface: 'cli' }));
/** Rows laid out at the terminal's width, at most the mockups' 100 columns. */
const shellText = (rows: readonly ResultRow[]): string => plainText(safeRows(rows), process.stdout.columns ?? MAX_WIDTH);
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
  // The Agent Lab session gets the agent-builder skill's text as its system prompt's own (instructions.ts): every turn
  // carries it, the ones Pi starts for a finished run as much as the owner's.
  const child = spawn(process.execPath, [resolve(piRoot, 'dist/bundle/cli.js'), ...await chatArguments(resolve(root, 'extensions/agent-lab.ts')), ...args],
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
  const situations = (id: string) => situationsOf(lab, id);
  /**
   * The list, or one situation with its question — the same rows the chat and the board draw, without the board's keys:
   * in a shell the way on is a command, said under the situation. JSON carries each situation's id: a command file names
   * its card by it.
   */
  const show = async (id: string, changes: string[] = []) => {
    const { record, views, rulebook } = await situations(id);
    const number = values.card === undefined ? undefined : Number(values.card);
    const view = number === undefined ? undefined : views.find(item => item.number === number);
    if (number !== undefined && !view) throw new Error(`Ситуации №${values.card} нет. Есть: ${views.map(item => item.number).join(', ')}.`);
    if (values.json) { await writeStdout(`${JSON.stringify({ runId: id, counts: countsText(views), ...(changes.length ? { changes } : {}), ...(view ? { situation: { id: view.id, ...situationData(view), details: view.details } } : { situations: views.map(item => ({ id: item.id, ...situationData(item) })), ...(rulebook ? { rulebook } : {}) }) }, null, 2)}\n`); return; }
    const rows = view ? [...briefRows(view), { role: 'blank' as const, indent: 0, text: '' }, ...detailRows(view)] : views.flatMap(item => listRows(item));
    const plan = record.librarySnapshot?.formatVersion === 2 ? planLines(record.librarySnapshot) : [];
    const gaps = gapsLine(record.preparationProgress);
    const head = view ? [] : [countsText(views), ...(formatNote(record) ? [formatNote(record)!] : []), '', ...(plan.length ? [...plan, ''] : []), ...(gaps ? [gaps, ''] : []),
      ...(rulebook ? [...rulebookLines(rulebook), ''] : [])];
    const choices = view?.format === 'card' ? view.question?.choices ?? [] : [];
    const next = !view || view.format !== 'card' ? [] : choices.length
      ? [`Ответить: agent-lab cards --id ${id} --card ${view.number} --choice ${choices.map(choice => choice.id).join('|')} --yes — ${choices.map((choice, index) => `${choice.id} — ответ ${index + 1}${choice.needsText ? ' со своими словами в --text «…»' : ''}`).join(', ')}.`]
      : [`Изменить: agent-lab cards --id ${id} --input команда.json — без --yes Lab покажет «было → стало».`];
    await writeStdout(`${[...changes, ...(changes.length ? [''] : []), ...head.map(line => line && ` ${safeLine(line)}`), plainSituationText(rows.map(row => ({ ...row, text: safeLine(row.text) })), process.stdout.columns ?? 100),
      ...(next.length ? ['', ...next.map(line => ` ${safeLine(line)}`)] : [])].join('\n')}\n`);
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
  if (!values.input && !values.choice && !values.check && !values.resume && !values.accept && !values.variations && !rulebookFlags) { await show(values.id); return; }
  await lab.init();
  try {
    if (values.variations) { await variationSituations(lab, values, show); return; }
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
    const changes = preparedLines(prepared);
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

/**
 * `cards --variations`: situations for the variations of the plan that have none — from the rules, never traffic. Without
 * --yes the variations and the ceiling the preparation would continue under; with it they are queued and the preparation
 * continues, the ceiling raised to what they need as the owner's word, like `--resume --yes`.
 */
async function variationSituations(lab: ExperimentLab, values: Flags, show: (id: string) => Promise<void>): Promise<void> {
  const record = await lab.get(values.id!);
  const library = record.librarySnapshot;
  if (library?.formatVersion !== 2 || !library.plan?.length) throw new Error('У этого набора нет плана сценариев.');
  const wanted = variationsWithout(library);
  if (!wanted.length) throw new Error('У всех вариантов плана уже есть ситуации.');
  const progress = record.preparationProgress;
  const after = progress && progress.protocol !== 'chronological-scenarios-v1' ? preparationBudget({ ...record, preparationProgress: { ...progress, pending: [...progress.pending, ...wanted.map((_, index) => `rules_${index}`)] } }) : undefined;
  if (!values.yes) {
    await writeStdout(`${['Составить ситуации для вариантов без ситуаций — по правилам, не из логов:', ...wanted.map(({ scenario, variation }) => `  ${variationLine(scenario, variation)} — сценарий «${scenario.question}»`),
      ...(after ? [`Потрачено ${after.spent} из ${after.ceiling} согласованных вызовов модели; с --yes потолок всей подготовки станет ${Math.max(after.ceiling, after.resume)}. Агент не запускается.`] : []),
      'Записать: та же команда с --yes.'].map(line => safeLine(line)).join('\n')}\n`);
    return;
  }
  const { experiment } = await lab.queueVariations(record.id, libraryHash(library));
  const budget = preparationBudget(experiment);
  const raise = budget && budget.resume > budget.ceiling ? budget.resume : undefined;
  await lab.resumePreparation(record.id, libraryHash(experiment.librarySnapshot!), { ...preparationFlags(values), ...(raise !== undefined ? { callCeiling: raise } : {}) });
  await lab.waitForIdle();
  await show(record.id);
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
  const exam = target && isRunnable(target) ? target.exam : undefined;
  if (connection && target?.kind === 'http' && target.request) {
    await doctorTemplate({ connection, target: { ...target, request: target.request }, directory, yes: values.yes, file: values.connection && resolve(values.connection), reply: values.reply });
    if (exam && values.yes && !process.exitCode) await examCommand(connection, directory);
    return;
  }
  if (!connection?.probe && !exam) throw new Error('Укажите --connection с разделом exam (многоходовые пути экзамена) или с probe.write/read/reset и initialState.');
  if (!values.yes) {
    if (exam) { process.stdout.write(`Экзамен подключения: ${countText(exam.length, ['путь', 'пути', 'путей'])}, ${countText(exam.reduce((n, path) => n + path.steps.length, 0), ['сообщение', 'сообщения', 'сообщений'])} агенту, без моделей.\n`); throw new Error('Для пробных разговоров с агентом укажите --yes.'); }
    process.stdout.write(JSON.stringify({ target: connection!.target, probe: connection!.probe, requests: 3 }, null, 2) + '\n'); throw new Error('Для трёх пробных запросов укажите --yes.');
  }
  if (!connection!.probe) { await examCommand(connection!, directory); return; }
  const result = await doctor(connection!);
  if (result.passed && !exam) await rememberConnection(directory, connection!);
  if (values.output) await writeFile(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = result.passed ? 0 : 2;
  if (exam && result.passed) await examCommand(connection!, directory);
}

/** The connection exam from the command line: its lines, and the connection remembered only when every path passed. */
async function examCommand(connection: Connection, directory: string): Promise<void> {
  const result = await examConnection(runnableTarget(connection.target), new AbortController().signal,
    (name, index, of) => process.stderr.write(`Путь ${index + 1} из ${of}: ${safeLine(name)}\n`));
  for (const line of examLines(result)) process.stdout.write(`${safeLine(line)}\n`);
  if (result.status === 'passed') await rememberConnection(directory, connection);
  process.exitCode = result.status === 'passed' ? 0 : 2;
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
  const format = values.format ?? 'json';
  if (!['json', 'html', 'markdown'].includes(format)) throw new Error('Формат экспорта: --format json, html или markdown.');
  const store = new ExperimentStore(directory);
  const bundle = await evidenceBundle(await store.get(values.id), store, values.before);
  const content = format === 'html' ? htmlReport(bundle) : format === 'markdown' ? markdownReport(bundle) : jsonReport(bundle);
  if (values.output) await writeFile(values.output, content, { mode: 0o600 }); else process.stdout.write(`${content}\n`);
}

async function diff({ values, directory }: CommandInput): Promise<void> {
  if (!values.before || !values.after) throw new Error('Укажите два прогона: --before RUN_ID --after RUN_ID');
  const store = new ExperimentStore(directory);
  const [before, after] = await Promise.all([store.get(values.before), store.get(values.after)]);
  const compared = compareRuns(before, after);
  // The words of the chat's comparison (result-text.ts comparisonRows), laid out for the terminal.
  if (values.json) process.stdout.write(`${JSON.stringify(compared, null, 2)}\n`);
  else process.stdout.write(`${shellText(comparisonRows(compared, before))}\n`);
  if (!compared.comparable) process.exitCode = 2;
}

/**
 * «Сверка с продом» of a finished run (docs/design/card-v2-spec.md §10): the line under the number, what was not compared and
 * each disagreement, as the summary shows them. With --card N --choice, the owner's word on the judge's reading of that
 * situation's logged conversation — the answer the chat and the board take: shown without --yes, written with it.
 * --expectation names one expectation by its letter; a disagreement needs the owner's reason in --text. Only the
 * comparison with production moves; the number never does.
 */
async function calibration({ values, directory }: CommandInput): Promise<void> {
  if (!values.id) throw new Error('Укажите прогон: --id RUN.');
  const store = new ExperimentStore(directory);
  const record = await store.get(values.id);
  const numbers = record.calibration?.entries.length ? await importNumbers(record, importId => store.readImport(importId)) : undefined;
  const calibrationOf = (run: Experiment) => buildResultView(run, numbers ? { numbers } : {}).calibration;
  const view = calibrationOf(record);
  if (!view) throw new Error(NO_CALIBRATION);
  if (values.card === undefined) {
    const answerable = view.disagreements.filter(item => logTargets(record, item.cardId).length);
    if (values.json) { await writeStdout(`${JSON.stringify({ runId: record.id, calibration: view, answerable: answerable.map(item => item.number) }, null, 2)}\n`); return; }
    const rows: ResultRow[] = [{ role: 'calibration', indent: 0, text: view.text }, ...calibrationRows({ calibration: view })];
    const next = answerable.length ? `Прав ли судья по разговору из логов: agent-lab calibration --id ${record.id} --card ${answerable.map(item => item.number).join('|')} --choice agree|disagree|unsure [--text «причина»] --yes` : '';
    await writeStdout(`${shellText(rows)}\n${next ? `\n ${safeLine(next)}\n` : ''}`);
    return;
  }
  const scenario = record.scenarios.find((item, at) => String(situationNumber(record, item.id, at + 1)) === values.card);
  if (!scenario) throw new Error(`Ситуации №${values.card} в этом прогоне нет.`);
  const refused = logRefusal(record, scenario.id);
  if (refused) throw new Error(refused);
  const all = logTargets(record, scenario.id);
  // The letter as the owner typed it, read once — the same form, case and spacing as shown; the expectation's id is taken too.
  const wanted = values.expectation?.normalize('NFKC').trim().toLocaleUpperCase('ru');
  const targets = wanted === undefined ? all : all.filter(target => target.letter.toLocaleUpperCase('ru') === wanted || target.expectationId.toLocaleUpperCase('ru') === wanted);
  if (!targets.length) throw new Error(`Судья по логу решил: ${logVerdictsText(all)}. Укажите --expectation ${all.map(target => target.letter).join('|')}.`);
  const answer = values.choice;
  if (answer !== 'agree' && answer !== 'disagree' && answer !== 'unsure') throw new Error(`${logQuestionText(targets)} Ответ: --choice agree (да, судья прав), disagree (нет, судья ошибся — с --text «причина») или unsure (не знаю).`);
  const reason = values.text?.trim();
  if (answer === 'disagree' && !reason) throw new Error('Для --choice disagree напишите, почему судья ошибся: --text «причина».');
  if (reason && reason.length > 3000) throw new Error('Причина длиннее 3000 знаков — сократите её.');
  const said = [logQuestionText(targets), `Ваш ответ: ${ANSWER_TEXT[answer]}${answer === 'disagree' ? ` — «${reason}»` : ''}.`];
  // The same answer given again writes nothing, as in the chat and on the board.
  const same = answer !== 'disagree' && logAnswerOf(record, targets) === answer;
  if (values.json && !values.yes) { await writeStdout(`${JSON.stringify({ runId: record.id, situation: Number(values.card), answer, written: false, same, targets }, null, 2)}\n`); return; }
  if (!values.yes || same) {
    await writeStdout(`${[...said, same ? 'Этот ответ уже записан.' : 'Записать: та же команда с --yes. Число не изменится: ответ меняет только сверку с продом.'].map(line => safeLine(line)).join('\n')}\n`);
    return;
  }
  await asWriter(directory, async lab => { for (const review of logAnswerReviews(targets, answer, reason ? { reason } : {})) await lab.addLogReview(record.id, review); });
  const after = calibrationOf(await store.get(record.id));
  if (values.json) { await writeStdout(`${JSON.stringify({ runId: record.id, situation: Number(values.card), answer, written: true, calibration: after?.text ?? null }, null, 2)}\n`); return; }
  await writeStdout(`${[...said, `Записано. ${after?.text ?? ''}`].map(line => safeLine(line)).join('\n')}\n`);
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
      : `${projection.lines.map(safeLine).join('\n')}\n`);
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
    for (const item of expanded.skipped) process.stderr.write(`Пропущен ${safeLine(item.file)}: ${safeLine(item.reason)}\n`);
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
    // The draft holds the logs' conversations word for word: they stay in the private folder, the terminal gets what was made and the way on.
    const { views } = await situationsOf(lab, id);
    if (values.json) {
      await writeStdout(`${JSON.stringify({ id, counts: countsText(views), situations: views.map(view => ({ id: view.id, number: view.number, title: view.brief.title, status: view.status })) }, null, 2)}\n`);
      return;
    }
    await writeStdout(`${[`Собрано: ${countsText(views)}.`, `Черновик: ${id}`, '', 'Дальше:', `  agent-lab cards --id ${id}   ситуации, их вопросы и как ответить`,
      `  agent-lab cards --id ${id} --accept --yes   утвердить готовые`, `  agent-lab run --id ${id} --yes   прогнать утверждённые`].map(line => safeLine(line)).join('\n')}\n`);
  });
}

/** The situations of a draft or a run as the chat and the board read them: a card set against its imports, an older record by its scenarios. */
async function situationsOf(lab: ExperimentLab, id: string): Promise<{ record: Experiment; views: SituationView[]; rulebook?: RulebookView | undefined }> {
  const record = await lab.get(id);
  if (record.librarySnapshot?.formatVersion !== 2) return { record, views: situationViews(record, { maxTurns: record.settings.maxTurns }) };
  const context = await lab.cardContext(id);
  return { record: context.experiment, views: situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns }),
    rulebook: shownRulebook(context.library) };
}

/** Runs an accepted draft to its result: the record as it ended and its one view, the source run read for stability as in `summary`. */
async function runToResult(lab: ExperimentLab, id: string, values: Flags) {
  const draft = await lab.get(id);
  await lab.start(id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft), ...(values.parallel ? { parallel: Number(values.parallel) } : {}) }); await lab.waitForIdle();
  const result = await lab.get(id);
  const verified = await resolveVerified(result, lab.store, result.parentRunId);
  return { result, warnings: verified.warnings, view: buildResultView(verified.record, { before: verified.before }), artifact: resolve(lab.store.directory, `${id}.json`) };
}
type Ran = Awaited<ReturnType<typeof runToResult>>;

/** A run as a script reads it: the view, its exit code and the proof of every dialogue. */
const machineRun = ({ result, warnings, view, artifact }: Ran) => ({ id: result.id, phase: result.phase, mode: result.mode, reviewMode: result.reviewMode,
  ...(result.workflow === 'evaluate' ? { ...machineResult(view), proofs: result.trials.map(trial => trialProofLines(result, trial.id)) } : { view }),
  comparison: result.comparisons.at(-1), ...(warnings.length ? { warnings } : {}), artifact });

/** A run that did not reach its result says why, what is kept and where to look. */
function reached({ result }: Ran): void {
  if (['complete', 'results_review'].includes(result.phase)) return;
  const why = stopText(result.error);
  throw new Error(`Прогон не дошёл до результата${why ? `: ${why}` : '.'} Записанное сохранено: agent-lab summary --id ${result.id}.`);
}

async function demo({ values, directory }: CommandInput): Promise<void> {
  await asWriter(directory, async lab => {
    // Free: no model, no keys — the teaching example needs no consent.
    const id = await prepareDraft(lab, demoInput());
    // The teaching example takes the owner's path: answer its one question («Да» — the customer knew the number), then accept every ready situation.
    const context = await lab.cardContext(id);
    let answered = 0;
    for (const view of situationViews(context.experiment, { evidence: context.evidence, maxTurns: context.experiment.settings.maxTurns })) if (view.question?.id) {
      const answer = await lab.prepareCardCommand(id, { kind: 'answer_question', cardId: view.id, questionId: view.question.id, choice: 'a' }, { via: 'cli-yes' });
      await lab.applyCardCommand(id, answer, hostGrant(answer, 'confirmed'));
      answered++;
    }
    const now = await lab.cardContext(id);
    const ready = situationViews(now.experiment, { evidence: now.evidence, maxTurns: now.experiment.settings.maxTurns }).filter(view => view.status === 'ready');
    await lab.acceptCards(id, libraryHash(now.library), ready.map(view => view.id));
    const ran = await runToResult(lab, id, values);
    reached(ran);
    // The teaching agent errs on purpose: its failure is the lesson, never a failure of the command — the exit code stays 0.
    if (values.json) { await writeStdout(`${JSON.stringify(machineRun(ran), null, 2)}\n`); return; }
    const said = (text: string) => wrapTextWithAnsi(safeLine(text), Math.min(process.stdout.columns ?? MAX_WIDTH, MAX_WIDTH)).join('\n');
    await writeStdout([
      said(`Учебный пример: ${countText(ready.length, ['ситуация', 'ситуации', 'ситуаций'])}, без модели и ключей.${answered
        ? ` На ${answered === 1 ? 'вопрос одной из них' : `вопросы ${countText(answered, ['ситуации', 'ситуаций', 'ситуаций'])}`} Lab ответил «Да» за вас.` : ''}`), '',
      screenText(ran.view, ran.warnings).trimEnd(), '',
      said('Учебный агент ошибается нарочно: так выглядит найденная ошибка — что ожидалось, что ответил агент, какое правило нарушено.'),
      said('Проверить своего агента: agent-lab в папке его проекта — откроется чат Pi с Agent Lab.'), '',
    ].join('\n'));
  });
}

async function run({ values, directory }: CommandInput): Promise<void> {
  await asWriter(directory, async lab => {
    if (!values.id) throw new Error('Укажите прогон: --id RUN.');
    if (!values.yes) throw new Error('Для запуска согласованных тестов укажите --yes.');
    const ran = await runToResult(lab, values.id, values);
    await writeStdout(`${JSON.stringify(machineRun(ran), null, 2)}\n`);
    if (ran.result.workflow === 'evaluate') process.exitCode = exitCodeOf(ran.view);
    reached(ran);
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

/** The flags of `import`: the owner's answers about the table, as the chat asks them one at a time. */
const TABLE_FLAGS: readonly Flag[] = ['file', 'input', 'json', 'yes', 'sheet', 'id-column', 'text-column', 'separator', 'no-separator', 'markers', 'role-column', 'roles',
  'order-column', 'row-order', 'where', 'collapse-repeats', 'keep-repeats'];
const BUILD_FLAGS: readonly Flag[] = ['input', 'dialogues-file', 'situations', 'connection', 'parallel', 'yes', 'json', 'prompts-from', 'prompt', 'prompts'];

/** Every command in the order `--help` lists them: first the owner's path, then what scripts and CI use. */
const COMMANDS: Readonly<Record<string, Command>> = {
  detect: { help: [['agent-lab detect [--directory ПАПКА] [--json]', 'Что Lab нашёл в папке проекта: агента, логи, материалы, промпт']], flags: ['directory', 'json'], run: detect },
  import: { help: [['agent-lab import --file логи.xlsx [--input задача.json] [--where "КОЛОНКА=ЗНАЧЕНИЕ"] [--collapse-repeats] [--yes] [--json]',
    'Как читать таблицу логов (.xlsx, .csv): с --input разметку предлагает модель задачи, Lab проверяет каждую строку; --yes — сначала на вызов модели, затем на загрузку']],
  flags: TABLE_FLAGS, run: importTable },
  build: { help: [['agent-lab build --input задача.json [--dialogues-file логи.jsonl|.xlsx] [--situations N] [--connection подключение.json] [--parallel 4] [--yes] [--json]',
    'Сколько ситуаций Lab подготовит и сколько вызовов модели это может стоить; --yes готовит их'],
  ['agent-lab build --input задача.json --prompts-from ПАПКА [--yes]', 'Промпты агента из его кода и JSON на выбор; с --yes модель задачи отметит те, что пишут ответ клиенту'],
  ['agent-lab build --input задача.json --prompts-from ПАПКА --prompt ФАЙЛ#ИМЯ ... | --prompts suggested [--yes]', 'Выбранные промпты (или отмеченные Lab) станут правилами поведения бота']],
  flags: BUILD_FLAGS, run: prepare },
  prepare: { help: [], flags: BUILD_FLAGS, run: prepare },
  cards: { help: [
    ['agent-lab cards --id RUN [--card N] [--json]', 'Ситуации: что пишет и знает клиент, что должен агент, статус и вопрос'],
    ['agent-lab cards --id RUN --card N --choice a|b|c [--text «…»] --yes', 'Ответ на вопрос ситуации'],
    ['agent-lab cards --id RUN --input команда.json [--yes]', 'Команда владельца; без --yes — только «было → стало»'],
    ['agent-lab cards --id RUN --check|--resume|--accept --yes [--parallel 4]', 'Проверить ситуации · продолжить подготовку · утвердить готовые'],
    ['agent-lab cards --id RUN --variations [--yes]', 'Ситуации для вариантов плана, которых нет в логах: по правилам'],
    ['agent-lab cards --id RUN [--operator-rules on|off] [--bind-rule ID] [--unbind-rule ID] [--yes]', 'Свод правил: входят ли инструкции для операторов, отдельные правила, обязательные для бота'],
    ['agent-lab cards --id RUN --convert', 'Черновик старого формата — продолжить в новом формате; старый останется как есть']],
  flags: ['id', 'card', 'json', 'input', 'choice', 'text', 'check', 'resume', 'accept', 'variations', 'convert', 'yes', 'parallel', 'operator-rules', 'bind-rule', 'unbind-rule'], run: cards },
  accept: { help: [['agent-lab accept --id RUN [--yes] [--json]', 'Что агент должен сделать в каждой ситуации; --yes подтверждает все ожидания']], flags: ['id', 'yes', 'json'], run: accept },
  run: { help: [['agent-lab run --id RUN --yes [--parallel 4]', 'Прогнать утверждённые ситуации; итог — JSON для скрипта']], flags: ['id', 'yes', 'parallel', 'json'], failure: 2, run },
  repeat: { help: [['agent-lab repeat --id RUN [--case SCENARIO_ID] [--control SCENARIO_ID]', 'Новый черновик тех же ситуаций']], flags: ['id', 'case', 'control'], run: repeat },
  demo: { help: [['agent-lab demo [--json]', 'Учебный пример целиком, без модели и ключей: итог экраном, с --json — JSON']], flags: ['json'], run: demo },
  summary: { help: [['agent-lab summary --id RUN [--json]', 'Сколько ситуаций агент прошёл, что не измерено и почему']], flags: ['id', 'json'], run: summary },
  logs: { help: [['agent-lab logs --id RUN [--agent-version ВЕРСИЯ | --unknown] [--import ID] [--yes]', 'Какая версия агента записала логи: только тогда сверка с продом — калибровка']],
    flags: ['id', 'agent-version', 'unknown', 'import', 'yes'], run: logs },
  calibration: { help: [['agent-lab calibration --id RUN [--json]', 'Сверка с продом: где синтетика разошлась с разговорами из логов и что это значит'],
    ['agent-lab calibration --id RUN --card N --choice agree|disagree|unsure [--expectation А] [--text «причина»] [--yes] [--json]',
      'Прав ли судья по разговору из логов ситуации N; без --yes — только что будет записано']],
  flags: ['id', 'card', 'choice', 'expectation', 'text', 'yes', 'json'], run: calibration },
  reassess: { help: [['agent-lab reassess --id RUN [--input criteria.json] [--trial ID] --yes | --code-only', 'Оценить записанные разговоры заново: судьёй или только точными проверками']],
    flags: ['id', 'input', 'trial', 'yes', 'code-only'], failure: 2, run: reassess },
  'check-judge': { help: [['agent-lab check-judge --id RUN [--planted 10] [--controls 10] [--yes] [--json]', 'Проверить судью без человека: поймает ли он подброшенные ошибки; без --yes — только сколько вызовов']],
    flags: ['id', 'planted', 'controls', 'yes', 'json'], run: checkJudgeCommand },
  export: { help: [['agent-lab export --id RUN --format html|markdown|json [--before RUN] [--output отчёт.html]', 'Отчёт для заказчика']], flags: ['id', 'format', 'before', 'output'], run: exportRun },
  diff: { help: [['agent-lab diff --before RUN --after RUN [--json]', 'Что сломалось и что исправилось между двумя прогонами']], flags: ['before', 'after', 'json'], run: diff },
  'save-suite': { help: [['agent-lab save-suite --id RUN --output .evals/regression.json [--case ID]', 'Сохранить набор ситуаций в файл']], flags: ['id', 'output', 'case'], run: saveSuite },
  evaluate: { help: [['agent-lab evaluate --input .evals/regression.json --yes [--case ID] [--parallel 4] [--connection подключение.json] [--before RUN]', 'Прогнать сохранённый набор (CI)']],
    flags: ['input', 'yes', 'case', 'parallel', 'connection', 'before'], failure: 2, run: evaluate },
  suites: { help: [['agent-lab suites [--directory .evals]', 'Сохранённые наборы']], flags: ['directory'],
    run: async ({ values }) => { process.stdout.write(JSON.stringify(await listSuites(values.directory ?? '.evals'), null, 2) + '\n'); } },
  connect: { help: [['agent-lab connect --curl запрос.txt|- [--message /путь] [--conversation /путь] [--output connection.json] [--yes]', 'Подключение агента в его собственном формате из команды curl']],
    flags: ['curl', 'message', 'conversation', 'output', 'yes'], run: ({ values }) => connectFromCurl(values) },
  doctor: { help: [['agent-lab doctor --connection подключение.json --yes', 'Три пробных запроса к агенту: запись, чтение, сброс'],
    ['agent-lab doctor --connection подключение.json [--reply /путь] --yes', 'Агент в своём формате: строение ответа, затем два хода одного разговора']],
  flags: ['connection', 'yes', 'reply', 'output'], run: checkConnection },
  status: { help: [['agent-lab status', 'Модели и ключи, которые видит Pi']], flags: [], run: async () => { process.stdout.write(`${JSON.stringify(await getPiStatus(), null, 2)}\n`); } },
};

const INTRO = 'Agent Lab — насколько хорош ваш агент: точность на ситуациях из реальных логов и причины провалов.';
const CHAT: readonly (readonly [string, string])[] = [['agent-lab', 'Диалог с Agent Lab в текущем проекте'], ['agent-lab chat [опции Pi]', 'То же; задачу пишите обычными словами']];
const RULES = [
  'evaluate, run и reassess: 0 — все оценки пройдены; 1 — зарегистрирован провал агента; 2 — ошибка теста или среды, неполные данные.',
  '--yes разрешает расход в пределах сохранённых лимитов; ручной оценкой ожиданий это не считается. Из чата Agent Lab --yes не принимается: там согласие спрашивает сам чат.',
];

/**
 * `--help` laid out for the terminal, at most 100 columns (docs/design/ui-spec.md §6): each command as it is typed, then
 * what it does under it, both wrapped — a long usage continues under itself. `name`: one command's own help.
 */
function helpText(name?: string): string {
  const width = Math.max(40, Math.min(process.stdout.columns ?? MAX_WIDTH, MAX_WIDTH));
  const entry = ([usage, text]: readonly [string, string]) => [...wrapHanging(usage, width - 2, width - 6).map((line, index) => `${index ? '      ' : '  '}${line}`),
    ...wrapTextWithAnsi(text, width - 6).map(line => `      ${line}`)];
  const own = name ? COMMANDS[name]?.help : undefined;
  const lines = own?.length ? own.flatMap(entry)
    : [...wrapTextWithAnsi(INTRO, width), '', ...CHAT.flatMap(entry), '', ...Object.values(COMMANDS).flatMap(command => command.help.flatMap(entry)), '', ...RULES.flatMap(rule => wrapTextWithAnsi(rule, width))];
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'chat' || (!args.length && process.stdin.isTTY)) { await chat(args.slice(args[0] === 'chat' ? 1 : 0)); return; }
  const line = readCommandLine(args, name => COMMANDS[name]?.flags, Object.keys(COMMANDS).filter(name => COMMANDS[name]!.help.length));
  if (line.help || !line.name) { await writeStdout(helpText(line.name)); return; }
  if (line.values.yes && IN_CHAT) throw new Error(CHAT_ASKS);
  await COMMANDS[line.name]!.run({ values: line.values, directory: line.values['data-dir'] ?? resolve('.agent-lab') });
}

/** The flags as far as the line can be read: a line that cannot be read still names its files, for the words of its error. */
function readableFlags(args: readonly string[]): Flags {
  try { return readCommandLine(args, command => COMMANDS[command]?.flags, []).values; } catch { return {} as Flags; }
}

/**
 * A command that could not do what it was asked says why in the owner's words, and exits with its command's code: 2
 * for what a CI reads (the test or the place could not measure), 1 for the rest. The command is read from the line
 * itself, wherever the owner put it among the flags.
 */
void main().catch(error => {
  const args = process.argv.slice(2);
  const name = commandOf(args);
  const values = readableFlags(args);
  const { text, detail } = errorText(error, { directory: values['data-dir'] ?? resolve('.agent-lab'),
    files: { input: values.input, file: values.file, connection: values.connection, curl: values.curl, 'dialogues-file': values['dialogues-file'], output: values.output } });
  process.stderr.write(`Agent Lab: ${safeLine(text)}\n${detail ? `  ${safeLine(detail)}\n` : ''}`);
  process.exitCode = (name ? COMMANDS[name]?.failure : undefined) ?? 1;
});
