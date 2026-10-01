import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, RotateCcw } from "lucide-react";
import { api } from "../../lab/api";
import { dialogOf } from "../../lab/dialogs";
import { when } from "../../lab/format";
import { typesOfRun } from "../../lab/logic";
import { isRunning, runTitle, useRun } from "../../lab/runs";
import type { LabRun, LabState } from "../../lab/types";
import { Facts } from "../../product/Facts";
import { Count } from "../../product/Count";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { Caps } from "../../ui/Caps";
import { Skeleton } from "../../ui/EmptyState";
import { useToast } from "../../ui/toast";
import { RunMatrix } from "./RunMatrix";
import { RunWord } from "./parts";

const enc = encodeURIComponent;

/** A run: which agent played what and how it went; its violations and dialogues open in their sections; scenario × customer type below. */
export function RunView({ summary, state, onBack }: { summary: LabRun; state: LabState; onBack?: () => void }) {
  const { refresh } = useLabState();
  const toast = useToast();
  const { data: run, isLoading, error } = useRun(summary.id, state);
  const items = run?.items ?? [];
  const m = summary.metric;
  const types = typesOfRun(run, state.personas);
  const live = isRunning(summary);
  const job = state.job.running && state.job.progress.run === summary.id ? state.job.progress : null;
  const rejudge = () => api(`/api/runs/${enc(summary.id)}/rejudge`, {}).then(() => refresh()).catch(toast.error);
  return (
    <article className="min-h-0 overflow-auto" aria-label={runTitle(summary)}>
      {onBack && <button type="button" onClick={onBack} className="sticky top-0 z-10 flex h-11 w-full items-center gap-1.5 border-b border-line bg-canvas px-3 text-body text-fg-2 lg:hidden"><ArrowLeft aria-hidden className="size-4" />Прогоны</button>}
      <div className="max-w-5xl px-4 pb-16 pt-5 lg:px-10 lg:pt-7">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><RunWord run={summary} /><span className="text-meta text-fg-3">{when(summary.startedAt)}</span></div>
        <h2 className="mt-2 text-balance text-title font-semibold text-fg">{summary.label || runTitle(summary)}</h2>
        {summary.label && <p className="mt-1 text-small text-fg-3">{runTitle(summary)}</p>}
        {summary.status === "failed" && <p className="mt-2 text-small text-bad">Прогон прервался: {summary.error}</p>}
        {live && <p className="mt-2 text-small text-run">Идёт: {job ? `${job.done ?? 0} из ${job.total ?? "…"}` : "диалоги появляются по мере готовности"}.</p>}
        <div className="mt-5">
          <Facts facts={[
            { label: "Диалогов", value: <span className="font-mono">{items.length || m?.total || 0}</span> },
            { label: "Нарушения", value: m?.measured ? <>в <Count n={m.failed} of={m.measured} bad /></> : "ещё не оценены", to: m?.measured ? `/violations?s=sim&run=${enc(summary.id)}` : undefined },
            { label: "Типы клиентов", value: types.length ? types.map(t => t.name).join(", ") : "—" },
            { label: "Повторы", value: summary.repeats && summary.repeats > 1 ? `×${summary.repeats}` : "без повторов" },
          ]} />
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          {!live && m?.measured ? <Link to={`/violations?s=sim&run=${enc(summary.id)}`}><Button variant="primary" icon={ArrowRight}>Нарушения прогона</Button></Link> : null}
          <Link to={`/dialogs?src=sim&run=${enc(summary.id)}`}><Button icon={ArrowRight}>Диалоги прогона</Button></Link>
          <Button variant="ghost" icon={RotateCcw} onClick={rejudge} disabled={state.job.running || live}
            title={state.job.running ? "Сейчас идёт другая задача" : "Судьи оценят диалоги этого прогона заново; агента не вызываем"}>Переоценить</Button>
        </div>
        <section className="mt-8" aria-label="Сценарии и типы клиентов">
          <Caps>Сценарии × типы клиентов</Caps>
          {isLoading ? <Skeleton className="mt-3 h-64" />
            : error ? <p className="mt-3 text-small text-bad">Не удалось открыть прогон: {error instanceof Error ? error.message : String(error)}</p>
            : run && items.length ? <RunMatrix run={run} items={items} hrefOf={i => dialogOf({ source: "sim", runId: summary.id, index: i })} scores />
            : <p className="mt-3 text-small text-fg-3">{live ? "Первые диалоги появятся, когда агент ответит." : "В этом прогоне не сыграно ни одного диалога."}</p>}
        </section>
      </div>
    </article>
  );
}
