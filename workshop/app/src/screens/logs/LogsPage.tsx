import { useSearchParams } from "react-router-dom";
import { Link } from "react-router-dom";
import { FileDown, Play } from "lucide-react";
import { day } from "../../lab/format";
import { download, problemsReport } from "../../lab/problemReport";
import { useProblems } from "../../lab/problems";
import { humanChecked } from "../../lab/verdicts";
import { JobStrip } from "../../shell/Activity";
import { useLabState } from "../../shell/LabProvider";
import { LINKS } from "../../shell/links";
import { SectionHeader } from "../../shell/SectionHeader";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Summary, type Stat } from "../../ui/Summary";
import { Tabs } from "../../ui/Tabs";
import { Dropzone, UploadButton } from "../dialogs/UploadLogs";
import { DialogsView } from "../dialogs/DialogsView";
import { AssessDialog } from "../problems/AssessDialog";
import { ProblemsView } from "../problems/ProblemsView";
import { ReviewView } from "../review/ReviewView";

type Tab = "problems" | "dialogs" | "review";
const link = "text-small text-lab-ink underline underline-offset-4";

/** Логи: the real conversations, assessed by the agent's criteria without running the agent. The first result. */
export function LogsPage() {
  const [params, setParams] = useSearchParams();
  const { state, offline } = useLabState();
  const { data } = useProblems(null);
  const wanted = params.get("tab");
  const tab: Tab = wanted === "dialogs" || wanted === "review" ? wanted : "problems";
  const change = (edit: (n: URLSearchParams) => void, replace = true) => setParams(prev => { const n = new URLSearchParams(prev); edit(n); return n; }, { replace });
  const setTab = (t: Tab) => change(n => { for (const k of ["p", "d", "dt", "v", "rule", "queue", "example"]) n.delete(k); if (t === "problems") n.delete("tab"); else n.set("tab", t); }, false);
  const assessing = params.get("assess") === "1";
  const setAssess = (on: boolean) => change(n => (on ? n.set("assess", "1") : n.delete("assess")));

  if (offline && !state) return <ServiceDown />;
  const logs = state?.logs;
  const busy = !!state?.job.running;
  const assessed = !!state?.discover;
  const log = data?.log;
  const violated = data?.rules.filter(r => r.log.failed > 0).length ?? 0;
  const v = params.get("v");
  const people = data ? humanChecked(data, "log") : null;
  const go = (t: Tab, v?: string) => change(n => {
    for (const k of ["p", "d", "dt", "v", "rule", "queue", "example"]) n.delete(k);
    if (t === "problems") n.delete("tab"); else n.set("tab", t);
    if (v) n.set("v", v);
  }, false);
  const stats: Stat[] = log ? [
    { label: "Оценено", value: log.assessed, of: `из ${log.sampled}`, active: tab === "dialogs" && !v, onClick: () => go("dialogs"), title: `Все оценённые диалоги. Всего в логах ${logs?.total}${logs?.file ? `, файл ${logs.file}` : ""}${logs?.updatedAt ? `, загружены ${day(logs.updatedAt)}` : ""}` },
    { label: "Диалогов с нарушениями", value: log.withViolations, of: `из ${log.assessed}`, active: tab === "dialogs" && v === "fail", onClick: () => go("dialogs", "fail") },
    { label: "Нарушаются критериев", value: violated, of: `из ${data!.rules.length}`, active: tab === "problems", onClick: () => go("problems") },
    ...(log.unassessed ? [{ label: "Без оценки", value: log.unassessed, of: "диалогов", active: tab === "dialogs" && v === "none", onClick: () => go("dialogs", "none"), title: "Судья не смог оценить" }] : []),
    { label: "Проверено людьми", value: people?.checked ?? 0, of: `из ${people?.of ?? 0}`, active: tab === "review", onClick: () => go("review") },
  ] : [];
  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        crumbs={[{ label: "Логи", to: "/logs" }, ...(logs?.total && assessed ? [{ label: { problems: "Нарушения", dialogs: "Диалоги", review: "Проверка" }[tab] }] : [])]}
        actions={<>
          <UploadButton variant="outline" />
          <Button variant="primary" icon={Play} onClick={() => setAssess(true)} disabled={!state?.sources.length || !logs?.total || busy} title={busy ? "Сейчас идёт другая задача" : undefined}>Оценить логи</Button>
        </>}
        below={<JobStrip kinds={["discover"]} />}
      />
      {!state ? <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div>
        : !state.sources.length && !assessed ? (
          <EmptyState drop title="Агент ещё не подключён" className="flex-1">
            Критерии оценки берутся из кода агента. <Link to={LINKS.agent} className={link}>Открыть «Агент»</Link>
          </EmptyState>
        )
        : !logs?.total ? <Dropzone />
        : !assessed ? (
          <>
            <EmptyState drop title="Логи ещё не оценены" className="flex-1" action={<Button variant="primary" icon={Play} onClick={() => setAssess(true)} disabled={busy}>Оценить логи</Button>} />
          </>
        ) : (
          <>
            <Summary stats={stats} />
            <Tabs<Tab> className="flex-shrink-0 px-4" value={tab} onChange={setTab}
              end={log && data && <Button variant="ghost" size="sm" icon={FileDown} onClick={() => download("otchet-logi.md", problemsReport(data, window.location.origin, "log"))}>Отчёт</Button>}
              tabs={[
              { value: "problems", label: "Нарушения", count: violated },
              { value: "dialogs", label: "Диалоги", count: log?.assessed },
              { value: "review", label: "Проверка" },
            ]} />
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {tab === "problems" ? <ProblemsView source="log" /> : tab === "dialogs" ? <DialogsView source="log" /> : <ReviewView source="log" />}
            </div>
          </>
        )}
      {state && <AssessDialog open={assessing} onClose={() => setAssess(false)} />}
    </div>
  );
}
