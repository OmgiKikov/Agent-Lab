import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { reviewLink, type Check } from "../app/links";
import { answersOf, answersSentence } from "../lab/answers";
import { pct, plural } from "../lab/format";
import { FEW } from "../lab/history";
import type { ResultBrief } from "../lab/types";
import { Step, Steps, STEP_ACTION, STEP_NEXT } from "./Checklist";

/**
 * Whether the answers step is still to do: done once a person answered on 10 of the errors (all of them, when fewer),
 * the low end of what the step asks.
 */
export function answersPending(result: ResultBrief | null | undefined): boolean {
  const answers = answersOf(result);
  return !!answers && answers.confirmed + answers.removed < Math.min(10, answers.errors);
}

/**
 * The steps right under a check's number (product/Checklist), a row each, in the order they are taken: «Ваша проверка»,
 * how far it can be trusted; «Серьёзные ошибки» (`serious`, product/Severity, SeverityStatus); the main problem
 * (`problem`). How it stands to the previous check is beside the number (checks/Compare, CompareDelta). Leading a page
 * (`lead`), the first step to do has the black button. What counts is a person's answer on what the model found — two models agreeing is not proof they are
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
  problem,
  lead,
  disputed = 0,
  className,
}: {
  result: ResultBrief;
  check: Check;
  serious?: ReactNode;
  /** The step after the serious errors: the main problem to open (checks/ResultPage). */
  problem?: ReactNode;
  /** The steps lead the page: the answers, while they are to do, are its one black button. */
  lead?: boolean;
  /** The verdicts a second model gave otherwise (LAB_SECOND_MODEL): the queue asks about them first. */
  disputed?: number;
  className?: string;
}) {
  const answers = answersOf(result);
  if (!answers) return null;
  const sentence = answersSentence(answers);
  const open = answers.errors - answers.confirmed - answers.removed;
  const enough = !answersPending(result);
  const queue = reviewLink(check, { queue: "unchecked" });
  const act = lead && !enough ? STEP_NEXT : STEP_ACTION;
  const action = (label: string) => (
    <Link to={queue} className={act}>
      {label}
    </Link>
  );
  return (
    <div className={className}>
      <Steps>
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
            action={
              open > 0 ? (
                action("Проверить ещё")
              ) : (
                // Every error answered: the answers stay one step away, to look through or change.
                <Link to={reviewLink(check, { queue: "all" })} className={act}>
                  Ваши ответы
                </Link>
              )
            }
          />
        ) : answers.errors > 0 ? (
          <Step
            state="todo"
            title="Проверьте оценки модели"
            text={`Ошибки нашла модель. Ответьте «да» или «нет» ${answers.errors <= 10 ? "на каждую" : "хотя бы на 10 из них"}, и станет понятно, можно ли верить итогу.`}
            action={action("Начать")}
          />
        ) : (
          // No error found: the misses are what a person looks for, in the cases «без ошибки» the queue gives.
          answers.measured > 0 && (
            <Step
              state="todo"
              title="Проверьте несколько оценок вручную"
              text="Модель не нашла ошибок. Посмотрите несколько разговоров «без ошибки»: если ошибка там всё же есть, итог неточный."
              action={
                <Link to={queue} className={lead ? STEP_NEXT : STEP_ACTION}>
                  Начать
                </Link>
              }
            />
          )
        )}
        {serious}
        {problem}
      </Steps>
      {disputed > 0 && (
        <p className="mt-2 text-small text-fg-3">
          Вторая модель оценила иначе {disputed}
          {"\u00a0"}
          {plural(disputed, "случай", "случая", "случаев")}.{" "}
          <Link to={reviewLink(check, { queue: "disputed" })} className="font-medium text-run hover:underline">
            Разобрать спорные
          </Link>
        </p>
      )}
      {answers.measured > 0 && answers.measured < FEW && (
        <p className="mt-2 text-small text-fg-3">{`Проверено меньше ${FEW}\u00a0разговоров, поэтому вывод предварительный.`}</p>
      )}
    </div>
  );
}
