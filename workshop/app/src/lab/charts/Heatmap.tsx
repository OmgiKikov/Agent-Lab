import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { cellOf, cellShare, type Cell, type CellState } from "../logic";
import { DEFAULT_PERSONA } from "../look";
import type { Item, Persona } from "../types";
import { Meter, PersonaIcon, StatusIcon, Tip } from "../ui";

/** A pass is quiet, a failure is loud, a doubt is amber; every state also has its own glyph, so colour is never the only channel. */
const CELL: Record<CellState, string> = {
  PASS: "bg-lab-card text-lab-mute hover:bg-lab-raised",
  FAIL: "bg-lab-bad/20 text-lab-bad hover:bg-lab-bad/30",
  MIXED: "bg-lab-warn/15 text-lab-warn hover:bg-lab-warn/20",
  UNMEASURED: "bg-lab-warn/10 text-lab-warn hover:bg-lab-warn/15",
  RUNNING: "bg-lab-accent/10 text-lab-accent",
  NONE: "border border-dashed border-lab-line text-lab-faint",
};
const CELL_TEXT: Record<CellState, string> = {
  PASS: "без нарушений", FAIL: "есть нарушение", MIXED: "результат меняется от повтора к повтору", UNMEASURED: "нет данных", RUNNING: "идёт", NONE: "не играли",
};

/** The glyph inside a cell: ✓ / ✕ / ? / spinner, or «выполнено из сыгранного» when repeats disagree. */
function Glyph({ cell }: { cell: Cell }) {
  switch (cell.state) {
    case "PASS": return <StatusIcon status="PASS" size={14} />;
    case "FAIL": return <StatusIcon status="FAIL" size={16} />;
    case "MIXED": return <span className="text-body font-semibold tabular-nums">{cell.passed}/{cell.done}</span>;
    case "UNMEASURED": return <StatusIcon status="UNKNOWN" size={14} />;
    case "RUNNING": return <StatusIcon status="RUNNING" size={14} />;
    default: return <StatusIcon status="NOT_APPLICABLE" size={12} />;
  }
}

function CellView({ cell, delta, broken, label, previous, onOpen }: { cell: Cell; delta: number; broken: boolean; label: string; previous?: string; onOpen: () => void }) {
  const text = [
    `${label}: ${CELL_TEXT[cell.state]}${cell.total > 1 && cell.done ? ` (${cell.passed} из ${cell.done})` : ""}`,
    broken ? "обычный клиент проходит, этот тип нет" : "",
    delta && previous ? `в ${previous} было ${delta > 0 ? "хуже" : "лучше"}` : "",
  ].filter(Boolean).join(". ");
  return (
    <Tip text={text} className="flex">
      <button
        onClick={onOpen} disabled={!cell.first} aria-label={text}
        className={cn("lab-focus relative flex h-9 w-full items-center justify-center rounded-md transition-colors duration-100 disabled:pointer-events-none", CELL[cell.state])}
      >
        <Glyph cell={cell} />
        {broken && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-lab-warn ring-2 ring-lab-panel" />}
        {delta !== 0 && (
          <span className={cn("absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full text-lab-canvas ring-2 ring-lab-panel", delta > 0 ? "bg-lab-ok" : "bg-lab-bad")}>
            {delta > 0 ? <ArrowUp className="size-2.5" strokeWidth={3} /> : <ArrowDown className="size-2.5" strokeWidth={3} />}
          </span>
        )}
      </button>
    </Tip>
  );
}

/**
 * The facts of the map, counted once for the header of every column and for the sentence above the map:
 * how many scenario × customer type pairs were played, and in how many something is broken (a failure, or repeats that disagree).
 */
export function mapFacts(items: Item[], personas: Persona[], scenarios: { id: string }[]) {
  const per = personas.map(persona => {
    let clean = 0, broken = 0;
    for (const s of scenarios) {
      const c = cellOf(items, s.id, persona.id);
      if (c.state === "PASS") clean++;
      else if (c.state === "FAIL" || c.state === "MIXED") broken++;
    }
    return { persona, clean, broken, seen: clean + broken };
  });
  const seen = per.reduce((n, p) => n + p.seen, 0);
  const broken = per.reduce((n, p) => n + p.broken, 0);
  const mixed = personas.reduce((n, p) => n + scenarios.filter(s => cellOf(items, s.id, p.id).state === "MIXED").length, 0);
  return { per, seen, broken, mixed };
}

/**
 * Scenario × customer type. The worst scenarios come first. Each column head says how many scenarios that customer type passes cleanly;
 * a cell opens the dialogue (the failed one when repeats differ). On a narrow screen the map scrolls inside its own frame.
 */
export function Heatmap({ personas, scenarios, items, previous, previousVersion, compare, onOpen }: {
  personas: Persona[];
  scenarios: { id: string; name: string }[];
  items: Item[];
  previous?: Item[] | null;
  previousVersion?: string;
  compare?: boolean;
  onOpen: (item: Item) => void;
}) {
  const cols = `minmax(150px,1.6fr) repeat(${personas.length}, minmax(64px,1fr)) 64px`;
  const facts = mapFacts(items, personas, scenarios);
  const best = Math.max(0, ...facts.per.filter(p => p.seen).map(p => p.clean / p.seen));
  const rows = scenarios
    .map((s, i) => {
      const cells = personas.map(p => cellOf(items, s.id, p.id));
      return { s, i, cells, bad: cells.filter(c => c.state === "FAIL" || c.state === "MIXED").length };
    })
    .sort((a, b) => b.bad - a.bad || a.i - b.i);
  const showDelta = !!compare && !!previous;

  return (
    <div>
      <div className="-mx-5 overflow-x-auto px-5 pb-1 sm:mx-0 sm:overflow-visible sm:px-0 sm:pb-0">
        <div className="grid items-end gap-x-1.5 gap-y-1.5" style={{ gridTemplateColumns: cols }}>
          <div className="sticky left-0 z-10 bg-lab-panel" />
          {facts.per.map(({ persona, clean, seen }) => {
            const weak = seen > 0 && best - clean / seen >= 0.15;
            return (
              <div key={persona.id} className="flex flex-col items-center gap-1 pb-2 text-center" title={`${persona.name}: без нарушений в ${clean} из ${seen} сценариев`}>
                <PersonaIcon id={persona.id} size={24} />
                <span className="text-caption font-medium leading-tight text-lab-text">{persona.name}</span>
                <span className="text-caption tabular-nums text-lab-mute">{seen ? `${clean} из ${seen}` : "—"}</span>
                <Meter value={seen ? (100 * clean) / seen : 0} hue={weak ? "warn" : undefined} className="w-full" />
              </div>
            );
          })}
          <div className="pb-2 text-center text-caption text-lab-mute">Итого</div>

          {rows.map(({ s, cells }) => {
            const ordinary = cellOf(items, s.id, DEFAULT_PERSONA);
            const seen = cells.filter(c => c.state === "PASS" || c.state === "FAIL" || c.state === "MIXED").length;
            const ok = cells.filter(c => c.state === "PASS").length;
            return (
              <div key={s.id} className="contents">
                <div className="sticky left-0 z-10 truncate bg-lab-panel pr-2 text-body text-lab-text" title={s.name}>{s.name}</div>
                {personas.map((p, i) => {
                  const cell = cells[i];
                  const before = showDelta ? cellShare(cellOf(previous!, s.id, p.id)) : null;
                  const now = cellShare(cell);
                  const delta = before !== null && now !== null ? Math.sign(now - before) : 0;
                  const broken = p.id !== DEFAULT_PERSONA && ordinary.state === "PASS" && cell.state === "FAIL";
                  return <CellView key={p.id} cell={cell} delta={delta} broken={broken} previous={previousVersion} label={`${s.name} · ${p.name}`} onOpen={() => cell.first && onOpen(cell.first)} />;
                })}
                <div className="text-center text-caption tabular-nums text-lab-mute">{seen ? `${ok} из ${seen}` : "—"}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-lab-line pt-4 text-caption text-lab-mute">
        <Legend state="PASS">без нарушений</Legend>
        <Legend state="FAIL">есть нарушение</Legend>
        <Legend state="MIXED" text="1/2">по-разному на повторах</Legend>
        <Legend state="UNMEASURED">нет данных</Legend>
        {personas.length > 1 && <span className="inline-flex items-center gap-2"><span className="size-1.5 rounded-full bg-lab-warn" />обычный клиент проходит, этот тип нет</span>}
        {showDelta && (
          <span className="inline-flex items-center gap-2">
            <span className="flex size-4 items-center justify-center rounded-full bg-lab-ok text-lab-canvas"><ArrowUp className="size-2.5" strokeWidth={3} /></span>
            <span className="-ml-1 flex size-4 items-center justify-center rounded-full bg-lab-bad text-lab-canvas"><ArrowDown className="size-2.5" strokeWidth={3} /></span>
            лучше или хуже, чем в {previousVersion ?? "прошлой версии"}. По одному-двум диалогам это ещё не доказательство
          </span>
        )}
      </div>
    </div>
  );
}

function Legend({ state, text, children }: { state: CellState; text?: string; children: React.ReactNode }) {
  const swatch = CELL[state].split(" ").filter(c => !c.startsWith("hover:")).join(" ");
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn("flex h-5 w-8 items-center justify-center rounded-md", swatch)}>
        {text ? <span className="text-caption font-semibold tabular-nums">{text}</span> : <Glyph cell={{ state, passed: 0, done: 0, total: 0 }} />}
      </span>
      {children}
    </span>
  );
}
