import { Check, SkipForward, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Decision, Example } from "../lab/problems";
import { Button } from "../ui/Button";

/**
 * A person's word on what the checks found, asked as one plain question with two answers. Saved at once; the answer
 * stays lit, and pressing it again takes it back. In the check queue «Пропустить» moves on without a word. V, N and → do
 * the same. Big where the answer is the point of the page, small inside a list of criteria.
 */
export function ReviewButtons({
  example,
  onDecide,
  onSkip,
  emphasis,
  size = "lg",
}: {
  example: Example;
  onDecide: (d: Decision) => void;
  onSkip?: () => void;
  emphasis?: boolean;
  size?: "lg" | "sm";
}) {
  const fail = example.status === "FAIL";
  const yes = example.review === "agree";
  const no = example.review === "disagree";
  const big = size === "lg";
  return (
    <div className={cn("flex flex-wrap items-center", big ? "gap-3" : "gap-2")}>
      <p
        className={cn(
          "w-full text-fg sm:mr-auto sm:w-auto",
          big ? "text-lead font-semibold" : "text-body font-medium text-fg-2",
        )}
      >
        {fail ? "Это действительно ошибка?" : "Здесь правда нет ошибки?"}
      </p>
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
          onClick={() => onDecide("disagree")}
          className={cn(big ? "sm:min-w-[104px]" : "sm:min-w-[76px]", no && "bg-bad/10 text-bad hover:bg-bad/15")}
        >
          Нет
        </Button>
        <Button
          size={big ? "lg" : "md"}
          variant={emphasis && !yes ? "primary" : "outline"}
          icon={Check}
          kbd="V"
          aria-pressed={yes}
          onClick={() => onDecide("agree")}
          className={cn(big ? "sm:min-w-[104px]" : "sm:min-w-[76px]", yes && "bg-ok/10 text-ok hover:bg-ok/15")}
        >
          Да
        </Button>
      </div>
    </div>
  );
}
