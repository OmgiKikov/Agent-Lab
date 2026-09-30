import { ChevronDown } from "lucide-react";
import { plural } from "../../lab/format";
import { FROM_LOG } from "../../lab/runs";
import type { Card } from "../../lab/types";
import { Tag } from "../../ui/Details";
import { Menu } from "../../ui/Menu";
import { Lead, ListBar, Table, type Col } from "../../ui/Table";

export type Origin = "all" | "errors" | "coverage";
const ORIGINS: { value: Origin; label: string }[] = [
  { value: "all", label: "Все" }, { value: "errors", label: "Ошибка из лога" }, { value: "coverage", label: "Покрытие темы" },
];

export const inOrigin = (c: Card, o: Origin) => o === "all" || (o === "errors" ? c.origin === FROM_LOG : c.origin !== FROM_LOG);

/** The scenarios as Raindrop's Issues table: a name and the situation, its topic, where it came from, how many criteria it checks. */
export function ScenarioList({ cards, onOpen, query, onQuery, origin, onOrigin }: {
  cards: Card[]; onOpen: (id: string) => void; query: string; onQuery: (q: string) => void; origin: Origin; onOrigin: (o: Origin) => void;
}) {
  const q = query.trim().toLowerCase();
  const shown = cards.filter(c => inOrigin(c, origin) && (!q || `${c.name} ${c.topic} ${c.situation}`.toLowerCase().includes(q)));
  const cols: Col<Card>[] = [
    { key: "name", label: "Сценарий", sort: (a, b) => a.name.localeCompare(b.name, "ru"), cell: c => <Lead title={c.name} sub={c.situation} /> },
    { key: "topic", label: "Тема", width: "240px", sort: (a, b) => a.topic.localeCompare(b.topic, "ru"), cell: c => <Tag className="max-w-full">{c.topic}</Tag> },
    { key: "origin", label: "Откуда", width: "120px", sort: (a, b) => a.origin.localeCompare(b.origin, "ru"), cell: c => <span className="text-small text-lab-soft">{c.origin === FROM_LOG ? "ошибка из лога" : "покрытие темы"}</span> },
    { key: "criteria", label: "Критериев", width: "88px", align: "right", sort: (a, b) => a.criteria.length - b.criteria.length, cell: c => <span className="text-small font-medium text-lab-ink">{c.criteria.length}</span> },
  ];
  return (
    <div className="h-full overflow-auto px-4 py-4">
      <ListBar query={query} onQuery={onQuery} placeholder="Найти сценарий…" label="Найти сценарий"
        end={
          <Menu align="right" trigger={<span className="inline-flex h-9 items-center gap-2 rounded border border-white/[0.08] px-3 text-small text-lab-text hover:border-white/25">{ORIGINS.find(o => o.value === origin)?.label}<ChevronDown className="size-3.5 text-lab-dim" /></span>}
            items={ORIGINS.map(o => ({ key: o.value, label: o.label, on: o.value === origin, run: () => onOrigin(o.value) }))} />
        } />
      <Table className="mt-4" rows={shown} cols={cols} rowKey={c => c.id} onOpen={c => onOpen(c.id)} initial={{ key: "topic", dir: 1 }}
        empty={<div className="px-4 py-10 text-center text-small text-lab-dim">В этом отборе сценариев нет</div>} />
      {shown.length > 0 && <p className="mt-2 text-meta text-lab-dim">{shown.length} {plural(shown.length, "сценарий", "сценария", "сценариев")}</p>}
    </div>
  );
}
