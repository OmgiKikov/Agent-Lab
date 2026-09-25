import { randomUUID } from 'node:crypto';
import { preparationBudget, preparationCeiling, preparationTime, promptsOversize } from '../card/budget.js';
import type { LogVersionCommand, LogVersionJournal } from '../card/calibration.js';
import { importEvidence, type CardEvidence } from '../card/checks.js';
import { applyCommand, applyLogVersion as appendLogVersion, prepareCommand, prepareLogVersion as previewLogVersion, type HostGrant, type Prepared, type PreparedLogVersion, type Via } from '../card/commands.js';
import { convertedPreparation, convertV1Library, type Conversion } from '../card/convert.js';
import { convertible, libraryV1Of } from '../card/legacy-v1.js';
import { acceptLibraryV2, requireLibraryV2 } from '../card/library.js';
import { notContinuable, pendingReviewCalls, preparationParallel, prepareCards, resumeCards, reviewCards, storedEvidence, type CardPlan } from '../card/prepare.js';
import type { CardCommand, LibraryV2 } from '../card/schema.js';
import { unmaskCommand, unmaskRequest } from '../card/unmask.js';
import { dialogueNumbers, type DialogueNumbers } from '../card/view.js';
import { probeToolChannel, TOOL_PROBE_OPENING } from '../connection.js';
import { createInputSchema, emptyUsage, fingerprint, isRunnable, type CardExecution, type CreateInput, type Experiment } from '../contracts.js';
import { CommandRefused, LibraryConflict, NotADraft } from '../errors.js';
import { logSample, preparationConsent, situationCount } from '../miner/plan.js';
import { evaluatorVersion } from '../pi.js';
import { countText } from '../plural.js';
import { chooseEditableDraft, draftIsBusy, recheckDecision } from '../scenario-draft.js';
import { importBatch, libraryHash } from '../scenario-library.js';
import { preflightTarget } from '../targets.js';
import { targetFingerprint } from '../target-version.js';
import type { Lab } from './context.js';
import { isRunning, moveTo } from '../phases.js';
import { draftBudget, draftHash, newRecord } from './record.js';
import { repeat } from './run.js';

/*
 * The situations of a draft — a card library: prepared from logs or the owner's rules, checked by the reviewer,
 * changed by the owner's commands, accepted for a run. A draft that ran never changes: an owner command goes to a
 * fresh draft of the same library. The logs' declared agent version lives with their import, not with any draft.
 *
 *   create / resume   preparing ─► review    within the ceiling the owner agreed to, over all its launches
 *   check / fill      review ─► checking ─► review    within the draft's limits; whatever cuts it short, the draft stays
 */

/** Why `record` is not a draft `what` may start on, in the owner's words: work is going on on it, or it already ran or stopped. */
function notADraft(record: Pick<Experiment, 'phase'>, what: string): NotADraft {
  return new NotADraft(isRunning(record.phase) ? `${what} сейчас нельзя: над этими ситуациями идёт работа — дождитесь её или остановите.`
    : `${what} можно только в черновике: этот прогон уже шёл или остановлен и не меняется.`);
}

/**
 * How a preparation runs: `parallel` units at once, PREPARATION_PARALLEL when not named. An execution knob, like a run's:
 * the draft does not depend on it (card/prepare.ts lands every unit's card step in plan order).
 */
export interface PreparationOptions {
  parallel?: number;
}

export interface CreateOptions extends PreparationOptions {
  /** Situations at most, prepared from logs: DEFAULT_SITUATIONS when the owner names no number. */
  situations?: number;
  /** The ceiling of model calls the owner agreed to; without one it is computed the same way (card/budget.ts). */
  callCeiling?: number;
}

/**
 * A new draft is always a card library (card/prepare.ts): situations citing the owner's materials verbatim,
 * proposed from real dialogues — at most `situations` of them, the representative sample of the logs' topics
 * (miner/plan.ts) — or from the materials alone.
 */
export async function create(lab: Lab, raw: CreateInput, options: CreateOptions = {}): Promise<Experiment> {
  lab.operations.ensureIdle();
  const situations = situationCount(options.situations);
  const parallel = preparationParallel(options.parallel);
  const originalImport = raw.originalImport ?? (raw.dialogues?.length ? importBatch(raw.dialogues) : undefined);
  const input = createInputSchema.parse({ ...raw, ...(originalImport ? { originalImport } : {}) });
  const record = newRecord(input);
  // Every proposal reads all the agent's prompts: prompts no request can hold refuse the preparation before any call.
  const prompts = promptsOversize(record.task, record.sources);
  if (prompts) throw new Error(prompts);
  // The preparation stops at the ceiling its consent stated — the one the owner agreed to, or the same computation —
  // over its creation and every resume; the draft's own limits are the run's.
  const consent = input.originalImport ? await preparationConsent(lab.store, { input, situations }) : undefined;
  const count = input.scenarioCount || 1;
  const callCeiling = options.callCeiling ?? consent?.callCeiling ?? preparationCeiling({ task: record.task, sources: record.sources, situations: count, fromLogs: false });
  const budget = { calls: callCeiling, timeMs: preparationTime(consent?.promised ?? count, consent?.topicMapCalls) };
  await lab.operations.launch(record, async ctx => {
    if (input.originalImport) {
      const batch = await lab.store.writeImport(input.originalImport);
      record.originalImport = { id: batch.id, contentHash: batch.contentHash };
    }
    await preflightTarget(record.target);
    record.targetFingerprint = await targetFingerprint(record.target);
    if (isRunnable(record.target)) {
      lab.operations.say(record, 'Спрашиваю агента, какие инструменты он показывает');
      record.toolChannel = await probeToolChannel(record.target, TOOL_PROBE_OPENING, ctx.signal);
      if (record.toolChannel.reason) lab.operations.say(record, `Действия агента не проверяются: ${record.toolChannel.reason}.`);
    }
    const runtime = await lab.runtime(record);
    if (!runtime.proposeCard || !runtime.reviewCard) throw new Error('Эта среда не умеет готовить ситуации.');
    const batch = record.originalImport ? await lab.store.readImport(record.originalImport.id) : undefined;
    const plan: CardPlan = batch ? { kind: 'dialogues', batch, sample: await logSample(lab.store, batch, runtime, ctx, situations, message => lab.operations.say(record, message)) }
      : { kind: 'rules', count };
    await prepareCards(record, plan, input.existingAgent, runtime, ctx, lab.operations, parallel);
    await lab.operations.checkpoint(record, 'review', 'Ситуации готовы. Проверьте их и утвердите для прогона.');
  }, { budget, carried: { calls: 0, elapsedMs: 0 } });
  return structuredClone(record);
}

/** The draft's cards as a detached copy, with the draft itself. */
export async function readCards(lab: Lab, id: string): Promise<{ library: LibraryV2; experiment: Experiment }> {
  const experiment = await lab.get(id);
  if (!experiment.librarySnapshot) throw new Error('У черновика нет ситуаций.');
  return { library: structuredClone(requireLibraryV2(experiment.librarySnapshot)), experiment };
}

/**
 * The agent's environment the cards are compiled with: its tool journal, when the probe before the preparation
 * confirmed it and named the tools; otherwise none, and the agent is judged on its replies as before.
 */
function toolEnvironment(record: Experiment): CardExecution['environmentView'] | undefined {
  const channel = record.toolChannel;
  if (!channel?.confirmed) return undefined;
  return { mode: 'prompt', contract: { operations: [...channel.tools], reset: false, observations: ['reply', 'tool'], confirmed: true } };
}

/** Accepts ready cards for a run: each is compiled here, once, and its definition hash sealed with the library (card/library.ts). */
export function acceptCards(lab: Lab, id: string, expectedHash: string, cardIds: string[]): Promise<{ library: LibraryV2; experiment: Experiment }> {
  return lab.operations.change(async () => {
    const { experiment, library } = await readCards(lab, id);
    if (experiment.phase !== 'review') throw notADraft(experiment, 'Утвердить ситуации');
    if (fingerprint(experiment.requirements) !== fingerprint(library.requirements) || fingerprint(experiment.sources) !== fingerprint(library.sources)) throw new Error('Правила изменились после подготовки ситуаций.');
    const environment = toolEnvironment(experiment);
    const accepted = acceptLibraryV2(library, expectedHash, cardIds, { evidence: await storedEvidence(lab.store, library), maxTurns: experiment.settings.maxTurns,
      ...(environment ? { environment } : {}) });
    experiment.librarySnapshot = accepted.library; experiment.scenarios = accepted.scenarios;
    delete experiment.selectedScenarioIds;
    const acceptedAt = new Date().toISOString();
    experiment.acceptedTests = accepted.scenarios.map(scenario => ({ testId: randomUUID(), scenarioId: scenario.id, definitionHash: fingerprint(scenario), acceptedAt }));
    experiment.acceptedDraftHash = draftHash(experiment);
    await lab.store.publishLibrary(experiment, accepted.library, expectedHash);
    return { library: accepted.library, experiment };
  });
}

/**
 * The owner's explicit check of every claim of the draft's cards that no receipt answers yet, within the draft's limits
 * from its start. Each answer is saved as it comes; whatever cuts the check short, the draft goes back to review with
 * them (phases.ts), and a restart puts a draft left in its check back to review too.
 */
export function checkCards(lab: Lab, id: string, expectedHash: string): Promise<Experiment> {
  return lab.operations.change(async () => {
    const { experiment, library } = await readCards(lab, id);
    if (experiment.phase !== 'review') throw notADraft(experiment, 'Проверить ситуации');
    if (libraryHash(library) !== expectedHash) throw new LibraryConflict('Ситуации изменились, пока вы смотрели: откройте их заново.');
    const batch = experiment.originalImport ? await lab.store.readImport(experiment.originalImport.id) : undefined;
    moveTo(experiment, 'checking'); experiment.error = null; experiment.message = 'Проверяю ситуации';
    await lab.operations.launch(experiment, async ctx => {
      await reviewCards(experiment, batch, await lab.runtime(experiment), ctx, lab.operations);
      await lab.operations.checkpoint(experiment, 'review', 'Проверка ситуаций завершена.');
    }, { ownsMutation: true, budget: draftBudget(experiment) });
    return structuredClone(experiment);
  });
}

/** A card draft with what its cards cite: statuses, checks and «из диалога №17» read the import batches. */
export async function cardContext(lab: Lab, id: string): Promise<{ experiment: Experiment; library: LibraryV2; evidence: CardEvidence; numbers: DialogueNumbers }> {
  const { experiment, library } = await readCards(lab, id);
  const batches = await Promise.all(library.imports.map(item => lab.store.readImport(item.id)));
  return { experiment, library, evidence: importEvidence(batches), numbers: dialogueNumbers(batches) };
}

/**
 * The draft an owner command goes to: this draft, the draft that holds the newest revision of its cards, or — when
 * only finished runs hold it — a fresh copy of the newest of them: a run that happened never changes. The fresh copy
 * is only previewed (Lab.preview): the owner sees the change on it, and it is written with the change they apply —
 * a preview they decline writes nothing.
 */
export async function editableCards(lab: Lab, id: string): Promise<{ id: string; copiedFrom?: string; preview?: true }> {
  const settled = await lab.get(id);
  if (!settled.librarySnapshot) throw new Error('У этого прогона нет ситуаций нового формата.');
  const library = requireLibraryV2(settled.librarySnapshot);
  const headHash = await lab.store.readLibrary(library.id).then(libraryHash, () => libraryHash(library));
  const choice = chooseEditableDraft({ settled, holders: await lab.list(), headHash, busy: draftIsBusy });
  if (choice.action === 'busy') throw new Error('Этот прогон сейчас идёт: ситуации можно смотреть, изменить — после него.');
  if (choice.action === 'edit') return { id };
  return choice.action === 'use' ? { id: choice.id, copiedFrom: id } : { id: (await repeat(lab, choice.sourceId, undefined, undefined, { preview: true })).id, copiedFrom: id, preview: true };
}

/** Previews an owner command on a card draft (card/commands.ts); nothing is written. */
export async function prepareCardCommand(lab: Lab, id: string, command: CardCommand, options: { via: Via; ownerWords?: string }): Promise<Prepared> {
  const { experiment, library, evidence } = await cardContext(lab, id);
  return prepareCommand(library, command, { evidence, maxTurns: experiment.settings.maxTurns, via: options.via, ...(options.ownerWords === undefined ? {} : { ownerWords: options.ownerWords }) });
}

/** Applies a previewed command with the owner's grant: a new revision of the draft, and what was accepted from it gives way. */
export function applyCardCommand(lab: Lab, id: string, prepared: Prepared, grant: HostGrant): Promise<{ library: LibraryV2; experiment: Experiment }> {
  return lab.operations.change(async () => {
    const { experiment, library } = await readCards(lab, id);
    if (experiment.phase !== 'review' || experiment.trials.length) throw notADraft(experiment, 'Менять ситуации');
    const next = applyCommand(library, prepared, grant);
    experiment.librarySnapshot = next; experiment.scenarios = []; experiment.acceptedTests = [];
    delete experiment.acceptedDraftHash; delete experiment.selectedScenarioIds; delete experiment.positiveControlScenarioIds;
    experiment.reviewedAt = null; experiment.reviewMode = null; experiment.manifestHash = null;
    await lab.store.publishLibrary(experiment, next, prepared.libraryHash);
    return { library: next, experiment };
  });
}

/**
 * Lab's plausible values over the masking marks of one card of a draft (card/unmask.ts): one builder call within the
 * draft's limits, whose answer is the `fill_masked` command the owner then confirms as shown. Nothing of the draft's
 * situations changes here; the call is recorded on the draft, which goes back to review however the fill ends.
 */
export async function proposeFill(lab: Lab, id: string, cardId: string): Promise<Extract<CardCommand, { kind: 'fill_masked' }>> {
  let command: Extract<CardCommand, { kind: 'fill_masked' }> | undefined;
  await lab.operations.change(async () => {
    const { experiment, library, evidence } = await cardContext(lab, id);
    if (experiment.phase !== 'review' || experiment.trials.length) throw notADraft(experiment, 'Подставлять значения');
    const card = library.cards.find(item => item.id === cardId);
    const request = card && unmaskRequest(card, evidence);
    if (!request) throw new CommandRefused('В этой ситуации нет обезличенных значений: подставлять нечего.');
    const filler = (await lab.runtime(experiment)).maskFill;
    if (!filler) throw new Error('Эта среда не умеет подставлять значения.');
    moveTo(experiment, 'checking'); experiment.error = null; experiment.message = 'Подбираю правдоподобные значения вместо обезличенных';
    await lab.operations.launch(experiment, async ctx => {
      command = unmaskCommand(request, await filler.fill(request, ctx));
      await lab.operations.checkpoint(experiment, 'review', 'Значения вместо обезличенных подобраны: ждут вашего подтверждения.');
    }, { ownsMutation: true, budget: draftBudget(experiment) });
  });
  await lab.operations.idle();
  if (!command) throw new Error((await lab.get(id)).error ?? 'Значения не подобраны.');
  return command;
}

/**
 * After an owner command: the claims it opened are checked now, later, or wait for a larger limit. A check is its own
 * operation: the calls it may make are the draft's limit from its start, whatever the preparation and earlier checks spent.
 */
export async function recheckCards(lab: Lab, id: string, options: { defer?: boolean; expectedHash?: string; explicit?: boolean } = {}) {
  const { experiment, library, evidence } = await cardContext(lab, id);
  const hash = libraryHash(library);
  if (options.expectedHash && options.expectedHash !== hash) throw new LibraryConflict('Библиотека изменилась: хеш устарел.');
  const pendingJobs = pendingReviewCalls(library, evidence), remainingCalls = draftBudget(experiment).calls;
  const decision = recheckDecision({ pendingJobs, remainingCalls, defer: !!options.defer, askedHash: options.explicit ? hash : undefined, libraryHash: hash });
  if (decision.action === 'run') await checkCards(lab, id, decision.startHash);
  return { decision, before: experiment };
}

/** Previews the owner's word on which agent version wrote an import's logs (card/commands.ts); nothing is written. */
export async function prepareLogVersion(lab: Lab, command: LogVersionCommand, options: { via: Via; at?: string }): Promise<PreparedLogVersion> {
  const batch = await lab.store.readImport(command.importId);
  return previewLogVersion(await lab.store.readLogVersions(batch.id), batch, command, options);
}

/**
 * Records a previewed declaration with the owner's grant, appended to the import's own journal: no run and no library
 * changes, so it may be given at any time; the next calibration reads it, a finished run keeps its snapshot.
 */
export async function applyLogVersion(lab: Lab, prepared: PreparedLogVersion, grant: HostGrant): Promise<LogVersionJournal> {
  const next = appendLogVersion(await lab.store.readLogVersions(prepared.command.importId), prepared, grant);
  await lab.store.writeLogVersions(next, prepared.journalHash);
  return next;
}

/** How a preparation continues: `callCeiling` — the new ceiling of the whole preparation the owner agreed to, when the one they agreed to before cannot take it further. */
export interface ResumeOptions extends PreparationOptions {
  callCeiling?: number;
}

/** «потратила 21 вызов», and after «до»: «до 21 вызова». */
const CALLS: [string, string, string] = ['вызов', 'вызова', 'вызовов'];
const CALLS_UP_TO: [string, string, string] = ['вызова', 'вызовов', 'вызовов'];

/**
 * Continues a card preparation from its saved place (card/prepare.ts); a unit whose paid call died in flight is left
 * out, because its cost is unknown. A first-format preparation is never continued: its draft is only read, and it goes
 * on in the card format (convertV1Draft). A resume spends out of the ceiling the owner agreed to for the whole
 * preparation (card/budget.ts preparationBudget) — or the higher one they agree to now — and is given the time of the
 * units it has left. A preparation that died with nothing left to prepare goes back to its draft without a call.
 */
export function resumePreparation(lab: Lab, id: string, expectedHash: string, options: ResumeOptions = {}): Promise<Experiment> {
  const parallel = preparationParallel(options.parallel);
  return lab.operations.change(async () => {
    const experiment = await lab.get(id);
    const progress = experiment.preparationProgress;
    if (experiment.phase !== 'review' && experiment.phase !== 'interrupted') throw notADraft(experiment, 'Продолжить подготовку');
    if (!progress?.pending.length && experiment.phase !== 'interrupted') throw new Error('Необработанных источников нет.');
    if (!experiment.librarySnapshot) throw new Error('Черновик библиотеки не сохранён; продолжить нельзя.');
    if (libraryHash(experiment.librarySnapshot) !== expectedHash || libraryHash(await lab.store.readLibrary(experiment.librarySnapshot.id)) !== expectedHash) throw new LibraryConflict('Библиотека изменилась: хеш устарел.');
    if (experiment.librarySnapshot.acceptance || experiment.trials.length || experiment.acceptedTests?.length) throw new Error('Принятый или выполненный набор не меняется. Создайте новый черновик.');
    if (!progress?.pending.length) {
      // It died after its last unit, or in a check made before checks had a phase of their own: what it saved is the draft.
      moveTo(experiment, 'review'); experiment.error = null; delete experiment.stop;
      experiment.message = 'Подготовка успела разобрать все разговоры: черновик снова открыт. Проверьте ситуации и утвердите для прогона.';
      experiment.updatedAt = new Date().toISOString();
      await lab.store.save(experiment);
      return structuredClone(experiment);
    }
    const refusal = notContinuable(progress);
    if (refusal) throw new Error(refusal);
    const budget = preparationBudget(experiment)!;
    const ceiling = options.callCeiling ?? budget.ceiling;
    if (ceiling <= budget.spent) {
      throw new CommandRefused(`Подготовка потратила ${countText(budget.spent, CALLS)} модели из ${budget.ceiling} согласованных — больше потолок не пускает. `
        + `Продолжить можно, согласившись на новый потолок: до ${countText(budget.resume, CALLS_UP_TO)} на всю подготовку.`);
    }
    const batch = experiment.originalImport ? await lab.store.readImport(experiment.originalImport.id) : undefined;
    moveTo(experiment, 'preparing'); experiment.error = null;
    await lab.operations.launch(experiment, async ctx => {
      await resumeCards(experiment, batch, await lab.runtime(experiment), ctx, lab.operations, parallel);
      await lab.operations.checkpoint(experiment, 'review', 'Подготовка продолжена с сохранённого места. Проверьте ситуации и утвердите для прогона.');
    }, { ownsMutation: true, budget: { calls: ceiling - budget.spent, timeMs: preparationTime(progress.pending.length) },
      carried: { calls: budget.spent, elapsedMs: progress.elapsedMs ?? 0 } });
    return structuredClone(experiment);
  });
}

/**
 * «Продолжить в новом формате»: a first-format draft goes on as a new draft of cards (card/convert.ts). The old draft
 * stays as it was and nothing is paid here: the new cards wait for the reviewer, whose check the owner agrees to.
 */
export function convertV1Draft(lab: Lab, id: string): Promise<Pick<Conversion, 'library' | 'left' | 'calls'> & { experiment: Experiment }> {
  return lab.operations.change(async () => {
    const previous = await lab.store.get(id);
    const library = libraryV1Of(previous);
    if (!library) throw new Error('Это не черновик старого формата: переносить нечего.');
    if (!convertible(previous)) throw new Error('Прогон старого формата не переносится: его можно открыть, переоценить и повторить как есть.');
    const now = new Date().toISOString();
    const record: Experiment = { ...structuredClone(previous), id: randomUUID(), createdAt: now, updatedAt: now, phase: 'review',
      message: 'Ситуации перенесены в новый формат. Lab проверит их, прежде чем их можно будет утвердить для прогона.',
      scenarios: [], acceptedTests: [], trials: [], comparisons: [], iterations: [], humanReviews: [], usage: emptyUsage(),
      reviewedAt: null, reviewMode: null, manifestHash: null, controlConsumedAt: null, error: null };
    delete record.acceptedDraftHash; delete record.selectedScenarioIds; delete record.positiveControlScenarioIds; delete record.ownerExpectationScenarioIds;
    delete record.parentRunId; delete record.executionRunId; delete record.sourceEvidence; delete record.resultsReviewedAt; delete record.resultsReviewHash;
    delete record.failureModes; delete record.targetRelease; delete record.assessmentOf; delete record.assessmentTrialIds; delete record.evidenceHash;
    delete record.releaseLog; delete record.calibration;
    record.evaluatorVersion = evaluatorVersion(record.settings);
    const conversion = convertV1Library(library, { id: `library_${record.id}`, createdAt: now, sources: record.sources, requirements: record.requirements });
    if (!conversion.library.cards.length) throw new Error(`Ни одну ситуацию этого черновика не перенести: ${conversion.left[0]?.reason ?? 'в нём нет ситуаций'}. Подготовьте ситуации заново.`);
    record.librarySnapshot = conversion.library;
    record.preparationProgress = convertedPreparation(record, conversion, previous.preparationProgress);
    // The cards cite the old library's dialogues; the store keeps them next to every other import.
    for (const batch of library.imports) await lab.store.writeImport(batch);
    await lab.store.publishLibrary(record, conversion.library);
    return { experiment: structuredClone(record), library: conversion.library, left: conversion.left, calls: conversion.calls };
  });
}
