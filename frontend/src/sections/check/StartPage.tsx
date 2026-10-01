import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { scenariosLink, SECTIONS } from "../../app/links";
import { count, longDay } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { codeSources, nextStep, TONE_ID, toneResult } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { Step } from "../../product/Step";
import { buttonClass } from "../../ui/Button";
import { History } from "./History";

type Metric = "tone" | "code";

const METRICS: Record<Metric, { name: string; what: string }> = {
  tone: {
    name: "Tone of voice",
    what: "Как агент общается: обращение, тон, ясность и нормы общения — по вашим правилам.",
  },
  code: {
    name: "Точность",
    what: "Делает ли агент то, что требуют его промпты и инструменты: отвечает по инструкции и ничего не выдумывает.",
  },
};

/** What a metric needs before it can be measured: what is already here, or where it will be added. */
function needs(metric: Metric, state: LabState | null) {
  const total = state?.logs.total ?? 0;
  const dialogs = {
    label: "Диалоги",
    value: total ? count(total, "разговор", "разговора", "разговоров") : null,
    later: "загрузите на следующем шаге",
  };
  if (metric === "tone") {
    const policy = state?.sources.find((s) => s.id === TONE_ID);
    return [dialogs, { label: "Правила общения", value: policy?.origin ?? null, later: "добавите на следующем шаге" }];
  }
  const code = codeSources(state).length;
  return [
    dialogs,
    {
      label: "Код агента",
      value: code ? count(code, "источник", "источника", "источников") : null,
      later: "прочитайте в «Агенте»",
    },
  ];
}

/** Where the chosen metric starts: its own guided check, or the assessment by the criteria read from the code. */
function action(metric: Metric, state: LabState | null) {
  if (metric === "tone") {
    const resume =
      !!state?.toneOfVoice || (!!state?.job.running && ["tone-criteria", "tone-check"].includes(state.job.kind ?? ""));
    return {
      label: resume ? "Продолжить проверку" : "Начать проверку",
      to: `/check?step=${resume ? nextStep(state) : "materials"}`,
    };
  }
  if (!codeSources(state).length) return { label: "Прочитать код агента", to: SECTIONS.agent };
  return { label: "Оценить диалоги", to: `${SECTIONS.logs}?assess=code` };
}

/**
 * «Начать проверку»: first what to measure, then the one pipeline every metric goes through — the real dialogues and
 * their metric, scenarios from the errors found there, and synthetic customers playing them with the agent.
 */
export function StartPage() {
  const { state } = useLabState();
  const [params, setParams] = useSearchParams();
  const result = state?.discover ?? null;
  const now: Metric | null = result ? (toneResult(state) ? "tone" : "code") : null;
  const asked = params.get("m");
  const metric: Metric = asked === "tone" || asked === "code" ? asked : (now ?? "tone");
  const choose = (m: Metric) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("m", m);
        return next;
      },
      { replace: true },
    );
  const go = action(metric, state);
  return (
    <div className="flex h-full flex-col">
      <Header title="Начать проверку" />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[980px] px-4 pb-24 pt-10 lg:px-10 lg:pt-14">
          <h2 className="text-page font-semibold text-fg">Что проверяем у агента?</h2>
          <p className="mt-3 max-w-[60ch] text-lead text-fg-2">
            Выберите метрику. Её критерии оценят настоящие диалоги, а потом — сценарии, которые сыграют с агентом
            синтетические клиенты.
          </p>
          <div role="radiogroup" aria-label="Метрика" className="mt-8 grid gap-3 md:grid-cols-2">
            {(["tone", "code"] as const).map((m) => (
              <MetricOption
                key={m}
                metric={m}
                on={m === metric}
                current={now === m ? longDay(result?.finishedAt) : null}
                state={state}
                onPick={() => choose(m)}
              />
            ))}
          </div>
          <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-5">
            <Link to={go.to} className={buttonClass({ variant: "primary", size: "lg" })}>
              {go.label}
              <ArrowRight aria-hidden className="size-4" />
            </Link>
            <Link
              to={SECTIONS.overview}
              className="inline-flex min-h-11 items-center justify-center rounded-control text-read text-fg-3 underline decoration-line-strong underline-offset-4 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 sm:justify-start"
            >
              Обзор результатов
            </Link>
          </div>
          {now && now !== metric && (
            <p className="mt-3 max-w-[64ch] text-body text-fg-3">
              {now === "tone"
                ? "Сейчас в «Диалогах» — проверка tone of voice. Оценка по коду агента займёт её место; проверки tone of voice останутся в истории."
                : "Сейчас в «Диалогах» — оценка по коду агента. Проверка tone of voice займёт её место."}
            </p>
          )}
          <Pipeline state={state} now={now} />
          <History finishedAt={state?.discover?.finishedAt} refreshStamp={String(state?.job.running)} />
        </div>
      </div>
    </div>
  );
}

function MetricOption({
  metric,
  on,
  current,
  state,
  onPick,
}: {
  metric: Metric;
  on: boolean;
  current: string | null;
  state: LabState | null;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onPick}
      className={cn(
        "flex h-full flex-col rounded-block border p-5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
        on ? "border-fg ring-1 ring-fg" : "border-line hover:border-line-strong",
      )}
    >
      <span className="flex w-full items-center justify-between gap-3">
        <span className="text-count font-semibold text-fg">{METRICS[metric].name}</span>
        <span
          aria-hidden
          className={cn(
            "flex size-5 flex-shrink-0 items-center justify-center rounded-full border",
            on ? "border-fg bg-fg" : "border-fg-4",
          )}
        >
          {on && <span className="size-2 rounded-full bg-canvas" />}
        </span>
      </span>
      <span className="mt-2 block text-body text-fg-2">{METRICS[metric].what}</span>
      {current && <span className="mt-2 block text-small text-fg-3">Сейчас в «Диалогах» · проверено {current}</span>}
      <span className="mt-4 block w-full border-t border-line pt-3">
        {needs(metric, state).map((n) => (
          <span key={n.label} className="flex items-start gap-2 py-1 text-body">
            {n.value ? (
              <Check aria-label="есть" className="mt-0.5 size-4 flex-shrink-0 text-ok" />
            ) : (
              <span aria-label="нужно добавить" className="mt-1 size-3 flex-shrink-0 rounded-full border border-fg-4" />
            )}
            <span className="min-w-0">
              <span className="text-fg">{n.label}</span>
              <span className="text-fg-3"> · {n.value ?? n.later}</span>
            </span>
          </span>
        ))}
      </span>
    </button>
  );
}

/**
 * The pipeline in four steps, each with what is already there: the same criteria go from the real dialogues to the
 * scenarios and the synthetic customers. The numbers stay apart: each stage counts its own conversations.
 */
function Pipeline({ state, now }: { state: LabState | null; now: Metric | null }) {
  const total = state?.logs.total ?? 0;
  const summary = state?.discover?.summary;
  const cards = state?.cards?.cards.length ?? 0;
  const runs = state?.runs.length ?? 0;
  const ready = !!state?.targets.some((t) => t.ready);
  const steps: { n?: 1 | 2; title: string; what: string; done: boolean; status: string; to: string }[] = [
    {
      n: 1,
      title: "Диалоги",
      what: "Настоящие разговоры клиентов из выгрузки чата",
      done: total > 0,
      status: total ? count(total, "разговор", "разговора", "разговоров") : "Ещё не загружены",
      to: SECTIONS.logs,
    },
    {
      title: "Метрика",
      what: "Как агент работает сейчас: оценка диалогов по критериям",
      done: !!summary,
      status:
        summary && now
          ? `${METRICS[now].name}: ${summary.failed} из ${summary.measured} с ошибкой`
          : "Диалоги ещё не оценены",
      to: now === "tone" ? "/check?step=result" : SECTIONS.logs,
    },
    {
      title: "Сценарии",
      what: "Ситуации из найденных ошибок с теми же критериями",
      done: cards > 0,
      status: cards ? count(cards, "сценарий", "сценария", "сценариев") : "Соберутся из ошибок",
      to: scenariosLink(),
    },
    {
      n: 2,
      title: "Симуляции",
      what: "Синтетические клиенты играют сценарии с агентом на ИФТ",
      done: runs > 0,
      status: runs
        ? count(runs, "прогон", "прогона", "прогонов")
        : ready
          ? "Агент подключён"
          : "По желанию: подключите агента",
      to: SECTIONS.simulations,
    },
  ];
  return (
    <section aria-labelledby="pipeline-title" className="mt-14 border-t border-line pt-8">
      <h3 id="pipeline-title" className="text-lead font-semibold text-fg">
        Дальше — один конвейер
      </h3>
      <p className="mt-1 max-w-[64ch] text-body text-fg-3">
        Какую метрику ни выберите, она проходит все шаги. Счёт у диалогов и у симуляций свой и не складывается.
      </p>
      <ol className="mt-6 grid sm:grid-cols-4 sm:gap-4">
        {steps.map((s, i) => (
          <li key={s.title} className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 sm:block">
            <div className="flex flex-col items-center sm:flex-row sm:gap-2">
              {s.n ? (
                <Step n={s.n} on={s.done} />
              ) : (
                <span
                  aria-hidden
                  className={cn(
                    "flex size-6 flex-shrink-0 items-center justify-center rounded-full",
                    s.done ? "bg-fg text-white" : "border border-fg-3/70",
                  )}
                >
                  {s.done && <Check className="size-3.5" strokeWidth={2.5} />}
                </span>
              )}
              <span
                aria-hidden
                className={cn("w-px flex-1 bg-line sm:h-px sm:w-auto", i === steps.length - 1 && "hidden")}
              />
            </div>
            <Link
              to={s.to}
              className="group -mx-2 mb-4 block rounded-control px-2 py-1 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 sm:mb-0 sm:mt-2"
            >
              <span className="block text-read font-semibold text-fg">{s.title}</span>
              <span className="mt-0.5 block text-small text-fg-3">{s.what}</span>
              <span className={cn("mt-2 block text-small font-medium", s.done ? "text-fg-2" : "text-fg-3")}>
                {s.status}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
