import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { LabRun, LabState } from "./types";

/** The service is polled: often while a job runs, rarely otherwise. */
export function useLab() {
  const [state, setState] = useState<LabState | null>(null);
  const [offline, setOffline] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<LabRun | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api<LabState>("/api/state");
      setState(next);
      setOffline(false);
      const active = next.job.running && next.job.kind === "run" ? next.job.progress.run : null;
      const id = active ?? runId ?? next.runs[0]?.id ?? null;
      if (active && active !== runId) setRunId(active);
      if (id) setRun(await api<LabRun>(`/api/runs/${id}`));
    } catch {
      setOffline(true);
    }
  }, [runId]);

  const running = state?.job.running;
  useEffect(() => {
    let timer: number;
    let alive = true;
    const loop = async () => {
      await refresh();
      if (alive) timer = window.setTimeout(loop, running ? 1200 : 4000);
    };
    loop();
    return () => { alive = false; clearTimeout(timer); };
  }, [refresh, running]);

  const pickRun = useCallback((id: string) => {
    setRunId(id);
    api<LabRun>(`/api/runs/${id}`).then(setRun).catch(() => {});
  }, []);

  return { state, offline, run, pickRun };
}

const finishedRuns = new Map<string, LabRun>();

/**
 * Full data (conversations included) of the given finished runs, fetched once and kept.
 * Pass only the runs a screen needs. The key includes the finish time and the score,
 * so a re-judged run is fetched again.
 */
export function useRunDetails(runs: LabRun[]) {
  const [, bump] = useState(0);
  const keyOf = (r: LabRun) => `${r.id}|${r.finishedAt}|${r.metric?.accuracy}`;
  const wanted = runs.filter(r => r.status !== "running");
  const signature = wanted.map(keyOf).join(",");
  useEffect(() => {
    let alive = true;
    for (const r of wanted) {
      if (finishedRuns.has(keyOf(r))) continue;
      api<LabRun>(`/api/runs/${r.id}`).then(full => {
        finishedRuns.set(keyOf(r), full);
        if (alive) bump(n => n + 1);
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  return (r: LabRun | null | undefined) => (r ? finishedRuns.get(keyOf(r)) ?? null : null);
}
