import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../ui/toast";
import { api } from "./api";
import { plural } from "./format";
import { shareText, type Counts } from "./history";
import { useLabState } from "./LabProvider";
import type { Problems } from "./problems";
import type { Check } from "./types";

/**
 * Serious and minor errors (spec 2026-10-04-severity-design.md): a person marks a criterion of a check serious, on its
 * criteria and on its problem's page; without the mark its errors are minor. The model never assigns it. The mark lives
 * in the service by the criterion's key (the problem's id), apart from the criteria: it changes neither what is checked
 * nor how. Serious problems come first everywhere, carry «серьёзная», and the conversations with a serious error are
 * counted beside the check's number — never instead of it, never added to it (DESIGN.md, «Честность чисел», 4).
 */
export type Mark = { check: Check; rule: string; serious: boolean };

/** The criteria tab says it once, while none of the check's criteria is marked. */
export const SEVERITY_HINT = "Отметьте серьёзные ошибки — они встанут первыми и получат отдельный счёт.";

/** Serious first; otherwise the order stays as it was (a stable sort keeps it). */
export const seriousFirst = (a: { serious: boolean }, b: { serious: boolean }) => Number(b.serious) - Number(a.serious);

/** The record of a check with one criterion marked as the person just marked it: shown at once, saved by the service. */
const marked = (data: Problems, rule: string, serious: boolean): Problems => ({
  ...data,
  rules: data.rules.map((r) => (r.id === rule ? { ...r, serious } : r)),
});

/**
 * «Серьёзная ошибка» on one criterion of a check, or taken back. The switch, the order and the tags change at once; the
 * service answers with the marks, and the state, the problems (their stamp has the marks) and «было → стало» are asked
 * again. A refused mark is taken back on screen.
 */
export function useSeverity() {
  const client = useQueryClient();
  const toast = useToast();
  const { refresh } = useLabState();
  return useMutation({
    mutationKey: ["severity"],
    mutationFn: ({ check, rule, serious }: Mark) => api("/api/severity", { check, rule, serious }),
    onMutate: ({ check, rule, serious }) => {
      client.setQueriesData<Problems>({ queryKey: ["problems"] }, (old) =>
        old && old.check === check ? marked(old, rule, serious) : old,
      );
    },
    onError: (e) => {
      toast.error(e);
      client.invalidateQueries({ queryKey: ["problems"] });
    },
    onSettled: () => refresh(),
  });
}

/**
 * The serious count of a check's result: the checked conversations with a serious error, its marked criteria, and the
 * conversations where they could be checked (`checked`) — elsewhere they did not apply or could not be checked.
 */
export type Serious = Counts & { marked: number; checked: number };

/**
 * The serious count of the result in a record of problems, or null: before any of its criteria is marked serious (the
 * service gives `withSerious` once a mark exists; marks of criteria the result no longer has count nothing), and when
 * no conversation could be checked. The denominator is the check's own.
 */
export function seriousOf(data: Problems | null | undefined): Serious | null {
  const log = data?.log;
  if (!data || !log || log.withSerious === undefined || !log.assessed) return null;
  const marked = data.rules.filter((r) => r.serious && r.log.ruleIds.length > 0).length;
  return marked
    ? { failed: log.withSerious, measured: log.assessed, marked, checked: log.seriousChecked ?? log.assessed }
    : null;
}

/**
 * Where the serious criteria could be checked, when not in every checked conversation: «их удалось проверить в 21
 * разговоре», or «его не удалось проверить ни в одном разговоре». A share of all conversations says little when the
 * criteria seldom applied, and this says how seldom.
 */
function whereChecked(s: Serious): string {
  if (s.checked >= s.measured) return "";
  const them = s.marked === 1 ? "его" : "их";
  if (!s.checked) return `; ${them} не удалось проверить ни в одном разговоре`;
  return `; ${them} удалось проверить в\u00a0${s.checked}\u00a0${plural(s.checked, "разговоре", "разговорах", "разговорах")}`;
}

/**
 * «С серьёзными ошибками — 6 из 53 (11%): по 2 критериям, которые вы отметили серьёзными; их удалось проверить в 21
 * разговоре.» In three parts, as the line of answers, so a screen can set the count apart and open its conversations.
 * Who marked: the person reading («вы»), or people, for a page someone else reads.
 */
export function seriousSentence(s: Serious, who: "you" | "people" = "you") {
  const criteria = plural(s.marked, "критерию, который", "критериям, которые", "критериям, которые");
  const serious = plural(s.marked, "серьёзным", "серьёзными", "серьёзными");
  return {
    head: "С серьёзными ошибками",
    share: shareText(s),
    rest: `: по\u00a0${s.marked}\u00a0${criteria} ${who === "you" ? "вы" : "люди"} отметили ${serious}${whereChecked(s)}.`,
  };
}

/** The same sentence as one line of text, for a letter. */
export const seriousText = (s: Serious, who: "you" | "people" = "you") => {
  const x = seriousSentence(s, who);
  return `${x.head} — ${x.share}${x.rest}`;
};
