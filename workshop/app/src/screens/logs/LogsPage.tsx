import { useSearchParams } from "react-router-dom";
import { FileDown, RotateCcw } from "lucide-react";
import { useCriteria } from "../../lab/criteria";
import { logRows } from "../../lab/dialogs";
import { day, plural } from "../../lab/format";
import { download, problemsReport } from "../../lab/problemReport";
import { JobStrip } from "../../shell/Activity";
import { useLabState } from "../../shell/LabProvider";
import { SectionHeader } from "../../shell/SectionHeader";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { PageTitle, Soft } from "../../ui/Tile";
import { DialogsView } from "../dialogs/DialogsView";
import { ReviewView } from "../review/ReviewView";
import { Outcome, Totals } from "../verdicts/Outcome";
import { SplitBar } from "../verdicts/EvidencePanel";
import { Assess } from "./Assess";

/**
 * Логи: the real conversations assessed by the agent's criteria, without running the agent. Tabs: the assessment
 * (before it — what × by what, one button; after — every criterion with its count and evidence), all the
 * conversations, and the check of the judge's verdicts.
 */
export function LogsPage() {
  const [params, setParams] = useSearchParams();
  const { state, offline } = useLabState();
  const { data, list } = useCriteria(null);
  if (offline && !state) return <ServiceDown />;
  const tab = params.get("tab") === "dialogs" || params.get("tab") === "review" ? (params.get("tab") as "dialogs" | "review") : null;
  const change = (edit: (n: URLSearchParams) => void, replace = true) => setParams(prev => { const n = new URLSearchParams(prev); edit(n); return n; }, { replace });
  const assessing = params.get("assess") === "1";
  const log = data?.log;
  const assessed = !!state?.discover && !!log;
  const dialogId = tab === "dialogs" ? params.get("d") : null;
  const dialogTitle = dialogId && state ? logRows(state).find(r => r.key === dialogId)?.title : undefined;
  const total = state?.logs.total ?? 0;

  let body;
  if (!state || (state.discover && !data)) body = <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div>;
  else if (tab === "dialogs") body = <DialogsView source="log" />;
  else if (tab === "review") body = <ReviewView source="log" />;
  else if (!assessed || assessing || !log || !data) body = <div className="min-h-0 flex-1 overflow-auto"><Assess criteria={list} onCancel={assessed ? () => change(n => n.delete("assess"), false) : undefined} /></div>;
  else {
    const broken = list.filter(c => c.r.log.failed > 0).length;
    const humans = list.reduce((n, c) => n + c.r.log.examples.filter(e => e.status === "FAIL" && e.review).length, 0);
    const fails = list.reduce((n, c) => n + c.r.log.examples.filter(e => e.status === "FAIL").length, 0);
    const second = list.reduce((acc, c) => {
      const judged = c.r.log.examples.filter(e => e.status === "FAIL" && e.second);
      return { checked: acc.checked + judged.length, agree: acc.agree + judged.filter(e => e.second === "agree").length };
    }, { checked: 0, agree: 0 });
    body = (
      <Outcome criteria={list} source="log"
        head={<PageTitle title="Оценка логов" sub={`${log.finishedAt ? `от ${day(log.finishedAt)} · ` : ""}${log.assessed} ${plural(log.assessed, "разговор", "разговора", "разговоров")} × ${list.length} ${plural(list.length, "критерий", "критерия", "критериев")}`}
          actions={<>
            <Soft onClick={() => download("otchet-logi.md", problemsReport(data, window.location.origin, "log"))} title="Отчёт в Markdown"><FileDown className="size-3.5" />Отчёт</Soft>
            <Soft onClick={() => change(n => n.set("assess", "1"), false)} disabled={!!state.job.running}><RotateCcw className="size-3.5" />Оценить заново</Soft>
          </>} />}
        totals={<Totals cells={[
          { label: "Разговоров с нарушениями", value: log.withViolations, of: `из ${log.assessed}`, tone: log.withViolations ? "text-lab-bad" : undefined,
            bar: <SplitBar className="mt-2" failed={log.withViolations} passed={log.assessed - log.withViolations} unknown={log.unassessed} /> },
          { label: "Нарушенных критериев", value: broken, of: `из ${list.length}` },
          { label: "Второй судья согласен", value: second.checked ? second.agree : "—", of: second.checked ? `из ${second.checked}` : undefined },
          { label: "Проверено людьми", value: humans || "—", of: humans ? `из ${fails}` : undefined },
        ]} />} />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        crumbs={[{ label: "Логи" }, ...(dialogTitle ? [{ label: dialogTitle }] : [])]}
        tabs={[
          { label: "Оценка", to: "/logs", on: !tab },
          { label: <>Разговоры{total > 0 && <span className="ml-1 text-lab-dim">{total}</span>}</>, to: "/logs?tab=dialogs", on: tab === "dialogs" },
          { label: "Проверка вердиктов", to: "/logs?tab=review", on: tab === "review" },
        ]}
        below={<JobStrip kinds={["discover"]} />}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
    </div>
  );
}
