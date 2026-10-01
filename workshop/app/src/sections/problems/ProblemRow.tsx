import { Link } from "react-router-dom";
import type { Criterion } from "../../lab/criteria";
import { pct, plural } from "../../lab/format";
import { checked, violationsOf, type SideKey } from "../violations/model";

/**
 * One problem in a list: the agent's behaviour as a sentence, its topics, one real exchange with the agent's words
 * marked, and how often, «N из M» with M the conversations where it could be checked. The rank is the order by frequency.
 */
export function ProblemRow({ c, side, rank, to }: { c: Criterion; side: SideKey; rank?: number; to: string }) {
  const s = c.r[side];
  const of = checked(s);
  const e = violationsOf(c, side)[0];
  return (
    <Link to={to} className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 gap-y-3 px-5 py-4 transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none sm:grid-cols-[28px_minmax(0,1fr)_200px] sm:gap-x-5">
      <span className="pt-0.5 text-body font-semibold tabular-nums text-fg-3">{rank ?? ""}</span>
      <span className="min-w-0">
        <span className="block text-lead font-medium text-fg">{c.r.title}</span>
        {c.r.topics.length > 0 && <span className="mt-0.5 block truncate text-small text-fg-3">{c.r.topics.slice(0, 3).join(" · ")}{c.r.topics.length > 3 ? ` и ещё ${c.r.topics.length - 3}` : ""}</span>}
        {e && (
          <span className="mt-2.5 block space-y-1 text-small">
            <span className="block truncate text-fg-2"><span className="text-fg-3">Клиент: </span>{e.opening}</span>
            {e.agentQuote && <span className="block truncate text-fg-2"><span className="text-fg-3">Агент: </span><mark className="rounded-sm bg-mark/70 px-0.5 text-fg">{e.agentQuote}</mark></span>}
          </span>
        )}
      </span>
      <span className="col-start-2 sm:col-start-auto sm:text-right">
        <span className="block text-count font-semibold tabular-nums text-fg"><span className="text-bad">{s.failed}</span> <span className="text-body font-normal text-fg-3">из {of}</span></span>
        <span className="block text-small text-fg-3" title="Из разговоров, где судья смог это проверить">{plural(of, "проверенного разговора", "проверенных разговоров", "проверенных разговоров")}</span>
        <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-well sm:ml-auto sm:w-40"><span className="block h-full rounded-full bg-bad" style={{ width: `${Math.max(3, pct(s.failed, of))}%` }} /></span>
      </span>
    </Link>
  );
}
