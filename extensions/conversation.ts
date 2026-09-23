import type { Experiment, Trial } from '../src/contracts.js';
import { assessmentRubrics } from '../src/contracts.js';
import type { RunComparison } from '../src/comparison.js';
import { plannedTrials } from '../src/run.js';
import { judgedScenario } from '../src/card/legacy-v1.js';
import type { ResultView } from '../src/result-view.js';
import { failureRows } from '../src/result-text.js';
import { countText } from '../src/plural.js';
import { clip, shortId } from '../src/text.js';
import { GLYPH, type Row } from './render/theme.ts';
import { costText } from './flow.ts';

/*
 * The conversational surface of Agent Lab: what a chat request needs before it reaches the same
 * ExperimentLab operations the board and the CLI use, all pure:
 *
 *   the owner's own messages of the session ──► the words a wording must be found in verbatim
 *   a human reference to a run («второй прогон», a short id, task words) ──► one stored run, or candidates
 *   a stored record ──► short rows for the chat feed, details on expand
 *
 * Situations themselves are drawn by the shared projection (src/card/view.ts). Nothing here writes
 * state or keeps its own copy of it.
 */

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

/* ───────────────────────────── feed rows ───────────────────────────── */

export const row = (text: string, tone?: Row['tone'], bold = false, indent = 0): Row => ({ text, ...(tone ? { tone } : {}), ...(bold ? { bold } : {}), ...(indent ? { indent } : {}) });
const blank = (): Row => row('');
const SITUATIONS: [string, string, string] = ['ситуация', 'ситуации', 'ситуаций'];
const CONVERSATIONS: [string, string, string] = ['разговор', 'разговора', 'разговоров'];
const phaseWord: Record<string, string> = {
  preparing: 'готовится', review: 'черновик', evaluating: 'идёт прогон', results_review: 'есть результат', complete: 'разбор завершён',
  cancelled: 'остановлен', error: 'ошибка', interrupted: 'прерван', baseline: 'идёт прогон', improving: 'идёт прогон', control: 'идёт прогон',
};

export interface Feed { rows: Row[]; more?: Row[] }

export const targetText = (record: Experiment): string => record.target.kind === 'sandbox' ? 'учебная песочница' : record.target.kind === 'http' ? record.target.url
  : record.target.kind === 'module' ? record.target.path : [record.target.command, ...record.target.args].join(' ');

/** A path inside the project reads relative to it; anything else stays as written. */
const projectPath = (text: string, cwd?: string): string => cwd && text.includes(`${cwd}/`) ? text.replaceAll(`${cwd}/`, '') : text;

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

/** The confirmation of a run (ui-spec §4.6): what runs, the agent, the judge's ceiling and the limits, what stays out. */
export function launchLines(record: Experiment, plan: LaunchPlan, cwd?: string): string[] {
  const left = Math.max(0, record.settings.maxCalls - record.usage.calls);
  return [
    `${countText(plan.situations, SITUATIONS)} · ${countText(plan.conversations, CONVERSATIONS)}: клиента играет Lab, ответы агента оценивает судья.`,
    `Агент: ${projectPath(targetText(record), cwd)}${record.targetVersion ? ` · версия ${record.targetVersion}` : ''}`,
    ...(record.mode === 'demo' ? ['Учебный пример: без модели и оплаты.'] : [`Судья: по 2 голоса на каждое ожидание — до ${plan.judgePerAttempt} вызовов на попытку, всего до ${plan.judgeCalls}.`,
      `Лимиты: осталось ${left} вызовов модели, до ${Math.round(record.settings.maxDurationMs / 60_000)} мин; стоимость заранее неизвестна.`]),
    ...(plan.outside ? [`Не войдут: ${plan.outside}`] : []),
  ];
}

/** Progress from the stored record only: finished, planned, unusable attempts and spending. Nothing is estimated. */
export function progressLines(record: Experiment): string[] {
  const planned = plannedTrials(record), done = record.trials.length;
  const unusable = record.trials.filter(trial => trial.outcome === 'invalid' || trial.outcome === 'cancelled').length;
  const cost = costText(record);
  if (record.phase === 'preparing') return [`Подготовка ${shortId(record.id)} · вызовов модели ${record.usage.calls} из ${record.settings.maxCalls}`, clip(record.message, 160)];
  return [`Прогон ${shortId(record.id)} · ${done} из ${planned} диалогов завершено${unusable ? ` · непригодных ${unusable}` : ''} · вызовов ${record.usage.calls} из ${record.settings.maxCalls} · ${cost}`,
    ...(record.message ? [clip(record.message, 160)] : [])];
}

/** After a stop or an interruption: what is kept and what has to be run again. */
export function stoppedLines(record: Experiment): string[] {
  const planned = plannedTrials(record), done = record.trials.length;
  return [`Прогон ${shortId(record.id)} остановлен: сохранено ${done} из ${planned} диалогов. Сохранённые диалоги и оценки можно смотреть.`,
    'Продолжить этот прогон с места остановки нельзя. «Повтори набор» создаст новый черновик тех же карточек; в нём все попытки выполняются заново.'];
}

/** The run list of `agent_lab_status`: newest first, one row per run. */
export function statusFeed(records: Experiment[], active?: { id: string }): Feed {
  if (!records.length) return { rows: [row('Прогонов пока нет. Скажите, какого агента проверить и где лежат логи.', 'muted')] };
  const sorted = [...records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const line = (record: Experiment): Row => {
    const library = record.librarySnapshot;
    const size = countText(library?.formatVersion === 2 ? library.cards.length : library?.formatVersion === 1 ? library.variants.length : record.scenarios.length, SITUATIONS);
    const tail = record.trials.length ? ` · ${record.trials.length} из ${plannedTrials(record)} разговоров` : library?.acceptance ? ' · утверждены' : '';
    // A repeat is named by the run it repeats, so a chain of reruns of one set does not print the same task five times.
    const about = record.parentRunId ? `повтор ${shortId(record.parentRunId)}${record.targetVersion ? ` · версия ${clip(record.targetVersion, 30)}` : ''}` : clip(record.task, 70);
    return row(`${shortId(record.id)} · ${phaseWord[record.phase] ?? record.phase}${record.id === active?.id ? ' (в этой сессии)' : ''} · ${size}${tail} · ${about}`,
      record.id === active?.id ? 'accent' : record.phase === 'error' ? 'error' : undefined, false, 1);
  };
  return { rows: [row(`Прогонов: ${records.length}`, 'text', true), ...sorted.slice(0, 5).map(line), ...(sorted.length > 5 ? [row(`…и ещё ${sorted.length - 5}`, 'muted', false, 1)] : [])], more: sorted.slice(5, 40).map(line) };
}

const ROLE_WORD: Record<string, string> = { user: 'Клиент', assistant: 'Агент', simulator: 'Симулятор', observation: 'Наблюдение', retrieval: 'Контекст RAG', tool_call: 'Вызов', tool_result: 'Результат', error: 'Ошибка' };
const OUTCOME_WORD: Record<string, string> = { pass: 'справился', fail: 'не справился', unknown: 'неясно', invalid: 'тест непригоден', cancelled: 'остановлен', ungraded: 'без итоговой оценки' };

/** One failure on one screen (E7): expected → the agent's words → the owner's rule → the conversation; tools, checks and the judge's reasons on expand. */
export function failureFeed(record: Experiment, view: ResultView, index: number): Feed | null {
  const failure = view.failures[index];
  if (!failure) return null;
  const rows: Row[] = failureRows(view, record, index).map(item => ({ text: item.right ? `${item.text} · ${item.right}` : item.text, role: item.role, ...(item.indent ? { indent: item.indent } : {}) }));
  const trial = record.trials.find(item => item.id === failure.trialId);
  return trial ? { rows, more: dialogueFeed(record, trial).more } : { rows };
}

/** A recorded dialogue: client and agent turns in the feed; tool calls, checks and the judge's reasons on expand. */
export function dialogueFeed(record: Experiment, trial: Trial): Feed {
  const scenario = record.scenarios.find(item => item.id === trial.scenarioId);
  const rows: Row[] = [row(`${scenario?.title ?? trial.scenarioId} — ${OUTCOME_WORD[trial.outcome] ?? trial.outcome} · попытка ${trial.repeat + 1}`, trial.outcome === 'pass' ? 'success' : trial.outcome === 'fail' ? 'error' : 'warning', true)];
  for (const event of trial.events) if (['user', 'assistant', 'error'].includes(event.type) && event.text !== undefined) {
    rows.push(row(`#${event.seq} ${ROLE_WORD[event.type]}: ${event.text}`, event.type === 'user' ? 'accent' : event.type === 'error' ? 'error' : undefined, false, 1));
  }
  if (trial.outcome === 'invalid' || trial.outcome === 'cancelled') rows.push(row(`Почему не измерено: ${trial.reason}`, 'warning', false, 1));
  const more: Row[] = [row('Решение судьи', 'accent', true)];
  for (const metric of scenario?.metrics ?? []) {
    const assessment = trial.assessments?.find(item => item.metricId === metric.id);
    more.push(row(`${metric.name}: ${assessment ? OUTCOME_WORD[assessment.result] ?? assessment.result : 'оценки нет'}`, assessment?.result === 'fail' ? 'error' : assessment?.result === 'pass' ? 'success' : 'warning', false, 1),
      ...(assessment ? [row(`${assessment.rationale}${assessment.evidence.length ? ` (реплики ${assessment.evidence.map(seq => `#${seq}`).join(', ')})` : ''}`, 'muted', false, 3)] : []));
  }
  for (const check of trial.checks) more.push(row(`${check.passed ? GLYPH.pass : GLYPH.fail} ${check.description}`, check.passed ? 'success' : 'error', false, 1), row(check.evidence, 'muted', false, 3));
  const hidden = trial.events.filter(event => !['user', 'assistant', 'error'].includes(event.type));
  if (hidden.length) more.push(blank(), row('Инструменты и наблюдения', 'accent', true), ...hidden.map(event =>
    row(`#${event.seq} ${ROLE_WORD[event.type] ?? event.type}${event.tool ? ` ${event.tool}` : ''}: ${clip(event.text ?? JSON.stringify(event.args ?? event.result ?? event.state ?? ''), 400)}`, 'muted', false, 1)));
  const human = (record.humanReviews ?? []).filter(item => item.trialId === trial.id);
  if (human.length) more.push(blank(), row('Отметки человека', 'accent', true), ...human.map(item => row(`${OUTCOME_WORD[item.verdict] ?? item.verdict}: ${item.note}`, undefined, false, 1)));
  return { rows, more };
}

/** Before/after of a repeat: what was fixed, what broke, and how much of the set could be compared at all. */
export function comparisonFeed(comparison: RunComparison, beforeId: string): Feed {
  const coverage = comparison.coverage;
  const rows: Row[] = [row(`Сравнение с прогоном ${shortId(beforeId)}: ${comparison.headline}`, comparison.comparable ? 'text' : 'warning', true),
    row(`Сопоставлено пар: ${coverage.validPairs} из ${coverage.plannedPairs}${coverage.excludedPairs ? ` · исключено ${coverage.excludedPairs}` : ''}`, 'muted', false, 1),
    ...comparison.fixed.map(item => row(`+ исправлено: ${item.title}`, 'success', false, 1)),
    ...comparison.regressed.map(item => row(`- сломалось: ${item.title}`, 'error', false, 1)),
    row(`Без изменений: проходят ${comparison.unchanged.passing}, не проходят ${comparison.unchanged.failing}`, 'muted', false, 1)];
  const more = [...comparison.incomparable.map(item => row(`/ несравнимо: ${item.title} — ${item.reason}`, 'warning', false, 1)), ...comparison.notes.map(note => row(note, 'muted', false, 1))];
  return { rows, ...(more.length ? { more } : {}) };
}

