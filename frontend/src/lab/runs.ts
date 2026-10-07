import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { Card, LabRun, LabState } from "./types";

/**
 * A run with its conversations; fetched again whenever the service reports that it changed. Its revision grows with
 * every change, so a run judged again with the same totals is fetched again too: other verdicts, reasons and quotes.
 * The answers people give are kept apart from the run: any answer, also one given in another tab or browser, changes
 * the stamp of answers (reviewsStamp).
 */
export function useRun(id: string | null | undefined, state: LabState | null) {
  const client = useQueryClient();
  const summary = state?.runs.find((r) => r.id === id);
  const stamp = [
    summary?.status,
    summary?.finishedAt,
    summary?.revision,
    summary?.updatedAt,
    JSON.stringify(summary?.metric ?? null),
    state?.reviewsStamp,
  ].join("|");
  const seen = useRef(stamp);
  useEffect(() => {
    if (!id || seen.current === stamp) return;
    seen.current = stamp;
    client.invalidateQueries({ queryKey: ["run", id] });
  }, [id, stamp, client]);
  return useQuery({
    queryKey: ["run", id],
    queryFn: () => api<LabRun>(`/api/runs/${encodeURIComponent(id!)}`),
    enabled: !!id,
    staleTime: 60_000,
  });
}

/** «Запуск из кода · версия 14704e1»: which way reached the agent, and which version of it. */
export const runTitle = (run: LabRun) =>
  [run.targetName, run.version ? `версия ${run.version}` : ""].filter(Boolean).join(" · ");

export const isRunning = (run: LabRun) => run.status === "running";

/** The scenarios a new run may play: all, one set, or chosen by hand. */
export type Pick = "all" | "representative" | "stress" | "chosen";
export const pickOf = (cards: Card[], pick: Pick, chosen: Set<string>) =>
  pick === "all"
    ? cards
    : pick === "chosen"
      ? cards.filter((c) => chosen.has(c.id))
      : cards.filter((c) => c.sets?.includes(pick));
