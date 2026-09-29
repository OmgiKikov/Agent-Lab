import { useMemo } from "react";
import { previousOf } from "./logic";
import type { LabRun, LabState } from "./types";
import { useRunDetails } from "./useLab";

/**
 * The run a page is about (the chosen one, else the latest finished), the run before it of the same agent,
 * and the few runs around them. Full data of these is fetched once and kept.
 */
export function useRunContext(state: LabState | null, selected: LabRun | null, baseId?: string | null) {
  const history = useMemo(() => (state?.runs ?? []).filter(r => r.metric && r.status !== "running"), [state?.runs]);
  const head = selected && selected.status !== "running" ? selected : history[0] ?? null;
  const sameAgent = useMemo(
    () => (head ? history.filter(r => r.target === head.target).sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)).slice(-12) : []),
    [history, head],
  );
  const recent = sameAgent.slice(-5);
  const previous = head && state ? (baseId ? history.find(r => r.id === baseId) ?? null : previousOf(state.runs, head)) : null;
  const { details, error, retry } = useRunDetails([...(head ? [head] : []), ...(previous ? [previous] : []), ...recent]);
  const finished: LabRun | null = head ? (head.items ? head : details(head)) : null;
  const previousItems = previous ? details(previous)?.items ?? null : null;
  return { history, head, finished, previous, previousItems, sameAgent, recent, details, error, retry };
}
