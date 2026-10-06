import { cn } from "@/lib/utils";
import { CHECK_NAME } from "../../lab/checks";
import type { ExportCheck } from "../../lab/exports";
import { longDay } from "../../lab/format";
import type { Check } from "../../lab/types";

/**
 * A check made of an export in one line: «Tone of voice · 78 из 92 с ошибкой · 2 октября», or that it was not checked
 * by it yet. The two checks are never added up: each has its own line.
 */
export function CheckLine({ check, line, className }: { check: Check; line: ExportCheck | null; className?: string }) {
  const { failed = 0, measured = 0 } = line?.summary ?? {};
  return (
    <p className={cn("text-body text-fg-3", className)}>
      <span className="font-medium text-fg-2">{CHECK_NAME[check]}</span>
      {" · "}
      {!line ? (
        "ещё не проверяли"
      ) : measured ? (
        <>
          <span className={cn("font-semibold tabular-nums", failed ? "text-bad" : "text-fg")}>{failed}</span>
          {" из "}
          <span className="tabular-nums">{measured}</span> с ошибкой · {longDay(line.finishedAt)}
          {line.current && " · текущий итог"}
        </>
      ) : (
        <>ни один разговор не удалось проверить · {longDay(line.finishedAt)}</>
      )}
    </p>
  );
}
