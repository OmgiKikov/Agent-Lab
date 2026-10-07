import { useQuery } from "@tanstack/react-query";
import { AGENT } from "../app/agent";
import { api } from "./api";
import type { Check, Metric, Message, Rule, Criterion } from "./types";

export type Mode = "dataset" | "questions" | "simulations";
export const MODE_NAME: Record<Mode, string> = {
  dataset: "Ответы в датасете",
  questions: "Вопросы живому агенту",
  simulations: "Симуляции клиента",
};
export type Outcome = {
  status: string;
  error?: string | null;
  checkId?: string;
  questionsId?: string;
  runId?: string;
  metric?: Metric;
};
export type Launch = {
  id: string;
  check: Check;
  status: string;
  error?: string;
  startedAt: string;
  agentVersion?: string;
  dataset?: { name?: string; file?: string; datasetId?: string };
  judge?: { id?: string; setId?: string; name: string; version: number } | null;
  modes: Partial<Record<Mode, Outcome>>;
};
export type Pair = {
  baseline?: { status: string; rules: Rule[] };
  comparable?: boolean;
  contextError?: string | null;
  knowledge?: { title: string; text: string; article: string }[];
  dialogueId: string;
  name: string;
  original: { role: "user" | "assistant"; content: string }[];
  conversation: Message[];
  status: string;
  criteria: Criterion[];
  rules: Rule[];
  error?: string | null;
};
export const useLaunch = (id?: string) =>
  useQuery({
    queryKey: ["launch", AGENT, id],
    queryFn: () => api<Launch>(`/api/launches/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.status === "running" || (!q.state.data && !q.state.error) ? 1500 : false),
  });
/**
 * The launches of a check, newest first. `stamp` changes when a task of the agent starts or ends, so the list is asked
 * again then; while one of them runs, it is asked every few seconds, and not at all when nothing runs.
 */
export const useLaunches = (check?: Check, stamp?: string) =>
  useQuery({
    queryKey: ["launches", AGENT, check, stamp],
    queryFn: () => api<{ launches: Launch[] }>(`/api/launches${check ? `?check=${check}` : ""}`),
    refetchInterval: (q) => (q.state.data?.launches.some((l) => l.status === "running") ? 4000 : false),
  });
export const useQuestions = (id?: string) =>
  useQuery({
    queryKey: ["questions", AGENT, id],
    queryFn: () => api<{ id: string; status: string; version: string; items: Pair[] }>(`/api/questions/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 1500 : false),
  });
