import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, Database, Presentation } from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import {
  criterionLink,
  launchLink,
  problemLink,
  reviewLink,
  scenariosLink,
  SECTIONS,
  stageLink,
  stageRoot,
  type Check,
} from "../../app/links";
import { useAgent, type CheckLine } from "../../lab/agents";
import { BY_CRITERIA, CHECK_NAME, CHECKS, checkOfOld, resultOf } from "../../lab/checks";
import { comparisonOf, previousOf, useCompare } from "../../lab/compare";
import { useCriteria } from "../../lab/criteria";
import { useDatasets } from "../../lab/datasets";
import { count, longDay } from "../../lab/format";
import { useJudges } from "../../lab/judges";
import { useLabState } from "../../lab/LabProvider";
import { isRunning } from "../../lab/runs";
import { seriousOf } from "../../lab/severity";
import { codeSources } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { runAnswersPending } from "../../lab/verdicts";
import { CheckResult } from "../../product/CheckResult";
import { AccuracyPicture, PAPER, SimulationPicture, TonePicture } from "../../product/Pictures";
import { seriousStep } from "../../product/Severity";
import { answersPending } from "../../product/Trust";
import { UploadButton } from "../../product/UploadLogs";
import { buttonClass } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Label } from "../../ui/Label";
import { CheckReport } from "../checks/CheckReport";
import { CompareDelta, PreviousCheck } from "../checks/Compare";
import { shownName } from "../data/DatasetInfo";
import { checked, queueOf } from "../problems/model";
import { useSimRuns } from "../simulations/stage";

/**
 * The person connected their agent: they set its address on the test stand, or its folder can start it from its code.
 * The address on this computer is built in («local-http»), so it says nothing about their agent.
 */
const connected = (state: LabState) => state.targets.some((t) => t.ready && t.id !== "local-http");

/** The one next step of a card; `todo` — a step of the work not done yet, which can be the screen's black button. */
type Step = { label: string; to: string; todo: boolean };

/**
 * What a card says: the result in a line, how it stands to the previous check, the main problem — or, without a
 * result, where it stands — and its one next step.
 */
type Model = {
  line?: CheckLine;
  sub?: string;
  delta?: ReactNode;
  status?: string;
  note?: ReactNode;
  problem?: { title: string; failed: number; of: number; to: string };
  step: Step;
};

/**
 * One check on the card: with a result, its line, the chip of its previous check, its main problem, and the step after
 * it in the order «Итог» takes them (the model's answers, the serious errors, the main problem). Without one, what it
 * lacks and the way to it, as «Критерии» and «Новая проверка» say it; after a new export, its previous check beside.
 */
function useCheckModel(check: Check, state: LabState | null): Model | null {
  const result = resultOf(state, check);
  const { data, list } = useCriteria(result ? check : null);
  const { data: answer } = useCompare(check);
  const judges = useJudges(check);
  if (!state) return null;
  const compare = comparisonOf(answer, result);
  if (result) {
    const { failed, measured, unmeasured } = result.summary;
    const top = queueOf(list, "log")[0];
    const step: Step = answersPending(result)
      ? { label: "Проверьте оценки модели", to: reviewLink(check, { queue: "unchecked" }), todo: true }
      : seriousStep(data) === "todo"
        ? { label: "Подтвердите серьёзные ошибки", to: stageRoot(check), todo: true }
        : top
          ? { label: "Разберите главную проблему", to: problemLink(top.r.id, check), todo: false }
          : { label: "Открыть итог", to: stageRoot(check), todo: false };
    return {
      line: { failed, measured, unmeasured, finishedAt: result.finishedAt },
      delta: <CompareDelta check={check} compare={compare} serious={seriousOf(data)?.marked} brief />,
      problem: top && {
        title: top.r.title,
        failed: top.r.log.failed,
        of: checked(top.r.log),
        to: problemLink(top.r.id, check),
      },
      step,
    };
  }
  const job = state.job;
  const own = check === "tone" ? ["tone-check", "tone-criteria"] : ["discover"];
  if (job.running && (own.includes(job.kind ?? "") || (job.kind === "launch" && job.input?.check === check)))
    return {
      status: job.kind === "tone-criteria" ? "Собираем критерии из правил общения." : "Идёт проверка разговоров.",
      step: {
        label: "Открыть",
        to: job.kind === "tone-criteria" ? criterionLink("tone") : stageRoot(check),
        todo: false,
      },
    };
  const previous = previousOf(compare, state.logs.updatedAt);
  if (previous?.newExport)
    return {
      status: "Новая выгрузка ещё не проверена.",
      note: <PreviousCheck check={check} line={previous.line} className="mt-1 text-small" />,
      step: { label: "Проверить новую выгрузку", to: launchLink(check), todo: true },
    };
  // Ready as «Новая проверка» counts it: the chosen rules have criteria, or Точность reads them from the agent's code.
  const rules = judges.data?.versions.find((v) => v.id === judges.data?.selectedId);
  const code = check === "code" && codeSources(state).length > 0;
  if (rules?.criteria.length || code)
    return {
      status: rules?.criteria.length
        ? `${count(rules.criteria.length, "критерий", "критерия", "критериев")} из «${rules.name}» готовы.`
        : "Критерии соберутся из кода агента при первой проверке.",
      step: { label: "Новая проверка", to: launchLink(check), todo: true },
    };
  return check === "tone"
    ? {
        status: "Нужны правила общения: из них соберутся критерии.",
        step: { label: "Добавить правила", to: criterionLink("tone"), todo: true },
      }
    : {
        status: "Нужен код агента: из его инструкций и инструментов соберутся критерии.",
        step: { label: "Подключить код агента", to: `${SECTIONS.agent}?return=code`, todo: true },
      };
}

/**
 * The simulation on its card: the last run with a result — its own number, by the criteria of its check, never set
 * beside the checks' — its main problem and the step after it; or, before any run, the way to the first: build the
 * scenarios, connect the agent, play them.
 */
function useSimModel(state: LabState | null): Model | null {
  const { finished, run: newest } = useSimRuns(state, null);
  const live = !!newest && isRunning(newest);
  const counted = live ? undefined : finished.find((r) => r.metric?.measured);
  const run = counted ?? newest;
  const criteria = useCriteria(run?.check ?? null, run && !live ? run.id : null);
  if (!state) return null;
  const deck = state.cards?.cards.length ? state.cards : null;
  if (!run) {
    if (!deck)
      return {
        status: "Симуляций ещё не было. Сценарии собирают из ошибок одной из проверок.",
        step: { label: "Собрать сценарии", to: scenariosLink(), todo: CHECKS.some((c) => !!resultOf(state, c)) },
      };
    return connected(state)
      ? {
          status: `Сценарии ${BY_CRITERIA[deck.check]} собраны. Синтетические клиенты сыграют их с агентом.`,
          step: { label: "Сыграть сценарии", to: `${SECTIONS.simulations}?play=1`, todo: true },
        }
      : {
          status: `Сценарии ${BY_CRITERIA[deck.check]} собраны. Чтобы их сыграть, нужен подключённый агент.`,
          step: { label: "Подключить агента", to: SECTIONS.agent, todo: true },
        };
  }
  const open = { label: "Открыть прогон", to: stageLink("sim", run.id), todo: false };
  if (live) return { status: "Идёт прогон: синтетические клиенты играют сценарии.", step: open };
  const m = run.metric;
  if (!m?.measured)
    return {
      status:
        run.status === "failed"
          ? `Прогон прервался${run.error ? `: ${run.error}` : "."}`
          : "Разговоры прогона ещё не оценены.",
      step: open,
    };
  const top = queueOf(criteria.list, "sim")[0];
  const answering = !!criteria.data?.sim && runAnswersPending(criteria.data);
  return {
    line: {
      failed: m.failed,
      measured: m.measured,
      unmeasured: Math.max(0, (m.total ?? 0) - m.measured),
      finishedAt: run.startedAt,
    },
    sub: `Последний прогон ${BY_CRITERIA[run.check]}`,
    problem: top && {
      title: top.r.title,
      failed: top.r.sim.failed,
      of: checked(top.r.sim),
      to: problemLink(top.r.id, "sim", run.id),
    },
    step: answering
      ? { label: "Проверьте оценки модели", to: reviewLink("sim", { run: run.id, queue: "unchecked" }), todo: true }
      : top
        ? { label: "Разберите главную проблему", to: problemLink(top.r.id, "sim", run.id), todo: false }
        : open,
  };
}

/**
 * A check, or the simulation, as a card — the same as on «Датасеты»: a picture of what it looks at, its name leading
 * to its section, its result in a line, the main problem, and its one next step. `main` — the screen's black button.
 */
function Card({
  name,
  to,
  picture,
  model,
  main,
}: {
  name: string;
  to: string;
  picture: ReactNode;
  model: Model;
  main: boolean;
}) {
  const title = (
    <Link
      to={to}
      className="group inline-flex items-center gap-1 rounded-sm font-medium text-fg-2 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
    >
      {name}
      <ArrowRight aria-hidden className="size-3.5 text-fg-4 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
  return (
    <section aria-label={name} className="flex gap-4 rounded-block border border-line bg-canvas p-3 pr-4">
      <div aria-hidden className={cn("hidden w-28 shrink-0 sm:block", PAPER)}>
        {picture}
      </div>
      <div className="flex min-w-0 flex-1 flex-col py-1">
        {model.line ? (
          <CheckResult name={title} line={model.line} />
        ) : (
          <>
            <p className="text-small">{title}</p>
            <p className="mt-1 text-body text-fg-3">{model.status}</p>
          </>
        )}
        {model.sub && <p className="mt-1.5 text-small text-fg-3">{model.sub}</p>}
        {model.delta && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-small text-fg-3 empty:hidden">
            {model.delta}
          </div>
        )}
        {model.note}
        {model.problem && (
          <Link
            to={model.problem.to}
            className="group mt-3 block rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
          >
            <span className="block text-small text-fg-3">Главная проблема</span>
            <span className="mt-0.5 flex items-baseline gap-2">
              <span className="min-w-0 truncate text-body text-fg group-hover:underline">{model.problem.title}</span>
              <span className="shrink-0 text-small tabular-nums text-fg-3">
                {model.problem.failed}
                {" из "}
                {model.problem.of}
              </span>
            </span>
          </Link>
        )}
        <div className="mt-auto pt-4">
          <Link to={model.step.to} className={buttonClass({ variant: main ? "primary" : "outline", size: "sm" })}>
            {model.step.label}
          </Link>
        </div>
      </div>
    </section>
  );
}

/** The export the checks read, in a line leading to «Датасеты»; without one, the way to load it — then the first step. */
function DatasetLine() {
  const library = useDatasets();
  if (!library.data) return <Skeleton className="mt-6 h-6 w-80" />;
  const listed = library.data.datasets.filter((d) => !d.archivedAt);
  const d = listed.find((x) => x.id === library.data?.activeId) ?? listed[0];
  if (!d)
    return (
      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
        <p className="text-read text-fg-2">Разговоров ещё нет: проверки читают выгрузку чата.</p>
        <UploadButton label="Загрузить выгрузку" />
      </div>
    );
  return (
    <Link
      to={SECTIONS.data}
      className="group mt-6 inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-control text-read text-fg-3 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
    >
      <Database aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 break-words font-medium text-fg">«{shownName(d)}»</span>
      <span>· {count(d.total, "разговор", "разговора", "разговоров")}</span>
      <span>· загружен {longDay(d.createdAt)}</span>
      <ArrowRight aria-hidden className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

/**
 * «Обзор»: how the agent is doing and what to do next, at a glance. The export the checks read; then each check and the
 * simulation as a card — its own number, never added up with the others, how it stands to its own previous check, its
 * main problem and its one next step. The screen's one black button is the first step not done, in the order of the
 * work: the export, tone of voice, Точность, the simulation. A new agent sees the same cards with what each lacks.
 */
export function OverviewPage() {
  const { state, offline } = useLabState();
  const agent = useAgent();
  const tone = useCheckModel("tone", state);
  const code = useCheckModel("code", state);
  const sim = useSimModel(state);
  const compares = { tone: useCompare("tone"), code: useCompare("code") };
  const [params, setParams] = useSearchParams();
  const [report, setReport] = useState<Check | null>(null);
  // ?report=tone|code opens that check's report; an older ?report=1 the check that has a result.
  const asked = params.get("report");
  useEffect(() => {
    if (asked && state) setReport(asked === "tone" || asked === "code" ? asked : checkOfOld(state));
  }, [asked, state]);
  const closeReport = () => {
    setReport(null);
    if (asked)
      setParams(
        (prev) => {
          const n = new URLSearchParams(prev);
          n.delete("report");
          return n;
        },
        { replace: true },
      );
  };

  const header = (
    <Header
      title="Обзор"
      actions={
        // The page to show management: once a check has a result to put on it.
        CHECKS.some((c) => resultOf(state, c)) && (
          <Link
            to={SECTIONS.summary}
            aria-label="Сводка для руководителя"
            className={buttonClass({ variant: "outline" })}
          >
            <Presentation aria-hidden className="size-3.5" />
            <span className="hidden sm:inline">Сводка для руководителя</span>
          </Link>
        )
      }
      below={<SectionJob kinds={["tone-check", "tone-criteria", "discover", "severity", "run", "rejudge", "cards"]} />}
    />
  );
  if (offline && !state)
    return (
      <div className="flex h-full flex-col">
        {header}
        <ServiceDown />
      </div>
    );
  if (!state || !tone || !code || !sim)
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="grid gap-3 px-4 pt-12 md:grid-cols-2 lg:px-10">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </div>
    );

  // A check with saved checks is past its first visit, even when a new export has no result yet.
  const blank = !CHECKS.some((c) => resultOf(state, c)) && !state.runs.length;
  const saved = CHECKS.some((c) => compares[c].data?.previous || compares[c].data?.current);
  const first = blank && !saved;
  // The first step not done, in the order of the work; without conversations, loading them is that step.
  const main = !state.logs.total ? -1 : [tone, code, sim].findIndex((m) => m.step.todo);
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[1180px] px-4 pb-24 pt-8 lg:px-10 lg:pt-12">
          <p className="text-read text-fg-3">{[agent?.name, agent?.description].filter(Boolean).join(" · ")}</p>
          <h2 className="mt-1 text-page font-semibold text-fg">{first ? "С чего начать" : "Как работает агент"}</h2>
          <p className="mt-3 max-w-[66ch] text-lead text-fg-2">
            {first
              ? "Загрузите разговоры и задайте правила: покажем, где агент ошибается и что исправить."
              : "У каждой проверки и у симуляций свой счёт: их числа не складываются, и каждая сравнивает себя только со своей прошлой."}
          </p>
          <DatasetLine />
          <section aria-labelledby="overview-checks" className="mt-12">
            <Label id="overview-checks">Проверки разговоров</Label>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <Card
                name={CHECK_NAME.tone}
                to={stageRoot("tone")}
                picture={<TonePicture />}
                model={tone}
                main={main === 0}
              />
              <Card
                name={CHECK_NAME.code}
                to={stageRoot("code")}
                picture={<AccuracyPicture />}
                model={code}
                main={main === 1}
              />
            </div>
          </section>
          <section aria-labelledby="overview-trials" className="mt-10">
            <Label id="overview-trials">Испытания</Label>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <Card
                name="Симуляции"
                to={SECTIONS.simulations}
                picture={<SimulationPicture />}
                model={sim}
                main={main === 2}
              />
            </div>
          </section>
        </div>
      </div>
      {report && <CheckReport check={report} open onClose={closeReport} />}
    </div>
  );
}
