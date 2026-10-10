import { useQuery } from "@tanstack/react-query";
import { AGENT } from "../app/agent";
import { api } from "./api";
import { inQuotes } from "./quote";
import type { Check, Metric, Message, Rule } from "./types";

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
  /** Some of the criteria of tone of voice, when a person chose them; the code's criteria read anew (Точность). */
  ruleIds?: string[] | null;
  replan?: boolean;
  modes: Partial<Record<Mode, Outcome>>;
  /** On its page: whether it was made of the dataset and the rules in force, so it can be started again as it was. */
  current?: boolean;
  /** On its page: whether starting it again goes on from where it stopped, with what it kept. */
  continuable?: boolean;
};
/** A recorded conversation asked again, as the list of a run shows it (api/launches.py, _line). */
export type PairLine = {
  dialogueId: string;
  name: string;
  /** How many questions of the customer were asked again. */
  asked: number;
  status: string;
  comparable?: boolean;
  /** How its recorded answers stood in the check of the dataset. */
  baseline?: { status: string } | null;
};
/** One recorded conversation asked again, whole: both sides and the verdicts on the new answers. */
export type Pair = PairLine & {
  contextError?: string | null;
  knowledge?: { title: string; text: string; article: string }[];
  original: { role: "user" | "assistant"; content: string }[];
  conversation: Message[];
  rules: Rule[];
  error?: string | null;
};
/**
 * Why a launch failed, in its own words: the reason its way gave, or with several ways the reason of each that failed,
 * by its name. The service ends a failed launch with one sentence for all its ways (backend/lab/flows/launches.py, run),
 * which says nothing of a single one. Null when no way says why.
 */
export function launchError(launch: Launch): string | null {
  const ways = Object.entries(launch.modes) as [Mode, Outcome][];
  const failed = ways.flatMap(([mode, outcome]) =>
    outcome.status === "failed" && outcome.error ? [{ mode, error: outcome.error }] : [],
  );
  if (!failed.length) return launch.error || null;
  if (ways.length === 1) return failed[0].error;
  return failed.map(({ mode, error }) => `${inQuotes(MODE_NAME[mode])}: ${error}`).join(" ");
}
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
/**
 * A run of recorded questions as its list: one light line a question, asked again every 1.5 s while the run goes; the
 * whole run would carry every conversation each time.
 */
export const useQuestions = (id?: string) =>
  useQuery({
    queryKey: ["questions", AGENT, id],
    queryFn: () =>
      api<{ id: string; status: string; version: string; items: PairLine[] }>(`/api/questions/${id}?brief=1`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 1500 : false),
  });
/** One question of a run, whole, while it is open; asked again while it is still being asked. */
export const useQuestion = (id: string, dialogueId: string | null) =>
  useQuery({
    queryKey: ["question", AGENT, id, dialogueId],
    queryFn: () => api<Pair>(`/api/questions/${id}/items/${encodeURIComponent(dialogueId ?? "")}`),
    enabled: !!dialogueId,
    refetchInterval: (q) => (q.state.data?.status === "RUNNING" ? 1500 : false),
  });
