import { useState, type ReactNode } from "react";
import { Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { itemKey, scenarioStatus, scenariosOfRun, typesOfRun } from "./logic";
import { AGENT_SUBTITLE, AGENT_TITLE, HUE, STATUS_TEXT, personaLook, personaName, statusHue } from "./look";
import { NAV_GROUP_TITLE, type NavGroup, type NavItem } from "./nav";
import type { LabRun, LabState, Step } from "./types";
import { Chip, Dot, Eyebrow, StatusIcon } from "./ui";

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

function Nav({ items, step, go }: { items: NavItem[]; step: Step; go: Go }) {
  const groups = (["main", "sources"] as NavGroup[]).map(g => ({ id: g, items: items.filter(i => i.group === g) }));
  const row = (i: NavItem) => {
    const active = i.id === step;
    return (
      <button
        key={i.id} onClick={() => go(i.id)} aria-current={active ? "page" : undefined}
        className={cn("flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50", active ? "border-white/15 bg-white/[0.08] text-lab-ink" : "border-transparent text-lab-mute hover:bg-white/[0.04] hover:text-lab-text")}
      >
        {i.busy ? <Loader2 className="size-[15px] flex-shrink-0 animate-spin text-lab-accent" /> : <i.icon className="size-[15px] flex-shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{i.title}</span>
        {i.badge && <span className={cn("flex-shrink-0 font-mono text-[10px]", i.hot ? "rounded-full bg-lab-bad px-1.5 font-bold leading-4 text-black" : "text-lab-dim")}>{i.badge}</span>}
      </button>
    );
  };
  return (
    <nav className="space-y-0.5 px-2.5 pb-3" aria-label="Разделы">
      {groups.map((g, k) => (
        <div key={g.id} className={cn(k > 0 && "mt-3 border-t border-white/[0.06] pt-3")}>
          {NAV_GROUP_TITLE[g.id] && <Eyebrow className="px-2.5 pb-1.5">{NAV_GROUP_TITLE[g.id]}</Eyebrow>}
          <div className="space-y-0.5">{g.items.map(row)}</div>
        </div>
      ))}
    </nav>
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
              <button className="flex w-full items-center gap-2.5 text-left focus-visible:outline-none" onClick={() => go("dialogs", itemKey(own[0]))}>
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
                        key={itemKey(i)} onClick={() => go("dialogs", itemKey(i))}
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

function CardsList({ state, itemId, go }: { state: LabState; itemId: string | null; go: Go }) {
  return (
    <div className="min-h-0 flex-1 space-y-0.5 overflow-auto px-2 pb-2 sb">
      {(state.cards?.cards ?? []).map(c => (
        <ListItem key={c.id} selected={c.id === itemId} onClick={() => go("checks", c.id)} lead={<Dot status={c.origin === "Ошибка из лога" ? "FAIL" : "NOT_APPLICABLE"} />} title={c.name} sub={c.topic} />
      ))}
    </div>
  );
}

const LIST_TITLE: Partial<Record<Step, string>> = { dialogs: "Сценарии проверки", checks: "Сценарии" };

/** The left column: the sections, and the list that belongs to the one you are in. */
export function Rail({ state, offline, step, itemId, run, go, nav, onPalette }: {
  state: LabState | null; offline: boolean; step: Step; itemId: string | null; run: LabRun | null; go: Go; nav: NavItem[];
  onPalette: () => void;
}) {
  const showRun = step === "dialogs" && !!itemId && !!state && !!run?.items?.some(i => itemKey(i) === itemId);
  const showCards = step === "checks" && !!itemId && !!state?.cards;
  const hasList = showRun || showCards;
  return (
    <aside className="flex w-[268px] flex-shrink-0 flex-col border-r border-white/[0.06]">
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
      <Nav items={nav} step={step} go={go} />
      {hasList && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-white/[0.06] pt-3">
          <Eyebrow className="px-4 pb-2">{LIST_TITLE[step]}</Eyebrow>
          {showRun && <RunList state={state!} run={run!} itemId={itemId} go={go} />}
          {showCards && <CardsList state={state!} itemId={itemId} go={go} />}
        </div>
      )}
      {!hasList && <div className="flex-1" />}
    </aside>
  );
}
