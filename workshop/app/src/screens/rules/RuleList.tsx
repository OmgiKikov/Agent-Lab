import { ChevronDown, Search } from "lucide-react";
import type { RuleEntry } from "../../lab/problems";
import { ListRow } from "../../ui/ListRow";
import { Menu } from "../../ui/Menu";
import { Label } from "../../ui/Label";

export type RuleFilter = "all" | "violated" | "kept" | "disputed";

const FILTER: Record<RuleFilter, string> = { all: "все", violated: "нарушаются", kept: "выполняются", disputed: "спорные" };

export const disputedCount = (r: RuleEntry) => [...r.log.examples, ...r.sim.examples].filter(e => e.second === "disagree").length;

export function matchesRule(r: RuleEntry, filter: RuleFilter, query: string) {
  const violated = r.log.failed + r.sim.failed > 0;
  if (filter === "violated" && !violated) return false;
  if (filter === "kept" && violated) return false;
  if (filter === "disputed" && !disputedCount(r)) return false;
  const q = query.trim().toLowerCase();
  return !q || [r.rule.text, r.rule.quote, r.title, r.rule.origin, ...r.topics].some(s => s.toLowerCase().includes(q));
}

const fileOf = (origin: string) => origin.split("/").pop() || origin || "без источника";

function Counts({ label, side }: { label: string; side: RuleEntry["log"] }) {
  if (!side.failed && !side.passed && !side.unknown) return null;
  return (
    <span>
      {label}: {side.failed > 0 && <span className="text-lab-bad">нарушено {side.failed}</span>}
      {side.failed > 0 && " · "}выполнено {side.passed}{side.unknown > 0 && ` · не проверено ${side.unknown}`}
    </span>
  );
}

/** The criteria grouped by the file they are quoted from; violated ones marked, counts in the logs and the run. */
export function RuleList({ rules, selectedId, filter, onFilter, query, onQuery, onPick }: {
  rules: RuleEntry[]; selectedId: string | null; filter: RuleFilter; onFilter: (f: RuleFilter) => void;
  query: string; onQuery: (q: string) => void; onPick: (id: string) => void;
}) {
  const groups = new Map<string, RuleEntry[]>();
  for (const r of rules) groups.set(r.rule.origin, [...(groups.get(r.rule.origin) ?? []), r]);
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-white/[0.06] bg-lab-surface px-3 py-2">
        <Menu
          trigger={<span className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-meta text-lab-dim hover:text-lab-text">{FILTER[filter]}<ChevronDown className="size-3" /></span>}
          items={(Object.keys(FILTER) as RuleFilter[]).map(f => ({ key: f, label: FILTER[f], on: f === filter, run: () => onFilter(f) }))}
        />
        <label className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded border border-white/[0.08] px-2 text-meta text-lab-dim focus-within:border-white/25">
          <Search aria-hidden className="size-3 flex-shrink-0" />
          <input value={query} onChange={e => onQuery(e.target.value)} placeholder="Найти…" name="q" autoComplete="off" aria-label="Найти критерий" className="min-w-0 flex-1 bg-transparent text-lab-text outline-none placeholder:text-lab-faint" />
        </label>
      </div>
      {[...groups.entries()].map(([origin, list]) => (
        <div key={origin}>
          <div className="border-b border-white/[0.06] bg-lab-bg/60 px-4 py-2" title={origin}>
            <Label className="truncate">{fileOf(origin)}{list[0].rule.kind === "tools" && " · инструменты"}</Label>
          </div>
          {list.map(r => {
            const violated = r.log.failed + r.sim.failed > 0;
            return (
              <ListRow key={r.id} selected={r.id === selectedId} onClick={() => onPick(r.id)}>
                <div className="flex gap-3">
                  <span className={violated ? "mt-2 size-1.5 flex-shrink-0 rounded-full bg-lab-bad" : "mt-2 size-1.5 flex-shrink-0 rounded-full bg-white/20"} aria-label={violated ? "нарушается" : "не нарушается"} />
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-small text-lab-ink">{r.rule.text}</div>
                    <div className="mt-1 flex flex-col gap-0.5 text-meta text-lab-dim">
                      <Counts label="логи" side={r.log} />
                      <Counts label="симуляция" side={r.sim} />
                      {!r.log.failed && !r.log.passed && !r.log.unknown && !r.sim.failed && !r.sim.passed && !r.sim.unknown && <span>вердиктов пока нет</span>}
                    </div>
                  </div>
                </div>
              </ListRow>
            );
          })}
        </div>
      ))}
      {!rules.length && <div className="px-4 py-10 text-center text-small text-lab-dim">{query ? "Ничего не нашлось" : "В этом отборе критериев нет"}</div>}
    </div>
  );
}
