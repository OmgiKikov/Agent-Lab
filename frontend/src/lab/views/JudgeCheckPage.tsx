import { ArrowLeft } from "lucide-react";
import { post } from "../api";
import { itemKey } from "../logic";
import type { LabState } from "../types";
import type { Scope } from "../useScope";
import { EmptyState, Page, Skeleton } from "../ui";
import { JudgeCheck } from "./JudgeCheck";

/** A person goes through the simulator's verdicts one by one and says whether the judge is right. */
export function JudgeCheckPage({
  state,
  scope,
  onBack,
  onOpen,
}: {
  state: LabState;
  scope: Scope;
  onBack: () => void;
  onOpen: (key: string) => void;
}) {
  const run = scope.finished;
  if (!state.runs.length)
    return (
      <Page wide title="проверка судьи">
        <EmptyState className="mt-5" drop title="Пока нечего проверять">
          Судью проверяют по диалогам симулятора. Прогоните его хотя бы раз.
        </EmptyState>
      </Page>
    );
  if (!run?.items)
    return (
      <Page wide title="проверка судьи">
        <Skeleton className="mt-5 h-[400px]" />
      </Page>
    );
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-white/[0.06] px-6 py-2.5">
        <button
          className="inline-flex items-center gap-1.5 text-[12px] text-lab-mute transition-colors hover:text-lab-text"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" />
          Судья
        </button>
        <span className="text-[12px] text-lab-dim">
          {run.targetName} · {run.version}
        </span>
      </div>
      <div className="sb min-h-0 flex-1 overflow-auto">
        <JudgeCheck
          run={run}
          state={state}
          onReview={(index, decision) => post("/api/review", { run: run.id, index, decision })}
          onOpen={(i) => onOpen(itemKey(i))}
        />
      </div>
    </div>
  );
}
