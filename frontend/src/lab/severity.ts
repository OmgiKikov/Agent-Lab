import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../ui/toast";
import { api } from "./api";
import { count, plural } from "./format";
import { shareText, type Counts } from "./history";
import { useLabState } from "./LabProvider";
import type { Problems, RuleEntry } from "./problems";
import type { Check, Job } from "./types";

/**
 * Serious and minor errors. After each check the automatic check proposes, for
 * every criterion of the result, whether its errors are serious, with a reason; a person confirms or changes it — in
 * the criteria, on the problem's page, or all at once («Подтвердить все») — and a person's decision always wins: no new
 * proposal changes it. Without either an error is minor. Both live in the service by the criterion's key (the
 * problem's id), apart from the criteria: they change neither what is checked nor how. Serious problems come first
 * everywhere, carry «серьёзная», and the conversations with a serious error are counted beside the check's number —
 * never instead of it, never added to it; every screen says whose decision it is.
 */
export type Mark = { check: Check; rule: string; serious: boolean };

/** What the service says while the automatic check proposes (backend/lab/flows/severity.py), and the name of its task. */
export const PROPOSING = "Отмечаем серьёзные ошибки";

/** The person reading («вы») or, on a page someone else reads (the summary, a report, a letter), people («люди»). */
type Who = "you" | "people";

/** Who proposes: «модель» on the product's screens, «автоматическая проверка» on a page someone else reads. */
const MODEL: Record<Who, string> = { you: "модель", people: "автоматическая проверка" };
const PEOPLE: Record<Who, string> = { you: "вы", people: "люди" };

/** Serious first; otherwise the order stays as it was (a stable sort keeps it). */
export const seriousFirst = (a: { serious: boolean }, b: { serious: boolean }) => Number(b.serious) - Number(a.serious);

/**
 * A criterion of the check's result: the automatic check proposes for these, «Подтвердить все» confirms them, and the
 * serious count counts them. One only a run of the scenarios has (problems.from_run) is none of these.
 */
export const ofResult = (r: Pick<RuleEntry, "log">) => r.log.ruleIds.length > 0;

/** One full stop at the end: a reason or an error comes with it or without. */
const sentence = (text: string) => (/[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * The model's reason as a sentence of its own, after whose decision it is: «Так считает модель. Обвинение клиента
 * вредит отношениям с банком.» Its own words often have a colon in them, so it never follows another one.
 */
export const reasonText = (reason: string) => {
  const text = sentence(reason);
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * Where the severity of a check's criteria stands, among the criteria of its result (`criteria`, N): how many are
 * serious (S), the automatic check's proposals no person checked yet (P), decided by a person (D), with neither yet
 * (`pending`, N − P − D); whether a person decided every serious one (`yours`); and why the last proposal failed,
 * while some criterion has neither.
 */
export type Standing = {
  criteria: number;
  serious: number;
  proposed: number;
  decided: number;
  pending: number;
  yours: boolean;
  error: string | null;
};

/** The standing of a record's result, or null without a result (a run's own criteria are not proposed for). */
export function standingOf(data: Problems | null | undefined): Standing | null {
  const rules = data?.rules.filter(ofResult) ?? [];
  if (!data || !rules.length) return null;
  const proposed = rules.filter((r) => r.severity.by === "model").length;
  const decided = rules.filter((r) => r.severity.by === "person").length;
  const pending = rules.length - proposed - decided;
  const serious = rules.filter((r) => r.serious);
  return {
    criteria: rules.length,
    serious: serious.length,
    proposed,
    decided,
    pending,
    yours: serious.every((r) => r.severity.by === "person"),
    error: pending ? data.severity.error : null,
  };
}

/**
 * While some criterion of the result has neither a decision nor a proposal: why the last proposal failed («Отметить
 * снова», `again`) or that nothing is marked yet («Отметить автоматически»). Null when nothing waits for one.
 */
export function pendingOf(st: Standing): { text: string; again: boolean } | null {
  if (!st.pending) return null;
  return st.error
    ? { text: `Не удалось отметить серьёзные ошибки. ${sentence(st.error)}`, again: true }
    : { text: "Серьёзные ошибки ещё не отмечены.", again: false };
}

/**
 * Which criteria are serious and whose decision it is, in one line: «Серьёзные критерии — 2 из 8. Их отметила модель,
 * вы проверили 0 из 8.» Once a person decided every serious one, «Их отметили вы.», with how many criteria they checked
 * in all while some proposals wait. With no serious criterion: «Серьёзных критериев нет. Так решили вы.» On a page
 * someone else reads, the automatic check and people.
 */
export function whoseText(st: Standing, who: Who = "you"): string {
  const person = PEOPLE[who];
  const checked = `${person} проверили ${st.decided}\u00a0из\u00a0${st.criteria}`;
  if (!st.serious)
    return st.proposed
      ? `Серьёзных критериев нет. Так считает ${MODEL[who]}, ${checked}.`
      : `Серьёзных критериев нет. Так решили ${person}.`;
  const head = `Серьёзные критерии — ${st.serious}\u00a0из\u00a0${st.criteria}.`;
  const them = st.serious === 1 ? "Его" : "Их";
  if (!st.yours) return `${head} ${them} отметила ${MODEL[who]}, ${checked}.`;
  return `${head} ${them} отметили ${person}.${st.proposed ? ` Всего ${checked}.` : ""}`;
}

/**
 * The criteria tab's one quiet line about severity, with its one action: while some criteria are the automatic
 * check's proposals, which are serious and how many the person checked, with «Подтвердить все»; while some has
 * neither, why or that nothing is marked yet, with «Отметить снова» or «Отметить автоматически». Null once a person
 * decided every criterion.
 */
export function hintOf(st: Standing): { text: string; action: "confirm" | "propose" | "again" } | null {
  if (st.proposed) return { text: whoseText(st), action: "confirm" };
  const pending = pendingOf(st);
  return pending && { text: pending.text, action: pending.again ? "again" : "propose" };
}

/**
 * The serious count of a check's result: the checked conversations with a serious error, its serious criteria
 * (`marked`), and the conversations where they could be checked (`checked`) — elsewhere they did not apply or could not
 * be checked. `yours`: a person decided every one of them; `pending`: the criteria of the result with neither a
 * decision nor a proposal yet.
 */
export type Serious = Counts & { marked: number; checked: number; yours: boolean; pending: number };

/**
 * The serious count of the result in a record of problems, or null: while none of its criteria is serious (the service
 * gives `withSerious` once one is; decisions on criteria the result no longer has count nothing), and when no
 * conversation could be checked. The denominator is the check's own.
 */
export function seriousOf(data: Problems | null | undefined): Serious | null {
  const log = data?.log;
  if (!data || !log || log.withSerious === undefined || !log.assessed) return null;
  const rules = data.rules.filter(ofResult);
  const serious = rules.filter((r) => r.serious);
  if (!serious.length) return null;
  return {
    failed: log.withSerious,
    measured: log.assessed,
    marked: serious.length,
    checked: log.seriousChecked ?? log.assessed,
    yours: serious.every((r) => r.severity.by === "person"),
    pending: rules.filter((r) => !r.severity.by).length,
  };
}

/**
 * Where the serious criteria could be checked, when not in every checked conversation: «Эти критерии удалось
 * проверить в 16 разговорах из 53.», or «Этот критерий не удалось проверить ни в одном разговоре.» A share of all
 * conversations says little when the criteria seldom applied, and this says how seldom.
 */
function whereText(s: Serious): string | null {
  if (s.checked >= s.measured) return null;
  const these = s.marked === 1 ? "Этот критерий" : "Эти критерии";
  if (!s.checked) return `${these} не удалось проверить ни в одном разговоре.`;
  return `${these} удалось проверить в\u00a0${s.checked}\u00a0${plural(s.checked, "разговоре", "разговорах", "разговорах")} из\u00a0${s.measured}.`;
}

/**
 * One line about serious errors under a check's number: the count, «С серьёзными ошибками — 6 из 53 (11%).», which a
 * screen sets apart and opens; or a sentence, with the action a screen puts after it — «Проверить» the proposals,
 * «Отметить автоматически» or «Отметить снова».
 */
export type SeverityLine =
  | { kind: "count"; head: string; share: string }
  | { kind: "text"; text: string; action?: "check" | "propose" | "again" };

/**
 * What a check says about serious errors, line by line. Once a criterion is
 * serious: the count of the same checked conversations; which criteria are serious and whose decision it is; where
 * they could be checked, when not everywhere; what is not decided yet. With none serious: whose decision that is. While
 * nothing is marked: that, or why it failed. A page someone else reads (`people`) says nothing until something is
 * marked. Never instead of the check's number and never added to it.
 */
export function severityLines(st: Standing, serious: Serious | null, who: Who = "you"): SeverityLine[] {
  const pending = pendingOf(st);
  const again = pending?.again ? ("again" as const) : ("propose" as const);
  const whose: SeverityLine = { kind: "text", text: whoseText(st, who), action: st.proposed ? "check" : undefined };
  if (serious) {
    const where = whereText(serious);
    const lines: SeverityLine[] = [{ kind: "count", head: "С серьёзными ошибками", share: shareText(serious) }, whose];
    if (where) lines.push({ kind: "text", text: where });
    if (pending)
      lines.push({
        kind: "text",
        text: `Ещё не решено по\u00a0${count(st.pending, "критерию", "критериям", "критериям")}.`,
        action: again,
      });
    return lines;
  }
  // Serious criteria the service has not counted yet: the lines come with their count a moment later.
  if (st.serious) return [];
  if (pending) return who === "you" ? [{ kind: "text", text: pending.text, action: again }] : [];
  return [whose];
}

/** A line as text, for a letter: «С серьёзными ошибками — 6 из 53 (11%).» */
export const lineText = (line: SeverityLine) => (line.kind === "count" ? `${line.head} — ${line.share}.` : line.text);

/**
 * What a page for someone else (a report, a letter) says about serious errors, one line under another (severityLines,
 * for people). Null while nothing is marked, and before any conversation was checked.
 */
export function severityText(data: Problems): string | null {
  const st = standingOf(data);
  if (!st || !data.log?.assessed) return null;
  return severityLines(st, seriousOf(data), "people").map(lineText).join("\n") || null;
}

/**
 * After any decision or proposal: the state (its stamp asks for the problems again), the problems and «было →
 * стало».
 */
function useRefreshSeverity() {
  const client = useQueryClient();
  const { refresh } = useLabState();
  return () => {
    void client.invalidateQueries({ queryKey: ["problems"] });
    void client.invalidateQueries({ queryKey: ["compare"] });
    return refresh();
  };
}

/**
 * Some decision on severity is on its way to the service: a switch, «Подтвердить» and «Подтвердить все» take no other
 * press meanwhile, so two decisions never race; nothing is disabled, so the keyboard keeps its place.
 */
export const useSeverityBusy = () => useIsMutating({ mutationKey: ["severity"] }) > 0;

/** The record with some criteria decided by a person, as the screen shows it at once; the service saves it. */
const decided = (data: Problems, which: (r: RuleEntry) => boolean, serious: (r: RuleEntry) => boolean): Problems => ({
  ...data,
  rules: data.rules.map((r) =>
    which(r) ? { ...r, serious: serious(r), severity: { ...r.severity, by: "person" as const } } : r,
  ),
});

/**
 * A person decides whether one criterion's errors are serious (POST /api/severity): its switch, or «Подтвердить» of a
 * proposal. The switch, the order, the tags and whose decision it is change at once; the state, the problems and
 * «было → стало» are asked again after it, and a refused decision is taken back with them.
 */
export function useSeverity() {
  const client = useQueryClient();
  const toast = useToast();
  const after = useRefreshSeverity();
  return useMutation({
    mutationKey: ["severity", "decide"],
    mutationFn: ({ check, rule, serious }: Mark) => api("/api/severity", { check, rule, serious }),
    onMutate: ({ check, rule, serious }) => {
      client.setQueriesData<Problems>({ queryKey: ["problems"] }, (old) =>
        old && old.check === check
          ? decided(
              old,
              (r) => r.id === rule,
              () => serious,
            )
          : old,
      );
    },
    onError: (e) => toast.error(e),
    onSettled: after,
  });
}

/**
 * «Подтвердить все»: every proposal of the automatic check for the check's result becomes the person's own decision
 * (POST /api/severity/confirm). The same criteria stay serious; whose decision it is changes, and every screen says so.
 */
export function useConfirmSeverity() {
  const client = useQueryClient();
  const toast = useToast();
  const after = useRefreshSeverity();
  return useMutation({
    mutationKey: ["severity", "confirm"],
    mutationFn: (check: Check) => api("/api/severity/confirm", { check }),
    onMutate: (check) => {
      client.setQueriesData<Problems>({ queryKey: ["problems"] }, (old) =>
        old && old.check === check
          ? decided(
              old,
              (r) => ofResult(r) && r.severity.by === "model",
              (r) => r.serious,
            )
          : old,
      );
    },
    onSuccess: () => toast.notify("Отметки модели подтверждены"),
    onError: (e) => toast.error(e),
    onSettled: after,
  });
}

/**
 * The check a running or finished proposal is for, as its task says (backend severity.propose): only a proposal, its
 * own task or the end of a check, names a check in its progress.
 */
export const proposalCheck = (job: Job | undefined): Check | null => job?.progress.check ?? null;

/**
 * «Отметить автоматически» and «Отметить снова»: the automatic check proposes for the criteria of the check's
 * result that have neither a decision nor a proposal (POST /api/severity/propose). It is a task of the service
 * (`severity`), seen where every task is; its failure is the task's, and the record says why (`severity.error`).
 */
export function useProposeSeverity() {
  const toast = useToast();
  const after = useRefreshSeverity();
  return useMutation({
    mutationKey: ["severity", "propose"],
    mutationFn: (check: Check) => api("/api/severity/propose", { check }),
    onError: (e) => toast.error(e),
    onSettled: after,
  });
}
