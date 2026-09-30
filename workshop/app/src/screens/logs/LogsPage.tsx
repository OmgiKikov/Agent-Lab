import { useSearchParams } from "react-router-dom";
import { Link } from "react-router-dom";
import { Play } from "lucide-react";
import { day, plural } from "../../lab/format";
import { useProblems } from "../../lab/problems";
import { JobStrip } from "../../shell/Activity";
import { useLabState } from "../../shell/LabProvider";
import { LINKS } from "../../shell/links";
import { SectionHeader } from "../../shell/SectionHeader";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Facts, type Fact } from "../../ui/Facts";
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
  const facts: Fact[] = logs?.total ? [
    { label: "Логи", value: String(logs.total) },
    ...(logs.file ? [{ label: "Файл", value: logs.file }] : []),
    ...(logs.updatedAt ? [{ label: "Загружены", value: day(logs.updatedAt) }] : []),
    ...(log ? [
      { label: "Оценено", value: `${log.assessed} из ${log.sampled}` },
      ...(log.unassessed ? [{ label: "Без оценки", value: String(log.unassessed), onClick: () => setTab("dialogs") }] : []),
      { label: "Нарушается", value: `${violated} из ${data!.rules.length} ${plural(data!.rules.length, "критерия", "критериев", "критериев")}`, onClick: () => setTab("problems") },
    ] : []),
  ] : [];
  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        crumbs={[{ label: "Логи" }]}
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
            <Facts facts={facts} className="flex-shrink-0 border-b border-white/[0.06] px-4 py-2" />
            <EmptyState drop title="Логи ещё не оценены" className="flex-1" action={<Button variant="primary" icon={Play} onClick={() => setAssess(true)} disabled={busy}>Оценить логи</Button>} />
          </>
        ) : (
          <>
            <Facts facts={facts} className="flex-shrink-0 border-b border-white/[0.06] px-4 py-2" />
            <Tabs<Tab> className="flex-shrink-0 px-4" value={tab} onChange={setTab} tabs={[
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
