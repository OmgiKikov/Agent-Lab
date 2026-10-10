import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { resultOf } from "./checks";
import { pct } from "./format";
import { VERDICT, type Direction, type Verdict } from "./compare";
import { useLabState } from "./LabProvider";
import type { LogDialogue } from "./problems";
import type { Check, Discover, ToneCriterion } from "./types";

/**
 * Below this many conversations where a criterion could be checked, on either side, a share says little (Hamel Husain:
 * under ~60 an interval is too wide): under the number («Проверено меньше 30 разговоров», product/Trust.tsx) and in
 * «было → стало» (backend/lab/domain/statistics.py, FEW).
 */
export const FEW = 30;

/** Errors among the conversations where they could be checked: the two numbers of every count. */
export type Counts = { failed: number; measured: number };
export type Summary = Counts & { passed: number; unmeasured: number };

/**
 * How a saved check stands to the one saved before it; only the service declares two checks comparable. Compared
 * (same-data, new-data), a line carries what a person may read into the difference, as «было → стало» on the result
 * says it (backend/lab/flows/checks.py, saved_checks). Older services have no verdict.
 */
export type Comparison = {
  kind: "same-data" | "new-data" | "incompatible" | "first";
  previousId: string | null;
  reason: string;
  verdict?: Verdict | null;
  direction?: Direction | null;
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

export const loadSaved = (check: Check, id: string) =>
  api<ToneSnapshot | CodeSnapshot>(`/api/history/${check}/${encodeURIComponent(id)}`);

/**
 * The saved checks of a check, newest first, each with how it stands to the one before it: asked again when the
 * check's result changes and when a task starts or ends.
 */
export function useHistory(check: Check) {
  const { state } = useLabState();
  const result = resultOf(state, check);
  return useQuery({
    queryKey: ["history", check, result?.finishedAt ?? null, String(state?.job.running)],
    queryFn: () => api<{ checks: SavedCheck[] }>(`/api/history/${check}`),
    enabled: !!state,
    staleTime: Infinity,
  });
}

/** «22 из 53 (42%)»: the conversations with an error of the checked ones, the share beside; never split by a line. */
export const shareText = ({ failed, measured }: Counts) =>
  `${failed}\u00a0из\u00a0${measured}\u00a0(${pct(failed, measured)}%)`;

/**
 * The share of the checked conversations without an error found: the percent a check's whole result is told by, so
 * it grows as the agent gets better — «5% без найденных ошибок», never «95%» of errors. The counts stay the errors'
 * («279 из 295 с ошибкой»): they are what to fix. A criterion's share and the serious errors' stay theirs.
 */
export const cleanPct = ({ failed, measured }: Counts) => pct(Math.max(0, measured - failed), measured);
/** «5% без найденных ошибок» */
export const cleanText = (c: Counts) => `${cleanPct(c)}%\u00a0без найденных ошибок`;
/** «58% без найденных ошибок · 22 из 53 с ошибкой»: a check's result in a line, its measurement first, as «Итог». */
export const resultText = (c: Counts) => `${cleanText(c)} · ${c.failed}\u00a0из\u00a0${c.measured} с ошибкой`;
/** The counts of the conversations without an error found, as the comparisons of whole results tell them. */
export const cleanOf = (c: Counts): Counts => ({ ...c, failed: Math.max(0, c.measured - c.failed) });

/** The same errors among the same number of checked conversations. */
const unchanged = (before: Counts, now: Counts) => before.failed === now.failed && before.measured === now.measured;

/** The same share of errors, whatever the counts: 5 of 50 and 10 of 100. */
const sameShare = (before: Counts, now: Counts) => before.failed * now.measured === now.failed * before.measured;

/**
 * «22 из 53 (42%) → сейчас 4 из 12 (33%)»: two counts of one check, the earlier first; `later` names the other one
 * («сейчас»). The arrow is neutral, a fact about the count; when the share is the same there is no arrow at all. Nor
 * between two equal percents of different shares: «22 из 53 (42%), сейчас 21 из 50 (42%)», without «доля та же».
 */
export function shiftText(before: Counts, now: Counts, same: boolean, later = "") {
  const next = later ? `${later}\u00a0` : "";
  if (unchanged(before, now)) return `${shareText(before)}, ${later ? `${later} ` : ""}столько же`;
  if (same) return `${shareText(before)}, ${next}${shareText(now)}, доля та же`;
  if (pct(before.failed, before.measured) === pct(now.failed, now.measured))
    return `${shareText(before)}, ${next}${shareText(now)}`;
  return `${shareText(before)}\u00a0→ ${next}${shareText(now)}`;
}

/** «С прошлой проверкой не сравниваем: изменились модели проверки.» — with the service's reason, and no numbers. */
export const notComparedText = (reason: string) =>
  `С прошлой проверкой не сравниваем: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;

/**
 * How a saved check stands to the one before it, in the list of the history. Only the service declares two checks
 * comparable; a different sample never proves anything about the agent, a re-evaluation measures the evaluation, and
 * numbers that did not change get no arrow. Other conversations are judged as «было → стало» on the result judges the
 * same pair, in its words: the service's verdict (lab/compare, VERDICT); an older service without one is told by the
 * number of conversations alone.
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
  const verdict = check.comparison.verdict;
  const caveat =
    kind === "same-data"
      ? !same && "Разница показывает только разброс оценки."
      : verdict !== undefined
        ? verdict && verdict !== "same" && VERDICT[verdict]
        : Math.min(before.measured, now.measured) < FEW
          ? VERDICT.few
          : !same && "Могли измениться темы разговоров и клиенты.";
  return `${context} Без найденных ошибок: ${shiftText(cleanOf(before), cleanOf(now), same)}.${caveat ? ` ${caveat}` : ""}`;
}
