import { isCardExecution, type Experiment, type Scenario } from '../contracts.js';
import type { LibraryV1, ScenarioVariant } from '../scenario-contracts.js';
import type { Calibration, LoggedDialogue } from './calibration.js';
import { expectationLetter } from './compile.js';
import type { Expectation } from './expectations.js';
import { projectedExpectations, projectedLetter } from './legacy-v1.js';
import type { Card, EventRef, LibraryV2 } from './schema.js';

/*
 * What a calibration covers (docs/design/card-v2-spec.md §10.1–10.2, §10.6), decided from the stored cards and logs alone:
 *
 *   situation ──its situation is its log's?──► no: excluded (not_from_log | situation_edited)
 *             └─ yes ──per expectation──► the log cannot show it: skipped (no_agent_reply | channel_unobserved), 0 calls
 *                                        └─ otherwise judged on the log: 2 votes
 *
 * Editing an expectation keeps a situation calibratable — both sides are judged by the same criteria; editing
 * the situation does not. The version rules say whether agreement is a calibration (the logs were written by the
 * version under test) or only a comparison. Pure: nothing here reads the store or calls a model.
 */

export type Exclusion = 'not_from_log' | 'situation_edited';
export type LogSkip = 'no_agent_reply' | 'channel_unobserved';

const inDialogue = (event: EventRef, origin: { batchId: string; dialogueId: string }): boolean =>
  event.batchId === origin.batchId && event.dialogueId === origin.dialogueId;

/**
 * Why a card's situation is not the situation of its log; undefined when it is: a card of a dialogue whose first
 * message, turn and every fact come from that dialogue, and whose account of the later messages holds no change.
 * A similar card, one added by the owner or written from the rules has no log of its own; a card of a dialogue
 * that the owner changed stands for another situation now — and so does one whose customer holds a plausible fact,
 * confirmed or not: it is in no message of the log, so the synthetic customer knows more than the logged one did —
 * and so does one whose masked values Lab filled in.
 */
export function cardExclusion(card: Card): Exclusion | undefined {
  const { origin } = card;
  if (origin.kind !== 'dialogue') return 'not_from_log';
  const { writesSource, turn, knows } = card.client;
  const fromLog = writesSource.kind === 'dialogue' && inDialogue(writesSource.event, origin)
    && (!turn || turn.source.kind === 'dialogue' && inDialogue(turn.source.event, origin))
    && knows.every(fact => fact.source.kind === 'dialogue' && inDialogue(fact.source.event, origin))
    && !card.coverage.some(entry => entry.as === 'changed')
    // Values Lab wrote over the log's masking marks: the synthetic customer says what the logged one's words hid.
    && !card.filled;
  return fromLog ? undefined : 'situation_edited';
}

/** Whether a card is calibrated against its log (docs/design/card-v2-spec.md §10.1). */
export const calibratable = (card: Card): boolean => cardExclusion(card) === undefined;

/**
 * The same rule for a first-format variant, read through its projection: a variant of a production dialogue,
 * made from no other variant, whose facts all come from the dialogue and whose history holds no owner edit of
 * the customer (a fact, the persona, the goal or the opening). An edit of a checkpoint is an edit of an
 * expectation and keeps it calibratable.
 */
export function variantExclusion(variant: ScenarioVariant): Exclusion | undefined {
  if (variant.provenance !== 'production' || variant.parentVariantId !== undefined || !variant.sourceDialogues.length) return 'not_from_log';
  const edited = variant.userState.persona !== undefined || variant.userState.facts.some(fact => fact.origin.kind !== 'dialogue')
    || variant.history.some(entry => entry.author === 'owner' && (entry.factEdit || entry.personaEdit || entry.textEdit?.field === 'opening' || entry.textEdit?.field === 'goal'));
  return edited ? 'situation_edited' : undefined;
}

/** A situation as a calibration reads it: its expectations with their letters, and the conversation it was taken from. */
export interface LogSituation {
  id: string;
  /** The number the owner knows it by, and its title. */
  number: number; title: string;
  exclusion?: Exclusion;
  expectations: { expectation: Expectation; letter: string }[];
  /** How a rubric names the situation («карточки №3»), exactly as its synthetic rubric does. */
  card: string;
  /** Its logged conversation; `opening` is the index of the customer's first message («Пишет») when the card records it. */
  log?: { importId: string; importContentHash: string | undefined; dialogueId: string; opening?: number };
}

/** A card as a calibration reads it; `expectations` are its accepted definition's, or the draft's own before acceptance. */
export function cardLogSituation(library: LibraryV2, card: Card, expectations: readonly Expectation[] = card.agentMust): LogSituation {
  const { origin, client } = card;
  const exclusion = cardExclusion(card);
  return {
    id: card.id, number: card.number, title: card.title, ...(exclusion ? { exclusion } : {}),
    expectations: expectations.map(expectation => ({ expectation, letter: expectationLetter(expectation.id) })),
    card: `карточки №${card.number}`,
    ...(origin.kind === 'dialogue' ? { log: { importId: origin.batchId, importContentHash: library.imports.find(item => item.id === origin.batchId)?.contentHash,
      dialogueId: origin.dialogueId, ...(client.writesSource.kind === 'dialogue' ? { opening: client.writesSource.event.eventIndex } : {}) } } : {}),
  };
}

/**
 * A first-format situation of a run, read through the projection it is judged by: one expectation per required
 * checkpoint, lettered by position, named by its title — as the synthetic judgment names it.
 */
function variantLogSituation(library: LibraryV1, variant: ScenarioVariant, scenario: Scenario, number: number): LogSituation {
  const execution = scenario.execution && !isCardExecution(scenario.execution) ? scenario.execution : undefined;
  const origin = variant.sourceDialogues[0];
  const batch = origin && library.imports.find(item => item.id === origin.batchId);
  const exclusion = variantExclusion(variant);
  return {
    id: scenario.id, number, title: scenario.title, ...(exclusion ? { exclusion } : {}),
    expectations: (execution ? projectedExpectations(execution) : []).map((expectation, index) => ({ expectation, letter: projectedLetter(index) })),
    card: `ситуации «${scenario.title}»`,
    ...(origin ? { log: { importId: origin.batchId, importContentHash: batch?.contentHash, dialogueId: origin.dialogueId } } : {}),
  };
}

/**
 * The situations of a run a calibration covers, in the run's order, each with its accepted definition. Controls
 * are left out: they check the connection and the judge, never the agent's accuracy. A situation without a card
 * or a variant behind it (a record made before libraries) has no situation of a log to compare with.
 */
export function runLogSituations(record: Pick<Experiment, 'librarySnapshot' | 'scenarios' | 'positiveControlScenarioIds'>): (LogSituation & { scenario: Scenario })[] {
  const library = record.librarySnapshot;
  const controls = new Set(record.positiveControlScenarioIds ?? []);
  return record.scenarios.flatMap((scenario, index) => {
    if (controls.has(scenario.id) || !library) return [];
    if (library.formatVersion === 2) {
      const card = library.cards.find(item => item.id === scenario.id);
      return card && isCardExecution(scenario.execution) ? [{ ...cardLogSituation(library, card, scenario.execution.evaluatorView.expectations), scenario }] : [];
    }
    const variant = library.variants.find(item => item.id === scenario.id);
    return variant ? [{ ...variantLogSituation(library, variant, scenario, index + 1), scenario }] : [];
  });
}

/** The imports whose logs a record's situations were taken from: what the owner declares a version for. */
export function logImports(record: Pick<Experiment, 'librarySnapshot' | 'originalImport'>): string[] {
  return record.librarySnapshot ? record.librarySnapshot.imports.map(item => item.id) : record.originalImport ? [record.originalImport.id] : [];
}

/**
 * Why the log cannot show an expectation, so the judge is not asked (0 calls): the agent never replied after the
 * customer's first message, or the expectation is judged on tool calls or state and the import did not record
 * that channel completely.
 */
export function logSkip(expectation: Pick<Expectation, 'observation'>, dialogue: LoggedDialogue, opening?: number): LogSkip | undefined {
  const messages = dialogue.events.filter(event => event.type === 'message');
  const first = opening ?? messages.find(event => event.role === 'user')?.index;
  if (first === undefined || !messages.some(event => event.role === 'assistant' && event.index > first)) return 'no_agent_reply';
  if (expectation.observation === 'reply') return undefined;
  const channel = expectation.observation === 'tool' ? 'tool' : 'state';
  return dialogue.observation === 'complete' && dialogue.events.some(event => event.type === channel) ? undefined : 'channel_unobserved';
}

/**
 * The judge calls a calibration of these situations may make, before any re-ask of a malformed vote: two votes
 * for every expectation of a situation from a log that its conversation can show. `dialogue` finds the logged
 * conversation; one it cannot find is never judged.
 */
export function calibrationCalls(situations: readonly LogSituation[], dialogue: (importId: string, dialogueId: string) => LoggedDialogue | undefined): number {
  let calls = 0;
  for (const situation of situations) {
    const logged = !situation.exclusion && situation.log && dialogue(situation.log.importId, situation.log.dialogueId);
    if (!logged) continue;
    for (const { expectation } of situation.expectations) if (!logSkip(expectation, logged, situation.log!.opening)) calls += 2;
  }
  return calls;
}

/**
 * The version under test (docs/design/card-v2-spec.md §10.2): the one the adapter reported in every attempt that reached the agent;
 * otherwise the version the owner declared for the run; otherwise unknown. An adapter that reported two versions
 * tested no single version, and a declaration the adapter contradicts is not taken: both are unknown.
 */
export function testedVersion(record: Pick<Experiment, 'trials' | 'targetVersion'>): string | null {
  const answered = record.trials.filter(trial => trial.events.some(event => event.type === 'assistant'));
  const reported = answered.map(trial => trial.observation?.version?.trim() || undefined);
  const named = new Set(reported.filter((version): version is string => version !== undefined));
  const declared = record.targetVersion?.trim() || null;
  if (named.size > 1) return null;
  const [only] = named;
  if (only === undefined) return declared;
  return reported.every(version => version === only) || declared === only ? only : null;
}

/**
 * Whether agreement is a calibration: every log compared was declared with a version, the version under test is
 * known, and they are equal after trimming. Otherwise it is a comparison with the reason in the owner's words.
 */
export function calibrationMode(calibration: Pick<Calibration, 'logVersions' | 'testedVersion'>, importIds: readonly string[]): { mode: 'calibration' | 'comparison'; versionNote: string | null } {
  const logs = [...new Set(importIds)].map(importId => calibration.logVersions.find(row => row.importId === importId)?.version?.trim() || null);
  const tested = calibration.testedVersion?.trim() || null;
  if (!logs.length || logs.includes(null)) return { mode: 'comparison', versionNote: 'версия логов не указана' };
  if (tested === null) return { mode: 'comparison', versionNote: 'версия проверяемого агента неизвестна' };
  const versions = [...new Set(logs as string[])];
  return versions.every(version => version === tested) ? { mode: 'calibration', versionNote: null }
    : { mode: 'comparison', versionNote: `в логах ${versions.join(', ')}, проверяли ${tested}` };
}
