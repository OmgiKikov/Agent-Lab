import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { reviewLink, type Check } from "../app/links";
import { answersOf, answersSentence } from "../lab/answers";
import { pct, plural } from "../lab/format";
import { FEW } from "../lab/history";
import type { ResultBrief } from "../lab/types";
import { Step, Steps, STEP_ACTION } from "./Checklist";

/**
 * The steps right under a check's number (product/Checklist), a row each: «Ваша проверка», how far it can be trusted;
 * «Серьёзные ошибки» (`serious`, product/Severity, SeverityStatus); «Прошлая проверка» (`compare`, checks/Compare,
 * CompareLine). What counts is a person's answer on what the model found — two models agreeing is not proof they are
 * right (Hamel Husain, «Using LLM-as-a-judge»; Kim et al. 2025). Before any answer the row leads to giving some. From
 * the first answer it counts the same conversations with the person's answers taken in and says what they did: the
 * errors they took back, the misses they found in the cases «без ошибки», how many verdicts they checked (lab/answers).
 * It never replaces the number above. With few conversations a quiet line under the rows says the conclusion is
 * preliminary.
 */
export function Trust({
  result,
  check,
  serious,
  compare,
  compact,
  className,
}: {
  result: ResultBrief;
  check: Check;
  serious?: ReactNode;
  compare?: ReactNode;
  /** A narrow column: each row's name above it (product/Checklist). */
  compact?: boolean;
  className?: string;
}) {
  const answers = answersOf(result);
  if (!answers) return null;
  const sentence = answersSentence(answers);
  const open = answers.errors - answers.confirmed - answers.removed;
  // Done once a person answered on 10 of the errors (all of them, when fewer): the low end of what the step asks.
  const enough = answers.confirmed + answers.removed >= Math.min(10, answers.errors);
  const queue = reviewLink(check, { queue: "unchecked" });
  const action = (label: string) => (
    <Link to={queue} className={STEP_ACTION}>
      {label}
    </Link>
  );
  return (
    <div className={className}>
      <Steps compact={compact}>
        {sentence ? (
          <Step
            state={enough ? "done" : "todo"}
            title={
              <>
                {sentence.head} ошибка есть в{" "}
                <span className="whitespace-nowrap font-semibold">
                  {`${answers.counted}\u00a0из\u00a0${answers.measured}`}
                </span>{" "}
                {plural(answers.measured, "разговора", "разговоров", "разговоров")} (
                {pct(answers.counted, answers.measured)}%)
              </>
            }
            text={sentence.rest.replace(/^\.\s*/, "")}
            action={open > 0 && action("Проверить ещё")}
          />
        ) : (
          answers.errors > 0 && (
            <Step
              state="todo"
              title="Проверьте оценки модели"
              text={`Ошибки нашла модель. Ответьте «да» или «нет» ${answers.errors <= 10 ? "на каждую" : "хотя бы на 10 из них"}, и станет понятно, можно ли верить итогу.`}
              action={action("Начать")}
            />
          )
        )}
        {serious}
        {compare}
      </Steps>
      {answers.measured > 0 && answers.measured < FEW && (
        <p className="mt-2 text-small text-fg-3">{`Проверено меньше ${FEW}\u00a0разговоров, поэтому вывод предварительный.`}</p>
      )}
    </div>
  );
}
