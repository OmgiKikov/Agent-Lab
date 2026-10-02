import { cn } from "@/lib/utils";
import { isRunning } from "../../lab/runs";
import type { LabRun } from "../../lab/types";

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

/** Why the scenario exists: «из ошибки в диалоге» or the name of its set («представительный набор»). */
export const originWord = (origin: string, fromLog: string) =>
  origin === fromLog ? "из ошибки в диалоге" : origin.toLowerCase();
