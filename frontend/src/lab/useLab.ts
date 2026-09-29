import { useCallback, useEffect } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { get } from "./api";
import type { LabRun, LabState } from "./types";

// A new revision means the verdicts or human reviews changed, even at the same accuracy.
function runQuery(run: LabRun | undefined, id = run?.id) {
  return {
    queryKey: ["lab", "run", id, run?.revision ?? run?.updatedAt],
    queryFn: ({ signal }: { signal: AbortSignal }) => get<LabRun>(`/api/runs/${encodeURIComponent(id!)}`, signal),
    enabled: !!id,
    placeholderData: (previous: LabRun | undefined) => (previous?.id === id ? previous : undefined),
  };
}

/** The URL owns the selected run, including a missing run's 404. */
export function useLab() {
  const [search, setSearch] = useSearchParams();
  const selectedId = search.get("run") || null;
  const pickRun = useCallback(
    (id: string | null, replace = false) => {
      setSearch(
        (current) => {
          const next = new URLSearchParams(current);
          if (id) next.set("run", id);
          else next.delete("run");
          return next;
        },
        { replace },
      );
    },
    [setSearch],
  );
  const stateQuery = useQuery({
    queryKey: ["lab", "state"],
    queryFn: ({ signal }) => get<LabState>("/api/state", signal),
    refetchInterval: (query) => (query.state.data?.job.running ? 1200 : 4000),
  });
  const state = stateQuery.data ?? null;
  const active = state?.job.running && state.job.kind === "run" ? state.job.progress.run : undefined;
  useEffect(() => {
    if (active && !selectedId) pickRun(active, true);
  }, [active, selectedId, pickRun]);
  const runId = selectedId ?? active ?? state?.runs[0]?.id;
  const summary = state?.runs.find((r) => r.id === runId);
  const run = useQuery({
    ...runQuery(summary, runId),
    refetchInterval: summary?.status === "running" ? 1200 : false,
  });
  return {
    state,
    offline: stateQuery.isError,
    run: run.data ?? null,
    runId,
    pickRun,
    runError: run.error,
    retryRun: run.refetch,
    runLoading: !!runId && run.isPending,
    runSummary: summary ?? null,
    refresh: stateQuery.refetch,
  };
}

/** Full conversations share the same query cache as the selected run. */
export function useRunDetails(runs: LabRun[]) {
  const wanted = [...new Map(runs.filter((r) => r.status !== "running").map((r) => [r.id, r])).values()];
  const queries = useQueries({ queries: wanted.map((run) => runQuery(run)) });
  const details = new Map(wanted.map((r, i) => [r.id, queries[i].data]));
  return {
    details: (run: LabRun | null | undefined) => (run ? (details.get(run.id) ?? null) : null),
    error: queries.find((q) => q.isError)?.error,
    retry: () => {
      for (const query of queries) if (query.isError) void query.refetch();
    },
  };
}
