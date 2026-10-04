import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { agentKey } from "../app/agent";
import { useToast } from "../ui/toast";
import { api } from "./api";
import { count, plural } from "./format";
import { shareText, type Counts } from "./history";
import { useLabState } from "./LabProvider";
import type { Problems, RuleEntry } from "./problems";
import type { Check } from "./types";

/**
 * Serious and minor errors (spec 2026-10-04-severity-design.md). After each check the automatic check proposes, for
 * every criterion of the result, whether its errors are serious, with a reason; a person confirms or changes it — in
 * the criteria, on the problem's page, or all at once («Подтвердить все») — and a person's decision always wins: no new
 * proposal changes it. Without either an error is minor. Both live in the service by the criterion's key (the
 * problem's id), apart from the criteria: they change neither what is checked nor how. Serious problems come first
 * everywhere, carry «серьёзная», and the conversations with a serious error are counted beside the check's number —
 * never instead of it, never added to it; every screen says whose decision it is (DESIGN.md, «Честность чисел», 4).
 */
export type Mark = { check: Check; rule: string; serious: boolean };

/** What the service says while the automatic check proposes (backend/lab/severity.py), and the name of its task. */
export const PROPOSING = "Предлагаю, какие ошибки серьёзные";

/** The person reading («вы») or, on a page someone else reads (the summary, a report, a letter), people («люди»). */
type Who = "you" | "people";

/** Serious first; otherwise the order stays as it was (a stable sort keeps it). */
export const seriousFirst = (a: { serious: boolean }, b: { serious: boolean }) => Number(b.serious) - Number(a.serious);

/**
 * A criterion of the check's result: the automatic check proposes for these, «Подтвердить все» confirms them, and the
 * serious count counts them. One only a run of the scenarios has (problems.from_run) is none of these.
 */
export const ofResult = (r: Pick<RuleEntry, "log">) => r.log.ruleIds.length > 0;

/** One full stop at the end: a reason or an error comes with it or without. */
const sentence = (text: string) => (/[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** A reason after a colon or a dash, from a small letter: «… — обвинение клиента вредит отношениям с банком». */
export const reasonText = (reason: string) => {
  const text = sentence(reason);
  return /^\p{Lu}\p{Ll}/u.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
};

/**
 * Where the severity of a check's criteria stands, among the criteria of its result (`criteria`, N): how many are
 * serious (S), the automatic check's proposals no person checked yet (P), decided by a person (D), with neither yet
 * (`pending`, N − P − D); and why the last proposal failed, while some criterion has neither.
 */
export type Standing = {
  criteria: number;
  serious: number;
  proposed: number;
  decided: number;
  pending: number;
  error: string | null;
};

/** The standing of a record's result, or null without a result (a run's own criteria are not proposed for). */
export function standingOf(data: Problems | null | undefined): Standing | null {
  const rules = data?.rules.filter(ofResult) ?? [];
  if (!data || !rules.length) return null;
  const proposed = rules.filter((r) => r.severity.by === "model").length;
  const decided = rules.filter((r) => r.severity.by === "person").length;
  const pending = rules.length - proposed - decided;
  return {
    criteria: rules.length,
    serious: rules.filter((r) => r.serious).length,
    proposed,
    decided,
    pending,
    error: pending ? data.severity.error : null,
  };
}

/**
 * While some criterion of the result has neither a decision nor a proposal: why the last proposal failed («Предложить
 * снова», `again`) or that it is not decided yet («Предложить автоматически»). Null when nothing waits for one.
 */
export function pendingOf(st: Standing): { text: string; again: boolean } | null {
  if (!st.pending) return null;
  return st.error
    ? { text: `Не удалось предложить, какие ошибки серьёзные: ${sentence(st.error)}`, again: true }
    : { text: "Какие ошибки серьёзные, ещё не решено.", again: false };
}

/**
 * The criteria tab's one quiet line about severity, with its one action: while some criteria are the automatic
 * check's proposals, how many of them are serious and how many the person checked — «Подтвердить все»; while some has
 * neither, why or that it is not decided yet — «Предложить снова» or «Предложить автоматически». Null once a person
 * decided every criterion.
 */
export function hintOf(st: Standing): { text: string; action: "confirm" | "propose" | "again" } | null {
  if (st.proposed)
    return {
      text: `Какие ошибки серьёзные, предложила автоматическая проверка: серьёзных — ${st.serious}\u00a0из\u00a0${st.criteria}. Вы проверили ${st.decided}\u00a0из\u00a0${st.criteria}; переключатель меняет решение.`,
      action: "confirm",
    };
  const pending = pendingOf(st);
  return pending && { text: pending.text, action: pending.again ? "again" : "propose" };
}

/**
 * Whose decision it is, while some criteria are the automatic check's proposals no person checked yet: «Какие
 * серьёзные, предложила автоматическая проверка; вы проверили 3 из 8 критериев.» — «люди проверили» on a page someone
 * else reads. Null once a person decided every proposal.
 */
export function proposedText(st: Standing, who: Who = "you"): string | null {
  if (!st.proposed) return null;
  const criteria = count(st.criteria, "критерия", "критериев", "критериев");
  return `Какие серьёзные, предложила автоматическая проверка; ${who === "you" ? "вы" : "люди"} проверили ${st.decided}\u00a0из\u00a0${criteria}.`;
}

/** No criterion of the result is serious, and none waits for a decision or a proposal. */
export const NONE_SERIOUS = "Ни один критерий не считается серьёзным.";
export const noneSerious = (st: Standing | null) => !!st && !st.serious && !st.pending;

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
 * разговоре.» Whose decision it is: «вы отметили» («люди отметили» on a page someone else reads) only when a person
 * decided every serious criterion; otherwise «которые считаются серьёзными» — some are the automatic check's proposals.
 * While some criterion has neither a decision nor a proposal: «…; ещё не решено по 3 критериям». In three parts, as the
 * line of answers, so a screen can set the count apart and open its conversations.
 */
export function seriousSentence(s: Serious, who: Who = "you") {
  const criteria = plural(s.marked, "критерию, который", "критериям, которые", "критериям, которые");
  const serious = plural(s.marked, "серьёзным", "серьёзными", "серьёзными");
  const whose = s.yours
    ? `${who === "you" ? "вы" : "люди"} отметили ${serious}`
    : `${plural(s.marked, "считается", "считаются", "считаются")} ${serious}`;
  const open = s.pending ? `; ещё не решено по\u00a0${count(s.pending, "критерию", "критериям", "критериям")}` : "";
  return {
    head: "С серьёзными ошибками",
    share: shareText(s),
    rest: `: по\u00a0${s.marked}\u00a0${criteria} ${whose}${whereChecked(s)}${open}.`,
  };
}

/** The same sentence as one line of text, for a letter. */
export const seriousText = (s: Serious, who: Who = "you") => {
  const x = seriousSentence(s, who);
  return `${x.head} — ${x.share}${x.rest}`;
};

/**
 * What a page for someone else (a report, a letter) says about serious errors in one paragraph: the serious count with
 * whose decision it is, or that no criterion is considered serious; then, while some criteria are the automatic check's
 * proposals, how many of them people checked. Null while some criterion is undecided and none is serious, and before
 * any conversation was checked.
 */
export function severityText(data: Problems): string | null {
  const st = standingOf(data);
  if (!st || !data.log?.assessed) return null;
  const serious = seriousOf(data);
  const head = serious ? seriousText(serious, "people") : noneSerious(st) ? NONE_SERIOUS : null;
  return head && [head, proposedText(st, "people")].filter(Boolean).join(" ");
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
    onSuccess: () => toast.notify("Предложения приняты: теперь это ваши решения"),
    onError: (e) => toast.error(e),
    onSettled: after,
  });
}

/** Where this tab keeps the check of its last proposal, per agent. */
const STARTED = agentKey("lab.severity.proposing");

/** The check whose proposal this tab started last: where its task leads (app/jobs). Storage may be unavailable. */
export function proposingCheck(): Check | null {
  try {
    const check = sessionStorage.getItem(STARTED);
    return check === "tone" || check === "code" ? check : null;
  } catch {
    return null;
  }
}

function rememberProposing(check: Check) {
  try {
    sessionStorage.setItem(STARTED, check);
  } catch {
    /* a private window or blocked storage: the task leads to «Обзор» */
  }
}

/**
 * «Предложить автоматически» and «Предложить снова»: the automatic check proposes for the criteria of the check's
 * result that have neither a decision nor a proposal (POST /api/severity/propose). It is a task of the service
 * (`severity`), seen where every task is; its failure is the task's, and the record says why (`severity.error`).
 */
export function useProposeSeverity() {
  const toast = useToast();
  const after = useRefreshSeverity();
  return useMutation({
    mutationKey: ["severity", "propose"],
    mutationFn: (check: Check) => api("/api/severity/propose", { check }),
    onMutate: rememberProposing,
    onError: (e) => toast.error(e),
    onSettled: after,
  });
}
