import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Decision, RuleEntry } from "../../lab/problems";
import { Button } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { Segmented } from "../../ui/Segmented";
import { ConversationBox, ExampleMeta, JudgeNote, useExample } from "../verdicts/Example";

/** The proof: one violation at a time, the best backed first; the conversation with the judge's quote marked. */
export function Evidence({ p, from, onFrom, at, onAt, hover, onHover, onDecide }: {
  p: RuleEntry; from: "log" | "sim"; onFrom: (f: "log" | "sim") => void; at: number; onAt: (n: number) => void;
  hover: boolean; onHover: (on: boolean) => void; onDecide: (d: Decision) => void;
}) {
  const list = p[from].examples.filter(e => e.status === "FAIL");
  const example = list[at];
  const view = useExample(example);
  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <Label>Доказательство</Label>
          {list.length > 0 && <span className="font-mono text-meta text-lab-dim">{at + 1} из {list.length}</span>}
        </div>
        <div className="flex items-center gap-2">
          {p.log.failed > 0 && p.sim.failed > 0 && (
            <Segmented value={from} onChange={onFrom} options={[
              { value: "log", label: "Логи", count: p.log.failed },
              { value: "sim", label: "Симуляция", count: p.sim.failed },
            ]} />
          )}
          <Button size="sm" variant="ghost" icon={ChevronLeft} title="Предыдущий пример (←)" aria-label="Предыдущий пример" disabled={at <= 0} onClick={() => onAt(at - 1)} />
          <Button size="sm" variant="ghost" icon={ChevronRight} title="Следующий пример (→)" aria-label="Следующий пример" disabled={at >= list.length - 1} onClick={() => onAt(at + 1)} />
        </div>
      </div>
      {example && (
        <>
          <div className="mt-3"><ExampleMeta example={example} /></div>
          <ConversationBox className="mt-2" view={view} example={example} hover={hover} onHover={onHover} />
          <div className="mt-3"><JudgeNote example={example} marked={view.marked} onDecide={onDecide} /></div>
        </>
      )}
    </section>
  );
}
