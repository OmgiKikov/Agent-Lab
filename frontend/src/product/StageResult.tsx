import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { pct, plural } from "../lab/format";
import { useArrived, useCountUp } from "./motion";

/**
 * The result of a stage as the one number it exists to say, the value of the measurement: the share of the checked
 * conversations without an error found (it grows as the agent gets better), with the count of those the agent erred in
 * under it — the errors to fix, the screen's one red — and the split of all of them: with an error, without one found,
 * not checked (never in the count).
 */
export function StageResult({
  failed,
  checked,
  unchecked = 0,
  size = "hero",
  link,
  all,
  important,
  delta,
  className,
}: {
  failed: number;
  checked: number;
  unchecked?: number;
  size?: "hero" | "display";
  /** Where each part's conversations open: every number leads to what it is made of. */
  link?: (part: "bad" | "ok" | "none") => string;
  /** Where all of them open, at the end of the parts. */
  all?: string;
  /** The conversations with an important criterion broken, on a line of their own: never added to the number. */
  important?: ReactNode;
  /** How the number stands to the previous check, on a line under it (checks/Compare, CompareDelta). */
  delta?: ReactNode;
  className?: string;
}) {
  const clean = Math.max(0, checked - failed);
  const share = pct(clean, checked);
  const parts = [
    { key: "bad", n: failed, word: "с ошибкой агента", dot: "bg-bad", bar: "bg-bad" },
    { key: "ok", n: clean, word: "без найденных ошибок", dot: "bg-ok", bar: "bg-ok" },
    { key: "none", n: unchecked, word: "не удалось проверить", dot: "border border-fg-4", bar: "hatch" },
  ].filter((p) => p.n > 0);
  const total = parts.reduce((s, p) => s + p.n, 0) || 1;
  const shownShare = useCountUp(share);
  const arrived = useArrived();
  return (
    <div className={className}>
      {checked > 0 ? (
        <>
          <p
            className={cn(
              "whitespace-nowrap font-semibold tabular-nums text-fg",
              size === "hero" ? "text-display sm:text-hero" : "text-page sm:text-display",
            )}
          >
            {/* The counting digits are for the eye; a screen reader hears the final number once. */}
            <span className="sr-only">{share}%</span>
            <span aria-hidden>{shownShare}%</span>
          </p>
          <p className={cn("text-fg-2", size === "hero" ? "mt-3 text-lead" : "mt-2 text-read")}>
            разговоров без найденных ошибок
          </p>
          <p className={cn("text-fg-3", size === "hero" ? "mt-1 text-read" : "mt-0.5 text-body")}>
            <span className={cn("font-semibold tabular-nums", failed ? "text-bad" : "text-fg-2")}>{failed}</span>
            {`\u00a0из\u00a0${checked} ${plural(checked, "проверенного", "проверенных", "проверенных")} — с ошибкой агента`}
          </p>
          {important}
          {delta && (
            <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-small text-fg-3">{delta}</div>
          )}
        </>
      ) : (
        // Nothing measured is not «0 из 0»: no number to show, and no «без ошибок» to imply.
        <p className={cn("font-semibold text-fg", size === "hero" ? "text-title sm:text-page" : "text-title")}>
          Ни один разговор не удалось проверить
        </p>
      )}
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
          <li key={p.key}>
            {link ? (
              <Link
                to={link(p.key as "bad" | "ok" | "none")}
                className="flex items-center gap-1.5 rounded-sm hover:text-fg hover:underline"
              >
                <span aria-hidden className={cn("size-2 rounded-full", p.dot)} />
                <span className="font-semibold tabular-nums text-fg-2">{p.n}</span> {p.word}
              </Link>
            ) : (
              <span className="flex items-center gap-1.5">
                <span aria-hidden className={cn("size-2 rounded-full", p.dot)} />
                <span className="font-semibold tabular-nums text-fg-2">{p.n}</span> {p.word}
              </span>
            )}
          </li>
        ))}
        {all && (
          <li className="ml-auto">
            <Link
              to={all}
              className="flex items-center gap-1 rounded-sm font-medium text-run hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
            >
              Все разговоры
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          </li>
        )}
      </ul>
    </div>
  );
}
