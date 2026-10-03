import { api } from "./api";
import { pct } from "./format";
import type { LogDialogue } from "./problems";
import type { Discover, ToneCriterion } from "./types";

export type ToneCheck = {
  id: string;
  finishedAt: string;
  criteriaRevision: string;
  criteriaFingerprint: string;
  datasetFingerprint: string;
  file: string | null;
  total: number;
  sampled: number;
  summary: { measured: number; passed: number; failed: number; unmeasured: number };
  model: string;
  comparison: {
    kind: "same-data" | "new-data" | "incompatible" | "first";
    previousId: string | null;
    reason: string;
  };
};

export type ToneHistory = { checks: ToneCheck[]; hasLegacyResult: boolean };
export type ToneSnapshot = {
  check: ToneCheck;
  result: Discover;
  dialogues: LogDialogue[];
  criteria: (ToneCriterion & { clarifications?: string[] })[];
  policy: { name: string; content: string };
  reviewSemantics: "latest-saved";
  reviews: { dialogueId: string; ruleId: string; decision: "agree" | "disagree" | null; updatedAt: string }[];
};

export const loadToneHistory = () => api<ToneHistory>("/api/tone-of-voice/history");
export const loadToneSnapshot = (id: string) =>
  api<ToneSnapshot>(`/api/tone-of-voice/history/${encodeURIComponent(id)}`);

/** The share of the checked conversations with an error of the agent, or null when none was checked. */
export const errorShare = (check: ToneCheck) =>
  check.summary.measured ? pct(check.summary.failed, check.summary.measured) : null;

/** «22 из 53 (42%)»: the conversations with an error of the checked ones, the share beside. */
const errors = (check: ToneCheck) =>
  `${check.summary.failed} из ${check.summary.measured} (${errorShare(check) ?? 0}%)`;

/**
 * How a saved check stands to the one before it. Only the server can declare two checks comparable; a different
 * sample never proves improvement, and numbers that did not change get no arrow.
 */
export function comparisonText(check: ToneCheck, previous?: ToneCheck): string {
  const kind = check.comparison.kind;
  if (kind === "first") return "Первая сохранённая проверка.";
  if (kind === "incompatible")
    return "Критерии или модель проверки изменились. Доли между этими проверками не сравниваем.";
  const context =
    kind === "same-data"
      ? "Повторная оценка тех же разговоров по тем же критериям."
      : "Другая выборка разговоров, те же критерии и модель проверки.";
  if (!previous || previous.id !== check.comparison.previousId) return context;
  if (!previous.summary.measured || !check.summary.measured)
    return `${context} Для сопоставления долей не хватает оценок.`;
  if (previous.summary.failed === check.summary.failed && previous.summary.measured === check.summary.measured)
    return `${context} С ошибкой агента — столько же: ${errors(check)}.`;
  return `${context} С ошибкой агента: ${errors(previous)} → ${errors(check)}. ${kind === "new-data" ? "Разница может зависеть от состава разговоров." : "Изменение оценки не означает, что агент был исправлен."}`;
}
