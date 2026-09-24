import type { Experiment, Trial } from '../src/contracts.js';
import { assessmentRubrics } from '../src/contracts.js';
import type { RunComparison } from '../src/comparison.js';
import { plannedTrials } from '../src/run.js';
import { judgedScenario } from '../src/card/legacy-v1.js';
import { AGREED_RATIONALE_PREFIX } from '../src/judge.js';
import { buildResultView, type ResultView } from '../src/result-view.js';
import { accuracyParts, whenText } from '../src/result-text.js';
import { agentLine } from '../src/workspace.js';
import { countText } from '../src/plural.js';
import { clip, oneLine } from '../src/text.js';
import type { Feed } from './render/feed.ts';
import { GLYPH, type Row } from './render/theme.ts';

/*
 * The conversational surface of Agent Lab: what a chat request needs before it reaches the same
 * ExperimentLab operations the workspace and the CLI use, all pure:
 *
 *   the owner's own messages of the session ──► the words a wording must be found in verbatim
 *   a human reference to a run («второй прогон», task words) ──► one stored run, or candidates
 *   a stored record ──► the summary rows of one action in the chat, details on expand
 *
 * Situations themselves are drawn by the shared projection (src/card/view.ts), results by result-text.ts.
 * On screen a run is named by its date and its agent, never by an id (ui-spec §2).
 */

export { agentLine, agentName } from '../src/workspace.js';

const SPACED = new Set('«»"\'`.,;:!?()[]{}<>—–-'.split(''));
const fold = (value: string): string => {
  let out = '';
  for (const ch of value.toLocaleLowerCase('ru').replaceAll('ё', 'е')) out += SPACED.has(ch) || /\s/u.test(ch) ? ' ' : ch;
  return out.trim().split(' ').filter(Boolean).join(' ');
};

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

/* ───────────────────────────── references to runs ───────────────────────────── */

export type Resolved<T> = { kind: 'one'; item: T } | { kind: 'none' } | { kind: 'many'; items: T[] };
const pick = <T>(items: T[]): Resolved<T> => items.length === 1 ? { kind: 'one', item: items[0]! } : items.length ? { kind: 'many', items } : { kind: 'none' };

/** Match by exact id, id prefix, 1-based position, exact name, then a name fragment. */
function resolveBy<T>(items: T[], ref: string, id: (item: T) => string, name: (item: T) => string): Resolved<T> {
  const raw = ref.trim();
  if (!raw) return { kind: 'none' };
  const exact = items.filter(item => id(item) === raw);
  if (exact.length) return pick(exact);
  const position = /^#?(\d{1,3})$/.exec(raw);
  if (position) { const item = items[Number(position[1]) - 1]; return item ? { kind: 'one', item } : { kind: 'none' }; }
  if (/^[A-Za-z0-9_-]{6,80}$/.test(raw)) { const prefixed = items.filter(item => id(item).startsWith(raw)); if (prefixed.length) return pick(prefixed); }
  const wanted = fold(raw);
  const same = items.filter(item => fold(name(item)) === wanted);
  if (same.length) return pick(same);
  const part = items.filter(item => fold(name(item)).includes(wanted));
  return pick(part);
}
export const resolveRun = (records: Experiment[], ref: string) => resolveBy(records, ref, record => record.id, record => record.task);

/** What to tell the model when a reference does not name exactly one object. */
export function referenceProblem(what: string, ref: string, resolved: { kind: 'none' } | { kind: 'many'; items: unknown[] }, names: string[]): string {
  return resolved.kind === 'none'
    ? `${what} «${clip(ref, 80)}» не найдено. Есть: ${names.slice(0, 12).join('; ') || 'ничего'}. Уточните у владельца, что он имеет в виду.`
    : `${what} «${clip(ref, 80)}» подходит к нескольким: ${names.slice(0, 12).join('; ')}. Спросите владельца, какой из них нужен; не выбирайте сами.`;
}

/* ───────────────────────────── names ───────────────────────────── */

export const row = (text: string, tone?: Row['tone'], bold = false, indent = 0): Row => ({ text, ...(tone ? { tone } : {}), ...(bold ? { bold } : {}), ...(indent ? { indent } : {}) });
const blank = (): Row => row('');
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

/** The run dialog (ui-spec §4.6): what runs, the agent, the judge's ceiling and the limits, what stays out. */
export function launchLines(record: Experiment, plan: LaunchPlan, cwd?: string): string[] {
  return [
    `${countText(plan.situations, SITUATIONS)} · ${countText(plan.conversations, CONVERSATIONS)}: клиента играет Lab, ответы агента оценивает судья.`,
    `Агент: ${agentLine(record, cwd)}`,
    ...(record.mode === 'demo' ? ['Учебный пример: без модели и оплаты.'] : [`Судья: по 2 голоса на каждое ожидание — до ${plan.judgePerAttempt} вызовов на попытку, всего до ${plan.judgeCalls}.`,
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
 * The one progress row of long work (ui-spec §4.6), from the stored record only — finished and planned
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
  const planned = plannedTrials(record), done = record.trials.length;
  return [`Прогон: ${done} из ${countText(planned, CONVERSATIONS_OF)}`, minutesSince(record.reviewedAt, now), spent(record)].filter(Boolean).join(' · ');
}

/** After a stop or an interruption: what is kept and what has to be run again. */
export function stoppedLines(record: Experiment): string[] {
  return [`Прогон остановлен: сохранено ${record.trials.length} из ${countText(plannedTrials(record), CONVERSATIONS_OF)}.`,
    'С места остановки не продолжить: «повтори прогон» запустит все разговоры заново.'];
}

/* ───────────────────────────── what exists ───────────────────────────── */

/** A run in one phrase: its result, or where it stands. */
function standing(record: Experiment, view?: ResultView): string {
  if (record.trials.length && view) {
    const { value, tail } = accuracyParts(view);
    return value ? `точность ${value}` : tail;
  }
  if (record.phase === 'preparing') return 'ситуации готовятся';
  if (record.phase === 'evaluating') return `идёт прогон: ${record.trials.length} из ${countText(plannedTrials(record), CONVERSATIONS_OF)}`;
  const library = record.librarySnapshot;
  const size = library?.formatVersion === 2 ? library.cards.length : library?.formatVersion === 1 ? library.variants.length : record.scenarios.length;
  if (record.phase === 'review') return `ситуации: ${size}${library?.acceptance ? ', утверждены' : ''}`;
  return record.phase === 'error' || record.phase === 'interrupted' || record.phase === 'cancelled' ? 'остановлен до результата' : `ситуации: ${size}`;
}

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

/** The turns of a recorded conversation, signed «Клиент» and «Агент» in one column; never the event numbers (ui-spec §2). */
export function turnRows(trial: Trial, indent = 0): Row[] {
  return trial.events.filter(event => (event.type === 'user' || event.type === 'assistant') && oneLine(event.text ?? ''))
    .map(event => ({ text: `${(event.type === 'user' ? 'Клиент' : 'Агент').padEnd(9)}${oneLine(event.text)}`, indent, hang: indent + 9 }));
}

/** How a conversation was judged, the tools it called and the owner's marks: what ctrl+o opens under a conversation. */
function judgedRows(record: Experiment, trial: Trial): Row[] {
  const scenario = record.scenarios.find(item => item.id === trial.scenarioId);
  const metrics = scenario ? judgedScenario(scenario, trial).metrics ?? [] : [];
  const judged = metrics.flatMap(metric => {
    const assessment = trial.assessments?.find(item => item.metricId === metric.id);
    return [row(`${metric.name}: ${assessment ? OUTCOME_WORD[assessment.result] ?? assessment.result : 'оценки нет'}`, assessment?.result === 'fail' ? 'error' : assessment?.result === 'pass' ? 'success' : 'warning'),
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
 * One failure (E7, ui-spec §4.10): the situation, what was expected and what the agent said, the owner's rule
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
    rows: [row(`${GLYPH.fail} ${index + 1}  ${oneLine(failure.title)}`, 'error', true),
      row(`Ожидалось: ${failure.expected ?? 'не записано в ситуации'} · Агент: ${failure.said ? `«${failure.said.quote}»` : 'ответ не подтверждён цитатой'}`),
      row(`${rule ? `Правило: «${rule.quote}»` : 'У ситуации нет правила из ваших материалов'}${unmarked ? ' · судья прав? да или нет' : ''}`, 'muted')],
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

/** Before/after of a repeat: what was fixed, what broke, and how much of the set could be compared at all. */
export function comparisonFeed(comparison: RunComparison, before: Pick<Experiment, 'createdAt'>, now?: Date): Feed {
  const coverage = comparison.coverage;
  const more = [
    ...comparison.fixed.map(item => row(`исправлено: ${oneLine(item.title)}`, 'success')),
    ...comparison.regressed.map(item => row(`сломалось: ${oneLine(item.title)}`, 'error')),
    ...comparison.incomparable.map(item => row(`несравнимо: ${oneLine(item.title)} — ${oneLine(item.reason)}`, 'warning')),
    ...comparison.notes.map(note => row(note, 'muted')),
  ];
  return {
    tone: comparison.comparable ? 'success' : 'warning',
    rows: [row(`Сравнение с прогоном ${runWhen(before, now)}: ${comparison.headline}`, comparison.comparable ? 'text' : 'warning', true),
      row(`Сравнимо ${coverage.validPairs} из ${countText(coverage.plannedPairs, CONVERSATIONS_OF)} · исправлено ${comparison.fixed.length} · сломалось ${comparison.regressed.length} · без изменений ${comparison.unchanged.passing + comparison.unchanged.failing}`, 'muted')],
    ...(more.length ? { more, expand: 'что изменилось' } : {}),
  };
}
