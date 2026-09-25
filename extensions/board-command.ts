import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { CardCommand } from '../src/card/schema.js';
import { cardStatuses } from '../src/card/status.js';
import { shownRulebook } from '../src/card/rulebook.js';
import { convertible } from '../src/card/legacy-v1.js';
import { checkCalls } from '../src/card/check-calls.js';
import { situationViews, type SituationAction, type SituationView } from '../src/card/view.js';
import { isRunning } from '../src/phases.js';
import { demoInput } from '../src/demo.js';
import { evidenceBundle, exportArtifacts } from '../src/artifacts.js';
import type { ExperimentLab } from '../src/experiment.js';
import { decisions, type DecisionChoice } from '../src/inbox.js';
import { situationCoverage } from '../src/miner/cards.js';
import { recurringProblems } from '../src/problems.js';
import { accuracyParts } from '../src/result-text.js';
import { buildResultView } from '../src/result-view.js';
import { plannedTrials } from '../src/run.js';
import { agentSpaces, type AgentSpace } from '../src/workspace.js';
import { safeText } from '../src/text.js';
import { progressText, scenarioPlan } from './conversation.ts';
import { applyRulebookChange, applySituationCommand, logsOf, settle, writer, type DecisionSurface } from './decisions.ts';
import type { LabHost } from './host.ts';
import { recordMark } from './judge-review.ts';
import { ask, boardDiscussionContext, inputError, requireInteractive } from './lab-ui.ts';
import { cardPlan, launchRun } from './launch.ts';
import type { SessionOperation } from './operations.ts';
import { newState, showWorkspace, type WorkspaceAction, type WorkspaceChanges, type WorkspaceState, type WorkspaceView } from './workspace.ts';
import type { SpaceData } from './workspace-screens.ts';

/*
 * /agent-lab: the loop that loads the agent's workspace from the store, shows it, takes the owner's action and does
 * it through the same ExperimentLab operations the chat uses. A key press or a pick in a native dialog is the owner's
 * decision; text they type is their own words; what needs words about a new situation, a rule or the connection goes
 * to the conversation. The workspace never holds the only copy of anything.
 */

const WHEN = { 'сразу': 'initial', 'если спросят': 'on_request', 'не знает': 'unknown' } as const;
const WHEN_CHOICES = ['сразу', 'если спросят', 'не знает'] as const;

/** One field of a situation the owner rewrites in their own words, in a native editor. */
async function ownWords(ctx: ExtensionCommandContext, title: string, current: string): Promise<string | undefined> {
  const text = (await ctx.ui.editor(title, current))?.trim();
  return text && text !== current ? text : undefined;
}

/**
 * «Изменить» (docs/design/ui-spec.md §4.5): a native menu of what to change, then the change itself — the customer's words and the
 * duties in the owner's own words, what the customer knows as the owner's pick.
 */
async function editCommand(ctx: ExtensionCommandContext, view: SituationView): Promise<{ command: CardCommand; words?: string } | undefined> {
  const { brief } = view;
  const menu = ['Что клиент пишет', 'Что клиент хочет', 'Что клиент знает и когда скажет', 'Что агент должен', 'Когда клиент уходит'];
  const picked = await ctx.ui.select(`Что изменить в ситуации ${view.number}?`, menu);
  const client = (field: 'writes' | 'wants' | 'leaves', title: string, current: string) => ownWords(ctx, title, current)
    .then(text => text === undefined ? undefined : { command: { kind: 'edit_client', cardId: view.id, [field]: text } as CardCommand, words: text });
  if (picked === menu[0]) return client('writes', 'Первая реплика клиента · дословно', brief.writes);
  if (picked === menu[1]) return client('wants', 'Чего хочет клиент', brief.wants);
  if (picked === menu[4]) return client('leaves', 'Когда клиент уходит', brief.leaves ?? '');
  if (picked === menu[3]) {
    const duties = brief.must.map((duty, index) => `${index + 1}  ${duty.text}`);
    const index = duties.length === 1 ? 0 : duties.indexOf(await ctx.ui.select('Какое ожидание изменить?', duties) ?? '');
    const expectationId = view.refs.must[index];
    if (index < 0 || !expectationId) return undefined;
    const text = await ownWords(ctx, 'Что агент должен · своими словами', brief.must[index]!.text);
    return text === undefined ? undefined : { command: { kind: 'edit_expectation', cardId: view.id, expectationId, text }, words: text };
  }
  if (picked !== menu[2]) return undefined;
  const facts = brief.knows.flatMap((fact, index) => view.refs.knows[index] ? [{ id: view.refs.knows[index]!, label: `${fact.what} — ${fact.when}` }] : []);
  const add = 'Добавить факт';
  const factPick = await ctx.ui.select('Какой факт?', [...facts.map(fact => fact.label), add]);
  if (factPick === add) {
    const label = (await ctx.ui.editor('Что знает клиент · например «Номер терминала»', ''))?.trim();
    const value = label && (await ctx.ui.editor('Значение · оставьте пустым, если его нет', ''))?.trim();
    const when = label && await ctx.ui.select('Когда клиент это скажет?', [...WHEN_CHOICES]);
    if (!label || value === undefined || !when) return undefined;
    return { command: { kind: 'set_fact', cardId: view.id, label, ...(value ? { value } : {}), disclosure: WHEN[when as keyof typeof WHEN] } };
  }
  const fact = facts.find(item => item.label === factPick);
  if (!fact) return undefined;
  const remove = 'Убрать факт';
  const when = await ctx.ui.select('Когда клиент это скажет?', [...WHEN_CHOICES, remove]);
  if (!when) return undefined;
  return { command: when === remove ? { kind: 'remove_fact', cardId: view.id, factId: fact.id }
    : { kind: 'set_fact_disclosure', cardId: view.id, factId: fact.id, disclosure: WHEN[when as keyof typeof WHEN] } };
}

/** The command a numbered action of a situation stands for; undefined when the owner stepped back. */
async function situationCommand(ctx: ExtensionCommandContext, action: SituationAction, view: SituationView): Promise<{ command: CardCommand; words?: string } | undefined> {
  if (action.kind === 'answer') {
    const { choice } = action;
    const question = view.question;
    if (!question?.id) return undefined;
    const text = choice.needsText ? (await ctx.ui.editor(`${choice.label} — своими словами`, choice.command.kind === 'edit_client' ? choice.command.wants ?? choice.command.writes ?? ''
      : choice.command.kind === 'edit_expectation' ? choice.command.text ?? '' : ''))?.trim() : undefined;
    if (choice.needsText && !text) return undefined;
    return { command: { kind: 'answer_question', cardId: view.id, questionId: question.id, choice: choice.id, ...(text ? { text } : {}) }, ...(text ? { words: text } : {}) };
  }
  if (action.kind === 'remove') {
    if (!await ask(ctx, `Убрать ситуацию ${view.number} «${view.brief.title}» из черновика?`, ['Разговоры из логов и прошлые прогоны не тронуты.'], 'Убрать')) return undefined;
    return { command: { kind: 'remove_card', cardId: view.id } };
  }
  return action.kind === 'edit' ? editCommand(ctx, view) : undefined;
}

/** What the workspace shows about one agent, read from the store now. */
async function spaceData(reader: ExperimentLab, space: AgentSpace, job: SessionOperation | undefined, now: Date): Promise<SpaceData> {
  const setRecord = space.draft ?? space.runs[0];
  let set: SpaceData['set'];
  let pendingCalls = 0;
  if (setRecord) {
    const library = setRecord.librarySnapshot;
    const context = library?.formatVersion === 2 ? await reader.cardContext(setRecord.id) : undefined;
    const maxTurns = setRecord.settings.maxTurns;
    const views = context ? situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns }) : situationViews(setRecord, { maxTurns });
    // A card set can always be worked on: a finished run's situations are changed in a fresh draft of the same set.
    const editable = !!context && !isRunning(setRecord.phase);
    const coverage = context ? situationCoverage(context.library, cardStatuses({ library: context.library, evidence: context.evidence, maxTurns })) : undefined;
    if (context && editable && setRecord.phase === 'review' && !setRecord.trials.length) pendingCalls = checkCalls(context.experiment, context.library, context.evidence);
    const rulebook = context && shownRulebook(context.library);
    set = { record: setRecord, views, editable, ...(coverage ? { coverage } : {}), ...(rulebook ? { rulebook } : {}), running: job?.kind === 'assessment' && job.id === setRecord.id,
      plan: context && !context.library.acceptance ? cardPlan(setRecord, views) : scenarioPlan(setRecord) };
  }
  // The newest run is read with its source run, so its stability is checked; the older ones only need their number.
  const runs = await Promise.all(space.runs.map(async (record, index) => ({ record, view: index ? buildResultView(record) : (await evidenceBundle(record, reader.store)).view })));
  const finished = runs.filter(run => run.record.phase === 'results_review' || run.record.phase === 'complete');
  const active = space.active;
  const planned = active ? plannedTrials(active) : 0;
  const prepared = active?.preparationProgress;
  const share = !active ? 0 : active.phase === 'preparing' ? prepared ? (prepared.processed.length + prepared.excluded.length) / Math.max(1, prepared.processed.length + prepared.excluded.length + prepared.pending.length) : 0
    : planned ? active.trials.length / planned : 0;
  return {
    space, ...(set ? { set } : {}), runs, now,
    // A first-format draft is not editable, but it has one decision: to go on in the new format.
    decisions: decisions({ ...(set && (set.editable || convertible(set.record)) ? { draft: { record: set.record, views: set.views, pendingCalls } } : {}), ...(finished[0] ? { run: finished[0] } : {}),
      logs: finished[0] ? await logsOf(reader.store, finished[0].record) : [], now }),
    problems: recurringProblems(finished),
    ...(active ? { progress: { text: progressText(active, now.getTime()), share, stoppable: job?.id === active.id } } : {}),
  };
}

/**
 * What makes an open workspace read itself again: a record written by any process — a checkpoint of a run, a step of
 * a preparation — and a new progress line of this session's own work, which it may say before it saves anything.
 */
function workspaceChanges(reader: ExperimentLab, job: SessionOperation | undefined): WorkspaceChanges {
  return changed => {
    const stops = [reader.store.watch(() => changed())];
    let line = '';
    if (job) stops.push(job.lab.follow(record => {
      const next = progressText(record);
      if (next !== line) { line = next; changed(); }
    }));
    return () => { for (const stop of stops) stop(); };
  };
}

/** The folder's agents, and the open one's workspace. */
export async function workspaceView(reader: ExperimentLab, state: WorkspaceState, job: SessionOperation | undefined): Promise<WorkspaceView> {
  const now = new Date();
  const spaces = agentSpaces(await reader.list());
  // One agent in the folder opens straight into its workspace.
  if (!state.space && spaces.length === 1) state.space = spaces[0]!.key;
  const open = spaces.find(space => space.key === state.space);
  const agents = spaces.length > 1 ? await Promise.all(spaces.map(async space => {
    const data = space === open ? undefined : await spaceData(reader, space, job, now);
    return { space, result: space.runs[0] ? accuracyParts(buildResultView(space.runs[0])).value : null, decisions: data?.decisions.length ?? 0 };
  })) : spaces.map(space => ({ space, result: null, decisions: 0 }));
  const data = open ? await spaceData(reader, open, job, now) : undefined;
  if (data) for (const agent of agents) if (agent.space === open) agent.decisions = data.decisions.length;
  return { agents, ...(data ? { data } : {}) };
}

/** Opens a saved report in the system's browser. */
async function openFile(path: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', path] : [path];
  await promisify(execFile)(command, args, { timeout: 10000 });
}

export interface BoardOptions {
  /** How a report is opened; the system's browser by default. */
  openReport?: (path: string) => Promise<void>;
  /** `/agent-lab gateway [off]`: the personal model gateway, connected without a model. */
  gateway?: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

/** The /agent-lab command. */
export function registerBoardCommand(pi: ExtensionAPI, host: LabHost, options: BoardOptions = {}): void {
  const { open, operations, background } = host;
  pi.registerCommand('agent-lab', {
    description: 'Рабочее пространство агента: /agent-lab, /agent-lab demo или /agent-lab /путь/к/проекту. /agent-lab gateway — подключить шлюз моделей',
    async handler(args, ctx) {
      requireInteractive(ctx, 'Рабочее пространство открывается в интерактивном терминале Pi.');
      const request = args.trim();
      const [word, ...rest] = request.split(' ');
      if (word === 'gateway' && options.gateway) { await options.gateway(rest.join(' ').trim(), ctx); return; }
      const directory = resolve(ctx.cwd, '.agent-lab');
      // Reading never takes the writer's lock: another session may own the folder, and its work stays visible here.
      const reading = () => operations.reader(directory);
      const state = newState();
      let handoff: { request: string; context: unknown } | undefined;
      let pending: WorkspaceAction | undefined = request === 'demo' ? { type: 'demo' } : request === 'new' || request.startsWith('/') || request.startsWith('~') ? { type: 'new' } : undefined;
      if (request && !pending) {
        const records = await reading().list();
        const found = records.filter(record => record.id === request || record.id.startsWith(request));
        if (found.length !== 1) throw new Error(found.length ? 'Нашлось несколько прогонов — откройте /agent-lab и выберите нужный.' : 'Такого прогона нет — откройте /agent-lab.');
        const space = agentSpaces(records).find(item => item.records.some(record => record.id === found[0]!.id));
        if (space) { state.space = space.key; if (found[0]!.trials.length) { state.area = 'runs'; state.stack = [{ kind: 'run', runId: found[0]!.id }]; } }
      }
      const inform = (text: string, tone: 'success' | 'warning' | 'error' | 'text' = 'success') => { state.notice = { text: safeText(text), tone }; };
      // A write needs the writer's lease; long work hands it to the session, which releases it when the work ends.
      const writing = writer(operations, open, ctx.cwd, directory);
      const surface: DecisionSurface = { ctx, origin: 'board', writing, background };
      while (true) {
        const job = operations.current(directory);
        const view = await workspaceView(reading(), state, job);
        const action: WorkspaceAction = pending ?? await showWorkspace(ctx, view, state, () => workspaceView(reading(), state, operations.current(directory)),
          workspaceChanges(reading(), operations.current(directory)));
        pending = undefined;
        state.notice = undefined;
        if (action.type === 'close') break;
        try {
          if (action.type === 'new') {
            const words = request.startsWith('/') || request.startsWith('~') ? `Проверь агента в ${request}` : await ctx.ui.editor('Какого агента проверить и где лежат логи · своими словами', '');
            if (!words?.trim()) continue;
            handoff = { request: words, context: { task: 'Prepare situations for the owner\'s agent with agent_lab_prepare: Lab finds the logs, the rules and how the agent starts in the project folder and asks the owner natively what it cannot settle. The agent may be connected later — Lab asks right before the run. Then say in plain words what was found and offer agent_lab_run for the ready situations. Never claim a review the owner did not make.' } };
            break;
          }
          if (action.type === 'demo') {
            await writing(async lab => { await lab.create(demoInput()); await lab.waitForIdle(); });
            Object.assign(state, newState('demo'));
            inform('Учебный пример готов: агент переспрашивает уже названный номер. Ответьте на вопрос ситуации 2 и запустите готовые — модель и ключи не нужны.');
            continue;
          }
          if (action.type === 'space') { Object.assign(state, newState(action.key)); continue; }
          // The workspace refreshed itself while it was open: the action is done on the records as they are now.
          const data = (await workspaceView(reading(), state, operations.current(directory))).data;
          if (!data) continue;
          if (action.type === 'ask') {
            const words = (await ctx.ui.input(safeText(`Спросить Lab про ${action.about}`), 'например: «поправь: клиент знает номер заранее»'))?.trim();
            if (!words) continue;
            const record = data.space.records.find(item => item.id === action.runId) ?? data.set?.record;
            // A conversation of a repeat carries its pair from the run before, so the conversation can show what changed.
            const bundle = record && action.trialId ? await evidenceBundle(record, reading().store) : undefined;
            const comparedPair = bundle?.comparison?.pairs.find(pair => pair.afterTrialId === action.trialId);
            handoff = { request: words, context: { ...(record ? boardDiscussionContext(record, action.situation) : {}), ...(action.trialId ? { trialId: action.trialId } : {}),
              ...(comparedPair ? { comparisonSource: bundle?.comparisonSource, comparedPair } : {}) } };
            break;
          }
          if (action.type === 'situation') {
            const { action: chosen, view: situation, record } = action;
            if (chosen.kind === 'similar' || chosen.kind === 'rule') {
              // A new situation or a missing rule is said in words: the request goes to the conversation, where the owner confirms the change.
              const words = (await ctx.ui.editor(chosen.kind === 'similar' ? `Чем похожая отличается от ситуации ${situation.number}? Например: клиент не знает номер`
                : `Какое правило решает ситуацию ${situation.number}? Своими словами или файл с правилами`, ''))?.trim();
              if (!words) continue;
              handoff = { request: `${chosen.kind === 'similar' ? `Добавь ситуацию, похожую на ${situation.number}` : `Для ситуации ${situation.number} нужно правило`}: ${words}`,
                context: boardDiscussionContext(record, situation) };
              break;
            }
            const decided = await situationCommand(ctx, chosen, situation);
            if (!decided) continue;
            inform(await applySituationCommand(surface, record, situation, decided));
            continue;
          }
          if (action.type === 'rulebook') {
            const said = await applyRulebookChange(surface, action.record, action.operatorInstructions);
            if (said) inform(said);
            continue;
          }
          if (action.type === 'decide') {
            const result = await decide(action.choice, data);
            if (result === 'handoff') break;
            if (result) inform(result);
            continue;
          }
          if (action.type === 'run') {
            const draft = data.space.draft;
            const started = await writing(async (lab, handOver) => {
              // No draft: the newest run's set is repeated — the same situations, the agent as it is now — written only when the owner starts it.
              const target = draft ?? (data.space.runs[0] ? await lab.repeat(data.space.runs[0].id, undefined, undefined, { preview: true }) : undefined);
              if (!target) throw new Error('Запускать нечего: сначала соберите ситуации.');
              const run = await launchRun(ctx, lab, target);
              if (run) handOver(lease => background.detach(ctx, lease, target.id, 'board'));
              return run;
            }, 'wait');
            if (started) { state.stack = []; if (state.step) state.step = 'run'; else state.area = 'runs'; inform('Прогон идёт: результат появится здесь и в чате. Доску можно закрыть — прогон продолжится.'); }
            continue;
          }
          if (action.type === 'stop') {
            const job = operations.current(directory);
            if (!job) { inform('Сейчас ничего не идёт.', 'text'); continue; }
            if (!await ask(ctx, job.kind === 'assessment' ? 'Остановить проверку ситуаций?' : job.kind === 'preparation' ? 'Остановить подготовку?' : 'Остановить прогон?',
              ['Записанные ситуации, проверки и разговоры сохранятся. Закрыть доску можно и без остановки.'], 'Остановить')) continue;
            await operations.stop(job);
            inform('Остановлено; записанное сохранено.', 'warning');
            continue;
          }
          if (action.type === 'report') {
            const record = data.runs.find(run => run.record.id === action.runId)?.record;
            if (!record) continue;
            const artifacts = await exportArtifacts(await evidenceBundle(record, reading().store), directory);
            await (options.openReport ?? openFile)(artifacts.htmlReport).then(() => inform(`Отчёт для заказчика открыт в браузере: ${artifacts.htmlReport.replace(`${ctx.cwd}/`, '')}`),
              () => inform(`Отчёт для заказчика сохранён: ${artifacts.htmlReport.replace(`${ctx.cwd}/`, '')}`));
            continue;
          }
          if (action.type === 'mark') {
            const notice = await writing(async lab => recordMark(ctx, lab, await lab.get(action.runId), action.trialId, action.answer, { readingMs: action.readingMs, seen: action.seen }));
            if (!notice) continue;
            state.reading.delete(action.trialId);
            inform(notice);
            // Walking the judge's decisions: the next one opens by itself; the last answer closes the walk.
            const top = state.stack.at(-1);
            if (top?.kind === 'judged' && top.queue) {
              const next = top.queue.slice(top.queue.indexOf(top.trialId) + 1)[0];
              state.stack.pop();
              if (next) state.stack.push({ ...top, trialId: next });
            }
            continue;
          }
        } catch (error) { inform(inputError(error), 'error'); }
      }
      if (handoff) {
        pi.sendMessage({ customType: 'agent-lab-context', content: JSON.stringify(handoff.context), display: false }, { deliverAs: 'followUp' });
        pi.sendUserMessage(handoff.request, { deliverAs: 'followUp', expandPromptTemplates: false });
      }

      /** One choice in the queue of decisions; 'handoff' when it went to the conversation. */
      async function decide(choice: DecisionChoice, data: SpaceData): Promise<string | 'handoff' | undefined> {
        const action = choice.action;
        const record = data.set?.record;
        switch (action.kind) {
          case 'answer': case 'remove': {
            const situation = data.set?.views.find(view => view.number === action.situation);
            if (!situation || !record) return undefined;
            const decided = await situationCommand(ctx, action.kind === 'answer' ? { kind: 'answer', choice: action.choice } : { kind: 'remove', label: choice.label }, situation);
            return decided ? `Решено: ${await applySituationCommand(surface, record, situation, decided)}` : undefined;
          }
          case 'add_rule': {
            const situation = data.set?.views.find(view => view.number === action.situation);
            const words = (await ctx.ui.editor(`Какое правило решает ситуацию ${action.situation}? Своими словами или файл с правилами`, ''))?.trim();
            if (!words || !record) return undefined;
            handoff = { request: `Для ситуации ${action.situation} нужно правило: ${words}`, context: boardDiscussionContext(record, situation) };
            return 'handoff';
          }
          case 'check_connection':
            handoff = { request: 'Проверь подключение к агенту', context: { task: 'The owner asked from the workspace to check the connection to the agent: show what was not measured with agent_lab_explain and ask the owner whether the agent runs and how it is started; a new way to start it goes to agent_lab_run as agent.' } };
            return 'handoff';
          case 'raise_limit':
            // A higher limit is spending: the key alone does not raise it, the owner confirms the number.
            if (!await ask(ctx, `Поднять лимит до ${action.to} вызовов модели?`, ['Лимит нужен, чтобы проверить изменённые ситуации; потраченное не сбрасывается.'], 'Поднять лимит')) return undefined;
            return settle(surface, action, data.runs.map(run => run.record));
          case 'reassess': {
            const run = data.runs.find(item => item.record.id === action.runId)?.record;
            if (!run || !await ask(ctx, `Переоценить ${run.trials.length} записанных разговоров судьёй?`,
              ['Агент не запускается: судья заново оценивает записанные разговоры; результат будет отдельным прогоном.', `Не больше ${run.settings.maxCalls} вызовов модели.`], 'Переоценить')) return undefined;
            return settle(surface, action, data.runs.map(item => item.record));
          }
          case 'name_log_version': {
            const version = (await ctx.ui.editor('Какая версия агента записала логи · как вы её называете', ''))?.trim();
            return version ? settle(surface, { kind: 'declare_log_version', importId: action.importId, version }, data.runs.map(run => run.record)) : undefined;
          }
          case 'check_situations': case 'resume_preparation': case 'convert_draft': case 'declare_log_version':
            return settle(surface, action, data.runs.map(run => run.record));
          case 'open_situation': case 'open_situations': case 'open_conversation': return undefined;
        }
      }
    },
  });
}
