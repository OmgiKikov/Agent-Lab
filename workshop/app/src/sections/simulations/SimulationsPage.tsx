import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Hammer, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { useWide } from "../../app/useWide";
import { api } from "../../lab/api";
import { useCriteria, type Criterion } from "../../lab/criteria";
import { day, plural, when } from "../../lab/format";
import { FROM_LOG, isRunning, runTitle } from "../../lab/runs";
import type { Card, LabRun } from "../../lab/types";
import { useKeys } from "../../app/keys";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Search } from "../../ui/Search";
import { Segmented } from "../../ui/Segmented";
import { useToast } from "../../ui/toast";
import { PlayDialog } from "./PlayDialog";
import { originWord, RunWord } from "./parts";
import { RunView } from "./RunView";
import { ScenarioView } from "./ScenarioView";

type Mode = "runs" | "scenarios";
const quoteKey = (q: string) => q.replace(/\s+/g, " ").trim().toLowerCase();

function RowButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (on) ref.current?.scrollIntoView({ block: "nearest" }); }, [on]);
  return (
    <button ref={ref} type="button" onClick={onClick} aria-current={on ? "true" : undefined}
      className={cn("relative block w-full border-b border-line py-3 pl-5 pr-4 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60",
        on ? "bg-raised before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-fg" : "hover:bg-hover")}>
      {children}
    </button>
  );
}

/**
 * «Симуляции»: synthetic customers play scenarios built from the logs against the agent. Runs with what they found,
 * scenarios with what they check; «Сыграть» starts a run, «Собрать сценарии» builds them from the last assessment.
 */
export function SimulationsPage() {
  const { state, offline, refresh } = useLabState();
  const [params, setParams] = useSearchParams();
  const wide = useWide();
  const toast = useToast();
  const { list } = useCriteria(null);
  const mode: Mode = params.get("mode") === "scenarios" ? "scenarios" : "runs";
  const [query, setQuery] = useState("");
  const [play, setPlay] = useState<{ preset: string[] | null } | null>(null);
  const [follow, setFollow] = useState(false);
  const set = (edit: (n: URLSearchParams) => void, replace = true) => setParams(prev => { const n = new URLSearchParams(prev); edit(n); return n; }, { replace });
  const runs = useMemo(() => [...(state?.runs ?? [])].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)), [state?.runs]);
  const cards = useMemo(() => state?.cards?.cards ?? [], [state?.cards]);
  const byQuote = useMemo(() => new Map(list.map(c => [quoteKey(c.r.rule.quote), c])), [list]);
  const mine = (card: Card): Criterion[] => card.criteria.flatMap(x => { const c = byQuote.get(quoteKey(x.quote)); return c ? [c] : []; }).sort((a, b) => a.n - b.n);
  const q = query.trim().toLowerCase();
  const shownRuns = runs.filter(r => !q || `${r.label ?? ""} ${runTitle(r)}`.toLowerCase().includes(q));
  const shownCards = cards.filter(c => !q || `${c.name} ${c.topic} ${c.situation} ${c.opening}`.toLowerCase().includes(q));

  // «Сыграть» from ⌘K (?play=1) or a scenario (?play=<id>) opens the dialog; nothing starts until it is confirmed.
  const asked = params.get("play");
  useEffect(() => {
    if (!asked) return;
    setPlay({ preset: asked === "1" ? null : [asked] });
    set(n => n.delete("play"));
  }, [asked]); // eslint-disable-line react-hooks/exhaustive-deps
  // After «Сыграть» the run opens as soon as the service names it.
  const started = state?.job.running && state.job.kind === "run" ? state.job.progress.run : undefined;
  useEffect(() => { if (follow && started) { setFollow(false); set(n => { n.delete("mode"); n.set("r", started); }, false); } }, [follow, started]); // eslint-disable-line react-hooks/exhaustive-deps

  const runId = params.get("r") ?? (wide && mode === "runs" ? shownRuns[0]?.id ?? null : null);
  const cardId = params.get("s") ?? (wide && mode === "scenarios" ? shownCards[0]?.id ?? null : null);
  const run = runs.find(r => r.id === runId) ?? null;
  const card = cards.find(c => c.id === cardId) ?? null;
  const ids = mode === "runs" ? shownRuns.map(r => r.id) : shownCards.map(c => c.id);
  const current = mode === "runs" ? runId : cardId;
  const pick = (id: string | null) => set(n => { const k = mode === "runs" ? "r" : "s"; if (id) n.set(k, id); else n.delete(k); }, wide);
  const step = (d: 1 | -1) => { if (!ids.length) return; const i = ids.indexOf(current ?? ""); pick(ids[Math.max(0, Math.min(ids.length - 1, (i < 0 ? -1 : i) + d))]); };
  useKeys({ KeyJ: () => step(1), KeyK: () => step(-1) });

  const busy = !!state?.job.running;
  const build = () => api("/api/cards", {}).then(() => { refresh(); toast.notify("Сценарии собираются: ход виден внизу навигации"); }).catch(toast.error);
  const header = (
    <Header title="Симуляции"
      actions={<>
        <Button icon={Hammer} onClick={build} disabled={busy || !state?.discover} className="hidden md:inline-flex"
          title={busy ? "Сейчас идёт другая задача" : !state?.discover ? "Сначала оцените логи" : "Собрать сценарии из оценённых логов"}>{cards.length ? "Собрать заново" : "Собрать сценарии"}</Button>
        <Button variant="primary" icon={Play} onClick={() => setPlay({ preset: null })} disabled={busy || !cards.length}
          title={busy ? "Сейчас идёт другая задача" : !cards.length ? "Сначала соберите сценарии" : undefined}>Сыграть</Button>
      </>}
      below={<SectionJob kinds={["run", "rejudge", "cards"]} />} />
  );
  if (offline && !state) return <div className="flex h-full flex-col">{header}<ServiceDown /></div>;
  if (!state) return <div className="flex h-full flex-col">{header}<div className="p-5"><Skeleton className="h-[480px]" /></div></div>;

  const detail = mode === "runs"
    ? run && <RunView key={run.id} summary={run} state={state} onBack={wide ? undefined : () => pick(null)} />
    : card && <ScenarioView key={card.id} card={card} state={state} mine={mine(card)} onPlay={() => setPlay({ preset: [card.id] })} onBack={wide ? undefined : () => pick(null)} />;
  const showDetail = !!detail && (wide || !!params.get(mode === "runs" ? "r" : "s"));
  const fromErrors = cards.filter(c => c.origin === FROM_LOG).length;
  return (
    <div className="flex h-full flex-col">
      {header}
      <p className="border-b border-line px-4 py-3 text-small text-fg-3 lg:px-5">
        {runs.length} {plural(runs.length, "прогон", "прогона", "прогонов")} · {cards.length} {plural(cards.length, "сценарий", "сценария", "сценариев")}{cards.length ? `, из них ${fromErrors} из ошибок в логах` : ""}{state.cards?.createdAt ? `, собраны ${day(state.cards.createdAt)}` : ""} · клиенты-симуляторы играют сценарии с агентом, судья оценивает
      </p>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[400px_minmax(0,1fr)]">
        <div className={cn("flex min-h-0 flex-col border-line bg-list lg:border-r", showDetail && !wide && "hidden")}>
          <div className="space-y-2 border-b border-line px-4 py-3">
            <Segmented<Mode> label="Что показать" value={mode} onChange={m => set(n => { if (m === "runs") n.delete("mode"); else n.set("mode", m); })} className="w-full"
              options={[{ value: "runs", label: "Прогоны", count: runs.length }, { value: "scenarios", label: "Сценарии", count: cards.length }]} />
            <Search value={query} onChange={setQuery} placeholder={mode === "runs" ? "Найти прогон" : "Найти сценарий"} />
          </div>
          <div className="min-h-0 flex-1 overflow-auto" role="list">
            {mode === "runs" ? shownRuns.map((r: LabRun) => {
              const job = state.job.running && state.job.progress.run === r.id ? state.job.progress : null;
              const m = r.metric;
              return (
                <RowButton key={r.id} on={r.id === runId} onClick={() => pick(r.id)}>
                  <span className="flex items-center gap-2"><RunWord run={r} /><span className="text-meta text-fg-3">{when(r.startedAt)}</span></span>
                  <span className="mt-1 block text-body font-medium text-fg">{r.label || runTitle(r)}</span>
                  <span className="mt-1 block text-meta text-fg-3">{r.label ? `${runTitle(r)} · ` : ""}{m ? `${m.total} ${plural(m.total, "диалог", "диалога", "диалогов")}${m.measured ? ` · нарушения в ${m.failed} из ${m.measured}` : ""}` : isRunning(r) ? "идёт" : "диалогов нет"}</span>
                  {job && job.total ? <span className="mt-2 block h-1 overflow-hidden rounded-full bg-well"><span className="block h-full rounded-full bg-run transition-[width] duration-500" style={{ width: `${Math.max(4, (100 * (job.done ?? 0)) / job.total)}%` }} /></span> : null}
                </RowButton>
              );
            }) : shownCards.map(c => (
              <RowButton key={c.id} on={c.id === cardId} onClick={() => pick(c.id)}>
                <span className="block text-meta text-fg-3">{c.topic} · <span className="text-fg-2">{originWord(c.origin, FROM_LOG)}</span></span>
                <span className="mt-1 block text-body font-medium text-fg">{c.name}</span>
                <span className="mt-1 block line-clamp-1 text-small text-fg-3">«{c.opening}»</span>
                <span className="mt-1 block text-meta text-fg-3">проверит {mine(c).length ? <span className="font-mono text-fg-2">{mine(c).map(x => x.n).join(", ")}</span> : `${c.criteria.length} ${plural(c.criteria.length, "критерий", "критерия", "критериев")}`}</span>
              </RowButton>
            ))}
            {mode === "runs" && !shownRuns.length && <p className="px-5 py-10 text-center text-small text-fg-3">{runs.length ? "Ничего не нашлось" : cards.length ? "Прогонов ещё не было: «Сыграть» справа вверху." : "Сначала соберите сценарии."}</p>}
            {mode === "scenarios" && !shownCards.length && <p className="px-5 py-10 text-center text-small text-fg-3">{cards.length ? "Ничего не нашлось" : state.discover ? "Сценариев пока нет: «Собрать сценарии»." : "Сценарии собираются из оценённых логов."}</p>}
          </div>
        </div>
        {showDetail ? detail : wide && <EmptyState drop title={mode === "runs" ? "Выберите прогон" : "Выберите сценарий"} className="justify-center">J и K листают.</EmptyState>}
      </div>
      <PlayDialog open={!!play} onClose={() => setPlay(null)} state={state} preset={play?.preset} onStarted={() => setFollow(true)} />
    </div>
  );
}
