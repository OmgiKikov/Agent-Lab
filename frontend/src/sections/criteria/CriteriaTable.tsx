import { cn } from "@/lib/utils";
import { duty, type Criterion } from "../../lab/criteria";
import { secondOf } from "../../lab/problemStats";
import { reasonText } from "../../lab/severity";
import { SeriousTag, SeveritySwitch } from "../../product/Severity";
import { nameOf, toneOf, type SideKey } from "./model";
import type { Check, Source } from "../../lab/types";

/**
 * All criteria as one list, broken first: the number, the duty, where it is written, and how it went in logs and
 * simulation; whether two checks agreed only when a second model checked them (hasSecond); and «Серьёзная» — switched
 * in the row itself, with whose mark it is under it: «модель» (its reason in the tooltip), «вы» or «не решено». A
 * decision never moves the row: the list stays where the person decides.
 */
export function CriteriaTable({
  check,
  list,
  sources,
  selected,
  onSelect,
  hasSim,
  hasSecond,
  className,
}: {
  check: Check;
  list: Criterion[];
  sources: Source[];
  selected: string | null;
  onSelect: (id: string) => void;
  hasSim: boolean;
  hasSecond: boolean;
  className?: string;
}) {
  const rows = [...list].sort(
    (a, b) => b.r.log.failed - a.r.log.failed || b.r.sim.failed - a.r.sim.failed || a.n - b.n,
  );
  const file = (id: string | null) => {
    const s = sources.find((x) => x.id === id);
    return s ? nameOf(s).file : "—";
  };
  const side = (c: Criterion, k: SideKey) => {
    const s = c.r[k];
    const tone = toneOf(c.r, k);
    return tone === "none" ? (
      <span className="text-fg-4">—</span>
    ) : (
      <span className="whitespace-nowrap tabular-nums">
        <b className={cn("font-semibold", tone === "bad" ? "text-bad" : "text-fg-2")}>{s.failed}</b>
        <span className="text-fg-3"> из {s.failed + s.passed}</span>
      </span>
    );
  };
  return (
    <div className={cn("min-h-0 overflow-auto", className)}>
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 z-10 bg-canvas">
          <tr className="border-b border-line text-small text-fg-3">
            <th className="w-14 py-2.5 pl-5 font-medium">№</th>
            <th className="py-2.5 pr-4 font-medium">Критерий</th>
            <th className="hidden py-2.5 pr-4 font-medium 2xl:table-cell">Где написан</th>
            <th className="py-2.5 pr-4 text-right font-medium">Диалоги</th>
            {hasSim && <th className="hidden py-2.5 pr-4 text-right font-medium sm:table-cell">Симуляции</th>}
            {hasSecond && (
              <th
                className="hidden py-2.5 pr-5 text-right font-medium md:table-cell"
                title="В скольких ошибках в диалогах две модели совпали"
              >
                Модели совпали
              </th>
            )}
            <th
              className="w-px whitespace-nowrap py-2.5 pr-5 text-right font-medium"
              title="Серьёзные ошибки идут первыми и считаются отдельно. Под переключателем написано, кто решил."
            >
              Серьёзная
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const second = secondOf(c.r.log.examples);
            const on = c.r.id === selected;
            // Whose mark it is, under the switch: the model's (its reason in the tooltip), the person's, or none yet.
            const { by, proposed } = c.r.severity;
            const [whose, said] =
              by === "model"
                ? ["модель", `Так считает модель.${proposed ? ` ${reasonText(proposed.reason)}` : ""}`]
                : by === "person"
                  ? ["вы", "Так решили вы."]
                  : ["не решено", "Ещё не решено."];
            return (
              <tr
                key={c.r.id}
                onClick={() => onSelect(c.r.id)}
                aria-current={on ? "true" : undefined}
                className={cn(
                  "cursor-pointer border-b border-line align-top transition-colors",
                  on ? "bg-selected" : "hover:bg-hover",
                )}
              >
                <td className="py-3 pl-5 text-small tabular-nums text-fg-3">{c.n}</td>
                <td className="py-3 pr-4">
                  <button
                    type="button"
                    onClick={() => onSelect(c.r.id)}
                    className="text-left text-body font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
                  >
                    {c.name}
                  </button>
                  {c.r.serious && <SeriousTag rule={c.r} className="relative -top-px ml-2 align-middle" />}
                  <div className="mt-0.5 line-clamp-2 text-small text-fg-3" title={duty(c.r.rule.text)}>
                    {duty(c.r.rule.text)}
                  </div>
                </td>
                <td className="hidden py-3 pr-4 font-mono text-small text-fg-3 2xl:table-cell">
                  {file(c.r.rule.sourceId)}
                </td>
                <td className="py-3 pr-4 text-right text-small">{side(c, "log")}</td>
                {hasSim && <td className="hidden py-3 pr-4 text-right text-small sm:table-cell">{side(c, "sim")}</td>}
                {hasSecond && (
                  <td className="hidden py-3 pr-5 text-right text-small tabular-nums text-fg-3 md:table-cell">
                    {second.checked ? `${second.agree} из ${second.checked}` : "—"}
                  </td>
                )}
                <td className="py-3 pr-5 text-right">
                  <SeveritySwitch check={check} rule={c.r} name={c.name} />
                  <span className="mt-1 block whitespace-nowrap text-small text-fg-3" title={said}>
                    <span aria-hidden>{whose}</span>
                    <span className="sr-only">{said}</span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
