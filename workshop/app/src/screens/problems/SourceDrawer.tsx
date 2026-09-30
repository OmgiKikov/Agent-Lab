import { useEffect, useRef } from "react";
import { thousands } from "../../lab/format";
import { useSource } from "../../lab/problems";
import { Drawer } from "../../ui/Drawer";
import { Skeleton } from "../../ui/EmptyState";
import { splitQuote } from "../../ui/highlight";

const KIND: Record<string, string> = { prompt: "Промпт", tools: "Инструменты агента" };

/** The source a rule is quoted from, with the quote marked and scrolled to: the rule is in the agent's own code. */
export function SourceDrawer({ open, onClose, sourceId, origin, quote }: {
  open: boolean; onClose: () => void; sourceId: string | null; origin: string; quote: string;
}) {
  const { data, isLoading, error } = useSource(open ? sourceId : null);
  const mark = useRef<HTMLElement>(null);
  const parts = data ? splitQuote(data.content, quote) : null;
  useEffect(() => {
    if (data && open) requestAnimationFrame(() => mark.current?.scrollIntoView({ block: "center" }));
  }, [data, open]);
  return (
    <Drawer open={open} onClose={onClose} title={origin || "Источник"} sub={data ? `${KIND[data.kind] ?? data.kind} · ${thousands(data.content.length)}` : undefined}>
      {isLoading && <div className="p-5"><Skeleton className="h-64" /></div>}
      {!!error && <p className="p-5 text-small text-lab-bad">Не удалось открыть источник: {error instanceof Error ? error.message : String(error)}</p>}
      {data && !parts && (
        <p className="border-b border-white/[0.06] px-5 py-3 text-meta text-lab-warn">
          Цитаты критерия нет в нынешнем тексте источника: код мог измениться после того, как критерии извлекли.
        </p>
      )}
      {data && (
        <pre className="whitespace-pre-wrap px-5 py-4 font-sans text-small text-lab-mute">
          {parts ? <>{parts[0]}<mark ref={mark} className="rounded-sm bg-lab-mark/[0.22] px-0.5 text-lab-ink">{parts[1]}</mark>{parts[2]}</> : data.content}
        </pre>
      )}
    </Drawer>
  );
}
