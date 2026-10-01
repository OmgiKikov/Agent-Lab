import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { Activity, Play, Users } from "lucide-react";
import { plural, when } from "../../lab/format";
import { isRunning, runTitle, runTypes } from "../../lab/runs";
import type { LabRun, LabState } from "../../lab/types";
import { JobStrip } from "../../shell/Activity";
import { FirstRun } from "../../shell/FirstRun";
import { useKeys } from "../../shell/keys";
import { useLabState } from "../../shell/LabProvider";
import { SectionHeader } from "../../shell/SectionHeader";
import { Button } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Chips, Pill } from "../../ui/Pill";
import { PageTitle, SOFT, Tile, TileGrid, WithFloating } from "../../ui/Tile";
import { PlayDialog } from "./PlayDialog";
import { DialogStrip, RunPanel, RunState } from "./RunDetail";

type Filter = "done" | "live" | "broken";
const kind = (r: LabRun): Filter => (isRunning(r) ? "live" : r.status === "failed" || r.status === "stopped" ? "broken" : "done");

function RunTile({ run, state, on, onOpen }: { run: LabRun; state: LabState; on: boolean; onOpen: () => void }) {
  const job = state.job.running && state.job.progress.run === run.id ? state.job.progress : null;
  const m = run.metric;
  return (
    <Tile on={on} onClick={onOpen} className="min-h-[190px]">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5"><RunState run={run} />{runTypes(run, state).slice(0, 2).map(t => <Pill key={t} icon={Users}>{t}</Pill>)}</div>
        <span className="flex-shrink-0 text-[11px] text-lab-dim">{when(run.startedAt)}</span>
      </div>
      <div className="mt-3 line-clamp-2 text-[14px] font-medium leading-[20px] text-lab-ink" title={runTitle(run)}>{runTitle(run)}</div>
      {run.label && <div className="mt-0.5 truncate text-[12px] text-lab-dim">{run.label}</div>}
      <div className="mt-auto pt-4">
        {m ? (
          <>
            <div className="flex items-baseline gap-1.5 text-[12px] text-lab-mute">
              <span className="text-[18px] font-medium text-lab-ink">{m.total}</span>{plural(m.total, "диалог", "диалога", "диалогов")}
              {run.repeats && run.repeats > 1 && <span className="text-lab-dim">· повторы ×{run.repeats}</span>}
            </div>
            <DialogStrip total={m.total} className="mt-2" />
          </>
        ) : job ? (
          <>
            <div className="text-[12px] text-lab-accent">идёт · {job.done ?? 0} из {job.total ?? "…"}</div>
            {job.total ? <DialogStrip total={job.done ?? 0} pending={(job.total ?? 0) - (job.done ?? 0)} className="mt-2" /> : null}
          </>
        )
          : <div className="text-[12px] text-lab-faint">диалогов нет</div>}
      </div>
    </Tile>
  );
}

/** Прогоны: synthetic customers play the scenarios against the agent; each run keeps its dialogues and their traces. */
export function SimulationsPage() {
  const { runId } = useParams<{ runId?: string }>();
  const [params, setParams] = useSearchParams();
  const { state, offline } = useLabState();
  const [play, setPlay] = useState<{ preset: string[] | null } | null>(null);
  const [follow, setFollow] = useState(false);
  const [filter, setFilter] = useState<Filter | null>(null);
  const runs = useMemo(() => [...(state?.runs ?? [])].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)), [state?.runs]);
  const cards = state?.cards?.cards ?? [];
  const shown = runs.filter(r => !filter || kind(r) === filter);
  const sel = runId ?? params.get("r");
  const run = runs.find(r => r.id === sel) ?? null;
  const setRun = (id: string | null) => setParams(prev => { const n = new URLSearchParams(prev); if (id) n.set("r", id); else n.delete("r"); n.delete("d"); return n; }, { replace: true });

  // «Сыграть этот сценарий» comes with ?play=<id>, ⌘K with ?play=1: the dialog opens, nothing starts until it is confirmed.
  const asked = params.get("play");
  useEffect(() => {
    if (!asked) return;
    setPlay({ preset: asked === "1" ? null : [asked] });
    setParams(prev => { const n = new URLSearchParams(prev); n.delete("play"); return n; }, { replace: true });
  }, [asked, setParams]);

  // After «Сыграть» the run opens as soon as the service names it.
  const started = state?.job.running && state.job.kind === "run" ? state.job.progress.run : undefined;
  useEffect(() => {
    if (follow && started) { setFollow(false); setRun(started); }
  }, [follow, started]); // eslint-disable-line react-hooks/exhaustive-deps

  const at = shown.findIndex(r => r.id === sel);
  useKeys({ KeyJ: () => shown.length && setRun(shown[Math.min(shown.length - 1, at + 1)].id), KeyK: () => shown.length && setRun(shown[Math.max(0, at - 1)].id) });

  if (params.get("mode") === "scenarios") return <Navigate to="/scenarios" replace />;
  if (offline && !state) return <ServiceDown />;
  const busy = !!state?.job.running;
  const playButton = (
    <Button variant="primary" icon={Play} onClick={() => setPlay({ preset: null })} disabled={busy || !cards.length}
      title={busy ? "Сейчас идёт другая задача" : !cards.length ? "Сначала соберите сценарии" : undefined}>Сыграть</Button>
  );
  const hints = [{ title: "Клиенты-симуляторы", text: "Играют сценарии в чате с агентом, обычные и трудные." }, { title: "Трейсы", text: "Каждый диалог остаётся в Workshop со всеми вызовами." }, { title: "Что дальше", text: "Судья оценит диалоги: это блок «Результаты»." }];

  let body;
  if (!state) body = <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div>;
  else if (!runs.length) {
    body = cards.length
      ? <FirstRun here="simulations" title="Ещё ни одного прогона" action={playButton} hints={hints}>Выберите сценарии и типы клиентов, агент ответит на каждый.</FirstRun>
      : <FirstRun here="simulations" title="Для прогона нужны сценарии" action={<Link to="/scenarios"><Button variant="primary">Открыть сценарии</Button></Link>} hints={hints}>Сценарии собираются из оценённых логов.</FirstRun>;
  } else {
    body = (
      <WithFloating wide open={!!run} panel={run && <RunPanel key={run.id} summary={run} state={state} onClose={() => setRun(null)} />}>
        <PageTitle title="Прогоны" sub="синтетические клиенты играют сценарии с агентом" actions={<>
          <Link to="/runs" className={SOFT} title="Все трейсы Workshop"><Activity className="size-3.5" />Трейсы</Link>
          {playButton}
        </>} />
        <Chips<Filter> className="mt-4" value={filter} onChange={setFilter} options={[
          { value: null, label: "Все", count: runs.length },
          { value: "done", label: "Завершены", count: runs.filter(r => kind(r) === "done").length },
          ...(runs.some(r => kind(r) === "live") ? [{ value: "live" as const, label: "Идут", count: runs.filter(r => kind(r) === "live").length }] : []),
          ...(runs.some(r => kind(r) === "broken") ? [{ value: "broken" as const, label: "Прерваны", count: runs.filter(r => kind(r) === "broken").length }] : []),
        ]} />
        <div className="mt-5">
          <TileGrid>{shown.map(r => <RunTile key={r.id} run={r} state={state} on={r.id === sel} onOpen={() => setRun(r.id === sel ? null : r.id)} />)}</TileGrid>
        </div>
        <p className="mt-4 text-[11px] text-lab-faint">Квадратик — сыгранный диалог · оценка судьи и нарушения — в «Результатах» · J и K листают</p>
      </WithFloating>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <SectionHeader crumbs={[{ label: "Прогоны" }]} meta={runs.length ? `${runs.length}` : undefined} below={<JobStrip kinds={["run", "rejudge"]} />} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
      {state && <PlayDialog open={!!play} onClose={() => setPlay(null)} state={state} preset={play?.preset} onStarted={() => setFollow(true)} />}
    </div>
  );
}
