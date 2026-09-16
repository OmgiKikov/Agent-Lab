import { DEFAULT_GOAL_OBSERVATION, type GoalObservation, type Scenario, type Target } from './contracts.js';

/*
 * Defaults that decide whether two records describe the same thing. Nothing here performs I/O
 * or rewrites a stored record; callers get a copy for comparison or for a new draft, so legacy
 * evidence keeps its original bytes and its judge fingerprints.
 */

/** The channel an external agent is judged on when none was chosen; a sandbox card has none. */
export function goalObservationDefault(targetKind: Target['kind']): GoalObservation | undefined {
  return targetKind === 'sandbox' ? undefined : DEFAULT_GOAL_OBSERVATION;
}

/** The same object when it already names a channel or runs in the sandbox, otherwise a shallow copy with the default. */
export function withDefaultGoalObservation<T extends { goalObservation?: GoalObservation }>(scenario: T, targetKind: Target['kind']): T {
  const goalObservation = goalObservationDefault(targetKind);
  if (scenario.goalObservation !== undefined || goalObservation === undefined) return scenario;
  return { ...scenario, goalObservation };
}

/** Card identity for comparison only; never persisted. */
export function normalizeScenarioIdentity(scenario: Scenario, targetKind: Target['kind']): Scenario {
  return withDefaultGoalObservation(scenario, targetKind);
}
