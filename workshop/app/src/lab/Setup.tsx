import { ArrowRight, Check } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { setupSteps, STEP_TITLE } from "./nav";
import type { LabState, Step } from "./types";
import { Button } from "./ui";

/** Where a setup page is in «① Агент → ② Логи → ③ Сценарии»: each step feeds the next, so the order is shown, not just the list. */
export function SetupSteps({ state, current }: { state: LabState; current: Step }) {
  const navigate = useNavigate();
  const steps = setupSteps(state);
  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-2 pb-3" aria-label="Шаги подготовки">
      {steps.map((s, i) => {
        const on = s.id === current;
        return (
          <li key={s.id} className="flex items-center gap-1.5">
            {i > 0 && <span className="h-px w-5 bg-lab-strong" aria-hidden />}
            <button
              onClick={() => navigate(s.to)} aria-current={on ? "step" : undefined}
              className={cn("lab-focus inline-flex h-7 items-center gap-2 rounded-full pl-1 pr-3 text-body transition-colors duration-100", on ? "bg-lab-active text-lab-ink" : "text-lab-mute hover:bg-lab-raised hover:text-lab-ink")}
            >
              <span className={cn("flex size-5 items-center justify-center rounded-full text-caption font-semibold tabular-nums",
                s.done ? "bg-lab-ok/15 text-lab-ok" : on ? "bg-lab-ink text-lab-canvas" : "border border-lab-strong text-lab-mute")}>
                {s.done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
              </span>
              {STEP_TITLE[s.id]}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** The way on from a setup step: what the next step gives, and one button to it. */
export function NextStep({ title, hint, to, cta, done, onClick }: { title: string; hint: string; to: string; cta: string; done?: boolean; onClick?: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="mt-10 flex flex-wrap items-center gap-4 rounded-xl border border-lab-line bg-lab-panel px-5 py-4">
      <div className="min-w-0 flex-1">
        <div className="text-caption text-lab-mute">{done ? "Следующий шаг уже пройден" : "Дальше"}</div>
        <div className="mt-0.5 text-body font-semibold text-lab-ink">{title}</div>
        <div className="text-body text-lab-mute">{hint}</div>
      </div>
      <Button variant={done ? "secondary" : "primary"} onClick={onClick ?? (() => navigate(to))}>{cta}<ArrowRight className="size-3.5" /></Button>
    </div>
  );
}
