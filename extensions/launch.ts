import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { runCalls } from '../src/card/budget.js';
import { calibrationConsent } from '../src/card/calibrate.js';
import { describeCheck, type Experiment, type RunnableTarget } from '../src/contracts.js';
import { situationViews, type SituationView } from '../src/card/view.js';
import { detectProject, evidenceText, targetLabel, type AgentCandidate } from '../src/detect.js';
import type { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { runPlan } from '../src/lab/run.js';
import { countText } from '../src/plural.js';
import { expectationSheet } from '../src/quality.js';
import { libraryHash } from '../src/scenario-library.js';
import { safeText } from '../src/text.js';
import { launchLines, scenarioPlan, type LaunchPlan } from './conversation.ts';
import { NeedsOwner } from './lab-ui.ts';

/*
 * One dialog starts a run, the same from the chat and from the workspace (docs/design/ui-spec.md §4.6, the owner's decision of
 * 23.09): a draft of cards is accepted with its ready situations in the very dialog that starts it; a repeat of an
 * accepted set just starts; a draft of a record made before libraries confirms its expectations with the run. The
 * acceptance and the start stay two facts in the record. Questions never block the ready situations.
 *
 * Situations may be prepared before the agent is connected. The agent is then the one the owner named, or the one Lab
 * finds in the project folder — one sure candidate goes straight into the plan, several are the owner's pick — and it
 * is connected only when the owner says «Запустить»: a declined dialog writes nothing.
 */

/** The two answers of every run dialog. */
export const LAUNCH = 'Запустить', NOT_NOW = 'Не сейчас';

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
    ...(count('unusable') ? [`${count('unusable')} не подходит для теста`] : []),
    ...(count('checking') ? [countText(count('checking'), ['ещё не проверена', 'ещё не проверены', 'ещё не проверены'])] : []),
  ].join(' · ');
  return { situations: ready.length, conversations: ready.length * attempts, judgePerAttempt: 2 * Math.max(0, ...ready.map(view => view.brief.must.length)),
    judgeCalls: 2 * attempts * ready.reduce((sum, view) => sum + view.brief.must.length, 0), outside: outside || null };
}

const SITUATIONS: [string, string, string] = ['ситуацию', 'ситуации', 'ситуаций'];
/** How many ways to start the agent the connection question offers. */
const OFFERED = 3;
const NO_AGENT = 'Агент ещё не подключён, а в папке проекта Lab не нашёл, как его запускать.';

/** A way to start the agent as the owner picks it: how it starts, and what in the folder says so. */
function candidateLabel(candidate: AgentCandidate, root: string): string {
  return safeText(`${targetLabel(candidate.target, root)}${candidate.evidence[0] ? ` — ${evidenceText(candidate.evidence[0])}` : ''}`);
}

/** The agent Lab found for a run, and the line of the plan that says where it was found. */
export interface FoundAgent { target: RunnableTarget; note: string }

/**
 * How to start an agent that is not connected yet, from what the folder `cwd` shows (read-only: nothing is run or
 * imported). One candidate Lab is sure of is proposed in the plan itself; several, or unsure ones, are the owner's
 * pick. Undefined when the owner stepped back; nothing found is a question to the owner.
 */
export async function findAgent(ctx: Pick<ExtensionContext, 'ui'>, cwd: string): Promise<FoundAgent | undefined> {
  const detection = await detectProject(cwd).catch(() => undefined);
  const found = detection?.agents.slice(0, OFFERED) ?? [];
  if (!found.length) throw new NeedsOwner('needs_owner_input', `${NO_AGENT} Спросите владельца, как его запускать (команда, файл модуля или адрес), и вызовите agent_lab_run с agent.`, [],
    `${NO_AGENT} Как его запускать — команда, файл модуля или адрес?`);
  const root = detection!.root;
  const note = (candidate: AgentCandidate) => safeText(`Lab нашёл его в папке проекта: ${candidate.evidence.map(evidenceText).join('; ')}.`);
  if (found.length === 1 && found[0]!.confidence === 'high') return { target: found[0]!.target, note: note(found[0]!) };
  const labels = found.map(candidate => candidateLabel(candidate, root));
  const picked = await ctx.ui.select(safeText(['Как запустить агента?', '', 'Ситуации готовы, а агент ещё не подключён. Lab нашёл в папке проекта — ничего не запускал и не менял:'].join('\n')),
    [...labels, NOT_NOW]);
  const chosen = found[labels.indexOf(picked ?? '')];
  return chosen ? { target: chosen.target, note: note(chosen) } : undefined;
}

/** How the run reaches the agent: a new connection the owner named or Lab found, and the owner's name for its version. */
export interface LaunchAgent { target?: RunnableTarget; version?: string; note?: string }

/**
 * Asks the owner and starts the run of a draft; undefined when they said «Не сейчас». A card draft is accepted in
 * the same dialog; its situations that are not ready stay out and wait for the owner. `agent` is a connection the
 * owner named for this run; without one, a draft whose agent is not connected yet gets the one Lab finds in `cwd`.
 * The connection is written only with «Запустить», and becomes part of what the owner confirmed.
 */
export async function launchRun(ctx: Pick<ExtensionContext, 'ui' | 'cwd'>, lab: ExperimentLab, start: Experiment, agent: LaunchAgent = {}, cwd = ctx.cwd): Promise<Experiment | undefined> {
  const found = !agent.target && start.target.kind === 'unconnected' ? await findAgent(ctx, cwd) : undefined;
  if (!agent.target && start.target.kind === 'unconnected' && !found) return undefined;
  const target = agent.target ?? found?.target;
  const note = agent.note ?? found?.note;
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
    const lines = launchLines(shown(context.experiment), cardPlan(context.experiment, views), cwd, { calibration: calibration?.line ?? null, ...(note ? { note } : {}) });
    const picked = await ctx.ui.select(safeText([`Принять ${countText(ready.length, SITUATIONS)} и запустить?`, '', ...lines, ...(limit ? [limit] : []),
      'Вместе с запуском Lab утвердит эти ситуации — повтор пойдёт по ним же.'].join('\n')), [LAUNCH, NOT_NOW]);
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
  const plan = [...scope, ...(scope.length ? [''] : []), ...launchLines(shown(start), scenarioPlan(start), cwd, { calibration: calibration?.line ?? null, ...(note ? { note } : {}) }),
    ...(limit ? [limit] : []), ...(library || confirmed ? [] : ['Запуск подтверждает ожидания ситуаций выше. Оценки судьи вы не проверяли.'])];
  const picked = await ctx.ui.select(safeText([library || confirmed ? 'Запустить прогон?' : 'Подтвердить ожидания и запустить?', '', ...plan].join('\n')), [LAUNCH, NOT_NOW]);
  if (picked !== LAUNCH) return undefined;
  const draft = await connected();
  const hash = draftHash(draft);
  // A new connection is a new version of the draft: the expectations the owner confirmed in this dialog are confirmed on it.
  if (draft.acceptedDraftHash !== hash) await lab.acceptDraft(draft.id, hash);
  return lab.start(draft.id, { approved: true, reviewer: 'expectations', expectedHash: hash, parallel: runParallel(draft), requireAccepted: true, raiseLimit: !!limit });
}
