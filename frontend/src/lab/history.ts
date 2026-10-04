import { api } from "./api";
import { pct } from "./format";
import type { LogDialogue } from "./problems";
import type { Check, Discover, ToneCriterion } from "./types";

/**
 * Below this many conversations where a criterion could be checked, on either side, a share says little (Hamel Husain:
 * under ~60 an interval is too wide): under the number («Проверено меньше 30 разговоров», product/Trust.tsx) and in
 * «было → стало» (backend/lab/history.py, FEW).
 */
export const FEW = 30;

/** Errors among the conversations where they could be checked: the two numbers of every count. */
export type Counts = { failed: number; measured: number };
export type Summary = Counts & { passed: number; unmeasured: number };

/** How a saved check stands to the one saved before it; only the service declares two checks comparable. */
export type Comparison = {
  kind: "same-data" | "new-data" | "incompatible" | "first";
  previousId: string | null;
  reason: string;
};

/** A saved check of tone of voice or of Точность, as its history lists it (GET /api/history/{check}). */
export type SavedCheck = {
  id: string;
  finishedAt: string;
  criteriaFingerprint: string;
  datasetFingerprint: string;
  file: string | null;
  total: number;
  sampled: number;
  summary: Summary;
  model: string;
  comparison: Comparison;
};

/** A saved check of tone of voice with its evidence: its criteria, the person's document and the answers on it. */
export type ToneSnapshot = {
  check: SavedCheck;
  result: Discover;
  dialogues: LogDialogue[];
  criteria: (ToneCriterion & { clarifications?: string[] })[];
  policy: { name: string; content: string };
  reviewSemantics: "latest-saved";
  reviews: { dialogueId: string; ruleId: string; decision: "agree" | "disagree" | null; updatedAt: string }[];
};

/** A saved check of Точность: the result as it was when the check finished, and the conversations it judged. */
export type CodeSnapshot = { check: SavedCheck; result: Discover; dialogues: LogDialogue[] };

export const loadHistory = (check: Check) => api<{ checks: SavedCheck[] }>(`/api/history/${check}`);
export const loadSaved = (check: Check, id: string) =>
  api<ToneSnapshot | CodeSnapshot>(`/api/history/${check}/${encodeURIComponent(id)}`);

/** The share of the checked conversations with an error of the agent, or null when none was checked. */
export const errorShare = (check: SavedCheck) =>
  check.summary.measured ? pct(check.summary.failed, check.summary.measured) : null;

/** «22 из 53 (42%)»: the conversations with an error of the checked ones, the share beside; never split by a line. */
export const shareText = ({ failed, measured }: Counts) =>
  `${failed}\u00a0из\u00a0${measured}\u00a0(${pct(failed, measured)}%)`;

/** The same errors among the same number of checked conversations. */
const unchanged = (before: Counts, now: Counts) => before.failed === now.failed && before.measured === now.measured;

/** The same share of errors, whatever the counts: 5 of 50 and 10 of 100. */
const sameShare = (before: Counts, now: Counts) => before.failed * now.measured === now.failed * before.measured;

/**
 * «22 из 53 (42%) → сейчас 4 из 12 (33%)»: two counts of one check, the earlier first; `later` names the other one
 * («сейчас»). The arrow is neutral, a fact about the count; when the share is the same there is no arrow at all.
 */
export function shiftText(before: Counts, now: Counts, same: boolean, later = "") {
  const next = later ? `${later}\u00a0` : "";
  if (unchanged(before, now)) return `${shareText(before)}, ${later ? `${later} ` : ""}столько же`;
  if (same) return `${shareText(before)}, ${next}${shareText(now)}, доля та же`;
  return `${shareText(before)}\u00a0→ ${next}${shareText(now)}`;
}

/** «С прошлой проверкой не сравниваем: изменились модели проверки.» — with the service's reason, and no numbers. */
export const notComparedText = (reason: string) =>
  `С прошлой проверкой не сравниваем: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;

/**
 * How a saved check stands to the one before it, in the list of the history. Only the service declares two checks
 * comparable; a different sample never proves anything about the agent, a re-evaluation measures the evaluation, and
 * numbers that did not change get no arrow.
 */
export function comparisonText(check: SavedCheck, previous?: SavedCheck): string {
  const kind = check.comparison.kind;
  if (kind === "first") return "Первая сохранённая проверка.";
  if (kind === "incompatible") return notComparedText(check.comparison.reason);
  const context =
    kind === "same-data"
      ? "Повторная оценка тех же разговоров по тем же критериям."
      : "Другие разговоры, те же критерии и модель.";
  if (!previous || previous.id !== check.comparison.previousId) return context;
  const before = previous.summary;
  const now = check.summary;
  if (!before.measured || !now.measured)
    return `${context} В одной из проверок нет проверенных разговоров, доли не сравнить.`;
  const same = sameShare(before, now);
  const caveat =
    kind === "same-data"
      ? !same && "Разница — разброс оценки, а не агента."
      : Math.min(before.measured, now.measured) < FEW
        ? "Мало разговоров, чтобы судить."
        : !same && "Могли измениться темы разговоров и клиенты.";
  return `${context} С ошибкой агента: ${shiftText(before, now, same)}.${caveat ? ` ${caveat}` : ""}`;
}
