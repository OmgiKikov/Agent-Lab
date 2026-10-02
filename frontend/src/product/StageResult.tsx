import { cn } from "@/lib/utils";
import { pct, plural } from "../lab/format";
import { useArrived, useCountUp } from "./motion";

/**
 * The result of a stage as the one number it exists to say: in how many of the checked conversations the agent erred,
 * its share, and the split of all of them — with an error, without one found, not checked (never in the count).
 * The error count is the screen's one red.
 */
export function StageResult({
  failed,
  checked,
  unchecked = 0,
  size = "hero",
  className,
}: {
  failed: number;
  checked: number;
  unchecked?: number;
  size?: "hero" | "display";
  className?: string;
}) {
  const clean = Math.max(0, checked - failed);
  const parts = [
    { key: "bad", n: failed, word: "с ошибкой агента", dot: "bg-bad", bar: "bg-bad" },
    { key: "ok", n: clean, word: "без найденных ошибок", dot: "bg-ok", bar: "bg-ok" },
    { key: "none", n: unchecked, word: "не удалось проверить", dot: "border border-fg-4", bar: "hatch" },
  ].filter((p) => p.n > 0);
  const total = parts.reduce((s, p) => s + p.n, 0) || 1;
  const shownFailed = useCountUp(failed);
  const shownChecked = useCountUp(checked);
  const arrived = useArrived();
  return (
    <div className={className}>
      <p
        className={cn(
          "whitespace-nowrap font-semibold tabular-nums text-fg",
          size === "hero" ? "text-display sm:text-hero" : "text-page sm:text-display",
        )}
        aria-label={`${failed} из ${checked}`}
      >
        <span aria-hidden className={failed ? "text-bad" : "text-fg"}>
          {shownFailed}
        </span>
        <span aria-hidden className="font-normal text-fg-3">
          {" "}
          из{" "}
        </span>
        <span aria-hidden>{shownChecked}</span>
      </p>
      <p className={cn("text-fg-2", size === "hero" ? "mt-3 text-lead" : "mt-2 text-read")}>
        {plural(checked, "проверенного разговора", "проверенных разговоров", "проверенных разговоров")} — с ошибкой
        агента
        {checked > 0 && (
          <span className="text-fg-3">
            {"\u00a0·\u00a0"}
            {pct(failed, checked)}%
          </span>
        )}
      </p>
      <div
        className={cn(
          "flex w-full gap-[3px] overflow-hidden rounded-full",
          size === "hero" ? "mt-6 h-2.5" : "mt-4 h-2",
        )}
        role="img"
        aria-label={parts.map((p) => `${p.word}: ${p.n}`).join(", ")}
      >
        {parts.map((p) => (
          <div
            key={p.key}
            className={cn(
              "h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none",
              p.bar,
            )}
            style={{ width: arrived ? `${(100 * p.n) / total}%` : "0%" }}
          />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-small text-fg-3">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <span aria-hidden className={cn("size-2 rounded-full", p.dot)} />
            <span className="font-semibold tabular-nums text-fg-2">{p.n}</span> {p.word}
          </li>
        ))}
      </ul>
    </div>
  );
}
