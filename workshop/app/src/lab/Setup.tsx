import { ArrowRight, Check } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { setupSteps, STEP_TITLE } from "./nav";
import type { LabState, Step } from "./types";
import { Button, Label } from "./ui";

/** Where a setup page is in «1 Агент → 2 Логи → 3 Сценарии»: tabs of the page, numbered, because each step feeds the next. */
export function SetupSteps({ state, current }: { state: LabState; current: Step }) {
  const navigate = useNavigate();
  const steps = setupSteps(state);
  return (
    <nav className="-mb-px flex gap-5 overflow-x-auto" aria-label="Шаги подготовки">
      {steps.map((s, i) => {
        const on = s.id === current;
        return (
          <button
            key={s.id} onClick={() => navigate(s.to)} aria-current={on ? "step" : undefined}
            className={cn("lab-focus-inset inline-flex h-10 flex-shrink-0 items-center gap-2 border-b-2 text-body transition-colors duration-100",
              on ? "border-lab-ink text-lab-ink" : "border-transparent text-lab-mute hover:text-lab-ink")}
          >
            <span className={cn("flex size-[18px] items-center justify-center rounded font-mono text-micro",
              s.done ? "bg-lab-ok/15 text-lab-ok" : on ? "bg-lab-ink text-black" : "border border-lab-strong text-lab-mute")}>
              {s.done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
            </span>
            <span className={cn(on && "font-medium")}>{STEP_TITLE[s.id]}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** The way on from a setup step: what the next step gives, and one button to it. */
export function NextStep({ title, hint, to, cta, done, onClick }: { title: string; hint: string; to: string; cta: string; done?: boolean; onClick?: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="mt-12 flex flex-wrap items-center gap-4 border-t border-lab-line pt-5">
      <div className="min-w-0 flex-1">
        <Label>{done ? "Следующий шаг уже пройден" : "Дальше"}</Label>
        <div className="mt-1 text-reading text-lab-ink">{title}</div>
        <div className="text-body text-lab-mute">{hint}</div>
      </div>
      <Button variant={done ? "secondary" : "primary"} onClick={onClick ?? (() => navigate(to))}>{cta}<ArrowRight className="size-3.5" /></Button>
    </div>
  );
}
