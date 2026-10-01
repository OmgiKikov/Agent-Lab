import { Check, SkipForward, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Decision, Example } from "../lab/problems";
import { Button } from "../ui/Button";

/**
 * A person's word on the judge's verdict: «Верно» (V) or «Неверно» (N), saved at once; in a case pressing again takes it
 * back, in «Проверка вердиктов» it moves on, and «Пропустить» (→) moves on without a word.
 */
export function ReviewButtons({ example, onDecide, onSkip }: { example: Example; onDecide: (d: Decision) => void; onSkip?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-small text-fg-3">Вердикт верный?</span>
      <Button size="sm" icon={Check} kbd="V" showKbd aria-pressed={example.review === "agree"} onClick={() => onDecide("agree")}
        className={cn(example.review === "agree" && "border-ok/50 bg-ok/10 text-ok")}>Верно</Button>
      <Button size="sm" icon={X} kbd="N" showKbd aria-pressed={example.review === "disagree"} onClick={() => onDecide("disagree")}
        className={cn(example.review === "disagree" && "border-bad/50 bg-bad/10 text-bad")}>Неверно</Button>
      {onSkip && <Button size="sm" variant="ghost" icon={SkipForward} kbd="→" showKbd onClick={onSkip}>Пропустить</Button>}
      {example.reviewScope === "dialogue" && <span className="text-meta text-fg-3">отмечено для диалога целиком</span>}
    </div>
  );
}
