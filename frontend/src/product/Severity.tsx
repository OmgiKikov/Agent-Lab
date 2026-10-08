import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { conversationsLink, criterionLink } from "../app/links";
import { JOB_OF } from "../lab/checks";
import { useLabState } from "../lab/LabProvider";
import { count, pct, plural } from "../lab/format";
import type { Problems, RuleEntry } from "../lab/problems";
import {
  hintOf,
  pendingOf,
  PROPOSING,
  proposalCheck,
  reasonText,
  seriousOf,
  standingOf,
  useConfirmSeverity,
  useProposeSeverity,
  useSeverity,
  useSeverityBusy,
  whereText,
  whoseText,
} from "../lab/severity";
import type { Check } from "../lab/types";
import { Switch } from "../ui/Switch";
import { Tag } from "../ui/Tag";
import { Step, STEP_ACTION, STEP_NEXT } from "./Checklist";

/** A quiet action inside a line of text, as «Проверить ещё» under a check's number. */
const ACTION =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-sm font-medium text-run hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 disabled:cursor-default disabled:no-underline disabled:opacity-50";

/**
 * «серьёзная» beside a serious problem: a quiet red word in the colour of errors, never a badge that shouts. It says
 * whose decision it is: the model's, which no person has checked yet, with its reason, or the person's. On the paper of
 * a report (`paper`) in the ink of the paper.
 */
export function SeriousTag({
  rule,
  paper,
  className,
}: {
  rule?: Pick<RuleEntry, "severity">;
  paper?: boolean;
  className?: string;
}) {
  const proposed = rule?.severity.by === "model" ? rule.severity.proposed : null;
  return (
    <Tag
      tone="bad"
      title={
        proposed
          ? `Отметила модель. ${reasonText(proposed.reason)} Вы ещё не проверили.`
          : rule?.severity.by === "person"
            ? "Отметили вы. Серьёзные ошибки идут первыми и считаются отдельно."
            : "Серьёзные ошибки идут первыми и считаются отдельно."
      }
      className={cn(paper && "border-ink-bad/35 text-ink-bad", className)}
    >
      серьёзная
    </Tag>
  );
}

/**
 * «Серьёзная ошибка» on one criterion of a check: on its criteria and on its problem's page. Off, its errors are minor.
 * Pressed, it is the person's decision, whatever the automatic check proposed. In a row of a table (`name`) the words
 * go to a screen reader with the criterion's name.
 */
export function SeveritySwitch({
  check,
  rule,
  name,
  className,
}: {
  check: Check;
  rule: Pick<RuleEntry, "id" | "serious">;
  name?: string;
  className?: string;
}) {
  const mark = useSeverity();
  const busy = useSeverityBusy();
  return (
    <Switch
      checked={rule.serious}
      onChange={(serious) => {
        if (!busy) mark.mutate({ check, rule: rule.id, serious });
      }}
      label={name ? `Серьёзная ошибка: ${name}` : "Серьёзная ошибка"}
      hideLabel={!!name}
      title={
        rule.serious
          ? "Серьёзная ошибка. Такие идут первыми и считаются отдельно."
          : "Незначительная ошибка. Серьёзные идут первыми и считаются отдельно."
      }
      className={className}
    />
  );
}

/**
 * The line under a criterion's switch: whose decision it is. The model's, with its reason and «Подтвердить», which
 * makes it the person's decision; the person's own («Так решили вы.»), with the model's reason when it thought
 * otherwise; or, with neither, that nothing is decided and the error is minor for now.
 */
export function SeverityNote({
  check,
  rule,
  className,
}: {
  check: Check;
  rule: Pick<RuleEntry, "id" | "serious" | "severity">;
  className?: string;
}) {
  const mark = useSeverity();
  const busy = useSeverityBusy();
  const { by, proposed } = rule.severity;
  const cls = cn("text-small text-fg-3", className);
  if (by === "model" && proposed)
    return (
      <p className={cls}>
        Так считает модель. {reasonText(proposed.reason)}{" "}
        <button
          type="button"
          onClick={() => {
            if (!busy) mark.mutate({ check, rule: rule.id, serious: proposed.serious });
          }}
          title="Согласиться с моделью"
          className={ACTION}
        >
          Подтвердить
        </button>
      </p>
    );
  if (by === "person")
    return (
      <p className={cls}>
        Так решили вы.
        {proposed && proposed.serious !== rule.serious && <> Модель считала иначе. {reasonText(proposed.reason)}</>}
      </p>
    );
  return <p className={cls}>Ещё не решено. Пока ошибка незначительная.</p>;
}

/** A criterion's switch with its line of whose decision it is: in the criterion's panel and on its problem's page. */
export function SeverityControl({
  check,
  rule,
  className,
}: {
  check: Check;
  rule: Pick<RuleEntry, "id" | "serious" | "severity">;
  className?: string;
}) {
  return (
    <div className={className}>
      <SeveritySwitch check={check} rule={rule} />
      <SeverityNote check={check} rule={rule} className="mt-1.5" />
    </div>
  );
}

/**
 * «Отметить автоматически», or «Отметить снова» after a failure: the service's task `severity`. While this check's
 * proposal runs — that task, or the end of the check itself — the button turns, and the task is seen where every task
 * is (the task card, the line under a section's head); while another task runs, it waits.
 */
function Propose({
  check,
  again,
  why,
  className = ACTION,
}: {
  check: Check;
  again?: boolean;
  why?: string | null;
  className?: string;
}) {
  const { state } = useLabState();
  const propose = useProposeSeverity();
  const job = state?.job;
  const own =
    !!job?.running &&
    (job.kind === "severity" ? proposalCheck(job) === check : job.kind === JOB_OF[check] && !!proposalCheck(job));
  const running = propose.isPending || own;
  const other = !!job?.running && !own;
  return (
    <button
      type="button"
      onClick={() => propose.mutate(check)}
      disabled={running || other}
      title={other ? "Сейчас идёт другая задача" : running ? PROPOSING : (why ?? undefined)}
      className={className}
    >
      {running && <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />}
      {again ? "Отметить снова" : "Отметить автоматически"}
    </button>
  );
}

/** «Подтвердить все»: every proposal of the check's result becomes the person's decision. */
function ConfirmAll({ check }: { check: Check }) {
  const confirm = useConfirmSeverity();
  const busy = useSeverityBusy();
  return (
    <button
      type="button"
      onClick={() => {
        if (!busy) confirm.mutate(check);
      }}
      className={ACTION}
    >
      {confirm.isPending && <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />}
      Подтвердить все
    </button>
  );
}

/**
 * The criteria tab's one quiet line about severity, with at most one action (lab/severity, hintOf): which criteria
 * are serious and how many the person checked, with «Подтвердить все»; or why nothing is marked yet, with «Отметить
 * автоматически». Nothing once a person decided every criterion of the result.
 */
export function SeverityHint({
  check,
  data,
  className,
}: {
  check: Check;
  data: Problems | null | undefined;
  className?: string;
}) {
  const st = standingOf(data);
  const hint = st && hintOf(st);
  if (!hint) return null;
  return (
    <p className={cn("text-small text-fg-3", className)}>
      {hint.text}{" "}
      {hint.action === "confirm" ? (
        <ConfirmAll check={check} />
      ) : (
        <Propose check={check} again={hint.action === "again"} />
      )}
    </p>
  );
}

/**
 * Where the step of serious errors stands: done once nothing waits for a proposal and a person decided — on every
 * serious criterion, or, with none serious, on every criterion; else to do. Null while there is no step: no result, or
 * its serious criteria not counted yet.
 */
export function seriousStep(data: Problems | null | undefined): "todo" | "done" | null {
  const st = standingOf(data);
  if (!st || !data?.log?.assessed) return null;
  const serious = seriousOf(data);
  // Serious criteria the service has not counted yet: the row comes with their count a moment later.
  if (st.serious && !serious) return null;
  return !pendingOf(st) && (serious ? st.yours : !st.proposed) ? "done" : "todo";
}

/**
 * The step about serious errors under a check's number (product/Checklist) — «Итог» of both checks, «Обзор», the
 * step-by-step result of tone of voice. Nothing marked: «Отметьте серьёзные ошибки», what that gives, «Отметить
 * автоматически»; failed: why, «Отметить снова». Marked: «Серьёзные ошибки — 6 из 53 (11%)», opening those
 * conversations, with whose decision it is and where the criteria could be checked, and «Проверить отметки» while the
 * model's proposals wait for a person. «Серьёзных ошибок нет» with whose decision that is. Done once a person decided
 * every serious criterion. It never stands in for the number above and is never added to it.
 */
export function SeverityStatus({
  data,
  check,
  next,
}: {
  data: Problems | null | undefined;
  check: Check;
  /** The step to take next on the page: its button is the black one. */
  next?: boolean;
}) {
  const state = seriousStep(data);
  const st = standingOf(data);
  if (!state || !st) return null;
  const serious = seriousOf(data);
  const pending = pendingOf(st);
  const act = next && state === "todo" ? STEP_NEXT : STEP_ACTION;
  const propose = pending && (
    <Propose
      check={check}
      again={pending.again}
      why={serious && st.error && `Прошлая попытка не удалась. ${st.error}`}
      className={act}
    />
  );
  const review = st.proposed > 0 && (
    <Link to={criterionLink(check)} className={act}>
      Проверить отметки
    </Link>
  );
  // While the model's proposals wait for a person, the step asks to confirm them; done, it says what came of it.
  const ask = pending ? "Отметьте серьёзные ошибки" : "Подтвердите серьёзные ошибки";
  if (serious) {
    // «Серьёзная ошибка есть в 46 из 295 разговоров (16%)»: the count opens those conversations.
    const found = (
      <>
        Серьёзная ошибка есть в{" "}
        <Link
          to={conversationsLink(check, { v: "serious" })}
          title="Разговоры с серьёзной ошибкой"
          className="whitespace-nowrap rounded-sm font-semibold underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-fg-3"
        >
          {`${serious.failed}\u00a0из\u00a0${serious.measured}`}
        </Link>{" "}
        {plural(serious.measured, "разговора", "разговоров", "разговоров")} ({pct(serious.failed, serious.measured)}%)
      </>
    );
    const rest = [
      whoseText(st),
      whereText(serious),
      pending && `Ещё не решено по\u00a0${count(st.pending, "критерию", "критериям", "критериям")}.`,
    ]
      .filter(Boolean)
      .join("\n");
    return state === "done" ? (
      <Step state="done" title={found} text={rest} />
    ) : (
      <Step
        state="todo"
        title={ask}
        text={
          <>
            {found}.{"\n"}
            {rest}
          </>
        }
        action={propose || review}
      />
    );
  }
  if (pending)
    return pending.again ? (
      <Step
        state="todo"
        title="Не удалось отметить серьёзные ошибки"
        text={pending.text.replace(/^Не удалось отметить серьёзные ошибки\.\s*/, "")}
        action={propose}
      />
    ) : (
      <Step
        state="todo"
        title="Отметьте серьёзные ошибки"
        text="Модель предложит, какие критерии серьёзные, а вы подтвердите. Серьёзные проблемы встанут в начало списка и посчитаются отдельно."
        action={propose}
      />
    );
  return state === "done" ? (
    <Step state="done" title="Серьёзных ошибок нет" text={whoseText(st)} />
  ) : (
    <Step state="todo" title={ask} text={whoseText(st)} action={review} />
  );
}
