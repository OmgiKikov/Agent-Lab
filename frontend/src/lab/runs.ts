import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { Card, LabRun, LabState } from "./types";

export const FROM_LOG = "Ошибка из лога";

/** A run with its conversations; fetched again whenever the service reports that it changed. */
export function useRun(id: string | null | undefined, state: LabState | null) {
  const client = useQueryClient();
  const summary = state?.runs.find((r) => r.id === id);
  const stamp = `${summary?.status}|${summary?.finishedAt}|${JSON.stringify(summary?.metric ?? null)}`;
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

/** «Агент из исходников · 14704e1»: which agent played, and which version of it. */
export const runTitle = (run: LabRun) => [run.targetName, run.version].filter(Boolean).join(" · ");

export const isRunning = (run: LabRun) => run.status === "running";

/** The scenarios a new run may play: all, the ones built from errors in the logs, or chosen by hand. */
export type Pick = "all" | "errors" | "chosen";
export const pickOf = (cards: Card[], pick: Pick, chosen: Set<string>) =>
  pick === "all"
    ? cards
    : pick === "errors"
      ? cards.filter((c) => c.origin === FROM_LOG)
      : cards.filter((c) => chosen.has(c.id));
