import { useMemo } from "react";
import { compareCriteria, deriveCriteria, historyOf, logDialogs, measured, provenanceOf, simDialogs, summarize, type Dialog } from "./criteria";
import { personaOf } from "./logic";
import { compareOutcomes, wilson, type Outcome } from "./stats";
import type { Item, LabRun, LabState } from "./types";
import { useRunContext } from "./useRunContext";

export type SourceFilter = "all" | "log" | "sim";

/** A simulated conversation's place in its run, the same across versions: scenario, customer type, repeat. */
export const slotOf = (i: Item) => `${i.cardId}~${personaOf(i)}~${i.attempt ?? 1}`;

const outcomes = (items: Item[] | null | undefined): Outcome[] =>
  (items ?? []).filter(i => i.status === "PASS" || i.status === "FAIL").map(i => ({ key: slotOf(i), pass: i.status === "PASS" }));

/**
 * What the screens are about: one version of the agent, set against the one before it.
 * The version's verdict is counted on the simulator only (it is what changes with a version); the real logs are a separate,
 * unversioned line («в реальных диалогах»). Criteria are counted on both, with the split kept per criterion.
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
  const change = useMemo(() => (comparing ? compareOutcomes(outcomes(finished?.items), outcomes(previousItems)) : null), [comparing, finished, previousItems]);
  const interval = sim.measured ? wilson(sim.clean, sim.measured) : null;

  const past = recent.map(r => (r.id === finished?.id ? finished : details(r))).filter((r): r is LabRun => !!r?.items);
  const versions = past.map(r => r.version);
  const history = (key: string) => historyOf(key, past);

  return {
    finished, previous, sameAgent, versions, history, comparing,
    /** Every dialogue: the version's simulated ones first, then the real logs. */
    dialogs, sims, logs, prevSims,
    criteria, compared,
    /** The version's verdict (simulator), the previous version's, and the real logs'. */
    sim, prevSim, log, change, interval,
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
