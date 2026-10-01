import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropPixelGrid } from "../../components/DropPixelGrid";
import { plural } from "../../lab/format";
import { SECTIONS } from "../../app/links";
import { useLabState } from "../../shell/LabProvider";
import { Button } from "../../ui/Button";

/** Before the first assessment: what the product does in one sentence, and four steps, each ticked with its result. */
export function FirstRun({ onAssess }: { onAssess: () => void }) {
  const { state } = useLabState();
  const sources = state?.sources.length ?? 0;
  const logs = state?.logs.total ?? 0;
  const runs = state?.runs.length ?? 0;
  const steps = [
    { done: sources > 0, title: "Подключите агента и прочитайте его код", result: sources ? `${sources} ${plural(sources, "источник", "источника", "источников")}` : null, to: SECTIONS.agent, action: "Открыть «Агента»" },
    { done: logs > 0, title: "Загрузите логи: выгрузку чата", result: logs ? `${logs} ${plural(logs, "диалог", "диалога", "диалогов")}` : null, to: "/logs?tab=dialogs", action: "Открыть «Диалоги»" },
    { done: false, title: "Найдите нарушения", result: null, run: onAssess, action: "Оценить логи" },
    { done: runs > 0, title: "Сыграйте сценарии, по желанию", result: runs ? `${runs} ${plural(runs, "прогон", "прогона", "прогонов")}` : null, to: SECTIONS.simulations, action: "Открыть «Симуляции»" },
  ];
  const next = steps.findIndex(s => !s.done);
  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-14">
      <DropPixelGrid px={2} gap={1.5} fillRgb="141,148,158" />
      <h2 className="mt-6 text-balance text-title font-semibold text-fg">Здесь появятся нарушения агента</h2>
      <p className="mt-2 max-w-[60ch] text-read text-fg-2">Продукт читает критерии агента из его собственного кода и находит в разговорах места, где агент их нарушил: с цитатой из кода и цитатой из разговора.</p>
      <ol className="mt-8 border-t border-line">
        {steps.map((s, i) => (
          <li key={s.title} className="flex items-center gap-4 border-b border-line py-4">
            <span className={cn("flex size-7 flex-shrink-0 items-center justify-center rounded-full border font-mono text-small", s.done ? "border-ok/40 text-ok" : i === next ? "border-fg-3 text-fg" : "border-line-strong text-fg-3")}>
              {s.done ? <Check aria-label="готово" className="size-3.5" strokeWidth={2.5} /> : i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn("block text-body font-medium", s.done ? "text-fg-2" : "text-fg")}>{s.title}</span>
              {s.result && <span className="block text-small text-fg-3">{s.result}</span>}
            </span>
            {s.run
              ? <Button variant={i === next ? "primary" : "outline"} size="sm" onClick={s.run} disabled={!sources || !logs || !!state?.job.running}>{s.action}</Button>
              : <Link to={s.to!} className={cn("text-small underline decoration-line-strong underline-offset-4 transition-colors", i === next ? "text-fg" : "text-fg-3 hover:text-fg-2")}>{s.action}</Link>}
          </li>
        ))}
      </ol>
    </div>
  );
}
