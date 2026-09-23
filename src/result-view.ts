import type { Experiment, Scenario, ValidationExclusion } from './contracts.js';
import { agentMetricResult, COUNTING_RULES, GOAL_METRIC_ID, observedRecord, RULES_METRIC_ID } from './outcomes.js';
import { judgeAgreement, type JudgeAgreement } from './agreement.js';
import { cardVerdict, headlineCardOutcome, judgeModel, NOT_MEASURED_CODES, stabilityAfterReassess, stabilityBetweenRuns, type CardPart, type NotMeasuredCode, type Stability, type StabilityRow } from './comparison.js';
import { exampleRows, failureExplanation, rowsToLines, violatedRuleNumber, type ExplanationRole, type FailureExplanation } from './explain.js';
import { pluralForm } from './plural.js';
import { oneLine, shortId } from './text.js';

export { COUNTING_RULES } from './outcomes.js';

/*
 * The one result every surface shows first: how many situations the agent handled, over one
 * denominator, what was not measured and why, and which dialogues never entered the set.
 * Pure: no I/O, no escaping (each surface escapes at its own boundary). Cards are decided by
 * cardVerdict in comparison.ts; this module only counts and words them. It must not import
 * quality.ts or experiment.ts: quality.ts imports it. The counting rule COUNTING_RULES lives in
 * outcomes.ts and is re-exported here for the surfaces.
 */

/** Below this many decided situations the headline percent is shown with its Wilson range; the verdict line says «мало данных» below it too. */
export const SMALL_SAMPLE = 20;
/** Below this many checked marks the agreement row names no percent: a share of a handful is not a share. */
const PERCENT_FROM = 10;
const Z = 1.959963984540054;

/** 95% Wilson score interval for passed/decided; null when nothing was decided. */
export function wilson(passed: number, decided: number): [number, number] | null {
  if (decided <= 0) return null;
  const p = passed / decided, d = 1 + Z * Z / decided;
  const centre = (p + Z * Z / (2 * decided)) / d;
  const half = Z * Math.sqrt(p * (1 - p) / decided + Z * Z / (4 * decided * decided)) / d;
  return [Math.min(1, Math.max(0, centre - half)), Math.min(1, Math.max(0, centre + half))];
}

export const NOT_MEASURED_TEXT: Record<NotMeasuredCode, string> = {
  in_progress: 'ещё не проверена',
  not_reached: 'прогон остановлен до ситуации',
  stopped: 'диалог остановлен до конца',
  turn_limit: 'разговор не уложился в лимит реплик',
  simulator_error: 'сбой симулятора',
  agent_error: 'сбой агента или связи',
  service_reply: 'стенд ответил служебным текстом, не агент',
  attempts_mismatch: 'запись ситуации неполная',
  judge_error: 'судья ответил не по формату',
  judge_stopped: 'оценка прервана: кончились время или бюджет',
  human_invalid: 'человек отметил ситуацию как ошибочную',
  reset_unconfirmed: 'агент не подтвердил сброс состояния',
  simulator_deviated: 'симулятор отклонился от диалога',
  simulator_unclear: 'судья не уверен, что симулятор держался диалога',
  human_unknown: 'человек не смог решить',
  not_judged: 'судья не оценивал ситуацию',
  judge_split: 'судья не уверен: голоса разошлись',
  no_evidence: 'нет доказательства в ответе',
  judge_unclear: 'правила не дают однозначного ответа',
};

type ExclusionKind = ValidationExclusion['kind'];
const EXCLUSION_ORDER: ExclusionKind[] = ['unconfirmed', 'customer_data', 'masked', 'length'];
const EXCLUSION_TEXT: Record<ExclusionKind, string> = {
  unconfirmed: 'в правилах нет ожидаемого ответа',
  customer_data: 'нужны данные клиента',
  masked: 'реплика клиента скрыта',
  length: 'слишком длинный диалог или нет реплик клиента',
};

/** Non-zero exclusion kinds, most frequent first. The model-written reason is never used. */
export function exclusionCounts(exclusions: ValidationExclusion[]): { kind: ExclusionKind; label: string; count: number }[] {
  return EXCLUSION_ORDER
    .map(kind => ({ kind, label: EXCLUSION_TEXT[kind], count: exclusions.filter(item => item.kind === kind).length }))
    .filter(item => item.count > 0)
    .sort((a, b) => b.count - a.count || EXCLUSION_ORDER.indexOf(a.kind) - EXCLUSION_ORDER.indexOf(b.kind));
}

type CardOutcome = 'pass' | 'fail' | 'unknown';
export interface ResultView {
  runId: string;
  phase: Experiment['phase'];
  countingRules: string;
  headline: { passed: number; decided: number; accuracy: number | null; range: [number, number] | null; text: string; smallSample: string | null };
  /**
   * The two halves of the headline over the counted (non-control) cards: how many requests were met
   * of those decided, how many situations broke a prompt rule of those where the rules were decided,
   * the one rule broken more often than any other (named only with a strict top count) and the
   * counted cards without the prompt-rule check. `text` is the row under the number, or null when
   * the draft never ran, no counted card has the goal rubric or nothing was decided. Never changes the headline.
   */
  breakdown: { goal: { met: number; decided: number }; rules: { broken: number; decided: number; commonRule: number | null; commonRuleCount: number }; withoutRules: number; text: string | null };
  /** Cards still waiting in a running phase; never part of notMeasured. */
  pending: number;
  notMeasured: { total: number; reasons: { code: NotMeasuredCode; label: string; count: number; scenarioIds: string[] }[] };
  /** The positive controls: `outcome` is the goal-only verdict the control is decided by; `rules` is its prompt-rule result, shown in words and never an alarm ('none' without the check). */
  control: { cards: { scenarioId: string; title: string; outcome: CardOutcome; reason?: NotMeasuredCode; rules: CardOutcome | 'none'; synthetic: boolean; unstable: boolean }[]; warning: string | null };
  coverage: { examined: number; included: number; excluded: { kind: ExclusionKind; label: string; count: number }[]; text: string | null };
  /**
   * One row per card: `outcome` is the headline verdict (goal-only for a control); `goal` and `rules`
   * are its two parts — the goal result and the prompt-rule result — each 'none' when the card has no
   * such check (a legacy card without the goal rubric has neither). `parts` are the parts of the
   * verdict in the owner's words: a card's expectations А, Б, В (each over every attempt), or «Цель»
   * and «Правила промпта»; empty for a legacy card decided by its strict result.
   */
  cards: { scenarioId: string; title: string; outcome: CardOutcome; reason?: NotMeasuredCode; goal: CardOutcome | 'none'; rules: CardOutcome | 'none'; parts: CardPart[]; control: boolean; unstable: boolean; provenance: Scenario['provenance'] }[];
  /** One explanation per failed situation of the headline (controls left out), in record order; built from stored data only. */
  failures: FailureExplanation[];
  /** Up to three failure causes, largest first; each counts distinct failed situations and carries one full explanation. */
  topCauses: { name: string; count: number; example: FailureExplanation }[];
  scope: { cards: number; synthetic: number; dialogues: number; judgeModel?: string; costUsd: number | null; target: string };
  /** Found flips against the source run, control situations left out; absent when there is nothing to compare with. Never changes the headline. */
  stability?: Stability;
  /** How often the owner confirmed the judge's own decisions. Never changes the headline: it says how much the number can be trusted, not what it is. */
  agreement: JudgeAgreement;
}

/** The source run to check stability against; the record's own parent or the run it reassessed. */
function stabilityOf(input: Experiment, before: Experiment | undefined): Stability | undefined {
  if (!before) return undefined;
  if (input.assessmentOf === before.id) return stabilityAfterReassess(input, before) ?? undefined;
  return stabilityBetweenRuns(before, input);
}

/**
 * The recorded failure clusters, counted in failed headline situations only. The example is
 * the explanation of the first failing cluster attempt whose goal failed (alone or with the
 * rules), or the situation's own one.
 */
function causesOf(record: Experiment, failures: FailureExplanation[]): ResultView['topCauses'] {
  const failed = new Map(failures.map(item => [item.scenarioId, item]));
  const trials = new Map(record.trials.map(trial => [trial.id, trial]));
  const scenarios = new Map(record.scenarios.map(scenario => [scenario.id, scenario]));
  return (record.failureModes ?? []).flatMap(mode => {
    const attempts = mode.trialIds.flatMap(id => trials.get(id) ?? []).filter(trial => failed.has(trial.scenarioId));
    const [first] = attempts;
    if (!first) return [];
    const own = attempts.map(trial => failureExplanation(record, scenarios.get(trial.scenarioId)!, trial)).find(item => !!item && item.kind !== 'rules');
    const example = own ?? failed.get(first.scenarioId)!;
    return [{ name: mode.name, count: new Set(attempts.map(trial => trial.scenarioId)).size, example }];
  })
    // Array.prototype.sort is stable: equal counts keep the recorded cluster order.
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
}

/**
 * A control the run could not measure. The alarm above the number and the control line below it use
 * this one predicate, so they never disagree: a control that is `unknown` with no recorded reason —
 * or one still running — is «ещё не проверен», never «не измерен».
 */
export function unmeasuredControl(card: { outcome: 'pass' | 'fail' | 'unknown'; reason?: NotMeasuredCode }): card is typeof card & { reason: NotMeasuredCode } {
  return card.outcome === 'unknown' && !!card.reason && card.reason !== 'in_progress';
}

/**
 * The breakdown row (C-301…C-304) over the counted cards. The most frequent rule is read the way the
 * explanation names it — the first attempt of each rule-breaking card whose rules the judge failed,
 * through violatedRuleNumber — and named only when its count is strictly above every other named rule's.
 */
function breakdownOf(record: Experiment, counted: ResultView['cards'], notStarted: boolean): ResultView['breakdown'] {
  const goal = { met: counted.filter(card => card.goal === 'pass').length, decided: counted.filter(card => card.goal === 'pass' || card.goal === 'fail').length };
  const broken = counted.filter(card => card.rules === 'fail');
  const tally = new Map<number, number>();
  for (const card of broken) {
    const attempt = record.trials.find(trial => trial.scenarioId === card.scenarioId && agentMetricResult(trial, RULES_METRIC_ID, record.humanReviews) === 'fail');
    const number = attempt ? violatedRuleNumber(record, attempt) : null;
    if (number !== null) tally.set(number, (tally.get(number) ?? 0) + 1);
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const [top, next] = ranked;
  const commonRule = top && (!next || top[1] > next[1]) ? top[0] : null;
  const rules = { broken: broken.length, decided: counted.filter(card => card.rules === 'pass' || card.rules === 'fail').length, commonRule, commonRuleCount: top && commonRule !== null ? top[1] : 0 };
  const withoutRules = counted.filter(card => card.goal !== 'none' && card.rules === 'none').length;
  const withRules = counted.some(card => card.rules !== 'none');
  const text = notStarted || !counted.some(card => card.goal !== 'none') || goal.decided + rules.decided === 0 ? null
    : withRules
      ? `Запрос выполнен: ${goal.met} из ${goal.decided}. Правила промпта нарушены: ${rules.broken} из ${rules.decided}`
        + (commonRule === null ? '' : `, из них правило ${commonRule} — ${rules.commonRuleCount}`) + '.'
        + (withoutRules ? ` Без правил промпта: ${withoutRules} — по ним считается только запрос.` : '')
      : 'Правил промпта в наборе нет — считается только запрос.';
  return { goal, rules, withoutRules, text };
}

export function buildResultView(input: Experiment, options: { before?: Experiment } = {}): ResultView {
  const record = observedRecord(input);
  // Positive controls are real situations the agent is known to handle; they never enter the number.
  const controlIds = new Set((record.positiveControlScenarioIds ?? []).filter(id => record.scenarios.some(scenario => scenario.id === id)));
  const found = stabilityOf(input, options.before);
  const unstableIds = new Set(found?.unstable.map(row => row.scenarioId) ?? []);
  const stability = found && { ...found, unstable: found.unstable.filter(row => !controlIds.has(row.scenarioId)) };
  const cards: ResultView['cards'] = record.scenarios.map(scenario => {
    // A control is decided by its goal alone; every counted card by the goal and the prompt rules.
    const verdict = cardVerdict(record, scenario, controlIds.has(scenario.id) ? 'goal' : 'headline');
    const parts = headlineCardOutcome(record, scenario);
    return { scenarioId: scenario.id, title: scenario.title, outcome: verdict.outcome, ...(verdict.reason ? { reason: verdict.reason } : {}),
      goal: parts.goal, rules: parts.rules, parts: parts.parts, control: controlIds.has(scenario.id), unstable: unstableIds.has(scenario.id), provenance: scenario.provenance };
  });
  const counted = cards.filter(card => !card.control);
  const failures = record.scenarios.flatMap(scenario => {
    const row = cards.find(card => card.scenarioId === scenario.id);
    if (row?.outcome !== 'fail' || row.control) return [];
    return failureExplanation(record, scenario) ?? [];
  });
  const topCauses = causesOf(record, failures);
  const controlCards = cards.filter(card => card.control).map(card => ({ scenarioId: card.scenarioId, title: card.title, outcome: card.outcome,
    ...(card.reason ? { reason: card.reason } : {}), rules: card.rules, synthetic: card.provenance === 'synthetic', unstable: card.unstable }));
  // Worded like the control line: a failed control is «не пройден», an unmeasured one «не измерен».
  const controlFailed = controlCards.some(card => card.outcome === 'fail');
  const controlUnmeasured = controlCards.some(unmeasuredControl);
  const controlWarning = controlFailed || controlUnmeasured
    ? `Контроль ${controlFailed && controlUnmeasured ? 'не пройден или не измерен' : controlFailed ? 'не пройден' : 'не измерен'} — числу пока не верить: проверьте судью и связь с агентом.` : null;
  const passed = counted.filter(card => card.outcome === 'pass').length;
  const decided = passed + counted.filter(card => card.outcome === 'fail').length;
  const accuracy = decided ? passed / decided : null;
  const range = wilson(passed, decided);
  // A draft that never ran has nothing pending and nothing unmeasured yet; its cards keep their reason.
  const notStarted = !record.trials.length && (record.phase === 'preparing' || record.phase === 'review');
  const pending = notStarted ? 0 : counted.filter(card => card.reason === 'in_progress').length;
  const reasons = notStarted ? [] : NOT_MEASURED_CODES.filter(code => code !== 'in_progress').map(code => {
    const scenarioIds = counted.filter(card => card.outcome === 'unknown' && card.reason === code).map(card => card.scenarioId);
    return { code, label: NOT_MEASURED_TEXT[code], count: scenarioIds.length, scenarioIds };
  }).filter(reason => reason.count > 0)
    // Array.prototype.sort is stable, so equal counts keep NOT_MEASURED_CODES order.
    .sort((a, b) => b.count - a.count);
  const text = notStarted ? 'Прогон ещё не запускался.'
    : !decided || accuracy === null ? 'Проверенных ситуаций нет.'
    : `Справился в ${passed} из ${decided} ${pluralForm(decided, ['проверенной ситуации', 'проверенных ситуаций', 'проверенных ситуаций'])} — ${Math.round(accuracy * 100)}%.`;
  const smallSample = range && decided < SMALL_SAMPLE
    ? `Мало данных: реальная доля где-то от ${Math.round(range[0] * 100)}% до ${Math.round(range[1] * 100)}%.` : null;
  const breakdown = breakdownOf(record, counted, notStarted);
  const exclusions = record.validationExclusions ?? [];
  const excluded = exclusionCounts(exclusions);
  const examined = record.dialogues.length + exclusions.length;
  const included = record.dialogues.length;
  const coverageText = !exclusions.length ? null
    : `Из ${examined} ${pluralForm(examined, ['диалога', 'диалогов', 'диалогов'])} в набор ${pluralForm(included, ['вошёл', 'вошли', 'вошли'])} ${included}. `
      + `Не ${pluralForm(exclusions.length, ['вошёл', 'вошли', 'вошли'])} ${exclusions.length}: ${excluded.map(item => `${item.label} — ${item.count}`).join(', ')}.`;
  const model = judgeModel(record);
  return {
    runId: record.id,
    phase: record.phase,
    countingRules: COUNTING_RULES,
    headline: { passed, decided, accuracy, range, text, smallSample },
    breakdown,
    pending,
    notMeasured: { total: reasons.reduce((n, reason) => n + reason.count, 0), reasons },
    // A draft that never ran has no control verdict to warn about yet.
    control: { cards: controlCards, warning: notStarted ? null : controlWarning },
    coverage: { examined, included, excluded, text: coverageText },
    cards,
    failures,
    topCauses,
    agreement: judgeAgreement(input),
    scope: {
      cards: record.scenarios.length,
      synthetic: record.scenarios.filter(scenario => scenario.provenance === 'synthetic').length,
      dialogues: record.trials.length,
      ...(model ? { judgeModel: model } : {}),
      costUsd: record.usage.costUsd,
      target: record.targetVersion ?? record.targetRelease ?? (record.target.kind === 'sandbox' ? 'песочница' : record.targetFingerprint?.slice(0, 12) ?? 'версия не названа'),
    },
    ...(stability ? { stability } : {}),
  };
}

const VERDICT_WORD: Record<StabilityRow['before'], string> = { pass: 'справился', fail: 'не справился' };

/** Only found instability is stated; a skipped check is said in words, never as a silent 0. */
function stabilityLine(stability: Stability): string {
  if (stability.skipped) return `Стабильность не проверена: ${stability.skipped}.`;
  return `Нестабильных: ${stability.unstable.length} (${stability.basis === 'repeat' ? 'повтор' : 'переоценка'} прогона ${shortId(stability.comparedWith)}).`;
}

/** The prompt-rule half of a single control's line, in words (C-305). */
const CONTROL_RULES_TEXT: Record<'pass' | 'fail' | 'unknown', string> = { pass: 'правила промпта соблюдены ✓', fail: 'правила промпта нарушены ✗', unknown: 'правила промпта не измерены' };

/**
 * One line for the positive controls; never merged into the headline. A control is decided by its
 * goal alone, but when it carries the prompt-rule check the line names both facts, so a broken rule
 * on the control is shown and never hidden (C-305, C-306). Without the check the phase-1 text is kept.
 */
function controlLine(view: ResultView): string {
  const { cards } = view.control;
  const [only] = cards;
  if (!only) return 'Контроль: не задан.';
  const n = cards.length;
  const passed = cards.filter(card => card.outcome === 'pass').length;
  const notStarted = !view.scope.dialogues && (view.phase === 'preparing' || view.phase === 'review');
  const ruled = cards.filter(card => card.rules !== 'none');
  // The phase-1 stems; a multi-control stem that ends in a period keeps it after any rules suffix.
  const [stem, period] = passed === n ? [n === 1 ? 'Контроль: пройден ✓' : `Контроль: пройдено ${n} из ${n} ✓`, '']
    : n > 1 ? [`Контроль: пройдено ${passed} из ${n}`, '.']
    : only.outcome === 'fail' ? ['Контроль: не пройден ✗', '']
    : notStarted || !unmeasuredControl(only) ? ['Контроль: ещё не проверен.', '']
    : [`Контроль: не измерен — ${NOT_MEASURED_TEXT[only.reason]}.`, ''];
  let base = stem + period;
  if (n === 1 && only.rules !== 'none' && (only.outcome === 'pass' || only.outcome === 'fail')) {
    base = `Контроль: запрос ${only.outcome === 'pass' ? 'выполнен ✓' : 'не выполнен ✗'} · ${CONTROL_RULES_TEXT[only.rules]}`;
  } else if (n > 1 && ruled.length) {
    const brokenRules = ruled.filter(card => card.rules === 'fail').length;
    const keptRules = ruled.filter(card => card.rules === 'pass').length;
    const suffix = brokenRules > 0 ? ` · правила промпта нарушены в ${brokenRules} из ${ruled.length}` : ` · правила промпта соблюдены в ${keptRules} из ${ruled.length}`;
    base = stem + suffix + period;
  }
  const synthetic = cards.some(card => card.synthetic) ? ' · синтетическая ситуация' : '';
  const unstable = cards.some(card => card.unstable) ? ' · нестабильно' : '';
  return base + synthetic + unstable;
}

/**
 * The agreement rows (F6): one main row plus its tail rows, or nothing at all when there is
 * neither a review queue nor a single mark. Fed only by `view.agreement`, so every surface words
 * it identically. No percent below PERCENT_FROM checks and «мало проверок» below SMALL_SAMPLE:
 * a share of a handful of marks is not a share. The 9-of-10 target is worded as a goal, never as
 * a reached bar, and no statistical coefficient or confusion matrix is shown.
 */
function agreementRows(view: ResultView): ResultRow[] {
  const found = view.agreement;
  const queued = found.queueFailures.length + found.sampledPasses.length;
  if (!queued && !found.checked && !found.unsure && !found.stale && !found.staleRule) return [];
  const rows: ResultRow[] = [];
  if (!found.checked) rows.push({ role: 'agreement', indent: 0, text: 'Согласие с судьёй: ещё не проверено.' });
  else {
    const percent = found.checked >= PERCENT_FROM ? ` — ${Math.round(100 * found.agreed / found.checked)}%` : '';
    const few = found.checked < SMALL_SAMPLE ? ' · мало проверок' : '';
    const failPart = found.failures.checked > 0 ? `провалы: ${found.failures.agreed} из ${found.failures.checked}`
      : found.queueFailures.length ? 'провалы ещё не проверены' : 'провалов нет';
    const passPart = found.passes.checked > 0 ? `успехи: ${found.passes.agreed} из ${found.passes.checked}`
      : found.sampledPasses.length ? 'успехи ещё не проверены' : 'успехов нет';
    rows.push({ role: 'agreement', indent: 0,
      text: `Согласие с судьёй: ${found.agreed} из ${found.checked} проверенных${percent}${few} (${failPart} · ${passPart}).` });
  }
  if (found.checked > 0) rows.push({ role: 'agreement-tail', indent: 2, text: 'Цель — согласие в 9 случаях из 10.' });
  if (found.unsure > 0) rows.push({ role: 'agreement-tail', indent: 2, text: `Человек не смог решить: ${found.unsure}.` });
  if (found.stale > 0) rows.push({ role: 'agreement-tail', indent: 2, text: `Отметки устарели после смены судьи: ${found.stale}.` });
  // Marks given under the previous counting rule answered another question; they are named, never counted (CTX-21, CTX-28).
  if (found.staleRule > 0) rows.push({ role: 'agreement-tail', indent: 2, text: `Отметки поставлены по прежнему правилу подсчёта: ${found.staleRule}. Отметьте заново.` });
  return rows;
}

/**
 * `alarm` is the control warning above the number; `lead` is always the number itself;
 * `agreement` is the F6 row and `agreement-tail` its indented rows, so a surface can color them.
 */
type ResultRowRole = 'lead' | 'line' | 'situation' | 'detail' | 'alarm' | 'agreement' | 'agreement-tail';
export interface ResultRow { role: ResultRowRole; indent: number; text: string }

/**
 * The first block of every result surface as rows. Each unmeasured situation follows the
 * `Не измерено:` row with its reason, grouped in the order of the reasons.
 */
export function resultViewRows(view: ResultView, options: { details?: boolean } = {}): ResultRow[] {
  const { headline, notMeasured, control, coverage } = view;
  const [main] = notMeasured.reasons;
  const rows: ResultRow[] = [];
  // The warning carries its own role, so it keeps its warning colour and the number keeps `lead`:
  // exactly when the reader most needs both rows, neither is muted by the other's position.
  if (control.warning) rows.push({ role: 'alarm', indent: 0, text: control.warning });
  rows.push({ role: 'lead', indent: 0, text: headline.text });
  const add = (role: ResultRowRole, text: string, indent = 0) => { rows.push({ role, indent, text }); };
  // The breakdown sits right under the number so a zero explains itself before any caveat.
  if (view.breakdown.text) add('line', view.breakdown.text);
  if (headline.smallSample) add('line', headline.smallSample);
  if (view.stability) add('line', stabilityLine(view.stability));
  if (view.pending > 0) add('line', `Ещё проверяется: ${view.pending}.`);
  if (notMeasured.total > 0 && main) {
    add('line', notMeasured.reasons.length === 1
      ? `Не измерено: ${notMeasured.total} — ${main.label}.`
      : `Не измерено: ${notMeasured.total} — чаще всего ${main.label} (${main.count}).`);
    const titles = new Map(view.cards.map(card => [card.scenarioId, card.title]));
    for (const reason of notMeasured.reasons) {
      for (const id of reason.scenarioIds) add('situation', `? ${titles.get(id) ?? id} — ${reason.label}`, 2);
    }
  }
  add('line', controlLine(view));
  rows.push(...agreementRows(view));
  if (coverage.text) add('line', coverage.text);
  if (options.details && notMeasured.reasons.length > 1) {
    add('detail', 'Не измерено по причинам:');
    for (const reason of notMeasured.reasons) add('detail', `${reason.label} — ${reason.count}`, 2);
  }
  if (options.details && view.stability) {
    for (const row of view.stability.unstable) add('detail', `нестабильно: ${row.title} — было «${VERDICT_WORD[row.before]}», стало «${VERDICT_WORD[row.after]}»`, 2);
  }
  return rows;
}

/** The first block of every result surface, as plain text lines. */
export function resultViewLines(view: ResultView, options: { details?: boolean } = {}): string[] {
  return rowsToLines(resultViewRows(view, options));
}

export const SECTION_TEXT = {
  causes: { text: 'Главные причины провалов:', board: 'ГЛАВНЫЕ ПРИЧИНЫ ПРОВАЛОВ' },
  failures: { text: 'Провалы:', board: 'ПРОВАЛЫ' },
  all: { board: 'ВСЕ ПРОВАЛЫ', hint: 'Все провалы: Enter.' },
} as const;
export const allFailuresTitle = (n: number) => `Все провалы (${n}):`;
export const allFailuresPointer = (runId: string) => `Все провалы — /agent-lab ${shortId(runId)}, раздел 1, Enter.`;

export interface SectionRow { role: ExplanationRole | 'cause' | 'blank'; indent: number; text: string }
const BLANK: SectionRow = { role: 'blank', indent: 0, text: '' };
const SITUATION_FORMS: [string, string, string] = ['ситуация', 'ситуации', 'ситуаций'];

/** Explanation blocks separated by one blank row. */
function blocks(items: SectionRow[][]): SectionRow[] {
  return items.flatMap((rows, i) => i ? [BLANK, ...rows] : rows);
}

/**
 * The top causes, each with a full example; without recorded causes, the first three failed
 * situations under `Провалы:`; null when nothing failed. The heading is SECTION_TEXT[kind].
 */
export function causeSection(view: ResultView): { kind: 'causes' | 'failures'; rows: SectionRow[] } | null {
  if (view.topCauses.length) {
    return { kind: 'causes', rows: blocks(view.topCauses.map((cause, i) => [
      { role: 'cause', indent: 0, text: `${i + 1}. ${cause.name} — ${cause.count} ${pluralForm(cause.count, SITUATION_FORMS)}` },
      ...exampleRows(cause.example),
    ])) };
  }
  if (!view.failures.length) return null;
  return { kind: 'failures', rows: blocks(view.failures.slice(0, 3).map(item => item.rows)) };
}

/** Every failed situation, in record order. */
export function failureListRows(view: ResultView): SectionRow[] {
  return blocks(view.failures.map(item => item.rows));
}

/** The board heading of the disagreement section (C-60); the text surfaces use `disagreementTitle`. */
export const DISAGREEMENT_BOARD_TITLE = 'НЕСОГЛАСИЯ С СУДЬЁЙ';
export const disagreementTitle = (k: number) => `Несогласия с судьёй (${k}):`;

type DisagreementRole = 'dis-title' | 'dis-verdicts' | 'dis-reason' | 'blank';
export interface DisagreementRow { role: DisagreementRole; indent: number; text: string }

/** The owner's side of one headline metric on the F7 row (C-315): the metric after the mark, or that the owner could not tell. */
const OWNER_PART: Record<string, Record<'pass' | 'fail' | 'unsure', string>> = {
  [GOAL_METRIC_ID]: { pass: 'запрос выполнен', fail: 'запрос не выполнен', unsure: 'про запрос не уверен' },
  [RULES_METRIC_ID]: { pass: 'правила промпта соблюдены', fail: 'правила промпта нарушены', unsure: 'про правила промпта не уверен' },
};

/**
 * What the owner said about the situation (C-62 / C-315). A full overturn is one word, the
 * opposite of the judge's. When the owner overturned one of the two metrics that decided the
 * situation, the verdict word would read absurdly («не справился → не справился»), so the row
 * names both halves instead: the overturned metric first, then the other one — the judge's side
 * where the owner agreed, «не уверен» where the owner could not tell (CTX-26).
 */
function ownerVerdict(view: ResultView, item: JudgeAgreement['disagreements'][number]): string {
  if (!item.overturned) return VERDICT_WORD[item.human];
  const overturned = new Set(item.overturned);
  const targets = view.agreement.marks.find(mark => mark.trialId === item.trialId)?.targets ?? [];
  const opposite = item.judge === 'fail' ? 'pass' : 'fail';
  const part = (target: (typeof targets)[number]) => {
    const words = OWNER_PART[target.metricId];
    if (!words) return target.answer === 'disagree' ? VERDICT_WORD[opposite] : VERDICT_WORD[item.judge];
    return target.answer === 'unsure' ? words.unsure : words[target.answer === 'disagree' ? opposite : item.judge];
  };
  return [...targets.filter(target => overturned.has(target.metricId)), ...targets.filter(target => !overturned.has(target.metricId))].map(part).join('; ');
}

/**
 * The disagreement section (F7): the situations where the owner overturned the judge, in the card
 * order of the record — the title, both verdicts and the owner's reason in full. Only current
 * quick disagreements are listed: an unsure or a stale mark overturned nothing. The text is raw,
 * because each surface escapes at its own boundary (`safeLine` on the CLI, `safeText` in Pi).
 */
export function disagreementRows(view: ResultView): DisagreementRow[] {
  return view.agreement.disagreements.flatMap((item, i) => [
    ...(i ? [{ role: 'blank' as const, indent: 0, text: '' }] : []),
    { role: 'dis-title' as const, indent: 0, text: `! ${item.title}` },
    { role: 'dis-verdicts' as const, indent: 2, text: `Судья: ${VERDICT_WORD[item.judge]} → владелец: ${ownerVerdict(view, item)}` },
    { role: 'dis-reason' as const, indent: 2, text: `Причина: «${oneLine(item.note)}»` },
  ]);
}

/**
 * Where the rest of the queue is marked (F8). The mark itself is made on the board and nowhere
 * else, so this row only points there; it is silent once every queued situation has been answered.
 */
export function agreementNextStep(view: ResultView): string | null {
  if (!view.agreement.unmarked.length) return null;
  return `Отметить согласие с судьёй можно в Pi: /agent-lab ${shortId(view.runId)}, раздел 3.`;
}

/** F7 and F8 as plain lines for the CLI and the Pi answer; empty when there is neither. */
export function agreementSectionLines(view: ResultView): string[] {
  const rows = disagreementRows(view);
  const lines = rows.length ? [disagreementTitle(view.agreement.disagreements.length), ...rowsToLines(rows)] : [];
  const next = agreementNextStep(view);
  if (!next) return lines;
  return [...lines, ...(lines.length ? [''] : []), next];
}
