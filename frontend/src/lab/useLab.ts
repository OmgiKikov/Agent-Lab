import { useEffect, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { get } from "./api";
import type { LabRun, LabState } from "./types";

// A new revision means the verdicts or human reviews changed, even at the same accuracy.
function runQuery(run: LabRun | undefined) {
  return {
    queryKey: ["lab", "run", run?.id, run?.revision ?? run?.updatedAt],
    queryFn: ({ signal }: { signal: AbortSignal }) => get<LabRun>(`/api/runs/${encodeURIComponent(run!.id)}`, signal),
    enabled: !!run,
    placeholderData: (previous: LabRun | undefined) => previous?.id === run?.id ? previous : undefined,
  };
}

/** One query owns each server snapshot; selecting another run cannot overwrite it. */
export function useLab() {
  const [selectedId, pickRun] = useState<string | null>(null);
  const stateQuery = useQuery({
    queryKey: ["lab", "state"],
    queryFn: ({ signal }) => get<LabState>("/api/state", signal),
    refetchInterval: query => query.state.data?.job.running ? 1200 : 4000,
  });
  const state = stateQuery.data ?? null;
  const active = state?.job.running && state.job.kind === "run" ? state.job.progress.run : undefined;
  useEffect(() => { if (active) pickRun(active); }, [active]);
  const summary = state?.runs.find(r => r.id === (active ?? selectedId)) ?? state?.runs[0];
  const run = useQuery({
    ...runQuery(summary),
    refetchInterval: summary?.status === "running" ? 1200 : false,
  });
  return {
    state, offline: stateQuery.isError, run: run.data ?? null, pickRun,
    runError: run.error, retryRun: run.refetch,
    runLoading: !!summary && run.isPending, runSummary: summary ?? null,
    refresh: stateQuery.refetch,
  };
}

/** Full conversations share the same query cache as the selected run. */
export function useRunDetails(runs: LabRun[]) {
  const wanted = [...new Map(runs.filter(r => r.status !== "running").map(r => [r.id, r])).values()];
  const queries = useQueries({ queries: wanted.map(runQuery) });
  const details = new Map(wanted.map((r, i) => [r.id, queries[i].data]));
  return {
    details: (run: LabRun | null | undefined) => run ? details.get(run.id) ?? null : null,
    error: queries.find(q => q.isError)?.error,
    retry: () => { for (const query of queries) if (query.isError) void query.refetch(); },
  };
}
