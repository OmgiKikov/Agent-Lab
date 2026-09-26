import { basename, resolve } from 'node:path';
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { z } from 'zod';
import { preparationCeiling, runLimit, runTime } from '../src/card/budget.js';
import { createInputSchema, isRunnable, judgeFor, materialSources, SCENARIO_LIMIT, settingsSchema, type Experiment, type FromAnalysis } from '../src/contracts.js';
import { rememberedConnection } from '../src/connection.js';
import { demoInput } from '../src/demo.js';
import { targetLabel, type ProjectDetection } from '../src/detect.js';
import { analysisView, criteriaHeld } from '../src/discover/view.js';
import { problemTitle } from '../src/discover/text.js';
import { checkLink, subsetImport } from '../src/discover/verify.js';
import type { ImportBatch } from '../src/scenario-contracts.js';
import type { ExperimentLab } from '../src/experiment.js';
import { consentText, DEFAULT_SITUATIONS, NothingFits, preparationConsent, rulesConsentText } from '../src/miner/plan.js';
import { countText } from '../src/plural.js';
import type { Encoding } from '../src/spreadsheet/csv.js';
import { safeText } from '../src/text.js';
import { preparedAnswer, STOP_HINT, type Background } from './background.ts';
import { progressText, row, runStamp } from './conversation.ts';
import { ask, displayFor, isInteractive, NeedsOwner, requireInteractive, zodText } from './lab-ui.ts';
import { followRecord, type LabLease, type SessionOperations } from './operations.ts';
import type { Feed } from './render/feed.ts';
import { TOOL } from './steps.ts';
import { declined, endedEarly, ownerInputs, projectPath, shownPath } from './owner-inputs.ts';

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
    interfaceMarkup: Type.Optional(Type.Boolean({ description: 'Only after the owner said what the fenced blocks (```…```) in the agent\'s messages are: true — interface elements (buttons, transitions) the customer does not read as text, false — text the customer reads.' })),
    encoding: Type.Optional(Type.Union([Type.Literal('utf-8'), Type.Literal('utf-16le'), Type.Literal('windows-1251'), Type.Literal('windows-1252')],
      { description: 'Only for a CSV file, when the owner said its text reads garbled or named its encoding: windows-1251 (Russian Excel), windows-1252 (Western Excel), utf-8, utf-16le.' })),
    answer: Type.Optional(Type.String({ maxLength: 200, description: 'One case per row: the column of the agent\'s logged reply; text is then the customer\'s question.' })),
    expected: Type.Optional(Type.Array(Type.Object({ column: Type.String({ maxLength: 200 }), kind: Type.Union([Type.Literal('answer'), Type.Literal('article'), Type.Literal('code'), Type.Literal('article_or_code')]) }, closed),
      { maxItems: 3, description: 'Columns of the assessor\'s expected result the owner named: answer text, article id or answer code.' })),
  }, { ...closed, description: 'Only when the owner corrected how to read a spreadsheet: sheet, conversation id, text, selection, repeated exchanges, CSV encoding, logged answer or expected result. A column is a header or a letter.' })),
  suite: Type.Optional(path('A saved set of situations (.evals/*.json) to load into a fresh draft instead of preparing: free, nothing runs.')),
  fromAnalysis: Type.Optional(Type.Object({ analysis: Type.String({ minLength: 1, maxLength: 200 }), problem: Type.Integer({ minimum: 1 }) },
    { ...closed, description: 'Only when the owner asks to make a check from a problem a log analysis found (agent_lab_analyze): the analysis id or "latest", and the problem number from its answer. The situations are made from the conversations where it was broken and those where the same rule held; each carries the problem\'s rule exactly as the analysis judged it.' })),
  demo: Type.Optional(Type.Literal(true, { description: 'The built-in teaching example: no model, no keys, one minute.' })),
}, closed);
type PrepareParams = { task?: string; logs?: string; withoutLogs?: true; situations?: number; materials?: string[]; prompts?: string[]; rules?: string; fromAnalysis?: { analysis: string; problem: number };
  table?: { sheet?: string; id?: string; text?: string; where?: { column: string; values?: string[] }; request?: string; collapseRepeats?: boolean; interfaceMarkup?: boolean;
    encoding?: Encoding; answer?: string; expected?: { column: string; kind: 'answer' | 'article' | 'code' | 'article_or_code' }[] }; suite?: string; demo?: true };

/**
 * A schema error in the owner's language: which field and what is wrong, never a raw issue dump. A call limit the
 * settings cannot hold means more situations than one preparation can take: a refusal in the owner's words, before
 * anything is written.
 */
export function plainInputError(error: unknown): Error {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error : new Error(String(error));
  const limit = error.issues.find(issue => issue.code === 'too_big' && issue.path.at(-1) === 'maxCalls');
  if (limit?.code === 'too_big') return new Error(`Столько ситуаций за один раз не подготовить: на них не хватит предельного лимита вызовов модели (${limit.maximum}). Назовите меньше ситуаций — остальные можно добавить следующей подготовкой. Ничего не запущено и не потрачено.`);
  return new Error(`Не удалось подготовить проверку: ${zodText(error)}. Ничего не запущено и не потрачено.`);
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
        if (params.fromAnalysis) return await fromAnalysis(host, callId, ctx, signal, onUpdate, params.fromAnalysis, params.situations);
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

/** What a preparation is made from: the task, the logs as an import (none from the rules alone), the rules and where they came from. */
interface Source {
  task: string;
  /** The log's name as the consent says it. */
  logsName?: string;
  libraryImport?: ImportBatch;
  materials: z.infer<typeof createInputSchema>['materials'];
  /** Where the rules came from, in the owner's words: files, prompts, «ваши слова из разговора». */
  rules: string[];
  found?: ProjectDetection | undefined;
  notes: string[];
  situations?: number;
  /** The problem of a log analysis the situations check, and the consent's line about it. */
  fromAnalysis?: { link: FromAnalysis; line: string };
  /** The teaching example's analysis makes a teaching check: its judge is a stand-in, and so is the check's. */
  mode?: 'demo' | 'live';
}

/** Logs and rules of the owner's own agent: what Lab finds, the owner's consent, then the preparation. */
async function fromOwner(host: PrepareHost, callId: string, ctx: ExtensionContext, signal: AbortSignal, onUpdate: ((update: AgentToolResult<unknown>) => void) | undefined,
  params: PrepareParams): Promise<AgentToolResult<unknown>> {
  const read = await ownerInputs(host, callId, ctx, signal, params, 'prepare');
  if (endedEarly(read)) return read;
  const { logs, libraryImport, expanded, prompts, files, found, notes } = read;
  return consentAndPrepare(host, callId, ctx, signal, onUpdate, { task: params.task!, ...(logs !== 'rules' ? { logsName: basename(logs) } : {}), ...(libraryImport ? { libraryImport } : {}),
    materials: expanded.materials, found, notes, ...(params.situations ? { situations: params.situations } : {}),
    rules: [...(params.rules ? ['ваши слова из разговора'] : []), ...prompts.map(prompt => prompt.id), ...[...files.promptFiles, ...files.materialFiles].map(file => shownPath(file, ctx.cwd))] });
}

/**
 * A check of a problem a log analysis found (DISCOVER → VERIFY): situations from the conversations where it was broken
 * and from those where the same criterion held with evidence (controls), by the analysis's own rules — an ordinary
 * preparation from logs, whose draft keeps the link to the analysis, the problem and its criterion, which every card of
 * those conversations carries (discover/verify.ts).
 */
async function fromAnalysis(host: PrepareHost, callId: string, ctx: ExtensionContext, signal: AbortSignal, onUpdate: ((update: AgentToolResult<unknown>) => void) | undefined,
  named: { analysis: string; problem: number }, situations: number | undefined): Promise<AgentToolResult<unknown>> {
  const reader = host.reading(resolve(ctx.cwd, '.agent-lab'));
  const analysis = named.analysis === 'latest' ? (await reader.listAnalyses())[0] : await reader.getAnalysis(named.analysis);
  if (!analysis) throw new NeedsOwner('unknown_reference', 'В этом проекте ещё нет ни одного разбора логов. Предложите владельцу сначала разобрать логи.', [], 'Разборов логов ещё нет — разобрать логи?');
  const batch = await reader.store.readImport(analysis.logs.importId);
  const view = analysisView(analysis, batch);
  const problem = view.problems[named.problem - 1];
  if (!problem) {
    const known = view.problems.map((item, index) => `${index + 1}. ${problemTitle(item)}`);
    throw new NeedsOwner('unknown_reference', `В разборе нет проблемы ${named.problem}.${known.length ? ` Есть: ${known.join('; ')}.` : ' Нарушений в нём нет.'} Спросите владельца, какую он имеет в виду.`, known.map((_, index) => String(index + 1)),
      `Проблемы ${named.problem} в разборе нет — из какой сделать проверку?`);
  }
  // A knowledge article says what is true, but does not by itself require this agent to answer instead of handing off.
  // Only the owner's confirmed examples may become regression situations for such a finding.
  if (problem.knowledgeOnly && !problem.confirmedDialogueIds.length) {
    throw new NeedsOwner('needs_owner_input',
      `Проблема ${named.problem} основана только на статье базы знаний. Сначала откройте её пример в разборе ${analysis.id} и подтвердите, что это нарушение именно для данного обращения. До этого проверку из неё не собираем.`, [],
      view.checking === 'facts' ? 'Сравните утверждение бота с фактом из статьи и подтвердите противоречие. После этого из примера можно сделать проверку новой версии.'
        : 'Статья базы знаний не задаёт обязательность каждого сведения в ответе. Откройте пример и подтвердите, что здесь есть нарушение.');
  }
  const selected = problem.knowledgeOnly ? { ...problem, dialogueIds: problem.confirmedDialogueIds } : problem;
  const { link, controls, neighbours } = checkLink(analysis, selected, criteriaHeld(view));
  const conversations: [string, string, string] = ['разговор', 'разговора', 'разговоров'];
  const line = `Ситуации — для проверки проблемы «${problemTitle(problem)}» из разбора логов: ${countText(link.broken.length, conversations)} с нарушением`
    + (controls.length ? ` и ${countText(controls.length, conversations)}, где агент это правило соблюдал, — исправление не должно их сломать.`
      : '. Разговоров, где это правило проверено и соблюдено, в разборе нет: что исправление не сломало его рядом, проверка не покажет.')
    + ' Каждая из них проверяет правило проблемы в точности так, как его оценил разбор.'
    + (neighbours.length ? ` Ещё ${countText(neighbours.length, conversations)}, где агент соблюдал другие правила, — проверка на регрессии остального: засчитается то, что выполнит нынешняя версия.` : '')
    + (problem.knowledgeOnly ? ' Основание — статья базы знаний; в ситуации с нарушением вошли только разговоры, где вы подтвердили вывод судьи.' : '');
  return consentAndPrepare(host, callId, ctx, signal, onUpdate, { task: analysis.task, logsName: analysis.logs.file, libraryImport: subsetImport(batch, link.dialogueIds),
    materials: analysis.sources.map(({ name, content, kind }) => ({ name, content, ...(kind ? { kind } : {}) })), notes: [],
    rules: analysis.sources.map(source => source.name), situations: situations ?? link.dialogueIds.length, mode: analysis.mode, fromAnalysis: { link, line } });
}

/** The draft's settings, the owner's consent with the ceiling, then the preparation. */
async function consentAndPrepare(host: PrepareHost, callId: string, ctx: ExtensionContext, signal: AbortSignal, onUpdate: ((update: AgentToolResult<unknown>) => void) | undefined,
  source: Source): Promise<AgentToolResult<unknown>> {
  const directory = resolve(ctx.cwd, '.agent-lab');
  const { libraryImport, found, notes } = source;
  // The run's settings are the host's: the model names neither a limit nor a model.
  const count = source.situations ?? (libraryImport ? DEFAULT_SITUATIONS : RULES_SITUATIONS);
  if (!libraryImport && count > SCENARIO_LIMIT) throw new Error(`По правилам без логов Lab готовит не больше ${SCENARIO_LIMIT} ситуаций за раз.`);
  // The draft's limits are its run's, computed from the run's plan (card/budget.ts): every situation at its most
  // expectations, one attempt with a customer Lab plays, and — from logs — the comparison with production. The
  // preparation has its own ceiling, the consent's, and its own time.
  const run = { repeats: 1, maxTurns: 6 };
  const connection = await rememberedConnection(directory);
  const session = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
  // What Pi can reach right now, from its own registry: no runtime is started for it.
  const judge = judgeFor(ctx.modelRegistry?.getAvailable().map(model => ({ provider: model.provider, id: model.id })) ?? [], session);
  let input: z.infer<typeof createInputSchema>;
  try {
    input = createInputSchema.parse({
      task: source.task, mode: source.mode ?? 'live', workflow: 'evaluate', materials: source.materials, scenarioCount: libraryImport ? 0 : count,
      target: connection?.target ?? { kind: 'unconnected' }, ...(connection?.targetVersion ? { targetVersion: connection.targetVersion } : {}),
      // The import is what the preparation reads; no older projection of it gates what the import accepted.
      ...(libraryImport ? { originalImport: libraryImport } : {}),
      ...(source.fromAnalysis ? { fromAnalysis: source.fromAnalysis.link } : {}),
      settings: settingsSchema.parse({ provider: ctx.model?.provider ?? '', model: ctx.model?.id ?? '', judge, ...run, userModes: ['reactive'],
        maxCalls: runLimit(count, run, !!libraryImport), maxDurationMs: runTime(count * run.repeats),
        // A proposal that reads the agent's prompts and articles whole routinely exceeds the two-minute default per call.
        ...(libraryImport ? { timeoutMs: 600_000 } : {}) }),
    });
  } catch (error) { throw plainInputError(error); }

  // The one gate of a paid preparation, asked last: a request that cannot start never asks the owner for money.
  requireInteractive(ctx, 'Подготовка ситуаций тратит вызовы модели: согласие на расход даёте вы в интерактивном терминале Pi. Откройте Agent Lab там (agent-lab chat) и повторите просьбу. Ничего не потрачено.');
  // No conversation fits: the refusal is the engine's own, told as it is — the unknown roles were asked above.
  const consent = libraryImport ? await preparationConsent(host.reading(directory).store, { input, situations: count })
    .catch(error => { throw error instanceof NothingFits ? new Error(error.message) : error; }) : undefined;
  // The ceiling the owner agrees to is the one the preparation stops at: it goes to the lab with the consent.
  const callCeiling = consent?.callCeiling ?? preparationCeiling({ task: input.task, sources: materialSources(input.materials), situations: count, fromLogs: false });
  const plan = consent ? consentText(consent, source.logsName ?? 'логов') : rulesConsentText(count, callCeiling, isRunnable(input.target));
  const agent = connection ? `Агент: ${targetLabel(connection.target, ctx.cwd)}.`
    : found?.agents[0] ? `Агента Lab подключит перед прогоном — в папке нашёл: ${targetLabel(found.agents[0].target, found.root)}.` : 'Как запускать агента, Lab спросит перед прогоном.';
  const lines = [...(source.fromAnalysis ? [source.fromAnalysis.line] : []), ...plan.lines,
    `Правила: ${source.rules.slice(0, 4).join(', ')}${source.rules.length > 4 ? ` и ещё ${source.rules.length - 4}` : ''} — ${countText(input.materials.length, DOCUMENTS)}.`, agent];
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
