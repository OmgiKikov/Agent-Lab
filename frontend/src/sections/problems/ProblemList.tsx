import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Criterion, Loading } from "../../lab/criteria";
import { count } from "../../lab/format";
import { criterionLink, problemLink, side, type Stage } from "../../app/links";
import { ENTER, stagger } from "../../product/motion";
import { Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { queueOf } from "./model";
import { ProblemRow } from "./ProblemRow";

/**
 * The problems of a stage, the ones a person marked important first, then the most frequent, with how many criteria
 * have no error found; `limit` for the overview, `was` for what each problem had in the previous check of a check.
 * `record` — how the record of the criteria stands (lab/criteria, useCriteria): while it loads or after it failed the
 * list says so, and an empty list is never shown for a record that has not come.
 */
export function ProblemList({
  list,
  stage,
  runId,
  limit,
  was,
  record,
}: {
  list: Criterion[];
  stage: Stage;
  runId?: string | null;
  limit?: number;
  was?: (id: string) => ReactNode;
  record?: Loading;
}) {
  if (record?.error)
    return <LoadFailed title="Не удалось загрузить проблемы" error={record.error} onRetry={record.retry} />;
  if (record?.loading) return <Skeleton className={limit ? "mt-3 h-48" : "mt-3 h-72"} />;
  const where = side(stage);
  const rows = queueOf(list, where);
  const shown = limit ? rows.slice(0, limit) : rows;
  const clean = list.filter((c) => c.r[where].passed > 0 && !c.r[where].failed).length;
  if (!rows.length)
    return (
      <p className="py-6 text-read text-fg-3">
        {/* «No errors» only where something was checked: a check the model could not do is not a clean result. */}
        {list.some((c) => c.r[where].passed > 0)
          ? "Ошибок не найдено ни по одному критерию."
          : "Ни один разговор пока не удалось проверить по этим критериям."}
      </p>
    );
  return (
    <>
      {/* «6 из 52» next to «53 проверенных разговоров» read as a slip: what the second number counts is said once. */}
      <p className="pt-2 text-small text-fg-3">Второе число — в скольких проверенных разговорах критерий применим.</p>
      <ol className="divide-y divide-line">
        {shown.map((c, i) => (
          <li key={c.r.id} className={ENTER} style={stagger(i + 2)}>
            <ProblemRow c={c} side={where} rank={i + 1} to={problemLink(c.r.id, stage, runId)} was={was?.(c.r.id)} />
          </li>
        ))}
      </ol>
      {!limit && clean > 0 && (
        <p className="mt-4 border-t border-line pt-4 text-body text-fg-3">
          По {count(clean, "критерию", "критериям", "критериям")} ошибок не найдено.{" "}
          {stage !== "sim" && (
            <Link to={criterionLink(stage)} className="font-medium text-run hover:underline">
              Все критерии
            </Link>
          )}
        </p>
      )}
    </>
  );
}
