import { Link } from "react-router-dom";
import { ArrowUpRight, ChevronLeft, ChevronRight } from "lucide-react";
import { dialogOf } from "../../lab/dialogs";
import { day } from "../../lab/format";
import { personaName } from "../../lab/look";
import { useTurns, type Decision, type Example } from "../../lab/problems";
import { Conversation } from "../../product/Conversation";
import { JudgeNote } from "../../product/JudgeNote";
import { Reliability } from "../../product/Reliability";
import { useLabState } from "../../shell/LabProvider";
import { Button } from "../../ui/Button";
import { Caps } from "../../ui/Caps";
import { visible } from "../../ui/Conversation";
import { Skeleton } from "../../ui/EmptyState";
import { splitQuote } from "../../ui/highlight";
import { Segmented } from "../../ui/Segmented";
import type { SideKey } from "./model";

/** Where an example was said: the log's topic, or the simulation's scenario and type of customer. */
function Where({ example }: { example: Example }) {
  const { state } = useLabState();
  if (example.source === "log") return <span>лог{example.topic ? ` · ${example.topic}` : ""}</span>;
  const run = state?.runs.find(r => r.id === example.runId);
  const repeat = example.attempt && example.attempt > 1 ? ` · повтор ${example.attempt}` : "";
  return <span>симуляция{run ? ` ${day(run.startedAt)}` : ""} · {example.name} · клиент: {personaName(state?.personas ?? [], example.persona)}{repeat}</span>;
}

/**
 * The proof, example after example: the source to show, the conversation with the agent's words the judge cited,
 * the judge's reason, the second judge, and «верно / неверно».
 */
export function Evidence({ list, at, onAt, side, onSide, counts, lit, onLit, onDecide }: {
  list: Example[]; at: number; onAt: (n: number) => void; side: SideKey; onSide: (s: SideKey) => void;
  counts: { log: number; sim: number }; lit: boolean; onLit: (on: boolean) => void; onDecide: (e: Example, d: Decision) => void;
}) {
  const example = list[at];
  const { turns, loading, error } = useTurns(example);
  const marked = !!example?.agentQuote && !!turns?.some(t => t.role === "agent" && splitQuote(visible(t.text).text, example.agentQuote));
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
        <>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-fg-3">
            <Reliability example={example} />
            <span aria-hidden>·</span>
            <Where example={example} />
            <span aria-hidden>·</span>
            <Link to={dialogOf(example)} title="Открыть диалог целиком (O)" className="inline-flex items-center gap-1 rounded-sm text-fg-2 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">
              Открыть диалог<ArrowUpRight aria-hidden className="size-3.5" />
            </Link>
          </div>
          <div className="mt-3 rounded-block border border-line bg-inset px-4 pb-4 pt-3.5">
            {loading ? <Skeleton className="h-28" />
              : error ? <p className="text-small text-bad">Не удалось загрузить разговор: {error instanceof Error ? error.message : String(error)}</p>
              : turns ? <Conversation turns={turns} marks={marked ? [{ quote: example.agentQuote, n: 1 }] : []} lit={lit} onLit={onLit} />
              : <p className="text-read text-fg">{example.opening}</p>}
            <JudgeNote example={example} marked={marked} lit={lit} onLit={onLit} onDecide={d => onDecide(example, d)} />
          </div>
        </>
      ) : <p className="mt-3 text-small text-fg-3">Примеров в этом источнике нет.</p>}
    </section>
  );
}
