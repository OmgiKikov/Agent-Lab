import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { FileText } from "lucide-react";
import { conversationsLink, launchLink, type Check } from "../../app/links";
import { resultOf } from "../../lab/checks";
import { seriousCompareText, type Compare } from "../../lab/compare";
import { useCriteria } from "../../lab/criteria";
import { pct } from "../../lab/format";
import { FEW } from "../../lab/history";
import { useLaunches } from "../../lab/launches";
import { useLabState } from "../../lab/LabProvider";
import { summarySentence } from "../../lab/problemReport";
import { toneJudgedByOther } from "../../lab/tone";
import { seriousOf } from "../../lab/severity";
import type { Problems } from "../../lab/problems";
import { StageResult } from "../../product/StageResult";
import { Button } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { ProblemList } from "../problems/ProblemList";
import { CheckHeader } from "./CheckHeader";
import { CompareDelta, NoLongerFound, useComparison, wasOf } from "./Compare";
import { CheckReport } from "./CheckReport";
import { AccuracyStart, ToneStart } from "./Start";

const PART = { bad: "fail", ok: "pass", none: "none" } as const;

/**
 * «С нарушением важных критериев — 5 из 100 (5%)» under the number, opening those conversations: counted apart, never
 * added to it. Once the check is compared with its previous one, the comparison says it beside the chip instead, «было
 * → сейчас» (checks/Compare, CompareDelta).
 */
function Important({ check, data, compare }: { check: Check; data: Problems; compare: Compare | null }) {
  const serious = seriousOf(data);
  if (!serious || (compare && seriousCompareText(compare, serious.marked))) return null;
  return (
    <p className="mt-1 text-read text-fg-3">
      С нарушением важных критериев —{" "}
      <Link
        to={conversationsLink(check, { v: "serious" })}
        title="Разговоры, где нарушен важный критерий"
        className="whitespace-nowrap rounded-sm font-medium text-fg-2 underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-fg-3"
      >
        {`${serious.failed}\u00a0из\u00a0${serious.measured}`}
      </Link>{" "}
      ({pct(serious.failed, serious.measured)}%)
    </p>
  );
}

/**
 * «Итог» of a check, as a measurement: the real conversations of the export as this check judged them — the share
 * without an error found, the version of the agent when the check was told it, how the number stands to the check's
 * previous check, the conversations where an important criterion was broken; then the problems it is made of, the
 * important ones first, then the most frequent, each beside its previous count, and the criteria whose errors are no
 * longer found. Its conversations open from the parts of the number («Все разговоры»), where a person can say an
 * error is not one. A new check is the header's «Новая проверка», where accuracy can also read its criteria from the
 * agent's code anew.
 */
export function ResultPage({ check }: { check: Check }) {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { data, list, error, retry } = useCriteria(check);
  const result = resultOf(state, check);
  const compare = useComparison(check);
  const launches = useLaunches(check, `${state?.job.id}-${state?.job.running}`);
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
      actions={
        // New conversations come through «Датасеты» or «Новая проверка»; the result's own action is its report.
        result && (
          <Button variant="outline" icon={FileText} aria-label="Отчёт для письма" onClick={() => setReport(true)}>
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

  // The version of the agent the check measured, when its launch was told it: the measurement is of that version.
  const version = launches.data?.launches.find((l) => l.modes.dataset?.checkId === result?.checkId)?.agentVersion;
  return page(
    <div className="max-w-[1040px] px-4 pb-24 pt-8 lg:px-10 lg:pt-12">
      {version && <p className="mb-4 break-words text-read text-fg-3">Версия агента {version}</p>}
      {check === "tone" && toneJudgedByOther(state) && (
        <p className="mb-4 max-w-[68ch] text-body text-fg-2">
          Критерии изменились после этой проверки: итог посчитан по прежним.{" "}
          <Link to={launchLink(check)} className="font-medium text-run hover:underline">
            Проверить по новым
          </Link>
        </p>
      )}
      <StageResult
        failed={log.withViolations}
        checked={log.assessed}
        unchecked={log.unassessed}
        link={(part) => conversationsLink(check, { v: PART[part] })}
        all={conversationsLink(check)}
        important={<Important check={check} data={data} compare={compare} />}
        delta={<CompareDelta check={check} compare={compare} serious={seriousOf(data)?.marked} />}
      />
      {log.assessed > 0 && log.assessed < FEW && (
        <p className="mt-3 text-small text-fg-3">{`Проверено меньше ${FEW}\u00a0разговоров, поэтому вывод предварительный.`}</p>
      )}
      <section aria-label="Проблемы" className="mt-16">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line pb-3">
          <h2 className="text-title font-semibold text-fg">Проблемы</h2>
          <p className="text-read text-fg-3">{summarySentence(data, "log")}</p>
        </div>
        <div className="mt-2">
          <ProblemList list={list} stage={check} was={wasOf(compare)} />
        </div>
        <NoLongerFound
          check={check}
          compare={compare}
          serious={new Map(data.rules.filter((r) => r.serious).map((r) => [r.id, r]))}
        />
      </section>
    </div>,
  );
}
