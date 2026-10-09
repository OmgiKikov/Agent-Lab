import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { yesNoText } from "../../lab/answers";
import type { Criterion } from "../../lab/criteria";
import { pct } from "../../lab/format";
import { humansOf } from "../../lab/problemStats";
import { SeriousTag } from "../../product/Severity";
import { checked, errorIn, violationsOf, type SideKey } from "./model";

/**
 * One problem in a list, on the page itself, no box: its rank (serious first, then by frequency), the agent's behaviour
 * as a sentence with «важный» when its errors are serious, one real exchange (the customer's words and the agent's,
 * marked), and «N из M» with a quiet bar. Red stays in the result above and in that quiet word.
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
  const answers = humansOf(s);
  return (
    <Link
      to={to}
      className="group -mx-3 grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-x-4 rounded-block px-3 py-4 transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none sm:grid-cols-[22px_minmax(0,1fr)_auto_16px]"
    >
      <span className="pt-0.5 text-read tabular-nums text-fg-4">{rank ?? ""}</span>
      <span className="min-w-0">
        <span className="block text-lead font-medium text-fg">
          {c.r.title}
          {c.r.serious && <SeriousTag rule={c.r} className="relative -top-px ml-2 align-middle" />}
        </span>
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
      {(answers.checked > 0 || was) && (
        // Under the text and the count together, right-aligned on a wide screen: the column of the count keeps its width.
        <span className="col-span-2 col-start-2 mt-1 text-small text-fg-3 sm:text-right">
          {answers.checked > 0 && (
            <span className="block">ваши ответы: {yesNoText(answers.agree, answers.checked - answers.agree)}</span>
          )}
          {was}
        </span>
      )}
    </Link>
  );
}
