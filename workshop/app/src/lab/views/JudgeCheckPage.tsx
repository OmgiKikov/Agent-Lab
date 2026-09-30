import { api } from "../api";
import { itemKey } from "../logic";
import { useToast } from "../toast";
import type { LabState } from "../types";
import type { Scope } from "../useScope";
import { EmptyState, Page, Skeleton } from "../ui";
import { JudgeCheck } from "./JudgeCheck";

/** A person goes through the simulator's verdicts one by one and says whether the judge is right. */
export function JudgeCheckPage({ state, scope, onBack, onOpen }: { state: LabState; scope: Scope; onBack: () => void; onOpen: (key: string) => void }) {
  const { error } = useToast();
  const run = scope.finished;
  const crumb = { label: "Судья", onClick: onBack };
  if (!state.runs.length) return <Page title="Сверка судьи" crumb={crumb}><EmptyState title="Пока нечего сверять">Судью сверяют на диалогах симулятора. Проверьте версию агента хотя бы раз.</EmptyState></Page>;
  if (!run?.items) return <Page title="Сверка судьи" crumb={crumb}><Skeleton className="mt-10 h-[420px]" /></Page>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[52px] flex-shrink-0 items-center gap-2 border-b border-lab-line px-5">
        <button className="lab-focus -ml-1.5 rounded-md px-1.5 py-1 text-body text-lab-mute transition-colors duration-100 hover:text-lab-ink" onClick={onBack}>Судья</button>
        <span className="text-body text-lab-faint" aria-hidden>/</span>
        <h1 className="text-body font-semibold text-lab-ink">Сверка</h1>
        <span className="ml-auto inline-flex items-center gap-2 text-body text-lab-mute"><span className="lab-label">Версия</span><span className="tabular-nums text-lab-ink">{run.version}</span></span>
      </div>
      <div className="min-h-0 flex-1">
        <JudgeCheck run={run} state={state} onReview={(index, decision) => api("/api/review", { run: run.id, index, decision }).catch(error)} onOpen={i => onOpen(itemKey(i))} />
      </div>
    </div>
  );
}
