import { Search } from "lucide-react";
import { plural } from "../../lab/format";
import type { RuleEntry } from "../../lab/problems";
import { ListRow } from "../../ui/ListRow";
import { ViewTabs } from "./ViewTabs";

export type Filter = "all" | "log" | "sim";

function ProblemRow({ p, selected, onClick }: { p: RuleEntry; selected: boolean; onClick: () => void }) {
  const fromLog = p.log.failed > 0;
  const side = fromLog ? p.log : p.sim;
  const parts = [
    p.log.failed ? `логи ${p.log.failed}/${p.log.failed + p.log.passed}` : "",
    p.sim.failed ? `симуляция ${p.sim.failed}/${p.sim.failed + p.sim.passed}` : "",
    p.topics.length > 1 ? `${p.topics.length} ${plural(p.topics.length, "тема", "темы", "тем")}` : "",
  ].filter(Boolean);
  return (
    <ListRow selected={selected} onClick={onClick}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-small text-lab-ink">{p.title}</div>
          <div className="mt-1 truncate font-mono text-micro text-lab-dim">
            {parts.join(" · ")}{!fromLog && <span className="text-lab-warn"> · только в симуляции</span>}
          </div>
        </div>
        <span className="font-mono text-count text-lab-ink" title={`нарушено в ${side.failed} из ${side.failed + side.passed}`}>{side.failed}</span>
      </div>
    </ListRow>
  );
}

/** The problems, most frequent in the logs first; a filter by where they were found, and a search. */
export function ProblemList({ problems, all, rules, selectedId, query, onQuery, onPick }: {
  problems: RuleEntry[]; all: RuleEntry[]; rules: number; selectedId: string | null; query: string; onQuery: (q: string) => void; onPick: (id: string) => void;
}) {
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-white/[0.06] bg-lab-surface px-3 py-2">
        <ViewTabs active="problems" problems={all.length} rules={rules} />
        <label className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded border border-white/[0.08] px-2 text-meta text-lab-dim focus-within:border-white/25">
          <Search className="size-3 flex-shrink-0" />
          <input value={query} onChange={e => onQuery(e.target.value)} placeholder="Найти" aria-label="Найти проблему" className="min-w-0 flex-1 bg-transparent text-lab-text outline-none placeholder:text-lab-faint" />
        </label>
      </div>
      {problems.map(p => <ProblemRow key={p.id} p={p} selected={p.id === selectedId} onClick={() => onPick(p.id)} />)}
      {!problems.length && <div className="px-4 py-10 text-center text-small text-lab-dim">{query ? "Ничего не нашлось" : "В этом отборе нарушений нет"}</div>}
    </div>
  );
}
