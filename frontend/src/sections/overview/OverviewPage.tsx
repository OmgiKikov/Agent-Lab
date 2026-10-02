import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, Bot, ClipboardCheck, FileText, Play } from "lucide-react";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { reviewLink, SECTIONS, stageLink, type Stage } from "../../app/links";
import { useCriteria } from "../../lab/criteria";
import { count, longDay } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { useAgent } from "../../lab/agents";
import { checkedIn, stagesSentence } from "../../lab/problemReport";
import type { Problems } from "../../lab/problems";
import type { LabRun } from "../../lab/types";
import { toneResult } from "../../lab/tone";
import { queueOf as verdictQueue } from "../../lab/verdicts";
import { StageResult } from "../../product/StageResult";
import { Trust } from "../../product/Trust";
import { Step } from "../../product/Step";
import { Button, buttonClass } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { AssessSheet } from "../problems/AssessSheet";
import { ProblemList } from "../problems/ProblemList";
import { ReportSheet } from "../problems/ReportSheet";
import { FirstRun } from "./FirstRun";
import { TONE_ONLY } from "../../app/product";
import { cn } from "@/lib/utils";

/**
 * «Обзор»: how the agent is doing, in the two stages it is checked — the customers' real conversations, then synthetic
 * customers playing scenarios. Each stage says its one number and its main problems, side by side and never added up;
 * then what to do next.
 */
export function OverviewPage() {
  const { state, offline } = useLabState();
  const agent = useAgent();
  const [params, setParams] = useSearchParams();
  const { data, list } = useCriteria(null);
  const [assess, setAssess] = useState(params.get("assess") === "1");
  const [report, setReport] = useState(params.get("report") === "1");
  useEffect(() => {
    if (params.get("assess") === "1") setAssess(true);
    if (params.get("report") === "1") setReport(true);
  }, [params]);
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
      title="Обзор"
      actions={
        <Button
          variant="primary"
          icon={FileText}
          aria-label="Отчёт для письма"
          onClick={() => setReport(true)}
          disabled={TONE_ONLY ? !toneResult(state) || !data?.log : !data?.log && !data?.sim}
        >
          <span className="hidden sm:inline">Отчёт для письма</span>
        </Button>
      }
      below={<SectionJob kinds={["discover", "run", "rejudge", "cards"]} />}
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
      />
      {data && (data.log || data.sim) && (
        <ReportSheet
          open={report}
          onClose={() => {
            setReport(false);
            drop("report");
          }}
          data={TONE_ONLY ? { ...data, sim: null } : data}
          list={list}
        />
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
        <div className="grid gap-12 px-4 pt-12 lg:grid-cols-2 lg:px-10">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  // Tone-only mode: the overview is the tone-of-voice result, never the accuracy one or the simulations.
  if (TONE_ONLY ? !toneResult(state) || !data.log : !data.log && !state.runs.length)
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="min-h-0 flex-1 overflow-auto">
          <FirstRun />
        </div>
        {sheets}
      </div>
    );

  const run = (data.sim && state.runs.find((r) => r.id === data.sim!.runId)) || null;
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[1180px] px-4 pb-24 pt-8 lg:px-10 lg:pt-12">
          <p className="text-read text-fg-3">{[agent?.name, agent?.description].filter(Boolean).join(" · ")}</p>
          <h2 className="mt-1 text-page font-semibold text-fg">
            {TONE_ONLY ? "Как агент общается с клиентами" : "Как работает агент"}
          </h2>
          <p className="mt-3 max-w-[64ch] text-lead text-fg-2">
            {TONE_ONLY
              ? "Tone of voice: настоящие диалоги из выгрузки чата проверены по вашим правилам общения."
              : `${stagesSentence(data)} Сначала — настоящие диалоги из выгрузки чата. Из найденных в них ошибок собираются сценарии, и синтетические клиенты разыгрывают их с агентом. Счёт у каждого этапа свой.`}
          </p>
          <div className={cn("mt-14 grid gap-x-16 gap-y-20", TONE_ONLY ? "max-w-[640px]" : "lg:grid-cols-2")}>
            <LogStage
              data={data}
              list={list}
              metric={toneResult(state) ? "Tone of voice" : "Точность по коду агента"}
            />
            {!TONE_ONLY && <SimStage list={list} run={run} />}
          </div>
          <NextSteps
            data={data}
            problems={list.filter((c) => c.r.log.failed > 0).length}
            ready={state.targets.some((t) => t.ready)}
            onReport={() => setReport(true)}
          />
        </div>
      </div>
      {sheets}
    </div>
  );
}

/** The head of a stage: its number in the order of the work, its name (the way into it), what it checks. */
function StageHead({ n, stage, title, sub }: { n: 1 | 2; stage: Stage; title: string; sub: ReactNode }) {
  return (
    <div>
      <Link
        to={stageLink(stage)}
        className="group inline-flex items-center gap-3 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
      >
        <Step n={n} size="lg" />
        <span className="text-title font-semibold text-fg">{title}</span>
        <ArrowRight
          aria-hidden
          className="size-5 text-fg-4 transition-transform group-hover:translate-x-0.5 group-hover:text-fg-2"
        />
      </Link>
      <p className="mt-1.5 text-read text-fg-3 lg:truncate">{sub}</p>
    </div>
  );
}

function LogStage({
  data,
  list,
  metric,
}: {
  data: Problems;
  list: ReturnType<typeof useCriteria>["list"];
  metric: string;
}) {
  const log = data.log;
  return (
    <section aria-label="Диалоги">
      <StageHead
        n={1}
        stage="log"
        title="Диалоги"
        sub={
          log ? (
            <>
              {metric} · проверено {longDay(log.finishedAt)}
            </>
          ) : (
            "Настоящие разговоры клиентов из выгрузки чата"
          )
        }
      />
      {log ? (
        <>
          <StageResult
            size="display"
            className="mt-8"
            failed={log.withViolations}
            checked={log.assessed}
            unchecked={log.unassessed}
          />
          <Trust data={data} stage="log" checked={log.assessed} />
          <h3 className="mt-12 text-read font-semibold text-fg">Главные проблемы</h3>
          <div className="mt-1">
            <ProblemList list={list} stage="log" limit={3} />
          </div>
          <Link
            to={stageLink("log")}
            className="mt-3 inline-flex items-center gap-1 text-read font-medium text-run hover:underline"
          >
            Все проблемы диалогов
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </>
      ) : (
        <div className="mt-8">
          <p className="max-w-[44ch] text-lead text-fg-2">
            Диалоги ещё не оценены. Выберите, что проверяем: tone of voice или точность по коду агента.
          </p>
          <Link to={SECTIONS.start} className={`mt-5 ${buttonClass({ variant: "primary" })}`}>
            Начать проверку
          </Link>
        </div>
      )}
    </section>
  );
}

function SimStage({ list, run }: { list: ReturnType<typeof useCriteria>["list"]; run: LabRun | null }) {
  const m = run?.metric;
  return (
    <section aria-label="Симуляции">
      <StageHead
        n={2}
        stage="sim"
        title="Симуляции"
        sub={
          run ? (
            <span title={run.label || undefined}>
              Синтетические клиенты по сценариям из ошибок в диалогах · {longDay(run.startedAt)}
            </span>
          ) : (
            "Синтетические клиенты по сценариям из ошибок в диалогах"
          )
        }
      />
      {run && m?.measured ? (
        <>
          <StageResult
            size="display"
            className="mt-8"
            failed={m.failed}
            checked={m.measured}
            unchecked={Math.max(0, (m.total ?? 0) - m.measured)}
          />
          <h3 className="mt-12 text-read font-semibold text-fg">Главные проблемы</h3>
          <div className="mt-1">
            <ProblemList list={list} stage="sim" runId={run.id} limit={3} />
          </div>
          <Link
            to={stageLink("sim", run.id)}
            className="mt-3 inline-flex items-center gap-1 text-read font-medium text-run hover:underline"
          >
            Весь прогон
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </>
      ) : (
        <div className="mt-8">
          <p className="max-w-[44ch] text-lead text-fg-2">
            Симуляций ещё не было. Синтетические клиенты сыграют с агентом сценарии из ошибок в диалогах, и вы увидите
            их до настоящих клиентов.
          </p>
          <Link to={SECTIONS.simulations} className="mt-5 inline-flex">
            <Button variant="primary" icon={Play}>
              Открыть симуляции
            </Button>
          </Link>
        </div>
      )}
    </section>
  );
}

/** What to do next, from what the data says now: the person's answers, the hand-off, the check on a simulation. */
function NextSteps({
  data,
  problems,
  ready,
  onReport,
}: {
  data: Problems;
  problems: number;
  ready: boolean;
  onReport: () => void;
}) {
  const disputed = verdictQueue(data, "disputed", null, "log").length;
  const unchecked = verdictQueue(data, "unchecked", null, "log").length;
  const steps = [
    disputed > 0
      ? {
          icon: ClipboardCheck,
          title: `Ответьте на ${count(disputed, "спорный случай", "спорных случая", "спорных случаев")}`,
          sub: "Две проверки разошлись: ваш ответ решит, ошибка это или нет.",
          to: reviewLink("log", { queue: "disputed" }),
        }
      : unchecked > 0
        ? {
            icon: ClipboardCheck,
            title: `Подтвердите ${count(unchecked, "найденную ошибку", "найденные ошибки", "найденных ошибок")}`,
            sub: "По одной: «да, ошибка» или «нет».",
            to: reviewLink("log", { queue: "unchecked" }),
          }
        : null,
    problems > 0
      ? {
          icon: FileText,
          title: `Передайте ${count(problems, "проблему", "проблемы", "проблем")} разработчикам`,
          sub: "Лист с примерами из разговоров — в письмо или тикет.",
          run: onReport,
        }
      : null,
    TONE_ONLY
      ? null
      : ready
        ? {
            icon: Play,
            title: "Проверьте исправление на симуляции",
            sub: "Синтетические клиенты сыграют сценарии из этих ошибок.",
            to: `${SECTIONS.simulations}?play=1`,
          }
        : {
            icon: Bot,
            title: "Подключите агента",
            sub: "Тогда исправления можно проверять, не дожидаясь новой выгрузки чата.",
            to: SECTIONS.agent,
          },
  ].filter(Boolean) as { icon: typeof Play; title: string; sub: string; to?: string; run?: () => void }[];
  return (
    <section aria-label="Что сделать" className="mt-16 border-t border-line pt-10">
      <h2 className="text-title font-semibold text-fg">Что сделать</h2>
      <ul className="mt-6 grid gap-x-10 gap-y-6 md:grid-cols-3">
        {steps.map((s) => {
          const body = (
            <>
              <span className="flex size-10 flex-shrink-0 items-center justify-center rounded-full bg-hover text-fg-2 transition-colors group-hover:bg-selected">
                <s.icon aria-hidden className="size-[18px]" strokeWidth={1.7} />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1 text-read font-semibold text-fg">
                  {s.title}
                  <ArrowRight
                    aria-hidden
                    className="size-4 text-fg-4 transition-transform group-hover:translate-x-0.5"
                  />
                </span>
                <span className="mt-0.5 block text-body text-fg-3">{s.sub}</span>
              </span>
            </>
          );
          const cls =
            "group flex w-full items-start gap-3.5 rounded-block text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60";
          return (
            <li key={s.title}>
              {s.to ? (
                <Link to={s.to} className={cls}>
                  {body}
                </Link>
              ) : (
                <button type="button" onClick={s.run} className={cls}>
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
