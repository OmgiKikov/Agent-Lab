import { hasCompleteJudgment, observableSources, scenarioSources } from './judge.js';
import { agentIdentity, judgeSettingsIdentity, normalizeScenarioIdentity } from './normalize.js';
import { fingerprint, metricApplies, simulatorWasUsed, type Experiment, type Scenario, type SourceIdentity, type Tier, type Trial, type UserMode } from './contracts.js';
import { automaticTrialResult, headlineMetricIds, headlineTrialResult, isAgentFailure, latestHumanReviews, markTargets, markUnderCurrentRule, measured, observedRecord, RULES_METRIC_ID } from './outcomes.js';
import { attemptKey, expectedAttemptRows, headlineCardOutcome, plannedTrials, runCompleteness } from './run.js';
import { judgeAgreement } from './agreement.js';
import { pluralForm } from './plural.js';
import { shortId } from './text.js';
import { sameTargetVersion } from './target-version.js';

/*
 * Two runs compared, and the owner's review workflow over one run. The result of a single run —
 * its number, reasons and causes — is derived in run.ts and shown through result-view.ts; nothing
 * here counts a headline. Pure: no I/O or model calls.
 *
 *   compareRuns        two runs of the same accepted set: before/after per situation
 *   stability*         which decided situations flipped against the source run
 *   awaitingVerdict    which dialogues still wait for the owner's decision
 */
function rubricReviewNote(scenario: Scenario | undefined, before: Trial, after: Trial): string | undefined {
  const replies = before.events.filter(e => e.type === 'assistant').map(e => e.text);
  const flipped = scenario?.metrics?.some(m => m.subject === 'agent'
    && before.assessments?.some(a => a.metricId === m.id && a.result !== 'unknown'
      && after.assessments?.some(b => b.metricId === m.id && b.result !== 'unknown' && b.result !== a.result)));
  return flipped && replies.length && fingerprint(replies) === fingerprint(after.events.filter(e => e.type === 'assistant').map(e => e.text))
    ? 'Ответы агента совпали, оценки по рубрикам различаются. Проверьте запросы пользователя, действия и критерии: рост оценки сам по себе не доказывает улучшение агента.' : undefined;
}
export interface HumanFinding {
  trialId: string; reviewId: string; target: string; subject: 'agent' | 'simulator' | 'check' | 'test';
  verdict: 'pass' | 'fail' | 'invalid'; automatic: 'pass' | 'fail' | 'unknown'; disagreement: boolean; note: string;
}
export function humanFindingText(finding: HumanFinding): string {
  const label = { pass: 'пройдено', fail: 'не пройдено', unknown: 'неясно', invalid: 'невалидный тест' };
  return `${finding.subject === 'test' ? 'Тест' : finding.subject === 'simulator' ? 'Симулятор' : finding.subject === 'check' ? 'Кодовая проверка' : 'Агент'} · ${finding.target}: человек — ${label[finding.verdict]}, автоматически — ${label[finding.automatic]}.${finding.disagreement ? ' Расхождение оценок.' : ''} ${finding.note}`;
}
/** Human reports and disagreements remain visible even when every automatic score is green. */
export function humanFindings(record: Experiment): HumanFinding[] {
  record = observedRecord(record);
  return [...latestHumanReviews(record).values()].flatMap(review => {
    const trial = record.trials.find(t => t.id === review.trialId);
    if (!trial || !['pass', 'fail', 'invalid'].includes(review.verdict)) return [];
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    const metric = scenario?.metrics?.find(m => m.id === review.metricId);
    const simulatorCheck = trial.simulatorChecks?.find(c => c.id === review.checkId);
    const check = simulatorCheck ?? trial.checks.find(c => c.id === review.checkId);
    const automatic = !measured(trial) ? 'unknown' : review.metricId ? trial.assessments?.find(a => a.metricId === review.metricId)?.result ?? 'unknown'
      : review.checkId ? check ? check.passed ? 'pass' : 'fail' : 'unknown' : automaticTrialResult(scenario, trial, record.humanReviews);
    const disagreement = automatic !== 'unknown' && review.verdict !== automatic;
    // Confirming the judge is not a remark of the owner: a one-key «согласен» with a failure says
    // the failure is real, so reporting it back as «замечание человека» would double-count it.
    if (review.source === 'quick' && !disagreement) return [];
    if (review.verdict !== 'fail' && review.verdict !== 'invalid' && !disagreement) return [];
    return [{ trialId: trial.id, reviewId: review.id, target: metric?.name ?? check?.description ?? review.metricId ?? review.checkId ?? 'Весь диалог',
      subject: simulatorCheck ? 'simulator' : review.verdict === 'invalid' ? 'test' : review.checkId ? 'check' : metric?.subject ?? 'agent', verdict: review.verdict as 'pass' | 'fail' | 'invalid', automatic, disagreement, note: review.note }];
  });
}
/** A label on a passing or simulator criterion does not resolve an agent's failed criteria. */
export function awaitingVerdict(record: Experiment): Set<string> {
  record = observedRecord(record);
  const latest = latestHumanReviews(record);
  const decided = (key: string) => ['pass', 'fail'].includes(latest.get(key)?.verdict ?? '');
  return new Set(record.trials.filter(trial => {
    if (latest.get(`${trial.id}|dialogue`)?.verdict === 'invalid') return false;
    {
      const pending = [
        ...(simulatorWasUsed(trial) ? trial.simulatorChecks ?? [] : []).filter(c => !c.passed).map(c => `check:${c.id}`),
        ...(record.scenarios.find(s => s.id === trial.scenarioId)?.metrics ?? [])
          .filter(m => m.subject === 'simulator' && metricApplies(m, trial) && trial.assessments?.find(a => a.metricId === m.id)?.result !== 'pass').map(m => `metric:${m.id}`),
      ];
      if (pending.some(key => !['pass', 'fail', 'invalid'].includes(latest.get(`${trial.id}|${key}`)?.verdict ?? ''))) return true;
    }
    // Quick marks close a situation only when every metric that decided it is answered (CTX-18);
    // on a goal card other rubrics and objective checks are not part of the headline. Doubt
    // («не могу сказать») is not a decision, and a phase-3 mark on a two-target situation answered
    // the previous rule, so either leaves the judge's own failure in the queue. The simulator is
    // judged above, separately.
    {
      const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
      const targets = markTargets(scenario, trial);
      const quickClosed = !!targets && targets.metricIds.every(id => {
        const mark = latest.get(`${trial.id}|metric:${id}`);
        return mark?.source === 'quick' && ['pass', 'fail'].includes(mark.verdict) && markUnderCurrentRule(scenario, mark, targets.metricIds);
      });
      if (quickClosed) {
        if (headlineMetricIds(scenario).length) return false;
        // A legacy strict card: every other agent rubric the judge failed is part of its headline and still needs a decision.
        return (scenario?.metrics ?? []).some(m => m.subject === 'agent' && !targets.metricIds.includes(m.id)
          && trial.assessments?.some(a => a.metricId === m.id && a.result === 'fail') && !decided(`${trial.id}|metric:${m.id}`));
      }
    }
    if (!isAgentFailure(record, trial) || decided(`${trial.id}|dialogue`) || latest.get(`${trial.id}|dialogue`)?.verdict === 'invalid') return false;
    const failed = [
      ...trial.checks.filter(c => !c.passed).map(c => `check:${c.id}`),
      ...(record.scenarios.find(s => s.id === trial.scenarioId)?.metrics ?? [])
        .filter(m => m.subject === 'agent' && trial.assessments?.some(a => a.metricId === m.id && a.result === 'fail'))
        .map(m => `metric:${m.id}`),
    ];
    return !failed.length || failed.some(key => !decided(`${trial.id}|${key}`));
  }).map(t => t.id));
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
}

/** Each excluded pair once, by its first reason. */
interface ExcludedBy { invalidBefore: number; missingBefore: number; invalidAfter: number; missingAfter: number; judgeIncomplete: number; other: number }

/** The judge model named on result screens: the recorded audit first, then the configured role. */
export function judgeModel(record: Experiment): string | undefined {
  return record.trials.map(t => (t.judgeAudit ?? t.judgeReceipt)?.model).find(Boolean) ?? record.settings.roles?.judge?.model ?? record.settings.judge?.model;
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
 * A repeat of the same set against its source run. Gated on comparability and on the same agent,
 * so a change of the agent, the judge or the criteria is never called instability. Uses the headline
 * verdict (goal and prompt rules, CTX-21), so «нестабильно» matches the number; reply quality and the
 * RAG rubrics never flip a card here.
 */
export function stabilityBetweenRuns(before: Experiment, after: Experiment): Stability {
  const result: Stability = { basis: 'repeat', comparedWith: before.id, checked: 0, unstable: [], skipped: null };
  const identity = reconstructedIdentity(before, after);
  if (identity === null) return { ...result, skipped: SOURCE_UNAVAILABLE };
  if (!compareRuns(before, after).comparable) return { ...result, skipped: 'прогоны несравнимы' };
  const agent = identity ?? { ...before, agent: agentIdentity(before) };
  if (!sameTargetVersion(agent.targetFingerprint, after.targetFingerprint) || agent.targetVersion !== after.targetVersion
    || agent.agent !== agentIdentity(after)) return { ...result, skipped: 'агент изменился между прогонами' };
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

const JUDGE_INCOMPLETE = 'Судья не завершил оценку этой попытки.';

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
  for (const run of [before, after]) {
    const stale = judgeAgreement(run).staleRule;
    if (stale > 0) result.notes.push(`В прогоне ${shortId(run.id)} есть отметки по прежнему правилу подсчёта: ${stale}.`);
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
    result.headline = `Выбранные тесты (${selected.size}/${before.scenarios.length}). ${result.headline}`;
    result.notes.push('Сравнение относится только к явно выбранным тестам. Остальной регрессионный набор не проверен.');
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
  if (fingerprint(before.scenarios.map(s => [s.id,s.provenance])) !== fingerprint(after.scenarios.map(s => [s.id,s.provenance])) || before.librarySnapshot?.revision !== after.librarySnapshot?.revision) notes.push('Ревизия или состав принятого набора по происхождению изменились; нужна новая сопоставимая база.');
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
  if (before.mode !== after.mode) notes.push('Демо и живые прогоны несравнимы.');
  const rejudgedPair = !!before.assessmentOf && !!after.assessmentOf && before.assessmentOf !== after.assessmentOf
    && after.sourceEvidence?.runId === after.assessmentOf && after.sourceEvidence.parentRunId === before.assessmentOf;
  if (fingerprint(before.target) !== fingerprint(after.target) && after.parentRunId !== before.id && !rejudgedPair) notes.push('Испытуемый в прогонах разный: выберите повтор того же агента.');
  if (fingerprint(before.settings) !== fingerprint(after.settings)) notes.push('Настройки, модель, режимы пользователя или число повторов отличаются.');
  if ((before.assessmentOf || after.assessmentOf) && !rejudgedPair) notes.push('Это переоценка сохранённых ответов. Для сравнения версий переоцените оба исходных прогона в одинаковых условиях.');
  if (before.evaluatorVersion !== after.evaluatorVersion) notes.push('Версия оценщика или его инструкций отличается. Сначала переоцените сохранённые трассы в одинаковых условиях.');
  if (fingerprint(before.sources) !== fingerprint(after.sources) || fingerprint(before.requirements) !== fingerprint(after.requirements)) notes.push('Материалы или требования изменились.');
  if (result.cards.onlyBefore.length || result.cards.onlyAfter.length) notes.push('Набор карточек изменился.');
  // External agents: a legacy card without a channel is judged on the reply, so it equals the same card with `reply`.
  const changed = shared.filter(s => {
    const b = before.scenarios.find(item => item.id === s.id)!;
    const now = fingerprint(normalizeScenarioIdentity(s, after.target.kind));
    return now !== sourceCardIdentity(before, b, identity);
  });
  if (changed.length) notes.push(`Содержимое карточек изменилось: ${changed.map(s => s.title).join(', ')}.`);
  for (const [name, record] of [['До', before], ['После', after]] as const) notes.push(...runCompleteness(record, true).map(n => `${name}: ${n}`));
  // A rejected judgment is a problem of its own pair, not a second protocol inside the run.
  const judgeIdentities = (record: Experiment) => [...new Set(record.trials.filter(t => measured(t) && !t.assessmentError
    && record.scenarios.find(s => s.id === t.scenarioId)?.metrics?.length).map(t => {
    // A legacy full audit and a receipt from the same judge are one identity.
    const judge = t.judgeAudit ?? t.judgeReceipt;
    return judge ? fingerprint({ protocol: judge.protocolHash, provider: judge.provider, model: judge.model }) : 'unrecorded';
  }))].sort();
  const beforeJudges = judgeIdentities(before), afterJudges = judgeIdentities(after);
  if (beforeJudges.length > 1 || afterJudges.length > 1) notes.push('Внутри прогона смешаны разные протоколы судьи.');
  if (beforeJudges.length && afterJudges.length && fingerprint(beforeJudges) !== fingerprint(afterJudges)) notes.push('Протокол или модель судьи отличаются; оценки нельзя приписать изменению агента.');
  if (notes.length) {
    for (const row of expectedRows) addIncomparable(row, notes.join(' '),
      before.trials.find(t => attemptKey(t) === `${row.scenarioId}|${row.userMode}|${row.repeat}`)?.id,
      after.trials.find(t => attemptKey(t) === `${row.scenarioId}|${row.userMode}|${row.repeat}`)?.id);
    result.headline = `Прогоны несравнимы: ${result.incomparable.length} пар. Исправления и регрессии не подсчитываются.`;
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
    if (a.length !== 1) { if (!a.length) excludedBy.missingBefore++; addIncomparable(row, a.length ? 'Несколько попыток «до» с одним ключом.' : 'Нет попытки «до».', a[0]?.id, b[0]?.id); }
    else if (!validBefore(a[0]!)) { excludedBy.invalidBefore++; addIncomparable(row, 'Попытка «до» невалидна или не измерена.', a[0]!.id, b[0]?.id); }
    else if (b.length !== 1) { if (!b.length) excludedBy.missingAfter++; addIncomparable(row, b.length ? 'Несколько попыток «после» с одним ключом.' : 'Нет попытки «после».', a[0]!.id, b[0]?.id); }
    else if (!validAfter(b[0]!)) { excludedBy.invalidAfter++; addIncomparable(row, 'Попытка «после» невалидна или не измерена.', a[0]!.id, b[0]!.id); }
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
  if (result.coverage.excludedPairs) notes.push(`Сопоставлено ${pairs.length} из ${result.coverage.plannedPairs} пар попыток. Исключено ${result.coverage.excludedPairs}: до — ${excludedBy.invalidBefore} невалидных и ${excludedBy.missingBefore} пропущенных; после — ${excludedBy.invalidAfter} невалидных и ${excludedBy.missingAfter} пропущенных`
    + `${excludedBy.judgeIncomplete ? `; без завершённой оценки судьи — ${excludedBy.judgeIncomplete}` : ''}${excludedBy.other ? `; повторённые или лишние попытки — ${excludedBy.other}` : ''}. Сбои могут скрывать регрессии; вывод относится только к сопоставленной части.`);
  if (!pairs.length) { result.headline = 'Нет совпадающих валидных попыток. Повторите неудавшиеся диалоги, чтобы получить сравнение.'; return result; }
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
    if (reviewNote) notes.push(`${scenario!.title} · ${trial.userMode} #${trial.repeat + 1}: ${reviewNote}`);
    if (change === 'unknown') addIncomparable({ scenarioId: trial.scenarioId, userMode: trial.userMode, repeat: trial.repeat },
      reviewNote ?? 'У пары нет решающей автоматической или человеческой оценки.', trial.id, following.id);
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
  result.headline = compared ? `${result.includesRubrics ? `Оценка выросла у ${result.fixed.length}, снизилась у ${result.regressed.length}` : `Исправлено ${result.fixed.length}, сломалось ${result.regressed.length}`}, без изменений ${result.unchanged.passing + result.unchanged.failing} из ${compared} ${pluralForm(compared, ['ситуации', 'ситуаций', 'ситуаций'])}.` : 'Общих оценённых ситуаций нет, сравнивать нечего.';
  if (result.coverage.excludedPairs) result.headline = `Частичное сравнение (${pairs.length}/${result.coverage.plannedPairs} пар). ${result.headline}`;
  if (result.includesRubrics) result.headline = `Предварительно: ${result.headline}`;
  const disputed = result.pairs.filter(p => p.reviewNote).length;
  if (disputed) result.headline += ` Пар с совпавшими ответами и разными оценками: ${disputed}. Нужна проверка.`;
  if (result.ungraded) notes.push(`${result.ungraded} карточек без решающей оценки; они не считаются пройденными.`);
  if (result.includesRubrics) notes.push('Сравнение включает предварительные оценки по рубрикам. Это не подтверждённое улучшение.');
  if (shared.some(s => headlineMetricIds(s).includes(RULES_METRIC_ID))) notes.push(RULE_NOTE);
  const smoke = result.regressed.filter(r => r.tier === 'smoke').length;
  if (smoke) notes.push(`Сломано ${smoke} дымовых карточек: сначала восстановите базовое поведение.`);
  if (compared < TRUSTED_SAMPLE) notes.push(`Сравнение по ${compared} карточкам: разница может быть случайной. Повторы не создают новые ситуации.`);
  if (before.target.kind !== 'sandbox' && (!(before.targetVersion || before.targetRelease) || !(after.targetVersion || after.targetRelease))) notes.push('Не все версии внешнего агента названы. Локальный отпечаток не учитывает удалённые сервисы и переменные окружения.');
  return result;
}
