import { randomUUID } from 'node:crypto';
import { VERSION, emptyUsage, fingerprint, materialSources, type CreateInput, type Experiment, type Revision } from '../contracts.js';
import { withDefaultGoalObservation } from '../normalize.js';
import { evaluatorVersion } from '../pi.js';
import type { Budget } from './operation.js';

/*
 * A record's identity and how records are made: the three hashes a record is sealed by, a new draft from the owner's
 * input, and a fresh draft copied from an earlier record — the only ways a record comes into being besides a stored
 * file. Every hash here is stored in records and receipts: its fields and their names never change.
 */

/** What the owner confirms before a run: the whole draft as it will be measured. */
export function draftHash(record: Experiment): string {
  return fingerprint({ task: record.task, workflow: record.workflow, mode: record.mode, sources: record.sources,
    settings: record.settings, target: record.target, requirements: record.requirements, questions: record.questions,
    goldenCases: record.goldenCases, dialogues: record.dialogues, profiles: record.profiles, notes: record.notes,
    scenarios: record.scenarios, agent: record.revisions[0]?.spec, positiveControlScenarioIds: record.positiveControlScenarioIds,
    ownerExpectationScenarioIds: record.ownerExpectationScenarioIds,
    librarySnapshot: record.librarySnapshot, originalImport: record.originalImport, generatorConfig:record.generatorConfig,generatorIdentity:record.generatorIdentity,
    targetVersion: record.targetVersion, targetFingerprint: record.targetFingerprint, evaluatorVersion: record.evaluatorVersion });
}
/** What a person's review of the results confirms: the draft, its dialogues and the verdicts already given. */
export function resultHash(record: Experiment): string {
  return fingerprint({ draft: draftHash(record), trials: record.trials, humanReviews: record.humanReviews ?? [] });
}
/**
 * What the record claims two runs measured the same way. The control set belongs in it: a control
 * card is excluded from the headline denominator, so two runs marking different controls measure
 * different things even when every scenario is byte-identical. `ownerExpectationScenarioIds` does
 * not: an owner edit rewrites `successCriteria` and the goal rubric, so the card fingerprint — and
 * with it `scenarios` — already moves; the marker itself is only a label on that change.
 * `undefined` drops out of `JSON.stringify`, so a record written before the field existed keeps its
 * old hash.
 */
export function measurementHash(record: Experiment): string {
  return fingerprint(measurementFields(record));
}
/** What measurementHash seals, field by field: a run's guard checks its large parts apart from the rest (lab/run.ts). */
export function measurementFields(record: Experiment): Record<string, unknown> {
  return { version: VERSION, workflow: record.workflow, task: record.task, baseline: record.revisions[0], mode: record.mode, sources: record.sources, requirements: record.requirements, scenarios: record.scenarios, settings: record.settings,
    target: record.target, goldenCases: record.goldenCases, dialogues: record.dialogues, profiles: record.profiles, notes: record.notes,
    positiveControlScenarioIds: record.positiveControlScenarioIds,
    librarySnapshot: record.librarySnapshot, originalImport: record.originalImport, generatorConfig:record.generatorConfig,generatorIdentity:record.generatorIdentity,
    targetVersion: record.targetVersion, targetFingerprint: record.targetFingerprint, evaluatorVersion: record.evaluatorVersion };
}

/**
 * What one operation on a draft other than its preparation may spend — a run, a check, a fill, a re-assessment: the
 * draft's limits, counted from that operation's start, never from what earlier work on the record spent. A preparation
 * spends out of the ceiling its consent stated instead (card/budget.ts).
 */
export function draftBudget(record: Pick<Experiment, 'settings'>): Budget {
  return { calls: record.settings.maxCalls, timeMs: record.settings.maxDurationMs };
}

/** The agent label a draft evaluates, identified by its content. */
export function revision(spec: Revision['spec'], parentId: string | null, hypothesis: string): Revision {
  return { id: fingerprint(spec), parentId, spec: structuredClone(spec), hypothesis, createdAt: new Date().toISOString() };
}

/** Keeps the acceptance of every situation whose definition is still the one accepted. */
export function retainAcceptedTests(record: Experiment): void {
  const scenarios = new Map(record.scenarios.map(scenario => [scenario.id, scenario]));
  record.acceptedTests = (record.acceptedTests ?? []).filter(test => {
    const scenario = scenarios.get(test.scenarioId);
    return scenario !== undefined && fingerprint(scenario) === test.definitionHash;
  });
}

/** A new draft from the owner's input: nothing prepared yet, the owner's materials as its sources. */
export function newRecord(input: CreateInput): Experiment {
  const now = new Date().toISOString();
  return {
    schemaVersion: '1', id: randomUUID(), task: input.task, mode: input.mode, createdAt: now, updatedAt: now,
    phase: 'preparing', message: 'Подключаю агента и готовлю требования и первый тест.',
    sources: materialSources(input.materials),
    settings: input.settings, requirements: [], questions: [], scenarios: [], revisions: [], selectedRevisionId: null,
    manifestHash: null, reviewedAt: null, reviewMode: null, controlConsumedAt: null, acceptedTests: [], trials: [], comparisons: [], iterations: [],
    usage: emptyUsage(), error: null,
    workflow: input.workflow, humanReviews: [],
    target: input.target, goldenCases: [], dialogues: input.dialogues, profiles: [], notes: '',
    evaluatorVersion: evaluatorVersion(input.settings),
    ...(input.targetVersion ? { targetVersion: input.targetVersion } : {}),
    // Only what is particular to this record, typed (caveats.ts): what every run's number does not prove is said by its trust line.
    limitations: [], ...(input.mode === 'demo' ? { caveats: [{ code: 'demo' as const }] } : {}),
  };
}

/**
 * A fresh draft of an earlier record's accepted situations — all of them, or `scenarioIds` — for a repeat, a saved
 * set or a re-assessment: the materials and cards as they are, evidence and approvals afresh.
 */
export function freshDraft(previous: Experiment, scenarioIds?: string[]): Experiment {
  const record = structuredClone(previous);
  if (scenarioIds) {
    if (!scenarioIds.length || new Set(scenarioIds).size !== scenarioIds.length
      || scenarioIds.some(id => !record.scenarios.some(s => s.id === id))) throw new Error('Выберите существующие тесты без повторов.');
    record.scenarios = record.scenarios.filter(s => scenarioIds.includes(s.id));
    record.selectedScenarioIds = [...scenarioIds];
  }
  const keptControls = (record.positiveControlScenarioIds ?? []).filter(id => record.scenarios.some(s => s.id === id));
  if (keptControls.length) record.positiveControlScenarioIds = keptControls;
  else delete record.positiveControlScenarioIds;
  const keptOwnerExpectations = (record.ownerExpectationScenarioIds ?? []).filter(id => record.scenarios.some(s => s.id === id));
  if (keptOwnerExpectations.length) record.ownerExpectationScenarioIds = keptOwnerExpectations;
  else delete record.ownerExpectationScenarioIds;
  record.scenarios = record.scenarios.map(scenario => withDefaultGoalObservation(scenario, record.target.kind));
  Object.assign(record, { id: randomUUID(), parentRunId: previous.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    phase: 'review', message: 'Тесты готовы. Проверьте подключение и запустите проверку.',
    trials: [], comparisons: [], iterations: [], humanReviews: [], usage: emptyUsage(),
    reviewedAt: null, reviewMode: null, manifestHash: null, controlConsumedAt: null, error: null });
  delete record.executionRunId;
  delete record.resultsReviewedAt; delete record.resultsReviewHash; delete record.failureModes; delete record.blindLabels;
  delete record.acceptedDraftHash;
  delete record.targetRelease; delete record.assessmentOf; delete record.assessmentTrialIds; delete record.evidenceHash; delete record.releaseLog; delete record.calibration;
  // A new run takes the connection exam anew; the earlier one belongs to the earlier run's conversations.
  delete record.connectionExam; delete record.realism;
  retainAcceptedTests(record);
  record.evaluatorVersion = evaluatorVersion(record.settings);
  // Every note is about the work done on the earlier record — its run, its review, its re-assessment, its usage — and
  // none of it is this draft's; only the teaching example stays what it is.
  record.limitations = [];
  delete record.caveats;
  if (record.mode === 'demo') record.caveats = [{ code: 'demo' }];
  return record;
}
