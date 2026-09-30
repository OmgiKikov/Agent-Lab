import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lab/api";
import { logKey, logRows, simKey, simRows } from "../../lab/dialogs";
import { useProblems } from "../../lab/problems";
import type { LabRun } from "../../lab/types";
import { useKeys } from "../../shell/keys";
import { useLabState } from "../../shell/LabProvider";
import { EmptyState, Skeleton } from "../../ui/EmptyState";
import { Split } from "../../ui/Split";
import { DialogList, matchesRow, type Verdict } from "./DialogList";
import { DialogView } from "./DialogView";

const wide = () => window.matchMedia("(min-width: 1024px)").matches;

/** The dialogues of one source: the assessed logs, or the items of a run. List and one dialogue in full (?d=). */
export function DialogsView({ source, runId }: { source: "log" | "sim"; runId?: string | null }) {
  const [params, setParams] = useSearchParams();
  const { state } = useLabState();
  const { data: problems } = useProblems(runId ?? null);
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
  const open = (k: string | null, replace = false) => setParams(prev => { const n = new URLSearchParams(prev); if (k) n.set("d", k); else n.delete("d"); n.delete("dt"); return n; }, { replace });
  useEffect(() => {
    if (!key && rows[0] && wide()) open(rows[0].key, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rows]);
  const step = (d: 1 | -1) => {
    if (!rows.length) return;
    const at = rows.findIndex(r => r.key === key);
    open(rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + d))].key, true);
  };
  useKeys({ KeyJ: () => step(1), ArrowDown: () => step(1), KeyK: () => step(-1), ArrowUp: () => step(-1) });

  if (!state || (source === "sim" && simRunId && run.isLoading)) return <div className="p-6"><Skeleton className="h-[420px]" /></div>;
  if (!all.length) return <EmptyState drop title={source === "log" ? "Оценённых логов нет" : "В этом прогоне нет диалогов"} />;
  return (
    <Split
      showDetail={!!key}
      list={<DialogList rows={rows} all={all} selected={key} verdict={verdict} onVerdict={v => set("v", v)} query={query} onQuery={setQuery}
        rule={rule?.title ?? null} onClearRule={() => set("rule", null)} onPick={k => open(k)} personas={state.personas} />}
      detail={selected ? <DialogView key={selected.key} row={selected} onBack={() => open(null)} />
        : <EmptyState title={key ? "Этого диалога нет среди загруженных" : "Выберите диалог слева"} />}
    />
  );
}
