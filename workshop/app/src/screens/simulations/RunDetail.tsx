import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, RotateCcw } from "lucide-react";
import { api } from "../../lab/api";
import { when } from "../../lab/format";
import { personaName } from "../../lab/look";
import { personaOf } from "../../lab/logic";
import { isRunning, runTitle, runTypes, useRun } from "../../lab/runs";
import type { Item, LabRun, LabState } from "../../lab/types";
import { useLabState } from "../../shell/LabProvider";
import { Button } from "../../ui/Button";
import { Conversation } from "../../ui/Conversation";
import { EmptyState, Skeleton } from "../../ui/EmptyState";
import { Facts } from "../../ui/Facts";
import { Tabs } from "../../ui/Tabs";
import { useToast } from "../../ui/toast";
import { RunMatrix, Sign } from "./RunMatrix";

type Tab = "dialogs" | "matrix";

function DialogRows({ items, onOpen }: { items: Item[]; onOpen: (i: number) => void }) {
  const personas = useLabState().state?.personas ?? [];
  const many = new Set(items.map(personaOf)).size > 1;
  return (
    <div>
      {items.map((item, index) => {
        const who = [many || item.persona ? personaName(personas, item.persona) : "", item.attempt && item.attempt > 1 ? `повтор ${item.attempt}` : ""].filter(Boolean);
        return (
          <button key={index} type="button" onClick={() => onOpen(index)} className="flex w-full gap-3 border-b border-white/[0.08] px-1 py-2 text-left transition-colors hover:bg-lab-hover">
            <Sign status={item.status} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div title={item.name} className="truncate text-small text-lab-ink">{item.name}</div>
              <div className="mt-0.5 truncate text-meta text-lab-dim">{[item.topic, ...who].join(" · ")}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** One conversation of the run, opened in place, with the way to its trace. */
function Dialog({ item, onBack }: { item: Item; onBack: () => void }) {
  const personas = useLabState().state?.personas ?? [];
  return (
    <div className="mt-4">
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1.5 text-small text-lab-mute transition-colors hover:text-lab-text"><ArrowLeft className="size-3.5" />Диалоги</button>
      <div className="flex items-start gap-2">
        <Sign status={item.status} className="mt-1" />
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium text-lab-ink">{item.name}</div>
          <div className="mt-0.5 text-meta text-lab-dim">{[item.topic, item.persona ? personaName(personas, item.persona) : "", item.attempt && item.attempt > 1 ? `повтор ${item.attempt}` : ""].filter(Boolean).join(" · ")}</div>
        </div>
        {item.runId && <Link to={`/runs/${encodeURIComponent(item.runId)}`} className="flex-shrink-0 text-small text-lab-ink underline decoration-white/20 underline-offset-4 hover:decoration-white/60">Трейс<ArrowRight className="ml-1 inline size-3.5" /></Link>}
      </div>
      <div className="mt-4 max-w-[720px]"><Conversation turns={item.conversation} /></div>
    </div>
  );
}

/** A run: which agent played what, its dialogues and the scenario × customer type table; the judge's findings are in Результаты. */
export function RunDetail({ summary, state, onBack }: { summary: LabRun; state: LabState; onBack: () => void }) {
  const [params, setParams] = useSearchParams();
  const { refresh } = useLabState();
  const toast = useToast();
  const { data: run, isLoading, error } = useRun(summary.id, state);
  const tab = (params.get("tab") as Tab | null) ?? "dialogs";
  const set = (k: string, v: string | null) => setParams(prev => { const n = new URLSearchParams(prev); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: k === "tab" });
  const items = run?.items ?? [];
  const open = params.get("d");
  const opened = open !== null ? items[Number(open)] : undefined;
  const rejudge = () => api(`/api/runs/${encodeURIComponent(summary.id)}/rejudge`, {}).then(() => refresh()).catch(toast.error);
  const m = summary.metric;

  return (
    <article className="message-arrive mx-auto max-w-[960px] px-6 pb-20 pt-5 lg:px-8">
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1.5 text-small text-lab-mute transition-colors hover:text-lab-text lg:hidden"><ArrowLeft className="size-3.5" />Прогоны</button>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-page font-medium text-lab-ink">{runTitle(summary)}</h1>
          {summary.label && <p className="mt-0.5 text-small text-lab-soft">{summary.label}</p>}
        </div>
        <Button variant="outline" icon={RotateCcw} onClick={rejudge} disabled={state.job.running || isRunning(summary)}
          title={state.job.running ? "Сейчас идёт другая задача" : "Судьи оценят диалоги этого прогона заново; агента не вызываем"}>Переоценить</Button>
      </div>
      <Facts className="mt-3" facts={[
        { label: "Агент", value: summary.targetName },
        { label: "Версия", value: summary.version },
        { label: "Дата", value: when(summary.startedAt) },
        ...(m ? [{ label: "Диалогов", value: m.total }] : []),
        { label: "Типы клиентов", value: runTypes(summary, state).join(", ") },
        ...(summary.repeats && summary.repeats > 1 ? [{ label: "Повторы", value: `×${summary.repeats}` }] : []),
      ]} />
      {isRunning(summary) && <p className="mt-2 text-small text-lab-accent">Прогон идёт: диалоги появляются по мере готовности.</p>}
      {summary.status === "failed" && <p className="mt-2 text-small text-lab-bad">Прогон прервался: {summary.error}</p>}
      {summary.status === "stopped" && <p className="mt-2 text-small text-lab-warn">Прогон остановлен до конца.</p>}
      {!isRunning(summary) && <Link to={`/results?run=${encodeURIComponent(summary.id)}`} className="mt-3 inline-flex items-center gap-1.5 text-small text-lab-ink underline decoration-white/20 underline-offset-4 hover:decoration-white/60">Результаты прогона<ArrowRight className="size-3.5" /></Link>}
      <Tabs<Tab> className="mt-5" value={tab} onChange={t => { set("d", null); set("tab", t === "dialogs" ? null : t); }} tabs={[
        { value: "dialogs", label: "Диалоги", count: items.length },
        { value: "matrix", label: "Сценарии × типы клиентов" },
      ]} />
      {isLoading ? <Skeleton className="mt-4 h-64" />
        : error ? <p className="mt-4 text-small text-lab-bad">Не удалось открыть прогон: {error instanceof Error ? error.message : String(error)}</p>
        : !run || !items.length ? <EmptyState title="Диалогов пока нет">{isRunning(summary) ? "Первые появятся, когда агент ответит." : "В этом прогоне не сыграно ни одного диалога."}</EmptyState>
        : tab === "matrix" ? <RunMatrix run={run} items={items} hrefOf={i => `/simulations?r=${encodeURIComponent(run.id)}&d=${i}`} />
        : opened ? <Dialog item={opened} onBack={() => set("d", null)} />
        : <div className="mt-2"><DialogRows items={items} onOpen={i => set("d", String(i))} /></div>}
    </article>
  );
}
