import { Search } from "lucide-react";
import { plural } from "../../lab/format";
import { FROM_LOG } from "../../lab/runs";
import type { Card } from "../../lab/types";
import { IssueRow } from "../../ui/IssueRow";
import { Menu } from "../../ui/Menu";

export type Origin = "all" | "errors" | "coverage";
const ORIGINS: { value: Origin; label: string }[] = [
  { value: "all", label: "Все" }, { value: "errors", label: "Ошибка из лога" }, { value: "coverage", label: "Покрытие темы" },
];

export const inOrigin = (c: Card, o: Origin) => o === "all" || (o === "errors" ? c.origin === FROM_LOG : c.origin !== FROM_LOG);

/** The scenarios grouped by topic; one row of controls above: a search and the origin. */
export function ScenarioList({ cards, selectedId, onPick, query, onQuery, origin, onOrigin }: {
  cards: Card[]; selectedId: string | null; onPick: (id: string) => void;
  query: string; onQuery: (q: string) => void; origin: Origin; onOrigin: (o: Origin) => void;
}) {
  const q = query.trim().toLowerCase();
  const shown = cards.filter(c => inOrigin(c, origin) && (!q || `${c.name} ${c.topic} ${c.situation}`.toLowerCase().includes(q)));
  const groups = [...shown.reduce((m, c) => m.set(c.topic, [...(m.get(c.topic) ?? []), c]), new Map<string, Card[]>())];
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-white/[0.08] bg-lab-surface px-3 py-2">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-white/[0.08] px-2 text-meta text-lab-dim focus-within:border-white/25">
          <Search aria-hidden className="size-3.5 flex-shrink-0" />
          <input value={query} onChange={e => onQuery(e.target.value)} placeholder="Найти сценарий…" name="q" autoComplete="off" aria-label="Найти сценарий" className="min-w-0 flex-1 bg-transparent text-lab-text outline-none placeholder:text-lab-faint" />
        </label>
        <Menu align="right" trigger={<span className="inline-flex h-7 items-center rounded-md border border-white/[0.08] px-2 text-meta text-lab-soft hover:text-lab-ink">{ORIGINS.find(o => o.value === origin)?.label}</span>}
          items={ORIGINS.map(o => ({ key: o.value, label: o.label, on: o.value === origin, run: () => onOrigin(o.value) }))} />
      </div>
      {groups.map(([topic, list]) => (
        <div key={topic}>
          <div className="border-b border-white/[0.08] bg-lab-bg px-3 py-1.5 text-meta font-medium text-lab-dim">
            {topic} · {list.length} {plural(list.length, "сценарий", "сценария", "сценариев")}
          </div>
          {list.map(c => (
            <IssueRow
              key={c.id} selected={c.id === selectedId} onClick={() => onPick(c.id)} title={c.name} sub={c.situation}
              tags={[c.origin === FROM_LOG ? "из лога" : "покрытие"]} tone="mute"
              stats={[{ value: c.criteria.length, label: plural(c.criteria.length, "критерий", "критерия", "критериев") }]}
            />
          ))}
        </div>
      ))}
      {!shown.length && <div className="px-4 py-10 text-center text-small text-lab-dim">В этом отборе сценариев нет</div>}
    </div>
  );
}
