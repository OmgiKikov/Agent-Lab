import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { listRuns } from "../../api/runs";
import { api } from "../../lab/api";
import { dialogPath, logKey, logRows, simKey, simRows, traceRows } from "../../lab/dialogs";
import { day, plural } from "../../lab/format";
import { useProblems } from "../../lab/problems";
import type { LabRun } from "../../lab/types";
import { useKeys } from "../../shell/keys";
import { useLabState } from "../../shell/LabProvider";
import { SectionHeader } from "../../shell/SectionHeader";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Split } from "../../ui/Split";
import { DialogList, matchesRow, type SourceFilter, type Verdict } from "./DialogList";
import { DialogView } from "./DialogView";
import { Dropzone, UploadButton } from "./UploadLogs";

const Dot = () => <span className="text-lab-faint">·</span>;

/** Диалоги: every conversation the product knows — the logs, the simulator and any other trace — and one of them in full. */
export function DialogsPage() {
  const { dialogKey } = useParams<{ dialogKey?: string }>();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { state, offline } = useLabState();
  const { data: problems } = useProblems(params.get("run"));
  const simRunId = problems?.sim?.runId ?? null;
  const run = useQuery({ queryKey: ["run", simRunId], queryFn: () => api<LabRun>(`/api/runs/${encodeURIComponent(simRunId!)}`), enabled: !!simRunId, staleTime: 60_000 });
  const traces = useQuery({ queryKey: ["traces"], queryFn: listRuns, staleTime: 15_000, retry: false });
  const [query, setQuery] = useState("");
  const source = (params.get("source") as SourceFilter | null) ?? "all";
  const verdict = (params.get("verdict") as Verdict | null) ?? "all";
  const ruleId = params.get("rule");
  const rule = ruleId ? problems?.rules.find(r => r.id === ruleId) : undefined;
  const only = useMemo(() => (rule ? new Set([...rule.log.examples, ...rule.sim.examples].filter(e => e.status === "FAIL").map(e => (e.source === "log" ? logKey(e.dialogueId ?? "") : simKey(e.runId ?? "", e.index ?? 0)))) : null), [rule]);
  const all = useMemo(() => [...(state ? logRows(state) : []), ...simRows(run.data), ...traceRows(traces.data ?? [])], [state, run.data, traces.data]);
  const rows = useMemo(() => all.filter(r => matchesRow(r, source, verdict, query, only)), [all, source, verdict, query, only]);
  const key = dialogKey ? decodeURIComponent(dialogKey) : null;
  const selected = key ? all.find(r => r.key === key) : undefined;
  const set = (name: string, value: string | null) => setParams(prev => { const n = new URLSearchParams(prev); if (value && value !== "all") n.set(name, value); else n.delete(name); return n; }, { replace: true });
  const open = (k: string) => navigate(`${dialogPath(k)}${window.location.search}`);
  useEffect(() => {
    if (!key && rows[0] && window.matchMedia("(min-width: 1024px)").matches) navigate(`${dialogPath(rows[0].key)}${window.location.search}`, { replace: true });
  }, [key, rows, navigate]);
  const step = (d: 1 | -1) => {
    if (!rows.length) return;
    const at = rows.findIndex(r => r.key === key);
    open(rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + d))].key);
  };
  useKeys({ KeyJ: () => step(1), ArrowDown: () => step(1), KeyK: () => step(-1), ArrowUp: () => step(-1) });

  if (offline && !state) return <ServiceDown />;
  const logs = state?.logs;
  const assessed = state?.discover?.results.length ?? 0;
  return (
    <div className="flex h-full flex-col">
      <SectionHeader crumbs={[{ label: "Диалоги" }]} actions={<UploadButton variant={logs?.total ? "outline" : "primary"} />} />
      {!state ? <div className="p-6"><Skeleton className="h-[420px]" /></div>
        : !all.length && !logs?.total ? <Dropzone />
        : (
          <>
            <div className="flex flex-shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-white/[0.06] px-6 py-3 text-small text-lab-mute">
              <span>{logs?.total ?? 0} {plural(logs?.total ?? 0, "диалог", "диалога", "диалогов")} в логах{logs?.file ? ` из «${logs.file}»` : ""}{logs?.updatedAt ? `, загружены ${day(logs.updatedAt)}` : ""}</span>
              <Dot /><span>{assessed ? `оценено ${assessed}` : "не оценены"}</span>
              {problems?.sim && <><Dot /><span>симуляция: {problems.sim.target} · {day(problems.sim.finishedAt)} · {problems.sim.dialogs} {plural(problems.sim.dialogs, "диалог", "диалога", "диалогов")}</span></>}
              {traces.data && <><Dot /><span>других трейсов: {traceRows(traces.data).length}</span></>}
            </div>
            <Split
              showDetail={!!key}
              list={<DialogList rows={rows} all={all} selected={key} source={source} onSource={s => set("source", s)} verdict={verdict} onVerdict={v => set("verdict", v)}
                query={query} onQuery={setQuery} rule={rule?.title ?? null} onClearRule={() => set("rule", null)} onPick={open} personas={state.personas} />}
              detail={selected ? <DialogView key={selected.key} row={selected} onBack={() => navigate(`/dialogs${window.location.search}`)} />
                : <EmptyState title={key ? "Этого диалога нет среди загруженных" : "Выберите диалог слева"}>{key ? "Логи могли загрузить заново или прогон удалили." : null}</EmptyState>}
            />
          </>
        )}
    </div>
  );
}
