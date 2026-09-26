import { resolve } from 'node:path';
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { runnableTarget, type Experiment, type RunnableTarget } from '../src/contracts.js';
import { isRunning } from '../src/phases.js';
import { resolveTarget } from '../src/connection.js';
import { situationNumber, situationViews } from '../src/card/view.js';
import type { ExperimentLab } from '../src/experiment.js';
import { countText } from '../src/plural.js';
import { expectationSheet, testPlanLines } from '../src/quality.js';
import { plannedTrials } from '../src/run.js';
import { libraryHash } from '../src/scenario-library.js';
import { sameTargetVersion } from '../src/target-version.js';
import { safeText } from '../src/text.js';
import { agentLine } from '../src/workspace.js';
import { ProgressRow, RUN_MESSAGE, runAnswer, STOP_HINT, type Background, type VerdictOutput } from './background.ts';
import { progressText, row, runStamp, runWhen, stoppedLines } from './conversation.ts';
import { ask, displayFor, NeedsOwner, requireInteractive } from './lab-ui.ts';
import { cardPlan, launchRun, type LaunchAgent } from './launch.ts';
import { followRecord, type LabLease, type SessionOperations } from './operations.ts';
import { projectPath } from './prepare-tool.ts';
import { recordFor } from './records.ts';
import type { Feed } from './render/feed.ts';
import { TOOL } from './steps.ts';

/*
 * Starting, accepting, following and stopping a run (docs/design/ui-spec.md §4.6). One native dialog starts a run — it accepts a
 * card draft's ready situations and connects the agent in the same dialog —; a finished run is run again as a repeat
 * of its accepted set; a long run continues in the session and its result arrives as a message. Nothing here starts
 * a run, spends or connects an agent without the owner's pick in that dialog.
 */

export interface RunHost {
  inlineRunMs: number;
  operations: SessionOperations;
  open: (cwd: string, pendingCheck?: 'cancel' | 'wait') => Promise<LabLease>;
  reading: (directory: string) => ExperimentLab;
  background: Background;
  feedResult: (callId: string, output: unknown, feed: Feed, note: string) => AgentToolResult<unknown>;
  askOwner: (callId: string, error: unknown) => AgentToolResult<unknown>;
  verdictOutput: VerdictOutput;
}

const SITUATIONS: [string, string, string] = ['ситуация', 'ситуации', 'ситуаций'];
const CONVERSATIONS: [string, string, string] = ['разговор', 'разговора', 'разговоров'];
const closed = { additionalProperties: false } as const;

const runParameters = Type.Object({
  action: Type.Optional(Type.Enum(['start', 'accept', 'progress', 'stop'], { description: 'start (default), accept without running, progress, stop.' })),
  run: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'The draft or run id from an earlier Agent Lab result. Omit for the one the project works on now; a finished run is run again as a repeat.' })),
  situations: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 999 }), { minItems: 1, maxItems: 40, description: 'Numbers of the situations of a finished run to run again; omit for the whole set.' })),
  agent: Type.Optional(Type.Object({
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: 'The command that starts the agent, e.g. «python3» or «.venv/bin/python».' })),
    args: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 50, description: 'Its arguments, e.g. ["agent.py"].' })),
    cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: 'The folder the command runs in.' })),
    module: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: 'A JavaScript module file that exports createSession.' })),
    factory: Type.Optional(Type.String({ pattern: '^[A-Za-z_$][A-Za-z0-9_$]{0,99}$', description: 'The module\'s exported function that creates a session, when it is not createSession.' })),
    url: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: 'The http address of the agent.' })),
    folder: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: 'The agent\'s project folder: Lab looks there and proposes how to start it.' })),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: 'How long one reply of the agent may take, when the owner said.' })),
    version: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'The owner\'s name for this version of the agent.' })),
  }, { ...closed, description: 'How the owner said to start the agent: command (with args, cwd), module, url, or folder to look in. Only when the owner said it.' })),
}, closed);
type AgentRequest = NonNullable<Static<typeof runParameters>['agent']>;

/**
 * The connection described in the chat, in the form a run takes; paths are the project's or the owner's home. The
 * model wrote it, whatever the owner said: the run dialog shows the command and says the model proposed it.
 */
function agentOf(request: AgentRequest | undefined, cwd: string): LaunchAgent & { folder?: string } {
  if (!request) return {};
  const ways = [request.command, request.module, request.url, request.folder].filter(item => item !== undefined).length;
  if (ways !== 1) throw new NeedsOwner('needs_owner_input', 'В agent нужен ровно один способ: command (с args), module, url или folder. Спросите владельца, как запускать агента.', [],
    'Как запускать агента — команда, файл модуля, адрес или папка проекта?');
  const timeout = request.timeoutSeconds ? { timeoutMs: request.timeoutSeconds * 1000 } : {};
  const version = request.version ? { version: request.version } : {};
  if (request.folder) return { folder: projectPath(request.folder, cwd), ...version };
  const at = (named: string) => projectPath(named, cwd);
  const raw = request.url ? { kind: 'http', url: request.url, ...timeout }
    : request.module ? { kind: 'module', path: at(request.module), ...(request.factory ? { exportName: request.factory } : {}), ...timeout }
    : { kind: 'command', command: request.command!.includes('/') ? at(request.command!) : request.command!, args: request.args ?? [], cwd: request.cwd ? at(request.cwd) : cwd, ...timeout };
  let target: RunnableTarget;
  try { target = runnableTarget(resolveTarget(raw, cwd)); }
  catch (error) { throw new NeedsOwner('needs_owner_input', `Так агента не запустить: ${error instanceof Error ? error.message : String(error)} Уточните у владельца.`, [], 'Так агента не запустить — как его запускать?'); }
  return { target, ...version, proposed: 'model' };
}

export function registerRunTool(pi: Pick<ExtensionAPI, 'registerTool'>, host: RunHost): void {
  pi.registerTool({
    ...displayFor(TOOL.run), name: TOOL.run, label: 'Run the situations',
    description: 'start (default): runs the ready situations of the draft — or runs a finished run\'s set again (situations: some of them) — after one native dialog with the plan: situations and conversations, the agent, the judge\'s ceiling, the comparison with production logs and its cost, the time limit; the ready situations are accepted in that same dialog. When the agent is not connected, Lab proposes what it found in the project folder; agent: only how the owner said to start it (a command, a module, an address, or a folder to look in). accept: accept the ready situations without running, only when the owner asks. progress / stop: the work going on in this session; stop only when the owner asks. A long run continues in the background and its result arrives as a message: say so in one sentence and do not poll.',
    parameters: runParameters,
    executionMode: 'sequential',
    async execute(callId, params, toolSignal, onUpdate, ctx) {
      const directory = resolve(ctx.cwd, '.agent-lab');
      try {
        const action = params.action ?? 'start';
        if (action === 'progress') return await progress(host, callId, ctx, params.run);
        if (action === 'stop') return await stop(host, callId, ctx, params.run);
        requireInteractive(ctx, action === 'accept' ? 'Ситуации утверждаете вы — в интерактивном терминале Pi: откройте Agent Lab там (agent-lab chat) и повторите просьбу. Ничего не утверждено.'
          : 'Запуск подтверждаете вы — в интерактивном терминале Pi: откройте Agent Lab там (agent-lab chat) и повторите просьбу. Агент не запускался, ничего не потрачено.');
        const found = recordFor(await host.reading(directory).list(), params.run, 'situations');
        if (action === 'accept') return await accept(host, callId, ctx, found);
        const signal = AbortSignal.any([toolSignal, ctx.signal].filter((item): item is AbortSignal => !!item));
        signal.throwIfAborted();
        return await start(host, callId, ctx, signal, onUpdate, found, params.situations, agentOf(params.agent, ctx.cwd));
      } catch (error) { return host.askOwner(callId, error); }
    },
  });
}

/** Accepting the ready situations without a run: the owner's native confirmation; nothing runs and no model is called. */
async function accept(host: RunHost, callId: string, ctx: ExtensionContext, found: Experiment): Promise<AgentToolResult<unknown>> {
  const { lab, close } = await host.open(ctx.cwd);
  try {
    await lab.init();
    const record = await lab.get(found.id);
    const note = `Утверждение · ${runStamp(record)}`;
    if (record.librarySnapshot?.formatVersion === 2 && record.phase === 'review' && !record.trials.length) {
      const context = await lab.cardContext(record.id);
      const views = situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns });
      const ready = views.filter(view => view.status === 'ready');
      if (!ready.length) throw new NeedsOwner('needs_owner_input', 'Утверждать нечего: ни одна ситуация не готова. Покажите владельцу вопросы по ситуациям (agent_lab_decide).', [], 'Утверждать нечего: ни одна ситуация ещё не готова.');
      const plan = cardPlan(context.experiment, views);
      if (!await ask(ctx, `Утвердить ${countText(ready.length, ['ситуацию', 'ситуации', 'ситуаций'])} для прогона?`,
        [...ready.map(view => `${view.number}  ${view.brief.title}`), '', 'Агент сейчас не запускается; запуск — отдельно.'], 'Утвердить')) {
        return host.feedResult(callId, { run: record.id, accepted: false, instruction: 'The owner did not accept. Nothing changed.' }, { tone: 'warning', rows: [row('Не утверждено; агент не запускался.')] }, note);
      }
      await lab.acceptCards(record.id, libraryHash(context.library), ready.map(view => view.id));
      return host.feedResult(callId, { run: record.id, accepted: true, situations: ready.map(view => view.number) },
        { rows: [row(`Утверждено ${countText(ready.length, SITUATIONS)}; агент не запускался.`, 'text', true),
          row(`Прогон: ${countText(plan.conversations, CONVERSATIONS)} — скажите «запусти».`, 'muted')] }, note);
    }
    if (record.phase !== 'review' || record.librarySnapshot) throw new NeedsOwner('needs_owner_input', 'Утверждать нечего: это не черновик, который ждёт утверждения.', [], 'Утверждать нечего: эти ситуации уже утверждены или уже запускались.');
    // A record made before libraries: a set of more than one situation is confirmed as one sheet; one test keeps its own definition.
    const sheet = record.scenarios.length > 1 ? expectationSheet(record) : undefined;
    const projection = sheet ? undefined : testPlanLines(record);
    const hash = sheet?.draftHash ?? projection!.draftHash;
    const confirmed = sheet ? await ask(ctx, `Подтвердить ожидания: ${sheet.countText}?`, sheet.compactLines(), 'Подтвердить все')
      : await ask(ctx, projection!.lines.at(-1)!, projection!.lines.slice(0, -2), 'Подтвердить');
    if (!confirmed) return host.feedResult(callId, { run: record.id, accepted: false, instruction: 'The expectations are not confirmed; the run will not start until they are.' },
      { tone: 'warning', rows: [row('Ожидания не подтверждены; агент не запускался.')] }, note);
    await lab.acceptDraft(record.id, hash);
    return host.feedResult(callId, { run: record.id, accepted: true },
      { rows: [row(`Ожидания подтверждены${sheet ? `: ${sheet.countText}` : ''}; агент не запускался — скажите «запусти».`, 'text', true)] }, note);
  } finally { await close(); }
}

/** One dialog, then the run: a short one ends in this row, a long one continues in the session and reports as a message. */
async function start(host: RunHost, callId: string, ctx: ExtensionContext, signal: AbortSignal, onUpdate: ((update: AgentToolResult<unknown>) => void) | undefined,
  found: Experiment, numbers: number[] | undefined, agent: LaunchAgent & { folder?: string }): Promise<AgentToolResult<unknown>> {
  const owned = await host.open(ctx.cwd, 'wait');
  let detached = false;
  let unfollow: (() => void) | undefined;
  const progressRow = new ProgressRow(ctx, RUN_MESSAGE);
  try {
    await owned.lab.init();
    let draft = await owned.lab.get(found.id);
    if (isRunning(draft.phase)) throw new Error(draft.phase === 'preparing' ? 'Ситуации ещё готовятся: запуск — после подготовки.'
      : draft.phase === 'checking' ? 'Ситуации сейчас проверяются: запуск — после проверки.' : 'Этот прогон уже идёт.');
    let note = `Запуск · ${runStamp(draft)}`;
    // A run that started is never run again in place: its accepted set goes into a fresh draft, the agent as it is now —
    // previewed, and written only when the owner says «Запустить».
    if (draft.reviewedAt || draft.trials.length) {
      const ids = numbers?.map(number => {
        const scenario = draft.scenarios.find((item, index) => situationNumber(draft, item.id, index + 1) === number);
        if (!scenario) throw new NeedsOwner('unknown_reference', `Ситуации №${number} в этом прогоне нет. Есть: ${draft.scenarios.map((item, index) => situationNumber(draft, item.id, index + 1)).join(', ')}.`, [],
          `Ситуации ${number} в этом прогоне нет — какие повторить?`);
        return scenario.id;
      });
      const source = draft;
      draft = await owned.lab.repeat(source.id, ids, undefined, { preview: true });
      note = `Повтор · ${runStamp(draft)}`;
      const moved = !!source.targetFingerprint && !!draft.targetFingerprint && !sameTargetVersion(source.targetFingerprint, draft.targetFingerprint);
      if (moved) agent = { ...agent, note: agent.note ?? 'Код агента изменился с прошлого прогона — проверяется новая версия.' };
    } else if (draft.phase !== 'review') {
      throw new NeedsOwner('needs_owner_input', 'Подготовка ситуаций не завершилась: запускать пока нечего. Её можно продолжить с сохранённого места — решение в agent_lab_decide.', [],
        'Подготовка ситуаций не завершилась — запускать пока нечего. Продолжить её?');
    } else if (numbers) throw new NeedsOwner('needs_owner_input', 'Номера ситуаций нужны только для повтора прогона; черновик запускается готовыми ситуациями.', [], 'Запускаются все готовые ситуации черновика.');
    // Nothing has started yet: an Esc before the dialog ends the action.
    signal.throwIfAborted();
    const started = await launchRun(ctx, owned.lab, draft, agent, agent.folder ?? ctx.cwd);
    if (!started) return host.feedResult(callId, { run: found.id, cancelled: true, instruction: 'The owner did not start the run. Nothing was written: the situations are kept as they were; do not ask to start again unless the owner does.' },
      { tone: 'warning', rows: [row('Не запускаю: вы отказались. Ситуации сохранены, агент не запускался.')] }, note);
    // The run has started: from here an Esc, even one pressed while it was starting, hands it to the session.
    // Its row and the row above the input are redrawn from the live record at each change the run reports.
    let shown = '';
    unfollow = followRecord(owned.lab, draft.id, current => {
      const text = progressText(current);
      progressRow.show(text);
      if (text !== shown) { shown = text; onUpdate?.({ content: [{ type: 'text', text: safeText(text) }], details: { id: current.id } }); }
    });
    // A short run ends in this row. A long one, or Esc, hands the run to the session: interrupting the action never stops the run.
    const inline = await new Promise<boolean>(settle => {
      const wait = setTimeout(() => settle(false), host.inlineRunMs);
      const onAbort = () => settle(false);
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      void owned.lab.waitForIdle().then(() => settle(true), () => settle(true)).finally(() => { clearTimeout(wait); signal.removeEventListener('abort', onAbort); });
    });
    unfollow(); unfollow = undefined; progressRow.clear();
    if (!inline) {
      const record = await owned.lab.get(draft.id);
      detached = true;
      host.background.detach(ctx, owned, draft.id, 'chat');
      return host.feedResult(callId, { run: draft.id, background: true, conversations: plannedTrials(record),
        instruction: 'The run continues in the background and its result arrives as a message. Tell the owner in one short sentence and end your turn; do not poll. Reads still work; changes and new runs wait until it ends.' },
        { rows: [row(`Прогон идёт: ${countText(plannedTrials(record), CONVERSATIONS)} с агентом ${agentLine(record, ctx.cwd)}. Результат придёт сюда сообщением.`, 'text', true),
          row(`Разговор свободен; ${STOP_HINT}.`, 'muted')] }, `Прогон · ${runStamp(record)}`);
    }
    // The same answer as a run that ends in the background: its result — drawn from the remembered view, the session
    // holds ids only (REV-01) — or what cut it short and what was saved.
    const { output, details } = await runAnswer(await owned.lab.get(draft.id), owned.lab, host.verdictOutput);
    return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], details };
  } finally {
    unfollow?.();
    if (!detached) { progressRow.clear(); await owned.close(); }
  }
}

/** How the work of this session goes, from the stored record; a named run is answered about that run. */
async function progress(host: RunHost, callId: string, ctx: ExtensionContext, id: string | undefined): Promise<AgentToolResult<unknown>> {
  const directory = resolve(ctx.cwd, '.agent-lab');
  const job = host.operations.current(directory);
  const named = id ? recordFor(await host.reading(directory).list(), id, 'situations') : undefined;
  const record = job && (!named || named.id === job.id) ? await job.lab.get(job.id) : named ?? recordFor(await host.reading(directory).list(), undefined, 'situations');
  const running = isRunning(record.phase);
  const note = `Прогресс · ${runStamp(record)}`;
  if (job?.kind === 'assessment' && job.id === record.id) return host.feedResult(callId, { run: record.id, working: 'check', instruction: 'A check of changed situations is going on; its result arrives as a message. Do not poll.' },
    { rows: [row('Проверяю изменённые ситуации в фоне; итог придёт сообщением.', 'text', true)] }, note);
  const feed: Feed = { rows: running ? [row(progressText(record), 'text', true), row(`Идёт в фоне; ${STOP_HINT}.`, 'muted')]
    : [row(`Сейчас ничего не идёт: ${runWhen(record)} — ${['interrupted', 'error', 'cancelled'].includes(record.phase) ? 'остановлен до результата' : record.trials.length ? 'прогон завершён' : 'черновик'}.`, 'muted')] };
  // A check of situations has a phase of its own (phases.ts): it is neither a preparation nor a run.
  const working = record.phase === 'preparing' ? 'preparation' : record.phase === 'checking' ? 'check' : running ? 'run' : null;
  return host.feedResult(callId, { run: record.id, running, working, inThisSession: !!job && job.id === record.id,
    // A preparation stops at the ceiling its consent stated; the draft's limit is the run's budget, so only a run names it.
    ...(working === 'preparation' || working === 'check' ? {} : { finished: record.trials.length, planned: plannedTrials(record), callLimit: record.settings.maxCalls }), calls: record.usage.calls }, feed, note);
}

/** Stops the work of this session — only the work that is going on — and says what was kept. */
async function stop(host: RunHost, callId: string, ctx: ExtensionContext, id: string | undefined): Promise<AgentToolResult<unknown>> {
  const directory = resolve(ctx.cwd, '.agent-lab');
  const job = host.operations.current(directory);
  if (!job) {
    // Work of a process that is gone reads as interrupted (store.ts): only work that is really going on is another session's.
    const elsewhere = (await host.reading(directory).list()).some(record => isRunning(record.phase));
    throw new Error(elsewhere ? 'В этой сессии ничего не идёт: ни прогона, ни подготовки, ни проверки. Работу другой сессии Pi останавливают там.'
      : 'Сейчас ничего не идёт — останавливать нечего.');
  }
  const going = job.kind === 'assessment' ? 'проверка ситуаций' : job.kind === 'preparation' ? 'подготовка ситуаций' : 'прогон';
  // The run the owner named must be the one that is going: another run is never stopped in its place.
  if (id) {
    const named = recordFor(await host.reading(directory).list(), id, 'situations');
    if (named.id !== job.id) throw new NeedsOwner('needs_owner_input', `Назван прогон ${runWhen(named)}, а сейчас идёт ${going} ${runWhen(await host.reading(directory).get(job.id))}. Ничего не остановлено. Спросите владельца, останавливать ли идущую работу.`, [],
      `Вы назвали прогон ${runWhen(named)}, а сейчас идёт ${going}. Я ничего не остановил — остановить её?`);
  }
  await host.operations.stop(job);
  const record = await host.reading(directory).get(job.id);
  const note = `Остановлено · ${runStamp(record)}`;
  if (job.kind === 'assessment') {
    const message = 'Проверка ситуаций остановлена. Правки и уже проверенное сохранены; остальное можно проверить позже.';
    return host.feedResult(callId, { run: record.id, stopped: true, message }, { tone: 'warning', rows: [row(message)] }, note);
  }
  if (job.kind === 'preparation') {
    const cards = record.librarySnapshot?.formatVersion === 2 ? record.librarySnapshot.cards.length : 0;
    const saved = [record.error ? 'Подготовка остановлена.' : 'Подготовка успела завершиться до остановки.',
      cards ? `Сохранено ${countText(cards, SITUATIONS)}: их можно смотреть и менять, подготовку — продолжить с того же места.` : 'Ситуации собрать не успели; записанное сохранено.'];
    return host.feedResult(callId, { run: record.id, stopped: true, savedSituations: cards, message: saved.join(' ') },
      { tone: 'warning', rows: [row(saved[0]!, 'text', true), row(saved[1]!, 'muted')] }, note);
  }
  const lines = stoppedLines(record);
  return host.feedResult(callId, { run: record.id, stopped: true, saved: record.trials.length, planned: plannedTrials(record), message: lines.join(' ') },
    { tone: 'warning', rows: [row(lines[0]!, 'text', true), row(lines[1]!, 'muted')] }, note);
}
