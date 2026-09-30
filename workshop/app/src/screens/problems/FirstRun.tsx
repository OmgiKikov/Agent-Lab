import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropPixelGrid } from "../../components/DropPixelGrid";
import { count } from "../../lab/format";
import type { LabState } from "../../lab/types";
import { LINKS } from "../../shell/links";
import { Button } from "../../ui/Button";

type Step = { title: string; done: boolean; result?: string; action: ReactNode; optional?: boolean };

const link = "text-small text-lab-ink underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-white";

/** Before the first assessment: what the product does, in one sentence, and the steps to the first problems. */
export function FirstRun({ state, onAssess }: { state: LabState; onAssess: () => void }) {
  const steps: Step[] = [
    {
      title: "Подключите агента и прочитайте его код", done: state.sources.length > 0,
      result: state.sources.length ? `прочитано ${count(state.sources.length, "источник", "источника", "источников")}` : undefined,
      action: <Link className={link} to={LINKS.agent}>Открыть «Агент»</Link>,
    },
    {
      title: "Загрузите логи", done: state.logs.total > 0,
      result: state.logs.total ? count(state.logs.total, "диалог", "диалога", "диалогов") : undefined,
      action: <Link className={link} to={LINKS.logs}>Загрузить выгрузку</Link>,
    },
    {
      title: "Найдите проблемы", done: !!state.discover,
      action: <Button variant="primary" onClick={onAssess} disabled={state.job.running}>Оценить логи</Button>,
    },
    {
      title: "Сыграйте сценарии на агенте", optional: true, done: state.runs.length > 0,
      action: <Link className={link} to={LINKS.simulations}>Открыть «Симуляции»</Link>,
    },
  ];
  const next = steps.findIndex(s => !s.done);
  return (
    <div className="mx-auto flex max-w-[620px] flex-col items-center px-6 py-16">
      <DropPixelGrid px={3} gap={2} fillRgb="142,157,166" />
      <h1 className="mt-6 text-center text-page font-semibold text-lab-ink">Найдём, где агент нарушает свои правила</h1>
      <p className="mt-2 max-w-[500px] text-center text-read text-lab-mute">
        Продукт читает правила агента из его кода и находит в разговорах места, где агент их нарушил, — с цитатой из кода и цитатой из разговора.
      </p>
      <ol className="mt-10 w-full divide-y divide-white/[0.06] overflow-hidden rounded-lg border border-white/[0.08]">
        {steps.map((s, i) => (
          <li key={s.title} className={cn("flex items-center gap-4 px-4 py-3.5", i === next && "bg-lab-hover")}>
            <span className={cn(
              "flex size-6 flex-shrink-0 items-center justify-center rounded-full border font-mono text-meta",
              s.done ? "border-lab-ok/40 text-lab-ok" : i === next ? "border-white/40 text-lab-ink" : "border-white/15 text-lab-dim",
            )}>
              {s.done ? <Check className="size-3.5" strokeWidth={2.5} /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className={cn("text-body", s.done || i === next ? "text-lab-ink" : "text-lab-mute")}>
                {s.title}{s.optional && <span className="ml-2 text-meta text-lab-dim">по желанию</span>}
              </div>
              {s.result && <div className="mt-0.5 text-meta text-lab-dim">{s.result}</div>}
            </div>
            {i === next && <div className="flex-shrink-0">{s.action}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}
