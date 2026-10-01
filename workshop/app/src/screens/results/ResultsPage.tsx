import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, FileDown, Play } from "lucide-react";
import { useCriteria } from "../../lab/criteria";
import { plural, when } from "../../lab/format";
import { simRows } from "../../lab/dialogs";
import { download, problemsReport } from "../../lab/problemReport";
import { runTitle, simDialog, useRun } from "../../lab/runs";
import { JobStrip } from "../../shell/Activity";
import { FirstRun } from "../../shell/FirstRun";
import { useLabState } from "../../shell/LabProvider";
import { SectionHeader } from "../../shell/SectionHeader";
import { Button } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Menu } from "../../ui/Menu";
import { PageTitle, Soft, SOFT } from "../../ui/Tile";
import { DialogsView } from "../dialogs/DialogsView";
import { ReviewView } from "../review/ReviewView";
import { SplitBar } from "../verdicts/EvidencePanel";
import { Outcome, Totals } from "../verdicts/Outcome";
import { TypesView } from "./TypesView";

type Tab = "problems" | "dialogs" | "review" | "types";

/**
 * Результаты: the synthetic runs assessed by the same criteria as the logs — a separate result, never added to the
 * logs'. Tabs: the criteria with their counts and evidence, the run's dialogues, the check of verdicts, by customer type.
 */
export function ResultsPage() {
  const [params, setParams] = useSearchParams();
  const { state, offline } = useLabState();
  const finished = useMemo(() => (state?.runs ?? []).filter(r => r.status !== "running" && r.metric).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)), [state?.runs]);
  const run = finished.find(r => r.id === params.get("run")) ?? finished[0];
  const tab = (params.get("tab") as Tab | null) ?? "problems";
  const set = (k: string, v: string | null) => setParams(prev => { const n = new URLSearchParams(prev); if (v) n.set(k, v); else n.delete(k); for (const x of ["p", "d", "dt", "example"]) if (k === "run") n.delete(x); return n; }, { replace: true });
  const { data: full } = useRun(run?.id, state);
  const { data, list } = useCriteria(run?.id ?? null);
  if (offline && !state) return <ServiceDown />;

  const m = run?.metric;
  const link = (t: Tab) => { const n = new URLSearchParams(); if (run && params.get("run")) n.set("run", run.id); if (t !== "problems") n.set("tab", t); const q = n.toString(); return `/results${q ? `?${q}` : ""}`; };
  const dialogTitle = tab === "dialogs" && params.get("d") ? simRows(full).find(r => r.key === params.get("d"))?.title : undefined;
  const picker = run && finished.length > 0 && (
    <Menu align="right" trigger={<span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 text-[12px] text-lab-soft hover:border-white/[0.2] hover:text-lab-ink">Прогон {when(run.startedAt)}<ChevronDown className="size-3.5 opacity-70" /></span>}
      items={finished.map(r => ({ key: r.id, label: runTitle(r), sub: when(r.startedAt), on: r.id === run.id, run: () => set("run", r.id) }))} />
  );

  let body;
  if (!state) body = <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div>;
  else if (!run) {
    body = (
      <FirstRun here="results" title="Результаты появятся после первого прогона" action={<Link to="/simulations"><Button variant="primary">Открыть прогоны</Button></Link>}
        hints={[{ title: "Нарушения", text: "Критерии, которые агент нарушил в диалогах прогона." }, { title: "Проверка", text: "Верно или неверно: вы подтверждаете решения судьи." }, { title: "По типам клиентов", text: "Кто из клиентов чаще приводит агента к нарушению." }]}>
        Здесь судья оценит диалоги прогона по тем же критериям, что и логи.
      </FirstRun>
    );
  } else if (tab === "dialogs") body = <DialogsView source="sim" runId={run.id} />;
  else if (tab === "review") body = <ReviewView source="sim" runId={run.id} />;
  else if (tab === "types") body = !full?.items?.length ? <Skeleton className="m-6 h-64" /> : <div className="h-full overflow-auto"><TypesView run={full} items={full.items} hrefOf={i => simDialog(run.id, i)} /></div>;
  else if (!data || !m) body = <div className="p-6"><Skeleton className="h-[420px]" /></div>;
  else {
    const broken = list.filter(c => c.r.sim.failed > 0).length;
    const fails = list.reduce((n, c) => n + c.r.sim.examples.filter(e => e.status === "FAIL").length, 0);
    const humans = list.reduce((n, c) => n + c.r.sim.examples.filter(e => e.status === "FAIL" && e.review).length, 0);
    body = (
      <Outcome criteria={list} source="sim"
        head={<PageTitle title="Результаты прогона" sub={`${runTitle(run)} · ${when(run.startedAt)} · ${m.total} ${plural(m.total, "диалог", "диалога", "диалогов")} с синтетическими клиентами`}
          actions={<>
            {picker}
            {data.sim?.runId === run.id && <Soft onClick={() => download(`otchet-${run.id}.md`, problemsReport(data, window.location.origin, "sim"))} title="Отчёт в Markdown"><FileDown className="size-3.5" />Отчёт</Soft>}
            <Link to={`/simulations?r=${encodeURIComponent(run.id)}`} className={SOFT}><Play className="size-3.5" />Открыть прогон</Link>
          </>} />}
        totals={<Totals cells={[
          { label: "Диалогов с нарушениями", value: m.failed, of: `из ${m.measured}`, tone: m.failed ? "text-lab-bad" : undefined,
            bar: <SplitBar className="mt-2" failed={m.failed} passed={m.passed} unknown={m.unmeasured} /> },
          { label: "Нарушенных критериев", value: broken, of: `из ${list.length}` },
          { label: "Второй судья согласен", value: m.secondJudge?.checked ? m.secondJudge.agree : "—", of: m.secondJudge?.checked ? `из ${m.secondJudge.checked}` : undefined },
          { label: "Проверено людьми", value: humans || "—", of: humans ? `из ${fails}` : undefined },
        ]} />} />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        crumbs={[{ label: "Результаты" }, ...(dialogTitle ? [{ label: dialogTitle }] : [])]}
        tabs={run ? [
          { label: "Нарушения", to: link("problems"), on: tab === "problems" },
          { label: <>Диалоги{m ? <span className="ml-1 text-lab-dim">{m.total}</span> : null}</>, to: link("dialogs"), on: tab === "dialogs" },
          { label: "Проверка вердиктов", to: link("review"), on: tab === "review" },
          { label: "По типам клиентов", to: link("types"), on: tab === "types" },
        ] : undefined}
        below={<JobStrip kinds={["rejudge"]} />}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
    </div>
  );
}
