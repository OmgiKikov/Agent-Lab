import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLabState } from "./LabProvider";
import { useToast } from "../ui/toast";
import { api } from "./api";
import { JOB_OF } from "./checks";
import type { Check, LabRun, LabState, Turn } from "./types";

/** The service's record of rules and problems (lab/problems.py; spec, section 8). */
export type Decision = "agree" | "disagree";
export type Scope = "rule" | "dialogue";
export type Example = {
  source: "log" | "sim";
  dialogueId?: string;
  runId?: string;
  index?: number;
  ruleId: string;
  status: "FAIL" | "PASS" | "UNKNOWN";
  opening: string;
  topic: string;
  name?: string;
  persona?: string;
  attempt?: number;
  agentQuote: string;
  reason: string;
  /** The check's short name for this violation; the problem's title is the most frequent one. */
  title?: string;
  second: Decision | null;
  secondScope: Scope | null;
  /** What the second check said on what it judged: this criterion, or the whole conversation. */
  secondStatus?: "PASS" | "FAIL" | null;
  review: Decision | null;
  reviewScope: Scope | null;
  /**
   * The check whose result (or whose run) the verdict belongs to. The service names it once for the whole record;
   * the page puts it on every example, so an answer goes to that check's result and its links stay in its section.
   */
  check?: Check;
};
/** One stage of a rule: its counts, its verdicts, and the ids the checks gave the rule in this stage. */
export type Side = { failed: number; passed: number; unknown: number; examples: Example[]; ruleIds: string[] };
/** What the automatic check proposed for a criterion: whether its errors are serious, and why. */
export type Proposal = { serious: boolean; reason: string };
/**
 * Whose decision a criterion's severity is (lab/severity): a person's (`person`), the automatic check's proposal no
 * person has checked yet (`model`), or nobody's yet (null: its errors are minor); and what the automatic check
 * proposed, kept also once a person decided.
 */
export type Severity = { by: "person" | "model" | null; proposed: Proposal | null };
export type RuleEntry = {
  id: string;
  title: string;
  /**
   * The criterion's errors are serious, by a person's decision, else by the automatic check's proposal: they come first
   * and are counted apart (lab/severity).
   */
  serious: boolean;
  severity: Severity;
  rule: {
    name?: string;
    text: string;
    quote: string;
    sourceId: string | null;
    origin: string;
    kind: string;
    condition: string;
    acceptable: string;
  };
  topics: string[];
  log: Side;
  sim: Side;
  secondJudge: { checked: number; agree: number; byDialogue: number };
  human: { agree: number; disagree: number };
  scenarioIds: string[];
};
export type Problems = {
  /** The check of the record: the one asked for, or the check of the run asked for. */
  check: Check;
  log: {
    sampled: number;
    assessed: number;
    withViolations: number;
    unassessed: number;
    finishedAt: string | null;
    rulesSince: string | null;
    /** The checked conversations with an error by a serious criterion; only once one is serious. */
    withSerious?: number;
    /** The checked conversations where a serious criterion could be checked: what `withSerious` rests on. */
    seriousChecked?: number;
  } | null;
  sim: {
    runId: string;
    target: string;
    version: string;
    dialogs: number;
    assessed: number;
    unassessed: number;
    withViolations: number;
    finishedAt: string | null;
  } | null;
  rules: RuleEntry[];
  problems: string[];
  /**
   * Among the criteria of the record: how many the automatic check proposed for and no person decided yet, how many a
   * person decided, and why the last proposal failed — only while a criterion has neither (lab/severity).
   */
  severity: { criteria: number; proposed: number; decided: number; error: string | null };
};
/** A logged conversation as the service keeps it (GET /api/logs/{id}). */
export type LogDialogue = { id: string; messages: { role: "user" | "assistant"; content: string }[] };
export type SourceText = { id: string; kind: string; origin: string; sha256?: string; content: string };

/**
 * What changes with any decision or proposal of severity (/api/state, severityStamp): it reorders the problems, changes
 * their count and says whose decision it is — a confirmation leaves the same criteria serious, yet it is a change. An
 * older service without the stamp: the serious criteria of both checks in a line.
 */
export const severityStamp = (state: LabState | null) =>
  state?.severityStamp ?? (state?.severity ? `${state.severity.tone.join(",")}|${state.severity.code.join(",")}` : "");

/**
 * What makes the problems out of date: a new result, a run that started or finished, new scenarios, a task that ended,
 * a decision or a proposal of whether a criterion's errors are serious.
 */
export function problemsStamp(state: LabState | null): string {
  if (!state) return "";
  const runs = state.runs.map((r) => `${r.id}:${r.status}:${r.finishedAt ?? ""}`).join(",");
  const sources = state.sources.map((s) => `${s.id}:${s.sha256 ?? ""}`).join(",");
  const results = `${state.checks.tone?.finishedAt ?? ""}|${state.checks.code?.finishedAt ?? ""}`;
  return `${state.logs.updatedAt ?? ""}|${results}|${state.cards?.createdAt ?? ""}|${sources}|${runs}|${state.job.running}|${severityStamp(state)}`;
}

/** Every example of the record with the check it belongs to (Example.check). */
function withCheck(data: Problems, asked: Check | null): Problems {
  const check = data.check ?? asked ?? undefined;
  const own = (e: Example): Example => ({ ...e, check });
  return {
    ...data,
    check: check as Check,
    rules: data.rules.map((r) => ({
      ...r,
      log: { ...r.log, examples: r.log.examples.map(own) },
      sim: { ...r.sim, examples: r.sim.examples.map(own) },
    })),
  };
}

/**
 * The rules and problems of a check: its result, and the last finished run of its scenarios. With a run, that run and
 * the result of the run's own check. Nothing is asked without one of them.
 */
export function useProblems(check: Check | null, runId: string | null = null, enabled = true) {
  const { state } = useLabState();
  const scope = runId ? `run=${encodeURIComponent(runId)}` : check ? `check=${check}` : null;
  return useQuery({
    queryKey: ["problems", scope, problemsStamp(state)],
    queryFn: () => api<Problems>(`/api/problems?${scope}`).then((data) => withCheck(data, runId ? null : check)),
    enabled: !!state && !!scope && enabled,
    // While the same record refreshes, the old one stays on screen; another check's or run's never stands in for it.
    placeholderData: (previous, query) => (query?.queryKey[1] === scope ? previous : undefined),
    staleTime: Infinity,
  });
}

const sameVerdict = (a: Example, b: Example) =>
  a.source === b.source &&
  a.check === b.check &&
  a.ruleId === b.ruleId &&
  (a.source === "log" ? a.dialogueId === b.dialogueId : a.runId === b.runId && a.index === b.index);

function withDecision(data: Problems, target: Example, decision: Decision | null): Problems {
  const side = target.source;
  const patch = (e: Example): Example =>
    sameVerdict(e, target) ? { ...e, review: decision, reviewScope: decision ? "rule" : null } : e;
  return {
    ...data,
    rules: data.rules.map((r) => ({ ...r, [side]: { ...r[side], examples: r[side].examples.map(patch) } })),
  };
}

/**
 * A person's answer on one verdict, as the screen shows it: the example with its status, and the logs' result it comes
 * from (`finishedAt`). The service refuses it when either has changed since, so it never lands on another check.
 */
export type Answer = { example: Example; decision: Decision | null; finishedAt: string | null | undefined };

/**
 * Why answers on a check's result wait, in one line, or null. While that check runs, its new result replaces the one
 * the person answers on, and the service refuses answers to it (backend/lab/api.py, review); the other check's
 * result takes answers as usual.
 */
export function answersWait(state: LabState | null, example: Pick<Example, "source" | "check">): string | null {
  if (example.source !== "log" || !state?.job.running) return null;
  const running = (Object.keys(JOB_OF) as Check[]).find((c) => JOB_OF[c] === state.job.kind);
  return running && (example.check ?? running) === running
    ? "Идёт проверка разговоров — ответить можно после неё."
    : null;
}

/**
 * «Верно / неверно» on one verdict: shown at once, saved by the service, the counts refreshed after. A refused answer
 * rejects its `mutateAsync`, so a screen that shows it at once takes it back.
 */
export function useReview() {
  const client = useQueryClient();
  const toast = useToast();
  const { refresh } = useLabState();
  return useMutation({
    mutationKey: ["review"],
    mutationFn: ({ example, decision, finishedAt }: Answer) =>
      api(
        "/api/review",
        example.source === "log"
          ? {
              source: "log",
              check: example.check,
              dialogueId: example.dialogueId,
              ruleId: example.ruleId,
              decision,
              finishedAt,
              status: example.status,
            }
          : {
              source: "sim",
              run: example.runId,
              index: example.index,
              ruleId: example.ruleId,
              decision,
              status: example.status,
            },
      ),
    onMutate: ({ example, decision }) => {
      client.setQueriesData<Problems>({ queryKey: ["problems"] }, (old) =>
        old ? withDecision(old, example, decision) : old,
      );
    },
    onError: (e) => toast.error(e),
    onSettled: () => {
      client.invalidateQueries({ queryKey: ["problems"] });
      client.invalidateQueries({ queryKey: ["run"] });
      client.invalidateQueries({ queryKey: ["history-snapshot"] });
      refresh();
    },
  });
}

/** The whole conversation of an example: a logged one from the logs, a simulated one from its run. */
export function useTurns(example?: Example): { turns?: Turn[]; loading: boolean; error: unknown } {
  const { state } = useLabState();
  const check = example?.check;
  const log = useQuery({
    queryKey: ["dialogue", example?.dialogueId, check, state?.logs.updatedAt],
    queryFn: () =>
      api<LogDialogue>(`/api/logs/${encodeURIComponent(example!.dialogueId!)}${check ? `?check=${check}` : ""}`),
    enabled: example?.source === "log",
    staleTime: Infinity,
  });
  const run = useQuery({
    queryKey: ["run", example?.runId],
    queryFn: () => api<LabRun>(`/api/runs/${encodeURIComponent(example!.runId!)}`),
    enabled: example?.source === "sim",
    staleTime: 60_000,
  });
  if (!example) return { loading: false, error: null };
  if (example.source === "log") {
    const turns = log.data?.messages.map((m): Turn => ({
      role: m.role === "user" ? "customer" : "agent",
      text: m.content,
    }));
    return { turns, loading: log.isLoading, error: log.error };
  }
  const item = run.data?.items?.[example.index ?? -1];
  const turns = item?.conversation.map((m) => ({
    role: m.role,
    text: m.text,
    events: m.events,
    ok: m.ok,
    status: m.status,
    seconds: m.seconds,
  }));
  return { turns, loading: run.isLoading, error: run.error };
}

export function useSource(id: string | null | undefined) {
  const { state } = useLabState();
  const revision = state?.sources.find((s) => s.id === id)?.sha256;
  return useQuery({
    queryKey: ["source", id, revision],
    queryFn: () => api<SourceText>(`/api/sources/${encodeURIComponent(id!)}`),
    enabled: !!id,
    staleTime: Infinity,
  });
}
