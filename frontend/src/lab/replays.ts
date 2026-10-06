import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { resultOf } from "./checks";
import type { Change, Check, LabState, Replay, ReplayItem, ReplaySummary, Turn } from "./types";

/** The checks of the live agent of one check, the newest first. */
export const replaysOf = (state: LabState | null, check: Check): ReplaySummary[] =>
  (state?.replays ?? []).filter((r) => r.check === check);

/** The newest check of the live agent of one check, finished or not. */
export const latestReplay = (state: LabState | null, check: Check) => replaysOf(state, check)[0] ?? null;

/**
 * The finished check of the live agent on the check's current result: what the screens set beside that result. One made
 * on an earlier result met other customers, or the same ones judged by other criteria.
 */
export function replayOnResult(state: LabState | null, check: Check): ReplaySummary | null {
  const result = resultOf(state, check);
  if (!result?.checkId) return null;
  return replaysOf(state, check).find((r) => r.basis.checkId === result.checkId && r.status !== "running") ?? null;
}

/** A check of the live agent with its conversations, asked again whenever it changes (its revision). */
export function useReplay(id: string | null, revision?: number) {
  return useQuery({
    queryKey: ["replay", id, revision ?? 0],
    queryFn: () => api<Replay>(`/api/replays/${encodeURIComponent(id ?? "")}`),
    enabled: !!id,
    placeholderData: (previous) => (previous?.id === id ? previous : undefined),
  });
}

export const startReplay = (check: Check, target: string, count: number) =>
  api<{ task: string }>("/api/replays", { check, target, count });

/** What a pair says, in words: how the agent did with this customer now, beside the recording. */
export const CHANGE_WORD: Record<Change, string> = {
  fixed: "стало лучше",
  broken: "стало хуже",
  failing: "ошибка осталась",
  passing: "без ошибки и тогда, и сейчас",
  unmeasured: "не удалось сравнить",
  running: "играется",
};

/** What a pair says, by the verdicts before and now (backend: domain/replay.py, change). */
export function changeOf(item: ReplayItem): Change {
  if (item.status === "RUNNING") return "running";
  const before = item.before.status;
  const now = item.status;
  if (before === "FAIL" && now === "PASS") return "fixed";
  if (before === "PASS" && now === "FAIL") return "broken";
  if (before === "FAIL" && now === "FAIL") return "failing";
  if (before === "PASS" && now === "PASS") return "passing";
  return "unmeasured";
}

/** The recorded conversation as the screens show a conversation. */
export const recordedTurns = (item: ReplayItem): Turn[] =>
  item.recorded.map((m) => ({ role: m.role === "user" ? "customer" : "agent", text: m.content }));

/** What may be read into the difference, as the result says it of two checks (lab/compare, VERDICT). */
export function verdictText(r: ReplaySummary): string | null {
  const s = r.summary;
  if (!s.pairs) return null;
  if (!s.comparable) return "Записи оценивали другие модели или инструкции, поэтому вывода о разнице нет.";
  if (s.verdict === "few") return "Мало разговоров, чтобы судить о разнице.";
  if (s.verdict === "same") return "Разговоров с ошибкой столько же, сколько в записях.";
  if (s.verdict === "beyond-chance")
    return s.direction === "fewer"
      ? "Ошибок заметно меньше: разница больше случайных колебаний."
      : "Ошибок заметно больше: разница больше случайных колебаний.";
  if (s.verdict === "within-chance") return "Разница в пределах случайных колебаний.";
  return null;
}
