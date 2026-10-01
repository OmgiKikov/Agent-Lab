import { api } from "./api";
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

export const toneShare = (check: ToneCheck) =>
  check.summary.measured ? Math.round((100 * check.summary.passed) / check.summary.measured) : null;

/** Only the server can declare two checks comparable; a different sample never proves improvement. */
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
  const before = toneShare(previous);
  const after = toneShare(check);
  if (before === null || after === null) return `${context} Для сопоставления долей не хватает оценок.`;
  const shares = `Без найденных ошибок: ${previous.summary.passed} из ${previous.summary.measured} (${before}%) → ${check.summary.passed} из ${check.summary.measured} (${after}%).`;
  return `${context} ${shares} ${kind === "new-data" ? "Разница может зависеть от состава разговоров." : "Изменение оценки не означает, что агент был исправлен."}`;
}
