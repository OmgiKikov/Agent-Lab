import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, ArrowUpRight, RotateCcw, Users } from "lucide-react";
import { api } from "../../lab/api";
import { plural, when } from "../../lab/format";
import { personaName } from "../../lab/look";
import { personaOf } from "../../lab/logic";
import { isRunning, runTitle, runTypes, useRun } from "../../lab/runs";
import type { Item, LabRun, LabState } from "../../lab/types";
import { useLabState } from "../../shell/LabProvider";
import { cn } from "@/lib/utils";
import { Button } from "../../ui/Button";
import { Conversation } from "../../ui/Conversation";
import { Skeleton } from "../../ui/EmptyState";
import { Pill } from "../../ui/Pill";
import { Caption, Floating } from "../../ui/Tile";
import { useToast } from "../../ui/toast";

/** How a run is doing, as a pill: live with a pulsing dot, finished, broken. */
export function RunState({ run }: { run: LabRun }) {
  if (isRunning(run)) return <Pill dot="rgb(166,196,205)" className="border-lab-accent/30 bg-lab-accent/[0.08] text-lab-accent [&>span:first-child]:animate-pulse">Идёт</Pill>;
  if (run.status === "failed") return <Pill dot="rgb(226,138,128)" className="border-lab-bad/30 bg-lab-bad/[0.08] text-[rgb(236,170,162)]">Прервался</Pill>;
  if (run.status === "stopped") return <Pill dot="rgb(253,186,116)">Остановлен</Pill>;
  return <Pill>Завершён</Pill>;
}

/** One square per dialogue played — no verdicts here, they are in «Результаты»; red marks a dialogue the agent did not finish. */
export function DialogStrip({ total, errors = 0, pending = 0, className }: { total: number; errors?: number; pending?: number; className?: string }) {
  const cells = [...Array(Math.max(0, total - errors)).fill("ok"), ...Array(errors).fill("err"), ...Array(pending).fill("wait")] as ("ok" | "err" | "wait")[];
  return (
    <div className={cn("flex flex-wrap gap-[3px]", className)} role="img" aria-label={`сыграно ${total}${errors ? `, с ошибкой ${errors}` : ""}${pending ? `, впереди ${pending}` : ""}`}>
      {cells.map((c, i) => <span key={i} className={cn("size-[9px] rounded-[2px]", c === "ok" ? "bg-white/[0.28]" : c === "err" ? "bg-lab-bad/80" : "border border-white/[0.16]")} />)}
    </div>
  );
}

function DialogRows({ items, onOpen }: { items: Item[]; onOpen: (i: number) => void }) {
  const personas = useLabState().state?.personas ?? [];
  const many = new Set(items.map(personaOf)).size > 1;
  return (
    <div className="overflow-hidden rounded-[10px] border border-white/[0.08]">
      {items.map((item, index) => {
        const who = [many || item.persona ? personaName(personas, item.persona) : "", item.attempt && item.attempt > 1 ? `повтор ${item.attempt}` : ""].filter(Boolean);
        return (
          <button key={index} type="button" onClick={() => onOpen(index)} className="flex w-full gap-3 border-b border-white/[0.06] bg-[rgb(35,35,35)] px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-[rgb(40,40,40)]">
            <span className={cn("mt-[5px] size-2 flex-shrink-0 rounded-[2px]", item.error ? "bg-lab-bad/80" : "bg-white/[0.28]")} title={item.error ? `Ошибка: ${item.error}` : "Сыгран"} />
            <div className="min-w-0 flex-1">
              <div title={item.name} className="truncate text-[12.5px] font-medium text-lab-ink">{item.name}</div>
              <div className="mt-0.5 truncate text-[11px] text-lab-dim">{[item.topic.split(",")[0], ...who].join(" · ")}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** A run, floating over the grid: which agent played what, its dialogues (one opens in place) and scenario × customer type. */
export function RunPanel({ summary, state, onClose }: { summary: LabRun; state: LabState; onClose: () => void }) {
  const [params, setParams] = useSearchParams();
  const { refresh } = useLabState();
  const toast = useToast();
  const { data: run, isLoading, error } = useRun(summary.id, state);
  const items = run?.items ?? [];
  const open = params.get("d");
  const opened = open !== null ? items[Number(open)] : undefined;
  const setOpen = (i: number | null) => setParams(prev => { const n = new URLSearchParams(prev); if (i === null) n.delete("d"); else n.set("d", String(i)); return n; }, { replace: true });
  const rejudge = () => api(`/api/runs/${encodeURIComponent(summary.id)}/rejudge`, {}).then(() => refresh()).catch(toast.error);
  const m = summary.metric;
  const personas = state.personas;

  return (
    <Floating wide onClose={onClose} head={<><RunState run={summary} /><span className="text-[11px] text-lab-dim">{when(summary.startedAt)}</span></>}>
      <h2 className="text-[20px] font-medium leading-[26px] tracking-[-0.4px] text-lab-ink">{runTitle(summary)}</h2>
      {summary.label && <p className="mt-1 text-[12.5px] text-lab-mute">{summary.label}</p>}
      {summary.status === "failed" && <p className="mt-2 text-[12.5px] text-lab-bad">Прогон прервался: {summary.error}</p>}
      {isRunning(summary) && <p className="mt-2 text-[12.5px] text-lab-accent">Прогон идёт: диалоги появляются по мере готовности.</p>}
      <div className="mt-3 flex flex-wrap gap-1.5">{runTypes(summary, state).map(t => <Pill key={t} icon={Users}>{t}</Pill>)}{summary.repeats && summary.repeats > 1 && <Pill>повторы ×{summary.repeats}</Pill>}</div>
      <div className="mt-4 flex flex-wrap gap-2">
        {!isRunning(summary) && <Link to={`/results?run=${encodeURIComponent(summary.id)}`}><Button variant="primary" icon={ArrowRight}>Результаты прогона</Button></Link>}
        <Button icon={RotateCcw} onClick={rejudge} disabled={state.job.running || isRunning(summary)}
          title={state.job.running ? "Сейчас идёт другая задача" : "Судьи оценят диалоги этого прогона заново; агента не вызываем"}>Переоценить</Button>
      </div>
      {(m || items.length > 0) && (
        <div className="mt-5 rounded-[10px] border border-white/[0.08] bg-[rgb(35,35,35)] px-4 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[22px] font-medium tracking-[-0.5px] text-lab-ink">{items.length || m?.total}</span>
            <span className="text-[12px] text-lab-mute">{plural(items.length || m?.total || 0, "диалог", "диалога", "диалогов")} · {new Set(items.map(i => i.cardId)).size || "…"} {plural(new Set(items.map(i => i.cardId)).size, "сценарий", "сценария", "сценариев")}</span>
          </div>
          <DialogStrip className="mt-2.5" total={items.length || m?.total || 0} errors={items.filter(i => i.error).length} />
          {items.some(i => i.error) && <div className="mt-2 text-[11px] text-lab-dim"><span className="mr-1 inline-block size-2 rounded-[2px] bg-lab-bad/80" />агент не ответил в {items.filter(i => i.error).length}</div>}
        </div>
      )}

      {opened ? (
        <div className="mt-6">
          <button type="button" onClick={() => setOpen(null)} className="inline-flex items-center gap-1.5 text-[12px] text-lab-mute hover:text-lab-text"><ArrowLeft className="size-3.5" />Все диалоги</button>
          <div className="mt-3 overflow-hidden rounded-[12px] border border-white/[0.08] bg-[rgb(33,33,33)]">
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-3.5 py-2 text-[11px] text-lab-mute">
              <span className={cn("size-2 flex-shrink-0 rounded-[2px]", opened.error ? "bg-lab-bad/80" : "bg-white/[0.28]")} />
              <span className="min-w-0 truncate">{[opened.name, opened.persona ? personaName(personas, opened.persona) : "", opened.attempt && opened.attempt > 1 ? `повтор ${opened.attempt}` : ""].filter(Boolean).join(" · ")}</span>
              {opened.runId && <Link to={`/runs/${encodeURIComponent(opened.runId)}`} title="Трейс в Workshop" className="ml-auto inline-flex flex-shrink-0 items-center gap-1 text-lab-dim hover:text-lab-text">Трейс<ArrowUpRight className="size-3.5" /></Link>}
            </div>
            <div className="px-3.5 py-3.5"><Conversation turns={opened.conversation} /></div>
          </div>
        </div>
      ) : (
        <>
          <Caption className="mt-6">Диалоги · что в них нарушено, смотрите в «Результатах»</Caption>
          <div className="mt-2">
            {isLoading ? <Skeleton className="h-64" />
              : error ? <p className="text-[12.5px] text-lab-bad">Не удалось открыть прогон: {error instanceof Error ? error.message : String(error)}</p>
              : !run || !items.length ? <Caption className="py-6 text-center">{isRunning(summary) ? "Первые диалоги появятся, когда агент ответит." : "В этом прогоне не сыграно ни одного диалога."}</Caption>
              : <DialogRows items={items} onOpen={setOpen} />}
          </div>
        </>
      )}
    </Floating>
  );
}
