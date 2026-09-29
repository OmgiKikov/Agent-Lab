import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Check, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { when } from "./format";
import { itemKey, scenarioStatus, scenariosOfRun, typesOfRun } from "./logic";
import { AGENT_SUBTITLE, AGENT_TITLE, HUE, LOG_TEXT, STATUS_TEXT, personaLook, personaName, statusHue } from "./look";
import { buildSteps } from "./steps";
import type { LabRun, LabState, Status, Step } from "./types";
import { Badge, Chip, Dot, Eyebrow, StatusIcon } from "./ui";

type Go = (step: Step, item?: string | null) => void;

function ListItem({ selected, onClick, lead, title, sub, right, disabled }: { selected: boolean; onClick: () => void; lead?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; disabled?: boolean }) {
  return (
    <button
      onClick={onClick} disabled={disabled}
      className={cn(
        "w-full rounded-lg border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50",
        selected ? "border-white/[0.14] bg-white/[0.07]" : "border-transparent hover:bg-white/[0.04]", disabled && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2.5">
        {lead && <span className="mt-[5px] flex flex-shrink-0">{lead}</span>}
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[13px] leading-snug text-lab-text">{title}</div>
          {sub && <div className="mt-0.5 truncate text-[11px] text-lab-dim">{sub}</div>}
        </div>
        {right}
      </div>
    </button>
  );
}

function Stepper({ state, step, go }: { state: LabState | null; step: Step; go: Go }) {
  const steps = buildSteps(state);
  const next = steps.find(s => !s.done)?.id;
  return (
    <nav className="px-2.5 pb-3" aria-label="Шаги проверки">
      {steps.map((s, i) => {
        const active = s.id === step;
        return (
          <div key={s.id} className="relative">
            {i < steps.length - 1 && <span className="absolute left-[19px] top-[30px] h-[calc(100%-20px)] w-px bg-white/[0.09]" />}
            <button
              onClick={() => go(s.id)} aria-current={active ? "step" : undefined}
              className={cn("relative flex w-full items-start gap-3 rounded-lg border px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50", active ? "border-white/15 bg-white/[0.08]" : "border-transparent hover:bg-white/[0.04]")}
            >
              <span className={cn(
                "relative z-10 mt-px flex size-5 flex-shrink-0 items-center justify-center rounded-full border font-mono text-[10px]",
                s.busy ? "border-lab-accent/50 bg-black text-lab-accent"
                  : active ? "border-white/60 bg-black text-lab-ink"
                  : s.done ? "border-white/15 bg-black text-lab-dim" : "border-white/15 bg-black text-lab-dim",
              )}>
                {s.busy ? <Loader2 className="size-3 animate-spin" /> : s.done && !active ? <Check className="size-3" strokeWidth={2.5} /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className={cn("text-[13px] font-medium", active ? "text-lab-ink" : s.done ? "text-lab-mute" : "text-lab-soft")}>{s.title}</span>
                  {next === s.id && !active && <Badge hue="accent">дальше</Badge>}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-lab-dim">{s.value}</span>
              </span>
            </button>
          </div>
        );
      })}
    </nav>
  );
}

function NextStep({ state, step, go }: { state: LabState | null; step: Step; go: Go }) {
  const next = buildSteps(state).find(s => !s.done);
  if (!next || next.id === step) return null;
  return (
    <div className="border-t border-white/[0.06] p-3">
      <button
        onClick={() => go(next.id)}
        className="group flex w-full items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50"
      >
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-[10px] uppercase tracking-[0.09em] text-lab-accent">дальше</span>
          <span className="mt-0.5 block text-[12px] font-medium text-lab-ink">{next.cta}</span>
        </span>
        <ArrowRight className="size-3.5 flex-shrink-0 text-lab-dim transition-transform group-hover:translate-x-0.5 group-hover:text-lab-text" />
      </button>
    </div>
  );
}

const LOG_FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "Все" }, { id: "FAIL", label: "Нарушения" }, { id: "PASS", label: "Без нарушений" }, { id: "UNMEASURED", label: "Нет данных" },
];

function LogsList({ state, itemId, go }: { state: LabState; itemId: string | null; go: Go }) {
  const d = state.discover!;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: d.results.length };
    for (const r of d.results) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [d]);
  const q = query.trim().toLowerCase();
  const rows = d.results.filter(r => (filter === "all" || r.status === filter) && (!q || r.opening.toLowerCase().includes(q)));
  return (
    <>
      <div className="space-y-2.5 px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-lab-dim" />
          <input
            value={query} onChange={e => setQuery(e.target.value)} placeholder="Поиск по первой реплике"
            className="h-8 w-full rounded-lg border border-white/[0.08] bg-white/[0.04] pl-8 pr-2 text-[12px] text-lab-text outline-none placeholder:text-lab-faint focus:border-lab-accent/60 focus:ring-2 focus:ring-lab-accent/20"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {LOG_FILTERS.filter(f => f.id === "all" || counts[f.id]).map(f => <Chip key={f.id} on={filter === f.id} onClick={() => setFilter(f.id)} count={counts[f.id]}>{f.label}</Chip>)}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto px-2 pb-2 sb">
        {rows.map(r => {
          const fail = r.rules.find(x => x.status === "FAIL");
          const topic = d.topics.find(t => t.id === r.topicId)?.title ?? "";
          return (
            <ListItem key={r.dialogueId} selected={!!r.runId && r.runId === itemId} disabled={!r.runId} onClick={() => r.runId && go("logs", r.runId)}
              lead={<Dot status={r.status} quiet />} title={r.opening} sub={fail?.title || `${LOG_TEXT[r.status] ?? ""} · ${topic}`} />
          );
        })}
        {!rows.length && <div className="px-3 py-6 text-center text-[12px] text-lab-dim">Ничего не нашлось</div>}
      </div>
    </>
  );
}

function RunList({ state, run, itemId, go }: { state: LabState; run: LabRun; itemId: string | null; go: Go }) {
  const items = run.items ?? [];
  const [onlyFailed, setOnlyFailed] = useState(false);
  const current = items.find(i => itemKey(i) === itemId) ?? items.find(i => i.status !== "RUNNING") ?? items[0];
  const multi = typesOfRun(run, state.personas).length > 1;
  const failed = items.filter(i => i.status === "FAIL").length;
  const scenarios = scenariosOfRun(items).filter(s => !onlyFailed || items.some(i => i.cardId === s.id && i.status === "FAIL"));
  return (
    <>
      {failed > 0 && (
        <div className="flex gap-1.5 px-3 pb-2">
          <Chip on={!onlyFailed} onClick={() => setOnlyFailed(false)}>Все</Chip>
          <Chip on={onlyFailed} onClick={() => setOnlyFailed(true)} count={failed}>Только провалы</Chip>
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto px-2 pb-2 sb">
        {scenarios.map(({ id, name }) => {
          const own = items.filter(i => i.cardId === id);
          const status = scenarioStatus(own);
          const active = own.includes(current);
          return (
            <div key={id} className={cn("rounded-lg border px-2.5 py-2 transition-colors", active ? "border-white/[0.12] bg-white/[0.06]" : "border-transparent")}>
              <button className="flex w-full items-center gap-2.5 text-left focus-visible:outline-none" onClick={() => go("run", itemKey(own[0]))}>
                <Dot status={status} pulse={status === "RUNNING"} quiet />
                <span className="min-w-0 flex-1 truncate text-[13px] text-lab-text" title={name}>{name}</span>
              </button>
              {own.length > 1 && (
                <div className="mt-2 flex flex-wrap gap-1 pl-[18px]">
                  {own.map(i => {
                    const on = i === current;
                    const quiet = i.status === "PASS";
                    const h = HUE[statusHue(i.status)];
                    const Icon = personaLook(i.persona).icon;
                    return (
                      <button
                        key={itemKey(i)} onClick={() => go("run", itemKey(i))}
                        title={`${personaName(state.personas, i.persona)}${i.attempt && i.attempt > 1 ? ` · повтор ${i.attempt}` : ""}: ${STATUS_TEXT[i.status]}`}
                        className={cn("inline-flex h-6 min-w-[28px] items-center justify-center gap-1 rounded-md px-1.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50", quiet ? "text-lab-dim" : h.text, on ? cn(quiet ? "bg-white/[0.12]" : h.bgStrong, "ring-1 ring-current") : cn(quiet ? "bg-white/[0.04] hover:bg-white/[0.09]" : h.bg, !quiet && "hover:brightness-125"))}
                      >
                        {multi && <Icon className="size-3 opacity-70" />}
                        <StatusIcon status={i.status} size={12} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {!scenarios.length && <div className="px-3 py-6 text-center text-[12px] text-lab-dim">Провалов нет</div>}
      </div>
    </>
  );
}

const shortDate = (r: LabRun) => `${r.version} · ${when(r.startedAt)}`;

function AccuracyList({ state, run, onPickRun }: { state: LabState; run: LabRun | null; onPickRun: (id: string) => void }) {
  return (
    <div className="min-h-0 flex-1 space-y-0.5 overflow-auto px-2 pb-2 sb">
      {state.runs.map(r => (
        <ListItem
          key={r.id} selected={r.id === run?.id} onClick={() => onPickRun(r.id)}
          lead={<Dot status={r.status === "running" ? "RUNNING" : "NOT_APPLICABLE"} pulse={r.status === "running"} />}
          title={r.targetName} sub={shortDate(r)}
          right={<span className="mt-px font-mono text-[13px] text-lab-ink">{r.metric?.accuracy ?? "—"}%</span>}
        />
      ))}
    </div>
  );
}

function CardsList({ state, itemId, go }: { state: LabState; itemId: string | null; go: Go }) {
  return (
    <div className="min-h-0 flex-1 space-y-0.5 overflow-auto px-2 pb-2 sb">
      {(state.cards?.cards ?? []).map(c => (
        <ListItem key={c.id} selected={c.id === itemId} onClick={() => go("cards", c.id)} lead={<Dot status={c.origin === "Ошибка из лога" ? "FAIL" : "NOT_APPLICABLE"} />} title={c.name} sub={c.topic} />
      ))}
    </div>
  );
}

const LIST_TITLE: Record<Step, string> = { agent: "", logs: "Разговоры из логов", cards: "Сценарии", run: "Сценарии прогона", accuracy: "Прогоны" };

/** The left column: where you are, what is next, and the list that belongs to the current step. */
export function Rail({ state, offline, step, itemId, run, go, onPickRun, onPalette }: {
  state: LabState | null; offline: boolean; step: Step; itemId: string | null; run: LabRun | null; go: Go; onPickRun: (id: string) => void; onPalette: () => void;
}) {
  const showLogs = step === "logs" && state?.discover;
  const showRun = step === "run" && state && run?.items;
  const showAccuracy = step === "accuracy" && state && state.runs.length > 0;
  const showCards = step === "cards" && !!itemId && !!state?.cards;
  const hasList = !!(showLogs || showRun || showAccuracy || showCards);
  return (
    <aside className="flex w-[292px] flex-shrink-0 flex-col border-r border-white/[0.06]">
      <div className="px-4 pb-3 pt-3">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 font-mono text-[10px] text-lab-dim">
            <span className={cn("size-1.5 rounded-full", offline ? "bg-lab-bad" : "bg-lab-ok/70")} />
            {offline ? "Agent Lab недоступен" : "Agent Lab"}
          </span>
          <span className="max-w-[130px] truncate font-mono text-[10px] text-lab-dim" title={state?.model}>{state?.job.running ? "работает…" : state?.model}</span>
        </div>
        <div className="mt-2.5 text-[14px] font-medium leading-tight text-lab-ink">{AGENT_TITLE}</div>
        <div className="mt-0.5 text-[11px] text-lab-dim">{AGENT_SUBTITLE}</div>
      </div>
      <div className="px-3 pb-3">
        <button
          onClick={onPalette}
          className="flex h-8 w-full items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 text-left text-[12px] text-lab-dim transition-colors hover:border-white/[0.16] hover:text-lab-mute focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50"
        >
          <Search className="size-3.5" />Быстрый переход
          <kbd className="ml-auto rounded border border-white/15 px-1 font-mono text-[10px] leading-4">⌘K</kbd>
        </button>
      </div>
      <Stepper state={state} step={step} go={go} />
      {hasList && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-white/[0.06] pt-3">
          <Eyebrow className="px-4 pb-2">{LIST_TITLE[step]}</Eyebrow>
          {showLogs && <LogsList state={state!} itemId={itemId} go={go} />}
          {showRun && <RunList state={state!} run={run!} itemId={itemId} go={go} />}
          {showAccuracy && <AccuracyList state={state!} run={run} onPickRun={onPickRun} />}
          {showCards && <CardsList state={state!} itemId={itemId} go={go} />}
        </div>
      )}
      {!hasList && <div className="flex-1" />}
      <NextStep state={state} step={step} go={go} />
    </aside>
  );
}
