import { libraryHash } from './scenario-library.js';
import { DEFAULT_GOAL_OBSERVATION, DEFAULT_JUDGE, fingerprint, type Experiment, type GoalObservation, type Scenario, type Settings, type SourceIdentity, type Target } from './contracts.js';

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

/** The judge a run is configured with, as the runtime resolves it: an explicit role wins over `settings.judge`. */
export function judgeSettingsIdentity(settings: Settings): string {
  const judge = settings.roles?.judge ?? settings.judge ?? { provider: settings.provider, model: settings.model };
  const upstream = settings.roles?.judge ? undefined : settings.judge?.upstream;
  return fingerprint({ provider: judge.provider, model: judge.model, upstream: upstream ?? null });
}

/** The agent definition a run evaluated; a sandbox agent is not part of `target`. */
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

/**
 * Settings of a score run, shared by the CLI and Pi so the same dialogues get the same budget, judge and timeout.
 * The budget grows with the number of recorded dialogues; the owner's explicit values win.
 * `repeats: 1` and `userModes: ['scripted']` are forced last: they describe how imported recordings were made
 * (one scripted attempt each), not an owner choice, and `goalCardOutcome` needs them to count a judged card.
 */
export function scoreSettings(dialogueCount: number, supplied: Partial<Settings>, mode: 'live' | 'demo'): Partial<Settings> {
  return {
    maxCalls: Math.min(3000, Math.max(20, 8 * dialogueCount)),
    maxDurationMs: Math.min(14_400_000, Math.max(180_000, 120_000 * dialogueCount)),
    timeoutMs: 600_000,
    ...(mode === 'live' ? { judge: { ...DEFAULT_JUDGE } } : {}),
    ...supplied,
    repeats: 1,
    userModes: ['scripted'],
  };
}

/** Exact target identity for scoped defect closure; never assume revision zero. */
export function resolutionTargetIdentity(record: Experiment, revisionId = record.selectedRevisionId ?? record.revisions[0]?.id): string {
  const revision = record.revisions.find(r => r.id === revisionId);
  if (!revision) throw new Error('Не найдена точная версия агента.');
  return fingerprint({ target: record.target, targetFingerprint: record.targetFingerprint, targetVersion: record.targetVersion, revision: revision.spec });
}
