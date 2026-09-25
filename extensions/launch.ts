import { resolve } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { runCalls } from '../src/card/budget.js';
import { planSummary } from '../src/card/plan.js';
import { calibrationConsent } from '../src/card/calibrate.js';
import { describeCheck, fingerprint, isRunnable, type Experiment, type RunnableTarget } from '../src/contracts.js';
import { CONNECTION_FILE } from '../src/connect.js';
import { projectConnection, sameConnection, saveExam } from '../src/connection.js';
import { examPlanLines, examShowsMemory } from '../src/exam.js';
import type { Exam } from '../src/target-schema.js';
import { situationViews, type SituationView } from '../src/card/view.js';
import { detectProject, evidenceText, releaseText, targetLabel, type AgentCandidate } from '../src/detect.js';
import type { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { runPlan } from '../src/lab/run.js';
import { countText } from '../src/plural.js';
import { expectationSheet } from '../src/quality.js';
import { libraryHash } from '../src/scenario-library.js';
import { safeText } from '../src/text.js';
import { agentLines, launchLines, scenarioPlan, type LaunchPlan } from './conversation.ts';
import { ask, NeedsOwner } from './lab-ui.ts';

/*
 * One dialog starts a run, the same from the chat and from the workspace (docs/design/ui-spec.md §4.6, the owner's decision of
 * 23.09): a draft of cards is accepted with its ready situations in the very dialog that starts it; a repeat of an
 * accepted set just starts; a draft of a record made before libraries confirms its expectations with the run. The
 * acceptance and the start stay two facts in the record. Questions never block the ready situations.
 *
 * Situations may be prepared before the agent is connected. The agent is then the one the owner named, or the one Lab
 * finds in the project folder — one sure candidate goes straight into the plan, several or unsure ones are the owner's
 * pick, and so is one that runs a release hook — and it is connected only when the owner says «Запустить»: a declined
 * dialog writes nothing. The dialog always shows what Lab will actually start and the hook it runs first, word for word,
 * and says so when the chat's model proposed the command. An address alone never becomes a connection here: Lab does not
 * know the request the agent there expects, so the owner's curl goes through agent_lab_connect (its fields read, two
 * test messages, the owner's confirmation) first.
 */

/** The two answers of every run dialog. */
export const LAUNCH = 'Запустить', NOT_NOW = 'Не сейчас';
/** The chat's third answer when the connection has no exam that counts: compose it first (the chat's model reads the agent's code). */
export const EXAM_FIRST = 'Сначала составить экзамен';

/** A real agent is independent per dialogue, so several run at once. */
export function runParallel(record: Experiment): number {
  return Math.max(1, Math.min(8, record.scenarios.length * record.settings.userModes.length * record.settings.repeats));
}

/**
 * What an older record's draft confirms with its run, in the owner's words. A set of more than one situation
 * leads with the compact expectation sheet; a single test keeps its full definition. Confirming seals
 * `fingerprint(scenario)` for every card, so a set not built from logs also lists the opening request and the
 * exact checks: in a validation set those come from the logged dialogue itself.
 */
function runScope(record: Experiment): string[] {
  const sheet = record.workflow === 'evaluate' && record.phase === 'review' && record.scenarios.length > 1 ? expectationSheet(record) : undefined;
  if (sheet) {
    const fromLog = record.scenarios.every(scenario => scenario.provenance === 'production');
    const sealed = fromLog ? [] : record.scenarios.flatMap(s => [safeText(s.title), `  Запрос: ${safeText(s.user.opening)}`,
      ...s.checks.map(c => `  Проверка: ${safeText(describeCheck(c))}`)]);
    return [...(fromLog ? ['Клиента играет Lab: на уточнения агента он отвечает только фактами из лога.', ''] : []),
      ...sheet.compactLines().map(item => safeText(item)),
      ...(sealed.length ? ['', 'Что вы подтверждаете дословно:', ...sealed] : [])];
  }
  return record.scenarios.map(s => [safeText(s.title), `  Запрос: ${safeText(s.user.opening)}`,
    ...(record.settings.userModes.includes('scripted') ? (s.user.script ?? []).map((message, i) => `  Продолжение ${i + 1}: ${safeText(message)}`) : []),
    `  Ожидается: ${safeText(s.successCriteria)}`, ...s.checks.map(c => `  Проверка: ${safeText(describeCheck(c))}`)].join('\n'));
}

/**
 * The dialog's line when the draft's call limit cannot hold its run's plan (card/budget.ts): the owner reads both
 * numbers, and «Запустить» raises the limit to the plan. None when the plan fits, or for the teaching example.
 */
function limitLine(record: Experiment, calls: number): string | undefined {
  if (record.mode === 'demo' || calls <= record.settings.maxCalls) return undefined;
  return `Лимит вызовов модели — ${record.settings.maxCalls}, а прогону нужно до ${calls}: запуск поднимет лимит до ${calls}.`;
}

/** The model calls a card draft's run of its `ready` situations plans (card/budget.ts runCalls), every answer passing the first time. */
function cardCalls(record: Experiment, ready: readonly SituationView[]): number {
  const modes = record.settings.userModes.filter(mode => mode !== 'scripted');
  return runCalls(ready.flatMap(view => modes.flatMap(mode => Array.from({ length: record.settings.repeats }, () => ({ customer: mode === 'reactive', expectations: view.brief.must.length })))),
    record.settings.maxTurns);
}

/** The plan of a card draft's run: its ready situations; the ones waiting for the owner, unusable or unchecked stay out. */
export function cardPlan(record: Experiment, views: readonly SituationView[]): LaunchPlan {
  const ready = views.filter(view => view.status === 'ready');
  const attempts = record.settings.repeats * record.settings.userModes.filter(mode => mode !== 'scripted').length;
  const count = (status: SituationView['status']) => views.filter(view => view.status === status).length;
  const outside = [
    ...(count('needs_owner') ? [countText(count('needs_owner'), ['ждёт вашего ответа', 'ждут вашего ответа', 'ждут вашего ответа'])] : []),
    ...(count('unusable') ? [countText(count('unusable'), ['не подходит для теста', 'не подходят для теста', 'не подходят для теста'])] : []),
    ...(count('checking') ? [countText(count('checking'), ['ещё не проверена', 'ещё не проверены', 'ещё не проверены'])] : []),
  ].join(' · ');
  return { situations: ready.length, conversations: ready.length * attempts, judgePerAttempt: 2 * Math.max(0, ...ready.map(view => view.brief.must.length)),
    judgeCalls: 2 * attempts * ready.reduce((sum, view) => sum + view.brief.must.length, 0), outside: outside || null };
}

const SITUATIONS: [string, string, string] = ['ситуацию', 'ситуации', 'ситуаций'];
/** How many ways to start the agent the connection question offers. */
const OFFERED = 3;
const NO_AGENT = 'Агент ещё не подключён, а в папке проекта Lab не нашёл, как его запускать.';

/** An address without its request format: an agent there is connected from the owner's curl, never in Lab's own contract by guess. */
const needsCurl = (target: RunnableTarget, evidence: readonly AgentCandidate['evidence'][number][] = []) =>
  target.kind === 'http' && !target.request && !evidence.some(item => item.kind === 'connection');
/** The question for an address: the owner's working curl to it, read by agent_lab_connect. */
function curlQuestion(url: string): NeedsOwner {
  const address = URL.parse(url);
  const shown = address ? `${address.origin}${address.pathname}` : url;
  return new NeedsOwner('needs_owner_input', `Агента по адресу ${shown} Lab подключает по curl-запросу владельца: так Lab узнаёт, в каком виде агент принимает сообщение и где в ответе его текст, и проверяет это двумя тестовыми сообщениями. Попросите у владельца команду curl, которой он обращается к агенту (с телом запроса), и передайте её целиком в agent_lab_connect; после подключения запустите снова.`, [],
    `Агента по адресу ${shown} Lab подключает по вашему curl-запросу: пришлите команду curl, которой вы обращаетесь к нему (с телом запроса), — Lab разберёт её и проверит двумя тестовыми сообщениями.`);
}

/** A way to start the agent as the owner picks it: how it starts, what in the folder says so, and what else it would do — its release hook. */
function candidateLabel(candidate: AgentCandidate, root: string): string {
  const release = candidate.target.release ? `; перед прогоном выполнит: ${releaseText(candidate.target.release, root)}` : '';
  return safeText(`${targetLabel(candidate.target, root)}${candidate.evidence[0] ? ` — ${evidenceText(candidate.evidence[0])}` : ''}${release}`);
}

/** The agent Lab found for a run, and the line of the plan that says where it was found. */
export interface FoundAgent { target: RunnableTarget; note: string }

/**
 * How to start an agent that is not connected yet, from what the folder `cwd` shows (read-only: nothing is run or
 * imported). One candidate Lab is sure of is proposed in the plan itself; several, unsure ones, or one with a release
 * hook — a command it runs before every run — are the owner's pick. Undefined when the owner stepped back; nothing
 * found is a question to the owner.
 */
export async function findAgent(ctx: Pick<ExtensionContext, 'ui'>, cwd: string): Promise<FoundAgent | undefined> {
  const detection = await detectProject(cwd).catch(() => undefined);
  const found = detection?.agents.slice(0, OFFERED) ?? [];
  if (!found.length) throw new NeedsOwner('needs_owner_input', `${NO_AGENT} Спросите владельца, как его запускать — команда или файл модуля (вызовите agent_lab_run с agent), а если агент отвечает по адресу — его curl-запрос к агенту (передайте его в agent_lab_connect). Если у агента ещё нет адаптера, точный контракт — adapterContract в ответе agent_lab_status.`, [],
    `${NO_AGENT} Как его запускать — команда или файл модуля? Если агент отвечает по адресу, пришлите curl-запрос, которым вы к нему обращаетесь.`);
  const root = detection!.root;
  const note = (candidate: AgentCandidate) => safeText(`Lab нашёл его в папке проекта: ${candidate.evidence.map(evidenceText).join('; ')}.`);
  // Only a candidate Lab is sure of goes straight into the plan; an address never does, nor a connection with a release hook.
  const sure = found.length === 1 ? found[0]! : undefined;
  if (sure && sure.confidence === 'high' && !needsCurl(sure.target, sure.evidence) && !sure.target.release) return { target: sure.target, note: note(sure) };
  const labels = found.map(candidate => `${candidateLabel(candidate, root)}${needsCurl(candidate.target, candidate.evidence) ? ' — подключу по вашему curl' : ''}`);
  const picked = await ctx.ui.select(safeText(['Как запустить агента?', '', 'Ситуации готовы, а агент ещё не подключён. Lab нашёл в папке проекта — ничего не запускал и не менял:'].join('\n')),
    [...labels, NOT_NOW]);
  const chosen = found[labels.indexOf(picked ?? '')];
  if (chosen && chosen.target.kind === 'http' && needsCurl(chosen.target, chosen.evidence)) throw curlQuestion(chosen.target.url);
  return chosen ? { target: chosen.target, note: note(chosen) } : undefined;
}

/**
 * How the run reaches the agent: a new connection named in the chat or found by Lab, and the owner's name for its
 * version. `proposed`: the chat's model wrote the connection — the run dialog says so next to the command.
 */
export interface LaunchAgent { target?: RunnableTarget; version?: string; note?: string; proposed?: 'model'; exam?: Exam }

/**
 * The agent a run of `start` reaches, before its dialog: the connection named in the chat, the one Lab finds in `cwd`
 * for a draft not connected yet (the owner's pick where Lab is unsure), else the draft's own. `found` when Lab found it.
 * Undefined when the owner stepped back from the pick, or for a retired sandbox.
 */
export async function runTarget(ctx: Pick<ExtensionContext, 'ui'>, start: Experiment, agent: LaunchAgent, cwd: string): Promise<{ target: RunnableTarget; note?: string; found?: true } | undefined> {
  // An address named in the chat is connected from the owner's curl first: Lab's own contract is not the agent's.
  if (agent.target?.kind === 'http' && agent.proposed && needsCurl(agent.target)) throw curlQuestion(agent.target.url);
  if (agent.target) return { target: agent.target, ...(agent.note ? { note: agent.note } : {}) };
  // A retired sandbox reaches nothing: its run is refused at the start, in its own words.
  if (start.target.kind !== 'unconnected') return isRunnable(start.target) ? { target: start.target } : undefined;
  const found = await findAgent(ctx, cwd);
  return found && { ...found, found: true };
}

const sameExam = (a: Exam | undefined, b: Exam | undefined) => (a === undefined) === (b === undefined) && (a === undefined || fingerprint(a) === fingerprint(b));

/**
 * The exam the chat's model proposed from the agent's code, whole, in its own native dialog — what the customer writes or
 * presses at every step, what the agent's turn must be — and where it goes: written into the project's connection file
 * only at the owner's word, the connection there kept when it reaches this agent. False when the owner declined:
 * nothing was written. An exam that never checks the conversation's memory is refused before the owner is asked.
 */
export async function writeExam(ctx: Pick<ExtensionContext, 'ui' | 'cwd'>, record: Experiment, target: RunnableTarget, exam: Exam): Promise<boolean> {
  if (!examShowsMemory(exam)) throw new Error('Экзамен не записан: в нём нет пути, который проверяет память разговора. Нужен путь из двух шагов и больше, где поздний шаг проверяет (contains), что в ответе есть сказанное клиентом раньше — номер, имя, выбор. Ничего не записано.');
  const file = resolve(ctx.cwd, CONNECTION_FILE);
  const current = await projectConnection(file);
  const where = current === null ? `Lab сохранит это подключение вместе с экзаменом в ${CONNECTION_FILE} в папке проекта.`
    : sameConnection(current.target, target, ctx.cwd) ? `Lab запишет экзамен в ${CONNECTION_FILE}${current.target.exam ? ' вместо прежнего' : ''}.`
    : `В ${CONNECTION_FILE} сейчас другой агент (${targetLabel(current.target, ctx.cwd)}): Lab заменит его этим подключением с экзаменом.`;
  if (!await ask(ctx, 'Записать экзамен подключения?', [...agentLines({ ...record, target }, ctx.cwd), '', ...examPlanLines(exam), '',
    'Пути предложила модель по коду агента. Перед каждым прогоном Lab пройдёт их с агентом, без модели: не пройден — прогон не запустится; пройден — в итоге будет процент.', where],
  'Записать экзамен')) return false;
  await saveExam(file, target, exam);
  return true;
}

/** The exam the project's connection file keeps for the agent `target` reaches, when the target's own differs: undefined otherwise. */
export async function keptExam(target: RunnableTarget, project: string): Promise<Exam | undefined> {
  const connection = await projectConnection(resolve(project, CONNECTION_FILE)).catch(() => null);
  const exam = connection?.target.exam;
  return exam && !sameExam(exam, target.exam) && sameConnection(connection.target, target, project) ? exam : undefined;
}

/**
 * Asks the owner and starts the run of a draft; undefined when they said «Не сейчас». A card draft is accepted in
 * the same dialog; its situations that are not ready stay out and wait for the owner. `agent` is a connection named
 * in the chat for this run; without one, a draft whose agent is not connected yet gets the one Lab finds in `cwd`.
 * The run takes the exam `agent` carries — the one the owner just wrote —, else the one the project's connection file
 * keeps for this very agent. The connection is written only with «Запустить», and becomes part of what the owner
 * confirmed. With `offerExam` (the chat), a connection without an exam that counts adds «Сначала составить экзамен»:
 * EXAM_FIRST when the owner picks it, nothing written.
 */
export async function launchRun(ctx: Pick<ExtensionContext, 'ui' | 'cwd'>, lab: ExperimentLab, start: Experiment, agent?: LaunchAgent, cwd?: string): Promise<Experiment | undefined>;
export async function launchRun(ctx: Pick<ExtensionContext, 'ui' | 'cwd'>, lab: ExperimentLab, start: Experiment, agent: LaunchAgent, cwd: string, options: { offerExam: true }): Promise<Experiment | typeof EXAM_FIRST | undefined>;
export async function launchRun(ctx: Pick<ExtensionContext, 'ui' | 'cwd'>, lab: ExperimentLab, start: Experiment, agent: LaunchAgent = {}, cwd = ctx.cwd, options: { offerExam?: true } = {}): Promise<Experiment | typeof EXAM_FIRST | undefined> {
  const reached = await runTarget(ctx, start, agent, cwd);
  if (!reached && start.target.kind === 'unconnected') return undefined;
  const note = agent.note ?? reached?.note;
  const proposed = agent.target && agent.proposed ? { proposed: agent.proposed } : {};
  // The exam: written just now at the owner's word, or kept for this very agent in the project's connection file.
  const kept = reached && !agent.exam ? await keptExam(reached.target, ctx.cwd) : undefined;
  const exam = agent.exam ?? kept;
  const target = reached && (agent.target || reached.found || exam && !sameExam(exam, reached.target.exam)) ? { ...reached.target, ...(exam ? { exam } : {}) } : undefined;
  const examined = { ...(kept ? { exam: 'connection' as const } : {}), ...(options.offerExam && reached && !examShowsMemory((target ?? reached.target).exam) ? { offerExam: true } : {}) };
  const answers = [LAUNCH, ...examined.offerExam ? [EXAM_FIRST] : [], NOT_NOW];
  const connect = target || agent.version ? { ...(target ? { target } : {}), ...(agent.version ? { targetVersion: agent.version } : {}) } : undefined;
  /** The draft as the plan names it: with the agent it will be connected to. */
  const shown = (record: Experiment): Experiment => connect ? { ...record, ...connect } : record;
  /** The draft to start: the connection written first, when there is one, so the start and the acceptance see it. */
  const connected = async (): Promise<Experiment> => connect ? lab.updateDraft(start.id, draftHash(start), connect) : start;
  const library = start.librarySnapshot;
  if (library?.formatVersion === 2 && !library.acceptance) {
    const context = await lab.cardContext(start.id);
    const views = situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns });
    const ready = views.filter(view => view.status === 'ready');
    if (!ready.length) throw new NeedsOwner('needs_owner_input', 'Запускать нечего: ни одна ситуация не готова. Покажите владельцу вопросы по ситуациям (agent_lab_decide) — ответ делает ситуацию готовой.', [],
      'Запускать нечего: ни одна ситуация ещё не готова — ответьте на их вопросы.');
    const calibration = await calibrationConsent(lab.store, context.experiment, ready.map(view => view.id));
    const limit = limitLine(context.experiment, cardCalls(context.experiment, ready));
    const lines = launchLines(shown(context.experiment), cardPlan(context.experiment, views), cwd, { calibration: calibration?.line ?? null, ...(note ? { note } : {}), ...proposed, ...examined });
    // What the run checks, scenario by scenario: accepting the situations accepts what they are examples of.
    const scenarios = planSummary(context.library, ready.map(view => view.id));
    const picked = await ctx.ui.select(safeText([`Принять ${countText(ready.length, SITUATIONS)} и запустить?`, '', ...(scenarios.length ? [...scenarios, ''] : []), ...lines, ...(limit ? [limit] : []),
      'Вместе с запуском Lab утвердит эти ситуации — повтор пойдёт по ним же.'].join('\n')), answers);
    if (picked === EXAM_FIRST) return EXAM_FIRST;
    if (picked !== LAUNCH) return undefined;
    const draft = await connected();
    const { experiment } = await lab.acceptCards(draft.id, libraryHash(context.library), ready.map(view => view.id));
    return lab.start(draft.id, { approved: true, reviewer: 'expectations', expectedHash: draftHash(experiment), parallel: runParallel(experiment), requireAccepted: true, raiseLimit: !!limit });
  }
  if (library && !library.acceptance) throw new NeedsOwner('needs_owner_input', 'Это черновик старого формата: его ситуации можно посмотреть, но не утвердить. Предложите владельцу продолжить их в новом формате (решение в agent_lab_decide).', [],
    'Это черновик старого формата: его ситуации нельзя утвердить. Их можно продолжить в новом формате — старый черновик останется как есть.');
  const confirmed = start.acceptedDraftHash === draftHash(start);
  const calibration = await calibrationConsent(lab.store, start);
  const scope = library ? [] : runScope(start);
  const limit = limitLine(start, runPlan(start));
  const plan = [...scope, ...(scope.length ? [''] : []), ...launchLines(shown(start), scenarioPlan(start), cwd, { calibration: calibration?.line ?? null, ...(note ? { note } : {}), ...proposed, ...examined }),
    ...(limit ? [limit] : []), ...(library || confirmed ? [] : ['Запуск подтверждает ожидания ситуаций выше. Оценки судьи вы не проверяли.'])];
  const picked = await ctx.ui.select(safeText([library || confirmed ? 'Запустить прогон?' : 'Подтвердить ожидания и запустить?', '', ...plan].join('\n')), answers);
  if (picked === EXAM_FIRST) return EXAM_FIRST;
  if (picked !== LAUNCH) return undefined;
  const draft = await connected();
  const hash = draftHash(draft);
  // A new connection is a new version of the draft: the expectations the owner confirmed in this dialog are confirmed on it.
  if (draft.acceptedDraftHash !== hash) await lab.acceptDraft(draft.id, hash);
  return lab.start(draft.id, { approved: true, reviewer: 'expectations', expectedHash: hash, parallel: runParallel(draft), requireAccepted: true, raiseLimit: !!limit });
}
