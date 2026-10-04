import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, Bot, ClipboardCheck, FileText, Hammer, Play, type LucideIcon } from "lucide-react";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import {
  conversationsLink,
  reviewLink,
  scenariosLink,
  SECTIONS,
  stageLink,
  stageRoot,
  toneCheckLink,
  type Check,
} from "../../app/links";
import { useAgent } from "../../lab/agents";
import { BY_CRITERIA, CHECK_NAME, CHECKS, checkOfOld, resultOf } from "../../lab/checks";
import { comparisonOf, previousOf, useCompare, type Compare } from "../../lab/compare";
import { useCriteria } from "../../lab/criteria";
import { longDay, count } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { isRunning } from "../../lab/runs";
import { codeSources } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { queueOf as verdictQueue } from "../../lab/verdicts";
import { StageResult } from "../../product/StageResult";
import { Trust } from "../../product/Trust";
import { buttonClass } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Label } from "../../ui/Label";
import { CheckReport } from "../checks/CheckReport";
import { CompareLine, PreviousCheck } from "../checks/Compare";
import { Needs, needsOf, type Need } from "../checks/Start";
import { ProblemList } from "../problems/ProblemList";
import { useSimRuns } from "../simulations/stage";

const PART = { bad: "fail", ok: "pass", none: "none" } as const;

/** What each check is about, in the words of the person who answers for the agent. */
const WHAT: Record<Check, string> = {
  tone: "Как агент общается: обращение, тон, ясность и нормы общения — по вашим правилам.",
  code: "Делает ли агент то, что требуют его промпты и инструменты: отвечает по инструкции и ничего не выдумывает.",
};

/** Where a check without a result stands, and its one way forward. */
type Begin = { status?: string; needs: Need[]; action?: { label: string; to: string } };

/** A new export not checked yet, when the check has saved checks before it: the same way forward, named so. */
const FRESH = "Новая выгрузка ещё не проверена";

function beginOf(check: Check, state: LabState, fresh = false): Begin {
  const job = state.job;
  if (check === "tone") {
    if (job.running && job.kind === "tone-check")
      return {
        status: "Идёт проверка",
        needs: needsOf("tone", state),
        action: { label: "Ход проверки", to: toneCheckLink("checking") },
      };
    if (fresh)
      return {
        status: FRESH,
        needs: needsOf("tone", state),
        action: { label: "Проверить новую выгрузку", to: toneCheckLink() },
      };
    const begun = !!state.toneOfVoice || (job.running && job.kind === "tone-criteria");
    return {
      status: begun ? "Проверка начата" : undefined,
      needs: needsOf("tone", state),
      action: begun
        ? { label: "Продолжить проверку", to: toneCheckLink() }
        : { label: "Начать проверку", to: toneCheckLink("materials") },
    };
  }
  if (job.running && job.kind === "discover")
    return {
      status: "Идёт оценка",
      needs: needsOf("code", state),
      action: { label: "Открыть", to: SECTIONS.accuracy },
    };
  if (!codeSources(state).length)
    return {
      status: "Нужен код агента",
      needs: needsOf("code", state),
      action: { label: "Прочитать код", to: SECTIONS.agent },
    };
  if (fresh)
    return {
      status: FRESH,
      needs: needsOf("code", state),
      action: { label: "Проверить новую выгрузку", to: SECTIONS.accuracy },
    };
  return { needs: needsOf("code", state), action: { label: "Оценить разговоры", to: SECTIONS.accuracy } };
}

/**
 * «Обзор»: how the agent is doing. Each check of the real conversations says its own number, how it stands to its own
 * previous check, and its main problems; the last run of the simulation says its own, with the check it was counted
 * by; never added up or compared with each other. Then what to do, check by check. Before anything is checked: where
 * to begin; after a new export, each check's previous check until it is checked again.
 */
export function OverviewPage() {
  const { state, offline } = useLabState();
  const agent = useAgent();
  const compares: Record<Check, { data?: Compare; isLoading: boolean }> = {
    tone: useCompare("tone"),
    code: useCompare("code"),
  };
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
      below={<SectionJob kinds={["tone-check", "tone-criteria", "discover", "run", "rejudge", "cards"]} />}
    />
  );
  if (offline && !state)
    return (
      <div className="flex h-full flex-col">
        {header}
        <ServiceDown />
      </div>
    );
  if (!state)
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="grid gap-12 px-4 pt-12 lg:grid-cols-2 lg:px-10">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );

  // A check with saved checks is past its first visit, even when a new export has no result yet.
  const blank = !CHECKS.some((c) => resultOf(state, c)) && !state.runs.length;
  const saved = CHECKS.some((c) => compares[c].data?.previous || compares[c].data?.current);
  if (blank && CHECKS.some((c) => compares[c].isLoading))
    return (
      <div className="flex h-full flex-col">
        {header}
        <Skeleton className="mx-4 mt-12 h-96 lg:mx-10" />
      </div>
    );
  const first = blank && !saved;
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[1180px] px-4 pb-24 pt-8 lg:px-10 lg:pt-12">
          <p className="text-read text-fg-3">{[agent?.name, agent?.description].filter(Boolean).join(" · ")}</p>
          <h2 className="mt-1 text-page font-semibold text-fg">{first ? "С чего начать" : "Как работает агент"}</h2>
          <p className="mt-3 max-w-[66ch] text-lead text-fg-2">
            {first
              ? "Настоящие разговоры клиентов из выгрузки чата проверяются двумя проверками, у каждой свои критерии. Из найденных ошибок потом собираются сценарии для синтетических клиентов."
              : "У каждой проверки свои критерии и свой счёт, у симуляций — свой: их числа не складываются. С прошлой выгрузкой каждая проверка сравнивает себя сама — по тем же критериям."}
          </p>
          {first ? (
            <StartCards state={state} />
          ) : (
            <>
              <section aria-labelledby="overview-checks" className="mt-12">
                <Label id="overview-checks">Проверки разговоров</Label>
                <div className="mt-6 grid gap-x-16 gap-y-16 lg:grid-cols-2">
                  {CHECKS.map((c) => (
                    <CheckBlock key={c} check={c} state={state} />
                  ))}
                </div>
              </section>
              <section aria-labelledby="overview-trials" className="mt-16 border-t border-line pt-10">
                <Label id="overview-trials">Испытания</Label>
                <RunBlock state={state} />
              </section>
              <NextSteps state={state} onReport={setReport} />
            </>
          )}
        </div>
      </div>
      {report && <CheckReport check={report} open onClose={closeReport} />}
    </div>
  );
}

/**
 * The person connected their agent: they set its address on the test stand, or its folder can start it from its code.
 * The address on this computer is built in («local-http»), so it says nothing about their agent.
 */
const connected = (state: LabState) => state.targets.some((t) => t.ready && t.id !== "local-http");

/** The first visit: the three ways in, each with what it needs and what is already here. */
function StartCards({ state }: { state: LabState }) {
  const ready = connected(state);
  const cards: { title: string; what: string; begin: Begin; primary?: boolean }[] = [
    { title: CHECK_NAME.tone, what: WHAT.tone, begin: beginOf("tone", state), primary: true },
    { title: CHECK_NAME.code, what: WHAT.code, begin: beginOf("code", state) },
    {
      title: "Симуляции",
      what: "Синтетические клиенты разыгрывают с агентом сценарии из найденных ошибок, и критерии той же проверки оценивают разговоры.",
      begin: {
        status: "После первой проверки",
        needs: [
          { label: "Итог проверки", value: null, later: "из его ошибок соберутся сценарии" },
          { label: "Подключение агента", value: ready ? "задано" : null, later: "в «Агенте»" },
        ],
        // Nothing to do here before the first check, unless the agent is not connected yet.
        action: ready ? undefined : { label: "Подключить агента", to: SECTIONS.agent },
      },
    },
  ];
  return (
    <ul className="mt-10 grid gap-4 md:grid-cols-3">
      {cards.map((c) => (
        <li key={c.title} className="flex flex-col rounded-block border border-line p-5">
          <h3 className="text-count font-semibold text-fg">{c.title}</h3>
          {c.begin.status && <p className="mt-1 text-small font-medium text-fg-3">{c.begin.status}</p>}
          <p className="mt-2 text-body text-fg-2">{c.what}</p>
          <Needs needs={c.begin.needs} className="mt-4 border-t border-line pt-3" />
          {c.begin.action && (
            <div className="mt-auto pt-6">
              <Link
                to={c.begin.action.to}
                className={buttonClass({ variant: c.primary ? "primary" : "outline", size: "lg" })}
              >
                {c.begin.action.label}
                <ArrowRight aria-hidden className="size-4" />
              </Link>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The head of a block: its name, the way into its section, and one line of what it is. */
function BlockHead({ to, title, sub }: { to: string; title: string; sub: ReactNode }) {
  return (
    <div>
      <Link
        to={to}
        className="group inline-flex items-center gap-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
      >
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

/**
 * One check: its number, how it stands to its previous check, how far to trust it, its three main problems; without a
 * result, how to get one — after a new export, beside the previous check.
 */
function CheckBlock({ check, state }: { check: Check; state: LabState }) {
  const result = resultOf(state, check);
  const { data, list } = useCriteria(result ? check : null);
  const { data: answer } = useCompare(check);
  const compare = comparisonOf(answer, result);
  const log = data?.log;
  if (!result) {
    const previous = previousOf(compare, state.logs.updatedAt);
    const begin = beginOf(check, state, !!previous?.newExport);
    return (
      <section aria-label={CHECK_NAME[check]}>
        <BlockHead
          to={stageRoot(check)}
          title={CHECK_NAME[check]}
          sub={begin.status ?? (previous ? "Итога пока нет" : "Ещё не проверяли")}
        />
        {previous ? (
          <PreviousCheck check={check} line={previous.line} className="mt-6 max-w-[56ch]" />
        ) : (
          <p className="mt-6 max-w-[48ch] text-read text-fg-2">{WHAT[check]}</p>
        )}
        <Needs needs={begin.needs} className="mt-3" />
        {begin.action && (
          <Link to={begin.action.to} className={`mt-5 ${buttonClass({ variant: "outline" })}`}>
            {begin.action.label}
          </Link>
        )}
      </section>
    );
  }
  return (
    <section aria-label={CHECK_NAME[check]}>
      <BlockHead
        to={stageRoot(check)}
        title={CHECK_NAME[check]}
        sub={`${state.logs.file ? `«${state.logs.file}» · ` : ""}проверено ${longDay(result.finishedAt)}`}
      />
      {data && log ? (
        <>
          <StageResult
            size="display"
            className="mt-8"
            failed={log.withViolations}
            checked={log.assessed}
            unchecked={log.unassessed}
            link={(part) => conversationsLink(check, { v: PART[part] })}
          />
          <CompareLine check={check} compare={compare} short className="mt-4" />
          <Trust data={data} check={check} checked={log.assessed} />
          <h3 className="mt-12 text-read font-semibold text-fg">Главные проблемы</h3>
          <div className="mt-1">
            <ProblemList list={list} stage={check} limit={3} />
          </div>
          <Link
            to={stageRoot(check)}
            className="mt-3 inline-flex items-center gap-1 text-read font-medium text-run hover:underline"
          >
            Все проблемы
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </>
      ) : (
        <Skeleton className="mt-8 h-72" />
      )}
    </section>
  );
}

/**
 * The last run of the simulation, with the check whose criteria counted it; its own number, never beside a sum. A run
 * without results (the agent answered in no conversation, or none is judged yet) is not the latest result: the latest
 * run with results stands, and one line says what became of the newer one.
 */
function RunBlock({ state }: { state: LabState }) {
  const { finished, run: newest } = useSimRuns(state, null);
  const live = !!newest && isRunning(newest);
  const counted = live ? undefined : finished.find((r) => r.metric?.measured);
  const run = counted ?? newest;
  const newer = counted && newest && counted.id !== newest.id ? newest : null;
  const { list } = useCriteria(run?.check ?? null, run && !live ? run.id : null);
  const m = run?.metric;
  const deck = state.cards?.cards.length ? state.cards : null;
  if (!run)
    return (
      <div className="mt-6 max-w-[640px]">
        <BlockHead to={SECTIONS.simulations} title="Симуляции" sub="Синтетические клиенты играют сценарии из ошибок" />
        <p className="mt-6 text-read text-fg-2">
          {deck
            ? `Сценарии ${BY_CRITERIA[deck.check]} собраны: синтетические клиенты сыграют их с агентом, и вы увидите ошибки раньше настоящих клиентов.`
            : "Симуляций ещё не было. Сценарии собираются из ошибок одной из проверок, и её критерии оценят разговоры синтетических клиентов."}
        </p>
        <Link
          to={deck ? `${SECTIONS.simulations}?play=1` : scenariosLink()}
          className={`mt-5 ${buttonClass({ variant: "outline" })}`}
        >
          {deck ? "Сыграть сценарии" : "К сценариям"}
        </Link>
      </div>
    );
  return (
    <div className="mt-6 grid gap-x-16 gap-y-10 lg:grid-cols-2">
      <div>
        <BlockHead
          to={stageLink("sim", run.id)}
          title="Симуляции"
          sub={
            <span title={run.label || undefined}>
              {live ? "Идёт прогон" : newer ? "Последний прогон с итогом" : "Последний прогон"} {BY_CRITERIA[run.check]}{" "}
              · {longDay(run.startedAt)}
            </span>
          }
        />
        {newer && (
          <p className="mt-3 max-w-[60ch] text-body text-fg-2">
            <Link
              to={stageLink("sim", newer.id)}
              className="font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg-3"
            >
              Последний прогон{newer.check !== run.check ? ` ${BY_CRITERIA[newer.check]}` : ""},{" "}
              {longDay(newer.startedAt)}, {newer.status === "failed" ? "прервался" : "ещё не оценён"}
            </Link>
            {newer.status === "failed" && newer.error ? `. ${newer.error}` : ""}
          </p>
        )}
        {!live && m?.measured ? (
          <StageResult
            size="display"
            className="mt-8"
            failed={m.failed}
            checked={m.measured}
            unchecked={Math.max(0, (m.total ?? 0) - m.measured)}
          />
        ) : (
          <p className="mt-6 text-read text-fg-2">
            {live
              ? "Синтетические клиенты играют сценарии; итог появится, когда разговоры будут оценены."
              : run.status === "failed"
                ? `Прогон прервался${run.error ? `. ${run.error}` : "."}`
                : "Разговоры этого прогона ещё не оценены."}
          </p>
        )}
      </div>
      {!live && !!m?.measured && (
        <div>
          <h3 className="text-read font-semibold text-fg">Главные проблемы прогона</h3>
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
        </div>
      )}
    </div>
  );
}

type Step = { icon: LucideIcon; title: string; sub: string; to?: string; run?: () => void };

function StepList({ label, steps }: { label: string; steps: Step[] }) {
  if (!steps.length) return null;
  return (
    <div>
      <Label>{label}</Label>
      <ul className="mt-3 space-y-5">
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
                    className="size-4 flex-shrink-0 text-fg-4 transition-transform group-hover:translate-x-0.5"
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
    </div>
  );
}

/** What to do in one check: the person's answers on what it found, then the hand-off of its problems. */
function CheckSteps({ check, onReport }: { check: Check; onReport: () => void }) {
  const { data, list } = useCriteria(check);
  if (!data?.log) return null;
  const disputed = verdictQueue(data, "disputed", null, "log").length;
  // The errors the model found and nobody answered yet, and how many conversations they are in: «28 ошибок» next to
  // «22 разговора с ошибкой» needs its own unit.
  const open = verdictQueue(data, "all", null, "log").filter((v) => v.example.status === "FAIL" && !v.example.review);
  const conversations = new Set(open.map((v) => v.example.dialogueId)).size;
  const problems = list.filter((c) => c.r.log.failed > 0).length;
  const steps: Step[] = [];
  if (disputed)
    steps.push({
      icon: ClipboardCheck,
      title: `Ответьте на ${count(disputed, "спорный случай", "спорных случая", "спорных случаев")}`,
      sub: "Две проверки разошлись: ваш ответ решит, ошибка это или нет.",
      to: reviewLink(check, { queue: "disputed" }),
    });
  else if (open.length)
    steps.push({
      icon: ClipboardCheck,
      title: `Подтвердите ${count(open.length, "найденную ошибку", "найденные ошибки", "найденных ошибок")}`,
      sub: `В ${count(conversations, "разговоре", "разговорах", "разговорах")}. По одной: «да, ошибка» или «нет».`,
      to: reviewLink(check, { queue: "unchecked" }),
    });
  if (problems)
    steps.push({
      icon: FileText,
      title: `Передайте ${count(problems, "проблему", "проблемы", "проблем")} команде агента`,
      sub: "Отчёт с примерами из разговоров — в письмо или тикет.",
      run: onReport,
    });
  return <StepList label={CHECK_NAME[check]} steps={steps} />;
}

/** What to do with the simulation: build the scenarios from a check's errors, play them, or connect the agent. */
function simSteps(state: LabState): Step[] {
  const deck = state.cards?.cards.length ? state.cards : null;
  const ready = connected(state);
  return [
    deck
      ? {
          icon: Play,
          title: "Проверьте исправление на симуляции",
          sub: `Синтетические клиенты сыграют сценарии ${BY_CRITERIA[deck.check]}.`,
          to: `${SECTIONS.simulations}?play=1`,
        }
      : {
          icon: Hammer,
          title: "Соберите сценарии",
          sub: "Из ошибок одной из проверок: синтетические клиенты сыграют их с агентом.",
          to: scenariosLink(),
        },
    ...(ready
      ? []
      : [
          {
            icon: Bot,
            title: "Подключите агента",
            sub: "Тогда исправления можно проверять, не дожидаясь новой выгрузки чата.",
            to: SECTIONS.agent,
          },
        ]),
  ];
}

/** What to do next, check by check, and with the simulation; each from what its own data says now. */
function NextSteps({ state, onReport }: { state: LabState; onReport: (check: Check) => void }) {
  return (
    <section aria-label="Что сделать" className="mt-16 border-t border-line pt-10">
      <h2 className="text-title font-semibold text-fg">Что сделать</h2>
      <div className="mt-6 grid gap-x-10 gap-y-10 md:grid-cols-3">
        {CHECKS.filter((c) => resultOf(state, c)).map((c) => (
          <CheckSteps key={c} check={c} onReport={() => onReport(c)} />
        ))}
        <StepList label="Симуляции" steps={simSteps(state)} />
      </div>
    </section>
  );
}
