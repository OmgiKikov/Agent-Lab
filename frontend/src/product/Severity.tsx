import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { conversationsLink } from "../app/links";
import type { Problems, RuleEntry } from "../lab/problems";
import { seriousOf, seriousSentence, useSeverity } from "../lab/severity";
import type { Check } from "../lab/types";
import { Switch } from "../ui/Switch";
import { Tag } from "../ui/Tag";

/**
 * «серьёзная» beside a problem a person marked serious: a quiet red word in the colour of errors, never a badge that
 * shouts. On the paper of a report (`paper`) in the ink of the paper.
 */
export function SeriousTag({ paper, className }: { paper?: boolean; className?: string }) {
  return (
    <Tag
      tone="bad"
      title="Критерий отмечен серьёзным: его ошибки идут первыми и считаются отдельно"
      className={cn(paper && "border-ink-bad/35 text-ink-bad", className)}
    >
      серьёзная
    </Tag>
  );
}

/**
 * «Серьёзная ошибка» on one criterion of a check: on its criteria and on its problem's page. Off, its errors are minor.
 * In a row of a table (`name`) the words go to a screen reader with the criterion's name. While the service saves a
 * mark the switch takes no other press, so two marks never race; it is not disabled, so the keyboard keeps its place.
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
  return (
    <Switch
      checked={rule.serious}
      onChange={(serious) => {
        if (!mark.isPending) mark.mutate({ check, rule: rule.id, serious });
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
 * Under a check's number, once a criterion of its result is marked serious: «С серьёзными ошибками — 6 из 53 (11%): по
 * 2 критериям, которые вы отметили серьёзными.» The same checked conversations; the count opens them. It never stands
 * in for the number above and is never added to it.
 */
export function SeriousLine({ data, check }: { data: Problems | null | undefined; check: Check }) {
  const serious = seriousOf(data);
  if (!serious) return null;
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
    </p>
  );
}
