import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { useLabState } from "../../lab/LabProvider";
import { CHECK_STEPS, nextStep, toneResult, type CheckStep } from "../../lab/tone";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Materials } from "./Materials";
import { Criteria } from "./Criteria";
import { Checking } from "./Checking";
import { Result } from "./Result";

export function CheckPage() {
  const { state, offline, refresh } = useLabState();
  const [params, setParams] = useSearchParams();
  const raw = params.get("step");
  const asked = CHECK_STEPS.find((s) => s.id === raw)?.id ?? nextStep(state);
  const ready = !!state?.toneOfVoice;
  const finished = !!toneResult(state);
  const step =
    asked === "checking" && !ready
      ? nextStep(state)
      : asked === "result" && !finished
        ? nextStep(state)
        : (asked === "criteria" || asked === "checking") && !ready && state?.job.kind !== "tone-criteria"
          ? "materials"
          : asked;
  const go = (next: CheckStep) => setParams({ step: next });
  const at = CHECK_STEPS.findIndex((s) => s.id === step);
  const header = <Header title="Проверка tone of voice" crumbs={[{ label: "Начать проверку", to: "/start" }]} />;
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
        <Skeleton className="m-6 h-80" />
      </div>
    );
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[980px] px-4 pb-24 pt-6 lg:px-10 lg:pt-8">
          {step !== "result" && (
            <nav aria-label="Шаги проверки">
              <ol className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:gap-x-5">
                {CHECK_STEPS.map((s, i) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      disabled={state.job.running || i > at || (s.id === "result" && !finished)}
                      onClick={() => go(s.id)}
                      aria-current={s.id === step ? "step" : undefined}
                      className={cn(
                        "flex items-center gap-2 rounded-full text-body disabled:cursor-default",
                        i === at ? "font-semibold text-fg" : "text-fg-3",
                      )}
                    >
                      <span
                        className={cn(
                          "grid size-6 place-items-center rounded-full text-small tabular-nums",
                          i === at ? "bg-fg text-canvas" : "bg-hover",
                        )}
                      >
                        {i + 1}
                      </span>
                      {s.label}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
          )}
          <div className={step === "result" ? "" : "mt-9"}>
            {offline && (
              <p role="alert" className="mb-5 text-body text-bad">
                Связь с сервисом потеряна.{" "}
                <button type="button" className="underline" onClick={() => refresh()}>
                  Попробовать ещё раз
                </button>
              </p>
            )}
            {step === "materials" && <Materials state={state} onNext={() => go("criteria")} />}
            {step === "criteria" && (
              <Criteria state={state} onBack={() => go("materials")} onStarted={() => go("checking")} />
            )}
            {step === "checking" && (
              <Checking state={state} onBack={() => go("criteria")} onDone={() => go("result")} />
            )}
            {step === "result" && <Result state={state} onAgain={() => go("criteria")} />}
          </div>
          <Link to="/overview" className="mt-12 inline-flex items-center gap-1.5 text-body text-fg-3 hover:text-fg">
            <ArrowLeft aria-hidden className="size-3.5" />
            Рабочая область
          </Link>
        </div>
      </div>
    </div>
  );
}
