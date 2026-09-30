import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Hammer, Play } from "lucide-react";
import { api } from "../../lab/api";
import { runTitle } from "../../lab/runs";
import { JobStrip } from "../../shell/Activity";
import { useKeys } from "../../shell/keys";
import { useLabState } from "../../shell/LabProvider";
import { SectionHeader, type Crumb } from "../../shell/SectionHeader";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Split } from "../../ui/Split";
import { useToast } from "../../ui/toast";
import { PlayDialog } from "./PlayDialog";
import { RunDetail } from "./RunDetail";
import { ScenarioDetail } from "./ScenarioDetail";
import { ModeBar, RunList, ScenarioList, type Mode } from "./SimList";

const wide = () => window.matchMedia("(min-width: 1024px)").matches;

/** Симуляции: the runs of the simulated customer against the agent, and the scenarios it plays. */
export function SimulationsPage() {
  const { runId, scenarioId } = useParams<{ runId?: string; scenarioId?: string }>();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { state, offline, refresh } = useLabState();
  const toast = useToast();
  const [play, setPlay] = useState<{ preset: string[] | null } | null>(null);
  const [follow, setFollow] = useState(false);
  const mode: Mode = scenarioId ? "scenarios" : runId ? "runs" : params.get("mode") === "scenarios" ? "scenarios" : "runs";
  const runs = useMemo(() => [...(state?.runs ?? [])].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)), [state?.runs]);
  const cards = useMemo(() => state?.cards?.cards ?? [], [state?.cards]);
  const run = runId ? runs.find(r => r.id === runId) : undefined;
  const card = scenarioId ? cards.find(c => c.id === scenarioId) : undefined;
  const ids = mode === "runs" ? runs.map(r => r.id) : cards.map(c => c.id);
  const selectedId = mode === "runs" ? runId ?? null : scenarioId ?? null;
  const pathOf = (id: string) => (mode === "runs" ? `/simulations/runs/${encodeURIComponent(id)}` : `/simulations/scenarios/${encodeURIComponent(id)}`);
  const home = mode === "runs" ? "/simulations" : "/simulations?mode=scenarios";

  useEffect(() => {
    if (!selectedId && ids[0] && wide()) navigate(pathOf(ids[0]), { replace: true });
  }, [selectedId, ids[0], mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ⌘K «Сыграть сценарии» comes with ?play=1: the dialog opens, nothing starts until it is confirmed.
  useEffect(() => {
    if (params.get("play") !== "1") return;
    setPlay({ preset: null });
    setParams(prev => { const n = new URLSearchParams(prev); n.delete("play"); return n; }, { replace: true });
  }, [params, setParams]);

  // After «Сыграть» the run opens as soon as the service names it.
  const started = state?.job.running && state.job.kind === "run" ? state.job.progress.run : undefined;
  useEffect(() => {
    if (follow && started) { setFollow(false); navigate(`/simulations/runs/${encodeURIComponent(started)}`); }
  }, [follow, started, navigate]);

  const step = (d: 1 | -1) => {
    if (!ids.length) return;
    const at = ids.indexOf(selectedId ?? "");
    navigate(pathOf(ids[at < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, at + d))]));
  };
  useKeys({ KeyJ: () => step(1), ArrowDown: () => step(1), KeyK: () => step(-1), ArrowUp: () => step(-1) });

  if (offline && !state) return <ServiceDown />;
  const busy = !!state?.job.running;
  const build = () => api("/api/cards", {}).then(() => refresh()).catch(toast.error);
  const crumbs: Crumb[] = [{ label: "Симуляции", to: selectedId ? home : undefined }];
  if (run) crumbs.push({ label: runTitle(run) });
  if (card) crumbs.push({ label: card.name });
  const head = <ModeBar mode={mode} onMode={m => navigate(m === "runs" ? "/simulations" : "/simulations?mode=scenarios")} runs={runs.length} scenarios={cards.length} />;
  const buildButton = (
    <Button icon={Hammer} onClick={build} disabled={busy || !state?.discover} title={busy ? "Сейчас идёт другая задача" : !state?.discover ? "Сначала оцените логи в «Проблемах»" : "Собрать сценарии из последней оценки логов"}>
      Собрать сценарии
    </Button>
  );

  const detail = () => {
    if (!state) return null;
    if (mode === "runs") {
      if (run) return <RunDetail key={run.id} summary={run} state={state} onBack={() => navigate(home)} />;
      if (runId) return <EmptyState title="Такого прогона нет" action={<Link to="/simulations" className="text-small text-lab-ink underline underline-offset-4">Все прогоны</Link>} />;
      return cards.length
        ? <EmptyState drop title="Прогонов пока нет" action={<Button variant="primary" icon={Play} disabled={busy} onClick={() => setPlay({ preset: null })}>Сыграть</Button>}>Синтетический клиент сыграет сценарии с агентом, судья оценит каждый диалог по правилам.</EmptyState>
        : <EmptyState drop title="Сначала нужны сценарии" action={buildButton}>Сценарии собираются из оценки логов: для каждой найденной ошибки и темы — ситуация, которую сыграет синтетический клиент.</EmptyState>;
    }
    if (card) return <ScenarioDetail key={card.id} card={card} state={state} onBack={() => navigate(home)} onPlay={() => setPlay({ preset: [card.id] })} />;
    if (scenarioId) return <EmptyState title="Такого сценария нет" action={<Link to="/simulations?mode=scenarios" className="text-small text-lab-ink underline underline-offset-4">Все сценарии</Link>}>Сценарии могли собрать заново.</EmptyState>;
    return (
      <EmptyState drop title="Сценариев пока нет" action={buildButton}>
        Сценарии собираются из оценки логов: для каждой найденной ошибки и темы — ситуация, первая реплика клиента и правила, которые проверит судья.
      </EmptyState>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        crumbs={crumbs}
        actions={<>
          <span className="hidden sm:contents">{buildButton}</span>
          <Button variant="primary" icon={Play} onClick={() => setPlay({ preset: null })} disabled={busy || !cards.length} title={busy ? "Сейчас идёт другая задача" : !cards.length ? "Сначала соберите сценарии" : undefined}>Сыграть</Button>
        </>}
        below={<JobStrip kinds={["run", "rejudge", "cards"]} />}
      />
      {!state ? <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div> : (
        <Split
          showDetail={!!selectedId}
          list={mode === "runs"
            ? <RunList runs={runs} state={state} selectedId={selectedId} onPick={id => navigate(pathOf(id))} head={head} />
            : <ScenarioList cards={cards} selectedId={selectedId} onPick={id => navigate(pathOf(id))} head={head} />}
          detail={detail()}
        />
      )}
      {state && <PlayDialog open={!!play} onClose={() => setPlay(null)} state={state} preset={play?.preset} onStarted={() => setFollow(true)} />}
    </div>
  );
}
