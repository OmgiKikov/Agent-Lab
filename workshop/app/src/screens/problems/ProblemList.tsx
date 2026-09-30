import { Search } from "lucide-react";
import { plural } from "../../lab/format";
import type { RuleEntry } from "../../lab/problems";
import { ListRow } from "../../ui/ListRow";
import { Segmented } from "../../ui/Segmented";

export type Filter = "all" | "log" | "sim";

function ProblemRow({ p, selected, onClick }: { p: RuleEntry; selected: boolean; onClick: () => void }) {
  const fromLog = p.log.failed > 0;
  const side = fromLog ? p.log : p.sim;
  const single = p.log.failed + p.sim.failed === 1;
  return (
    <ListRow selected={selected} onClick={onClick}>
      <div className="flex gap-4">
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-body font-medium text-lab-ink">{p.title}</div>
          <div className="mt-1 truncate text-meta text-lab-dim">«{p.rule.quote}»</div>
          <div className="mt-1.5 flex flex-wrap gap-x-1.5 text-meta text-lab-mute">
            {fromLog ? <span>в логах {p.log.failed}</span> : <span className="text-lab-warn">только в симуляции</span>}
            {fromLog && p.sim.failed > 0 && <span>· в симуляции {p.sim.failed}</span>}
            {p.topics.length > 1 && <span>· {p.topics.length} {plural(p.topics.length, "тема", "темы", "тем")}</span>}
            {single && <span>· один случай</span>}
          </div>
        </div>
        <div className="flex-shrink-0 text-right">
          <div className="font-mono text-count text-lab-ink">{side.failed}</div>
          <div className="text-meta text-lab-dim">из {side.failed + side.passed}</div>
        </div>
      </div>
    </ListRow>
  );
}

/** The problems, most frequent in the logs first; a filter by where they were found, and a search. */
export function ProblemList({ problems, all, selectedId, filter, onFilter, query, onQuery, onPick }: {
  problems: RuleEntry[]; all: RuleEntry[]; selectedId: string | null; filter: Filter; onFilter: (f: Filter) => void;
  query: string; onQuery: (q: string) => void; onPick: (id: string) => void;
}) {
  return (
    <div>
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-white/[0.06] bg-lab-surface px-4 py-2.5">
        <Segmented value={filter} onChange={onFilter} options={[
          { value: "all", label: "Все", count: all.length },
          { value: "log", label: "Логи", count: all.filter(p => p.log.failed).length },
          { value: "sim", label: "Симуляция", count: all.filter(p => p.sim.failed).length },
        ]} />
        <label className="flex h-7 min-w-[140px] flex-1 items-center gap-1.5 rounded-md border border-white/[0.08] px-2 text-meta text-lab-dim focus-within:border-white/25">
          <Search className="size-3.5 flex-shrink-0" />
          <input value={query} onChange={e => onQuery(e.target.value)} placeholder="Найти" aria-label="Найти проблему" className="min-w-0 flex-1 bg-transparent text-lab-text outline-none placeholder:text-lab-faint" />
        </label>
      </div>
      {problems.map(p => <ProblemRow key={p.id} p={p} selected={p.id === selectedId} onClick={() => onPick(p.id)} />)}
      {!problems.length && <div className="px-4 py-10 text-center text-small text-lab-dim">{query ? "Ничего не нашлось" : "В этом отборе нарушений нет"}</div>}
    </div>
  );
}
