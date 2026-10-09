import { Check, SkipForward, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLabState } from "../lab/LabProvider";
import { answersWait, type Decision, type Example } from "../lab/problems";
import { Button } from "../ui/Button";

/**
 * A person's word on what the checks found, asked as one plain question with two answers. Saved at once; the answer
 * stays lit, and pressing it again takes it back. In the check queue «Пропустить» moves on without a word. V, N and → do
 * the same. Big where the answer is the point of the page, small inside a list of criteria. While a check of the
 * conversations runs, the answers wait, and one line says why.
 */
export function ReviewButtons({
  example,
  onDecide,
  onSkip,
  size = "lg",
}: {
  example: Example;
  onDecide: (d: Decision) => void;
  onSkip?: () => void;
  size?: "lg" | "sm";
}) {
  const { state } = useLabState();
  const wait = answersWait(state, example);
  const fail = example.status === "FAIL";
  const yes = example.review === "agree";
  const no = example.review === "disagree";
  const big = size === "lg";
  return (
    <div className={cn("flex flex-wrap items-center", big ? "gap-3" : "gap-2")}>
      <div className="w-full min-w-0 sm:w-auto sm:flex-1">
        <p className={cn("text-fg", big ? "text-lead font-semibold" : "text-body font-medium text-fg-2")}>
          {fail ? "Это действительно ошибка?" : "Здесь действительно нет ошибки?"}
        </p>
        {wait && <p className="mt-0.5 text-small text-fg-3">{wait}</p>}
      </div>
      <div
        className={cn("grid w-full gap-2 sm:flex sm:w-auto", onSkip ? "grid-cols-3" : "grid-cols-2", big && "sm:gap-3")}
      >
        {onSkip && (
          <Button
            size={big ? "lg" : "md"}
            variant="ghost"
            icon={SkipForward}
            kbd="→"
            aria-label="Пропустить"
            onClick={onSkip}
          >
            <span className="hidden sm:inline">Пропустить</span>
          </Button>
        )}
        <Button
          size={big ? "lg" : "md"}
          icon={X}
          kbd="N"
          aria-pressed={no}
          disabled={!!wait}
          onClick={() => onDecide("disagree")}
          className={cn(big ? "sm:min-w-[104px]" : "sm:min-w-[76px]", no && "bg-bad/10 text-bad hover:bg-bad/15")}
        >
          Нет
        </Button>
        <Button
          size={big ? "lg" : "md"}
          icon={Check}
          kbd="V"
          aria-pressed={yes}
          disabled={!!wait}
          onClick={() => onDecide("agree")}
          className={cn(big ? "sm:min-w-[104px]" : "sm:min-w-[76px]", yes && "bg-ok/10 text-ok hover:bg-ok/15")}
        >
          Да
        </Button>
      </div>
    </div>
  );
}
