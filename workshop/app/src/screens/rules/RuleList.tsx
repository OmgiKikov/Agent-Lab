import { ChevronDown } from "lucide-react";
import type { RuleEntry } from "../../lab/problems";
import { Tag } from "../../ui/Details";
import { Menu } from "../../ui/Menu";
import { Lead, ListBar, Share, Table, type Col } from "../../ui/Table";

export type RuleFilter = "all" | "violated" | "kept" | "disputed";

const FILTER: Record<RuleFilter, string> = { all: "Все", violated: "Нарушаются", kept: "Выполняются", disputed: "Спорные" };

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
const dash = <span className="text-lab-faint">—</span>;

/** The criteria as Raindrop's Issues table: the text with its file, then the counts of the logs and of the run, kept apart. */
export function RuleList({ rules, filter, onFilter, query, onQuery, onOpen }: {
  rules: RuleEntry[]; filter: RuleFilter; onFilter: (f: RuleFilter) => void; query: string; onQuery: (q: string) => void; onOpen: (id: string) => void;
}) {
  const side = (s: RuleEntry["log"]) => (s.failed + s.passed ? <Share n={s.failed} of={s.failed + s.passed} title={`нарушено ${s.failed} из ${s.failed + s.passed}`} /> : dash);
  const cols: Col<RuleEntry>[] = [
    { key: "rule", label: "Критерий", sort: (a, b) => a.rule.text.localeCompare(b.rule.text, "ru"),
      cell: r => <Lead title={r.rule.text} sub={r.rule.condition || undefined} tags={<Tag title={r.rule.origin} className="max-w-[260px] font-mono">{fileOf(r.rule.origin)}{r.rule.kind === "tools" ? " · инструменты" : ""}</Tag>} /> },
    { key: "log", label: "В логах", width: "128px", align: "right", title: "Нарушено в N из M диалогов логов", sort: (a, b) => a.log.failed - b.log.failed, cell: r => side(r.log) },
    { key: "sim", label: "В прогоне", width: "128px", align: "right", title: "Нарушено в N из M диалогов последнего прогона", sort: (a, b) => a.sim.failed - b.sim.failed, cell: r => side(r.sim) },
    { key: "disputed", label: "Спорных", width: "76px", align: "right", title: "Вердиктов, где второй судья не согласен", sort: (a, b) => disputedCount(a) - disputedCount(b), cell: r => (disputedCount(r) ? <span className="text-small text-lab-warn">{disputedCount(r)}</span> : dash) },
    { key: "people", label: "Люди", width: "72px", align: "right", sort: (a, b) => a.human.agree + a.human.disagree - b.human.agree - b.human.disagree,
      cell: r => (r.human.agree + r.human.disagree ? <span className="whitespace-nowrap text-small text-lab-soft">{r.human.agree + r.human.disagree}</span> : dash) },
  ];
  return (
    <div className="h-full overflow-auto px-4 py-4">
      <ListBar query={query} onQuery={onQuery} placeholder="Найти критерий…" label="Найти критерий"
        end={
          <Menu align="right" trigger={<span className="inline-flex h-9 items-center gap-2 rounded border border-white/[0.08] px-3 text-small text-lab-text hover:border-white/25">{FILTER[filter]}<ChevronDown className="size-3.5 text-lab-dim" /></span>}
            items={(Object.keys(FILTER) as RuleFilter[]).map(f => ({ key: f, label: FILTER[f], on: f === filter, run: () => onFilter(f) }))} />
        } />
      <Table className="mt-4" rows={rules} cols={cols} rowKey={r => r.id} onOpen={r => onOpen(r.id)} initial={{ key: "log", dir: -1 }}
        empty={<div className="px-4 py-10 text-center text-small text-lab-dim">{query ? "Ничего не нашлось" : "В этом отборе критериев нет"}</div>} />
      {rules.length > 0 && <p className="mt-2 text-meta text-lab-dim">{rules.length} критериев</p>}
    </div>
  );
}
