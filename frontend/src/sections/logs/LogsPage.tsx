import { useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { FileText, RotateCcw } from "lucide-react";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { StageTabs } from "../../app/StageTabs";
import { problemLink } from "../../app/links";
import { useCriteria } from "../../lab/criteria";
import { longDay } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { checkedIn, summarySentence } from "../../lab/problemReport";
import { toneResult } from "../../lab/tone";
import { queueOf as verdictQueue } from "../../lab/verdicts";
import { StageResult } from "../../product/StageResult";
import { Trust } from "../../product/Trust";
import { UploadButton } from "../../product/UploadLogs";
import { Button } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { FirstRun } from "../overview/FirstRun";
import { AssessSheet } from "../problems/AssessSheet";
import { ProblemList } from "../problems/ProblemList";
import { ReportSheet } from "../problems/ReportSheet";
import { BriefSheet, useToneBrief } from "../check/BriefSheet";
import { TONE_ONLY } from "../../app/product";

/** The tabs of the logs with their counts: every conversation of the export, the verdicts where the two checks disagree. */
export function useLogTabs() {
  const { state } = useLabState();
  const { data } = useCriteria(null);
  return (
    <StageTabs
      stage="log"
      counts={{
        conversations: state?.discover?.results.length,
        review: data ? verdictQueue(data, "disputed", null, "log").length : undefined,
      }}
    />
  );
}

/**
 * «Диалоги», the first stage: the customers' real conversations from the chat's export, checked against the agent's criteria.
 * The result as one number, then the problems it is made of. The older addresses of this place lead to its pages.
 */
export function LogsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab");
  const legacy = params.get("p");
  if (tab === "dialogs") return <Navigate to={`/logs/conversations?${strip(params, ["tab"])}`} replace />;
  if (tab === "review") return <Navigate to={`/logs/review?${strip(params, ["tab"])}`} replace />;
  if (legacy) return <Navigate to={problemLink(legacy, "log")} replace />;
  return <LogsResult params={params} setParams={setParams} />;
}

const strip = (p: URLSearchParams, keys: string[]) => {
  const n = new URLSearchParams(p);
  keys.forEach((k) => n.delete(k));
  return n.toString();
};

function LogsResult({
  params,
  setParams,
}: {
  params: URLSearchParams;
  setParams: ReturnType<typeof useSearchParams>[1];
}) {
  const { state, offline } = useLabState();
  const { data, list } = useCriteria(null);
  const tabs = useLogTabs();
  const asked = params.get("assess");
  const [assess, setAssess] = useState(asked === "1" || asked === "code");
  // «code»: the start asked for the assessment by the criteria from the agent's code, whatever the dialogues hold now.
  const [code, setCode] = useState(asked === "code");
  const [report, setReport] = useState(params.get("report") === "1");
  // A tone-of-voice result has its own report: the same as on the result, with the same number.
  const tone = !!toneResult(state);
  const brief = useToneBrief(state);
  const navigate = useNavigate();
  useEffect(() => {
    if (asked === "1" || asked === "code") {
      setAssess(true);
      setCode(asked === "code");
    }
    if (params.get("report") === "1") setReport(true);
  }, [asked, params]);
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
    <Header
      title="Диалоги"
      step={1}
      tabs={tabs}
      actions={
        <>
          <span className="hidden sm:contents">
            <UploadButton variant="outline" />
          </span>
          {(tone || !!data?.log) && (
            <Button
              variant="primary"
              icon={FileText}
              aria-label="Отчёт для письма"
              onClick={() => setReport(true)}
              disabled={tone && !brief}
            >
              <span className="hidden sm:inline">Отчёт для письма</span>
            </Button>
          )}
        </>
      }
      below={<SectionJob kinds={["tone-check", "discover"]} />}
    />
  );
  const sheets = (
    <>
      <AssessSheet
        open={assess}
        onClose={() => {
          setAssess(false);
          drop("assess");
        }}
        criteria={data ? checkedIn(data, "log").length : 0}
        code={code}
      />
      {tone ? (
        <BriefSheet
          open={report}
          onClose={() => {
            setReport(false);
            drop("report");
          }}
          brief={brief}
        />
      ) : (
        data?.log && (
          <ReportSheet
            open={report}
            onClose={() => {
              setReport(false);
              drop("report");
            }}
            data={data}
            list={list}
          />
        )
      )}
    </>
  );
  if (offline && !state)
    return (
      <div className="flex h-full flex-col">
        {header}
        <ServiceDown />
      </div>
    );
  if (!state || !data)
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="space-y-6 px-4 pt-10 lg:px-10">
          <Skeleton className="h-36 max-w-3xl" />
          <Skeleton className="h-80 max-w-5xl" />
        </div>
      </div>
    );
  if (!data.log)
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="min-h-0 flex-1 overflow-auto">
          <FirstRun />
        </div>
        {sheets}
      </div>
    );

  const log = data.log;
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[1040px] px-4 pb-24 pt-8 lg:px-10 lg:pt-12">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-read text-fg-3">
            <span>
              {toneResult(state) ? "Tone of voice" : "Точность по коду агента"}
              {state.logs.file ? ` · «${state.logs.file}»` : ""} · проверено {longDay(log.finishedAt)}
            </span>
            <button
              type="button"
              onClick={() => {
                // In tone-only mode the sheet would offer one way only: the check's own criteria step.
                if (TONE_ONLY && tone) return void navigate("/check?step=criteria");
                setCode(false);
                setAssess(true);
              }}
              disabled={!state.logs.total || !!state.job.running}
              title="Проверить разговоры выгрузки заново"
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-small font-medium text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40"
            >
              <RotateCcw aria-hidden className="size-3.5" />
              Оценить заново
            </button>
          </div>
          <StageResult className="mt-4" failed={log.withViolations} checked={log.assessed} unchecked={log.unassessed} />
          <Trust data={data} stage="log" checked={log.assessed} />
          <section aria-label="Проблемы" className="mt-16">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line pb-3">
              <h2 className="text-title font-semibold text-fg">Проблемы</h2>
              <p className="text-read text-fg-3">{summarySentence(data, "log")}</p>
            </div>
            <div className="mt-2">
              <ProblemList list={list} stage="log" />
            </div>
          </section>
        </div>
      </div>
      {sheets}
    </div>
  );
}
