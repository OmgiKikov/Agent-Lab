import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FileText, RotateCcw } from "lucide-react";
import { conversationsLink, toneCheckLink, type Check } from "../../app/links";
import { resultOf } from "../../lab/checks";
import { useCriteria } from "../../lab/criteria";
import { longDay } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { summarySentence } from "../../lab/problemReport";
import { seriousOf } from "../../lab/severity";
import { SeverityStatus } from "../../product/Severity";
import { StageResult } from "../../product/StageResult";
import { Trust } from "../../product/Trust";
import { UploadButton } from "../../product/UploadLogs";
import { Button } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { ProblemList } from "../problems/ProblemList";
import { AssessSheet } from "./AssessSheet";
import { CheckHeader } from "./CheckHeader";
import { CompareLine, NoLongerFound, useComparison, wasOf } from "./Compare";
import { CheckReport } from "./CheckReport";
import { AccuracyStart, ToneStart } from "./Start";

const PART = { bad: "fail", ok: "pass", none: "none" } as const;

/**
 * «Итог» of a check: the real conversations of the export as this check judged them — one number, the conversations
 * with a serious error and whose decision that is, and how it stands to the check's previous check; then the
 * problems it is made of, serious first, then most frequent, each beside its previous count, and the criteria whose
 * errors are no longer found. Without a result, how to get one. «Проверить снова», the same words in both checks,
 * repeats tone of voice step by step; accuracy is checked again here (?assess=1), by the same criteria or by criteria
 * read from the code anew.
 */
export function ResultPage({ check }: { check: Check }) {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { data, list, error, retry } = useCriteria(check);
  const result = resultOf(state, check);
  const compare = useComparison(check);
  const [assess, setAssess] = useState(false);
  const [report, setReport] = useState(false);
  useEffect(() => {
    if (params.get("assess") === "1" && check === "code") setAssess(true);
    if (params.get("report") === "1") setReport(true);
  }, [params, check]);
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
        <>
          <span className="hidden sm:contents">
            <UploadButton variant="outline" check={check} />
          </span>
          {result && (
            <Button variant="primary" icon={FileText} aria-label="Отчёт для письма" onClick={() => setReport(true)}>
              <span className="hidden sm:inline">Отчёт для письма</span>
            </Button>
          )}
        </>
      }
    />
  );
  const sheets = (
    <>
      {check === "code" && (
        <AssessSheet
          open={assess}
          onClose={() => {
            setAssess(false);
            drop("assess");
          }}
        />
      )}
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

  const busy = !!state.job.running;
  return page(
    <div className="max-w-[1040px] px-4 pb-24 pt-8 lg:px-10 lg:pt-12">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-read text-fg-3">
        <span>
          {state.logs.file ? `«${state.logs.file}» · ` : ""}проверено {longDay(log.finishedAt)}
        </span>
        <button
          type="button"
          onClick={() => (check === "tone" ? navigate(toneCheckLink("criteria")) : setAssess(true))}
          disabled={!state.logs.total || busy}
          title={
            check === "tone"
              ? "Проверить снова по шагам, с теми же или уточнёнными критериями"
              : "Проверить разговоры выгрузки заново по критериям из кода агента"
          }
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-small font-medium text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40"
        >
          <RotateCcw aria-hidden className="size-3.5" />
          Проверить снова
        </button>
      </div>
      <StageResult
        className="mt-4"
        failed={log.withViolations}
        checked={log.assessed}
        unchecked={log.unassessed}
        link={(part) => conversationsLink(check, { v: PART[part] })}
      />
      {result && (
        <Trust
          result={result}
          check={check}
          serious={<SeverityStatus data={data} check={check} />}
          compare={<CompareLine check={check} compare={compare} serious={seriousOf(data)?.marked} />}
          className="mt-5"
        />
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
