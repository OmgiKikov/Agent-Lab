import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropPixelGrid } from "../components/DropPixelGrid";
import { useLabState } from "./LabProvider";
import { LINKS } from "./links";

type Block = "agent" | "logs" | "scenarios" | "simulations" | "results";
const STEPS: { id: Block; label: string; to: string }[] = [
  { id: "agent", label: "Агент", to: LINKS.agent }, { id: "logs", label: "Логи", to: LINKS.logs }, { id: "scenarios", label: "Сценарии", to: LINKS.scenarios },
  { id: "simulations", label: "Прогоны", to: LINKS.simulations }, { id: "results", label: "Результаты", to: LINKS.results },
];

/** The five blocks in the order of the work, each ticked when it has something to show. */
export function ChainSteps({ here }: { here: Block }) {
  const { state } = useLabState();
  const done: Record<Block, boolean> = {
    agent: !!state?.sources.length,
    logs: !!state?.discover,
    scenarios: !!state?.cards?.cards.length,
    simulations: !!state?.runs.length,
    results: !!state?.runs.some(r => r.status !== "running" && r.metric),
  };
  return (
    <ol aria-label="Цепочка блоков" className="flex flex-wrap items-center justify-center gap-x-1 gap-y-2">
      {STEPS.map((s, i) => (
        <li key={s.id} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden className="mx-1 h-px w-4 bg-white/[0.12]" />}
          <Link to={s.to} aria-current={s.id === here ? "step" : undefined}
            className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-meta transition-colors", s.id === here ? "border-white/30 text-lab-ink" : "border-white/[0.08] text-lab-dim hover:text-lab-text")}>
            {done[s.id] ? <Check aria-hidden className="size-3 text-lab-ok" strokeWidth={2.5} /> : <span className="text-lab-faint">{i + 1}</span>}
            {s.label}
          </Link>
        </li>
      ))}
    </ol>
  );
}

/** A block with nothing to show yet: where it is in the chain, what it gives, the next button, and three short hints. */
export function FirstRun({ here, title, action, hints, children }: {
  here: Block; title: string; action?: ReactNode; hints?: { title: string; text: string }[]; children?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-auto px-6 py-12 text-center">
      <ChainSteps here={here} />
      <div className="mt-8"><DropPixelGrid px={2} gap={1.5} fillRgb="142,157,166" /></div>
      <h1 className="mt-6 max-w-[520px] text-title font-medium text-lab-ink">{title}</h1>
      {children && <p className="mt-2 max-w-[460px] text-body text-lab-dim">{children}</p>}
      {action && <div className="mt-5 flex items-center gap-2">{action}</div>}
      {hints && (
        <div className="mt-10 grid w-full max-w-[720px] gap-3 text-left sm:grid-cols-3">
          {hints.map(h => (
            <div key={h.title} className="rounded-lg border border-white/[0.08] bg-lab-surface p-3.5">
              <div className="text-body text-lab-ink">{h.title}</div>
              <div className="mt-1 text-meta text-lab-dim">{h.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

