import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useKeys } from "../../app/keys";
import { useWide } from "../../app/useWide";
import { useCriteria, type Criterion } from "../../lab/criteria";
import { count, day } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { FROM_LOG } from "../../lab/runs";
import type { Card } from "../../lab/types";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Search } from "../../ui/Search";
import { originWord } from "./parts";
import { ScenarioView } from "./ScenarioView";
import { SimHeader } from "./stage";

const quoteKey = (q: string) => q.replace(/\s+/g, " ").trim().toLowerCase();

function Row({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (on) ref.current?.scrollIntoView({ block: "nearest" }); }, [on]);
  return (
    <button ref={ref} type="button" onClick={onClick} aria-current={on ? "true" : undefined}
      className={cn("block w-full rounded-control px-3 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60",
        on ? "bg-selected" : "hover:bg-hover")}>
      {children}
    </button>
  );
}

/**
 * «Сценарии»: the business situations the synthetic customers play, built from the errors in the logs and from the topics
 * the logs cover. A scenario says how the customer begins, what the checks will look at, and plays on its own.
 */
export function ScenariosPage() {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const wide = useWide();
  const { list } = useCriteria(null);
  const [query, setQuery] = useState("");
  const set = (edit: (n: URLSearchParams) => void, replace = true) => setParams(prev => { const n = new URLSearchParams(prev); edit(n); return n; }, { replace });
  const cards = useMemo(() => state?.cards?.cards ?? [], [state?.cards]);
  const byQuote = useMemo(() => new Map(list.map(c => [quoteKey(c.r.rule.quote), c])), [list]);
  const mine = (card: Card): Criterion[] => card.criteria.flatMap(x => { const c = byQuote.get(quoteKey(x.quote)); return c ? [c] : []; }).sort((a, b) => a.n - b.n);
  const q = query.trim().toLowerCase();
  const shown = cards.filter(c => !q || `${c.name} ${c.topic} ${c.situation} ${c.opening}`.toLowerCase().includes(q));
  const id = params.get("s") ?? (wide ? shown[0]?.id ?? null : null);
  const card = cards.find(c => c.id === id) ?? null;
  const pick = (next: string | null) => set(n => { if (next) n.set("s", next); else n.delete("s"); }, wide);
  const step = (d: 1 | -1) => { if (!shown.length) return; const i = shown.findIndex(c => c.id === id); pick(shown[Math.max(0, Math.min(shown.length - 1, (i < 0 ? -1 : i) + d))].id); };
  useKeys({ KeyJ: () => step(1), KeyK: () => step(-1) });

  const header = <SimHeader runId={null} />;
  if (offline && !state) return <div className="flex h-full flex-col">{header}<ServiceDown /></div>;
  if (!state) return <div className="flex h-full flex-col">{header}<div className="p-5"><Skeleton className="h-[480px]" /></div></div>;

  const fromErrors = cards.filter(c => c.origin === FROM_LOG).length;
  const showDetail = !!card && (wide || !!params.get("s"));
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="grid min-h-0 flex-1 lg:grid-cols-[400px_minmax(0,1fr)]">
        <div className={cn("flex min-h-0 flex-col border-line lg:border-r", showDetail && !wide && "hidden")}>
          <div className="space-y-3 px-4 pb-3 pt-4">
            <p className="text-read text-fg-3">
              {cards.length ? <>{count(cards.length, "сценарий", "сценария", "сценариев")}, {fromErrors} из ошибок в логах{state.cards?.createdAt ? ` · собраны ${day(state.cards.createdAt)}` : ""}</> : "Сценариев пока нет"}
            </p>
            <Search value={query} onChange={setQuery} placeholder="Найти сценарий" />
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 pb-4" role="list">
            {shown.map(c => (
              <Row key={c.id} on={c.id === id} onClick={() => pick(c.id)}>
                <span className="block text-small text-fg-3">{c.topic} · <span className={c.origin === FROM_LOG ? "text-fg-2" : undefined}>{originWord(c.origin, FROM_LOG)}</span></span>
                <span className="mt-0.5 block text-body font-medium text-fg">{c.name}</span>
                <span className="mt-0.5 block line-clamp-1 text-small text-fg-3">«{c.opening}»</span>
              </Row>
            ))}
            {!shown.length && <p className="px-3 py-10 text-center text-small text-fg-3">{cards.length ? "Ничего не нашлось" : state.discover ? "Нажмите «Собрать сценарии» справа вверху." : "Сценарии собираются из оценённых логов."}</p>}
          </div>
        </div>
        {showDetail && card
          ? <ScenarioView key={card.id} card={card} state={state} mine={mine(card)} onPlay={() => set(n => n.set("play", card.id), false)} onBack={wide ? undefined : () => pick(null)} />
          : wide && <EmptyState drop title="Выберите сценарий" className="justify-center">J и K листают.</EmptyState>}
      </div>
    </div>
  );
}
