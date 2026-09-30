import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, FileDown } from "lucide-react";
import { when } from "../../lab/format";
import { download, problemsReport } from "../../lab/problemReport";
import { useProblems } from "../../lab/problems";
import { humanChecked } from "../../lab/verdicts";
import { runTitle, simDialog, useRun } from "../../lab/runs";
import { JobStrip } from "../../shell/Activity";
import { useLabState } from "../../shell/LabProvider";
import { SectionHeader } from "../../shell/SectionHeader";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Summary, type Stat } from "../../ui/Summary";
import { Menu } from "../../ui/Menu";
import { Tabs } from "../../ui/Tabs";
import { DialogsView } from "../dialogs/DialogsView";
import { ProblemsView } from "../problems/ProblemsView";
import { RunMatrix } from "../simulations/RunMatrix";
import { ReviewView } from "../review/ReviewView";

type Tab = "problems" | "dialogs" | "review" | "types";

/** Результаты: the assessment of the synthetic runs, apart from the logs' one. */
export function ResultsPage() {
  const [params, setParams] = useSearchParams();
  const { state, offline } = useLabState();
  const finished = useMemo(() => (state?.runs ?? []).filter(r => r.status !== "running" && r.metric).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)), [state?.runs]);
  const run = finished.find(r => r.id === params.get("run")) ?? finished[0];
  const tab = (params.get("tab") as Tab | null) ?? "problems";
  const set = (k: string, v: string | null) => setParams(prev => { const n = new URLSearchParams(prev); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const { data: full } = useRun(run?.id, state);
  const { data: problems } = useProblems(run?.id ?? null);
  if (offline && !state) return <ServiceDown />;

  const m = run?.metric;
  const v = params.get("v");
  const violated = problems?.rules.filter(r => r.sim.failed > 0).length ?? 0;
  const people = problems ? humanChecked(problems, "sim") : null;
  const go = (t: Tab, extra?: Record<string, string>) => setParams(prev => {
    const n = new URLSearchParams(prev);
    for (const k of ["p", "d", "dt", "v", "rule", "queue", "example"]) n.delete(k);
    if (t === "problems") n.delete("tab"); else n.set("tab", t);
    for (const [k, x] of Object.entries(extra ?? {})) n.set(k, x);
    return n;
  });
  const stats: Stat[] = run && m ? [
    { label: "Диалогов", value: m.total, active: tab === "dialogs" && !v, onClick: () => go("dialogs") },
    ...(m.measured ? [{ label: "Диалогов с нарушениями", value: m.failed, of: `из ${m.measured}`, active: tab === "dialogs" && v === "fail", onClick: () => go("dialogs", { v: "fail" }) }] : []),
    { label: "Нарушаются критериев", value: violated, of: `из ${problems?.rules.length ?? 0}`, active: tab === "problems", onClick: () => go("problems") },
    ...(m.unmeasured ? [{ label: "Без оценки", value: m.unmeasured, of: "диалогов", active: tab === "dialogs" && v === "none", onClick: () => go("dialogs", { v: "none" }) }] : []),
    ...(m.secondJudge?.checked ? [{ label: "Второй судья согласен", value: m.secondJudge.agree, of: `из ${m.secondJudge.checked}`, title: m.secondJudge.model, onClick: () => go("review", { queue: "disputed" }) }] : []),
    { label: "Проверено людьми", value: people?.checked ?? 0, of: `из ${people?.of ?? 0}`, active: tab === "review", onClick: () => go("review") },
  ] : [];
  const picker = run && (
    <Menu align="right" trigger={<span className="inline-flex h-7 items-center gap-1 rounded px-2 text-meta text-lab-mute hover:text-lab-text">Прогон: {when(run.startedAt)}<ChevronDown className="size-3" /></span>}
      items={finished.map(r => ({ key: r.id, label: runTitle(r), sub: when(r.startedAt), on: r.id === run.id, run: () => set("run", r.id) }))} />
  );

  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        crumbs={[{ label: "Результаты", to: run ? "/results" : undefined }, ...(run ? [{ label: runTitle(run) }] : [])]}
        actions={run ? <>
          <Link to={`/simulations?r=${encodeURIComponent(run.id)}`}><Button variant="outline">Открыть прогон</Button></Link>
        </> : undefined}
        below={<JobStrip kinds={["rejudge"]} />}
      />
      {!state ? <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div> : !run ? (
        <EmptyState drop title="Завершённых прогонов нет" action={<Link to="/simulations"><Button variant="primary">Сыграть</Button></Link>}>Результаты появятся после первого прогона.</EmptyState>
      ) : (
        <>
          <Summary stats={stats} />
          <Tabs<Tab> className="px-2" value={tab} onChange={t => set("tab", t === "problems" ? null : t)}
            end={<>{picker}{problems?.sim?.runId === run.id && <Button variant="ghost" size="sm" icon={FileDown} onClick={() => download(`otchet-${run.id}.md`, problemsReport(problems, window.location.origin, "sim"))}>Отчёт</Button>}</>}
            tabs={[
            { value: "problems", label: "Нарушения" },
            { value: "dialogs", label: "Диалоги", count: m?.total },
            { value: "review", label: "Проверка" },
            { value: "types", label: "По типам клиентов" },
          ]} />
          <div className="min-h-0 flex-1 overflow-auto">
            {tab === "problems" ? <ProblemsView source="sim" runId={run.id} />
              : tab === "dialogs" ? <DialogsView source="sim" runId={run.id} />
              : tab === "review" ? <ReviewView source="sim" runId={run.id} />
              : !full?.items?.length ? <Skeleton className="m-6 h-64" />
              : <div className="mx-auto max-w-[960px] px-6 pb-16"><RunMatrix run={full} items={full.items} scores hrefOf={i => simDialog(run.id, i)} /></div>}
          </div>
        </>
      )}
    </div>
  );
}
