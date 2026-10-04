import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { conversationsLink, criterionLink } from "../app/links";
import { JOB_OF } from "../lab/checks";
import { useLabState } from "../lab/LabProvider";
import type { Problems, RuleEntry } from "../lab/problems";
import {
  hintOf,
  NONE_SERIOUS,
  pendingOf,
  proposedText,
  PROPOSING,
  proposingCheck,
  reasonText,
  seriousOf,
  seriousSentence,
  standingOf,
  useConfirmSeverity,
  useProposeSeverity,
  useSeverity,
  useSeverityBusy,
} from "../lab/severity";
import type { Check } from "../lab/types";
import { Switch } from "../ui/Switch";
import { Tag } from "../ui/Tag";

/** A quiet action inside a line of text, as «Проверить ещё» under a check's number. */
const ACTION =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-sm font-medium text-run hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 disabled:cursor-default disabled:no-underline disabled:opacity-50";

/**
 * «серьёзная» beside a serious problem: a quiet red word in the colour of errors, never a badge that shouts. It says
 * whose decision it is: the automatic check's proposal, which no person has checked yet, carries its reason. On the
 * paper of a report (`paper`) in the ink of the paper.
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
          ? `Предложено автоматически, человек ещё не проверил: ${reasonText(proposed.reason)}`
          : "Критерий отмечен серьёзным: его ошибки идут первыми и считаются отдельно"
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
          ? "Серьёзная ошибка: идёт первой и считается отдельно. Без отметки — незначительная."
          : "Незначительная ошибка. Отметьте серьёзной — встанет первой и получит отдельный счёт."
      }
      className={className}
    />
  );
}

/**
 * The line under a criterion's switch: whose decision it is. The automatic check's proposal with its reason, and
 * «Подтвердить», which makes the proposed value the person's decision; the person's own («Решили вы.»), with what the
 * automatic check proposed when it proposed otherwise; or, with neither, that the error is minor.
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
        Предложено автоматически: {reasonText(proposed.reason)}{" "}
        <button
          type="button"
          onClick={() => {
            if (!busy) mark.mutate({ check, rule: rule.id, serious: proposed.serious });
          }}
          title="Принять предложение: оно станет вашим решением"
          className={ACTION}
        >
          Подтвердить
        </button>
      </p>
    );
  if (by === "person")
    return (
      <p className={cls}>
        Решили вы.
        {proposed && proposed.serious !== rule.serious && (
          <>
            {" "}
            Автоматическая проверка предлагала: {proposed.serious ? "серьёзная" : "незначительная"} —{" "}
            {reasonText(proposed.reason)}
          </>
        )}
      </p>
    );
  return <p className={cls}>Без отметки ошибка незначительная.</p>;
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
 * «Предложить автоматически», or «Предложить снова» after a failure: the service's task `severity`. While this check's
 * proposal runs — that task, or the end of the check itself — the button turns, and the task is seen where every task
 * is (the task card, the line under a section's head); while another task runs, it waits.
 */
function Propose({ check, again, why }: { check: Check; again?: boolean; why?: string | null }) {
  const { state } = useLabState();
  const propose = useProposeSeverity();
  const job = state?.job;
  const own =
    !!job?.running &&
    (job.kind === "severity"
      ? (proposingCheck() ?? check) === check
      : job.kind === JOB_OF[check] && job.progress.message === PROPOSING);
  const running = propose.isPending || own;
  const other = !!job?.running && !own;
  return (
    <button
      type="button"
      onClick={() => propose.mutate(check)}
      disabled={running || other}
      title={other ? "Сейчас идёт другая задача" : running ? PROPOSING : (why ?? undefined)}
      className={ACTION}
    >
      {running && <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />}
      {again ? "Предложить снова" : "Предложить автоматически"}
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
 * The criteria tab's one quiet line about severity, with at most one action (lab/severity, hintOf): the automatic
 * check's proposals with «Подтвердить все», or why nothing is proposed yet with «Предложить». Nothing once a person
 * decided every criterion of the result.
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
 * Under a check's number — «Итог» of both checks, «Обзор», the step-by-step result of tone of voice. Once a criterion
 * is serious: «С серьёзными ошибками — 6 из 53 (11%): по 2 критериям, которые считаются серьёзными; …» — the same
 * checked conversations, the count opens them; «вы отметили» only when a person decided every serious criterion. While
 * some criteria are the automatic check's proposals: «Какие серьёзные, предложила автоматическая проверка; вы проверили
 * 3 из 8 критериев. Проверить»; while some have neither: «ещё не решено по 2 критериям» and «Предложить
 * автоматически». With no serious criterion: «Ни один критерий не считается серьёзным.», or why it is not decided yet
 * and the way to propose. It never stands in for the number above and is never added to it.
 */
export function SeverityStatus({ data, check }: { data: Problems | null | undefined; check: Check }) {
  const st = standingOf(data);
  if (!st || !data?.log?.assessed) return null;
  const serious = seriousOf(data);
  const proposed = proposedText(st);
  const whose: ReactNode = proposed && (
    <>
      {" "}
      {proposed}{" "}
      <Link to={criterionLink(check)} className="font-medium text-run hover:underline">
        Проверить
      </Link>
    </>
  );
  if (serious) {
    const s = seriousSentence(serious);
    return (
      <p className="max-w-[72ch]">
        {s.head} —{" "}
        <Link
          to={conversationsLink(check, { v: "serious" })}
          title="Разговоры с серьёзной ошибкой"
          className="whitespace-nowrap rounded-sm font-semibold text-fg underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-fg-3"
        >
          {s.share}
        </Link>
        {s.rest}
        {serious.pending > 0 && (
          <>
            {" "}
            <Propose check={check} why={st.error && `Прошлое предложение не удалось: ${st.error}`} />
          </>
        )}
        {whose}
      </p>
    );
  }
  // Serious criteria the service has not counted yet: the line comes with its count a moment later.
  if (st.serious) return null;
  const pending = pendingOf(st);
  if (pending)
    return (
      <p className="max-w-[72ch]">
        {pending.text} <Propose check={check} again={pending.again} />
      </p>
    );
  return (
    <p className="max-w-[72ch]">
      {NONE_SERIOUS}
      {whose}
    </p>
  );
}
