import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { commonText, commonTitle, type Criterion } from "../../lab/criteria";
import { inQuotes } from "../../lab/quote";
import { pct } from "../../lab/format";
import { askedOf } from "../../lab/problems";
import { humansOf, humansText } from "../../lab/problemStats";
import { SeriousTag } from "../../product/Severity";
import { checked, errorIn, violationsOf, type SideKey } from "./model";

/**
 * One problem in a list, on the page itself, no box: its rank (the criteria a person marked important first, then by
 * frequency), its criterion's name with «важный» when its errors are serious, the kind of error the model named most
 * often when it says more than the name, one real exchange — the customer's words and the agent's reply to them,
 * marked — and «N из M» with a quiet bar. The agent's words are the evidence: the customer's take at most a third of
 * the line and are cut first. Red stays in the result above and in that quiet word.
 * Under the count (on a phone, under the text): the person's answers on its errors, once there are any, and `was` —
 * what the criterion had in the previous check of this check.
 */
export function ProblemRow({
  c,
  side,
  rank,
  to,
  was,
}: {
  c: Criterion;
  side: SideKey;
  rank?: number;
  to: string;
  was?: ReactNode;
}) {
  const s = c.r[side];
  const of = checked(s);
  const e = violationsOf(c, side)[0];
  const common = commonTitle(c, side);
  const answers = humansOf(s);
  const asked = e ? askedOf(e) : "";
  return (
    <Link
      to={to}
      className="group -mx-3 grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-x-4 rounded-block px-3 py-4 transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none sm:grid-cols-[22px_minmax(0,1fr)_auto_16px]"
    >
      <span className="pt-0.5 text-read tabular-nums text-fg-3">{rank ?? ""}</span>
      <span className="min-w-0">
        <span className="block text-lead font-medium text-fg">
          {c.name}
          <SeriousTag rule={c.r} className="relative -top-px ml-2 align-middle" />
        </span>
        {common && <span className="mt-0.5 block text-body text-fg-2">{commonText(common)}</span>}
        {e && (asked || e.agentQuote) && (
          // One line on a wide screen; on a phone the agent's words take a line of their own, two at most.
          <span className="mt-1 block text-body text-fg-3 sm:flex sm:items-baseline sm:gap-1.5">
            {asked && (
              <span className={cn("block truncate", e.agentQuote && "sm:max-w-[33%] sm:flex-shrink-0")}>
                {inQuotes(asked)}
              </span>
            )}
            {e.agentQuote && (
              <span className="flex min-w-0 items-baseline gap-1.5">
                {asked && (
                  <span aria-hidden className="flex-shrink-0">
                    →
                  </span>
                )}
                <span className="min-w-0 line-clamp-2 sm:block sm:truncate">
                  <mark className="rounded-sm bg-mark/60 px-0.5 text-fg-2 box-decoration-clone">{e.agentQuote}</mark>
                </span>
              </span>
            )}
          </span>
        )}
      </span>
      <span className="pt-0.5 text-right">
        <span
          className="block whitespace-nowrap text-read font-semibold tabular-nums text-fg"
          title={`Ошибка ${errorIn(s)}`}
        >
          {s.failed}
          <span className="font-normal text-fg-3"> из {of}</span>
        </span>
        <span className="ml-auto mt-2 block h-1 w-16 overflow-hidden rounded-full bg-well" aria-hidden>
          <span
            className="block h-full rounded-full bg-fg/60"
            style={{ width: `${Math.max(4, pct(s.failed, of))}%` }}
          />
        </span>
      </span>
      <ChevronRight
        aria-hidden
        className="mt-1 hidden size-4 text-fg-4 transition-transform group-hover:translate-x-0.5 sm:block"
      />
      {(answers.checked > 0 || was) && (
        // Under the text and the count together, right-aligned on a wide screen: the column of the count keeps its width.
        <span className="col-span-2 col-start-2 mt-1 text-small text-fg-3 sm:text-right">
          {answers.checked > 0 && <span className="block">{humansText(answers)}</span>}
          {was}
        </span>
      )}
    </Link>
  );
}
