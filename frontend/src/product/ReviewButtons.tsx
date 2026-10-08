import { Check, SkipForward, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLabState } from "../lab/LabProvider";
import { answersWait, type Decision, type Example } from "../lab/problems";
import { Button } from "../ui/Button";

/**
 * A person's word on what the checks found, asked as one plain question with two answers. Saved at once; the answer
 * stays lit, and pressing it again takes it back. In the check queue «Пропустить» moves on without a word. V, N and →
 * do the same. While a check of the conversations runs, the answers wait, and one line says why.
 */
export function ReviewButtons({
  example,
  onDecide,
  onSkip,
  emphasis,
}: {
  example: Example;
  onDecide: (d: Decision) => void;
  onSkip?: () => void;
  emphasis?: boolean;
}) {
  const { state } = useLabState();
  const wait = answersWait(state, example);
  const fail = example.status === "FAIL";
  const yes = example.review === "agree";
  const no = example.review === "disagree";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="w-full min-w-0 sm:w-auto sm:flex-1">
        <p className="text-lead font-semibold text-fg">
          {fail ? "Это действительно ошибка?" : "Здесь действительно нет ошибки?"}
        </p>
        {wait && <p className="mt-0.5 text-small text-fg-3">{wait}</p>}
      </div>
      <div className={cn("grid w-full gap-2 sm:flex sm:w-auto sm:gap-3", onSkip ? "grid-cols-3" : "grid-cols-2")}>
        {onSkip && (
          <Button size="lg" variant="ghost" icon={SkipForward} kbd="→" aria-label="Пропустить" onClick={onSkip}>
            <span className="hidden sm:inline">Пропустить</span>
          </Button>
        )}
        <Button
          size="lg"
          icon={X}
          kbd="N"
          aria-pressed={no}
          disabled={!!wait}
          onClick={() => onDecide("disagree")}
          className={cn("sm:min-w-[104px]", no && "bg-bad/10 text-bad hover:bg-bad/15")}
        >
          Нет
        </Button>
        <Button
          size="lg"
          variant={emphasis && !yes ? "primary" : "outline"}
          icon={Check}
          kbd="V"
          aria-pressed={yes}
          disabled={!!wait}
          onClick={() => onDecide("agree")}
          className={cn("sm:min-w-[104px]", yes && "bg-ok/10 text-ok hover:bg-ok/15")}
        >
          Да
        </Button>
      </div>
    </div>
  );
}
