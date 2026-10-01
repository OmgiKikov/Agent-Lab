import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Decision, Example } from "../../lab/problems";
import { ExampleCard } from "../../product/ExampleCard";
import { Button } from "../../ui/Button";
import { Caps } from "../../ui/Caps";
import { Segmented } from "../../ui/Segmented";
import type { SideKey } from "./model";

/**
 * The proof, example after example: the source to show, the conversation with the agent's words the judge cited,
 * the judge's reason, the second judge, and «верно / неверно».
 */
export function Evidence({ list, at, onAt, side, onSide, counts, lit, onLit, onDecide }: {
  list: Example[]; at: number; onAt: (n: number) => void; side: SideKey; onSide: (s: SideKey) => void;
  counts: { log: number; sim: number }; lit: boolean; onLit: (on: boolean) => void; onDecide: (e: Example, d: Decision) => void;
}) {
  const example = list[at];
  const sides = ([["log", "Логи"], ["sim", "Симуляция"]] as const).filter(([k]) => counts[k] > 0);
  return (
    <section aria-label="Доказательство">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Caps>Доказательство</Caps>
        {sides.length > 1 && <Segmented<SideKey> size="sm" label="Источник примеров" value={side} onChange={onSide} options={sides.map(([k, l]) => ({ value: k, label: l, count: counts[k] }))} />}
        <span className="flex-1" />
        {list.length > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="mr-1 font-mono text-meta text-fg-3">{at + 1} из {list.length}</span>
            <Button size="sm" icon={ChevronLeft} aria-label="Предыдущий пример" kbd="←" disabled={at <= 0} onClick={() => onAt(at - 1)} />
            <Button size="sm" icon={ChevronRight} aria-label="Следующий пример" kbd="→" disabled={at >= list.length - 1} onClick={() => onAt(at + 1)} />
          </span>
        )}
      </div>
      {example ? (
        <div className="mt-2.5"><ExampleCard example={example} lit={lit} onLit={onLit} onDecide={d => onDecide(example, d)} /></div>
      ) : <p className="mt-3 text-small text-fg-3">Примеров в этом источнике нет.</p>}
    </section>
  );
}
