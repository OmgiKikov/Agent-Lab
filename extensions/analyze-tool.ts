import { basename, resolve } from 'node:path';
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { judgeFor, settingsSchema } from '../src/contracts.js';
import { demoAnalysisInput } from '../src/demo.js';
import { analysisConsentText, continuationConsentText } from '../src/discover/consent.js';
import { ANALYSIS_LIMIT, DEFAULT_ANALYSED, toolNameSchema, type LogAnalysis } from '../src/discover/schema.js';
import { conversationLines, exampleLine, problemTitle, reviewWord } from '../src/discover/text.js';
import { analysisView } from '../src/discover/view.js';
import type { AnalyzeInput, ContinueInput } from '../src/lab/discover.js';
import { countText } from '../src/plural.js';
import { clip, safeText } from '../src/text.js';
import { analysisAnswer, exampleAt } from './analysis-output.ts';
import { STOP_HINT } from './background.ts';
import { row } from './conversation.ts';
import type { LabHost } from './host.ts';
import { ask, displayFor, isInteractive, NeedsOwner, requireInteractive } from './lab-ui.ts';
import { followAnalysis } from './operations.ts';
import { declined, endedEarly, ownerInputs, shownPath } from './owner-inputs.ts';
import { prepareParameters } from './prepare-tool.ts';
import { TOOL } from './steps.ts';

/*
 * «Найди ошибки в этих логах» (DISCOVER): the owner's rules put to the logged conversations — what the agent did with real
 * customers, where it broke a rule, how often among the conversations it was checked on, verbatim. No situation is made,
 * no agent is connected or started, no customer is simulated: an analysis needs only the logs and the rules. Lab finds
 * the logs and the rules as a preparation does (owner-inputs.ts), asks one native consent with the ceiling, and runs the
 * analysis in the background; the owner's word on a finding is asked natively too — the model never passes it.
 */

const DOCUMENTS: [string, string, string] = ['документ', 'документа', 'документов'];
const closed = { additionalProperties: false } as const;
const { task, logs, materials, prompts, rules, table } = prepareParameters.properties;

export const analyzeParameters = Type.Object({
  task, logs, materials, prompts, rules, table,
  conversations: Type.Optional(Type.Integer({ minimum: 1, maximum: ANALYSIS_LIMIT, description: `How many conversations to judge at most, only when the owner named a number: ${DEFAULT_ANALYSED} by default. With analysis and more: how many more.` })),
  recordedTools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 50, description: 'The tools whose every call the log records, only when the owner said so or the log\'s format documents it; the host asks the owner natively to confirm, and without that a missing call is never counted as a violation.' })),
  analysis: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'An analysis id from an earlier answer, or "latest": shows it again; nothing is spent.' })),
  more: Type.Optional(Type.Literal(true, { description: 'With analysis: continue it with the next conversations not selected before (conversations says how many); the host asks the owner natively for the ceiling; findings already made are not paid for again.' })),
  review: Type.Optional(Type.Object({ problem: Type.Integer({ minimum: 1 }), example: Type.Optional(Type.Integer({ minimum: 1 })) },
    { ...closed, description: 'With analysis: the example the owner wants to judge themselves, by the numbers of the answer (example "1.2" is problem 1, example 2). The host asks the owner natively whether the judge is right; you never pass the verdict.' })),
  stop: Type.Optional(Type.Literal(true, { description: 'Only when the owner asks to stop the analysis going on: what it found is kept.' })),
  demo: Type.Optional(Type.Literal(true, { description: 'The teaching example\'s logs: no model, no keys, a few seconds.' })),
}, closed);
type AnalyzeParams = { task?: string; logs?: string; materials?: string[]; prompts?: string[]; rules?: string; table?: Parameters<typeof ownerInputs>[4]['table'];
  conversations?: number; recordedTools?: string[]; analysis?: string; more?: true; review?: { problem: number; example?: number }; stop?: true; demo?: true };

type Host = Pick<LabHost, 'operations' | 'open' | 'reading' | 'background' | 'feedResult' | 'askOwner' | 'inlineBuildMs'>;

export function registerAnalyzeTool(pi: Pick<ExtensionAPI, 'registerTool'>, host: Host): void {
  pi.registerTool({
    ...displayFor(TOOL.analyze), name: TOOL.analyze, label: 'Find errors in logs',
    description: 'Finds the agent\'s errors in logged conversations (JSON, JSONL, XLSX, CSV) against the owner\'s rules: which rule it broke, in how many of the conversations the rule was checked on, verbatim quotes. '
      + 'Use it when the owner asks to find errors or problems in logs, records or real conversations («найди ошибки в логах», «что не так в разговорах»). It makes no situations, needs no connected agent and simulates no customer; '
      + 'testing how a version of the agent behaves is agent_lab_prepare and agent_lab_run instead. Lab finds the logs and the rules in the project when they are not named, like agent_lab_prepare. '
      + 'The host asks the owner natively how to read a spreadsheet and for one consent with the spending ceiling; you never pass settings or a consent. A long analysis continues in the background and its findings '
      + 'arrive as a message: tell the owner in one sentence and do not poll. analysis: shows an earlier one; with review {problem, example}: the host asks the owner whether the judge is right about that example.',
    parameters: analyzeParameters,
    executionMode: 'sequential',
    async execute(callId, params: AnalyzeParams, toolSignal, onUpdate, ctx) {
      const signal = AbortSignal.any([toolSignal, ctx.signal].filter((item): item is AbortSignal => !!item));
      signal.throwIfAborted();
      const directory = resolve(ctx.cwd, '.agent-lab');
      try {
        if (params.stop) return await stop(host, callId, directory);
        if (params.analysis && !params.more) return params.review ? await review(host, callId, ctx, directory, params.analysis, params.review) : await show(host, callId, directory, params.analysis);
        const busy = host.operations.busy(directory);
        if (busy) throw new Error(busy);
        if (params.analysis) return await continueOne(host, callId, ctx, signal, onUpdate, directory, params.analysis, params.conversations);
        if (params.demo) return await start(host, callId, ctx, signal, onUpdate, { input: demoAnalysisInput() }, []);
        return await fromOwner(host, callId, ctx, signal, onUpdate, params, directory);
      } catch (error) { return host.askOwner(callId, error); }
    },
  });
}

/** The analysis `named` — an id, or «latest» — as it is now. */
async function analysisNamed(host: Host, directory: string, named: string): Promise<LogAnalysis> {
  const reader = host.reading(directory);
  if (named !== 'latest') return reader.getAnalysis(named);
  const latest = (await reader.listAnalyses())[0];
  if (!latest) throw new NeedsOwner('unknown_reference', 'В этом проекте ещё нет ни одного разбора логов. Предложите владельцу разобрать логи.', [], 'Разборов логов ещё нет — разобрать логи?');
  return latest;
}

async function show(host: Host, callId: string, directory: string, named: string): Promise<AgentToolResult<unknown>> {
  const reader = host.reading(directory);
  const answer = await analysisAnswer(reader, await analysisNamed(host, directory, named));
  return host.feedResult(callId, answer.output, answer.feed, answer.note);
}

/** The owner's own word on one example: asked natively, with the violation, the rule and what was said; a dispute needs its reason. */
async function review(host: Host, callId: string, ctx: ExtensionContext, directory: string, named: string, place: { problem: number; example?: number }): Promise<AgentToolResult<unknown>> {
  requireInteractive(ctx, 'Прав ли судья, решаете вы в интерактивном терминале Pi: откройте Agent Lab там (agent-lab chat). Ничего не записано.');
  const analysis = await analysisNamed(host, directory, named);
  const view = analysisView(analysis, await host.reading(directory).store.readImport(analysis.logs.importId).catch(() => undefined));
  const found = exampleAt(view, place);
  const name = `${place.problem}.${place.example ?? 1}`;
  if (!found) {
    const known = view.problems.flatMap((problem, index) => problem.examples.map((_, at) => `${index + 1}.${at + 1}`));
    throw new NeedsOwner('unknown_reference', `В разборе нет примера ${name}.${known.length ? ` Есть: ${known.join(', ')}.` : ' Нарушений в нём нет.'} Спросите владельца, какой он имеет в виду.`, known,
      `Примера ${name} в разборе нет — какой открыть?`);
  }
  const { problem, example } = found;
  // The whole source conversation, every message as the log holds it: a summary of the evidence never stands in for it.
  const batch = await host.reading(directory).store.readImport(analysis.logs.importId).catch(() => undefined);
  const dialogue = batch?.dialogues.find(item => item.id === example.dialogueId);
  const body = [`Судья: ${problemTitle(problem)}.`,
    ...(problem.knowledgeOnly ? ['Основание — статья базы знаний. Решите для этого обращения: какие сведения агент обязан сообщить и допустима ли передача оператору?'] : []),
    ...problem.rules.slice(0, 2).map(rule => `Правило: «${clip(rule.quote, 300)}» — ${rule.source}.`), exampleLine(example),
    ...(example.rationale ? [`Почему, по словам судьи: ${clip(example.rationale, 500)}`] : []),
    ...(example.review ? [`Ваша отметка сейчас: ${reviewWord(example.review)}.`] : []),
    '', `Разговор ${example.dialogueId} целиком:`, ...(dialogue ? conversationLines(dialogue, example.quotes.map(quote => quote.seq)) : ['— его нет в логах этого разбора.'])];
  const answers = ['Да, это нарушение', 'Нет, это не нарушение', 'Не знаю', 'Не сейчас'] as const;
  const picked = await ctx.ui.select(safeText([problem.knowledgeOnly ? 'Здесь есть нарушение?' : 'Прав ли судья?', '', ...body].join('\n')), [...answers]);
  const verdict = picked === answers[0] ? 'confirmed' : picked === answers[1] ? 'disputed' : picked === answers[2] ? 'unsure' : undefined;
  if (!verdict) return declined(host, callId, 'Отметка не записана: вы не ответили. Ничего не изменено.', 'analyze');
  const note = verdict === 'disputed' ? (await ctx.ui.editor('Почему это не нарушение? Коротко, своими словами.', ''))?.trim() ?? '' : '';
  if (verdict === 'disputed' && !note) return declined(host, callId, 'Отметка не записана: оспорить можно только с причиной. Ничего не изменено.', 'analyze');
  const owned = await host.open(ctx.cwd);
  let updated: LogAnalysis;
  try { await owned.lab.init(); updated = await owned.lab.reviewFinding(analysis.id, { key: example.key, verdict, note, via: 'pi-confirm' }); }
  finally { await owned.close(); }
  const answer = await analysisAnswer(host.reading(directory), updated);
  const said = verdict === 'confirmed' ? 'Записано: вы подтвердили нарушение.' : verdict === 'disputed' ? 'Записано: вы оспорили вывод судьи — это нарушение больше не считается.' : 'Записано: вы не уверены — остаётся вывод судьи.';
  return host.feedResult(callId, { ...answer.output, reviewed: { example: name, verdict }, instruction: 'The owner\'s word is recorded beside the judge\'s. Tell them in one sentence; do not repeat the whole analysis.' },
    { rows: [row(said, 'text', true), ...answer.feed.rows.slice(0, 1)] }, answer.note);
}

async function stop(host: Host, callId: string, directory: string): Promise<AgentToolResult<unknown>> {
  const job = host.operations.current(directory);
  if (job?.kind !== 'analysis') return host.feedResult(callId, { stopped: false, instruction: 'No analysis is going on in this session.' }, { rows: [row('Сейчас разбор логов не идёт.', 'muted')] }, 'Разбор логов');
  await host.operations.stop(job);
  const answer = await analysisAnswer(host.reading(directory), await host.reading(directory).getAnalysis(job.id));
  return host.feedResult(callId, { ...answer.output, stopped: true }, { ...answer.feed, title: 'Разбор остановлен' }, answer.note);
}

/**
 * The owner's word on what the log records: the tools the model named, confirmed natively — only then does a complete
 * conversation with no call of a required tool count as the action not made. Undefined when none was named or the owner said no.
 */
async function recordedBy(ctx: ExtensionContext, named: readonly string[] | undefined, file: string): Promise<AnalyzeInput['logContract']> {
  const tools = [...new Set((named ?? []).map(tool => tool.trim()).filter(tool => toolNameSchema.safeParse(tool).success))];
  if (!tools.length) return undefined;
  const yes = 'Да, каждый вызов';
  const picked = await ctx.ui.select(safeText([`Лог «${file}» записывает каждый вызов этих инструментов в разговорах, помеченных полными?`, '', tools.join(', '), '',
    'Если да, разговор без вызова инструмента, которого требует правило, — нарушение. Если нет или вы не знаете, Lab скажет «не видно», а не «нарушено».'].join('\n')),
    [yes, 'Нет или не знаю']);
  return picked === yes ? { tools, via: 'pi-confirm' } : undefined;
}

/** A continuation of an analysis: its consent natively — the next conversations, what is reused with no call, the ceiling —, then the work. */
async function continueOne(host: Host, callId: string, ctx: ExtensionContext, signal: AbortSignal, onUpdate: ((update: AgentToolResult<unknown>) => void) | undefined,
  directory: string, named: string, more: number | undefined): Promise<AgentToolResult<unknown>> {
  const earlier = await analysisNamed(host, directory, named);
  const session = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
  const settings = earlier.mode === 'demo' || !session ? undefined
    : settingsSchema.parse({ provider: session.provider, model: session.id, judge: judgeFor(ctx.modelRegistry?.getAvailable().map(model => ({ provider: model.provider, id: model.id })) ?? [], session), timeoutMs: 600_000 });
  if (earlier.mode === 'live' && !settings) throw new Error('В Pi не выбрана модель: выберите её (/model). Ничего не потрачено.');
  const input = { analysisId: earlier.id, ...(more ? { more } : {}), ...(settings ? { settings } : {}) };
  const consent = await host.reading(directory).continuationConsent(input);
  const text = continuationConsentText(consent);
  if (!consent.demo) {
    requireInteractive(ctx, 'Продолжение разбора тратит вызовы модели: согласие даёте вы в интерактивном терминале Pi. Ничего не потрачено.');
    if (!await ask(ctx, text.question, text.lines, 'Продолжить')) return declined(host, callId, 'Не продолжаю: вы отказались. Ничего не потрачено.', 'analyze');
  }
  return start(host, callId, ctx, signal, onUpdate, { continues: input }, [], consent.callCeiling);
}

/** The owner's logs and rules, the consent with the ceiling, then the analysis. */
async function fromOwner(host: Host, callId: string, ctx: ExtensionContext, signal: AbortSignal, onUpdate: ((update: AgentToolResult<unknown>) => void) | undefined,
  params: AnalyzeParams, directory: string): Promise<AgentToolResult<unknown>> {
  const read = await ownerInputs(host, callId, ctx, signal, params, 'analyze');
  if (endedEarly(read)) return read;
  if (!read.libraryImport || read.logs === 'rules') throw new Error('Для разбора нужны логи: файл с записанными разговорами.');
  if (!ctx.model) throw new Error('В Pi не выбрана модель: выберите её (/model) — ею Lab размечает темы и находит правила. Ничего не потрачено.');
  const session = { provider: ctx.model.provider, id: ctx.model.id };
  // What Pi can reach right now, from its own registry: the independent default judge when it can, else the session's model.
  const judge = judgeFor(ctx.modelRegistry?.getAvailable().map(model => ({ provider: model.provider, id: model.id })) ?? [], session);
  requireInteractive(ctx, 'Разбор логов тратит вызовы модели: согласие на расход даёте вы в интерактивном терминале Pi. Откройте Agent Lab там (agent-lab chat) и повторите просьбу. Ничего не потрачено.');
  const logContract = await recordedBy(ctx, params.recordedTools, basename(read.logs));
  const input: AnalyzeInput = { task: params.task!, mode: 'live', materials: read.expanded.materials, logs: read.libraryImport, file: basename(read.logs),
    settings: settingsSchema.parse({ provider: session.provider, model: session.id, judge, timeoutMs: 600_000 }),
    ...(params.conversations ? { requested: params.conversations } : {}), ...(logContract ? { logContract } : {}) };
  const consent = await host.reading(directory).analysisConsent(input);
  const text = analysisConsentText(consent, input.file);
  const sources = [...(params.rules ? ['ваши слова из разговора'] : []), ...read.prompts.map(prompt => prompt.id),
    ...[...read.files.promptFiles, ...read.files.materialFiles].map(file => shownPath(file, ctx.cwd))];
  const lines = [...text.lines, `Правила: ${sources.slice(0, 4).join(', ')}${sources.length > 4 ? ` и ещё ${sources.length - 4}` : ''} — ${countText(read.expanded.materials.length, DOCUMENTS)}.`];
  if (!await ask(ctx, text.question, lines, 'Найти ошибки')) return declined(host, callId, 'Не разбираю: вы отказались. Ничего не потрачено.', 'analyze');
  return start(host, callId, ctx, signal, onUpdate, { input }, read.notes, consent.callCeiling);
}

/**
 * The analysis itself. A short one ends in the row of its call; a long one, or Esc, goes to the session the way a long
 * run does: the row above the input follows it and its findings arrive as a message.
 */
async function start(host: Host, callId: string, ctx: ExtensionContext, signal: AbortSignal, onUpdate: ((update: AgentToolResult<unknown>) => void) | undefined,
  work: { input: AnalyzeInput } | { continues: ContinueInput }, notes: string[], ceiling?: number): Promise<AgentToolResult<unknown>> {
  const owned = await host.open(ctx.cwd);
  const { lab, close } = owned;
  const interactive = isInteractive(ctx) && !!ctx.ui;
  let handedOver = false;
  let id: string | undefined;
  let unfollow: (() => void) | undefined;
  const cancel = () => { if (id) void lab.cancelAnalysis(id).catch(() => {}); };
  try {
    await lab.init(); signal.addEventListener('abort', cancel, { once: true }); signal.throwIfAborted();
    if (interactive) signal.removeEventListener('abort', cancel);
    const callCeiling = ceiling ?? ('input' in work ? (await lab.analysisConsent(work.input)).callCeiling : (await lab.continuationConsent(work.continues)).callCeiling);
    id = ('input' in work ? await lab.analyze(work.input, { callCeiling }) : await lab.continueAnalysis(work.continues, { callCeiling })).id;
    if (signal.aborted && !interactive) cancel();
    let last = '';
    unfollow = followAnalysis(lab, id, analysis => {
      const text = safeText(`Разбор логов · ${analysis.message}`);
      if (onUpdate && text !== last) { last = text; onUpdate({ content: [{ type: 'text', text }], details: { id: analysis.id } }); }
    });
    const inline = !interactive ? (await lab.waitForIdle(), true) : await new Promise<boolean>(settle => {
      const wait = setTimeout(() => settle(false), host.inlineBuildMs);
      const onAbort = () => settle(false);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      void lab.waitForIdle().then(() => settle(true), () => settle(true)).finally(() => { clearTimeout(wait); signal.removeEventListener('abort', onAbort); });
    });
    if (!inline) {
      unfollow(); unfollow = undefined;
      handedOver = true;
      host.background.analysis(ctx, owned, id);
      return host.feedResult(callId, { analysis: id, background: true, instruction: 'The analysis continues in the background and its findings arrive as a message. Tell the owner in one short sentence and end your turn; do not poll. Stop it only when the owner asks: agent_lab_analyze stop.' },
        { rows: [row('Разбираю логи в фоне — итог придёт сюда сообщением.', 'text', true), row(`Разговор свободен; ${STOP_HINT}.`, 'muted')] }, 'Разбор логов');
    }
    const answer = await analysisAnswer(lab, await lab.getAnalysis(id));
    return host.feedResult(callId, { ...answer.output, ...(notes.length ? { materials: notes } : {}) }, answer.feed, answer.note);
  } finally { unfollow?.(); signal.removeEventListener('abort', cancel); if (!handedOver) await close(); }
}
