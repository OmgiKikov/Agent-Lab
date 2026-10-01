import { Link } from "react-router-dom";
import type { Criterion } from "../../lab/criteria";
import { count } from "../../lab/format";
import { problemLink, SECTIONS, type Stage } from "../../app/links";
import { ENTER, stagger } from "../../product/motion";
import { queueOf } from "./model";
import { ProblemRow } from "./ProblemRow";

/** The problems of a stage, most frequent first, with how many criteria have no error found; `limit` for the overview. */
export function ProblemList({
  list,
  stage,
  runId,
  limit,
}: {
  list: Criterion[];
  stage: Stage;
  runId?: string | null;
  limit?: number;
}) {
  const rows = queueOf(list, stage);
  const shown = limit ? rows.slice(0, limit) : rows;
  const clean = list.filter((c) => c.r[stage].passed > 0 && !c.r[stage].failed).length;
  if (!rows.length) return <p className="py-6 text-read text-fg-3">Ошибок не найдено ни по одному критерию.</p>;
  return (
    <>
      <ol className="divide-y divide-line">
        {shown.map((c, i) => (
          <li key={c.r.id} className={ENTER} style={stagger(i + 2)}>
            <ProblemRow c={c} side={stage} rank={i + 1} to={problemLink(c.r.id, stage, runId)} />
          </li>
        ))}
      </ol>
      {!limit && clean > 0 && (
        <p className="mt-4 border-t border-line pt-4 text-body text-fg-3">
          По {count(clean, "критерию", "критериям", "критериям")} ошибок не найдено.{" "}
          <Link to={SECTIONS.criteria} className="font-medium text-run hover:underline">
            Все критерии
          </Link>
        </p>
      )}
    </>
  );
}
