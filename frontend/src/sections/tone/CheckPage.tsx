import { Link, useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { buttonClass } from "../../ui/Button";
import { launchLink, SECTIONS } from "../../app/links";
import { useLabState } from "../../lab/LabProvider";
import { CHECK_STEPS, nextStep, toneResult, type CheckStep } from "../../lab/tone";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Materials } from "./Materials";
import { Criteria } from "./Criteria";
import { Checking } from "./Checking";
import { Result } from "./Result";

/**
 * Tone of voice step by step: the export and the rules of communication, the criteria collected from them, the check,
 * its result. Without a step in the address it opens where the work stands.
 */
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
  // A step the page moves to by itself replaces the one it left: «Назад» from the result goes to the criteria, not to a
  // finished check that would move forward again.
  const go = (next: CheckStep, replace = false) => setParams({ step: next }, { replace });
  const at = CHECK_STEPS.findIndex((s) => s.id === step);
  const header = (
    <Header
      title="Правила и отдельные критерии"
      crumbs={[{ label: "Tone of voice", to: SECTIONS.tone }]}
      actions={
        <Link to={launchLink("tone")} className={buttonClass()}>
          К запуску с режимами
        </Link>
      }
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
                      disabled={state.job.running || (s.id === "result" ? !finished : i > at)}
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
                Нет связи с сервисом.{" "}
                <button type="button" className="underline" onClick={() => refresh()}>
                  Попробовать ещё раз
                </button>
              </p>
            )}
            {step === "materials" && (
              <Materials
                key={state.toneOfVoice?.revision ?? state.sources.find((s) => s.id === "tone-of-voice")?.sha256}
                state={state}
                onNext={() => go("criteria")}
              />
            )}
            {step === "criteria" && (
              <Criteria state={state} onBack={() => go("materials")} onStarted={() => go("checking")} />
            )}
            {step === "checking" && (
              <Checking
                state={state}
                onBack={() => go("criteria")}
                onDone={() => go("result", true)}
                onResult={() => go("result")}
              />
            )}
            {step === "result" && <Result state={state} onAgain={() => go("criteria")} />}
          </div>
        </div>
      </div>
    </div>
  );
}
