import { resolve } from 'node:path';
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { z } from 'zod';
import { agentSchema, createInputSchema, DEFAULT_JUDGE, dialogueSchema, runnableTargetSchema, SCENARIO_LIMIT, settingsSchema, type Experiment } from '../src/contracts.js';
import { demoInput } from '../src/demo.js';
import { evidenceBundle, exportArtifacts } from '../src/artifacts.js';
import { rememberedConnection, readConnection } from '../src/connection.js';
import { readData, selectValidationDialogues, readDialogueImport, importDialogues } from '../src/imports.js';
import { expandMaterials } from '../src/materials.js';
import { MATERIAL_CHARS, MATERIAL_LIMIT } from '../src/limits.js';
import { consentText, preparationConsent } from '../src/miner/plan.js';
import type { ExperimentLab } from '../src/experiment.js';
import { safeText } from '../src/text.js';
import { progressText, row, runStamp } from './conversation.ts';
import { preparedAnswer, STOP_HINT, type Background, type Prepared } from './background.ts';
import { ask, displayFor, isInteractive, requireInteractive } from './lab-ui.ts';
import type { LabLease } from './operations.ts';
import type { Feed } from './render/feed.ts';
import { summary } from './summary.ts';

/*
 * «Собери ситуации»: logs, materials and the agent become a draft of situations (ui-spec §4.10). From logs the owner
 * first agrees to one consent — what is read, how many situations at most, what is left out and why, the spending
 * ceiling (miner/plan.ts). The agent need not be connected yet: its situations are prepared now, and the connection
 * is asked for right before the run (the owner's decision of 23.09). A short preparation answers in its own row;
 * a long one continues in the session and its situations arrive as a message.
 */

export interface BuildHost {
  inlineBuildMs: number;
  open: (cwd: string) => Promise<LabLease>;
  reading: (directory: string) => ExperimentLab;
  focus: Map<string, string>;
  background: Background;
  feedResult: (callId: string, output: unknown, feed: Feed, note: string) => AgentToolResult<unknown>;
}

/** A schema error in the owner's language: which field and what is wrong, never a raw issue dump. */
function plainInputError(error: unknown): Error {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error : new Error(String(error));
  return new Error(`Не удалось подготовить проверку: ${error.issues.slice(0, 6).map(issue => `${issue.path.join('.') || 'вход'} — ${issue.message}`).join('; ')}. Ничего не запущено и не потрачено.`);
}
/** People and models name files relative to the project; the stored target keeps absolute paths. */
function projectTarget(target: unknown, cwd: string): unknown {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return target;
  const fixed: Record<string, unknown> = { ...target as Record<string, unknown> };
  for (const key of ['path', 'promptFile', 'cwd']) if (typeof fixed[key] === 'string' && fixed[key]) fixed[key] = resolve(cwd, fixed[key] as string);
  return fixed;
}
const unreadable = (error: unknown) => new Error(safeText(`Не удалось прочитать записи: ${error instanceof Error ? error.message : String(error)}. Исправьте JSON/JSONL и повторите команду; агент не запускался.`));

export function registerBuildTool(pi: ExtensionAPI, host: BuildHost): void {
  pi.registerTool({
    ...displayFor('agent_lab_build'),
    name: 'agent_lab_build', label: 'Prepare agent and business-scenario tests',
    description: 'Prepare agent checks. mode=validate selects up to 15 measurable prompt/RAG cases from up to 300 de-identified dialogues, grounds expectations in owner requirements and gives user facts to a reactive simulator; unavailable customer data and masked-only utterances are excluded. It does not run the agent. mode=demo is the built-in example.',
    parameters: Type.Object({
      task: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
      materials: Type.Optional(Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 180 }), content: Type.String({ minLength: 1, maxLength: MATERIAL_CHARS }), kind: Type.Optional(Type.Union([Type.Literal('knowledge'), Type.Literal('prompt')], { description: "'prompt' marks the agent's own system prompt: observable rules are extracted from it and every generated card gets the prompt_compliance rubric" })) }, { additionalProperties: false }), { minItems: 1, maxItems: MATERIAL_LIMIT, description: 'Short materials written inline. For files and folders use materialFiles/promptFiles instead of pasting their text: Lab reads them whole.' })),
      materialFiles: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 50, description: 'Knowledge articles: paths of files (.docx, .md, .txt, .html) or folders, absolute or relative to the project. Lab reads every file itself, verbatim; pass the path the owner named, never a retyped excerpt. Hundreds of articles are fine: for each dialogue the model picks the relevant ones from the table of contents.' })),
      promptFiles: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 20, description: "Files holding the agent's own system prompt(s) (kind 'prompt'), read whole by Lab." })),
      existingAgent: Type.Optional(Type.Unsafe(z.toJSONSchema(agentSchema))),
      settings: Type.Optional(Type.Unsafe(z.toJSONSchema(settingsSchema, { io: 'input' }))),
      scenarioCount: Type.Optional(Type.Integer({ minimum: 0, maximum: SCENARIO_LIMIT })),
      validationCount: Type.Optional(Type.Integer({ minimum: 1, maximum: SCENARIO_LIMIT, description: 'Cards in mode=validate; defaults to 15.' })),
      connectionFile: Type.Optional(Type.String()), dialoguesFile: Type.Optional(Type.String()),
      withoutDialogues: Type.Optional(Type.Boolean({ description: 'Set true only when the user explicitly chose to start without real dialogues. Otherwise ask for optional JSON/JSONL logs before building a live run.' })),
      target: Type.Optional(Type.Unsafe(z.toJSONSchema(runnableTargetSchema, { io: 'input' }))),
      targetVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Agent release, commit or remote deployment version.' })),
      dialogues: Type.Optional(Type.Unsafe(z.toJSONSchema(z.array(z.json()).max(300), { io: 'input' }))),
      mode: Type.Optional(Type.Union([Type.Literal('live'), Type.Literal('demo'), Type.Literal('validate')])),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(callId, params, toolSignal, onUpdate, ctx) {
      const { dialoguesFile, connectionFile, withoutDialogues, materialFiles, promptFiles, validationCount: requestedValidation, ...rest } = params;
      const operation = rest.mode ?? 'live';
      const signal = AbortSignal.any([toolSignal, ctx.signal].filter((s): s is AbortSignal => !!s));
      signal.throwIfAborted();
      const materialNotes: string[] = [];
      if (materialFiles?.length || promptFiles?.length) {
        // Lab reads the owner's files itself: whole articles, no retyping by the model, no per-call item limit.
        const expanded = await expandMaterials({ materials: rest.materials, materialFiles, promptFiles }, ctx.cwd);
        rest.materials = expanded.materials;
        materialNotes.push(`Прочитано из файлов: ${expanded.read}.`);
        for (const item of expanded.skipped.slice(0, 20)) materialNotes.push(`Пропущен ${item.file}: ${item.reason}.`);
        if (expanded.skipped.length > 20) materialNotes.push(`…и ещё ${expanded.skipped.length - 20} пропущенных файлов.`);
      }
      let dialogues: unknown;
      const libraryImport = operation !== 'demo' && (dialoguesFile || rest.dialogues)
        ? dialoguesFile ? await readDialogueImport(resolve(ctx.cwd, dialoguesFile)) : importDialogues(rest.dialogues) : undefined;
      try { dialogues = libraryImport ? libraryImport.dialogues.slice(0, operation === 'validate' ? 300 : 200) : (dialoguesFile ? await readData(resolve(ctx.cwd, dialoguesFile), { maxItems: operation === 'validate' ? 300 : 200 }) : rest.dialogues); }
      catch (error) { if (operation !== 'validate') throw error; throw unreadable(error); }
      let parsedDialogues: z.infer<typeof dialogueSchema>[];
      try { parsedDialogues = z.array(dialogueSchema).max(operation === 'validate' ? 300 : 200).parse(dialogues ?? []); }
      catch (error) { if (operation !== 'validate') throw error; throw unreadable(error); }
      if (operation === 'validate' && !parsedDialogues.length && !libraryImport?.originalImport.dialogues.length) throw new Error('Для validation set укажите JSON/JSONL с обезличенными реальными диалогами.');
      if (operation !== 'demo' && !parsedDialogues.length && !libraryImport?.originalImport.dialogues.length && withoutDialogues !== true) {
        const output = { status: 'needs_input', message: 'Есть реальные диалоги с агентом? Укажите файл JSON/JSONL с обезличенными разговорами или скажите «начать без логов».',
          nextStep: 'Ask the user in ordinary language. Import their supplied dialoguesFile/dialogues, or set withoutDialogues=true after their explicit choice to skip. Do not silently skip or search unrelated logs.' };
        return host.feedResult(callId, output, { tone: 'warning', rows: [row('Есть записи разговоров с агентом? Назовите файл с логами — или скажите «начать без логов».')] }, 'Нужны логи');
      }
      const supplied = (rest.settings ?? {}) as Partial<z.infer<typeof settingsSchema>>;
      const validationCount = operation === 'validate' ? requestedValidation ?? 15 : 0;
      if (operation === 'validate') {
        parsedDialogues = selectValidationDialogues(parsedDialogues, Math.min(40, validationCount * 3));
        if (!parsedDialogues.length && !libraryImport?.originalImport.dialogues.length) throw new Error('В логах нет пригодных диалогов с 1–16 репликами пользователя без полностью замаскированных реплик.');
        requireInteractive(ctx, 'Для сборки ситуаций из логов нужно ваше согласие в интерактивном терминале Pi.');
      }
      const mode = operation === 'demo' ? 'demo' : 'live';
      const connection = mode === 'demo' ? undefined : connectionFile ? await readConnection(resolve(ctx.cwd, connectionFile)) : !rest.target ? await rememberedConnection(resolve(ctx.cwd, '.agent-lab')) : undefined;
      let input: z.infer<typeof createInputSchema>;
      // The built-in example is fixed: its own materials, dialogues and teaching agent. Without a known agent the
      // situations are prepared now and Lab asks how to reach the agent right before the run.
      try { input = mode === 'demo' ? demoInput() : createInputSchema.parse({
        ...rest, target: rest.target ? projectTarget(rest.target, ctx.cwd) : { kind: 'unconnected' }, scenarioCount: operation === 'validate' ? 0 : rest.scenarioCount ?? 1,
        mode, workflow: 'evaluate',
        ...(connection ? { target: connection.target, targetVersion: connection.targetVersion } : {}),
        ...(dialogues !== undefined ? { dialogues: parsedDialogues.slice(0, 200) } : {}),
        ...(libraryImport ? { originalImport: libraryImport.originalImport } : {}),
        settings: { repeats: 1,
          maxCalls: operation === 'validate' ? Math.max(140, 2 * parsedDialogues.length + 19 * validationCount + 20) : 20,
          maxDurationMs: operation === 'validate' ? Math.max(180_000, 180_000 * parsedDialogues.length) : 180_000,
          judge: DEFAULT_JUDGE,
          // Grounding many materials with a small model routinely exceeds the two-minute default per call.
          ...(operation === 'validate' ? { timeoutMs: 600_000 } : {}),
          ...supplied,
          ...(operation === 'validate' ? { maxTurns: 6, userModes: ['reactive'] } : {}),
          provider: supplied.provider || ctx.model?.provider || '', model: supplied.model || ctx.model?.id || '' },
      }); } catch (error) { throw plainInputError(error); }
      // The spending question comes last: a request that cannot start never asks the owner for money.
      if (operation === 'validate' && libraryImport) {
        const consent = await preparationConsent(host.reading(resolve(ctx.cwd, '.agent-lab')).store, { batch: libraryImport.originalImport, settings: input.settings, situations: validationCount });
        const text = consentText(consent, dialoguesFile ? dialoguesFile.split('/').at(-1)! : 'логов');
        if (!await ask(ctx, text.question, text.lines, 'Собрать ситуации')) {
          return host.feedResult(callId, { status: 'cancelled', calls: 0, mutated: false, message: 'The owner declined. Nothing was spent or changed; do not ask again unless they request it.' },
            { tone: 'warning', rows: [row('Не собираю: вы отказались. Ничего не потрачено.')] }, 'Сбор ситуаций отменён');
        }
        return prepare(host, callId, ctx, signal, onUpdate, input, { situations: consent.promised, materialNotes, validation: { sourceDialogues: consent.conversations, usable: consent.usable, promised: consent.promised } });
      }
      return prepare(host, callId, ctx, signal, onUpdate, input, { materialNotes });
    },
  });
}

/**
 * The preparation itself. A short one ends in the row of its call. A long one, or Esc, goes to the session the way a
 * long run does: in the terminal Esc interrupts the action, not the work.
 */
async function prepare(host: BuildHost, callId: string, ctx: ExtensionContext, signal: AbortSignal, onUpdate: ((update: AgentToolResult<unknown>) => void) | undefined,
  input: z.infer<typeof createInputSchema>, options: { situations?: number; materialNotes: string[]; validation?: Record<string, number> }): Promise<AgentToolResult<unknown>> {
  const owned = await host.open(ctx.cwd);
  const { lab, close } = owned;
  // Only a terminal can take a preparation over: the hand-over draws its progress and delivers its result through `ctx.ui` and a message.
  const interactive = isInteractive(ctx) && !!ctx.ui;
  let handedOver = false;
  let id: string | undefined;
  let polling: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastProgress = '';
  const progress = async () => {
    if (!id || !onUpdate) return;
    const text = safeText(progressText(await lab.get(id)));
    if (text !== lastProgress) { lastProgress = text; onUpdate({ content: [{ type: 'text', text }], details: { id } }); }
  };
  const cancel = () => { if (id) void lab.cancel(id).catch(() => {}); };
  try {
    await lab.init(); signal.addEventListener('abort', cancel, { once: true }); signal.throwIfAborted();
    /** The answer of a preparation that has ended — in the row of this call, or as the message of one that outlived it. */
    const prepared = async (record: Experiment, interrupted: boolean): Promise<Prepared> => {
      const bundle = await evidenceBundle(record, lab.store);
      const output = { ...summary(record, lab.store.directory, bundle.view),
        ...(options.validation ? { validation: options.validation } : {}),
        ...(options.materialNotes.length ? { materialsFromFiles: options.materialNotes } : {}),
        artifacts: await exportArtifacts(bundle, lab.store.directory), ...(interrupted ? { cancelled: true } : {}) };
      host.focus.set(lab.store.directory, record.id);
      const situations = await preparedAnswer(lab, record, interrupted);
      return { ...situations, output: { ...situations.output, ...output } };
    };
    if (interactive) signal.removeEventListener('abort', cancel);
    id = (await lab.create(input, options.situations ? { situations: options.situations } : {})).id;
    if (signal.aborted && !interactive) cancel();
    await progress();
    timer = setInterval(() => { polling = polling.then(progress).catch(() => {}); }, 750);
    const inline = !interactive ? (await lab.waitForIdle(), true) : await new Promise<boolean>(settle => {
      const wait = setTimeout(() => settle(false), host.inlineBuildMs);
      const onAbort = () => settle(false);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      void lab.waitForIdle().then(() => settle(true), () => settle(true)).finally(() => { clearTimeout(wait); signal.removeEventListener('abort', onAbort); });
    });
    if (!inline) {
      clearInterval(timer); timer = undefined; await polling;
      const record = await lab.get(id);
      handedOver = true;
      // The record ends with an error exactly when the preparation was cut short: stopped, out of calls or out of time.
      host.background.detach(ctx, owned, id, 'chat', finished => prepared(finished, !!finished.error));
      host.focus.set(lab.store.directory, id);
      return host.feedResult(callId, { id, background: true, phase: record.phase, usage: record.usage, maxCalls: record.settings.maxCalls,
        instruction: 'The preparation continues in the background and its result (the situations) will arrive as a message. Tell the owner in one short sentence and end your turn; do not poll. Reads still work; edits, a new preparation and runs wait until it ends. Stop it only when the owner asks: agent_lab_run action:"stop".' },
        { rows: [row('Готовлю ситуации в фоне — они придут сюда сообщением.', 'text', true), row(`Разговор свободен; ${STOP_HINT}.`, 'muted')] }, `Подготовка · ${runStamp(record)}`);
    }
    await progress();
    const done = await prepared(await lab.get(id), signal.aborted && !interactive);
    return done.feed ? host.feedResult(callId, done.output, done.feed, done.note ?? '')
      : host.feedResult(callId, done.output, { rows: [row('Подготовка завершена.')] }, 'Подготовка');
  } finally { clearInterval(timer); signal.removeEventListener('abort', cancel); await polling; if (!handedOver) await close(); }
}
