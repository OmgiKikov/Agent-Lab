import { useMemo } from "react";
import { compareCriteria, deriveCriteria, historyOf, logDialogs, measured, provenanceOf, simDialogs, summarize, type Dialog } from "./criteria";
import type { LabRun, LabState } from "./types";
import { useRunContext } from "./useRunContext";

export type SourceFilter = "all" | "log" | "sim";

/**
 * What the screens are about: one checked version of the agent and, next to it, the one checked before.
 * The service (lab/metric.py) counts a run's share of dialogues without violations and never compares versions:
 * the screens show both runs' numbers side by side and do not judge which version is better.
 * The real logs are a separate, unversioned line («в реальных диалогах»). Criteria are counted on both, the split kept per criterion.
 */
export function useScope(state: LabState | null, run: LabRun | null) {
  const ctx = useRunContext(state, run);
  const { finished, previous, previousItems, sameAgent, recent, details } = ctx;
  const provenance = useMemo(() => (state ? provenanceOf(state) : new Map()), [state]);
  const logs = useMemo(() => logDialogs(state?.discover ?? null), [state?.discover]);
  const sims = useMemo(() => simDialogs(finished?.items ?? []), [finished]);
  const prevSims = useMemo(() => simDialogs(previousItems ?? []), [previousItems]);
  const dialogs = useMemo(() => [...sims, ...logs], [logs, sims]);

  const comparing = !!previous && !!previousItems;
  const criteria = useMemo(() => deriveCriteria(dialogs, provenance), [dialogs, provenance]);
  // A version changes only what the simulator sees: the change of a criterion is counted on simulated dialogues, both sides.
  const compared = useMemo(
    () => compareCriteria(criteria, comparing ? deriveCriteria(prevSims, provenance) : null, c => c.by.sim.failed),
    [criteria, comparing, prevSims, provenance],
  );

  const sim = useMemo(() => summarize(sims), [sims]);
  const prevSim = useMemo(() => (comparing ? summarize(prevSims) : null), [comparing, prevSims]);
  const log = useMemo(() => summarize(logs), [logs]);

  const past = recent.map(r => (r.id === finished?.id ? finished : details(r))).filter((r): r is LabRun => !!r?.items);
  const versions = past.map(r => r.version);
  const history = (key: string) => historyOf(key, past);

  return {
    finished, previous, sameAgent, versions, history, comparing,
    /** Every dialogue: the version's simulated ones first, then the real logs. */
    dialogs, sims, logs, prevSims,
    criteria, compared,
    /** Dialogues without violations: the version's (simulator), the previous version's, and the real logs'. */
    sim, prevSim, log,
    /** @deprecated Use `sim` (or `log` when there is no run). */
    summary: sims.length ? sim : log,
    counts: { all: logs.length + sims.length, log: logs.length, sim: sims.length },
    ready: !!state && (!state.runs.length || !!finished),
    empty: logs.length + sims.length === 0,
  };
}

export type Scope = ReturnType<typeof useScope>;

/** Dialogues of one source. */
export const bySource = (dialogs: Dialog[], src: SourceFilter) => (src === "all" ? dialogs : dialogs.filter(d => d.origin === src));

/** Dialogues the judge could decide (passed or failed). */
export const decided = (dialogs: Dialog[]) => dialogs.filter(measured);
