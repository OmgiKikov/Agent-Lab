import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, FileDown } from "lucide-react";
import { when } from "../../lab/format";
import { download, problemsReport } from "../../lab/problemReport";
import { useProblems } from "../../lab/problems";
import { runTitle, simDialog, useRun } from "../../lab/runs";
import { JobStrip } from "../../shell/Activity";
import { useLabState } from "../../shell/LabProvider";
import { SectionHeader } from "../../shell/SectionHeader";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Facts, type Fact } from "../../ui/Facts";
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
  const facts: Fact[] = run && m ? [
    { label: "Прогон", value: (
      <Menu trigger={<span className="inline-flex items-center gap-1 underline decoration-white/20 underline-offset-2">{runTitle(run)} · {when(run.startedAt)}<ChevronDown className="size-3" /></span>}
        items={finished.map(r => ({ key: r.id, label: runTitle(r), sub: when(r.startedAt), on: r.id === run.id, run: () => set("run", r.id) }))} />
    ) },
    { label: "Диалогов", value: m.total },
    ...(m.measured ? [{ label: "Нарушения", value: `в ${m.failed} из ${m.measured}` }] : []),
    ...(m.unmeasured ? [{ label: "Без оценки", value: m.unmeasured }] : []),
    ...(m.secondJudge?.checked ? [{ label: "Второй судья", value: `согласен в ${m.secondJudge.agree} из ${m.secondJudge.checked}`, title: m.secondJudge.model }] : []),
    ...(m.human?.reviewed ? [{ label: "Люди", value: `проверили ${m.human.reviewed}` }] : []),
  ] : [];

  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        crumbs={[{ label: "Результаты" }]}
        actions={run ? <>
          {problems?.sim?.runId === run.id && <Button variant="outline" icon={FileDown} onClick={() => download(`otchet-${run.id}.md`, problemsReport(problems, window.location.origin, "sim"))}>Отчёт</Button>}
          <Link to={`/simulations?r=${encodeURIComponent(run.id)}`}><Button variant="outline">Прогон</Button></Link>
        </> : undefined}
        below={<JobStrip kinds={["rejudge"]} />}
      />
      {!state ? <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div> : !run ? (
        <EmptyState drop title="Завершённых прогонов нет" action={<Link to="/simulations"><Button variant="primary">Сыграть</Button></Link>}>Результаты появятся после первого прогона.</EmptyState>
      ) : (
        <>
          <Facts className="px-4 pt-2.5" facts={facts} />
          <Tabs<Tab> className="mt-2 px-2" value={tab} onChange={t => set("tab", t === "problems" ? null : t)} tabs={[
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
              : <div className="mx-auto max-w-[960px] px-6 pb-16"><RunMatrix run={full} items={full.items} state={state} scores hrefOf={i => simDialog(run.id, i)} /></div>}
          </div>
        </>
      )}
    </div>
  );
}
