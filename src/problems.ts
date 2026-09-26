import type { Experiment } from './contracts.js';
import { situationViews } from './card/view.js';
import { countText, pluralForm } from './plural.js';
import { NOT_MEASURED_SIDE, type ResultView } from './result-view.js';
import type { NotMeasuredCode } from './run.js';
import { oneLine } from './text.js';
import type { AnalysisView } from './discover/view.js';
import { problemTitle } from './discover/text.js';

/*
 * «Проблемы» (docs/design/ui-spec.md §8.6): what repeats, not a one-off error — the same cause in two or more situations of the
 * newest run, or a situation that keeps failing run after run. A problem in the agent is a cause of its failures;
 * a problem in the test is the customer Lab plays leaving the situation, so the conversation cannot be judged.
 * Every observation is a verified quote of the recorded reply the judge pointed at (explain.ts `said`) — a reply it did
 * not point at proves nothing about the failure and is never an observation; nothing here is guessed — a hypothesis and a
 * way to check it need the failure analysis, which is a separate step. Pure: from stored results only.
 *
 *   newest run: causes ×2+ situations ─┐
 *   a failure that repeats in a row  ──┼──► Problem { side, situations, runs in a row, observations }
 *   the customer left the situation  ──┘
 *
 * The same section holds what an analysis of the logs found (DISCOVER): a violation of the owner's rule in real
 * conversations, with how many of the conversations it was checked on it broke — `origin` says so. It need not repeat:
 * one conversation where the agent broke a rule is already worth the owner's look.
 */

export interface Problem {
  key: string;
  side: 'agent' | 'test';
  title: string;
  situations: { scenarioId: string; title: string }[];
  /** How many of the newest runs, one after another, it showed up in. */
  runsInRow: number;
  topics: string[];
  /** The agent's own words in the newest run that the judge pointed at, each checked against the recorded reply. */
  observations: { quote: string; title: string }[];
  /** A conversation of the newest run that shows it; for a problem from the logs, the analysis. */
  runId: string; trialId?: string;
  /** A problem found in the logged conversations (DISCOVER): its analysis, and in how many of the conversations it was checked on it broke. */
  origin?: { kind: 'logs'; analysisId: string; violations: number; checked: number };
}

export interface ProblemRun { record: Experiment; view: ResultView }

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
    // A failed situation can have a different cause in the next run. Only claim that this cause recurred
    // when the previous result names the same cause on at least one of the same situations.
    const runsInRow = inRow(runs, run => run.view.topCauses.some(previous => previous.name === cause.name
      && previous.scenarioIds.some(id => cause.scenarioIds.includes(id))));
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
    // The customer Lab plays left the situation: the test, not the agent, has to change.
    if (NOT_MEASURED_SIDE[reason.code] !== 'client') continue;
    const runsInRow = inRow(runs, run => unmeasuredBy(run, reason.code, reason.scenarioIds));
    if (reason.scenarioIds.length < 2 && runsInRow < 2) continue;
    problems.push({ key: `test:${reason.code}`, side: 'test', title: reason.label.charAt(0).toLocaleUpperCase('ru') + reason.label.slice(1), situations: situations(reason.scenarioIds),
      runsInRow, topics: topics(reason.scenarioIds), observations: [], runId: record.id, ...(trialOf(reason.scenarioIds[0]) ? { trialId: trialOf(reason.scenarioIds[0])! } : {}) });
  }
  return problems;
}

/** The violations the newest analysis of the logs found, as problems of the section; none without one. */
export function logProblems(view: AnalysisView | undefined): Problem[] {
  if (!view) return [];
  return view.problems.map(problem => ({ key: `logs:${problem.key}`, side: 'agent' as const, title: oneLine(problemTitle(problem)), situations: [], runsInRow: 1, topics: problem.topics,
    observations: problem.examples.flatMap(example => example.quotes.filter(quote => quote.role === 'agent').slice(0, 1).map(quote => ({ quote: oneLine(quote.quote), title: `разговор ${example.dialogueId} из логов` }))),
    runId: view.id, origin: { kind: 'logs' as const, analysisId: view.id, violations: problem.violations, checked: problem.checked } }));
}

/** «2 ситуации · 2 прогона подряд» — the size of a problem in one phrase. */
export function problemSize(problem: Problem): string {
  if (problem.origin) return `${problem.origin.violations} из ${countText(problem.origin.checked, ['разговора', 'разговоров', 'разговоров'])} логов`;
  const runs = problem.runsInRow > 1 ? ` · ${problem.runsInRow} ${pluralForm(problem.runsInRow, ['прогон', 'прогона', 'прогонов'])} подряд` : '';
  return `${countText(problem.situations.length, ['ситуация', 'ситуации', 'ситуаций'])}${runs}`;
}

/** «3 повторяющиеся проблемы: 2 в агенте, 1 в тесте» — the answer of the problems' screen. */
export function problemsLine(problems: readonly Problem[]): string {
  if (!problems.length) return 'Повторяющихся проблем нет: разовые ошибки — в «Прогонах».';
  const logs = problems.filter(problem => problem.origin).length;
  if (logs === problems.length) return `${countText(logs, ['нарушение правил', 'нарушения правил', 'нарушений правил'])} в логах — по последнему разбору`;
  const agent = problems.filter(problem => problem.side === 'agent').length;
  const test = problems.length - agent;
  const parts = [agent ? `${agent} в агенте` : '', test ? `${test} в тесте` : ''].filter(Boolean).join(', ');
  const noun: [string, string, string] = logs ? ['проблема', 'проблемы', 'проблем'] : ['повторяющаяся проблема', 'повторяющиеся проблемы', 'повторяющихся проблем'];
  return `${countText(problems.length, noun)}: ${parts}${logs ? `; из них по логам — ${logs}` : ''}`;
}
