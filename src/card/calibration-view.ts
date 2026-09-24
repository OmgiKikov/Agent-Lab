import type { Experiment, Scenario, Trial } from '../contracts.js';
import { SMALL_SAMPLE, wilson } from '../interval.js';
import { expectationResult } from '../outcomes.js';
import { pluralForm } from '../plural.js';
import type { RunDerivation, Verdict } from '../run.js';
import type { BehaviorPolicy } from '../scenario-contracts.js';
import type { Calibration } from './calibration.js';
import { calibrationMode, runLogSituations, type LogSituation } from './calibration-scope.js';
import { logJudgmentComplete, notExercised } from './log-judge.js';
import type { DialogueNumbers } from './view.js';

/*
 * The calibration of a run as the owner reads it (docs/design/card-v2-spec.md §10.4–10.5), built from the record alone, next to the
 * number and never moving it:
 *
 *   situation of a log ──expectations decided on both sides (E′)──► none: not compared, with the first reason
 *                      └─ s(e) = l(e) for every e in E′ ──► agrees; otherwise a disagreement with its evidence
 *
 * s(e) is the synthetic verdict of the headline rule (every attempt, fail first, the channel gate, the owner's
 * verdicts); l(e) is the log judge's receipt. A disagreement names both conversations and compares the customer's
 * path in each — the controller's moves against the late messages the card accounts for — so the owner sees
 * whether the synthetic customer or the agent behaved differently. No text is interpreted: paths are typed moves.
 */

/** Why a situation of the run was not compared with its log. */
export type CalibrationExclusion = 'not_from_log' | 'situation_edited' | 'no_agent_reply' | 'channel_unobserved' | 'not_exercised_in_log' | 'judge_split' | 'synthetic_unmeasured';
/** The order of the exclusions line. */
const EXCLUSIONS: readonly CalibrationExclusion[] = ['not_from_log', 'situation_edited', 'no_agent_reply', 'channel_unobserved', 'not_exercised_in_log', 'judge_split', 'synthetic_unmeasured'];
/** Which reason a situation with no comparable expectation is given: the first of these found among its expectations. */
const UNCOMPARED: readonly CalibrationExclusion[] = ['no_agent_reply', 'channel_unobserved', 'not_exercised_in_log', 'judge_split', 'synthetic_unmeasured'];
const EXCLUSION_TEXT: Record<CalibrationExclusion, string> = {
  not_from_log: 'не из логов',
  situation_edited: 'ситуация изменена',
  no_agent_reply: 'в логе агент не ответил',
  channel_unobserved: 'в логе не записаны действия агента',
  not_exercised_in_log: 'в логе не дошло до ожидания',
  judge_split: 'судья не решил по логу',
  synthetic_unmeasured: 'в синтетике не измерено',
};

type Decided = 'pass' | 'fail';
export interface CalibrationDisagreement {
  cardId: string; number: number; title: string;
  /** The expectations decided differently: the synthetic verdict against the verdict on the log. */
  expectations: { id: string; letter: string; text: string; synthetic: Decided; log: Decided }[];
  /** The customer's moves after the first message, in the synthetic attempt and in the log; `same` ignores the final leaving, which ends both. */
  path: { synthetic: string[]; log: string[]; same: boolean };
  /** What the paths suggest, in the owner's words. */
  hint: string;
  /** The synthetic attempts behind the synthetic verdict; the path is read from the first. */
  trialIds: string[];
  /** The logged conversation; `number` is its place in the import, null when the import is not at hand. */
  log: { importId: string; dialogueId: string; number: number | null };
}

export interface CalibrationView {
  mode: 'calibration' | 'comparison';
  /** Why agreement is not a calibration; null for a calibration. */
  versionNote: string | null;
  /** Situations whose decided expectations agree, of those compared, and the 95% interval of that share. */
  agreed: number; compared: number; range: [number, number] | null;
  /** The line under the number. */
  text: string;
  excluded: { reason: CalibrationExclusion; count: number; cardIds: string[] }[];
  disagreements: CalibrationDisagreement[];
  /** Why the calibration stopped before every expectation was judged; null when it finished. */
  unfinished: 'budget' | 'stopped' | null;
}

/** What the reader of a calibration is told in the details, whatever it shows. */
export const CALIBRATION_CAVEATS = [
  'С обеих сторон судит один и тот же судья: совпадение не доказывает, что судья прав, — это показывают ваши отметки согласия с ним.',
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

const decisionOf = (result: unknown): string | undefined => {
  const decision = (result as { decision?: { actionId?: unknown } } | null | undefined)?.decision;
  return typeof decision?.actionId === 'string' ? decision.actionId : undefined;
};

/** The controller's accepted moves in one synthetic attempt. */
function syntheticSteps(trial: Trial | undefined, policy: BehaviorPolicy, facts: ReadonlyMap<string, string>): Step[] {
  return (trial?.events ?? []).filter(event => event.type === 'simulator').flatMap(event => {
    const action = policy.actions.find(item => item.id === decisionOf(event.result));
    return action ? [actionStep(action, facts)] : [];
  });
}

/** The customer's program, the names of its facts, and the late messages of its log as steps: a card's coverage, a variant's source coverage. */
function pathSources(record: Experiment, scenario: Scenario): { policy: BehaviorPolicy; facts: Map<string, string>; log: Step[] } | undefined {
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
    return { policy, facts, log };
  }
  const variant = library.variants.find(item => item.id === scenario.id);
  if (!variant) return undefined;
  const facts = new Map(variant.userState.facts.map(fact => [fact.id, fact.statement]));
  const log = [...variant.sourceCoverage ?? []].sort((a, b) => a.eventIndex - b.eventIndex).flatMap((entry): Step[] =>
    entry.disposition === 'initial_fact' ? [{ kind: 'told', facts: entry.factIds }]
      : entry.disposition === 'conditional_action' ? entry.actionIds.flatMap(id => policy.actions.filter(action => action.id === id).map(action => actionStep(action, facts))) : []);
  return { policy, facts, log };
}

/** Both paths and the first place they part; leaving at the end is how both conversations end, so it never counts as a difference. */
function comparePaths(synthetic: Step[], log: Step[], facts: ReadonlyMap<string, string>): { path: CalibrationDisagreement['path']; first: string | null } {
  const moves = (steps: Step[]) => steps.at(-1)?.kind === 'left' ? steps.slice(0, -1) : steps;
  const a = moves(synthetic), b = moves(log);
  const at = Array.from({ length: Math.max(a.length, b.length) }, (_, index) => index).find(index => !a[index] || !b[index] || !sameStep(a[index]!, b[index]!));
  const said = (step: Step | undefined) => step ? stepText(step, facts) : 'разговор закончился';
  return { path: { synthetic: synthetic.map(step => stepText(step, facts)), log: log.map(step => stepText(step, facts)), same: at === undefined },
    first: at === undefined ? null : `в синтетике — ${said(a[at])}, в логе — ${said(b[at])}` };
}

/** The deterministic hint of a disagreement (docs/design/card-v2-spec.md §10.5). */
function hintOf(first: string | null, mode: CalibrationView['mode']): string {
  if (first) return `Синтетический клиент повёл себя иначе, чем реальный: ${first}. Это дрейф симулятора или ситуации.`;
  return mode === 'calibration' ? 'Клиент тот же — различается ответ агента: проверьте окружение стенда или шум судьи.'
    : 'Клиент тот же — вероятно, изменился агент (версии различаются или неизвестны).';
}

/* ───────────────────────────── the view ───────────────────────────── */

interface Row { id: string; letter: string; text: string; synthetic: Verdict; log: Verdict | undefined; reason?: CalibrationExclusion }

/** Each expectation of a situation on both sides, with the reason it cannot be compared. */
function expectationRows(record: Experiment, calibration: Calibration, situation: LogSituation, parts: readonly { id: string; outcome: Verdict }[]): Row[] {
  return situation.expectations.map(({ expectation, letter }) => {
    const synthetic = parts.find(part => part.id === expectation.id)?.outcome ?? 'unknown';
    const entry = calibration.entries.find(item => item.cardId === situation.id && item.expectationId === expectation.id);
    // A receipt that does not stand (incomplete, altered, of another definition) decides nothing.
    const log = entry ? logJudgmentComplete(entry, record) ? entry.result : 'unknown' : undefined;
    const reason = entry?.skipped ?? (log === 'unknown' ? notExercised(entry!.votes) && entry!.complete ? 'not_exercised_in_log' : 'judge_split' : undefined)
      ?? (synthetic === 'unknown' ? 'synthetic_unmeasured' : undefined);
    return { id: expectation.id, letter, text: expectation.text, synthetic, log, ...(reason ? { reason } : {}) };
  });
}

/** The line under the number, in the owner's words. */
function trustText(view: Omit<CalibrationView, 'text'>): string {
  const unfinished = view.unfinished === 'budget' ? 'не хватило лимита вызовов судьи' : 'прогон остановили';
  if (!view.compared) return view.unfinished === 'budget' ? 'Сверка с продом пропущена: не хватило лимита вызовов судьи.'
    : view.unfinished ? 'Сверку с продом остановили раньше, чем удалось что-то сравнить.' : 'С продом сравнить не удалось: ни одна ситуация из логов не решена и в синтетике, и в логе.';
  const counted = `в ${view.agreed} из ${view.compared} ${pluralForm(view.compared, SITUATIONS_OF)}`;
  const main = view.mode === 'calibration' ? `Синтетика совпадает с продом ${counted}.` : `С записанными диалогами совпадает ${counted}. Это не калибровка: ${view.versionNote}.`;
  const small = view.mode === 'calibration' && view.compared < SMALL_SAMPLE && view.range ? ` Мало данных: от ${percent(view.range[0])} до ${percent(view.range[1])}.` : '';
  return `${main}${small}${view.unfinished ? ` Сверка не завершена: ${unfinished}.` : ''}`;
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
  const excluded = new Map<CalibrationExclusion, string[]>();
  const exclude = (reason: CalibrationExclusion, id: string) => { excluded.set(reason, [...excluded.get(reason) ?? [], id]); };
  const disagreements: CalibrationDisagreement[] = [];
  let agreed = 0, compared = 0;
  for (const situation of situations) {
    if (situation.exclusion) { exclude(situation.exclusion, situation.id); continue; }
    const derived = run.situation(situation.id);
    if (!situation.log || !derived) continue;
    const rows = expectationRows(record, calibration, situation, derived.parts);
    const comparable = rows.filter((row): row is Row & { synthetic: Decided; log: Decided } => (row.synthetic === 'pass' || row.synthetic === 'fail') && (row.log === 'pass' || row.log === 'fail'));
    if (!comparable.length) {
      // No reason at all: its expectations were not judged on the log yet — a calibration that did not finish.
      const reason = UNCOMPARED.find(code => rows.some(row => row.reason === code));
      if (reason) exclude(reason, situation.id);
      continue;
    }
    compared++;
    const differing = comparable.filter(row => row.synthetic !== row.log);
    if (!differing.length) { agreed++; continue; }
    const trials = derived.attempts.map(attempt => attempt.trial);
    const supporting = trials.filter(trial => differing.some(row => row.synthetic === 'pass'
      || expectationResult(trial, { ...situation.expectations.find(item => item.expectation.id === row.id)!.expectation, letter: row.letter }, record.humanReviews) === 'fail'));
    const sources = pathSources(record, situation.scenario);
    const paths = sources ? comparePaths(syntheticSteps(supporting[0], sources.policy, sources.facts), sources.log, sources.facts) : { path: { synthetic: [], log: [], same: true }, first: null };
    disagreements.push({ cardId: situation.id, number: situation.number, title: situation.title,
      expectations: differing.map(({ id, letter, text, synthetic, log }) => ({ id, letter, text, synthetic, log })),
      path: paths.path, hint: hintOf(paths.first, mode), trialIds: supporting.map(trial => trial.id),
      log: { importId: situation.log.importId, dialogueId: situation.log.dialogueId, number: logNumber(record, situation.log.importId, situation.log.dialogueId, options.numbers) } });
  }
  const view: Omit<CalibrationView, 'text'> = { mode, versionNote, agreed, compared, range: wilson(agreed, compared),
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
/** One disagreeing expectation: «Б · объяснить, как оформить возврат — в синтетике: выполнил, в проде: нет». */
export const disagreementText = (row: CalibrationDisagreement['expectations'][number]): string =>
  `${row.letter} · ${row.text} — в синтетике: ${VERDICT_WORD[row.synthetic]}, в проде: ${VERDICT_WORD[row.log]}`;
/** Where the two conversations of a disagreement are: the run's attempt and the logged dialogue. */
export const conversationsText = (item: Pick<CalibrationDisagreement, 'log'>): string =>
  `Разговоры: попытка в этом прогоне · ${item.log.number === null ? 'исходный разговор из логов' : `диалог №${item.log.number} из логов`}`;
