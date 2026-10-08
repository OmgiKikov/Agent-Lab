import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { CheckLine } from "../lab/agents";
import { longDay, plural } from "../lab/format";

/**
 * The result of one check in a line: its name and date, errors of measured, the split as a thin bar. Each check has its
 * own line: the two are never added up. On an agent's card and on its dataset.
 */
export function CheckResult({ name, line }: { name: ReactNode; line: CheckLine }) {
  const { failed, measured, unmeasured } = line;
  const parts = [
    { key: "bad", n: failed, cls: "bg-bad" },
    { key: "ok", n: Math.max(0, measured - failed), cls: "bg-ok" },
    { key: "none", n: unmeasured, cls: "hatch" },
  ].filter((p) => p.n > 0);
  const total = parts.reduce((s, p) => s + p.n, 0) || 1;
  return (
    <div>
      <p className="flex items-baseline justify-between gap-3 text-small text-fg-3">
        <span className="font-medium text-fg-2">{name}</span>
        <span>{longDay(line.finishedAt)}</span>
      </p>
      <p className="mt-1 text-small text-fg-3">
        {measured ? (
          <>
            <span className={cn("text-count font-semibold tabular-nums", failed ? "text-bad" : "text-fg")}>
              {failed}
            </span>
            {"\u00a0из\u00a0"}
            <span className="font-semibold tabular-nums text-fg">{measured}</span>{" "}
            {plural(measured, "проверенного разговора", "проверенных разговоров", "проверенных разговоров")} — с ошибкой
            агента
          </>
        ) : (
          "Ни один разговор не удалось проверить"
        )}
      </p>
      <div className="mt-2 flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full" aria-hidden>
        {parts.map((p) => (
          <div key={p.key} className={cn("h-full rounded-full", p.cls)} style={{ width: `${(100 * p.n) / total}%` }} />
        ))}
      </div>
    </div>
  );
}
