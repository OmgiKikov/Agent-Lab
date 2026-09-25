import { libraryHash } from './scenario-library.js';
import { DEFAULT_GOAL_OBSERVATION, fingerprint, type Experiment, type GoalObservation, type Scenario, type Settings, type SourceIdentity, type Target } from './contracts.js';
import { roleChoices } from './llm/models.js';

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

/** The judge a run is configured with, as the runtime resolves it (roleChoices). The fingerprint is stored in derived records: its fields never change. */
export function judgeSettingsIdentity(settings: Settings): string {
  const { judge, judgeUpstream } = roleChoices(settings);
  return fingerprint({ provider: judge.provider, model: judge.model, upstream: judgeUpstream ?? null });
}

/** The agent definition a run evaluated: the label of an external agent, or the built-in agent of a stored sandbox run, which `target` does not name. */
export function agentIdentity(record: Experiment): string {
  return fingerprint(record.revisions[0]?.spec ?? null);
}

/** The identity a derived record keeps of its source run, for the scenarios it carries. */
export function sourceIdentity(record: Experiment, scenarioIds: string[]): SourceIdentity {
  const selected = new Set(scenarioIds);
  return {
    ...(record.targetFingerprint ? { targetFingerprint: record.targetFingerprint } : {}),
    ...(record.targetVersion ? { targetVersion: record.targetVersion } : {}),
    ...(record.evaluatorVersion ? { evaluatorVersion: record.evaluatorVersion } : {}),
    manifestHash: record.manifestHash,
    ...(record.librarySnapshot ? { libraryHash: libraryHash(record.librarySnapshot) } : {}),
    ...(record.originalImport ? { importHash: record.originalImport.contentHash } : {}),
    agent: agentIdentity(record),
    judge: judgeSettingsIdentity(record.settings),
    scenarios: Object.fromEntries(record.scenarios.filter(scenario => selected.has(scenario.id))
      .map(scenario => [scenario.id, fingerprint(normalizeScenarioIdentity(scenario, record.target.kind))])),
  };
}
