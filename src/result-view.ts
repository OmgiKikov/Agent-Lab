import type { Experiment, Scenario, ValidationExclusion } from './contracts.js';
import { observedRecord } from './outcomes.js';
import { cardVerdict, judgeModel, NOT_MEASURED_CODES, type NotMeasuredCode } from './comparison.js';

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

/** Russian plural form only: pluralForm(2, ['диалог', 'диалога', 'диалогов']) → «диалога». */
export function pluralForm(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10, mod100 = n % 100;
  return mod10 === 1 && mod100 !== 11 ? forms[0] : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20) ? forms[1] : forms[2];
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
  control: { cards: { scenarioId: string; title: string; outcome: CardOutcome; reason?: NotMeasuredCode; synthetic: boolean }[]; warning: string | null };
  coverage: { examined: number; included: number; excluded: { kind: ExclusionKind; label: string; count: number }[]; text: string | null };
  cards: { scenarioId: string; title: string; outcome: CardOutcome; reason?: NotMeasuredCode; control: boolean; unstable: boolean; provenance: Scenario['provenance'] }[];
  scope: { cards: number; synthetic: number; dialogues: number; judgeModel?: string; costUsd: number | null; target: string };
}

export function buildResultView(input: Experiment): ResultView {
  const record = observedRecord(input);
  const cards: ResultView['cards'] = record.scenarios.map(scenario => {
    const verdict = cardVerdict(record, scenario);
    return { scenarioId: scenario.id, title: scenario.title, outcome: verdict.outcome, ...(verdict.reason ? { reason: verdict.reason } : {}),
      control: false, unstable: false, provenance: scenario.provenance };
  });
  const passed = cards.filter(card => card.outcome === 'pass').length;
  const decided = passed + cards.filter(card => card.outcome === 'fail').length;
  const accuracy = decided ? passed / decided : null;
  const range = wilson(passed, decided);
  // A draft that never ran has nothing pending and nothing unmeasured yet; its cards keep their reason.
  const notStarted = !record.trials.length && (record.phase === 'preparing' || record.phase === 'review');
  const pending = notStarted ? 0 : cards.filter(card => card.reason === 'in_progress').length;
  const reasons = notStarted ? [] : NOT_MEASURED_CODES.filter(code => code !== 'in_progress').map(code => {
    const scenarioIds = cards.filter(card => card.outcome === 'unknown' && card.reason === code).map(card => card.scenarioId);
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
    control: { cards: [], warning: null },
    coverage: { examined, included, excluded, text: coverageText },
    cards,
    scope: {
      cards: record.scenarios.length,
      synthetic: record.scenarios.filter(scenario => scenario.provenance === 'synthetic').length,
      dialogues: record.trials.length,
      ...(model ? { judgeModel: model } : {}),
      costUsd: record.usage.costUsd,
      target: record.targetVersion ?? record.targetRelease ?? (record.target.kind === 'sandbox' ? 'песочница' : record.targetFingerprint?.slice(0, 12) ?? 'версия не названа'),
    },
  };
}

/** The first block of every result surface, as plain text lines. */
export function resultViewLines(view: ResultView, options: { details?: boolean } = {}): string[] {
  const { headline, notMeasured, control, coverage } = view;
  const [main] = notMeasured.reasons;
  const lines = [headline.text];
  if (headline.smallSample) lines.push(headline.smallSample);
  if (view.pending > 0) lines.push(`Ещё проверяется: ${view.pending}.`);
  if (notMeasured.total > 0 && main) {
    lines.push(notMeasured.reasons.length === 1
      ? `Не измерено: ${notMeasured.total} — ${main.label}.`
      : `Не измерено: ${notMeasured.total} — чаще всего ${main.label} (${main.count}).`);
  }
  if (!control.cards.length) lines.push('Контроль: не задан.');
  if (coverage.text) lines.push(coverage.text);
  if (options.details && notMeasured.reasons.length > 1) {
    lines.push('Не измерено по причинам:', ...notMeasured.reasons.map(reason => `  ${reason.label} — ${reason.count}`));
  }
  return lines;
}
