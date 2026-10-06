import { cn } from "@/lib/utils";
import { exportOf, exportWords } from "../../lab/exports";
import { longDay, plural, time } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { verdictText } from "../../lab/replays";
import type { Change, ReplaySummary } from "../../lab/types";
import { CHANGE_TONE } from "./Pair";

/** What a run records when the agent's version is not known: before it was reached, or a stand that names none. */
const UNKNOWN = ["…", "не сообщается", ""];

/** «Тестовый стенд банка · версия 1.4.2 · 7 октября, 14:05»: the agent met and when; its version when it is known. */
export function replayMeta(r: ReplaySummary) {
  const version = r.version && !UNKNOWN.includes(r.version) ? `версия ${r.version}` : null;
  return [r.targetName, version, `${longDay(r.startedAt)}, ${time(r.startedAt)}`].filter(Boolean).join(" · ");
}

/** The check of the result the customers came from: its export and when it was made. */
export function useBasisWords(r: ReplaySummary | null) {
  const { state } = useLabState();
  if (!r) return "";
  const made = exportWords(exportOf(state, r.basis.export));
  return [made, r.basis.finishedAt ? `проверено ${longDay(r.basis.finishedAt)}` : null].filter(Boolean).join(", ");
}

/** The changes of the pairs, in words: «стало лучше 15 · стало хуже 1 · ошибка осталась 11 · без ошибки 3». */
const PARTS: [Change, string][] = [
  ["fixed", "стало лучше"],
  ["broken", "стало хуже"],
  ["failing", "ошибка осталась"],
  ["passing", "без ошибки"],
  ["unmeasured", "не удалось сравнить"],
];

export function ChangeLine({
  r,
  onPick,
  className,
}: {
  r: ReplaySummary;
  onPick?: (change: Change) => void;
  className?: string;
}) {
  const s = r.summary;
  const parts = PARTS.filter(([key]) => s[key] > 0);
  if (!parts.length) return null;
  return (
    <p className={cn("flex flex-wrap gap-x-4 gap-y-1 text-body", className)}>
      {parts.map(([key, word]) =>
        onPick ? (
          <button
            key={key}
            type="button"
            onClick={() => onPick(key)}
            className={cn(
              "rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
              CHANGE_TONE[key],
            )}
          >
            {word} <span className="font-semibold tabular-nums">{s[key]}</span>
          </button>
        ) : (
          <span key={key} className={CHANGE_TONE[key]}>
            {word} <span className="font-semibold tabular-nums">{s[key]}</span>
          </span>
        ),
      )}
    </p>
  );
}

/**
 * The pairs in two numbers with one denominator: the conversations with an error in the recordings and now, among the
 * same customers. Never an average with anything else: the recordings have their own result above.
 */
export function ReplayNumbers({ r, size = "page" }: { r: ReplaySummary; size?: "page" | "card" }) {
  const { before, now, pairs } = r.summary;
  const big = size === "page" ? "text-title sm:text-display" : "text-count";
  if (!pairs)
    return (
      <p className="text-read text-fg-2">
        {r.status === "running" ? "Пока ни одна пара не готова." : "Ни один разговор не удалось сравнить с записью."}
      </p>
    );
  return (
    <div>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-read text-fg-3">в записях</span>
        <span className={cn(big, "font-semibold tabular-nums text-fg-3")}>
          {before.failed}
          <span className="font-normal"> из {before.measured}</span>
        </span>
        <span aria-hidden className={cn(big, "text-fg-4")}>
          →
        </span>
        <span className="text-read text-fg-3">сейчас</span>
        <span className={cn(big, "font-semibold tabular-nums", now.failed ? "text-bad" : "text-ok")}>
          {now.failed}
          <span className="font-normal text-fg-3"> из {now.measured}</span>
        </span>
      </p>
      <p className="mt-1 text-read text-fg-2">
        {plural(pairs, "разговор", "разговора", "разговоров")} с ошибкой агента у тех же клиентов
      </p>
    </div>
  );
}

/** What may be read into the difference, said once under the numbers. */
export function VerdictLine({ r, className }: { r: ReplaySummary; className?: string }) {
  const text = verdictText(r);
  return text ? <p className={cn("text-body text-fg-3", className)}>{text}</p> : null;
}
