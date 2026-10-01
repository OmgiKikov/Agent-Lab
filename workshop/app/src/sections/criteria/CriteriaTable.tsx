import { cn } from "@/lib/utils";
import type { Criterion } from "../../lab/criteria";
import { secondOf } from "../../lab/problemStats";
import { nameOf, toneOf, type SideKey } from "./model";
import type { Source } from "../../lab/types";

/** All criteria as one list, broken first: the number, the duty, where it is written, and how it went in logs and simulation. */
export function CriteriaTable({ list, sources, selected, onSelect, hasSim, className }: { list: Criterion[]; sources: Source[]; selected: string | null; onSelect: (id: string) => void; hasSim: boolean; className?: string }) {
  const rows = [...list].sort((a, b) => b.r.log.failed - a.r.log.failed || b.r.sim.failed - a.r.sim.failed || a.n - b.n);
  const file = (id: string | null) => { const s = sources.find(x => x.id === id); return s ? nameOf(s).file : "—"; };
  const side = (c: Criterion, k: SideKey) => {
    const s = c.r[k];
    const tone = toneOf(c.r, k);
    return tone === "none" ? <span className="text-fg-4">—</span>
      : <span className="whitespace-nowrap tabular-nums"><b className={cn("font-semibold", tone === "bad" ? "text-bad" : "text-fg-2")}>{s.failed}</b><span className="text-fg-3"> из {s.failed + s.passed}</span></span>;
  };
  return (
    <div className={cn("min-h-0 overflow-auto", className)}>
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 z-10 bg-canvas">
          <tr className="border-b border-line text-small text-fg-3">
            <th className="w-14 py-2.5 pl-5 font-medium">№</th>
            <th className="py-2.5 pr-4 font-medium">Критерий</th>
            <th className="hidden py-2.5 pr-4 font-medium 2xl:table-cell">Где написан</th>
            <th className="py-2.5 pr-4 text-right font-medium">Логи</th>
            {hasSim && <th className="hidden py-2.5 pr-4 text-right font-medium sm:table-cell">Симуляции</th>}
            <th className="hidden py-2.5 pr-5 text-right font-medium md:table-cell" title="В скольких ошибках логов две проверки совпали">Проверки совпали</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(c => {
            const second = secondOf(c.r.log.examples);
            const on = c.r.id === selected;
            return (
              <tr key={c.r.id} onClick={() => onSelect(c.r.id)} aria-selected={on}
                className={cn("cursor-pointer border-b border-line align-top transition-colors", on ? "bg-selected" : "hover:bg-hover")}>
                <td className="py-3 pl-5 text-small tabular-nums text-fg-3">{c.n}</td>
                <td className="py-3 pr-4">
                  <button type="button" onClick={() => onSelect(c.r.id)} className="text-left text-body font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">{c.name}</button>
                  <div className="mt-0.5 line-clamp-2 text-small text-fg-3" title={c.r.rule.text}>{c.r.rule.text}</div>
                </td>
                <td className="hidden py-3 pr-4 font-mono text-small text-fg-3 2xl:table-cell">{file(c.r.rule.sourceId)}</td>
                <td className="py-3 pr-4 text-right text-small">{side(c, "log")}</td>
                {hasSim && <td className="hidden py-3 pr-4 text-right text-small sm:table-cell">{side(c, "sim")}</td>}
                <td className="hidden py-3 pr-5 text-right text-small tabular-nums text-fg-3 md:table-cell">{second.checked ? `${second.agree} из ${second.checked}` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
