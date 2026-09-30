import { ChevronDown } from "lucide-react";
import { plural } from "../../lab/format";
import type { RuleEntry } from "../../lab/problems";
import { humansOf, secondOf } from "../../lab/problemStats";
import { Menu } from "../../ui/Menu";
import { Lead, ListBar, Share, Table, type Col } from "../../ui/Table";
import { Tag } from "../../ui/Details";

export type Order = "most" | "unchecked" | "disputed";
const ORDERS: { value: Order; label: string }[] = [
  { value: "most", label: "Чаще всего" }, { value: "unchecked", label: "Не проверены людьми" }, { value: "disputed", label: "Судьи расходятся" },
];
export const orderOf = (raw: string | null): Order => (ORDERS.some(o => o.value === raw) ? (raw as Order) : "most");

/** Does the problem have what the order asks for. */
export function inOrder(p: RuleEntry, source: "log" | "sim", order: Order): boolean {
  const side = p[source];
  if (order === "unchecked") { const h = humansOf(side); return h.of > h.checked; }
  if (order === "disputed") return side.examples.some(e => e.status === "FAIL" && e.second === "disagree");
  return true;
}

const dash = <span className="text-lab-faint">—</span>;

/** The problems of one source as Raindrop's Issues table: a criterion with its line and topics, then the counts. */
export function ProblemList({ problems, all, source, query, onQuery, order, onOrder, onOpen }: {
  problems: RuleEntry[]; all: RuleEntry[]; source: "log" | "sim"; query: string; onQuery: (q: string) => void;
  order: Order; onOrder: (o: Order) => void; onOpen: (id: string) => void;
}) {
  const total = (p: RuleEntry) => p[source].failed + p[source].passed;
  const cols: Col<RuleEntry>[] = [
    {
      key: "title", label: "Критерий", sort: (a, b) => a.title.localeCompare(b.title, "ru"),
      cell: p => (
        <Lead title={p.title} sub={p.rule.condition || p.rule.text}
          tags={p.topics.length ? <>{p.topics.slice(0, 2).map(t => <Tag key={t} className="max-w-[200px]">{t}</Tag>)}{p.topics.length > 2 && <Tag>+{p.topics.length - 2}</Tag>}</> : undefined} />
      ),
    },
    {
      key: "failed", label: source === "log" ? "В логах" : "В прогоне", width: "128px", align: "right", title: "Диалогов с нарушением из тех, где критерий удалось проверить",
      sort: (a, b) => a[source].failed - b[source].failed,
      cell: p => <Share n={p[source].failed} of={total(p)} title={`нарушено в ${p[source].failed} из ${total(p)}`} />,
    },
    { key: "unknown", label: "Без оценки", width: "84px", align: "right", title: "Диалогов, где судья не нашёл доказательств", sort: (a, b) => a[source].unknown - b[source].unknown,
      cell: p => <span className="text-small text-lab-soft">{p[source].unknown || dash}</span> },
    {
      key: "second", label: "Второй судья", width: "104px", align: "right", title: "Согласен с первым в N из проверенных нарушений",
      sort: (a, b) => secondOf(a[source].examples).checked - secondOf(b[source].examples).checked,
      cell: p => { const s = secondOf(p[source].examples); return s.checked ? <span className="whitespace-nowrap text-small text-lab-soft">{s.agree} из {s.checked}</span> : dash; },
    },
    {
      key: "people", label: "Люди", width: "72px", align: "right", title: "Проверено людьми из показанных нарушений",
      sort: (a, b) => humansOf(a[source]).checked - humansOf(b[source]).checked,
      cell: p => { const h = humansOf(p[source]); return h.checked ? <span className="whitespace-nowrap text-small text-lab-soft">{h.checked} из {h.of}</span> : dash; },
    },
  ];
  return (
    <div className="h-full overflow-auto px-4 py-4">
      <ListBar query={query} onQuery={onQuery} placeholder="Найти нарушение…" label="Найти нарушение"
        end={
          <Menu align="right"
            trigger={<span className="inline-flex h-9 items-center gap-2 rounded border border-white/[0.08] px-3 text-small text-lab-text hover:border-white/25">{ORDERS.find(o => o.value === order)?.label}<ChevronDown className="size-3.5 text-lab-dim" /></span>}
            items={ORDERS.map(o => ({ key: o.value, label: o.label, sub: `${all.filter(p => inOrder(p, source, o.value)).length}`, on: o.value === order, run: () => onOrder(o.value) }))} />
        } />
      <Table className="mt-4" rows={problems} cols={cols} rowKey={p => p.id} onOpen={p => onOpen(p.id)} initial={{ key: "failed", dir: -1 }}
        empty={<div className="px-4 py-10 text-center text-small text-lab-dim">{query ? "Ничего не нашлось" : `Нарушений нет${order !== "most" ? " в этом отборе" : ""}`}</div>} />
      {problems.length > 0 && <p className="mt-2 text-meta text-lab-dim">{problems.length} {plural(problems.length, "нарушение", "нарушения", "нарушений")}</p>}
    </div>
  );
}
