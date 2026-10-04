import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import type { Criterion } from "../../lab/criteria";
import { pct } from "../../lab/format";
import { checked, errorIn, violationsOf, type SideKey } from "./model";

/**
 * One problem in a list, on the page itself, no box: its rank by frequency, the agent's behaviour as a sentence, one real
 * exchange (the customer's words and the agent's, marked), and «N из M» with a quiet bar. Red stays in the result above.
 * `was` — what the criterion had in the previous check of this check, under the count (on a phone, under the text).
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
  return (
    <Link
      to={to}
      className="group -mx-3 grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-x-4 rounded-block px-3 py-4 transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none sm:grid-cols-[22px_minmax(0,1fr)_auto_16px]"
    >
      <span className="pt-0.5 text-read tabular-nums text-fg-4">{rank ?? ""}</span>
      <span className="min-w-0">
        <span className="block text-lead font-medium text-fg">{c.r.title}</span>
        {e && (
          <span className="mt-1 block truncate text-body text-fg-3">
            «{e.opening}»
            {e.agentQuote && (
              <>
                {" "}
                <span aria-hidden>→</span>{" "}
                <mark className="rounded-sm bg-mark/60 px-0.5 text-fg-2">{e.agentQuote}</mark>
              </>
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
      {was && (
        <span className="col-span-2 col-start-2 mt-1 text-small text-fg-3 sm:col-span-1 sm:col-start-3 sm:text-right">
          {was}
        </span>
      )}
    </Link>
  );
}
