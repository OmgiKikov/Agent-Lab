import { useEffect, useRef } from "react";
import { thousands } from "../lab/format";
import { useSource } from "../lab/problems";
import { splitQuote } from "../ui/highlight";
import { Skeleton } from "../ui/EmptyState";
import { Sheet } from "../ui/Sheet";

const KIND: Record<string, string> = { prompt: "Промпт", tools: "Инструменты агента" };

/** The text a criterion is quoted from, with the quote marked and brought to the middle: it is the agent's own code. */
export function SourceSheet({ open, onClose, sourceId, origin, quote }: { open: boolean; onClose: () => void; sourceId: string | null; origin: string; quote: string }) {
  const { data, isLoading, error } = useSource(open ? sourceId : null);
  const mark = useRef<HTMLElement>(null);
  const parts = data ? splitQuote(data.content, quote) : null;
  useEffect(() => { if (data && open) requestAnimationFrame(() => mark.current?.scrollIntoView({ block: "center" })); }, [data, open]);
  return (
    <Sheet open={open} onClose={onClose} title={<span className="font-mono text-small">{origin || "Источник"}</span>} sub={data ? `${KIND[data.kind] ?? data.kind} · ${thousands(data.content.length)}` : undefined}>
      {isLoading && <div className="p-5"><Skeleton className="h-64" /></div>}
      {!!error && <p className="p-5 text-small text-bad">Не удалось открыть источник: {error instanceof Error ? error.message : String(error)}</p>}
      {data && !parts && <p className="border-b border-line px-5 py-3 text-meta text-warn">Цитаты критерия нет в нынешнем тексте: код мог измениться после того, как критерии извлекли.</p>}
      {data && (
        <pre className="whitespace-pre-wrap px-5 py-4 font-mono text-small text-fg-3">
          {parts ? <>{parts[0]}<mark ref={mark} className="rounded-sm border-b-2 border-warn bg-warn/20 px-0.5 text-fg">{parts[1]}</mark>{parts[2]}</> : data.content}
        </pre>
      )}
    </Sheet>
  );
}
