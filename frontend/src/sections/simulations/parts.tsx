import { cn } from "@/lib/utils";
import { isRunning } from "../../lab/runs";
import type { LabRun, Status } from "../../lab/types";

/** A conversation's result as a dot: red with an error, green without one, dashed when it could not be checked. */
export const DOT: Record<string, { word: string; cls: string }> = {
  FAIL: { word: "ошибка", cls: "bg-bad" },
  PASS: { word: "без ошибок", cls: "bg-ok" },
  RUNNING: { word: "идёт", cls: "animate-pulse bg-run" },
  UNMEASURED: { word: "не удалось проверить", cls: "border-[1.5px] border-dashed border-fg-4" },
  /** A scenario no run has played yet. */
  NONE: { word: "не играли", cls: "bg-fg-4/35" },
};
export const dotOf = (status: Status | "NONE") => DOT[status] ?? DOT.UNMEASURED;

/** One conversation as a dot; colour never stands alone: the word is beside it, in its title or for a screen reader. */
export function Dot({ status, className }: { status: Status | "NONE"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "block size-3.5 flex-shrink-0 rounded-full transition-transform duration-150",
        dotOf(status).cls,
        className,
      )}
    />
  );
}

/** A run's state as a sign and a word: running pulses, a break is red, the rest stays quiet. */
export function RunWord({ run, className }: { run: LabRun; className?: string }) {
  const [word, dot, text] = isRunning(run)
    ? ["идёт", "animate-pulse bg-run", "text-run"]
    : run.status === "failed"
      ? ["прервался", "bg-bad", "text-bad"]
      : run.status === "stopped"
        ? ["остановлен", "bg-warn", "text-warn"]
        : ["завершён", "bg-fg-3", "text-fg-3"];
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-small", text, className)}>
      <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />
      {word}
    </span>
  );
}

/** «из ошибки в диалоге» or «покрытие темы»: why the scenario exists. */
export const originWord = (origin: string, fromLog: string) =>
  origin === fromLog ? "из ошибки в диалоге" : "покрытие темы";
