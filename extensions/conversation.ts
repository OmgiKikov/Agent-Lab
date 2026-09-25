import { isRunnable, type Experiment, type RunnableTarget, type Trial } from '../src/contracts.js';
import { assessmentRubrics } from '../src/assessment.js';
import type { RunComparison } from '../src/comparison.js';
import { plannedTrials } from '../src/run.js';
import { headlineRule, recordedExpectationResult, type Expectation } from '../src/card/expectations.js';
import { judgedScenario } from '../src/card/legacy-v1.js';
import { AGREED_RATIONALE_PREFIX } from '../src/judge.js';
import { buildResultView, type ResultView } from '../src/result-view.js';
import { accuracyParts, comparisonRows, noRuleText, saidText, trialTurns, TURN_HANG, turnText, whenText, type ResultRow } from '../src/result-text.js';
import { CONNECTION_FILE, shownAddress } from '../src/connect.js';
import { examShowsMemory } from '../src/exam.js';
import { commandText, folderText, releaseText, targetLabel } from '../src/detect.js';
import { agentLine, agentOwnName, agentVersion } from '../src/workspace.js';
import { countText } from '../src/plural.js';
import { clip, oneLine } from '../src/text.js';
import { standing } from './records.ts';
import type { Feed } from './render/feed.ts';
import { GLYPH, type Row } from './render/theme.ts';

/*
 * The conversational surface of Agent Lab: what a chat request needs before it reaches the same
 * ExperimentLab operations the workspace and the CLI use, all pure:
 *
 *   the owner's own messages of the session ──► the words a wording must be found in verbatim
 *   a stored record ──► the summary rows of one action in the chat, details on expand
 *
 * Situations themselves are drawn by the shared projection (src/card/view.ts), results by result-text.ts.
 * On screen a run is named by its date and its agent, never by an id (docs/design/ui-spec.md §2); the model names it by its id.
 */

export { agentLine, agentName } from '../src/workspace.js';

type BranchReader = { sessionManager?: { getBranch?: () => unknown[] } };

/**
 * The owner's own messages of the current session branch, oldest first. Only user-role session
 * entries count: a tool result, a model reply or a custom message can never appear here, so the
 * model cannot supply the words a change is attributed to.
 */
export function ownerMessages(ctx: BranchReader): string[] {
  let entries: unknown[];
  try { entries = ctx.sessionManager?.getBranch?.() ?? []; } catch { return []; }
  return entries.flatMap(entry => {
    const item = entry as { type?: string; message?: { role?: string; content?: unknown } };
    if (item.type !== 'message' || item.message?.role !== 'user') return [];
    const content = item.message.content;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.flatMap(part => part && typeof part === 'object' && (part as { type?: string }).type === 'text' ? [String((part as { text?: unknown }).text ?? '')] : []).join('\n') : '';
    return text.trim() ? [text.trim()] : [];
  });
}

/* ───────────────────────────── names ───────────────────────────── */

export const row = (text: string, tone?: Row['tone'], bold = false, indent = 0): Row => ({ text, ...(tone ? { tone } : {}), ...(bold ? { bold } : {}), ...(indent ? { indent } : {}) });
const blank = (): Row => row('');

/**
 * Rows of result-text.ts as rows of the chat: the same words, painted by their role, `shift` columns further left (the
 * chat's summary stands under its action, not at a screen's margin); a wrapped line keeps its hanging column.
 */
export function feedRows(rows: readonly ResultRow[], shift = 0): Row[] {
  return rows.map(item => {
    if (item.role === 'blank' || !item.text) return blank();
    const indent = Math.max(0, item.indent - shift);
    return { text: item.text, role: item.role, ...(indent ? { indent } : {}), ...(item.hang ? { hang: indent + item.hang } : {}) };
  });
}

const SITUATIONS: [string, string, string] = ['ситуация', 'ситуации', 'ситуаций'];
const CONVERSATIONS: [string, string, string] = ['разговор', 'разговора', 'разговоров'];
const CONVERSATIONS_OF: [string, string, string] = ['разговора', 'разговоров', 'разговоров'];
const RUNS: [string, string, string] = ['прогон', 'прогона', 'прогонов'];

/** Long ago: measured from it, every date reads absolute («23 сент. в 14:05»), never «сегодня». */
const EPOCH = new Date(0);
/** «сегодня в 14:05»: how a run is named on screen. */
export const runWhen = (record: Pick<Experiment, 'createdAt'>, now?: Date): string => whenText(record.createdAt, now);
/** «23 сент. в 14:05»: how a run is named in a note the session keeps, which must not say «сегодня» tomorrow. */
export const runStamp = (record: Pick<Experiment, 'createdAt'>): string => whenText(record.createdAt, EPOCH);

/* ───────────────────────────── the run: plan, progress, stop ───────────────────────────── */

/** What a run will be: its situations and conversations, the judge's ceiling, what stays out of it. */
export interface LaunchPlan { situations: number; conversations: number; judgePerAttempt: number; judgeCalls: number; outside: string | null }

/**
 * The plan of the situations a record already holds — a repeat of an accepted set or a record made before
 * libraries. The judge votes twice on every expectation of every attempt (a first-format situation is judged
 * through its projection, one expectation per required checkpoint), before any re-ask of a malformed vote.
 */
export function scenarioPlan(record: Experiment): LaunchPlan {
  const attempts = (scenario: Experiment['scenarios'][number]) => record.settings.userModes.filter(mode => mode !== 'scripted' || scenario.user.script !== undefined).length * record.settings.repeats;
  const votes = (scenario: Experiment['scenarios'][number]) => 2 * assessmentRubrics(judgedScenario(scenario, {}), { events: [] }).length;
  return { situations: record.scenarios.length, conversations: plannedTrials(record), judgePerAttempt: Math.max(0, ...record.scenarios.map(votes)),
    judgeCalls: record.scenarios.reduce((sum, scenario) => sum + votes(scenario) * attempts(scenario), 0), outside: null };
}

/** What of a run's connection the chat's model, not the owner, wrote: said next to it in the run dialog. */
const PROPOSED: Record<RunnableTarget['kind'], string> = { command: 'команду предложила модель', module: 'модуль предложила модель', http: 'адрес предложила модель' };

/**
 * The agent of the run dialog: its name and, never hidden behind the name, what Lab will actually start — the command
 * with every argument word for word and its folder, the module and its function, the address — marked when the chat's
 * model proposed it rather than a connection the owner has; then the release hook the connection runs before every
 * run, word for word. An agent without a name of its own is named by exactly that.
 */
export function agentLines(record: Experiment, cwd?: string, proposed?: 'model'): string[] {
  const target = record.target;
  if (!isRunnable(target)) return [`Агент: ${agentLine(record, cwd)}`];
  const root = cwd ?? (target.kind === 'command' && target.cwd || '/');
  const how = target.kind === 'command' ? `${commandText(target.command, target.args, target.cwd ?? root)} ${folderText(target.cwd ?? root, root)}`
    : target.kind === 'module' ? `${targetLabel(target, root)}, функция ${target.exportName}` : shownAddress(target);
  const origin = proposed ? ` — ${PROPOSED[target.kind]}` : '';
  const own = agentOwnName(record), version = agentVersion(record);
  const versioned = version ? ` · версия ${version}` : '';
  return [
    ...own ? [`Агент: ${own}${versioned}`, `${target.kind === 'http' ? 'Адрес' : 'Запуск'}: ${how}${origin}`] : [`Агент: ${how}${versioned}${origin}`],
    ...target.release ? [`Перед прогоном Lab выполнит: ${releaseText(target.release, root)}`] : [],
  ];
}

const PATHS: [string, string, string] = ['путь', 'пути', 'путей'];

/**
 * Whether the run's number will be a percent (exam.ts): the connection's exam — `connection` when the project's
 * connection file brought it —, else plainly that without one, or with one that never checks the conversation's
 * memory, the result shows in how many situations the agent coped but no percent. `offered`: the dialog offers to
 * compose it first.
 */
function examLine(target: RunnableTarget, from: 'connection' | undefined, offered: boolean): string {
  const offer = offered ? ' Его можно сначала составить по коду агента.' : '';
  if (!target.exam) return `Без экзамена подключения процента не будет — Lab покажет, в скольких ситуациях агент справился, но не долю: не проверено, что через это подключение агент помнит разговор.${offer}`;
  if (!examShowsMemory(target.exam)) return `Экзамен подключения не проверяет память разговора — процента не будет: нужен путь из двух шагов и больше, где поздний шаг проверяет, что в ответе есть сказанное раньше.${offer}`;
  return `Экзамен подключения: ${countText(target.exam.length, PATHS)}${from === 'connection' ? ` из ${CONNECTION_FILE}` : ''} — Lab пройдёт его перед прогоном, без модели; не пройден — прогон не запустится.`;
}

/**
 * The run dialog (docs/design/ui-spec.md §4.6): what runs, the agent — what exactly Lab starts, and where Lab found it —,
 * whether the connection's exam lets the result show a percent, the judge's ceiling and next to it what the comparison
 * with production costs, the time limit, what stays out. `proposed`: the connection is the chat's model's, not one the
 * owner has; `exam`: where the connection's exam came from; `offerExam`: the dialog offers to compose one first.
 */
export function launchLines(record: Experiment, plan: LaunchPlan, cwd?: string,
  extra: { calibration?: string | null; note?: string; proposed?: 'model'; exam?: 'connection'; offerExam?: boolean } = {}): string[] {
  return [
    `${countText(plan.situations, SITUATIONS)} · ${countText(plan.conversations, CONVERSATIONS)}: клиента играет Lab, ответы агента оценивает судья.`,
    ...agentLines(record, cwd, extra.proposed),
    ...(isRunnable(record.target) ? [examLine(record.target, extra.exam, !!extra.offerExam)] : []),
    ...(extra.note ? [extra.note] : []),
    ...(record.mode === 'demo' ? ['Учебный пример: без модели и оплаты.'] : [`Судья: по 2 голоса на каждую проверку ответа и клиента — до ${plan.judgePerAttempt} вызовов на попытку, всего до ${plan.judgeCalls}.`,
      ...(extra.calibration ? [`${extra.calibration}.`] : []),
      `Займёт не больше ${Math.max(1, Math.round(record.settings.maxDurationMs / 60_000))} мин; платите только за то, что потрачено.`]),
    ...(plan.outside ? [`Не войдут: ${plan.outside}`] : []),
  ];
}

/** Minutes since `iso`, from 1: «2 мин». */
const minutesSince = (iso: string | null | undefined, now: number): string | undefined => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(at) ? undefined : `${Math.max(1, Math.round((now - at) / 60_000))} мин`;
};
/** Spending so far, only when there is some: «$0.14». */
const spent = (record: Experiment): string | undefined => record.mode !== 'demo' && record.usage.costUsd ? `$${record.usage.costUsd.toFixed(2)}` : undefined;

/**
 * The one progress row of long work (docs/design/ui-spec.md §4.6), from the stored record only — finished and planned
 * conversations, time, spending; nothing estimated. A preparation says how far it got: the topic map's step
 * while the logs' topics are mapped, then the conversations turned into situations.
 */
export function progressText(record: Experiment, now = Date.now()): string {
  if (record.phase === 'preparing') {
    const progress = record.preparationProgress;
    const total = progress ? progress.processed.length + progress.pending.length + progress.excluded.length : 0;
    const done = progress ? progress.processed.length + progress.excluded.length : 0;
    const step = total ? `разобрано ${done} из ${countText(total, CONVERSATIONS_OF)}` : oneLine(record.message);
    return [`Готовлю ситуации: ${step}`, minutesSince(record.createdAt, now), spent(record)].filter(Boolean).join(' · ');
  }
  // A check of the draft's situations, or values proposed for one of them: the line its work says.
  if (record.phase === 'checking') return [oneLine(record.message), spent(record)].filter(Boolean).join(' · ');
  const planned = plannedTrials(record), done = record.trials.length;
  return [`Прогон: ${done} из ${countText(planned, CONVERSATIONS_OF)}`, minutesSince(record.reviewedAt, now), spent(record)].filter(Boolean).join(' · ');
}

/** After a stop or an interruption: what is kept and what has to be run again. */
export function stoppedLines(record: Experiment): string[] {
  return [`Прогон остановлен: сохранено ${record.trials.length} из ${countText(plannedTrials(record), CONVERSATIONS_OF)}.`,
    'С места остановки не продолжить: «повтори прогон» запустит все разговоры заново.'];
}

/* ───────────────────────────── what exists ───────────────────────────── */

/** What `agent_lab_status` answers: the newest run in one phrase, every run on expand (newest first, by date and agent). */
export function statusFeed(records: Experiment[], active?: { id: string }, now?: Date): Feed {
  if (!records.length) return { rows: [row('Прогонов пока нет. Скажите, какого агента проверить и где лежат логи.', 'muted')], tone: 'success' };
  const sorted = [...records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const views = new Map(sorted.filter(record => record.trials.length).map(record => [record.id, buildResultView(record)]));
  const was = (record: Experiment) => {
    const parent = record.parentRunId && views.get(record.parentRunId);
    const value = parent ? accuracyParts(parent).value : null;
    return value ? ` (было ${value})` : '';
  };
  const line = (record: Experiment): Row => row(`${runWhen(record, now)} · ${agentLine(record)} · ${standing(record, views.get(record.id))}${was(record)}${record.id === active?.id ? ' · идёт сейчас' : ''}`,
    record.id === active?.id ? 'accent' : undefined);
  const latest = sorted[0]!;
  return { rows: [row(`${countText(records.length, RUNS)}: последний — ${runWhen(latest, now)}, ${agentLine(latest)}, ${standing(latest, views.get(latest.id))}${was(latest)}`, 'text', true)],
    more: sorted.slice(0, 40).map(line), expand: 'все прогоны' };
}

/* ───────────────────────────── one failure, one conversation ───────────────────────────── */

const OUTCOME_WORD: Record<string, string> = { pass: 'справился', fail: 'не справился', unknown: 'не измерено', invalid: 'не измерено', cancelled: 'остановлен', ungraded: 'без итоговой оценки' };
/** The judge's own reason: our fixed consensus sentence in front of it is bookkeeping, not the reason. */
const judgeReason = (rationale: string): string => oneLine(rationale.startsWith(AGREED_RATIONALE_PREFIX) ? rationale.slice(AGREED_RATIONALE_PREFIX.length) : rationale);

/** The turns of a recorded conversation, signed «Клиент» and «Агент» in one column; never the event numbers (docs/design/ui-spec.md §2). */
export function turnRows(trial: Trial, indent = 0): Row[] {
  return trialTurns(trial).map(turn => ({ text: turnText(turn), indent, hang: indent + TURN_HANG }));
}

/** Why a verdict the judge gave does not stand: its evidence channel does not support it, in the owner's words. */
const CHANNEL_GAP: Record<Expectation['observation'], string> = {
  reply: 'нет подтверждения в ответе агента', tool: 'нет подтверждения в журнале инструментов', state: 'нет подтверждения в состоянии системы',
};

/**
 * How a conversation was judged, the tools it called and the owner's marks: what ctrl+o opens under a conversation.
 * An expectation shows its verdict read through its evidence channel — the one the result counts — and says so
 * when that reading undid the judge's own word; the judge's reason stays beneath it.
 */
function judgedRows(record: Experiment, trial: Trial): Row[] {
  const scenario = record.scenarios.find(item => item.id === trial.scenarioId);
  const metrics = scenario ? judgedScenario(scenario, trial).metrics ?? [] : [];
  const rule = headlineRule(scenario, [trial]);
  const counted = new Map(rule.kind === 'expectations' ? rule.expectations.map(expectation => [expectation.id, expectation]) : []);
  const judged = metrics.flatMap(metric => {
    const assessment = trial.assessments?.find(item => item.metricId === metric.id);
    const expectation = counted.get(metric.id);
    const result = expectation ? recordedExpectationResult(trial, expectation) : assessment?.result;
    const gap = assessment && expectation && assessment.result !== 'unknown' && result === 'unknown' ? ` — ${CHANNEL_GAP[expectation.observation]}` : '';
    return [row(`${metric.name}: ${result ? `${OUTCOME_WORD[result] ?? result}${gap}` : 'оценки нет'}`, result === 'fail' ? 'error' : result === 'pass' ? 'success' : 'warning'),
      ...(assessment && judgeReason(assessment.rationale) ? [{ ...row(judgeReason(assessment.rationale), 'muted', false, 2) }] : [])];
  });
  const checks = trial.checks.map(check => row(`${check.passed ? 'выполнено' : 'не выполнено'}: ${check.description}`, check.passed ? 'success' : 'error'));
  const tools = trial.events.filter(event => event.type === 'tool_call').map(event => row(`вызвал ${event.tool ?? 'инструмент'}`, 'muted'));
  const human = (record.humanReviews ?? []).filter(item => item.trialId === trial.id).map(item => row(`${OUTCOME_WORD[item.verdict] ?? item.verdict}: ${oneLine(item.note)}`));
  return [
    ...(judged.length || checks.length ? [blank(), row('Как оценил судья', 'accent', true), ...judged, ...checks] : []),
    ...(tools.length ? [blank(), row('Инструменты агента', 'accent', true), ...tools] : []),
    ...(human.length ? [blank(), row('Ваши отметки', 'accent', true), ...human] : []),
  ];
}

/**
 * One failure (E7, docs/design/ui-spec.md §4.10): the situation, what was expected and what the agent said, the owner's rule
 * and whether the judge still waits for the owner's word; the whole conversation on expand.
 */
export function failureFeed(record: Experiment, view: ResultView, index: number): Feed | null {
  const failure = view.failures[index];
  if (!failure) return null;
  const rule = failure.violated ?? failure.rules[0];
  const unmarked = view.agreement.unmarked.includes(failure.trialId);
  const trial = record.trials.find(item => item.id === failure.trialId);
  return {
    tone: 'warning',
    // The agent's words are the reply the judge pointed at, else why none is quoted: a reply the judge never named is no evidence of the failure.
    rows: [row(`${GLYPH.fail} ${index + 1}  ${oneLine(failure.title)}`, 'error', true),
      row(`Ожидалось: ${failure.expected ?? 'не записано в ситуации'} · Агент: ${saidText(failure)}`),
      row(`Правило: ${rule ? `«${rule.quote}»` : noRuleText()}${unmarked ? ' · судья прав? да или нет' : ''}`, 'muted')],
    ...(trial ? { more: [row('Разговор', 'accent', true), ...turnRows(trial, 2), ...judgedRows(record, trial)], expand: 'весь разговор' } : {}),
  };
}

/** A recorded conversation: the situation and how it ended in the summary; the turns, the judge and the tools on expand. */
export function dialogueFeed(record: Experiment, trial: Trial): Feed {
  const scenario = record.scenarios.find(item => item.id === trial.scenarioId);
  const reply = trial.events.filter(event => event.type === 'assistant' && oneLine(event.text ?? '')).at(-1);
  const measured = trial.outcome === 'pass' || trial.outcome === 'fail' || trial.outcome === 'ungraded';
  return {
    tone: measured ? 'success' : 'warning',
    rows: [row(`${oneLine(scenario?.title ?? 'Ситуация')} — ${OUTCOME_WORD[trial.outcome] ?? trial.outcome}${record.settings.repeats > 1 ? ` · попытка ${trial.repeat + 1}` : ''}`, trial.outcome === 'fail' ? 'error' : undefined, true),
      ...(measured ? [] : [row(`Почему не измерено: ${oneLine(trial.reason)}`, 'warning')]),
      ...(reply ? [row(`Последний ответ агента: «${clip(oneLine(reply.text), 200)}»`, 'muted')] : [])],
    more: [...turnRows(trial), ...judgedRows(record, trial)], expand: 'весь разговор',
  };
}

/**
 * Before/after of a repeat, in the words of result-text.ts comparisonRows: the answer and how much of the set could be
 * compared in the summary; what broke, what was fixed, what could not be compared, the notes and the next step on expand.
 */
export function comparisonFeed(comparison: RunComparison, before: Pick<Experiment, 'createdAt' | 'targetVersion' | 'targetRelease'>, options: { now?: Date; selected?: boolean } = {}): Feed {
  const [lead, counts, ...rest] = feedRows(comparisonRows(comparison, before, { ...(options.now ? { now: options.now } : {}), ...(options.selected ? { selected: true } : {}) }));
  return {
    tone: comparison.comparable ? 'success' : 'warning',
    rows: [{ ...lead!, bold: true }, counts!],
    ...(rest.length ? { more: rest, expand: 'что изменилось' } : {}),
  };
}
