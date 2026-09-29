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
  const crumb = { label: "Доверие", onClick: onBack };
  if (!state.runs.length) return <Page title="Сверка судьи" crumb={crumb}><EmptyState className="mt-10" title="Пока нечего сверять">Судью сверяют на диалогах симулятора. Проверьте версию агента хотя бы раз.</EmptyState></Page>;
  if (!run?.items) return <Page title="Сверка судьи" crumb={crumb}><Skeleton className="mt-10 h-[420px]" /></Page>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 flex-shrink-0 items-center gap-2 border-b border-lab-line px-6">
        <button className="lab-focus -ml-1.5 rounded-md px-1.5 py-1 text-body text-lab-mute transition-colors duration-100 hover:text-lab-ink" onClick={onBack}>Доверие</button>
        <span className="text-body text-lab-faint" aria-hidden>/</span>
        <h1 className="text-body font-semibold text-lab-ink">Сверка судьи</h1>
        <span className="ml-auto text-body text-lab-mute">Версия {run.version}</span>
      </div>
      <div className="min-h-0 flex-1">
        <JudgeCheck run={run} state={state} onReview={(index, decision) => api("/api/review", { run: run.id, index, decision }).catch(error)} onOpen={i => onOpen(itemKey(i))} />
      </div>
    </div>
  );
}
