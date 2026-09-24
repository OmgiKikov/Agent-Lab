import { EXPECTATIONS_PROTOCOL, isCardExecution, type CardExecution, type Experiment, type Scenario, type Trial, type VariantExecution } from '../contracts.js';
import { isRunning } from '../phases.js';
import type { LibraryV1, ScenarioVariant } from '../scenario-contracts.js';
import { EXPECTATION_LETTERS, expectationRubric } from './compile.js';
import type { ScenarioLibrary } from './schema.js';

/*
 * The first library format: business groups of variants. Old libraries, drafts and runs are read as
 * they are, never migrated and never edited: a draft of this format goes on in the card format
 * (card/convert.ts), and a run of it opens, re-assesses and repeats with its accepted cards.
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

/** A draft of the first format that can go on as cards (card/convert.ts): nothing ran on it and nothing runs it now. */
export const convertible = (record: Pick<Experiment, 'librarySnapshot' | 'phase' | 'trials'>): boolean =>
  !!libraryV1Of(record) && !record.trials.length && !isRunning(record.phase);

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

/*
 * Reading a first-format draft: the order its variants are listed in, and its checker's remarks and the
 * customer's program in the owner's words. The projection onto the brief (card/view.ts) is built from these.
 */

/** Variants in the order every list shows them: group by group, so «третья ситуация» means the third row on screen. */
export function orderedVariants(library: LibraryV1): ScenarioVariant[] {
  const grouped = library.businessScenarios.flatMap(group => library.variants.filter(variant => variant.businessScenarioId === group.id));
  return [...grouped, ...library.variants.filter(variant => !grouped.includes(variant))];
}

/** Remarks the owner can act on: «the recheck has not run yet» is the tool's own bookkeeping. */
export const ownerRemarks = <T extends { code: string }>(issues: T[]): T[] => issues.filter(issue => issue.code !== 'semantic_pending' && issue.code !== 'semantic_variant_pending');

/** The checker's open questions the owner could settle in their own name. */
export const ownerQuestions = (variant: ScenarioVariant) => ownerRemarks(variant.issues).filter(issue => issue.code === 'semantic_finding' && issue.severity === 'needs_review');

/** Internal field and enum names the checker sometimes writes into a remark, as the owner says them. Whole words only. */
const CHECKER_WORDS = new Map([
  ['ownerFactEvidence', 'подтверждение владельца'], ['checkpoints', 'проверки'], ['checkpoint', 'проверка'],
  ['learned_in_source', 'узнал только в старом разговоре'], ['initial', 'знал заранее'], ['uncertain', 'неясно'], ['missing', '«данных нет»'],
]);
const WORDS = new Intl.Segmenter('ru', { granularity: 'word' });
const ownerWords = (text: string): string => Array.from(WORDS.segment(text), ({ segment, isWordLike }) => isWordLike ? CHECKER_WORDS.get(segment) ?? segment : segment).join('');

/** A checker remark as the owner can act on it: titles instead of ids, and the part of the situation it is about. The stored remark is not changed. */
export function plainIssue(library: LibraryV1, variant: ScenarioVariant, issue: { path: string; message: string }): string {
  let text = issue.message;
  for (const other of library.variants) if (other.id.length >= 6) text = text.split(other.id).join(`«${other.title}»`);
  for (const fact of variant.userState.facts) if (fact.id.length >= 6) text = text.split(fact.id).join(`«${fact.statement}»`);
  text = ownerWords(text);
  const checkpointId = issue.path.split('.checkpoints.')[1]?.split('.')[0];
  const checkpoint = checkpointId ? variant.evaluationSpec.checkpoints.find(item => item.id === checkpointId) : undefined;
  const factId = issue.path.split('.facts.')[1]?.split('.')[0];
  const fact = factId ? variant.userState.facts.find(item => item.id === factId) : undefined;
  const about = checkpoint ? `Проверка «${checkpoint.rule}»` : fact ? `Факт «${fact.statement}»` : issue.path.endsWith('.duplicates') ? 'Похоже на дубль'
    : issue.path.includes('behaviorPolicy') ? 'Поведение клиента' : issue.path.includes('successCriteria') ? 'Ожидаемый результат' : issue.path.includes('opening') ? 'Первая реплика' : '';
  return about ? `${about}: ${text}` : text;
}

const ACTION_WORDS = { answer: 'отвечает', missing: 'говорит, что данных нет', clarify: 'уточняет', correct: 'исправляет ответ', change_intent: 'меняет намерение', finish: 'завершает разговор', observe: 'сообщает, что видит' } as const;

/** The customer's program as sentences: when, and what the customer does then. */
export function behaviorLines(variant: Pick<ScenarioVariant, 'behaviorPolicy'>): string[] {
  return variant.behaviorPolicy.transitions.flatMap(transition => {
    const action = variant.behaviorPolicy.actions.find(item => item.id === transition.actionId);
    return action ? [`${transition.when}: клиент ${ACTION_WORDS[action.kind]}${action.payload ? ` «${action.payload}»` : ''}`] : [];
  });
}
