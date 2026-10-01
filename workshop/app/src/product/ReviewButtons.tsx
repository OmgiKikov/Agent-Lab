import { Check, SkipForward, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Decision, Example } from "../lab/problems";
import { Button } from "../ui/Button";

/**
 * A person's word on the judge's verdict, asked as one question: «Судья прав?». Saved at once. In a problem pressing it
 * again takes it back; in «Проверка вердиктов» it moves on, and «Пропустить» moves on without a word. V, N and → do the same.
 */
export function ReviewButtons({ example, onDecide, onSkip }: { example: Example; onDecide: (d: Decision) => void; onSkip?: () => void }) {
  const fail = example.status === "FAIL";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-body font-medium text-fg">Судья прав?</span>
      <Button size="sm" icon={Check} kbd="V" aria-pressed={example.review === "agree"} onClick={() => onDecide("agree")}
        className={cn(example.review === "agree" && "border-ok/40 bg-ok/10 text-ok hover:bg-ok/15")}>{fail ? "Да, это ошибка" : "Да, всё верно"}</Button>
      <Button size="sm" icon={X} kbd="N" aria-pressed={example.review === "disagree"} onClick={() => onDecide("disagree")}
        className={cn(example.review === "disagree" && "border-bad/40 bg-bad/10 text-bad hover:bg-bad/15")}>{fail ? "Нет, ответ верный" : "Нет, тут ошибка"}</Button>
      {onSkip && <Button size="sm" variant="ghost" icon={SkipForward} kbd="→" onClick={onSkip}>Пропустить</Button>}
      {example.review && (
        <span className="text-meta text-fg-3">
          {example.review === "agree" ? "Вы подтвердили" : "Вы не согласились"}{example.reviewScope === "dialogue" ? " для всего разговора" : ""}
        </span>
      )}
    </div>
  );
}
