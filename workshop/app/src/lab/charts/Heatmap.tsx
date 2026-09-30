import { cn } from "@/lib/utils";
import { cellOf, type Cell, type CellState } from "../logic";
import { DEFAULT_PERSONA } from "../look";
import type { Item, Metric, Persona } from "../types";
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

function CellView({ cell, broken, label, onOpen }: { cell: Cell; broken: boolean; label: string; onOpen: () => void }) {
  const text = [
    `${label}: ${CELL_TEXT[cell.state]}${cell.total > 1 && cell.done ? ` (${cell.passed} из ${cell.done})` : ""}`,
    broken ? "обычный клиент проходит, этот тип нет" : "",
  ].filter(Boolean).join(". ");
  return (
    <Tip text={text} className="flex">
      <button
        onClick={onOpen} disabled={!cell.first} aria-label={text}
        className={cn("lab-focus relative flex h-9 w-full items-center justify-center rounded-md transition-colors duration-100 disabled:pointer-events-none", CELL[cell.state])}
      >
        <Glyph cell={cell} />
        {broken && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-lab-warn ring-2 ring-lab-panel" />}
      </button>
    </Tip>
  );
}

/**
 * Scenario × customer type, one cell per pair with all its repeats. Each column head is the service's accuracy for that
 * customer type (`metric.personas`, lab/metric.py); «Итого» counts the scenario's dialogues. The worst scenarios come first.
 * The amber dot is the reading lab/personas.py gives the types: a scenario the ordinary customer passes and this type fails.
 * A cell opens the dialogue (the failed one when repeats differ). On a narrow screen the map scrolls inside its own frame.
 */
export function Heatmap({ personas, scenarios, items, accuracy, onOpen }: {
  personas: Persona[];
  scenarios: { id: string; name: string }[];
  items: Item[];
  /** `metric.personas` of the run: the service's accuracy per customer type (present when more than one type played). */
  accuracy?: Metric["personas"];
  onOpen: (item: Item) => void;
}) {
  const cols = `minmax(150px,1.6fr) repeat(${personas.length}, minmax(64px,1fr)) 64px`;
  const rows = scenarios
    .map((s, i) => {
      const cells = personas.map(p => cellOf(items, s.id, p.id));
      return { s, i, cells, bad: cells.filter(c => c.state === "FAIL" || c.state === "MIXED").length };
    })
    .sort((a, b) => b.bad - a.bad || a.i - b.i);

  return (
    <div>
      <div className="-mx-5 overflow-x-auto px-5 pb-1 sm:mx-0 sm:overflow-visible sm:px-0 sm:pb-0">
        <div className="grid items-end gap-x-1.5 gap-y-1.5" style={{ gridTemplateColumns: cols }}>
          <div className="sticky left-0 z-10 bg-lab-panel" />
          {personas.map(persona => {
            const a = accuracy?.[persona.id];
            return (
              <div key={persona.id} className="flex flex-col items-center gap-1 pb-2 text-center" title={a ? `${persona.name}: без нарушений ${a.passed} из ${a.measured} диалогов` : persona.note}>
                <PersonaIcon id={persona.id} size={24} />
                <span className="text-caption font-medium leading-tight text-lab-text">{persona.name}</span>
                {a && <span className="text-caption tabular-nums text-lab-mute">{a.accuracy === null ? "—" : `${a.accuracy}%`}</span>}
                {a && a.accuracy !== null && <Meter value={a.accuracy} className="w-full" />}
              </div>
            );
          })}
          <div className="pb-2 text-center text-caption text-lab-mute">Итого</div>

          {rows.map(({ s, cells }) => {
            const ordinary = cellOf(items, s.id, DEFAULT_PERSONA);
            const own = items.filter(i => i.cardId === s.id && (i.status === "PASS" || i.status === "FAIL"));
            const ok = own.filter(i => i.status === "PASS").length;
            return (
              <div key={s.id} className="contents">
                <div className="sticky left-0 z-10 truncate bg-lab-panel pr-2 text-body text-lab-text" title={s.name}>{s.name}</div>
                {personas.map((p, i) => {
                  const cell = cells[i];
                  const broken = p.id !== DEFAULT_PERSONA && ordinary.state === "PASS" && cell.state === "FAIL";
                  return <CellView key={p.id} cell={cell} broken={broken} label={`${s.name} · ${p.name}`} onOpen={() => cell.first && onOpen(cell.first)} />;
                })}
                <div className="text-center text-caption tabular-nums text-lab-mute" title="Диалоги сценария без нарушений">{own.length ? `${ok} из ${own.length}` : "—"}</div>
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
