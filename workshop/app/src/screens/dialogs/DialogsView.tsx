import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lab/api";
import { logKey, logRows, simKey, simRows } from "../../lab/dialogs";
import { useCriteria } from "../../lab/criteria";
import type { LabRun } from "../../lab/types";
import { useKeys } from "../../shell/keys";
import { useLabState } from "../../shell/LabProvider";
import { EmptyState, Skeleton } from "../../ui/EmptyState";
import { DialogList, matchesRow, type Verdict } from "./DialogList";
import { DialogView } from "./DialogView";

/** The dialogues of one source: the assessed logs, or the items of a run. List and one dialogue in full (?d=). */
export function DialogsView({ source, runId }: { source: "log" | "sim"; runId?: string | null }) {
  const [params, setParams] = useSearchParams();
  const { state } = useLabState();
  const { data: problems, list: criteria, topics } = useCriteria(source === "sim" ? runId ?? null : null);
  const simRunId = source === "sim" ? (runId ?? problems?.sim?.runId ?? null) : null;
  const run = useQuery({ queryKey: ["run", simRunId], queryFn: () => api<LabRun>(`/api/runs/${encodeURIComponent(simRunId!)}`), enabled: !!simRunId, staleTime: 60_000 });
  const [query, setQuery] = useState("");
  const verdict = (params.get("v") as Verdict | null) ?? "all";
  const ruleId = params.get("rule");
  const key = params.get("d");
  const rule = ruleId ? problems?.rules.find(r => r.id === ruleId) : undefined;
  const only = useMemo(() => (rule ? new Set(rule[source].examples.filter(e => e.status === "FAIL").map(e => (source === "log" ? logKey(e.dialogueId ?? "") : simKey(e.runId ?? "", e.index ?? 0)))) : null), [rule, source]);
  const all = useMemo(() => (source === "log" ? (state ? logRows(state) : []) : simRows(run.data)), [source, state, run.data]);
  const rows = useMemo(() => all.filter(r => matchesRow(r, "all", verdict, query, only)), [all, verdict, query, only]);
  const selected = key ? all.find(r => r.key === key) : undefined;
  const set = (name: string, value: string | null) => setParams(prev => { const n = new URLSearchParams(prev); if (value && value !== "all") n.set(name, value); else n.delete(name); return n; }, { replace: true });
  const open = useCallback((k: string | null, replace = false) => setParams(prev => { const n = new URLSearchParams(prev); if (k) n.set("d", k); else n.delete("d"); n.delete("dt"); return n; }, { replace }), [setParams]);
  const pick = useCallback((k: string) => open(k), [open]);
  const step = (d: 1 | -1) => {
    if (!key || !rows.length) return;
    const at = rows.findIndex(r => r.key === key);
    open(rows[Math.max(0, Math.min(rows.length - 1, (at < 0 ? 0 : at) + d))].key, true);
  };
  useKeys({ KeyJ: () => step(1), KeyK: () => step(-1) });

  if (!state || (source === "sim" && simRunId && run.isLoading)) return <div className="p-6"><Skeleton className="h-[420px]" /></div>;
  if (!all.length) return <EmptyState drop title={source === "log" ? "Оценённых логов нет" : "В этом прогоне нет диалогов"} />;
  if (key) return selected ? <DialogView key={selected.key} row={selected} onBack={() => open(null)} /> : <EmptyState title="Этого диалога нет среди загруженных" />;
  return (
    <DialogList rows={rows} all={all} verdict={verdict} onVerdict={v => set("v", v)} query={query} onQuery={setQuery}
      rule={criteria.find(c => c.r.id === ruleId) ?? null} onClearRule={() => set("rule", null)} onOpen={pick} personas={state.personas}
      criteria={criteria} topics={topics} />
  );
}
