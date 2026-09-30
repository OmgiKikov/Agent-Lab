import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, FileDown } from "lucide-react";
import { when } from "../../lab/format";
import { simKey, simRows } from "../../lab/dialogs";
import { download, problemsReport } from "../../lab/problemReport";
import { useProblems } from "../../lab/problems";
import { humanChecked } from "../../lab/verdicts";
import { runTitle, simDialog, useRun } from "../../lab/runs";
import { JobStrip } from "../../shell/Activity";
import { useLabState } from "../../shell/LabProvider";
import { SectionHeader } from "../../shell/SectionHeader";
import { Button } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { FirstRun } from "../../shell/FirstRun";
import { Summary, type Stat } from "../../ui/Summary";
import { Menu } from "../../ui/Menu";
import { PillTabs } from "../../ui/PillTabs";
import { DialogsView } from "../dialogs/DialogsView";
import { ProblemsView } from "../problems/ProblemsView";
import { TypesView } from "./TypesView";
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
  const openId = tab === "problems" ? params.get("p") : tab === "dialogs" ? params.get("d") : null;
  const tabName = { problems: "Нарушения", dialogs: "Диалоги", review: "Проверка", types: "По типам клиентов" }[tab];
  const openTitle = !openId ? null : tab === "problems" ? problems?.rules.find(r => r.id === openId)?.title : simRows(full).find(r => r.key === openId)?.title;
  const back = () => { const n = new URLSearchParams(params); for (const k of ["p", "d", "dt", "example", "ev"]) n.delete(k); return `/results?${n}`; };
  const picker = run && (
    <Menu align="right" trigger={<span className="inline-flex h-7 items-center gap-1 rounded border border-white/[0.15] bg-[rgb(40,40,40)] px-2.5 text-meta text-lab-text hover:border-white/25">Прогон: {when(run.startedAt)}<ChevronDown className="size-3" /></span>}
      items={finished.map(r => ({ key: r.id, label: runTitle(r), sub: when(r.startedAt), on: r.id === run.id, run: () => set("run", r.id) }))} />
  );

  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        crumbs={[{ label: "Результаты", to: run ? "/results" : undefined }, ...(run ? [{ label: runTitle(run), to: openId ? back() : undefined }] : []), ...(openTitle ? [{ label: openTitle }] : [])]}
        meta={run && !openId ? `${tabName} · ${when(run.startedAt)}` : undefined}
        actions={run ? <>
          <Link to={`/simulations?r=${encodeURIComponent(run.id)}`}><Button variant="outline">Открыть прогон</Button></Link>
        </> : undefined}
        below={<JobStrip kinds={["rejudge"]} />}
      />
      {!state ? <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div> : !run ? (
        <FirstRun here="results" title="Результаты появятся после первого прогона" action={<Link to="/simulations"><Button variant="primary">Открыть прогоны</Button></Link>}
          hints={[{ title: "Нарушения", text: "Критерии, которые агент нарушил в диалогах прогона." }, { title: "Проверка", text: "Верно или неверно: вы подтверждаете решения судьи." }, { title: "По типам клиентов", text: "Кто из клиентов чаще приводит агента к нарушению." }]}>
          Здесь судья оценит диалоги прогона по тем же критериям, что и логи.
        </FirstRun>
      ) : (
        <>
          {!openId && (
            <>
              <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-white/[0.08] px-3 py-[7px]">
                <PillTabs<Tab> value={tab} onChange={t => set("tab", t === "problems" ? null : t)} tabs={[
                  { value: "problems", label: "Нарушения", count: violated },
                  { value: "dialogs", label: "Диалоги", count: m?.total },
                  { value: "review", label: "Проверка" },
                  { value: "types", label: "По типам клиентов" },
                ]} />
                <div className="flex items-center gap-1">{picker}{problems?.sim?.runId === run.id && <Button variant="ghost" size="sm" icon={FileDown} onClick={() => download(`otchet-${run.id}.md`, problemsReport(problems, window.location.origin, "sim"))}>Отчёт</Button>}</div>
              </div>
              {tab !== "review" && tab !== "types" && <Summary stats={stats} />}
            </>
          )}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {tab === "problems" ? <ProblemsView source="sim" runId={run.id} />
              : tab === "dialogs" ? <DialogsView source="sim" runId={run.id} />
              : tab === "review" ? <ReviewView source="sim" runId={run.id} />
              : !full?.items?.length ? <Skeleton className="m-6 h-64" />
              : <div className="h-full overflow-auto"><TypesView run={full} items={full.items} hrefOf={i => simDialog(run.id, i)} /></div>}
          </div>
        </>
      )}
    </div>
  );
}
