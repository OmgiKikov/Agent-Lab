import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { criterionLink } from "../app/links";
import { JOB_OF } from "../lab/checks";
import { useLabState } from "../lab/LabProvider";
import { importantByPerson, type Problems, type RuleEntry } from "../lab/problems";
import {
  hintOf,
  importantWord,
  PROPOSING,
  proposalCheck,
  reasonText,
  standingOf,
  useConfirmSeverity,
  useProposeSeverity,
  useSeverity,
  useSeverityBusy,
  type Serious,
} from "../lab/severity";
import type { Check } from "../lab/types";
import { Switch } from "../ui/Switch";
import { Tag } from "../ui/Tag";

/** A quiet action inside a line of text, as «Проверить ещё» under a check's number. */
const ACTION =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-sm font-medium text-run hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 disabled:cursor-default disabled:no-underline disabled:opacity-50";

/** What an important criterion is, and what marking one changes: said beside the switch and the tag. */
export const IMPORTANT =
  "Важный критерий — одно его нарушение может навредить клиенту или банку. Отмеченные вами идут первыми, а «Итог» отдельно считает разговоры, где нарушен важный критерий.";

/**
 * The word beside the problem of an important criterion (lab/severity, importantWord): «важный», a quiet red word in
 * the colour of errors when a person marked it, never a badge that shouts; «важный по мнению модели», grey and dashed,
 * while it is the model's proposal no person has checked yet, with its reason. On the paper of a report (`paper`) in
 * the ink of the paper.
 */
export function SeriousTag({
  rule,
  paper,
  className,
}: {
  rule: Pick<RuleEntry, "serious" | "severity">;
  paper?: boolean;
  className?: string;
}) {
  const word = importantWord(rule);
  if (!word) return null;
  if (!importantByPerson(rule)) {
    const reason = rule.severity.proposed?.reason;
    return (
      <Tag
        title={`Так считает модель.${reason ? ` ${reasonText(reason)}` : ""} Вы ещё не проверили.`}
        className={cn("border-dashed", paper && "border-ink-line text-ink-2", className)}
      >
        {word}
      </Tag>
    );
  }
  return (
    <Tag
      tone="bad"
      title={`Отметили вы. ${IMPORTANT}`}
      className={cn(paper && "border-ink-bad/35 text-ink-bad", className)}
    >
      {word}
    </Tag>
  );
}

/**
 * «важные предложила модель», after the count of the conversations with an important criterion broken: that count
 * rests on the model's proposals, wholly or in part, until a person confirms or changes them on «Критерии», where it
 * leads. Shown only for a count that rests on a proposal (`serious.proposed`).
 */
export function ProposedImportant({ check, serious }: { check: Check; serious: Serious }) {
  return (
    <Link to={criterionLink(check)} className="whitespace-nowrap rounded-sm font-medium text-run hover:underline">
      {serious.proposed < serious.marked ? "часть важных предложила модель" : "важные предложила модель"}
    </Link>
  );
}

/**
 * «Важный критерий» on one criterion of a check: on its criteria and on its problem's page. Off, it is an ordinary one.
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
      label={name ? `Важный критерий: ${name}` : "Важный критерий"}
      hideLabel={!!name}
      title={IMPORTANT}
      className={className}
    />
  );
}

/**
 * The line under a criterion's switch, only where it tells something the switch does not: the model's proposal, with
 * its reason and «Подтвердить», which makes it the person's decision; or, on a person's decision, the model's reason
 * when it thought otherwise. A person's own decision and a criterion nobody decided say nothing: the switch shows them.
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
  if (by === "person" && proposed && proposed.serious !== rule.serious)
    return <p className={cls}>Модель считала иначе. {reasonText(proposed.reason)}</p>;
  return null;
}

/** A criterion's switch with the line under it, where it has one: in the criterion's panel and on its problem's page. */
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
