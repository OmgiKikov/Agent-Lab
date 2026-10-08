import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { FileText } from "lucide-react";
import { conversationsLink, launchLink, problemLink, type Check } from "../../app/links";
import { resultOf } from "../../lab/checks";
import { useCriteria, type Criterion } from "../../lab/criteria";
import { longDay, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { summarySentence } from "../../lab/problemReport";
import { seriousOf } from "../../lab/severity";
import { Step, STEP_ACTION, STEP_NEXT } from "../../product/Checklist";
import { seriousStep, SeverityStatus } from "../../product/Severity";
import { StageResult } from "../../product/StageResult";
import { answersPending, Trust } from "../../product/Trust";
import { Button } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { checked, queueOf } from "../problems/model";
import { ProblemList } from "../problems/ProblemList";
import { CheckHeader } from "./CheckHeader";
import { CompareDelta, NoLongerFound, useComparison, wasOf } from "./Compare";
import { CheckReport } from "./CheckReport";
import { AccuracyStart, ToneStart } from "./Start";

const PART = { bad: "fail", ok: "pass", none: "none" } as const;

/**
 * The step after the model's answers are checked and the serious errors decided: the main problem — serious first,
 * then the most frequent — opened where its examples are and where it goes to a developer.
 */
function MainProblem({ check, c, next }: { check: Check; c: Criterion; next: boolean }) {
  const s = c.r.log;
  return (
    <Step
      state="todo"
      title="Разберите главную проблему"
      text={`${c.r.title}: ${s.failed}\u00a0из\u00a0${checked(s)} ${plural(checked(s), "разговора", "разговоров", "разговоров")}. На странице проблемы — примеры с цитатами и задача для разработчика.`}
      action={
        <Link to={problemLink(c.r.id, check)} className={next ? STEP_NEXT : STEP_ACTION}>
          Открыть
        </Link>
      }
    />
  );
}

/**
 * «Итог» of a check: the real conversations of the export as this check judged them — one number and how it stands to
 * the check's previous check beside it; the steps after a check in the order they are taken, the next one with the
 * black button: check the model's answers, decide the serious errors, open the main problem; then the problems it is
 * made of, serious first, then most frequent, each beside its previous count, and the criteria whose errors are no
 * longer found. Its conversations open from the parts of the number («Все разговоры»), the person's answers from
 * «Проверьте оценки модели» (product/Trust): both are of this result, not tabs of their own. A new check is the
 * header's «Новая проверка», where accuracy can also read its criteria from the agent's code anew.
 */
export function ResultPage({ check }: { check: Check }) {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { data, list, error, retry } = useCriteria(check);
  const result = resultOf(state, check);
  const compare = useComparison(check);
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

  // The steps in their order: the answers first while they are to do, then the serious errors, then the main problem.
  const answering = answersPending(result);
  const top = queueOf(list, "log")[0];
  return page(
    <div className="max-w-[1040px] px-4 pb-24 pt-8 lg:px-10 lg:pt-12">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-read text-fg-3">
        <span>
          {state.logs.file ? `«${state.logs.file}» · ` : ""}проверено {longDay(log.finishedAt)}
        </span>
      </div>
      <StageResult
        className="mt-4"
        failed={log.withViolations}
        checked={log.assessed}
        unchecked={log.unassessed}
        link={(part) => conversationsLink(check, { v: PART[part] })}
        all={conversationsLink(check)}
        delta={<CompareDelta check={check} compare={compare} serious={seriousOf(data)?.marked} />}
      />
      {result && (
        <Trust
          result={result}
          check={check}
          lead
          serious={<SeverityStatus data={data} check={check} next={!answering} />}
          problem={top && <MainProblem check={check} c={top} next={!answering && seriousStep(data) !== "todo"} />}
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
