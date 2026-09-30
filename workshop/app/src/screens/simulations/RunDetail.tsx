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
import { Chip } from "../../ui/Chip";
import { Details, type Detail } from "../../ui/Details";
import { PillTabs } from "../../ui/PillTabs";
import { Tiles } from "../../ui/Tiles";
import { TwoCol } from "../../ui/TwoCol";
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
          <button key={index} type="button" onClick={() => onOpen(index)} className="flex w-full gap-3 border-b border-white/[0.08] px-4 py-3 text-left transition-colors hover:bg-lab-hover">
            <Sign status={item.status} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div title={item.name} className="truncate text-small font-medium text-lab-ink">{item.name}</div>
              <div className="mt-0.5 truncate text-meta text-lab-mute">{[item.topic, ...who].join(" · ")}</div>
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
    <div className="px-4 py-4">
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

  const many = new Set(items.map(personaOf)).size;
  const status = isRunning(summary) ? { tone: "live" as const, word: "Идёт" } : summary.status === "failed" ? { tone: "bad" as const, word: "Прервался" } : summary.status === "stopped" ? { tone: "warn" as const, word: "Остановлен" } : { tone: "mute" as const, word: "Завершён" };
  const details: Detail[] = [
    { label: "Агент", value: summary.targetName },
    { label: "Версия", value: <span className="font-mono text-meta">{summary.version}</span> },
    { label: "Начат", value: when(summary.startedAt) },
    ...(summary.finishedAt ? [{ label: "Закончен", value: when(summary.finishedAt) }] : []),
    { label: "Типы клиентов", value: runTypes(summary, state).join(", ") },
    ...(summary.model ? [{ label: "Модель", value: <span className="font-mono text-meta">{summary.model}</span> }] : []),
  ];
  const left = (
    <>
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1.5 text-small text-lab-mute transition-colors hover:text-lab-text lg:hidden"><ArrowLeft className="size-3.5" />Прогоны</button>
      <Chip tone={status.tone}>{status.word}</Chip>
      <h1 className="mt-2.5 text-title font-medium text-lab-ink">{runTitle(summary)}</h1>
      {summary.label && <p className="mt-2 text-small text-lab-mute">{summary.label}</p>}
      {isRunning(summary) && <p className="mt-2 text-small text-lab-accent">Прогон идёт: диалоги появляются по мере готовности.</p>}
      {summary.status === "failed" && <p className="mt-2 text-small text-lab-bad">Прогон прервался: {summary.error}</p>}
      {summary.status === "stopped" && <p className="mt-2 text-small text-lab-warn">Прогон остановлен до конца.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {!isRunning(summary) && <Link to={`/results?run=${encodeURIComponent(summary.id)}`}><Button variant="primary" icon={ArrowRight}>Результаты прогона</Button></Link>}
        <Button icon={RotateCcw} onClick={rejudge} disabled={state.job.running || isRunning(summary)}
          title={state.job.running ? "Сейчас идёт другая задача" : "Судьи оценят диалоги этого прогона заново; агента не вызываем"}>Переоценить</Button>
      </div>
      <Tiles className="mt-4" tiles={[
        { label: "Диалогов", value: m ? m.total : items.length, onClick: () => set("tab", null) },
        { label: "Сценариев", value: new Set(items.map(i => i.cardId)).size, onClick: () => set("tab", "matrix") },
        { label: "Типов клиентов", value: many || runTypes(summary, state).length },
        ...(summary.repeats && summary.repeats > 1 ? [{ label: "Повторов", value: `×${summary.repeats}` }] : []),
      ]} />
      <Details rows={details} />
    </>
  );
  const right = (
    <div className="flex min-h-full flex-col">
      <div className="flex-shrink-0 border-b border-white/[0.08] px-3 py-[7px]">
        <PillTabs<Tab> value={tab} onChange={t => { set("d", null); set("tab", t === "dialogs" ? null : t); }} tabs={[
          { value: "dialogs", label: "Диалоги", count: items.length },
          { value: "matrix", label: "Сценарии × типы клиентов" },
        ]} />
      </div>
      {isLoading ? <Skeleton className="m-4 h-64" />
        : error ? <p className="p-4 text-small text-lab-bad">Не удалось открыть прогон: {error instanceof Error ? error.message : String(error)}</p>
        : !run || !items.length ? <EmptyState title="Диалогов пока нет">{isRunning(summary) ? "Первые появятся, когда агент ответит." : "В этом прогоне не сыграно ни одного диалога."}</EmptyState>
        : tab === "matrix" ? <div className="px-4 pb-10"><RunMatrix run={run} items={items} hrefOf={i => `/simulations?r=${encodeURIComponent(run.id)}&d=${i}`} /></div>
        : opened ? <Dialog item={opened} onBack={() => set("d", null)} />
        : <DialogRows items={items} onOpen={i => set("d", String(i))} />}
    </div>
  );
  return <TwoCol left={left} right={right} />;
}
