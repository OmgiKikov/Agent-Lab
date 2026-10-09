import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { CheckLine } from "../lab/agents";
import { longDay, pct, plural } from "../lab/format";

/**
 * The result of one check in a line: its name and date, the share without an error found as «Итог» says it, the errors
 * of measured beside it, the split as a thin bar. Each check has its own line: the two are never added up. On an
 * agent's card and on its dataset.
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
      {measured ? (
        <>
          <p className="mt-1 text-small text-fg-3">
            <span className="text-count font-semibold tabular-nums text-fg">
              {pct(Math.max(0, measured - failed), measured)}%
            </span>{" "}
            без найденных ошибок
          </p>
          <p className="text-small text-fg-3">
            <span className={cn("font-medium tabular-nums", failed ? "text-bad" : "text-fg-2")}>{failed}</span>
            {`\u00a0из\u00a0${measured} ${plural(measured, "проверенного", "проверенных", "проверенных")} — с ошибкой агента`}
          </p>
        </>
      ) : (
        <p className="mt-1 text-small text-fg-3">Ни один разговор не удалось проверить</p>
      )}
      <div className="mt-2 flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full" aria-hidden>
        {parts.map((p) => (
          <div key={p.key} className={cn("h-full rounded-full", p.cls)} style={{ width: `${(100 * p.n) / total}%` }} />
        ))}
      </div>
    </div>
  );
}
