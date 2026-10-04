import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { resultOf } from "./checks";
import { longDay, plural } from "./format";
import { FEW, notComparedText, shareText, shiftText, type Counts, type Summary } from "./history";
import { useLabState } from "./LabProvider";
import type { Check, Discover } from "./types";

/**
 * What a person may read into two shares of errors (backend/lab/history.py, verdict): under 30 checked conversations on
 * a side — nothing more; otherwise whether chance explains the difference (Fisher's exact test), or there is none.
 */
export type Verdict = "few" | "beyond-chance" | "within-chance" | "same";
/** Which way the share of errors went: a fact about the count, never a judgement of the agent. */
export type Direction = "fewer" | "more" | "same";

/** A saved check in a line: which it is, when, of which export, its counts. */
export type CheckLine = { id: string; finishedAt: string; file: string | null; summary: Summary };

/** One criterion of both checks, by the key of the problems (problems.rule_key); a side that lacked it is null. */
export type CompareRow = {
  id: string;
  name: string;
  text: string;
  before: Counts | null;
  now: Counts | null;
  verdict: Verdict | null;
  direction: Direction | null;
};

/**
 * «Было → стало» of one check (GET /api/compare): its current result against its previous saved check. `first` —
 * nothing saved before; `none` — no current result, `previous` is the last saved check; `incompatible` — other
 * criteria or models, no numbers; `same-data` and `new-data` — the overall share and each criterion side by side.
 */
export type Compare = {
  check: Check;
  kind: "first" | "none" | "incompatible" | "same-data" | "new-data";
  reason: string;
  current: CheckLine | null;
  previous: CheckLine | null;
  overall?: { before: Counts; now: Counts; verdict: Verdict | null; direction: Direction | null };
  criteria?: CompareRow[];
  /**
   * The conversations with a serious error on both sides, by the marks as they are now, under the same rules as
   * `overall`; only once a criterion of the check is marked serious (lab/severity).
   */
  serious?: {
    before: Counts;
    now: Counts;
    /** The conversations of each side where a serious criterion could be checked; under 30 on a side — `few`. */
    checked?: { before: number; now: number };
    verdict: Verdict | null;
    direction: Direction | null;
  };
};

/**
 * The comparison of a check's current result with its previous saved check. It reads saved records only, and is asked
 * again when that check's result, the export or its serious marks change.
 */
export function useCompare(check: Check | null) {
  const { state } = useLabState();
  const result = check ? resultOf(state, check) : null;
  const marks = check ? (state?.severity?.[check] ?? []).join(",") : "";
  return useQuery({
    queryKey: ["compare", check, result?.checkId ?? result?.finishedAt ?? null, state?.logs.updatedAt ?? null, marks],
    queryFn: () => api<Compare>(`/api/compare?check=${check}`),
    enabled: !!state && !!check,
    staleTime: Infinity,
  });
}

/**
 * The comparison of the result on the screen, or nothing: an answer about another result (one replaced meanwhile)
 * says nothing about it, and a result is compared only once the service has it in the history.
 */
export function comparisonOf(compare: Compare | undefined, result: Discover | null): Compare | null {
  if (!compare) return null;
  if (!result) return compare.kind === "none" || compare.kind === "first" ? compare : null;
  return compare.current && compare.current.id === result.checkId ? compare : null;
}

/**
 * The last saved check of a check without a current result (`none`), and whether the export was loaded after it: then
 * the new export is not checked yet. Otherwise the result went with the check's own criteria (new rules of
 * communication, changed code of the agent) on the same export.
 */
export function previousOf(
  compare: Compare | null,
  uploadedAt?: string | null,
): { line: CheckLine; newExport: boolean } | null {
  if (compare?.kind !== "none" || !compare.previous) return null;
  const newExport = !!uploadedAt && Date.parse(uploadedAt) > Date.parse(compare.previous.finishedAt);
  return { line: compare.previous, newExport };
}

const VERDICT: Record<Exclude<Verdict, "same">, string> = {
  few: "Мало разговоров, чтобы судить.",
  "beyond-chance": "Разница больше случайных колебаний; могли измениться и сами разговоры — темы, клиенты.",
  "within-chance": "Разница в пределах случайных колебаний.",
};

/** A side without a single checked conversation has no share to set beside the other: no arrow then. */
const sideText = (counts: Counts) => (counts.measured ? shareText(counts) : "ни один разговор не удалось проверить");

/**
 * The line under a check's number, in two parts: its first words (`head`, the way to the previous check) and the
 * rest. «Прошлая проверка, 3 октября, «Выгрузка чата сентябрь 2026.xlsx»: 22 из 53 (42%) → сейчас 4 из 12 (33%). Мало
 * разговоров, чтобы судить.» A re-evaluation of the same conversations says the difference is the evaluation's; other
 * criteria or models — that the checks are not compared, without numbers. Nothing before the first comparison, nor
 * without a current result. `short` leaves out the export, for «Обзор».
 */
export function compareSentence(compare: Compare, { short = false } = {}): { head: string; rest: string } | null {
  if (compare.kind === "incompatible") {
    const text = notComparedText(compare.reason);
    return { head: text.slice(0, text.indexOf(":")), rest: text.slice(text.indexOf(":")) };
  }
  const { overall, previous } = compare;
  if ((compare.kind !== "new-data" && compare.kind !== "same-data") || !overall || !previous) return null;
  const { before, now, verdict, direction } = overall;
  const same = direction === "same";
  const both = !!before.measured && !!now.measured;
  const counts = both ? shiftText(before, now, same, "сейчас") : `${sideText(before)}; сейчас ${sideText(now)}`;
  if (compare.kind === "same-data")
    return {
      head: "Повторная оценка тех же разговоров",
      rest: `: ${counts}.${both && !same ? " Разница — разброс оценки, а не агента." : ""}`,
    };
  const file = !short && previous.file ? `, «${previous.file}»` : "";
  const said = verdict && verdict !== "same" ? ` ${VERDICT[verdict]}` : "";
  return { head: "Прошлая проверка", rest: `, ${longDay(previous.finishedAt)}${file}: ${counts}.${said}` };
}

/**
 * «С серьёзными ошибками: 6 из 53 (11%) → сейчас 0 из 71 (0%). Мало разговоров, чтобы судить: серьёзные критерии
 * удалось проверить в 16 разговорах тогда и в 4 сейчас.» — the line under the comparison of the whole check, in its
 * words: the same counts and arrow, the same verdict (few, beyond chance or within it), and for a re-evaluation of the
 * same conversations — that the difference is the evaluation's. Both sides by the serious marks as they are now
 * (`marked` of them in the current result). The share rests on the conversations where a serious criterion could be
 * checked: with few of them the line says how few. Null when nothing is marked or the checks are not compared.
 */
export function seriousCompareText(compare: Compare, marked = 2): string | null {
  const serious = compare.serious;
  if (!serious || (compare.kind !== "new-data" && compare.kind !== "same-data")) return null;
  const { before, now, checked, verdict, direction } = serious;
  const same = direction === "same";
  const both = !!before.measured && !!now.measured;
  const counts = both ? shiftText(before, now, same, "сейчас") : `${sideText(before)}; сейчас ${sideText(now)}`;
  if (compare.kind === "same-data")
    return `С серьёзными ошибками: ${counts}.${both && !same ? " Разница — разброс оценки, а не агента." : ""}`;
  const criteria = marked === 1 ? "серьёзный критерий" : "серьёзные критерии";
  const said =
    verdict === "few" && checked && Math.min(checked.before, checked.now) < FEW
      ? ` Мало разговоров, чтобы судить: ${criteria} удалось проверить в\u00a0${checked.before}\u00a0${plural(checked.before, "разговоре", "разговорах", "разговорах")} тогда и в\u00a0${checked.now} сейчас.`
      : verdict && verdict !== "same"
        ? ` ${VERDICT[verdict]}`
        : "";
  return `С серьёзными ошибками: ${counts}.${said}`;
}

/** «было 6 из 52»: what a criterion with errors now had in the previous check, beside its count. */
export function wasText(row: CompareRow): string {
  const before = row.before;
  if (!before || !before.measured) return "раньше не проверялся";
  if (!before.failed) return `раньше ошибок не было: 0\u00a0из\u00a0${before.measured}`;
  return `было ${before.failed}\u00a0из\u00a0${before.measured}`;
}

/** The criteria with errors in the previous check and none now: «было 3 из 56 → 0 из 12». */
export const noLongerFound = (compare: Compare) =>
  (compare.criteria ?? []).filter((row) => (row.before?.failed ?? 0) > 0 && !row.now?.failed);

/** «было 3 из 56 → 0 из 12», or that the criterion could not be checked now at all. */
export function goneText(row: CompareRow): string {
  const before = row.before!;
  const now = row.now?.measured ? `0\u00a0из\u00a0${row.now.measured}` : "сейчас проверить не удалось";
  return `было ${before.failed}\u00a0из\u00a0${before.measured} → ${now}`;
}

/** What a person may read into one criterion's change, in a few quiet words; nothing when nothing may be read. */
export const VERDICT_WORD: Record<Verdict, string> = {
  few: "мало разговоров, чтобы судить",
  "beyond-chance": "разница больше случайных колебаний",
  "within-chance": "в пределах случайных колебаний",
  same: "доля та же",
};
