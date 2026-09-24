import type { Experiment, HumanReview, Scenario, Trial } from '../contracts.js';
import { controllerEvent } from '../customer-moves.js';
import { SMALL_SAMPLE, wilson } from '../interval.js';
import { expectationResult, humanOverride, latestHumanReviews } from '../outcomes.js';
import { pluralForm } from '../plural.js';
import type { AttemptDerivation, RunDerivation, SituationDerivation, Verdict } from '../run.js';
import type { BehaviorPolicy } from '../scenario-contracts.js';
import type { Calibration, LogJudgmentReceipt, LogReview } from './calibration.js';
import { calibrationMode, runLogSituations, type LogSituation } from './calibration-scope.js';
import { headlineRule, type CountedExpectation } from './expectations.js';
import { logJudgmentComplete, logUndecided } from './log-judge.js';
import type { DialogueNumbers } from './view.js';

/*
 * The calibration of a run as the owner reads it (docs/design/card-v2-spec.md §10.4–10.5), built from the record alone, next to the
 * number and never moving it:
 *
 *   situation of a log ──one synthetic conversation: the first usable repeat of the customer that plays the card
 *                      └─ its logged conversation: the log judge's receipt
 *     ──expectations decided on both sides (E′)──► none: not compared, with the first reason
 *                                                 └─ s(e) = l(e) for every e in E′ ──► agrees; otherwise softer, stricter or both
 *
 * One conversation against one conversation. The headline reads every repeat fail-first, so the more repeats a run has,
 * the stricter its verdict of a situation: set against the single logged conversation, agreement would fall with the
 * repeats while the customer stayed the same. Here each side is one conversation of the situation, so agreement means
 * the same whatever the repeats, and each situation is one yes-or-no — what Wilson's interval counts. The customer
 * compared is the one that plays the card (reactive); scripted lines and a bare opening are its baselines, compared
 * only in a run without it.
 *
 * s(e) and l(e) are the judge's verdicts — the attempt's read through its channel gate, the log's from its receipt — or
 * the owner's where their latest word replaces the judge's: a verdict on the attempt, `log:{key}` on the log
 * (calibration.ts LogReview). A disagreement says whose each side is, and where they differ the hint sends the owner to
 * the side nobody checked. Agreement where every compared expectation passed, or every one failed, on both sides tells
 * nothing about the customer — any customer would agree — and the line says so. A disagreement compares the customer's
 * path in each conversation, both read the same way (the moves the log's account can record), so the owner sees
 * whether the customer or the agent behaved differently. No text is interpreted: paths are typed moves.
 */

/** Why a situation of the run was not compared with its log. */
export type CalibrationExclusion = 'not_from_log' | 'situation_edited' | 'no_agent_reply' | 'channel_unobserved' | 'not_exercised_in_log'
  | 'receipt_invalid' | 'judge_failed' | 'owner_unknown' | 'judge_split' | 'no_evidence' | 'judge_unclear' | 'synthetic_unmeasured';
/**
 * Which reason a situation with no comparable expectation is given: the first of these found among its expectations —
 * what the log cannot show, then why its judgment decided nothing (a failure before a verdict), then the synthetic side.
 */
const UNCOMPARED: readonly CalibrationExclusion[] = ['no_agent_reply', 'channel_unobserved', 'not_exercised_in_log', 'receipt_invalid', 'judge_failed',
  'owner_unknown', 'judge_split', 'no_evidence', 'judge_unclear', 'synthetic_unmeasured'];
/** The order of the exclusions line. */
const EXCLUSIONS: readonly CalibrationExclusion[] = ['not_from_log', 'situation_edited', ...UNCOMPARED];
const EXCLUSION_TEXT: Record<CalibrationExclusion, string> = {
  not_from_log: 'не из логов',
  situation_edited: 'ситуация изменена',
  no_agent_reply: 'в логе агент не ответил',
  channel_unobserved: 'в логе не записаны действия агента',
  not_exercised_in_log: 'в логе не дошло до ожидания',
  receipt_invalid: 'запись судьи по логу не сходится',
  judge_failed: 'ответа судьи по логу нет',
  owner_unknown: 'вы не смогли решить по логу',
  judge_split: 'оценки судьи по логу разошлись',
  no_evidence: 'в логе нет доказательства',
  judge_unclear: 'судья не смог решить по логу',
  synthetic_unmeasured: 'в синтетике не измерено',
};

type Decided = 'pass' | 'fail';
/** Whose verdict one side of a comparison is: the judge's, or the owner's where their latest word replaces it (outcomes.ts humanOverride). */
export type Decider = 'judge' | 'owner';
/** How a disagreeing situation leans: the synthetic side passed every differing expectation the log failed, failed every one the log passed, or both. */
export type Leaning = 'softer' | 'stricter' | 'both';

export interface CalibrationDisagreement {
  cardId: string; number: number; title: string;
  /** The expectations decided differently: the synthetic verdict against the verdict on the log, and whose each one is. */
  expectations: { id: string; letter: string; text: string; synthetic: Decided; log: Decided; decidedBy: { synthetic: Decider; log: Decider } }[];
  leaning: Leaning;
  /**
   * The customer's moves after the first message that both sides can record, in the compared attempt and in the log;
   * `same` ignores the final leaving, which ends both. Null when the attempt's moves could not be read.
   */
  path: { synthetic: string[]; log: string[]; same: boolean } | null;
  /** What the difference suggests, in the owner's words. */
  hint: string;
  /** The synthetic attempt compared; the path is read from it. */
  trialIds: string[];
  /** The compared attempt's place among the situation's repeats, from 1; absent when the run does not repeat situations. */
  attempt?: number;
  /** The logged conversation; `number` is its place in the import, null when the import is not at hand. */
  log: { importId: string; dialogueId: string; number: number | null };
}

export interface CalibrationView {
  mode: 'calibration' | 'comparison';
  /** Why agreement is not a calibration; null for a calibration. */
  versionNote: string | null;
  /** Situations whose decided expectations agree, of those compared, and the 95% interval of that share. */
  agreed: number; compared: number; range: [number, number] | null;
  /** The situations that disagree, by how the synthetic side leans against the log. */
  leaning: Record<Leaning, number>;
  /** Every compared expectation passed on both sides, or every one failed on both: agreement then tells nothing about the customer. Null otherwise. */
  degenerate: 'all_pass' | 'all_fail' | null;
  /** Compared situations whose customer says values Lab wrote over the log's masking marks; the log judge read the marks. */
  masked: number;
  /** The line under the number. */
  text: string;
  excluded: { reason: CalibrationExclusion; count: number; cardIds: string[] }[];
  disagreements: CalibrationDisagreement[];
  /** Why the calibration stopped before every expectation was judged; null when it finished. */
  unfinished: NonNullable<Calibration['unfinished']> | null;
}

/** What the reader of a calibration is told in the details, whatever it shows. */
export const CALIBRATION_CAVEATS = [
  'Где вы не поправляли судью, обе стороны оценивает один и тот же судья: совпадение не доказывает, что он прав, — это показывают ваши отметки согласия с ним.',
  'С разговором из логов сравнивается одна попытка каждой ситуации — первая измеренная; число выше учитывает все попытки.',
  'Сверка покрывает только ситуации из логов.',
  'Тестовый стенд и прод могут различаться даже при одной версии агента.',
] as const;

const percent = (share: number) => `${Math.round(share * 100)}%`;
const SITUATIONS_OF: [string, string, string] = ['ситуации', 'ситуаций', 'ситуаций'];

/* ───────────────────────────── the customer's path ───────────────────────────── */

type Step = { kind: 'told' | 'dunno'; facts: string[] } | { kind: 'turn' | 'left' | 'asked' | 'corrected' };
const sameStep = (a: Step, b: Step): boolean => a.kind === b.kind
  && (!('facts' in a) || 'facts' in b && [...a.facts].sort().join('|') === [...b.facts].sort().join('|'));

/** A move of the customer's program as a step: what the customer did, never the words. */
function actionStep(action: BehaviorPolicy['actions'][number], facts: ReadonlyMap<string, string>): Step {
  switch (action.kind) {
    case 'answer': return { kind: 'told', facts: action.factIds };
    // A card's «не знаю» about one fact is the move `dunno_<fact>` (compile.ts); any other is a question it has no answer to.
    case 'missing': return { kind: 'dunno', facts: action.factIds.length ? action.factIds : action.id.startsWith('dunno_') && facts.has(action.id.slice(6)) ? [action.id.slice(6)] : [] };
    case 'change_intent': case 'observe': return { kind: 'turn' };
    case 'finish': return { kind: 'left' };
    case 'clarify': return { kind: 'asked' };
    case 'correct': return { kind: 'corrected' };
  }
}

function stepText(step: Step, facts: ReadonlyMap<string, string>): string {
  const named = (ids: string[]) => ids.map(id => `„${facts.get(id) ?? id}“`).join(', ');
  switch (step.kind) {
    case 'told': return `назвал ${named(step.facts)}`;
    case 'dunno': return step.facts.length ? `не знает ${named(step.facts)}` : 'сказал, что не знает';
    case 'turn': return 'повернул разговор';
    case 'left': return 'ушёл';
    case 'asked': return 'уточнил';
    case 'corrected': return 'поправил ответ';
  }
}

/**
 * The controller's accepted moves in one synthetic attempt, each read through the typed record of a move
 * (customer-moves.ts). Null when the attempt holds a move this cannot read — a record of another form, or an action
 * its definition does not declare — so a path is never read shorter than it was. A bare opening has no move at all.
 */
function syntheticSteps(trial: Trial, policy: BehaviorPolicy, facts: ReadonlyMap<string, string>): Step[] | null {
  const steps: Step[] = [];
  for (const event of trial.events) {
    if (event.type !== 'simulator') continue;
    const move = controllerEvent.safeParse(event.result);
    const action = move.success ? policy.actions.find(item => item.id === move.data.decision.actionId) : undefined;
    if (!action) return null;
    steps.push(actionStep(action, facts));
  }
  return steps;
}

/**
 * A customer's program and log as the path comparison reads them: the program, the names of its facts, the facts its
 * opening already says, whether the log's account can hold a «не знаю» that names no fact, and the late messages that
 * account records, as steps.
 */
interface PathSources { policy: BehaviorPolicy; facts: Map<string, string>; opening: string[]; unnamedDunno: boolean; log: Step[] }

/** The sources of a card (its coverage) or of a first-format variant (its source coverage). */
function pathSources(record: Experiment, scenario: Scenario): PathSources | undefined {
  const library = record.librarySnapshot;
  const policy = scenario.execution?.userView.policy;
  if (!library || !policy) return undefined;
  if (library.formatVersion === 2) {
    const card = library.cards.find(item => item.id === scenario.id);
    if (!card) return undefined;
    const facts = new Map(card.client.knows.map(fact => [fact.id, fact.label]));
    const at = (index: number) => card.client.knows.filter(fact => fact.source.kind === 'dialogue' && fact.source.event.eventIndex === index);
    const log = [...card.coverage].sort((a, b) => a.event.eventIndex - b.event.eventIndex).flatMap((entry): Step[] => {
      if (entry.as === 'turn') return [{ kind: 'turn' }];
      if (entry.as === 'stop') return [{ kind: 'left' }];
      if (entry.as !== 'fact') return [];
      const told = at(entry.event.eventIndex);
      const known = told.filter(fact => fact.disclosure !== 'unknown').map(fact => fact.id), unknown = told.filter(fact => fact.disclosure === 'unknown').map(fact => fact.id);
      return [...(known.length ? [{ kind: 'told' as const, facts: known }] : []), ...(unknown.length ? [{ kind: 'dunno' as const, facts: unknown }] : [])];
    });
    // A card accounts for a later message as a fact, the turn or the leaving; anything else is «ignored», a «не знаю» that names no fact included.
    return { policy, facts, opening: card.client.knows.filter(fact => fact.disclosure === 'initial').map(fact => fact.id), unnamedDunno: false, log };
  }
  const variant = library.variants.find(item => item.id === scenario.id);
  if (!variant) return undefined;
  const facts = new Map(variant.userState.facts.map(fact => [fact.id, fact.statement]));
  const log = [...variant.sourceCoverage ?? []].sort((a, b) => a.eventIndex - b.eventIndex).flatMap((entry): Step[] =>
    entry.disposition === 'initial_fact' ? [{ kind: 'told', facts: entry.factIds }]
      : entry.disposition === 'conditional_action' ? entry.actionIds.flatMap(id => policy.actions.filter(action => action.id === id).map(action => actionStep(action, facts))) : []);
  // A variant accounts for a later message as any move of its program; which facts its opening says it does not record.
  return { policy, facts, opening: [], unnamedDunno: true, log };
}

/**
 * The moves a log's account can record, read the same way on both sides. A fact counts the first time the customer
 * names it, or says they do not know it: naming again one the opening or an earlier message gave is the customer
 * answering the agent's repeated question, and the account records such a message as nothing. A «не знаю» that names
 * no fact counts only where the account can hold one.
 */
function recordable(steps: readonly Step[], sources: Pick<PathSources, 'opening' | 'unnamedDunno'>): Step[] {
  const said = { told: new Set(sources.opening), dunno: new Set<string>() };
  return steps.flatMap((step): Step[] => {
    if (step.kind !== 'told' && step.kind !== 'dunno') return [step];
    if (!step.facts.length) return step.kind === 'told' || sources.unnamedDunno ? [step] : [];
    const seen = said[step.kind];
    const fresh = step.facts.filter(fact => !seen.has(fact));
    for (const fact of fresh) seen.add(fact);
    return fresh.length ? [{ kind: step.kind, facts: fresh }] : [];
  });
}

interface ComparedPaths { path: NonNullable<CalibrationDisagreement['path']>; first: string | null }

/** Both paths as both sides can record them, and the first place they part; leaving at the end is how both conversations end, so it never counts as a difference. */
function comparePaths(synthetic: readonly Step[], sources: PathSources): ComparedPaths {
  const ours = recordable(synthetic, sources), theirs = recordable(sources.log, sources);
  const moves = (steps: Step[]) => steps.at(-1)?.kind === 'left' ? steps.slice(0, -1) : steps;
  const a = moves(ours), b = moves(theirs);
  const at = Array.from({ length: Math.max(a.length, b.length) }, (_, index) => index).find(index => !a[index] || !b[index] || !sameStep(a[index]!, b[index]!));
  const said = (step: Step | undefined) => step ? stepText(step, sources.facts) : 'разговор закончился';
  return { path: { synthetic: ours.map(step => stepText(step, sources.facts)), log: theirs.map(step => stepText(step, sources.facts)), same: at === undefined },
    first: at === undefined ? null : `в синтетике — ${said(a[at])}, в логе — ${said(b[at])}` };
}

/* ───────────────────────────── the two sides ───────────────────────────── */

interface Row { id: string; letter: string; text: string; synthetic: Verdict; log: Verdict | undefined; decidedBy: { synthetic: Decider; log: Decider }; reason?: CalibrationExclusion }
type Compared = Row & { synthetic: Decided; log: Decided };
const decided = (verdict: Verdict | undefined): verdict is Decided => verdict === 'pass' || verdict === 'fail';
/** The owner's when their latest verdict replaces the judge's (outcomes.ts humanOverride: a one-key «не знаю» does not); otherwise the judge's. */
const deciderOf = (review: Pick<HumanReview, 'verdict' | 'source'> | undefined): Decider => humanOverride(review, undefined).result === undefined ? 'judge' : 'owner';

/** The customer a calibration compares, by preference: the one that plays the card, then scripted lines, then the bare opening. */
const MODE_ORDER: readonly Trial['userMode'][] = ['reactive', 'scripted', 'static'];

/**
 * The one synthetic conversation a situation is compared by: of the customer the calibration reads, the first repeat
 * that is a usable measurement of this very definition (outcomes.ts measurementUsable) — whatever its verdict, so the
 * choice never leans on the outcome. Undefined when that customer has no usable attempt.
 */
function comparedAttempt(record: Experiment, situation: SituationDerivation): AttemptDerivation | undefined {
  const { scenario } = situation;
  const own = situation.attempts.filter(({ trial }) => trial.familyId === scenario.familyId && trial.split === scenario.split
    && (!record.manifestHash || trial.manifestHash === record.manifestHash));
  const mode = MODE_ORDER.find(item => own.some(({ trial }) => trial.userMode === item));
  return own.filter(attempt => attempt.trial.userMode === mode && attempt.usable).sort((a, b) => a.trial.repeat - b.trial.repeat)[0];
}

/** The log side of one expectation: the receipt's verdict, or the owner's `log:{key}` over it, with the reason it decides nothing; undefined: not judged yet. */
function logSide(entry: LogJudgmentReceipt | undefined, record: Experiment, marks: ReadonlyMap<string, LogReview>): { verdict: Verdict | undefined; by: Decider; reason?: CalibrationExclusion } {
  if (!entry) return { verdict: undefined, by: 'judge' };
  // A receipt that does not stand — altered, of another definition, or an incomplete judgment — decides nothing.
  const stands = logJudgmentComplete(entry, record);
  const mark = marks.get(entry.key);
  const verdict = humanOverride(mark, stands ? entry.result : 'unknown').result ?? 'unknown';
  const by = deciderOf(mark);
  if (decided(verdict)) return { verdict, by };
  const reason: CalibrationExclusion = by === 'owner' ? 'owner_unknown' : !stands ? entry.complete ? 'receipt_invalid' : 'judge_failed' : logUndecided(entry) ?? 'judge_unclear';
  return { verdict, by, reason };
}

/** Each expectation of a situation on both sides — the compared attempt and the log — with the reason it cannot be compared. */
function expectationRows(record: Experiment, calibration: Calibration, situation: LogSituation, scenario: Scenario, attempt: AttemptDerivation | undefined,
  marks: ReadonlyMap<string, LogReview>): Row[] {
  const rule = attempt ? headlineRule(scenario, [attempt.trial]) : undefined;
  // Only an attempt judged by expectations has a verdict per expectation; a first-format one with checkpoint verdicts has none.
  const counted: CountedExpectation[] = rule?.kind === 'expectations' ? rule.expectations : [];
  const reviews = attempt ? latestHumanReviews({ trials: [attempt.trial], humanReviews: record.humanReviews }) : new Map<string, HumanReview>();
  return situation.expectations.map(({ expectation, letter }) => {
    const judged = counted.find(item => item.id === expectation.id);
    const synthetic = attempt && judged ? expectationResult(attempt.trial, judged, record.humanReviews) ?? 'unknown' : 'unknown';
    const syntheticBy = attempt && judged ? deciderOf(reviews.get(`${attempt.trial.id}|metric:${expectation.id}`)) : 'judge';
    const log = logSide(calibration.entries.find(item => item.cardId === situation.id && item.expectationId === expectation.id), record, marks);
    const reason = log.reason ?? (synthetic === 'unknown' ? 'synthetic_unmeasured' : undefined);
    return { id: expectation.id, letter, text: expectation.text, synthetic, log: log.verdict, decidedBy: { synthetic: syntheticBy, log: log.by }, ...(reason ? { reason } : {}) };
  });
}

const leaningOf = (differing: readonly Compared[]): Leaning => differing.every(row => row.synthetic === 'pass') ? 'softer'
  : differing.every(row => row.synthetic === 'fail') ? 'stricter' : 'both';

/** The deterministic hint of a disagreement (docs/design/card-v2-spec.md §10.5). */
function hintOf(differing: readonly Compared[], paths: ComparedPaths | null, mode: CalibrationView['mode']): string {
  // One side is the owner's word and the other the judge's: the judge may be wrong on the side nobody checked.
  const mixed = differing.find(row => row.decidedBy.synthetic !== row.decidedBy.log);
  if (mixed) return mixed.decidedBy.synthetic === 'owner' ? 'В попытке решение ваше, по логу — судьи: проверьте, прав ли судья по логу.'
    : 'По логу решение ваше, в попытке — судьи: проверьте, прав ли судья в попытке.';
  if (!paths) return 'Путь клиента сравнить не удалось: сравните оба разговора сами.';
  if (paths.first) return `Синтетический клиент повёл себя иначе, чем реальный: ${paths.first}. Это дрейф симулятора или ситуации.`;
  if (mode === 'comparison') return 'Клиент тот же — вероятно, изменился агент (версии различаются или неизвестны).';
  // Where the owner decided both sides, there is no judge's noise to suspect.
  return differing.every(row => row.decidedBy.synthetic === 'owner') ? 'Клиент тот же — различается ответ агента: проверьте окружение стенда.'
    : 'Клиент тот же — различается ответ агента: проверьте окружение стенда или шум судьи.';
}

/* ───────────────────────────── the view ───────────────────────────── */

const UNFINISHED_TEXT: Record<NonNullable<Calibration['unfinished']>, string> = {
  budget: 'не хватило лимита вызовов судьи',
  stopped: 'прогон остановили',
  logs: 'логи недоступны или изменились после подготовки ситуаций',
  failed: 'сбой при сверке',
};

/** The line when nothing was compared, by why the calibration did not finish. */
function nothingCompared(unfinished: CalibrationView['unfinished']): string {
  switch (unfinished) {
    case 'budget': case 'logs': return `Сверка с продом пропущена: ${UNFINISHED_TEXT[unfinished]}.`;
    case 'stopped': return 'Сверку с продом остановили раньше, чем удалось что-то сравнить.';
    case 'failed': return 'Сверка с продом прервалась из-за сбоя раньше, чем удалось что-то сравнить.';
    case null: return 'С продом сравнить не удалось: ни одна ситуация из логов не решена и в синтетике, и в логе.';
  }
}

const LEANING_WORD: Record<Leaning, string> = { softer: 'мягче', stricter: 'строже', both: 'в обе стороны' };
/** «, расходится в 2: мягче прода в 1, строже в 1» — how the disagreeing situations lean; empty when none disagrees. */
function leaningText(leaning: CalibrationView['leaning'], versus: string): string {
  const kinds = (['softer', 'stricter', 'both'] as const).filter(kind => leaning[kind] > 0);
  const total = kinds.reduce((sum, kind) => sum + leaning[kind], 0);
  if (!total) return '';
  // The first comparative names what the synthetic side is compared with: «мягче прода в 1, строже в 1».
  const word = (kind: Leaning, index: number) => index === 0 && kind !== 'both' ? `${LEANING_WORD[kind]} ${versus}` : LEANING_WORD[kind];
  return kinds.length === 1 ? `, расходится в ${total} — ${word(kinds[0]!, 0)}`
    : `, расходится в ${total}: ${kinds.map((kind, index) => `${word(kind, index)} в ${leaning[kind]}`).join(', ')}`;
}

const DEGENERATE_TEXT: Record<NonNullable<CalibrationView['degenerate']>, string> = { all_pass: 'справился везде', all_fail: 'не справился нигде' };

/** «Синтетика совпадает с продом в 13 из 15 ситуаций, расходится в 2: мягче прода в 1, строже в 1.» */
function agreementText(view: Omit<CalibrationView, 'text'>): string {
  const counted = `в ${view.agreed} из ${view.compared} ${pluralForm(view.compared, SITUATIONS_OF)}`;
  const calibration = view.mode === 'calibration';
  const main = calibration ? `Синтетика совпадает с продом ${counted}` : `С записанными диалогами совпадает ${counted}`;
  if (view.degenerate) return `${main}, но это ничего не доказывает: и в синтетике, и ${calibration ? 'в проде' : 'в логах'} агент ${DEGENERATE_TEXT[view.degenerate]} — так совпал бы любой клиент.`;
  return `${main}${leaningText(view.leaning, calibration ? 'прода' : 'логов')}.`;
}

/** The line under the number, in the owner's words. */
function trustText(view: Omit<CalibrationView, 'text'>): string {
  if (!view.compared) return nothingCompared(view.unfinished);
  const version = view.mode === 'comparison' ? ` Это не калибровка: ${view.versionNote}.` : '';
  const masked = view.masked ? ` В ${view.masked} из них значения в логах скрыты, в синтетике — подставлены Lab.` : '';
  // An agreement that proves nothing has no interval worth reading.
  const small = view.mode === 'calibration' && !view.degenerate && view.compared < SMALL_SAMPLE && view.range
    ? ` Мало данных: от ${percent(view.range[0])} до ${percent(view.range[1])}.` : '';
  return `${agreementText(view)}${version}${masked}${small}${view.unfinished ? ` Сверка не завершена: ${UNFINISHED_TEXT[view.unfinished]}.` : ''}`;
}

/** The place of a logged dialogue in its import: from the caller when the imports are at hand, from a first-format library that carries them. */
function logNumber(record: Experiment, importId: string, dialogueId: string, numbers?: DialogueNumbers): number | null {
  const known = numbers?.(importId, dialogueId);
  if (known !== undefined) return known;
  const library = record.librarySnapshot;
  const batch = library?.formatVersion === 1 ? library.imports.find(item => item.id === importId) : undefined;
  const index = batch?.dialogues.findIndex(item => item.id === dialogueId) ?? -1;
  return index < 0 ? null : index + 1;
}

/**
 * The calibration of a run for every surface; undefined when the run has none (never calibrated, calibration off,
 * or no situation from a log). `numbers` places the logged dialogues in their imports.
 */
export function buildCalibration(run: RunDerivation, options: { numbers?: DialogueNumbers } = {}): CalibrationView | undefined {
  const { record } = run;
  const calibration = record.calibration;
  if (!calibration) return undefined;
  const situations = runLogSituations(record);
  const logged = situations.filter(situation => !situation.exclusion && situation.log);
  const { mode, versionNote } = calibrationMode(calibration, logged.map(situation => situation.log!.importId));
  // The owner's latest verdict on each receipt: a later one replaces an earlier.
  const marks = new Map((calibration.reviews ?? []).map(review => [review.key, review]));
  const excluded = new Map<CalibrationExclusion, string[]>();
  const exclude = (reason: CalibrationExclusion, id: string) => { excluded.set(reason, [...excluded.get(reason) ?? [], id]); };
  const disagreements: CalibrationDisagreement[] = [];
  const leaning: Record<Leaning, number> = { softer: 0, stricter: 0, both: 0 };
  const pairs: Compared[] = [];
  let agreed = 0, compared = 0, masked = 0;
  for (const situation of situations) {
    if (situation.exclusion) { exclude(situation.exclusion, situation.id); continue; }
    const derived = run.situation(situation.id);
    if (!situation.log || !derived) continue;
    const attempt = comparedAttempt(record, derived);
    const rows = expectationRows(record, calibration, situation, derived.scenario, attempt, marks);
    const comparable = rows.filter((row): row is Compared => decided(row.synthetic) && decided(row.log));
    if (!attempt || !comparable.length) {
      // No reason at all: its expectations were not judged on the log yet — a calibration that did not finish.
      const reason = UNCOMPARED.find(code => rows.some(row => row.reason === code));
      if (reason) exclude(reason, situation.id);
      continue;
    }
    compared++;
    if (situation.masked) masked++;
    pairs.push(...comparable);
    const differing = comparable.filter(row => row.synthetic !== row.log);
    if (!differing.length) { agreed++; continue; }
    const lean = leaningOf(differing);
    leaning[lean]++;
    const sources = pathSources(record, derived.scenario);
    const steps = sources && syntheticSteps(attempt.trial, sources.policy, sources.facts);
    const paths = sources && steps ? comparePaths(steps, sources) : null;
    disagreements.push({ cardId: situation.id, number: situation.number, title: situation.title,
      expectations: differing.map(({ id, letter, text, synthetic, log, decidedBy }) => ({ id, letter, text, synthetic, log, decidedBy })),
      leaning: lean, path: paths?.path ?? null, hint: hintOf(differing, paths, mode), trialIds: [attempt.trial.id],
      ...(record.settings.repeats > 1 ? { attempt: attempt.trial.repeat + 1 } : {}),
      log: { importId: situation.log.importId, dialogueId: situation.log.dialogueId, number: logNumber(record, situation.log.importId, situation.log.dialogueId, options.numbers) } });
  }
  const all = (synthetic: Decided) => pairs.length > 0 && pairs.every(row => row.synthetic === synthetic && row.log === synthetic);
  const view: Omit<CalibrationView, 'text'> = { mode, versionNote, agreed, compared, range: wilson(agreed, compared), leaning,
    degenerate: all('pass') ? 'all_pass' : all('fail') ? 'all_fail' : null, masked,
    excluded: EXCLUSIONS.flatMap(reason => excluded.has(reason) ? [{ reason, count: excluded.get(reason)!.length, cardIds: excluded.get(reason)! }] : []),
    disagreements, unfinished: calibration.unfinished ?? null };
  return { ...view, text: trustText(view) };
}

/** «Не сравнивались: 4 — ситуация изменена (2), в логе не дошло до ожидания (2).»; null when every situation was compared. */
export function exclusionsLine(view: Pick<CalibrationView, 'excluded'>): string | null {
  const total = view.excluded.reduce((sum, item) => sum + item.count, 0);
  return total ? `Не сравнивались: ${total} — ${view.excluded.map(item => `${EXCLUSION_TEXT[item.reason]} (${item.count})`).join(', ')}.` : null;
}

const VERDICT_WORD: Record<Decided, string> = { pass: 'выполнил', fail: 'нет' };
/** One side of a disagreement: the verdict, and «ваша отметка» where it is the owner's word. */
const sideText = (verdict: Decided, by: Decider): string => `${VERDICT_WORD[verdict]}${by === 'owner' ? ' (ваша отметка)' : ''}`;
/** One disagreeing expectation: «Б · объяснить, как оформить возврат — в синтетике: выполнил, в проде: нет». */
export const disagreementText = (row: CalibrationDisagreement['expectations'][number]): string =>
  `${row.letter} · ${row.text} — в синтетике: ${sideText(row.synthetic, row.decidedBy.synthetic)}, в проде: ${sideText(row.log, row.decidedBy.log)}`;
/** Where the two conversations of a disagreement are: the run's attempt compared and the logged dialogue. */
export const conversationsText = (item: Pick<CalibrationDisagreement, 'log' | 'attempt'>): string =>
  `Разговоры: попытка${item.attempt === undefined ? '' : ` ${item.attempt}`} в этом прогоне · ${item.log.number === null ? 'исходный разговор из логов' : `диалог №${item.log.number} из логов`}`;
