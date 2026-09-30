import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLabState } from "../shell/LabProvider";
import type { Turn } from "../ui/Conversation";
import { useToast } from "../ui/toast";
import { api } from "./api";
import type { LabRun, LabState } from "./types";

/** The service's record of rules and problems (lab/problems.py; spec, section 8). */
export type Decision = "agree" | "disagree";
export type Scope = "rule" | "dialogue";
export type Example = {
  source: "log" | "sim"; dialogueId?: string; runId?: string; index?: number; ruleId: string;
  status: "FAIL" | "PASS" | "UNKNOWN"; traceId?: string | null; opening: string; topic: string;
  name?: string; persona?: string; attempt?: number;
  agentQuote: string; reason: string;
  second: Decision | null; secondScope: Scope | null; review: Decision | null; reviewScope: Scope | null;
};
export type Side = { failed: number; passed: number; unknown: number; examples: Example[] };
export type RuleEntry = {
  id: string; title: string;
  rule: { text: string; quote: string; sourceId: string | null; origin: string; kind: string; condition: string; acceptable: string };
  topics: string[]; log: Side; sim: Side;
  secondJudge: { checked: number; agree: number; byDialogue: number };
  human: { agree: number; disagree: number };
  scenarioIds: string[];
};
export type Problems = {
  log: { sampled: number; assessed: number; withViolations: number; unassessed: number; finishedAt: string | null; rulesSince: string | null } | null;
  sim: { runId: string; target: string; version: string; dialogs: number; withViolations: number; finishedAt: string | null } | null;
  rules: RuleEntry[];
  problems: string[];
};
export type LogDialogue = { id: string; messages: Turn[]; result: { status: string; topic: string } | null };
export type SourceText = { id: string; kind: string; origin: string; sha256?: string; content: string };

/** What makes the problems out of date: a new assessment, a run that started or finished, a task that ended. */
export function problemsStamp(state: LabState | null): string {
  if (!state) return "";
  const runs = state.runs.map(r => `${r.id}:${r.status}:${r.finishedAt ?? ""}`).join(",");
  return `${state.discover?.finishedAt ?? ""}|${runs}|${state.job.running}`;
}

export function useProblems(runId: string | null) {
  const { state } = useLabState();
  return useQuery({
    queryKey: ["problems", runId ?? "latest", problemsStamp(state)],
    queryFn: () => api<Problems>(`/api/problems${runId ? `?run=${encodeURIComponent(runId)}` : ""}`),
    enabled: !!state,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
}

const sameVerdict = (a: Example, b: Example) =>
  a.source === b.source && a.ruleId === b.ruleId
  && (a.source === "log" ? a.dialogueId === b.dialogueId : a.runId === b.runId && a.index === b.index);

function withDecision(data: Problems, target: Example, decision: Decision | null): Problems {
  const side = target.source;
  const patch = (e: Example): Example => (sameVerdict(e, target) ? { ...e, review: decision, reviewScope: decision ? "rule" : null } : e);
  return { ...data, rules: data.rules.map(r => ({ ...r, [side]: { ...r[side], examples: r[side].examples.map(patch) } })) };
}

/** «Верно / неверно» on one verdict: shown at once, saved by the service, the counts refreshed after. */
export function useReview() {
  const client = useQueryClient();
  const toast = useToast();
  const { refresh } = useLabState();
  return useMutation({
    mutationFn: ({ example, decision }: { example: Example; decision: Decision | null }) => api("/api/review", example.source === "log"
      ? { source: "log", dialogueId: example.dialogueId, ruleId: example.ruleId, decision }
      : { source: "sim", run: example.runId, index: example.index, ruleId: example.ruleId, decision }),
    onMutate: ({ example, decision }) => {
      client.setQueriesData<Problems>({ queryKey: ["problems"] }, old => (old ? withDecision(old, example, decision) : old));
    },
    onError: e => toast.error(e),
    onSettled: () => {
      client.invalidateQueries({ queryKey: ["problems"] });
      client.invalidateQueries({ queryKey: ["run"] });
      refresh();
    },
  });
}

/** The whole conversation of an example: a logged one from the logs, a simulated one from its run. */
export function useTurns(example?: Example): { turns?: Turn[]; loading: boolean; error: unknown } {
  const log = useQuery({
    queryKey: ["dialogue", example?.dialogueId],
    queryFn: () => api<LogDialogue>(`/api/dialogues/${encodeURIComponent(example!.dialogueId!)}`),
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
  if (example.source === "log") return { turns: log.data?.messages, loading: log.isLoading, error: log.error };
  const item = run.data?.items?.[example.index ?? -1];
  const turns = item?.conversation.map(m => ({ role: m.role, text: m.text, events: m.events, ok: m.ok, status: m.status, seconds: m.seconds }));
  return { turns, loading: run.isLoading, error: run.error };
}

export function useSource(id: string | null | undefined) {
  return useQuery({
    queryKey: ["source", id],
    queryFn: () => api<SourceText>(`/api/sources/${encodeURIComponent(id!)}`),
    enabled: !!id,
    staleTime: Infinity,
  });
}
