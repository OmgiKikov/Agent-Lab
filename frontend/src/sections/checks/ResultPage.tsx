import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { FileText } from "lucide-react";
import { conversationsLink, launchLink, type Check } from "../../app/links";
import { resultOf } from "../../lab/checks";
import { useCriteria } from "../../lab/criteria";
import { useLabState } from "../../lab/LabProvider";
import { toneJudgedByOther } from "../../lab/tone";
import { Button } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { CheckHeader } from "./CheckHeader";
import { useComparison } from "./Compare";
import { CheckReport } from "./CheckReport";
import { useOrigins } from "./origin";
import { PART, ResultView } from "./ResultView";
import { AccuracyStart, ToneStart } from "./Start";

/**
 * «Итог» of a check, as a measurement (checks/ResultView): the real conversations of the dataset in use as this check
 * judged them. Its conversations open from the parts of the number («Все разговоры»), where a person can say an error
 * is not one. Before its first result, or while a new dataset waits for its first check, the start of the check
 * (checks/Start), which leads on by its own button: the header's «Новая проверка» is quiet then. A new check is the
 * header's «Новая проверка», where accuracy can also read its criteria from the agent's code anew.
 */
export function ResultPage({ check }: { check: Check }) {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { data, list, error, retry } = useCriteria(check);
  const result = resultOf(state, check);
  const compare = useComparison(check);
  const origins = useOrigins(check);
  const [report, setReport] = useState(false);
  useEffect(() => {
    // «Проверить снова» of an older address (?assess=1) is the new check now.
    if (params.get("assess") === "1") navigate(launchLink(check), { replace: true });
    if (params.get("report") === "1") setReport(true);
  }, [params, check, navigate]);
  const drop = (key: string) => {
    if (params.get(key))
      setParams(
        (prev) => {
          const n = new URLSearchParams(prev);
          n.delete(key);
          return n;
        },
        { replace: true },
      );
  };

  const header = (
    <CheckHeader
      check={check}
      quiet={!!state && !result}
      actions={
        // New conversations come through «Датасеты» or «Новая проверка»; the result's own action is its report.
        result && (
          <Button variant="outline" icon={FileText} aria-label="Отчёт для письма" onClick={() => setReport(true)}>
            <span className="sm:hidden">Отчёт</span>
            <span className="hidden sm:inline">Отчёт для письма</span>
          </Button>
        )
      }
    />
  );
  const sheets = (
    <>
      {result && (
        <CheckReport
          check={check}
          open={report}
          onClose={() => {
            setReport(false);
            drop("report");
          }}
        />
      )}
    </>
  );
  const page = (body: ReactNode) => (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
      {sheets}
    </div>
  );
  if (offline && !state) return page(<ServiceDown />);
  if (state && !result) return page(check === "tone" ? <ToneStart /> : <AccuracyStart />);
  const log = data?.log;
  if (error) return page(<LoadFailed page title="Не удалось загрузить итог проверки" error={error} onRetry={retry} />);
  if (!state || !data || !log)
    return page(
      <div className="space-y-6 px-4 pt-10 lg:px-10">
        <Skeleton className="h-36 max-w-3xl" />
        <Skeleton className="h-80 max-w-5xl" />
      </div>,
    );

  return page(
    <ResultView
      check={check}
      data={{ ...data, log }}
      list={list}
      // The current result is of the dataset in use.
      origin={origins(result?.checkId, state.logs.datasetId, state.logs.file)}
      lead={
        check === "tone" &&
        toneJudgedByOther(state) && (
          <p className="mb-4 max-w-[68ch] text-body text-fg-2">
            Критерии изменились после этой проверки: итог посчитан по прежним.{" "}
            <Link to={launchLink(check)} className="font-medium text-run hover:underline">
              Проверить по новым
            </Link>
          </p>
        )
      }
      compare={compare}
      part={(part) => conversationsLink(check, { v: PART[part] })}
      all={conversationsLink(check)}
    />,
  );
}
