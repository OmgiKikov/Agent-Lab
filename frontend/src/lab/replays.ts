import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { resultOf } from "./checks";
import type { Change, Check, LabState, Replay, ReplayItem, ReplaySummary, Turn } from "./types";

/** The checks of the live agent of one check, the newest first. */
export const replaysOf = (state: LabState | null, check: Check): ReplaySummary[] =>
  (state?.replays ?? []).filter((r) => r.check === check);

/** The newest check of the live agent of one check, finished or not. */
export const latestReplay = (state: LabState | null, check: Check) => replaysOf(state, check)[0] ?? null;

/** The newest check of the live agent on the check's current result, finished or not: what «Агент сейчас» shows. */
export function latestOnResult(state: LabState | null, check: Check): ReplaySummary | null {
  const result = resultOf(state, check);
  if (!result?.checkId) return null;
  return replaysOf(state, check).find((r) => r.basis.checkId === result.checkId) ?? null;
}

/**
 * The check of the live agent that ran to its end on the check's current result: what the screens set beside that
 * result. One made on an earlier result met other customers, or the same ones judged by other criteria; a stopped or
 * failed one is no result to set beside it.
 */
export function replayOnResult(state: LabState | null, check: Check): ReplaySummary | null {
  const result = resultOf(state, check);
  if (!result?.checkId) return null;
  return replaysOf(state, check).find((r) => r.basis.checkId === result.checkId && r.status === "done") ?? null;
}

/**
 * A check of the live agent with its conversations, fetched again whenever the service says it changed (its revision):
 * one entry per check, so a check that changes every few seconds never piles copies of itself up in the browser.
 */
export function useReplay(id: string | null, revision?: number) {
  const client = useQueryClient();
  const seen = useRef(revision);
  useEffect(() => {
    if (!id || seen.current === revision) return;
    seen.current = revision;
    void client.invalidateQueries({ queryKey: ["replay", id] });
  }, [id, revision, client]);
  return useQuery({
    queryKey: ["replay", id],
    queryFn: () => api<Replay>(`/api/replays/${encodeURIComponent(id ?? "")}`),
    enabled: !!id,
    staleTime: 60_000,
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

/** The recorded conversation as it was judged: up to as many replies of the agent as the conversation now had. */
export const recordedTurns = (item: ReplayItem): Turn[] =>
  item.recorded
    .slice(0, item.cut ?? item.recorded.length)
    .map((m) => ({ role: m.role === "user" ? "customer" : "agent", text: m.content }));

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
