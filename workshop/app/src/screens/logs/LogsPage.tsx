import { useSearchParams } from "react-router-dom";
import { logRows } from "../../lab/dialogs";
import { useProblems } from "../../lab/problems";
import { JobStrip } from "../../shell/Activity";
import { useLabState } from "../../shell/LabProvider";
import { SectionHeader } from "../../shell/SectionHeader";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { DialogsView } from "../dialogs/DialogsView";
import { ProblemDetail } from "../problems/ProblemDetail";
import { ReviewView } from "../review/ReviewView";
import { AssessPanel } from "./AssessPanel";
import { AssessResult } from "./AssessResult";

/** Логи: assess the real conversations by the agent's criteria. Before: what × by what, one button. After: every criterion and its counts. */
export function LogsPage() {
  const [params, setParams] = useSearchParams();
  const { state, offline } = useLabState();
  const { data } = useProblems(null);
  if (offline && !state) return <ServiceDown />;
  const tab = params.get("tab") === "dialogs" || params.get("tab") === "review" ? (params.get("tab") as "dialogs" | "review") : null;
  const change = (edit: (n: URLSearchParams) => void, replace = true) => setParams(prev => { const n = new URLSearchParams(prev); edit(n); return n; }, { replace });
  const ruleId = params.get("p");
  const rule = ruleId ? data?.rules.find(r => r.id === ruleId) : undefined;
  const assessing = params.get("assess") === "1";
  const assessed = !!state?.discover && !!data?.log;
  const dialogId = tab === "dialogs" ? params.get("d") : null;
  const dialogTitle = dialogId && state ? logRows(state).find(r => r.key === dialogId)?.title : undefined;
  const clear = (...keys: string[]) => { const n = new URLSearchParams(params); keys.forEach(k => n.delete(k)); return `/logs${n.toString() ? `?${n}` : ""}`; };
  const crumbs = tab
    ? [{ label: "Логи", to: "/logs" }, { label: tab === "dialogs" ? "Все разговоры" : "Проверка вердиктов", to: dialogId ? clear("d", "dt", "example", "ev") : undefined }, ...(dialogTitle ? [{ label: dialogTitle }] : [])]
    : ruleId ? [{ label: "Логи", to: "/logs" }, { label: rule?.title ?? "Критерий" }]
    : [{ label: "Логи" }];
  return (
    <div className="flex h-full flex-col">
      <SectionHeader crumbs={crumbs} below={<JobStrip kinds={["discover"]} />} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {!state ? <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div>
          : tab === "dialogs" ? <DialogsView source="log" />
          : tab === "review" ? <ReviewView source="log" />
          : ruleId ? (
            !data ? <div className="p-6"><Skeleton className="h-[420px]" /></div>
              : rule ? <ProblemDetail key={rule.id} p={rule} source="log" onBack={() => change(n => { n.delete("p"); n.delete("example"); }, false)} />
              : <EmptyState title="Этого критерия нет в текущей оценке">Критерии могли извлечь заново.</EmptyState>
          )
          : <div className="min-h-0 flex-1 overflow-auto">
              {state.discover && !data ? <div className="p-6"><Skeleton className="h-[420px]" /></div>
                : assessed && !assessing && data ? <AssessResult data={data} onAgain={() => change(n => n.set("assess", "1"), false)} onOpen={id => change(n => n.set("p", id), false)} />
                : <AssessPanel onCancel={assessed ? () => change(n => n.delete("assess"), false) : undefined} />}
            </div>}
      </div>
    </div>
  );
}
