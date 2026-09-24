import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, relative, resolve } from 'node:path';
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { z } from 'zod';
import { preparationCeiling } from '../src/card/budget.js';
import { createInputSchema, DEFAULT_JUDGE, materialSources, SCENARIO_LIMIT, settingsSchema, type Experiment } from '../src/contracts.js';
import { rememberedConnection } from '../src/connection.js';
import { demoInput } from '../src/demo.js';
import { detectProject, targetLabel, type ProjectDetection } from '../src/detect.js';
import type { ExperimentLab } from '../src/experiment.js';
import { readDialogueImport } from '../src/imports.js';
import { expandMaterials, promptMaterials } from '../src/materials.js';
import type { PromptCandidate } from '../src/prompt-candidates.js';
import { consentText, DEFAULT_SITUATIONS, preparationConsent, rulesConsentText } from '../src/miner/plan.js';
import { countText } from '../src/plural.js';
import { TABLE_EXTENSIONS } from '../src/spreadsheet/workbook.js';
import { safeText } from '../src/text.js';
import { preparedAnswer, STOP_HINT, type Background } from './background.ts';
import { progressText, row, runStamp } from './conversation.ts';
import { ask, displayFor, isInteractive, NeedsOwner, requireInteractive } from './lab-ui.ts';
import { followRecord, type LabLease, type SessionOperations } from './operations.ts';
import type { Feed } from './render/feed.ts';
import { TOOL } from './steps.ts';
import { confirmedBefore, importTable } from './table-import.ts';
import { choosePromptsWithLab } from './prompt-choice.ts';

/*
 * «Проверь агента, логи — выгрузка.xlsx» (docs/design/ui-spec.md §4.10): logs, the owner's rules and the agent become a draft of
 * situations. Lab looks through the project folder for what the request did not name — the logs, the rules, how
 * the agent is started — and asks only what it cannot settle: which log file of several, how to read a spreadsheet.
 * Every paid preparation passes one consent the host asks natively — what is read, how many situations at most,
 * what is left out and why, the spending ceiling (miner/plan.ts); the model never passes settings or a consent.
 * The agent need not be connected yet: the connection is asked for right before the run (the owner's decision of 23.09).
 */

export interface PrepareHost {
  inlineBuildMs: number;
  operations: SessionOperations;
  open: (cwd: string) => Promise<LabLease>;
  reading: (directory: string) => ExperimentLab;
  background: Background;
  feedResult: (callId: string, output: unknown, feed: Feed, note: string) => AgentToolResult<unknown>;
  askOwner: (callId: string, error: unknown) => AgentToolResult<unknown>;
}

/** Situations prepared from the owner's rules alone when the owner names no number. */
const RULES_SITUATIONS = 5;
const DOCUMENTS: [string, string, string] = ['документ', 'документа', 'документов'];
const closed = { additionalProperties: false } as const;
const path = (description: string) => Type.String({ minLength: 1, maxLength: 1000, description });

export const prepareParameters = Type.Object({
  task: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: 'What the agent does and what to check, in one or two sentences — from the owner\'s words or the project. Needed unless demo or suite.' })),
  logs: Type.Optional(path('The file of logged conversations the owner named (.json, .jsonl, .xlsx, .csv), relative to the project, absolute or from ~. Omit to use what Lab finds in the project folder.')),
  withoutLogs: Type.Optional(Type.Literal(true, { description: 'Only after the owner explicitly chose to start without logs: situations from their rules alone.' })),
  situations: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: `How many situations at most, when the owner named a number: ${DEFAULT_SITUATIONS} from logs, ${RULES_SITUATIONS} from rules by default.` })),
  materials: Type.Optional(Type.Array(path('A file or a folder.'), { minItems: 1, maxItems: 50, description: 'The owner\'s rules and knowledge base as files or folders (.docx, .md, .txt, .html), read whole by Lab. Omit to use what Lab finds in the project folder.' })),
  prompts: Type.Optional(Type.Array(path('A file, or a prompt id Lab found (file#CONSTANT, file#field).'), { minItems: 1, maxItems: 20, description: 'Only the prompts the owner named as forming the bot\'s reply to the customer: files, or ids from what Lab found in the project. Omit to let the owner choose among what Lab finds.' })),
  rules: Type.Optional(Type.String({ minLength: 1, maxLength: 20000, description: 'Rules the owner wrote in this conversation, in their own words.' })),
  table: Type.Optional(Type.Object({
    sheet: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), text: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    where: Type.Optional(Type.Object({
      column: Type.String({ minLength: 1, maxLength: 200 }),
      values: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { minItems: 1, maxItems: 30, description: 'Only values the owner named, as written in the table.' })),
    }, { ...closed, description: 'Only when the owner named the column whose values choose the conversations to evaluate. Without values the host asks the owner which to keep.' })),
    request: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: 'The owner\'s own words about which conversations to evaluate, when they did not name the column (e.g. «только те, где отвечал один агент эквайринга»): Lab\'s model finds the column and its values in the table.' })),
    collapseRepeats: Type.Optional(Type.Boolean({ description: 'Only after the owner said what to do with exchanges the export repeated: true — read each once, false — keep them as written.' })),
  }, { ...closed, description: 'Only when the owner corrected how to read a spreadsheet or chose which of its conversations to evaluate: the sheet, the column of the conversation id, the column of the text, the conversations kept (where, or request in the owner\'s words), the repeated exchanges. A column is a header or a letter.' })),
  suite: Type.Optional(path('A saved set of situations (.evals/*.json) to load into a fresh draft instead of preparing: free, nothing runs.')),
  demo: Type.Optional(Type.Literal(true, { description: 'The built-in teaching example: no model, no keys, one minute.' })),
}, closed);
type PrepareParams = { task?: string; logs?: string; withoutLogs?: true; situations?: number; materials?: string[]; prompts?: string[]; rules?: string;
  table?: { sheet?: string; id?: string; text?: string; where?: { column: string; values?: string[] }; request?: string; collapseRepeats?: boolean }; suite?: string; demo?: true };

/** A path the owner or the model named: `~/…` is the owner's home, anything else is relative to the project. */
export function projectPath(named: string, cwd: string): string {
  return named === '~' || named.startsWith('~/') ? join(homedir(), named.slice(1)) : resolve(cwd, named);
}
/** How a path is shown to the owner: inside the project relative to it, elsewhere from ~. */
function shownPath(file: string, cwd: string): string {
  const inside = relative(cwd, file);
  if (inside && !inside.startsWith('..')) return inside;
  const home = homedir();
  return file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file;
}

/** A schema error in the owner's language: which field and what is wrong, never a raw issue dump. */
function plainInputError(error: unknown): Error {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error : new Error(String(error));
  return new Error(`Не удалось подготовить проверку: ${error.issues.slice(0, 6).map(issue => `${issue.path.join('.') || 'вход'} — ${issue.message}`).join('; ')}. Ничего не запущено и не потрачено.`);
}

export function registerPrepareTool(pi: Pick<ExtensionAPI, 'registerTool'>, host: PrepareHost): void {
  pi.registerTool({
    ...displayFor(TOOL.prepare), name: TOOL.prepare, label: 'Prepare situations',
    description: 'Prepares situations (test cases) for the owner\'s agent: from logged conversations (logs), from the owner\'s rules alone (withoutLogs, only after the owner chose that), the built-in teaching example (demo) or a saved set (suite). Rules come from files (materials, prompts) or the owner\'s own words (rules); without any, Lab uses what it finds in the project folder, and it proposes the log file itself when none is named. The host asks the owner natively how to read a spreadsheet and for one consent with the spending ceiling; you never pass settings or a consent. The agent need not be connected yet. A long preparation continues in the background and its situations arrive as a message: tell the owner in one sentence and do not poll.',
    parameters: prepareParameters,
    executionMode: 'sequential',
    async execute(callId, params, toolSignal, onUpdate, ctx) {
      const signal = AbortSignal.any([toolSignal, ctx.signal].filter((item): item is AbortSignal => !!item));
      signal.throwIfAborted();
      try {
        // Work going on in this session holds the writer's lease: say so before asking the owner anything.
        const busy = host.operations.busy(resolve(ctx.cwd, '.agent-lab'));
        if (busy) throw new Error(busy);
        if (params.demo) return await prepare(host, callId, ctx, signal, onUpdate, demoInput(), { notes: [] });
        if (params.suite) return await loadSuite(host, callId, ctx, projectPath(params.suite, ctx.cwd));
        return await fromOwner(host, callId, ctx, signal, onUpdate, params);
      } catch (error) { return host.askOwner(callId, error); }
    },
  });
}

/** A saved set of situations as a fresh draft: nothing is prepared, paid or run. */
async function loadSuite(host: PrepareHost, callId: string, ctx: ExtensionContext, file: string): Promise<AgentToolResult<unknown>> {
  const { lab, close } = await host.open(ctx.cwd);
  try {
    await lab.init();
    const record = await lab.loadSuite(file);
    return host.feedResult(callId, { run: record.id, situations: record.scenarios.length, instruction: 'A draft of the saved set; nothing ran. The owner starts it with agent_lab_run.' },
      { rows: [row(`Набор загружен: ${countText(record.scenarios.length, ['ситуация', 'ситуации', 'ситуаций'])}; агент не запускался.`, 'text', true),
        row('Скажите «запусти», чтобы прогнать его.', 'muted')] }, `Набор · ${runStamp(record)}`);
  } finally { await close(); }
}

/** Which of the logs Lab found in the project folder: the one there is, or the owner's pick of several; «rules» — the owner chose to start without logs. */
async function logsOf(ctx: ExtensionContext, found: ProjectDetection | undefined): Promise<string | 'rules' | undefined> {
  const logs = found?.logs ?? [];
  if (!logs.length) throw new NeedsOwner('needs_owner_input', 'В папке проекта нет файлов с разговорами. Спросите владельца, где лежат логи (JSON, JSONL, XLSX или CSV), — или пусть скажет «начать без логов» (withoutLogs).', [],
    'Есть записи разговоров с агентом? Назовите файл с логами — или скажите «начать без логов».');
  if (logs.length === 1) return join(found!.root, logs[0]!.file);
  requireInteractive(ctx, 'В папке несколько файлов с логами: какой взять, решает владелец в интерактивном терминале Pi. Назовите файл в logs.');
  const labels = logs.slice(0, 8).map(log => safeText(`${log.file} — ${countText(log.dialogues, ['разговор', 'разговора', 'разговоров'])}${log.table ? ', таблица' : ''}`));
  const without = 'Без логов — по вашим правилам';
  const picked = await ctx.ui.select(safeText('Из каких логов собрать ситуации?\n\nLab нашёл в папке проекта несколько файлов с разговорами:'), [...labels, without, 'Не сейчас']);
  if (picked === without) return 'rules';
  const index = labels.indexOf(picked ?? '');
  return index < 0 ? undefined : join(found!.root, logs[index]!.file);
}

/** A prompt id the request named that Lab did not find: the model named it wrong, the owner is asked. */
function unknownPrompt(id: string, found: ProjectDetection | undefined): never {
  const known = (found?.prompts ?? []).slice(0, 12).map(prompt => prompt.id);
  throw new NeedsOwner('unknown_reference', `Промпта ${id} Lab в проекте не нашёл.${known.length ? ` Есть: ${known.join('; ')}.` : ''} Спросите владельца, какой нужен.`, known);
}

const declined = (host: PrepareHost, callId: string, text: string) =>
  host.feedResult(callId, { cancelled: true, spent: 0, instruction: 'The owner stepped back: nothing was spent or written. Do not ask again unless they do.' },
    { tone: 'warning', rows: [row(text)] }, 'Сбор ситуаций отменён');

/** Logs and rules of the owner's own agent: what Lab finds, the owner's consent, then the preparation. */
async function fromOwner(host: PrepareHost, callId: string, ctx: ExtensionContext, signal: AbortSignal, onUpdate: ((update: AgentToolResult<unknown>) => void) | undefined,
  params: PrepareParams): Promise<AgentToolResult<unknown>> {
  const directory = resolve(ctx.cwd, '.agent-lab');
  const named = !!(params.materials || params.prompts || params.rules);
  // A prompt named by its id (file#CONSTANT) is one Lab finds in the project, verbatim.
  const byId = (params.prompts ?? []).filter(item => item.includes('#'));
  // Lab looks through the project for what the request did not name: the logs, the rules, how the agent is started.
  const found = params.logs && named && !byId.length ? undefined : await detectProject(ctx.cwd).catch(() => undefined);
  const logs = params.withoutLogs ? 'rules' as const : params.logs ? projectPath(params.logs, ctx.cwd) : await logsOf(ctx, found);
  if (logs === undefined) return declined(host, callId, 'Не собираю: файл с логами не выбран. Ничего не потрачено.');
  if (logs !== 'rules' && !await stat(logs).then(info => info.isFile(), () => false)) {
    throw new NeedsOwner('unknown_reference', `Файла с логами ${shownPath(logs, ctx.cwd)} нет. Спросите владельца, где он лежит.`, [], `Файла ${shownPath(logs, ctx.cwd)} нет — где лежат логи?`);
  }
  // The model can say this itself from the project or the owner's words: a plain error it corrects, never a question to the owner.
  if (!params.task) throw new Error('Не хватает описания агента: одной-двумя фразами — что он делает и что проверить (task).');
  // The rules: the files named, otherwise the knowledge folders found in the project and the prompts the owner picks among
  // those found; the owner's own words on top.
  let prompts: PromptCandidate[];
  if (named) {
    prompts = byId.map(id => found?.prompts.find(prompt => prompt.id === id) ?? unknownPrompt(id, found));
  } else {
    if (found?.prompts.length) requireInteractive(ctx, 'Какие промпты — правила ответа бота, выбирает владелец в интерактивном терминале Pi. Без него: agent-lab build --prompts-from ПАПКА --prompt ФАЙЛ#ИМЯ.');
    let picked: PromptCandidate[] | 'declined' = [];
    if (found?.prompts.length) {
      // The writer's lease for the length of the choice: a proposal Lab's model makes is stored for the next look.
      const owned = await host.open(ctx.cwd);
      try { await owned.lab.init(); picked = await choosePromptsWithLab(ctx, owned.lab, found.prompts, signal); } finally { await owned.close(); }
    }
    if (picked === 'declined') return declined(host, callId, 'Не собираю: промпты не выбраны. Ничего не потрачено.');
    prompts = picked;
  }
  const files = named ? { materialFiles: (params.materials ?? []).map(item => projectPath(item, ctx.cwd)),
    promptFiles: (params.prompts ?? []).filter(item => !item.includes('#')).map(item => projectPath(item, ctx.cwd)) }
    : { materialFiles: (found?.materials ?? []).map(item => join(found!.root, item.folder)), promptFiles: [] };
  const inline = [...(params.rules ? [{ name: 'Правила из разговора', content: params.rules }] : []),
    ...promptMaterials(prompts).map(({ name, content, kind }) => ({ name, content, kind }))];
  const expanded = await expandMaterials({ ...(inline.length ? { materials: inline } : {}), ...files }, ctx.cwd);
  if (!expanded.materials.length) throw new NeedsOwner('needs_owner_input', 'Нет правил, по которым судить агента: Lab не нашёл ни промпта, ни базы знаний. Спросите владельца, где они (файлы или папка: materials, prompts), или пусть напишет правила словами (rules).', [],
    'По каким правилам судить агента? Назовите файл с промптом или базой знаний — или напишите правила словами.');
  const notes = [...expanded.skipped.slice(0, 20).map(item => `Пропущен ${shownPath(item.file, ctx.cwd)}: ${item.reason}.`),
    ...(expanded.skipped.length > 20 ? [`…и ещё ${expanded.skipped.length - 20} пропущенных файлов.`] : [])];

  // The logs become an import: a spreadsheet only through the reading its owner confirmed.
  let libraryImport: Awaited<ReturnType<typeof readDialogueImport>> | undefined;
  if (logs !== 'rules') {
    if (TABLE_EXTENSIONS.has(extname(logs).toLowerCase())) {
      const { sheet, id, text, where, request: words, collapseRepeats } = params.table ?? {};
      // The owner's corrections, said in words; which conversations to keep is asked natively when no value was named.
      const choices = { ...(sheet ? { sheet } : {}), ...(id ? { id } : {}), ...(text ? { text } : {}), ...(where ? { where } : {}), ...(collapseRepeats === undefined ? {} : { collapseRepeats }) };
      if (Object.keys(choices).length || words || !await confirmedBefore(logs, directory)) {
        requireInteractive(ctx, 'Как читать таблицу, решает владелец в интерактивном терминале Pi. Без него: agent-lab import --file … --input задача.json --yes.');
        const owned = await host.open(ctx.cwd);
        let imported: Awaited<ReturnType<typeof importTable>>;
        try {
          await owned.lab.init();
          // The chat's model reads the table, as it prepares the situations after it; without one Lab reads it by itself and says so.
          const settings = ctx.model && settingsSchema.parse({ provider: ctx.model.provider, model: ctx.model.id });
          const reader = settings && (await owned.lab.modelRuntime(settings)).tableReading;
          imported = await importTable(ctx, owned.lab.store, logs, choices, reader && settings ? { reader, timeoutMs: settings.timeoutMs, signal, ...(words ? { words } : {}) } : undefined);
        } finally { await owned.close(); }
        if ('declined' in imported) return declined(host, callId, 'Таблицу не загружаю: вы не подтвердили, как её читать. Ничего не потрачено.');
        if ('refused' in imported) return host.feedResult(callId, { refused: imported.refused, instruction: 'Nothing was read. Tell the owner why in one sentence; they may name the sheet or a column (table).' },
          { tone: 'warning', rows: [row(safeText(imported.refused))] }, 'Таблица не прочитана');
      }
    }
    try { libraryImport = await readDialogueImport(logs, { directory }); }
    catch (error) { throw new Error(safeText(`Не удалось прочитать логи ${shownPath(logs, ctx.cwd)}: ${error instanceof Error ? error.message : String(error)} Агент не запускался, ничего не потрачено.`)); }
    if (!libraryImport.originalImport.dialogues.length) throw new Error(`В ${shownPath(logs, ctx.cwd)} нет разговоров, которые Lab может прочитать.`);
  }

  // The run's settings are the host's: the model names neither a limit nor a model.
  const count = params.situations ?? (libraryImport ? DEFAULT_SITUATIONS : RULES_SITUATIONS);
  if (!libraryImport && count > SCENARIO_LIMIT) throw new Error(`По правилам без логов Lab готовит не больше ${SCENARIO_LIMIT} ситуаций за раз.`);
  // The conversations a preparation may try: the sample and the replacements of picks that make no situation.
  const tried = Math.min(40, 3 * count);
  const connection = await rememberedConnection(directory);
  let input: z.infer<typeof createInputSchema>;
  try {
    input = createInputSchema.parse({
      task: params.task, mode: 'live', workflow: 'evaluate', materials: expanded.materials, scenarioCount: libraryImport ? 0 : count,
      target: connection?.target ?? { kind: 'unconnected' }, ...(connection?.targetVersion ? { targetVersion: connection.targetVersion } : {}),
      ...(libraryImport ? { originalImport: libraryImport.originalImport, dialogues: libraryImport.dialogues.slice(0, 200) } : {}),
      settings: settingsSchema.parse({ provider: ctx.model?.provider ?? '', model: ctx.model?.id ?? '', judge: DEFAULT_JUDGE, repeats: 1,
        ...(libraryImport ? { maxCalls: Math.max(140, 2 * tried + 19 * count + 20), maxDurationMs: Math.min(14_400_000, Math.max(180_000, 180_000 * tried)),
          // Grounding many materials with a small model routinely exceeds the two-minute default per call.
          timeoutMs: 600_000, maxTurns: 6, userModes: ['reactive'] }
          : { maxCalls: Math.max(20, 10 * count + 10), maxDurationMs: 180_000 }) }),
    });
  } catch (error) { throw plainInputError(error); }

  // The one gate of a paid preparation, asked last: a request that cannot start never asks the owner for money.
  requireInteractive(ctx, 'Подготовка ситуаций тратит вызовы модели: согласие даётся в интерактивном терминале Pi. Без него: agent-lab build --input задача.json.');
  const consent = libraryImport ? await preparationConsent(host.reading(directory).store, { input, situations: count }) : undefined;
  // The ceiling the owner agrees to is the one the preparation stops at: it goes to the lab with the consent.
  const callCeiling = consent?.callCeiling ?? preparationCeiling({ task: input.task, sources: materialSources(input.materials), situations: count, fromLogs: false });
  const plan = consent ? consentText(consent, basename(logs)) : rulesConsentText(count, callCeiling);
  const sources = [...(params.rules ? ['ваши слова из разговора'] : []), ...prompts.map(prompt => prompt.id),
    ...[...files.promptFiles, ...files.materialFiles].map(file => shownPath(file, ctx.cwd))];
  const agent = connection ? `Агент: ${targetLabel(connection.target, ctx.cwd)}.`
    : found?.agents[0] ? `Агента Lab подключит перед прогоном — в папке нашёл: ${targetLabel(found.agents[0].target, found.root)}.` : 'Как запускать агента, Lab спросит перед прогоном.';
  const lines = [...plan.lines, `Правила: ${sources.slice(0, 4).join(', ')}${sources.length > 4 ? ` и ещё ${sources.length - 4}` : ''} — ${countText(expanded.materials.length, DOCUMENTS)}.`, agent];
  if (!await ask(ctx, plan.question, lines, 'Собрать ситуации')) return declined(host, callId, 'Не собираю: вы отказались. Ничего не потрачено.');
  return prepare(host, callId, ctx, signal, onUpdate, input, { situations: consent?.promised ?? count, callCeiling, notes });
}

/**
 * The preparation itself. A short one ends in the row of its call. A long one, or Esc, goes to the session the way a
 * long run does: in the terminal Esc interrupts the action, not the work.
 */
async function prepare(host: PrepareHost, callId: string, ctx: ExtensionContext, signal: AbortSignal, onUpdate: ((update: AgentToolResult<unknown>) => void) | undefined,
  input: z.infer<typeof createInputSchema>, options: { situations?: number; callCeiling?: number; notes: string[] }): Promise<AgentToolResult<unknown>> {
  const owned = await host.open(ctx.cwd);
  const { lab, close } = owned;
  // Only a terminal can take a preparation over: the hand-over draws its progress and delivers its result through `ctx.ui` and a message.
  const interactive = isInteractive(ctx) && !!ctx.ui;
  let handedOver = false;
  let id: string | undefined;
  let unfollow: (() => void) | undefined;
  let lastProgress = '';
  /** The row of this call says how far the preparation got: redrawn from the live record at each change it reports. */
  const progress = (record: Experiment) => {
    if (!onUpdate) return;
    const text = safeText(progressText(record));
    if (text !== lastProgress) { lastProgress = text; onUpdate({ content: [{ type: 'text', text }], details: { id: record.id } }); }
  };
  const cancel = () => { if (id) void lab.cancel(id).catch(() => {}); };
  const notes = options.notes.length ? { materials: options.notes } : {};
  try {
    await lab.init(); signal.addEventListener('abort', cancel, { once: true }); signal.throwIfAborted();
    if (interactive) signal.removeEventListener('abort', cancel);
    id = (await lab.create(input, { ...(options.situations ? { situations: options.situations } : {}), ...(options.callCeiling ? { callCeiling: options.callCeiling } : {}) })).id;
    if (signal.aborted && !interactive) cancel();
    unfollow = followRecord(lab, id, progress);
    const inline = !interactive ? (await lab.waitForIdle(), true) : await new Promise<boolean>(settle => {
      const wait = setTimeout(() => settle(false), host.inlineBuildMs);
      const onAbort = () => settle(false);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      void lab.waitForIdle().then(() => settle(true), () => settle(true)).finally(() => { clearTimeout(wait); signal.removeEventListener('abort', onAbort); });
    });
    if (!inline) {
      unfollow(); unfollow = undefined;
      const record = await lab.get(id);
      handedOver = true;
      // The record ends with an error exactly when the preparation was cut short: stopped, out of calls or out of time.
      host.background.detach(ctx, owned, id, 'chat', async finished => { const answer = await preparedAnswer(lab, finished, !!finished.error); return { ...answer, output: { ...answer.output, ...notes } }; });
      return host.feedResult(callId, { run: id, background: true, instruction: 'The preparation continues in the background and its situations arrive as a message. Tell the owner in one short sentence and end your turn; do not poll. Reads still work; changes and runs wait until it ends. Stop it only when the owner asks: agent_lab_run action:"stop".' },
        { rows: [row('Готовлю ситуации в фоне — они придут сюда сообщением.', 'text', true), row(`Разговор свободен; ${STOP_HINT}.`, 'muted')] }, `Подготовка · ${runStamp(record)}`);
    }
    const finished: Experiment = await lab.get(id);
    const done = await preparedAnswer(lab, finished, signal.aborted && !interactive);
    return host.feedResult(callId, { ...done.output, ...notes }, done.feed ?? { rows: [row('Подготовка завершена.')] }, done.note ?? 'Подготовка');
  } finally { unfollow?.(); signal.removeEventListener('abort', cancel); if (!handedOver) await close(); }
}
