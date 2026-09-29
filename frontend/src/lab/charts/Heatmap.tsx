import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { cellOf, cellShare, type Cell, type CellState } from "../logic";
import { DEFAULT_PERSONA } from "../look";
import type { Item, Persona } from "../types";
import { PersonaIcon, StatusIcon, Tip } from "../ui";

const CELL: Record<CellState, string> = {
  PASS: "bg-white/[0.035] text-lab-faint hover:bg-white/[0.08]",
  FAIL: "bg-lab-bad/20 text-lab-bad hover:bg-lab-bad/30",
  MIXED: "bg-lab-warn/15 text-lab-warn hover:bg-lab-warn/25",
  UNMEASURED: "bg-white/[0.035] text-lab-dim hover:bg-white/[0.08]",
  RUNNING: "bg-lab-accent/10 text-lab-accent",
  NONE: "bg-white/[0.02] text-lab-faint",
};
const CELL_TEXT: Record<CellState, string> = { PASS: "выполнены все критерии", FAIL: "есть провал", MIXED: "результат меняется от повтора к повтору", UNMEASURED: "не измерено", RUNNING: "идёт", NONE: "не играли" };

function CellView({ cell, delta, broken, label, onOpen }: { cell: Cell; delta: number; broken: boolean; label: string; onOpen: () => void }) {
  const text = `${label}: ${CELL_TEXT[cell.state]}${cell.total > 1 && cell.done ? ` (${cell.passed} из ${cell.done})` : ""}`;
  return (
    <Tip text={text} className="flex">
      <button
        onClick={onOpen} disabled={!cell.first} aria-label={text}
        className={cn("relative flex h-8 w-full items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lab-accent/60", CELL[cell.state])}
      >
        {cell.state === "MIXED"
          ? <span className="font-mono text-[11.5px] font-medium">{cell.passed}/{cell.done}</span>
          : cell.state === "NONE" ? <span className="text-[13px]">·</span>
          : <StatusIcon status={cell.state === "UNMEASURED" ? "UNKNOWN" : cell.state} size={cell.state === "FAIL" ? 15 : 13} />}
        {broken && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-lab-warn ring-2 ring-[#0a0a0a]" />}
        {delta !== 0 && (
          <span className={cn("absolute bottom-1 right-1 flex size-3.5 items-center justify-center rounded-full text-black", delta > 0 ? "bg-lab-ok" : "bg-lab-bad")}>
            {delta > 0 ? <ArrowUp className="size-2.5" strokeWidth={3} /> : <ArrowDown className="size-2.5" strokeWidth={3} />}
          </span>
        )}
      </button>
    </Tip>
  );
}

/**
 * Scenario × customer type. Every cell is one state (pass / fail / mixed / not measured), always with an icon,
 * so colour is never the only channel. Column heads carry the accuracy of that customer type.
 */
export function Heatmap({ personas, scenarios, items, previous, accuracy, compare, onOpen }: {
  personas: Persona[];
  scenarios: { id: string; name: string }[];
  items: Item[];
  previous?: Item[] | null;
  accuracy?: Record<string, { accuracy: number | null }>;
  compare?: boolean;
  onOpen: (item: Item) => void;
}) {
  const cols = `minmax(170px,1.5fr) repeat(${personas.length}, minmax(76px,1fr)) 56px`;
  return (
    <div>
      <div className="grid items-end gap-x-1.5 gap-y-1.5" style={{ gridTemplateColumns: cols }}>
        <div />
        {personas.map(p => {
          const value = accuracy?.[p.id]?.accuracy;
                    return (
            <div key={p.id} className="flex flex-col items-center gap-1.5 pb-1 text-center">
              <PersonaIcon id={p.id} size={26} />
              <span className="text-[12px] leading-tight text-lab-soft">{p.name}</span>
              <span className="flex w-full items-center gap-1.5">
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.07]"><span className="block h-full rounded-full bg-lab-mute" style={{ width: `${value ?? 0}%` }} /></span>
                <span className="w-8 text-right font-mono text-[11px] text-lab-text">{value ?? "—"}%</span>
              </span>
            </div>
          );
        })}
        <div className="pb-1 text-center font-mono text-[10.5px] uppercase tracking-[0.09em] text-lab-dim">итого</div>

        {scenarios.map(s => {
          const ordinary = cellOf(items, s.id, DEFAULT_PERSONA);
          const cells = personas.map(p => cellOf(items, s.id, p.id));
          const ok = cells.filter(c => c.state === "PASS").length;
          const seen = cells.filter(c => c.state !== "NONE" && c.state !== "UNMEASURED").length;
          return (
            <div key={s.id} className="contents">
              <div className="truncate pr-2 text-[13px] text-lab-text" title={s.name}>{s.name}</div>
              {personas.map((p, i) => {
                const cell = cells[i];
                const before = compare && previous ? cellShare(cellOf(previous, s.id, p.id)) : null;
                const now = cellShare(cell);
                const delta = before !== null && now !== null ? Math.sign(now - before) : 0;
                const broken = p.id !== DEFAULT_PERSONA && ordinary.state === "PASS" && cell.state === "FAIL";
                return <CellView key={p.id} cell={cell} delta={delta} broken={broken} label={`${s.name} · ${p.name}`} onOpen={() => cell.first && onOpen(cell.first)} />;
              })}
              <div className="text-center font-mono text-[11.5px] text-lab-mute">{seen ? `${ok}/${seen}` : "—"}</div>
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/[0.06] pt-4 text-[12px] text-lab-dim">
        <Legend cls={CELL.PASS} icon="PASS">выполнены критерии</Legend>
        <Legend cls={CELL.FAIL} icon="FAIL">провал</Legend>
        <Legend cls={CELL.MIXED} text="1/2">по-разному в повторах</Legend>
        <Legend cls={CELL.UNMEASURED} icon="UNKNOWN">не измерено</Legend>
        <span className="inline-flex items-center gap-2"><span className="size-1.5 rounded-full bg-lab-warn" />обычный клиент проходит, этот тип — нет</span>
        {compare && previous && <span className="inline-flex items-center gap-2"><span className="flex size-3.5 items-center justify-center rounded-full bg-lab-ok text-black"><ArrowUp className="size-2.5" strokeWidth={3} /></span><span className="flex size-3.5 items-center justify-center rounded-full bg-lab-bad text-black"><ArrowDown className="size-2.5" strokeWidth={3} /></span>лучше или хуже прошлого прогона</span>}
      </div>
    </div>
  );
}

function Legend({ cls, icon, text, children }: { cls: string; icon?: string; text?: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn("flex h-5 w-7 items-center justify-center rounded-md", cls.split(" ").filter(c => !c.startsWith("hover:")).join(" "))}>
        {icon ? <StatusIcon status={icon} size={11} /> : <span className="font-mono text-[10px]">{text}</span>}
      </span>
      {children}
    </span>
  );
}
