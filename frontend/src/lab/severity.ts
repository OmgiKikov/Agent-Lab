import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../ui/toast";
import { api } from "./api";
import { count } from "./format";
import { shareText, type Counts } from "./history";
import { useLabState } from "./LabProvider";
import { importantByPerson, type Problems, type RuleEntry } from "./problems";
import type { Check, Job } from "./types";

/**
 * Serious and minor errors. After each check the automatic check proposes, for
 * every criterion of the result, whether its errors are serious, with a reason; a person confirms or changes it — in
 * the criteria, on the problem's page, or all at once («Подтвердить все») — and a person's decision always wins: no new
 * proposal changes it. Without either an error is minor. Both live in the service by the criterion's key (the
 * problem's id), apart from the criteria: they change neither what is checked nor how. The problems a person marked
 * serious come first everywhere and carry «важный»; a proposal no person checked yet carries a quieter tag of its own
 * and moves nothing. The conversations with a serious error, by the proposals too, are counted beside the check's
 * number — never instead of it, never added to it; every screen says whose decision it is.
 */
export type Mark = { check: Check; rule: string; serious: boolean };

/** What the service says while the automatic check proposes (backend/lab/flows/severity.py), and the name of its task. */
export const PROPOSING = "Отмечаем важные критерии";

/** The person reading («вы») or, on a page someone else reads (the summary, a report, a letter), people («люди»). */
type Who = "you" | "people";

const PEOPLE: Record<Who, string> = { you: "вы", people: "люди" };

/** A criterion as its severity stands: whether its errors are serious, and whose decision that is. */
type Graded = Pick<RuleEntry, "serious" | "severity">;

/**
 * The criteria a person marked serious first; otherwise the order stays as it was (a stable sort keeps it). The
 * automatic check's proposal moves nothing: the most frequent problems lead until a person decides.
 */
export const seriousFirst = (a: Graded, b: Graded) => Number(importantByPerson(b)) - Number(importantByPerson(a));

/**
 * The word beside a serious criterion: «важный» by a person's decision, «важный по мнению модели» while it is the
 * automatic check's proposal no person checked yet; null for an ordinary one.
 */
export const importantWord = (r: Graded) =>
  !r.serious ? null : importantByPerson(r) ? "важный" : "важный по мнению модели";

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
    ? { text: `Не удалось отметить важные критерии. ${sentence(st.error)}`, again: true }
    : { text: "Важные критерии ещё не отмечены.", again: false };
}

/**
 * Which criteria are important and whose decision it is, in one line clear on its own: «Важных критериев 2 из 8, их
 * отметили вы.»; while the count rests on proposals of the model, «Важных критериев 2 из 8 — с учётом предложений
 * модели, которые вы ещё не подтвердили.» With none important: «Важных критериев нет, так решили вы.», or the model's
 * word for it, with how many criteria the person decided. The person reading, where the rest of the proposals waits
 * for «Подтвердить все»; on a page someone else reads, people, and nothing of what waits.
 */
export function whoseText(st: Standing, who: Who = "you"): string {
  const person = PEOPLE[who];
  if (!st.serious) {
    if (!st.proposed) return `Важных критериев нет, так решили ${person}.`;
    if (!st.decided) return `Важных критериев нет: так считает модель, ${person} это ещё не подтвердили.`;
    return `Важных критериев нет. По\u00a0${count(st.decided, "критерию", "критериям", "критериям")} из\u00a0${st.criteria} так решили ${person}, по\u00a0${st.proposed} так считает модель.`;
  }
  const head = `Важных критериев ${st.serious}\u00a0из\u00a0${st.criteria}`;
  if (!st.yours) return `${head} — с учётом предложений модели, которые ${person} ещё не подтвердили.`;
  const waiting =
    who === "you" && st.proposed
      ? ` Ещё ${count(st.proposed, "критерий", "критерия", "критериев")} модель предлагает считать обычными.`
      : "";
  return `${head}, ${st.serious === 1 ? "его" : "их"} отметили ${person}.${waiting}`;
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
 * be checked. `yours`: a person decided every one of them; `proposed`: how many of them are the automatic check's
 * proposals no person checked yet; `pending`: the criteria of the result with neither a decision nor a proposal yet.
 */
export type Serious = Counts & { marked: number; checked: number; yours: boolean; proposed: number; pending: number };

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
  const proposed = serious.filter((r) => !importantByPerson(r)).length;
  return {
    failed: log.withSerious,
    measured: log.assessed,
    marked: serious.length,
    checked: log.seriousChecked ?? log.assessed,
    yours: !proposed,
    proposed,
    pending: rules.filter((r) => !r.severity.by).length,
  };
}

/**
 * Where the important criteria apply, when not in every checked conversation: «Важные критерии применимы в 16 из 53
 * проверенных разговоров.», or «Важный критерий не применим ни в одном проверенном разговоре.» A share of all
 * conversations says little when the criteria seldom apply, and this says how seldom.
 */
export function whereText(s: Serious): string | null {
  if (s.checked >= s.measured) return null;
  const one = s.marked === 1;
  if (!s.checked)
    return `${one ? "Важный критерий не применим" : "Важные критерии не применимы"} ни в одном проверенном разговоре.`;
  return `${one ? "Важный критерий применим" : "Важные критерии применимы"} в\u00a0${s.checked}\u00a0из\u00a0${count(s.measured, "проверенного разговора", "проверенных разговоров", "проверенных разговоров")}.`;
}

/**
 * One line about serious errors under a check's number: the count, «С нарушением важных критериев — 6 из 53 (11%).», which a
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
    const lines: SeverityLine[] = [
      { kind: "count", head: "С нарушением важных критериев", share: shareText(serious) },
      whose,
    ];
    if (where) lines.push({ kind: "text", text: where });
    if (pending)
      lines.push({
        kind: "text",
        text: `Ещё по\u00a0${count(st.pending, "критерию", "критериям", "критериям")} не решено, важные ли они.`,
        action: again,
      });
    return lines;
  }
  // Serious criteria the service has not counted yet: the lines come with their count a moment later.
  if (st.serious) return [];
  if (pending) return who === "you" ? [{ kind: "text", text: pending.text, action: again }] : [];
  return [whose];
}

/** A line as text, for a letter: «С нарушением важных критериев — 6 из 53 (11%).» */
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
