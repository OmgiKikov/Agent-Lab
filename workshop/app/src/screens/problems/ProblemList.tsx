import { Search } from "lucide-react";
import { plural } from "../../lab/format";
import type { RuleEntry } from "../../lab/problems";
import { ListRow } from "../../ui/ListRow";

function ProblemRow({ p, source, selected, onClick }: { p: RuleEntry; source: "log" | "sim"; selected: boolean; onClick: () => void }) {
  const side = p[source];
  const total = side.failed + side.passed;
  return (
    <ListRow selected={selected} onClick={onClick}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-small text-lab-ink">{p.title}</div>
          <div className="mt-1 truncate text-meta text-lab-dim">
            {[`${side.failed} из ${total}`, p.topics.length > 1 ? `${p.topics.length} ${plural(p.topics.length, "тема", "темы", "тем")}` : ""].filter(Boolean).join(" · ")}
          </div>
        </div>
        <span className="text-count text-lab-ink" title={`нарушено в ${side.failed} из ${total}`}>{side.failed}</span>
      </div>
    </ListRow>
  );
}

/** The problems of one source, most frequent first, and a search. */
export function ProblemList({ problems, source, selectedId, query, onQuery, onPick }: {
  problems: RuleEntry[]; source: "log" | "sim"; selectedId: string | null; query: string; onQuery: (q: string) => void; onPick: (id: string) => void;
}) {
  return (
    <div>
      <div className="sticky top-0 z-10 border-b border-white/[0.06] bg-lab-surface px-3 py-2">
        <label className="flex h-6 min-w-0 items-center gap-1.5 rounded border border-white/[0.08] px-2 text-meta text-lab-dim focus-within:border-white/25">
          <Search aria-hidden className="size-3 flex-shrink-0" />
          <input value={query} onChange={e => onQuery(e.target.value)} placeholder="Найти…" name="q" autoComplete="off" aria-label="Найти нарушение" className="min-w-0 flex-1 bg-transparent text-lab-text outline-none placeholder:text-lab-faint" />
        </label>
      </div>
      {problems.map(p => <ProblemRow key={p.id} p={p} source={source} selected={p.id === selectedId} onClick={() => onPick(p.id)} />)}
      {!problems.length && <div className="px-4 py-10 text-center text-small text-lab-dim">{query ? "Ничего не нашлось" : "Нарушений нет"}</div>}
    </div>
  );
}
