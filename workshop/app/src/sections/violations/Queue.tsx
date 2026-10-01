import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { Criterion } from "../../lab/criteria";
import { plural } from "../../lab/format";
import { Kbd } from "../../ui/Kbd";
import { Search } from "../../ui/Search";
import { Segmented } from "../../ui/Segmented";
import { Tag } from "../../ui/Tag";
import { checked, queueOf, rowSide, type Filter } from "./model";

function Row({ c, filter, on, onOpen }: { c: Criterion; filter: Filter; on: boolean; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (on) ref.current?.scrollIntoView({ block: "nearest" }); }, [on]);
  const side = rowSide(c, filter);
  const s = c.r[side];
  const disputed = s.examples.filter(e => e.status === "FAIL" && e.second === "disagree").length;
  const topics = c.r.topics.length;
  return (
    <button
      ref={ref} type="button" onClick={onOpen} aria-current={on ? "true" : undefined}
      className={cn(
        "relative grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-b border-line py-3.5 pl-5 pr-4 text-left transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60",
        on ? "bg-raised before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-fg" : "hover:bg-hover",
      )}
    >
      <span className="text-body font-medium text-fg">{c.r.title}</span>
      <span className="row-span-3 text-right">
        <span className={cn("block font-mono text-count font-medium", side === "sim" ? "text-fg-2" : "text-fg")}>{s.failed}</span>
        <span className="block font-mono text-meta text-fg-3">из {checked(s)}</span>
      </span>
      <span className="truncate text-small text-fg-3" title={c.r.rule.quote}>«{c.r.rule.quote}»</span>
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-meta text-fg-3">
        {side === "sim" && filter === "all" && <Tag>только в симуляции</Tag>}
        {s.failed === 1 && <Tag>один случай</Tag>}
        {disputed > 0 && <Tag tone="warn">судьи расходятся в {disputed}</Tag>}
        {side === "log" && c.r.sim.failed > 0 && <span>в симуляции {c.r.sim.failed}</span>}
        {side === "log" && c.r.sim.failed > 0 && topics > 0 && <span aria-hidden>·</span>}
        {topics > 0 && <span>{topics} {plural(topics, "тема", "темы", "тем")}</span>}
      </span>
    </button>
  );
}

/** The queue of violations: the source to look at, a search, and the criteria the agent breaks, most frequent first. */
export function Queue({ list, items, filter, onFilter, query, onQuery, selected, onOpen, className }: {
  list: Criterion[]; items: Criterion[]; filter: Filter; onFilter: (f: Filter) => void; query: string; onQuery: (q: string) => void;
  selected: string | null; onOpen: (id: string) => void; className?: string;
}) {
  return (
    <div className={cn("flex min-h-0 flex-col border-line bg-list lg:border-r", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Segmented<Filter> label="Где искать нарушения" value={filter} onChange={onFilter} className="w-full sm:w-auto" options={[
          { value: "all", label: "Все", count: queueOf(list, "all").length },
          { value: "log", label: "Логи", count: queueOf(list, "log").length },
          { value: "sim", label: "Симуляция", count: queueOf(list, "sim").length },
        ]} />
        <Search value={query} onChange={onQuery} placeholder="Найти нарушение" className="min-w-40 flex-1" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto" role="list" aria-label="Нарушения">
        {items.map(c => <Row key={c.r.id} c={c} filter={filter} on={c.r.id === selected} onOpen={() => onOpen(c.r.id)} />)}
        {!items.length && <p className="px-5 py-10 text-center text-small text-fg-3">{query ? "Ничего не нашлось" : filter === "sim" ? "Симуляция не нашла нарушений" : "Нарушений нет"}</p>}
      </div>
      <div className="hidden items-center gap-4 border-t border-line px-4 py-2.5 text-meta text-fg-3 lg:flex">
        <span className="inline-flex items-center gap-1"><Kbd>J</Kbd><Kbd>K</Kbd>соседнее</span>
        <span className="inline-flex items-center gap-1"><Kbd>←</Kbd><Kbd>→</Kbd>пример</span>
        <span className="inline-flex items-center gap-1"><Kbd>V</Kbd><Kbd>N</Kbd>верно / неверно</span>
      </div>
    </div>
  );
}
