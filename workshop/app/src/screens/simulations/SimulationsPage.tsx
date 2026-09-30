import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Play } from "lucide-react";
import { when } from "../../lab/format";
import { isRunning, runTitle } from "../../lab/runs";
import { JobStrip } from "../../shell/Activity";
import { useKeys } from "../../shell/keys";
import { useLabState } from "../../shell/LabProvider";
import { SectionHeader } from "../../shell/SectionHeader";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { FirstRun } from "../../shell/FirstRun";
import { Summary } from "../../ui/Summary";
import { Split } from "../../ui/Split";
import { PlayDialog } from "./PlayDialog";
import { RunDetail } from "./RunDetail";
import { RunList } from "./SimList";

const wide = () => window.matchMedia("(min-width: 1024px)").matches;
const link = "text-small text-lab-ink underline underline-offset-4";

/** Прогоны: synthetic customers play the scenarios against the agent; each run keeps its dialogues and their traces. */
export function SimulationsPage() {
  const { runId } = useParams<{ runId?: string }>();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { state, offline } = useLabState();
  const [play, setPlay] = useState<{ preset: string[] | null } | null>(null);
  const [follow, setFollow] = useState(false);
  const runs = useMemo(() => [...(state?.runs ?? [])].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)), [state?.runs]);
  const cards = state?.cards?.cards ?? [];
  const st = params.get("st") ?? "all";
  const setParam = (k: string, v: string | null) => setParams(prev => { const n = new URLSearchParams(prev); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const shownRuns = runs.filter(r => st === "all" || (st === "live" ? isRunning(r) : st === "broken" ? r.status === "failed" || r.status === "stopped" : !isRunning(r) && r.status !== "failed" && r.status !== "stopped"));
  const sel = runId ?? params.get("r");
  const run = runs.find(r => r.id === sel);
  const setRun = (id: string | null) => setParams(prev => { const n = new URLSearchParams(prev); if (id) n.set("r", id); else n.delete("r"); n.delete("d"); n.delete("tab"); return n; }, { replace: !!id });

  useEffect(() => {
    if (!run && !sel && runs[0] && wide()) setRun(runs[0].id);
  }, [run, sel, runs[0]?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const step = (d: 1 | -1) => {
    if (!runs.length) return;
    const at = runs.findIndex(r => r.id === sel);
    setRun(runs[at < 0 ? 0 : Math.max(0, Math.min(runs.length - 1, at + d))].id);
  };
  useKeys({ KeyJ: () => step(1), ArrowDown: () => step(1), KeyK: () => step(-1), ArrowUp: () => step(-1) });

  if (params.get("mode") === "scenarios") return <Navigate to="/scenarios" replace />;
  if (offline && !state) return <ServiceDown />;
  const busy = !!state?.job.running;
  
  const playButton = (
    <Button variant="primary" icon={Play} onClick={() => setPlay({ preset: null })} disabled={busy || !cards.length}
      title={busy ? "Сейчас идёт другая задача" : !cards.length ? "Сначала соберите сценарии" : undefined}>Сыграть</Button>
  );
  const hints = [{ title: "Клиенты-симуляторы", text: "Играют сценарии в чате с агентом, обычные и трудные." }, { title: "Трейсы", text: "Каждый диалог остаётся в Workshop со всеми вызовами." }, { title: "Что дальше", text: "Судья оценит диалоги: это блок «Результаты»." }];
  const empty = cards.length
    ? <FirstRun here="simulations" title="Ещё ни одного прогона" action={playButton} hints={hints}>Выберите сценарии и типы клиентов, агент ответит на каждый.</FirstRun>
    : <FirstRun here="simulations" title="Для прогона нужны сценарии" action={<Link to="/scenarios"><Button variant="primary">Открыть сценарии</Button></Link>} hints={hints}>Сценарии собираются из оценённых логов.</FirstRun>;

  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        crumbs={[{ label: "Прогоны", to: run ? "/simulations" : undefined }, ...(run ? [{ label: runTitle(run) }] : [])]}
        actions={<>
          <Button variant="ghost" className="hidden sm:inline-flex" onClick={() => navigate("/runs")} title="Все трейсы Workshop">Трейсы</Button>
          {playButton}
        </>}
        below={<JobStrip kinds={["run", "rejudge"]} />}
      />
      {!state ? <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div> : !runs.length ? empty : (
        <>
          <Summary stats={[
            { label: "Прогонов", value: runs.length, active: st === "all", onClick: () => setParam("st", null) },
            { label: "Завершены", value: runs.filter(r => !isRunning(r) && r.status !== "failed" && r.status !== "stopped").length, of: `из ${runs.length}`, active: st === "done", onClick: () => setParam("st", "done") },
            ...(runs.some(isRunning) ? [{ label: "Идут сейчас", value: runs.filter(isRunning).length, active: st === "live", onClick: () => setParam("st", "live") }] : []),
            ...(runs.some(r => r.status === "failed" || r.status === "stopped") ? [{ label: "Прерваны", value: runs.filter(r => r.status === "failed" || r.status === "stopped").length, active: st === "broken", onClick: () => setParam("st", "broken") }] : []),
          ]} />
          <Split
            showDetail={!!run}
            list={<RunList runs={shownRuns} state={state} selectedId={run?.id ?? null} onPick={setRun} />}
            detail={run
              ? <RunDetail key={run.id} summary={run} state={state} onBack={() => setRun(null)} />
              : <EmptyState title={sel ? "Такого прогона нет" : "Выберите прогон"} action={sel ? <Link to="/simulations" className={link}>Все прогоны</Link> : undefined} />}
          />
        </>
      )}
      {state && <PlayDialog open={!!play} onClose={() => setPlay(null)} state={state} preset={play?.preset} onStarted={() => setFollow(true)} />}
    </div>
  );
}
