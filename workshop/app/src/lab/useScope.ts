import { useCallback, useMemo, useState } from "react";
import { compareCriteria, deriveCriteria, historyOf, logDialogs, provenanceOf, simDialogs, summarize, type Dialog } from "./criteria";
import type { LabRun, LabState } from "./types";
import { useRunContext } from "./useRunContext";

export type SourceFilter = "all" | "log" | "sim";

const read = <T extends string>(key: string, fallback: T): T => { try { return (localStorage.getItem(key) as T) || fallback; } catch { return fallback; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* ignore */ } };

/**
 * What the screens are about: which dialogues (real logs, the simulator, both), of which version of the agent, and whether to set it against the previous one.
 * Chosen once, in the bar above the screens; the criteria, the dialogues and the numbers all follow.
 */
export function useScope(state: LabState | null, run: LabRun | null) {
  const [src, setSrcState] = useState<SourceFilter>(() => read<SourceFilter>("lab.src", "all"));
  const [compare, setCompareState] = useState(() => read("lab.compare", "1") === "1");
  const setSrc = useCallback((s: SourceFilter) => { setSrcState(s); write("lab.src", s); }, []);
  const setCompare = useCallback((on: boolean) => { setCompareState(on); write("lab.compare", on ? "1" : "0"); }, []);

  const ctx = useRunContext(state, run);
  const { finished, previous, previousItems, sameAgent, recent, details } = ctx;
  const provenance = useMemo(() => (state ? provenanceOf(state) : new Map()), [state]);
  const logs = useMemo(() => logDialogs(state?.discover ?? null), [state?.discover]);
  const sims = useMemo(() => simDialogs(finished?.items ?? []), [finished]);
  const prevSims = useMemo(() => simDialogs(previousItems ?? []), [previousItems]);

  const pick = (l: Dialog[], s: Dialog[]) => [...(src !== "sim" ? l : []), ...(src !== "log" ? s : [])];
  const dialogs = useMemo(() => pick(logs, sims), [logs, sims, src]); // eslint-disable-line react-hooks/exhaustive-deps
  const canCompare = !!previous && src !== "log";
  const comparing = compare && canCompare && !!previousItems;
  const criteria = useMemo(() => deriveCriteria(dialogs, provenance), [dialogs, provenance]);
  const compared = useMemo(
    () => compareCriteria(criteria, comparing ? deriveCriteria(pick(logs, prevSims), provenance) : null),
    [criteria, comparing, logs, prevSims, provenance], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const summary = useMemo(() => summarize(dialogs), [dialogs]);
  const prevSummary = useMemo(() => (comparing ? summarize(pick(logs, prevSims)) : null), [comparing, logs, prevSims]); // eslint-disable-line react-hooks/exhaustive-deps

  const past = recent.map(r => (r.id === finished?.id ? finished : details(r))).filter((r): r is LabRun => !!r?.items);
  const versions = past.map(r => r.version);
  const history = (key: string) => historyOf(key, past);

  return {
    src, setSrc, compare, setCompare, canCompare, comparing,
    finished, previous, sameAgent, versions, history,
    dialogs, criteria, compared, summary, prevSummary,
    counts: { all: logs.length + sims.length, log: logs.length, sim: sims.length },
    ready: !!state && (!state.runs.length || !!finished),
    empty: logs.length + sims.length === 0,
  };
}

export type Scope = ReturnType<typeof useScope>;
