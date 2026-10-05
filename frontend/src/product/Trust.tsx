import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { reviewLink, type Check } from "../app/links";
import { answersOf, answersSentence } from "../lab/answers";
import { FEW } from "../lab/history";
import type { ResultBrief } from "../lab/types";

/**
 * The lines right under a check's number: how far it can be trusted, and how it stands to the previous check. What
 * counts is a person's answer on what the model found — two models agreeing is not proof they are right (Hamel Husain,
 * «Using LLM-as-a-judge»; Kim et al. 2025). Before any answer the first line shows the way to give some. From the first
 * answer it counts the same conversations with the person's answers taken in and says what they did: the errors they
 * took back, the misses they found in the cases «без ошибки» (from 20 of them, out of how many), how many verdicts they
 * checked (lab/answers). It never replaces the number above: that stays the check's, the one the line about the
 * previous check (`compare`, under it) sets beside its previous count. The lines of serious errors and whose decision
 * they are (`serious`, product/Severity, SeverityStatus) come first, right under the number they are part of. With
 * few conversations the last, quiet line says the conclusion is preliminary.
 */
export function Trust({
  result,
  check,
  serious,
  compare,
  className,
}: {
  result: ResultBrief;
  check: Check;
  serious?: ReactNode;
  compare?: ReactNode;
  className?: string;
}) {
  const answers = answersOf(result);
  if (!answers) return null;
  const sentence = answersSentence(answers);
  const open = answers.errors - answers.confirmed - answers.removed;
  const queue = reviewLink(check, { queue: "unchecked" });
  return (
    <div className={cn("space-y-1 text-read text-fg-2", className)}>
      {serious}
      {sentence ? (
        <p className="max-w-[72ch]">
          {sentence.head} — <span className="whitespace-nowrap font-semibold text-fg">{sentence.share}</span>
          {sentence.rest}{" "}
          {open > 0 && (
            <Link to={queue} className="font-medium text-run hover:underline">
              Проверить ещё
            </Link>
          )}
        </p>
      ) : (
        answers.errors > 0 && (
          <p>
            Ошибки нашла модель. Чтобы доверять итогу,{" "}
            <Link to={queue} className="inline-flex items-center gap-1 font-medium text-run hover:underline">
              {answers.errors <= 20 ? "проверьте их" : "проверьте 10–20 из них"}
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          </p>
        )
      )}
      {compare}
      {answers.measured > 0 && answers.measured < FEW && (
        <p className="text-fg-3">{`Проверено меньше ${FEW}\u00a0разговоров, вывод предварительный.`}</p>
      )}
    </div>
  );
}
