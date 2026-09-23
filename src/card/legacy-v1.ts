import { EXPECTATIONS_PROTOCOL, isCardExecution, type CardExecution, type Scenario, type Trial, type VariantExecution } from '../contracts.js';
import type { LibraryV1 } from '../scenario-contracts.js';
import { EXPECTATION_LETTERS, expectationRubric } from './compile.js';
import type { ScenarioLibrary } from './schema.js';

/*
 * The first library format: business groups of variants. Old libraries, drafts and runs are read as
 * they are, never migrated; the variant editor and the screens built on it know only this format.
 *
 * Its runs were judged by a checkpoint judge plus one `library_required` rubric. Those judgments stay
 * readable and keep their frozen rule (checkpoints.ts). Every new judgment of a first-format card —
 * a repeat or a reassessment — goes through the projection below instead: each required checkpoint is
 * one expectation with its own two votes, exactly like a card's. The stored card is never changed, so
 * its definition hash keeps verifying; the projection exists only while judging and counting.
 */

/** The record's library when it is in the first format. */
export function libraryV1Of(record: { librarySnapshot?: ScenarioLibrary }): LibraryV1 | undefined {
  return record.librarySnapshot?.formatVersion === 1 ? record.librarySnapshot : undefined;
}

/** For a variant-editor operation: a card library is never changed by it. */
export function requireLibraryV1(library: ScenarioLibrary): LibraryV1 {
  if (library.formatVersion !== 1) throw new Error('Этот набор ситуаций в новом формате: старый редактор его не меняет.');
  return library;
}

/** An attempt judged by the checkpoint judge: a first-format run made before the projection. Such a verdict keeps its frozen rule. */
export const judgedByCheckpoints = (trial: Pick<Trial, 'checkpoints' | 'checkpointReceipt'>): boolean =>
  trial.checkpoints !== undefined || trial.checkpointReceipt !== undefined;

type Expectation = CardExecution['evaluatorView']['expectations'][number];

/**
 * What a first-format card is judged by now: every required checkpoint without an exact check, in its own
 * words — the rule is the duty, the applicability its condition, the channel its observation. A checkpoint
 * with an exact check stays a direct check; a diagnostic checkpoint never decided the verdict.
 */
export function projectedExpectations(execution: VariantExecution): Expectation[] {
  return execution.evaluatorView.checkpoints.filter(checkpoint => checkpoint.role === 'required' && checkpoint.check === undefined)
    .map(checkpoint => ({ id: checkpoint.id, text: checkpoint.rule, requirementIds: [checkpoint.requirementId], appliesWhen: checkpoint.applicability, observation: checkpoint.observation }));
}

/** The letter of a projected expectation: by position, like the checkpoints were listed. */
export const projectedLetter = (index: number): string => EXPECTATION_LETTERS[index] ?? String(index + 1);

function projected(scenario: Scenario, execution: VariantExecution): Scenario {
  const expectations = projectedExpectations(execution);
  const { successCriteria: _whole, ...rest } = scenario;
  const card = `ситуации «${scenario.title}»`;
  return { ...rest,
    execution: { protocol: execution.protocol, evaluation: EXPECTATIONS_PROTOCOL, userView: execution.userView, environmentView: execution.environmentView,
      evaluatorView: { expectations, requirements: execution.evaluatorView.requirements } },
    // The one `library_required` rubric over all checkpoints gives way to one rubric per checkpoint.
    metrics: [...expectations.map((expectation, index) => expectationRubric(expectation, projectedLetter(index), card)),
      ...(scenario.metrics ?? []).filter(metric => metric.id !== 'library_required')] };
}

/**
 * The card as this attempt is judged and counted: a first-format card through the projection, unless the
 * attempt carries a checkpoint verdict; any other card as it is. The result has a card execution exactly
 * when the attempt is judged by expectations.
 */
export function judgedScenario(scenario: Scenario, trial: Pick<Trial, 'checkpoints' | 'checkpointReceipt'>): Scenario {
  const execution = scenario.execution;
  return execution && !isCardExecution(execution) && !judgedByCheckpoints(trial) ? projected(scenario, execution) : scenario;
}
