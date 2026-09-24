import type { Experiment } from './contracts.js';
import { situationViews } from './card/view.js';
import { countText, pluralForm } from './plural.js';
import type { ResultView } from './result-view.js';
import type { NotMeasuredCode } from './run.js';
import { oneLine } from './text.js';

/*
 * «Проблемы» (docs/design/ui-spec.md §8.6): what repeats, not a one-off error — the same cause in two or more situations of the
 * newest run, or a situation that keeps failing run after run. A problem in the agent is a cause of its failures;
 * a problem in the test is the customer Lab plays leaving the situation, so the conversation cannot be judged.
 * Every observation is a verified quote of the agent's recorded reply; nothing here is guessed — a hypothesis and a
 * way to check it need the failure analysis, which is a separate step. Pure: from stored results only.
 *
 *   newest run: causes ×2+ situations ─┐
 *   a failure that repeats in a row  ──┼──► Problem { side, situations, runs in a row, observations }
 *   the customer left the situation  ──┘
 */

export interface Problem {
  key: string;
  side: 'agent' | 'test';
  title: string;
  situations: { scenarioId: string; title: string }[];
  /** How many of the newest runs, one after another, it showed up in. */
  runsInRow: number;
  topics: string[];
  /** The agent's own words in the newest run, each checked against the recorded reply. */
  observations: { quote: string; title: string }[];
  /** A conversation of the newest run that shows it. */
  runId: string; trialId?: string;
}

export interface ProblemRun { record: Experiment; view: ResultView }

/** The customer Lab plays left the situation: the test, not the agent, has to change. */
const TEST_SIDE: readonly NotMeasuredCode[] = ['simulator_deviated', 'simulator_unclear', 'simulator_error', 'turn_limit'];

/** Runs from the newest on, one after another, in which `hit` holds; the newest always counts. */
function inRow(runs: readonly ProblemRun[], hit: (run: ProblemRun) => boolean): number {
  let count = 1;
  while (count < runs.length && hit(runs[count]!)) count++;
  return count;
}

const failed = (run: ProblemRun, ids: readonly string[]) => run.view.failures.some(failure => ids.includes(failure.scenarioId));
const unmeasuredBy = (run: ProblemRun, code: NotMeasuredCode, ids: readonly string[]) =>
  run.view.notMeasured.reasons.some(reason => reason.code === code && reason.scenarioIds.some(id => ids.includes(id)));

/** The problems the newest run shows; `runs` are one agent's finished runs, newest first. */
export function recurringProblems(runs: readonly ProblemRun[]): Problem[] {
  const newest = runs[0];
  if (!newest) return [];
  const { record, view } = newest;
  const titles = new Map(view.cards.map(card => [card.scenarioId, oneLine(card.title)]));
  const topicOf = new Map(situationViews(record, { maxTurns: record.settings.maxTurns }).flatMap(item => item.topic ? [[item.id, item.topic] as const] : []));
  const situations = (ids: readonly string[]) => ids.map(id => ({ scenarioId: id, title: titles.get(id) ?? id }));
  const topics = (ids: readonly string[]) => [...new Set(ids.flatMap(id => topicOf.get(id) ?? []))];
  const trialOf = (id: string | undefined) => record.trials.find(trial => trial.scenarioId === id)?.id;
  const problems: Problem[] = [];
  const explained = new Set<string>();
  for (const cause of view.topCauses) {
    const runsInRow = inRow(runs, run => failed(run, cause.scenarioIds));
    if (cause.scenarioIds.length < 2 && runsInRow < 2) continue;
    cause.scenarioIds.forEach(id => explained.add(id));
    const observations = cause.scenarioIds.flatMap(id => {
      const failure = view.failures.find(item => item.scenarioId === id);
      return failure?.said ? [{ quote: oneLine(failure.said.quote), title: oneLine(failure.title) }] : [];
    });
    problems.push({ key: `agent:${cause.name}`, side: 'agent', title: oneLine(cause.name), situations: situations(cause.scenarioIds), runsInRow,
      topics: topics(cause.scenarioIds), observations, runId: record.id, ...(trialOf(cause.scenarioIds[0]) ? { trialId: trialOf(cause.scenarioIds[0])! } : {}) });
  }
  // A failure no repeating cause explains is still a problem when it repeats run after run.
  for (const failure of view.failures) {
    if (explained.has(failure.scenarioId)) continue;
    const runsInRow = inRow(runs, run => failed(run, [failure.scenarioId]));
    if (runsInRow < 2) continue;
    problems.push({ key: `agent:${failure.scenarioId}`, side: 'agent', title: `Не справляется: ${oneLine(failure.title)}`, situations: situations([failure.scenarioId]), runsInRow,
      topics: topics([failure.scenarioId]), observations: failure.said ? [{ quote: oneLine(failure.said.quote), title: oneLine(failure.title) }] : [],
      runId: record.id, trialId: failure.trialId });
  }
  for (const reason of view.notMeasured.reasons) {
    if (!TEST_SIDE.includes(reason.code)) continue;
    const runsInRow = inRow(runs, run => unmeasuredBy(run, reason.code, reason.scenarioIds));
    if (reason.scenarioIds.length < 2 && runsInRow < 2) continue;
    problems.push({ key: `test:${reason.code}`, side: 'test', title: reason.label.charAt(0).toLocaleUpperCase('ru') + reason.label.slice(1), situations: situations(reason.scenarioIds),
      runsInRow, topics: topics(reason.scenarioIds), observations: [], runId: record.id, ...(trialOf(reason.scenarioIds[0]) ? { trialId: trialOf(reason.scenarioIds[0])! } : {}) });
  }
  return problems;
}

/** «2 ситуации · 2 прогона подряд» — the size of a problem in one phrase. */
export function problemSize(problem: Problem): string {
  const runs = problem.runsInRow > 1 ? ` · ${problem.runsInRow} ${pluralForm(problem.runsInRow, ['прогон', 'прогона', 'прогонов'])} подряд` : '';
  return `${countText(problem.situations.length, ['ситуация', 'ситуации', 'ситуаций'])}${runs}`;
}

/** «3 повторяющиеся проблемы: 2 в агенте, 1 в тесте» — the answer of the problems' screen. */
export function problemsLine(problems: readonly Problem[]): string {
  if (!problems.length) return 'Повторяющихся проблем нет: разовые ошибки — в «Прогонах».';
  const agent = problems.filter(problem => problem.side === 'agent').length;
  const test = problems.length - agent;
  const parts = [agent ? `${agent} в агенте` : '', test ? `${test} в тесте` : ''].filter(Boolean).join(', ');
  return `${countText(problems.length, ['повторяющаяся проблема', 'повторяющиеся проблемы', 'повторяющихся проблем'])}: ${parts}`;
}
