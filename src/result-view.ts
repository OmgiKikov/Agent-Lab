import type { Experiment, Scenario, ValidationExclusion } from './contracts.js';
import { observedRecord } from './outcomes.js';
import { cardVerdict, judgeModel, NOT_MEASURED_CODES, stabilityAfterReassess, stabilityBetweenRuns, type NotMeasuredCode, type Stability, type StabilityRow } from './comparison.js';
import { exampleRows, failureExplanation, rowsToLines, type ExplanationRole, type FailureExplanation } from './explain.js';
import { pluralForm } from './plural.js';

export { pluralForm } from './plural.js';

/*
 * The one result every surface shows first: how many situations the agent handled, over one
 * denominator, what was not measured and why, and which dialogues never entered the set.
 * Pure: no I/O, no escaping (each surface escapes at its own boundary). Cards are decided by
 * cardVerdict in comparison.ts; this module only counts and words them. It must not import
 * quality.ts or experiment.ts, so quality.ts can reuse pluralForm without a cycle.
 */
export const COUNTING_RULES = 'goal-v1';

/** Below this many decided situations the headline percent is shown with its Wilson range. */
const SMALL_SAMPLE = 20;
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
export const EXCLUSION_TEXT: Record<ExclusionKind, string> = {
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
  /** Cards still waiting in a running phase; never part of notMeasured. */
  pending: number;
  notMeasured: { total: number; reasons: { code: NotMeasuredCode; label: string; count: number; scenarioIds: string[] }[] };
  control: { cards: { scenarioId: string; title: string; outcome: CardOutcome; reason?: NotMeasuredCode; synthetic: boolean; unstable: boolean }[]; warning: string | null };
  coverage: { examined: number; included: number; excluded: { kind: ExclusionKind; label: string; count: number }[]; text: string | null };
  cards: { scenarioId: string; title: string; outcome: CardOutcome; reason?: NotMeasuredCode; control: boolean; unstable: boolean; provenance: Scenario['provenance'] }[];
  /** One explanation per failed situation of the headline (controls left out), in record order; built from stored data only. */
  failures: FailureExplanation[];
  /** Up to three failure causes, largest first; each counts distinct failed situations and carries one full explanation. */
  topCauses: { name: string; count: number; example: FailureExplanation }[];
  scope: { cards: number; synthetic: number; dialogues: number; judgeModel?: string; costUsd: number | null; target: string };
  /** Found flips against the source run, control situations left out; absent when there is nothing to compare with. Never changes the headline. */
  stability?: Stability;
}

/** The source run to check stability against; the record's own parent or the run it reassessed. */
function stabilityOf(input: Experiment, before: Experiment | undefined): Stability | undefined {
  if (!before) return undefined;
  if (input.assessmentOf === before.id) return stabilityAfterReassess(input, before) ?? undefined;
  return stabilityBetweenRuns(before, input);
}

/**
 * The recorded failure clusters, counted in failed headline situations only. The example is
 * the goal explanation of the first failing cluster attempt, or the situation's own one.
 */
function causesOf(record: Experiment, failures: FailureExplanation[]): ResultView['topCauses'] {
  const failed = new Map(failures.map(item => [item.scenarioId, item]));
  const trials = new Map(record.trials.map(trial => [trial.id, trial]));
  const scenarios = new Map(record.scenarios.map(scenario => [scenario.id, scenario]));
  return (record.failureModes ?? []).flatMap(mode => {
    const attempts = mode.trialIds.flatMap(id => trials.get(id) ?? []).filter(trial => failed.has(trial.scenarioId));
    const [first] = attempts;
    if (!first) return [];
    const own = attempts.map(trial => failureExplanation(record, scenarios.get(trial.scenarioId)!, trial)).find(item => item?.kind === 'goal');
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

export function buildResultView(input: Experiment, options: { before?: Experiment } = {}): ResultView {
  const record = observedRecord(input);
  // Positive controls are real situations the agent is known to handle; they never enter the number.
  const controlIds = new Set((record.positiveControlScenarioIds ?? []).filter(id => record.scenarios.some(scenario => scenario.id === id)));
  const found = stabilityOf(input, options.before);
  const unstableIds = new Set(found?.unstable.map(row => row.scenarioId) ?? []);
  const stability = found && { ...found, unstable: found.unstable.filter(row => !controlIds.has(row.scenarioId)) };
  const cards: ResultView['cards'] = record.scenarios.map(scenario => {
    const verdict = cardVerdict(record, scenario);
    return { scenarioId: scenario.id, title: scenario.title, outcome: verdict.outcome, ...(verdict.reason ? { reason: verdict.reason } : {}),
      control: controlIds.has(scenario.id), unstable: unstableIds.has(scenario.id), provenance: scenario.provenance };
  });
  const counted = cards.filter(card => !card.control);
  const failures = record.scenarios.flatMap(scenario => {
    const row = cards.find(card => card.scenarioId === scenario.id);
    if (row?.outcome !== 'fail' || row.control) return [];
    return failureExplanation(record, scenario) ?? [];
  });
  const topCauses = causesOf(record, failures);
  const controlCards = cards.filter(card => card.control).map(card => ({ scenarioId: card.scenarioId, title: card.title, outcome: card.outcome,
    ...(card.reason ? { reason: card.reason } : {}), synthetic: card.provenance === 'synthetic', unstable: card.unstable }));
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
    pending,
    notMeasured: { total: reasons.reduce((n, reason) => n + reason.count, 0), reasons },
    // A draft that never ran has no control verdict to warn about yet.
    control: { cards: controlCards, warning: notStarted ? null : controlWarning },
    coverage: { examined, included, excluded, text: coverageText },
    cards,
    failures,
    topCauses,
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
  return `Нестабильных: ${stability.unstable.length} (${stability.basis === 'repeat' ? 'повтор' : 'переоценка'} прогона ${stability.comparedWith.slice(0, 8)}).`;
}

/** One line for the positive controls; never merged into the headline. */
function controlLine(view: ResultView): string {
  const { cards } = view.control;
  const [only] = cards;
  if (!only) return 'Контроль: не задан.';
  const n = cards.length;
  const passed = cards.filter(card => card.outcome === 'pass').length;
  const notStarted = !view.scope.dialogues && (view.phase === 'preparing' || view.phase === 'review');
  const base = passed === n ? (n === 1 ? 'Контроль: пройден ✓' : `Контроль: пройдено ${n} из ${n} ✓`)
    : n > 1 ? `Контроль: пройдено ${passed} из ${n}.`
    : only.outcome === 'fail' ? 'Контроль: не пройден ✗'
    : notStarted || !unmeasuredControl(only) ? 'Контроль: ещё не проверен.'
    : `Контроль: не измерен — ${NOT_MEASURED_TEXT[only.reason]}.`;
  const synthetic = cards.some(card => card.synthetic) ? ' · синтетическая ситуация' : '';
  const unstable = cards.some(card => card.unstable) ? ' · нестабильно' : '';
  return base + synthetic + unstable;
}

export type ResultRowRole = 'lead' | 'line' | 'situation' | 'detail';
export interface ResultRow { role: ResultRowRole; indent: number; text: string }

/**
 * The first block of every result surface as rows. Each unmeasured situation follows the
 * `Не измерено:` row with its reason, grouped in the order of the reasons.
 */
export function resultViewRows(view: ResultView, options: { details?: boolean } = {}): ResultRow[] {
  const { headline, notMeasured, control, coverage } = view;
  const [main] = notMeasured.reasons;
  const rows: ResultRow[] = [];
  const add = (role: ResultRowRole, text: string, indent = 0) => { rows.push({ role: rows.length ? role : 'lead', indent, text }); };
  if (control.warning) add('line', control.warning);
  add('line', headline.text);
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
export const allFailuresPointer = (runId: string) => `Все провалы — /agent-lab ${runId.slice(0, 8)}, раздел 1, Enter.`;

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
