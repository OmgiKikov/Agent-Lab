import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertCircle, CheckCircle2, HelpCircle } from "lucide-react";
import type { Criterion } from "../../lab/criteria";
import { plural } from "../../lab/format";
import { secondOf } from "../../lab/problemStats";
import { useKeys } from "../../shell/keys";
import { cn } from "@/lib/utils";
import { Mark } from "../../ui/Mark";
import { Chips } from "../../ui/Pill";
import { Tile, TileGrid, WithFloating } from "../../ui/Tile";
import { Scope } from "../agent/Criteria";
import { EvidencePanel, SplitBar } from "./EvidencePanel";

type Filter = "failed" | "clean" | "unknown";

/** A criterion with its outcome on one side: the same card as in «Критерии», with how the conversations divided. */
function OutcomeTile({ c, source, on, onOpen }: { c: Criterion; source: "log" | "sim"; on: boolean; onOpen: () => void }) {
  const side = c.r[source];
  const total = side.failed + side.passed + side.unknown;
  const second = secondOf(side.examples);
  return (
    <Tile on={on} onClick={onOpen} className={cn(side.failed > 0 && !on && "border-lab-bad/[0.22]")}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5"><Scope c={c} /></div>
        <Mark n={c.n} on={on} />
      </div>
      <div className="mt-3 text-[14px] font-medium leading-[20px] text-lab-ink">{c.name}</div>
      <div className="mt-auto pt-4">
        <div className="flex items-baseline gap-1.5">
          {side.failed > 0
            ? <><span className="text-[22px] font-medium leading-[26px] tracking-[-0.5px] text-lab-bad">{side.failed}</span><span className="text-[12px] text-lab-mute">из {total} — {plural(side.failed, "нарушение", "нарушения", "нарушений")}</span></>
            : total ? <span className="text-[12px] text-lab-ok">нарушений нет · в {total} {plural(total, "разговоре", "разговорах", "разговорах")}</span>
            : <span className="text-[12px] text-lab-faint">не встречался в разговорах</span>}
        </div>
        <SplitBar className="mt-2" failed={side.failed} passed={side.passed} unknown={side.unknown} />
        {second.checked > 0 && <div className="mt-2 text-[11px] text-lab-dim">второй судья согласен в {second.agree} из {second.checked}</div>}
      </div>
    </Tile>
  );
}

/**
 * The outcome of an assessment on one side (logs or a run): a line of totals, filters, every criterion as a card
 * with its count; a card opens its evidence over the grid. `head` is the page title row.
 */
export function Outcome({ criteria, source, head, totals }: { criteria: Criterion[]; source: "log" | "sim"; head: ReactNode; totals: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter | null>(null);
  const pid = params.get("p");
  const at = Math.max(0, (Number(params.get("example")) || 1) - 1);
  const set = (edit: (n: URLSearchParams) => void) => setParams(prev => { const n = new URLSearchParams(prev); edit(n); return n; }, { replace: true });
  const open = (id: string | null) => set(n => { if (id) n.set("p", id); else n.delete("p"); n.delete("example"); });
  const sorted = [...criteria].sort((a, b) => b.r[source].failed - a.r[source].failed || a.n - b.n);
  const shown = sorted.filter(c => {
    const s = c.r[source];
    return !filter || (filter === "failed" ? s.failed > 0 : filter === "clean" ? s.failed === 0 && s.passed > 0 : s.unknown > 0);
  });
  const i = shown.findIndex(c => c.r.id === pid);
  useKeys({ KeyJ: () => shown.length && open(shown[Math.min(shown.length - 1, i + 1)].r.id), KeyK: () => shown.length && open(shown[Math.max(0, i - 1)].r.id) });
  const chosen = criteria.find(c => c.r.id === pid) ?? null;
  const count = (f: Filter) => criteria.filter(c => { const s = c.r[source]; return f === "failed" ? s.failed > 0 : f === "clean" ? s.failed === 0 && s.passed > 0 : s.unknown > 0; }).length;

  return (
    <WithFloating wide open={!!chosen} panel={chosen && <EvidencePanel key={chosen.r.id} c={chosen} source={source} at={at} onAt={n => set(p => p.set("example", String(n + 1)))} onClose={() => open(null)} />}>
      {head}
      {totals}
      <Chips<Filter> className="mt-5" value={filter} onChange={setFilter} options={[
        { value: null, label: "Все критерии", count: criteria.length },
        { value: "failed", label: "Нарушены", count: count("failed"), icon: AlertCircle },
        { value: "clean", label: "Без нарушений", count: count("clean"), icon: CheckCircle2 },
        { value: "unknown", label: "Есть неясные", count: count("unknown"), icon: HelpCircle },
      ]} />
      <div className="mt-5">
        <TileGrid>{shown.map(c => <OutcomeTile key={c.r.id} c={c} source={source} on={c.r.id === pid} onOpen={() => open(c.r.id === pid ? null : c.r.id)} />)}</TileGrid>
        {!shown.length && <p className="mt-10 text-center text-[13px] text-lab-dim">Таких критериев нет</p>}
      </div>
      <p className="mt-4 text-[11px] text-lab-faint">Номер у критерия тот же, что во вкладке «Критерии» · J и K листают критерии</p>
    </WithFloating>
  );
}

/** A line of totals: a few boxed numbers, Raindrop's way, with one thin bar under the first. */
export function Totals({ cells }: { cells: { label: string; value: ReactNode; of?: ReactNode; tone?: string; bar?: ReactNode }[] }) {
  return (
    <div className="mt-5 grid overflow-hidden rounded-[10px] border border-white/[0.08] bg-[rgb(35,35,35)] sm:grid-cols-[1.4fr_repeat(3,1fr)]">
      {cells.map((s, k) => (
        <div key={s.label} className={cn("px-4 py-3", k > 0 && "border-t border-white/[0.08] sm:border-l sm:border-t-0")}>
          <div className="text-[11px] text-lab-mute">{s.label}</div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className={cn("text-[24px] font-medium leading-[30px] tracking-[-0.5px] text-lab-ink", s.tone)}>{s.value}</span>
            {s.of && <span className="text-[12px] text-lab-dim">{s.of}</span>}
          </div>
          {s.bar}
        </div>
      ))}
    </div>
  );
}
