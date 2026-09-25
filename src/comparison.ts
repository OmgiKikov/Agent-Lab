import { headlineRule } from './card/expectations.js';
import { judgedByCheckpoints } from './card/legacy-v1.js';
import { customerProtocolsOf } from './card-customer.js';
import { hasCompleteJudgment, observableSources, scenarioSources } from './judge.js';
import { roleChoices } from './llm/models.js';
import { agentIdentity, judgeSettingsIdentity, normalizeScenarioIdentity } from './normalize.js';
import { fingerprint, type Experiment, type Scenario, type SourceIdentity, type Tier, type Trial, type UserMode } from './contracts.js';
import { headlineMetricIds, headlineTrialResult, latestHumanReviews, measured, observedRecord, RULES_METRIC_ID } from './outcomes.js';
import { attemptKey, expectedAttemptRows, headlineCardOutcome, plannedTrials, runCompleteness } from './run.js';
import { judgeAgreement } from './agreement.js';
import { countText, pluralForm } from './plural.js';
import { agentVersionRelation } from './target-version.js';

/*
 * Two runs compared. The result of a single run — its number, reasons and causes — is derived in run.ts
 * and shown through result-view.ts; nothing here counts a headline. Pure: no I/O or model calls. The words
 * go to the chat, the CLI `diff` and the customer report as they are, so they are the owner's words.
 *
 *   compareRuns        two runs of the same accepted set: before/after per situation
 *   stability*         which decided situations flipped against the source run
 */
const SITUATIONS: [string, string, string] = ['ситуация', 'ситуации', 'ситуаций'];
/**
 * The two units a comparison speaks in, each named in every statement: situations — what was fixed or broke — and pairs
 * of conversations, a conversation «до» and the same one «после», which is what could or could not be compared.
 * Genitive after «из» and «у»: «из 1 пары разговоров», «у 5 пар разговоров».
 */
const PAIRS_OF: [string, string, string] = ['пары разговоров', 'пар разговоров', 'пар разговоров'];

function rubricReviewNote(scenario: Scenario | undefined, before: Trial, after: Trial): string | undefined {
  const replies = before.events.filter(e => e.type === 'assistant').map(e => e.text);
  const flipped = scenario?.metrics?.some(m => m.subject === 'agent'
    && before.assessments?.some(a => a.metricId === m.id && a.result !== 'unknown'
      && after.assessments?.some(b => b.metricId === m.id && b.result !== 'unknown' && b.result !== a.result)));
  return flipped && replies.length && fingerprint(replies) === fingerprint(after.events.filter(e => e.type === 'assistant').map(e => e.text))
    ? 'Ответы агента совпали, а оценки судьи различаются: разница не доказывает, что агент стал лучше или хуже.' : undefined;
}

/** Below this many compared situations a difference may be chance; repeats do not add situations. */
const TRUSTED_SAMPLE = 30;

/**
 * Two runs of the same cards, before and after a change. This is the everyday question —
 * "did my edit help?" — and a single average answers it badly: an improvement on easy cards
 * hides a regression on the one that matters. So the comparison is per card, per stage and
 * per rung, and it states out loud when the two runs are not actually comparable.
 */
export interface RunComparison {
  headline: string; comparable: boolean;
  pairs: { scenarioId: string; userMode: UserMode; repeat: number; beforeTrialId: string; afterTrialId: string;
    change: 'fixed' | 'regressed' | 'unchanged' | 'unknown'; reviewNote?: string }[];
  coverage: { plannedPairs: number; validPairs: number; excludedPairs: number; missingBefore: number; missingAfter: number; invalidBefore: number; invalidAfter: number;
    /** Each excluded pair once, by its first reason; the parts add up to `excludedPairs`. Absent when nothing was paired. */
    excludedBy?: ExcludedBy };
  cards: { shared: number; onlyBefore: string[]; onlyAfter: string[] };
  fixed: { scenarioId: string; title: string; tier: Tier }[];
  regressed: { scenarioId: string; title: string; tier: Tier }[];
  incomparable: { scenarioId: string; title: string; tier: Tier; userMode: UserMode; repeat: number;
    beforeTrialId?: string; afterTrialId?: string; reason: string }[];
  unchanged: { passing: number; failing: number };
  ungraded: number; includesRubrics: boolean;
  notes: string[];
  /**
   * The agent's version is unknown in either run: its note says what that means for «исправлено» and «сломалось»; the
   * owner is also told how to name it (result-text.ts comparisonRows), a page for others is not.
   */
  versionUnknown?: true;
}

/** Each excluded pair once, by its first reason. */
interface ExcludedBy { invalidBefore: number; missingBefore: number; invalidAfter: number; missingAfter: number; judgeIncomplete: number; other: number }

/** The judge model named on result screens: the one a receipt or an audit recorded, else the model the judge's role resolves to. */
export function judgeModel(record: Experiment): string | undefined {
  return record.trials.map(t => (t.judgeAudit ?? t.judgeReceipt)?.model).find(Boolean) ?? (roleChoices(record.settings).judge.model || undefined);
}

/** One situation whose headline verdict flipped between two decided verdicts. */
export interface StabilityRow { scenarioId: string; title: string; before: 'pass' | 'fail'; after: 'pass' | 'fail' }
/**
 * Found instability only: `checked` situations had a decided verdict on both sides, `unstable`
 * lists the flips. `skipped` names why nothing was compared; it never means «stable».
 */
export interface Stability { basis: 'repeat' | 'reassess'; comparedWith: string; checked: number; unstable: StabilityRow[]; skipped: string | null }

type Decided = 'pass' | 'fail';

/*
 * A source run rebuilt from embedded evidence (artifacts.ts embeddedBefore) is a copy of the
 * current record with the source attempts swapped in: its agent, evaluator and card fields are
 * the current ones. Stability must never compare the current record with itself, so a rebuilt
 * source is registered here and checked against the identity the derived record embedded.
 */
const reconstructedSources = new WeakSet<Experiment>();
const SOURCE_UNAVAILABLE = 'исходный прогон недоступен';
/**
 * Neither the owner's name for the agent's version nor anything Lab saw of its code tells the two runs apart or together.
 * Said where stability was not checked — the customer report —, so it names what is missing and asks nothing.
 */
export const VERSION_UNKNOWN = 'версия агента неизвестна';
/** Marks a run rebuilt from embedded evidence; stability then trusts only `sourceEvidence.identity`. */
export function markReconstructedSource(run: Experiment): Experiment {
  reconstructedSources.add(run);
  return run;
}
/** undefined: `source` is a real run. null: rebuilt without a recorded identity, so nothing can be compared. */
function reconstructedIdentity(source: Experiment, derived: Experiment): SourceIdentity | null | undefined {
  if (!reconstructedSources.has(source)) return undefined;
  const evidence = derived.sourceEvidence;
  return evidence?.runId === source.id && evidence.identity ? evidence.identity : null;
}
/** The card the source attempts were judged against: from the embedded identity when the source was rebuilt. */
function sourceCardIdentity(source: Experiment, card: Scenario, identity: SourceIdentity | undefined): string | undefined {
  return identity ? identity.scenarios[card.id] : fingerprint(normalizeScenarioIdentity(card, source.target.kind));
}
const isDecided = (outcome: 'pass' | 'fail' | 'unknown'): outcome is Decided => outcome !== 'unknown';

/**
 * A repeat of the same set against its source run. Gated on comparability and on proof of the same agent
 * version, so a change of the agent, the judge or the criteria is never called instability, and neither is a
 * version nobody knows: an http agent redeployed at the same address may be fixed, not unstable. Uses the headline
 * verdict (goal and prompt rules, CTX-21), so «нестабильно» matches the number; reply quality and the
 * RAG rubrics never flip a card here.
 */
export function stabilityBetweenRuns(before: Experiment, after: Experiment): Stability {
  const result: Stability = { basis: 'repeat', comparedWith: before.id, checked: 0, unstable: [], skipped: null };
  const identity = reconstructedIdentity(before, after);
  if (identity === null) return { ...result, skipped: SOURCE_UNAVAILABLE };
  if (!compareRuns(before, after).comparable) return { ...result, skipped: 'прогоны несравнимы' };
  const agent = identity ?? { ...before, agent: agentIdentity(before) };
  // An embedded identity keeps no reported version: the fingerprint and the owner's name speak for the source there.
  const version = agentVersionRelation({ targetFingerprint: agent.targetFingerprint, targetVersion: agent.targetVersion, targetRelease: identity ? undefined : before.targetRelease }, after);
  if (version === 'changed' || agent.agent !== agentIdentity(after)) return { ...result, skipped: 'агент изменился между прогонами' };
  if (version === 'unknown') return { ...result, skipped: VERSION_UNKNOWN };
  const source = observedRecord(before), repeat = observedRecord(after);
  for (const card of repeat.scenarios) {
    const sourceCard = source.scenarios.find(item => item.id === card.id);
    if (!sourceCard) continue;
    // A card edited since the source attempts were judged is another question, not a repeat of it.
    if (fingerprint(normalizeScenarioIdentity(card, after.target.kind)) !== sourceCardIdentity(before, sourceCard, identity)) continue;
    const was = headlineCardOutcome(source, sourceCard).outcome, now = headlineCardOutcome(repeat, card).outcome;
    if (!isDecided(was) || !isDecided(now)) continue;
    result.checked++;
    if (was !== now) result.unstable.push({ scenarioId: card.id, title: card.title, before: was, after: now });
  }
  return result;
}

/**
 * A reassessment of saved answers against its source run: pass↔fail flips of the headline verdict
 * (goal and prompt rules) on the same attempts, the same criteria and the same judge (model, routing
 * and protocol). Null when the record is not a reassessment of `source`.
 * compareRuns is not used here: it always marks a reassessment as incomparable.
 */
export function stabilityAfterReassess(record: Experiment, source: Experiment): Stability | null {
  if (record.assessmentOf !== source.id || !record.evidenceHash) return null;
  const result: Stability = { basis: 'reassess', comparedWith: source.id, checked: 0, unstable: [], skipped: null };
  const identity = reconstructedIdentity(source, record);
  if (identity === null) return { ...result, skipped: SOURCE_UNAVAILABLE };
  // The judge, not the whole evaluator: an Agent Lab upgrade with the same judge still compares.
  const protocols = (run: Experiment) => [...new Set(run.trials.flatMap(trial => {
    const judge = trial.judgeAudit ?? trial.judgeReceipt;
    return judge ? [judge.protocolHash] : [];
  }))].sort();
  const sourceProtocols = protocols(source), recordProtocols = protocols(record);
  if (judgeSettingsIdentity(record.settings) !== (identity?.judge ?? judgeSettingsIdentity(source.settings))
    || sourceProtocols.length && recordProtocols.length && fingerprint(sourceProtocols) !== fingerprint(recordProtocols)) {
    return { ...result, skipped: 'судья или его настройки изменились' };
  }
  const sourceTrialIds = new Set(source.trials.map(trial => trial.id));
  for (const card of record.scenarios) {
    const sourceCard = source.scenarios.find(item => item.id === card.id);
    if (!sourceCard) continue;
    // A rebuilt source holds the current cards, so the source card identity comes from the embedded record of it.
    if (fingerprint(normalizeScenarioIdentity(card, record.target.kind)) !== sourceCardIdentity(source, sourceCard, identity)) continue;
    const trialIds = new Set(record.trials.filter(trial => trial.scenarioId === card.id).map(trial => trial.id));
    // Only a card whose every source attempt was reassessed, and nothing else, compares the same answers.
    if ([...trialIds].some(id => !sourceTrialIds.has(id))
      || source.trials.some(trial => trial.scenarioId === card.id && !trialIds.has(trial.id))) continue;
    const was = headlineCardOutcome(source, sourceCard).outcome, now = headlineCardOutcome(record, card).outcome;
    if (!isDecided(was) || !isDecided(now)) continue;
    result.checked++;
    if (was !== now) result.unstable.push({ scenarioId: card.id, title: card.title, before: was, after: now });
  }
  return result;
}

const JUDGE_INCOMPLETE = 'Судья не завершил оценку этого разговора.';
/** The note of a comparison whose agent's version is unknown in either run (`versionUnknown`): what that means, for any reader. */
export const VERSION_UNKNOWN_NOTE = 'Версия агента неизвестна хотя бы в одном прогоне: «исправлено» и «сломалось» здесь — изменения ответов, а не доказанный эффект новой версии.';

const CONTROL_NOTE = 'Контрольные ситуации не сравниваются: они не входят в главное число.';
/** Named whenever a shared card carries the prompt-rule check, so a reader knows which rule the before/after counts by (CTX-22). */
const RULE_NOTE = 'Сравнение считает «справился» как главное число: запрос выполнен и правила промпта соблюдены.';

export function compareRuns(before: Experiment, after: Experiment): RunComparison {
  // A rebuilt source carries the current cards; its embedded identity says what the source cards were.
  // Taken from the original records: a stripped copy is not a registered rebuilt source.
  const identity = reconstructedIdentity(before, after) ?? undefined;
  const controls = new Set([...before.positiveControlScenarioIds ?? [], ...after.positiveControlScenarioIds ?? []]);
  let result: RunComparison;
  if (!controls.size) result = compareRunsAgainst(before, after, identity);
  else {
    // A control never enters the headline (CTX-11), and a repeat runs it as one turn, so it is not a pair either.
    result = compareRunsAgainst(withoutControls(before, controls), withoutControls(after, controls), identity);
    result.notes.push(CONTROL_NOTE);
  }
  // Marks given under the previous counting rule are named, never mixed in silently (CTX-21). Informational: `comparable` is untouched.
  for (const [name, run] of [['до', before], ['после', after]] as const) {
    const stale = judgeAgreement(run).staleRule;
    if (stale > 0) result.notes.push(`В прогоне «${name}» отметки по прежнему правилу подсчёта: ${stale}.`);
  }
  return result;
}

/** A shallow copy of a run without its control situations: cards, attempts, selection and reassessed attempts. */
function withoutControls(run: Experiment, controls: Set<string>): Experiment {
  const trials = run.trials.filter(trial => !controls.has(trial.scenarioId));
  const copy: Experiment = { ...run, scenarios: run.scenarios.filter(scenario => !controls.has(scenario.id)), trials };
  delete copy.positiveControlScenarioIds;
  const selected = run.selectedScenarioIds?.filter(id => !controls.has(id));
  if (selected?.length) copy.selectedScenarioIds = selected;
  else delete copy.selectedScenarioIds;
  if (run.assessmentTrialIds) {
    const kept = new Set(trials.map(trial => trial.id));
    copy.assessmentTrialIds = run.assessmentTrialIds.filter(id => kept.has(id));
  }
  return copy;
}

function compareRunsAgainst(before: Experiment, after: Experiment, identity: SourceIdentity | undefined): RunComparison {
  if (after.parentRunId === before.id && after.selectedScenarioIds?.length
    && after.scenarios.length < before.scenarios.length
    && after.scenarios.length === after.selectedScenarioIds.length
    && after.scenarios.every(s => after.selectedScenarioIds!.includes(s.id) && before.scenarios.some(b => b.id === s.id))) {
    const selected = new Set(after.selectedScenarioIds);
    const result = compareRunsAgainst({ ...before, scenarios: before.scenarios.filter(s => selected.has(s.id)), trials: before.trials.filter(t => selected.has(t.scenarioId)) }, after, identity);
    result.cards.onlyBefore = before.scenarios.filter(s => !selected.has(s.id)).map(s => s.id);
    result.headline = `Только выбранные ситуации: ${selected.size} из ${before.scenarios.length}. ${result.headline}`;
    result.notes.push('Сравнение относится только к выбранным ситуациям: остальные в этот раз не проверялись.');
    return result;
  }
  const beforeIds = new Set(before.scenarios.map(s => s.id));
  const afterIds = new Set(after.scenarios.map(s => s.id));
  const shared = after.scenarios.filter(s => beforeIds.has(s.id));
  const beforeReviews = latestHumanReviews(before), afterReviews = latestHumanReviews(after);
  const validBefore = (t: Trial) => measured(t) && beforeReviews.get(`${t.id}|dialogue`)?.verdict !== 'invalid';
  const validAfter = (t: Trial) => measured(t) && afterReviews.get(`${t.id}|dialogue`)?.verdict !== 'invalid';
  const result: RunComparison = {
    headline: '', comparable: false, pairs: [], cards: { shared: shared.length,
      onlyBefore: before.scenarios.filter(s => !afterIds.has(s.id)).map(s => s.id),
      onlyAfter: after.scenarios.filter(s => !beforeIds.has(s.id)).map(s => s.id) },
    fixed: [], regressed: [], incomparable: [], unchanged: { passing: 0, failing: 0 }, ungraded: 0,
    includesRubrics: shared.some(s => s.metrics?.some(m => m.subject === 'agent')), notes: [],
    coverage: { plannedPairs: plannedTrials(before), validPairs: 0, excludedPairs: plannedTrials(before),
      missingBefore: Math.max(0, plannedTrials(before) - before.trials.length), missingAfter: Math.max(0, plannedTrials(after) - after.trials.length),
      invalidBefore: before.trials.filter(t => !validBefore(t)).length, invalidAfter: after.trials.filter(t => !validAfter(t)).length },
  };
  const { notes } = result;
  if (fingerprint(before.scenarios.map(s => [s.id,s.provenance])) !== fingerprint(after.scenarios.map(s => [s.id,s.provenance])) || before.librarySnapshot?.revision !== after.librarySnapshot?.revision) notes.push('Набор ситуаций изменился — другая его версия или состав: сравнивать нужно с прогоном того же набора.');
  const addIncomparable = (row: { scenarioId: string; userMode: UserMode; repeat: number }, reason: string, beforeTrialId?: string, afterTrialId?: string) => {
    const scenario = after.scenarios.find(s => s.id === row.scenarioId) ?? before.scenarios.find(s => s.id === row.scenarioId);
    if (!scenario || result.incomparable.some(item => item.scenarioId === row.scenarioId && item.userMode === row.userMode && item.repeat === row.repeat)) return;
    result.incomparable.push({ ...row, title: scenario.title, tier: scenario.tier ?? 'regression',
      ...(beforeTrialId ? { beforeTrialId } : {}), ...(afterTrialId ? { afterTrialId } : {}), reason });
  };
  const expectedRows = [...expectedAttemptRows(before), ...expectedAttemptRows(after)]
    .filter((row, index, rows) => rows.findIndex(value => value.scenarioId === row.scenarioId && value.userMode === row.userMode && value.repeat === row.repeat) === index);
  if (before.id === after.id) notes.push('Выбран один и тот же прогон.');
  if (before.workflow !== 'evaluate' || after.workflow !== 'evaluate') notes.push('Сравнение поддерживает отдельные оценочные прогоны.');
  if (before.mode !== after.mode) notes.push('Учебный пример и живой прогон несравнимы.');
  const rejudgedPair = !!before.assessmentOf && !!after.assessmentOf && before.assessmentOf !== after.assessmentOf
    && after.sourceEvidence?.runId === after.assessmentOf && after.sourceEvidence.parentRunId === before.assessmentOf;
  // A repeat of a run compares with that run re-judged by today's judge: the same cards and judge, only the agent's answers differ.
  const repeatOfReassessed = !!before.assessmentOf && !after.assessmentOf && after.parentRunId === before.assessmentOf;
  if (fingerprint(before.target) !== fingerprint(after.target) && after.parentRunId !== before.id && !repeatOfReassessed && !rejudgedPair) notes.push('Испытуемый в прогонах разный: выберите повтор того же агента.');
  if (fingerprint(before.settings) !== fingerprint(after.settings)) notes.push('Отличаются настройки прогона: модели, поведение клиента или число повторов.');
  if ((before.assessmentOf || after.assessmentOf) && !rejudgedPair && !repeatOfReassessed) notes.push('Это переоценка сохранённых ответов. Для сравнения версий переоцените оба исходных прогона в одинаковых условиях.');
  // A first-format run judged by its checkpoints is another judgment than one per expectation, whatever the judge model.
  if (before.trials.some(judgedByCheckpoints) !== after.trials.some(judgedByCheckpoints)) notes.push('Протокол судьи отличается: один прогон судился по контрольным точкам, другой — по отдельным ожиданиям. Переоцените старый прогон, чтобы сравнить.');
  if (before.evaluatorVersion !== after.evaluatorVersion) notes.push('Отличается версия судьи или его инструкций: сначала переоцените записанные разговоры одним и тем же судьёй.');
  // A conversation is read by the customer that played it (card-customer.ts): another customer is another test, and judging again does not change who played.
  if (fingerprint(customerProtocolsOf(before.trials)) !== fingerprint(customerProtocolsOf(after.trials))) notes.push('Клиента в разговорах «до» и «после» играли разные версии Lab: разницу нельзя приписать агенту.');
  if (fingerprint(before.sources) !== fingerprint(after.sources) || fingerprint(before.requirements) !== fingerprint(after.requirements)) notes.push('Изменились материалы или правила.');
  if (result.cards.onlyBefore.length || result.cards.onlyAfter.length) notes.push('Набор ситуаций изменился.');
  // External agents: a legacy card without a channel is judged on the reply, so it equals the same card with `reply`.
  const changed = shared.filter(s => {
    const b = before.scenarios.find(item => item.id === s.id)!;
    const now = fingerprint(normalizeScenarioIdentity(s, after.target.kind));
    return now !== sourceCardIdentity(before, b, identity);
  });
  if (changed.length) notes.push(`Изменились ситуации: ${changed.map(s => s.title).join(', ')}.`);
  for (const [name, record] of [['До', before], ['После', after]] as const) notes.push(...runCompleteness(record, true).map(n => `${name}: ${n}`));
  // A rejected judgment is a problem of its own pair, not a second protocol inside the run.
  const judgeIdentities = (record: Experiment) => [...new Set(record.trials.filter(t => measured(t) && !t.assessmentError
    && record.scenarios.find(s => s.id === t.scenarioId)?.metrics?.length).map(t => {
    // A legacy full audit and a receipt from the same judge are one identity.
    const judge = t.judgeAudit ?? t.judgeReceipt;
    return judge ? fingerprint({ protocol: judge.protocolHash, provider: judge.provider, model: judge.model }) : 'unrecorded';
  }))].sort();
  const beforeJudges = judgeIdentities(before), afterJudges = judgeIdentities(after);
  if (beforeJudges.length > 1 || afterJudges.length > 1) notes.push('Внутри прогона разговоры оценивали разные судьи или по разным инструкциям.');
  if (beforeJudges.length && afterJudges.length && fingerprint(beforeJudges) !== fingerprint(afterJudges)) notes.push('Разговоры «до» и «после» оценивали разные судьи или по разным инструкциям: разницу нельзя приписать агенту.');
  if (notes.length) {
    for (const row of expectedRows) addIncomparable(row, notes.join(' '),
      before.trials.find(t => attemptKey(t) === `${row.scenarioId}|${row.userMode}|${row.repeat}`)?.id,
      after.trials.find(t => attemptKey(t) === `${row.scenarioId}|${row.userMode}|${row.repeat}`)?.id);
    result.headline = 'Прогоны несравнимы: исправления и поломки не подсчитаны.';
    return result;
  }
  // The judge saw observable sources (evaluation.ts), so its receipt is checked against the same input, one pair at a time.
  const auditRequired = before.mode === 'live' && result.includesRubrics;
  const judged = (run: Experiment, trial: Trial) => {
    const scenario = run.scenarios.find(s => s.id === trial.scenarioId);
    return !!scenario && hasCompleteJudgment({ scenario, sources: observableSources(scenarioSources(run, scenario), run.requirements), trial });
  };
  const beforeAttempts = new Map<string, Trial[]>(), afterAttemptGroups = new Map<string, Trial[]>();
  for (const trial of before.trials) beforeAttempts.set(attemptKey(trial), [...beforeAttempts.get(attemptKey(trial)) ?? [], trial]);
  for (const trial of after.trials) afterAttemptGroups.set(attemptKey(trial), [...afterAttemptGroups.get(attemptKey(trial)) ?? [], trial]);
  const excludedBy: ExcludedBy = { invalidBefore: 0, missingBefore: 0, invalidAfter: 0, missingAfter: 0, judgeIncomplete: 0, other: 0 };
  for (const row of expectedRows) {
    const key = `${row.scenarioId}|${row.userMode}|${row.repeat}`;
    const a = beforeAttempts.get(key) ?? [], b = afterAttemptGroups.get(key) ?? [];
    if (a.length !== 1) { if (!a.length) excludedBy.missingBefore++; addIncomparable(row, a.length ? 'разговор «до» записан несколько раз' : 'нет разговора «до»', a[0]?.id, b[0]?.id); }
    else if (!validBefore(a[0]!)) { excludedBy.invalidBefore++; addIncomparable(row, 'разговор «до» не измерен', a[0]!.id, b[0]?.id); }
    else if (b.length !== 1) { if (!b.length) excludedBy.missingAfter++; addIncomparable(row, b.length ? 'разговор «после» записан несколько раз' : 'нет разговора «после»', a[0]!.id, b[0]?.id); }
    else if (!validAfter(b[0]!)) { excludedBy.invalidAfter++; addIncomparable(row, 'разговор «после» не измерен', a[0]!.id, b[0]!.id); }
    else if (auditRequired && (!judged(before, a[0]!) || !judged(after, b[0]!))) { excludedBy.judgeIncomplete++; addIncomparable(row, JUDGE_INCOMPLETE, a[0]!.id, b[0]!.id); }
  }
  const afterAttempts = new Map([...afterAttemptGroups].flatMap(([key, trials]) => trials.length === 1 ? [[key, trials[0]!] as const] : []));
  const pairs = before.trials.filter(t => {
    const following = afterAttempts.get(attemptKey(t));
    return validBefore(t) && !!following && validAfter(following) && (!auditRequired || (judged(before, t) && judged(after, following)));
  });
  result.coverage.validPairs = pairs.length;
  result.coverage.excludedPairs -= pairs.length;
  // Duplicated keys and attempts outside the plan are the remainder, so the parts always add up.
  const named = excludedBy.invalidBefore + excludedBy.missingBefore + excludedBy.invalidAfter + excludedBy.missingAfter + excludedBy.judgeIncomplete;
  excludedBy.other = Math.max(0, result.coverage.excludedPairs - named);
  result.coverage.excludedBy = excludedBy;
  if (result.coverage.excludedPairs) notes.push(`Сопоставлено ${pairs.length} из ${countText(result.coverage.plannedPairs, PAIRS_OF)}. Не сопоставлено ${result.coverage.excludedPairs}: `
    + `«до» — не измерено ${excludedBy.invalidBefore}, нет разговора ${excludedBy.missingBefore}; «после» — не измерено ${excludedBy.invalidAfter}, нет разговора ${excludedBy.missingAfter}`
    + `${excludedBy.judgeIncomplete ? `; без завершённой оценки судьи — ${excludedBy.judgeIncomplete}` : ''}${excludedBy.other ? `; повторённые или лишние разговоры — ${excludedBy.other}` : ''}. `
    + 'За несопоставленными разговорами может скрываться поломка: вывод относится только к сопоставленным.');
  if (!pairs.length) { result.headline = 'Нет разговоров, измеренных в обоих прогонах: сравнивать нечего.'; return result; }
  result.pairs = pairs.map(trial => {
    const scenario = shared.find(s => s.id === trial.scenarioId);
    // The headline rule per attempt (goal and prompt rules); a legacy card falls back to the strict trial result.
    const was = headlineTrialResult(scenario, trial, before.humanReviews);
    const following = afterAttempts.get(attemptKey(trial))!;
    const now = headlineTrialResult(scenario, following, after.humanReviews);
    let change: RunComparison['pairs'][number]['change'] = was === 'unknown' || now === 'unknown' ? 'unknown'
      : was === now ? 'unchanged' : now === 'pass' ? 'fixed' : 'regressed';
    const reviewNote = rubricReviewNote(scenario, trial, following);
    if (reviewNote) change = 'unknown';
    if (reviewNote) notes.push(`${scenario!.title} · попытка ${trial.repeat + 1}: ${reviewNote}`);
    if (change === 'unknown') addIncomparable({ scenarioId: trial.scenarioId, userMode: trial.userMode, repeat: trial.repeat },
      reviewNote ?? 'ни судья, ни человек не решили, справился ли агент в этой паре разговоров', trial.id, following.id);
    return { scenarioId: trial.scenarioId, userMode: trial.userMode, repeat: trial.repeat,
      beforeTrialId: trial.id, afterTrialId: following.id, change, ...(reviewNote ? { reviewNote } : {}) };
  });
  // Open the actual changed attempt, not an unchanged repeat of a changed card.
  const rank = { regressed: 0, fixed: 1, unchanged: 2, unknown: 2 };
  result.pairs.sort((a, b) => rank[a.change] - rank[b.change]);
  before = { ...before, trials: pairs };
  after = { ...after, trials: pairs.map(t => afterAttempts.get(attemptKey(t))!) };
  result.comparable = true;
  for (const scenario of shared) {
    if (result.pairs.some(p => p.scenarioId === scenario.id && p.reviewNote)) { result.ungraded++; continue; }
    // The headline rule over the matched attempts (partial gate); a legacy card reaches the strict cardOutcome(…, true) through it.
    const was = headlineCardOutcome(before, scenario, { partial: true }).outcome;
    const now = headlineCardOutcome(after, scenario, { partial: true }).outcome;
    if (was === 'unknown' || now === 'unknown') { result.ungraded++; continue; }
    const row = { scenarioId: scenario.id, title: scenario.title, tier: scenario.tier ?? 'regression' };
    if (was === 'fail' && now === 'pass') result.fixed.push(row);
    else if (was === 'pass' && now === 'fail') result.regressed.push(row);
    else if (now === 'pass') result.unchanged.passing++;
    else result.unchanged.failing++;
  }
  const compared = shared.length - result.ungraded;
  // A run of situations is compared by the rule of its number, every expectation: fixed or broken, like the number itself.
  // Older runs judged by rubrics keep their words: a rubric's score rising was never a confirmed fix.
  const preliminary = result.includesRubrics && !shared.every(s => headlineRule(s, after.trials.filter(t => t.scenarioId === s.id)).kind === 'expectations');
  result.headline = compared ? `${preliminary ? `Оценка выросла у ${result.fixed.length}, снизилась у ${result.regressed.length}` : `Исправлено ${result.fixed.length}, сломалось ${result.regressed.length}`}, без изменений ${result.unchanged.passing + result.unchanged.failing} из ${compared} ${pluralForm(compared, ['ситуации', 'ситуаций', 'ситуаций'])}.` : 'Общих оценённых ситуаций нет, сравнивать нечего.';
  // How many pairs of conversations could be compared is said apart (result-text.ts comparisonRows), in its own unit.
  if (result.coverage.excludedPairs) result.headline = `Частичное сравнение: ${result.headline.charAt(0).toLocaleLowerCase('ru')}${result.headline.slice(1)}`;
  if (preliminary) result.headline = `Предварительно: ${result.headline.charAt(0).toLocaleLowerCase('ru')}${result.headline.slice(1)}`;
  const disputed = result.pairs.filter(p => p.reviewNote).length;
  if (disputed) result.headline += ` У ${countText(disputed, PAIRS_OF)} ответы агента совпали, а оценки судьи разные: судью нужно проверить.`;
  if (result.ungraded) notes.push(`${countText(result.ungraded, SITUATIONS)} без решающей оценки не ${pluralForm(result.ungraded, ['вошла', 'вошли', 'вошли'])} в сравнение.`);
  if (preliminary) notes.push('Сравнение включает предварительные оценки по рубрикам. Это не подтверждённое улучшение.');
  if (shared.some(s => headlineMetricIds(s).includes(RULES_METRIC_ID))) notes.push(RULE_NOTE);
  const smoke = result.regressed.filter(r => r.tier === 'smoke').length;
  if (smoke) notes.push(`${pluralForm(smoke, ['Сломалась', 'Сломались', 'Сломались'])} ${countText(smoke, ['базовая ситуация', 'базовые ситуации', 'базовых ситуаций'])}: сначала верните то, что должно работать всегда.`);
  if (compared && compared < TRUSTED_SAMPLE) notes.push(`Сравнение по ${countText(compared, ['ситуации', 'ситуациям', 'ситуациям'])}: разница может быть случайной, повторы новых ситуаций не добавляют.`);
  if (before.target.kind !== 'sandbox' && agentVersionRelation(before, after) === 'unknown') {
    notes.push(VERSION_UNKNOWN_NOTE);
    result.versionUnknown = true;
  } else if (before.target.kind !== 'sandbox' && (!(before.targetVersion || before.targetRelease) || !(after.targetVersion || after.targetRelease))) notes.push('Не все версии внешнего агента названы. Локальный отпечаток не учитывает удалённые сервисы и переменные окружения.');
  return result;
}
