import { Link } from "react-router-dom";
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { personaName } from "../../lab/look";
import { reliabilityWord, secondLine } from "../../lab/problemReport";
import { useTurns, type Decision, type Example, type RuleEntry } from "../../lab/problems";
import type { Persona } from "../../lab/types";
import { useLabState } from "../../shell/LabProvider";
import { LINKS } from "../../shell/links";
import { Button } from "../../ui/Button";
import { Conversation, MarkNumber, visible } from "../../ui/Conversation";
import { Skeleton } from "../../ui/EmptyState";
import { splitQuote } from "../../ui/highlight";
import { Label } from "../../ui/Label";
import { Segmented } from "../../ui/Segmented";

function where(e: Example, personas: Persona[]): string {
  if (e.source === "log") return `Лог · тема «${e.topic}»`;
  const repeat = e.attempt && e.attempt > 1 ? ` · повтор ${e.attempt}` : "";
  return `Симуляция · ${e.name} · клиент: ${personaName(personas, e.persona)}${repeat}`;
}

/** The proof: one violation at a time, the best backed first; the conversation with the judge's quote marked. */
export function Evidence({ p, from, onFrom, at, onAt, hover, onHover, onDecide }: {
  p: RuleEntry; from: "log" | "sim"; onFrom: (f: "log" | "sim") => void; at: number; onAt: (n: number) => void;
  hover: boolean; onHover: (on: boolean) => void; onDecide: (d: Decision) => void;
}) {
  const { state } = useLabState();
  const list = p[from].examples.filter(e => e.status === "FAIL");
  const example = list[at];
  const { turns, loading, error } = useTurns(example);
  const marked = !!example?.agentQuote && !!turns?.some(t => t.role === "agent" && splitQuote(visible(t.text).text, example.agentQuote));
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
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-meta text-lab-dim">
            <span>{where(example, state?.personas ?? [])} · {reliabilityWord(example)}</span>
            {example.traceId && (
              <Link to={LINKS.trace(example.traceId)} className="inline-flex items-center gap-1 transition-colors hover:text-lab-text" title="Открыть диалог (O)">
                Открыть диалог<ArrowUpRight className="size-3.5" />
              </Link>
            )}
          </div>
          <div className="mt-2 rounded-lg border border-white/[0.07] bg-lab-surface p-4">
            {loading ? <Skeleton className="h-28" />
              : error ? <p className="text-small text-lab-bad">Не удалось загрузить разговор: {error instanceof Error ? error.message : String(error)}</p>
              : turns ? <Conversation turns={turns} mark={marked ? { quote: example.agentQuote, n: 1 } : undefined} hover={hover} onHover={onHover} />
              : <p className="text-read text-lab-text">{example.opening}</p>}
          </div>
          <div className="mt-3 flex gap-3">
            <span className="mt-1"><MarkNumber n={1} /></span>
            <div className="min-w-0 flex-1 space-y-1.5">
              {!marked && example.agentQuote && <p className="text-small text-lab-mute">Судья ссылается на: «{example.agentQuote}»</p>}
              <p className="text-read text-lab-text"><span className="text-lab-dim">Судья: </span>{example.reason}</p>
              <p className="text-small text-lab-mute">{secondLine(example, state?.models.second ?? null)}</p>
              <div className="flex flex-wrap items-center gap-2 pt-1.5">
                <span className="text-small text-lab-mute">Вердикт верный?</span>
                <Button size="sm" icon={Check} kbd="V" aria-pressed={example.review === "agree"} onClick={() => onDecide("agree")} className={cn(example.review === "agree" && "border-lab-ok/50 text-lab-ok")}>Верно</Button>
                <Button size="sm" icon={X} kbd="N" aria-pressed={example.review === "disagree"} onClick={() => onDecide("disagree")} className={cn(example.review === "disagree" && "border-lab-bad/50 text-lab-bad")}>Неверно</Button>
                {example.reviewScope === "dialogue" && <span className="text-meta text-lab-dim">отмечено для диалога целиком</span>}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
