import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DialogRow, Source } from "../../lab/dialogs";
import { personaName } from "../../lab/look";
import type { Persona } from "../../lab/types";
import { Tag } from "../../ui/Details";
import { Menu } from "../../ui/Menu";
import { Lead, ListBar, Share, Table, type Col } from "../../ui/Table";

export type Verdict = "all" | "fail" | "pass" | "none" | "disputed";
export type SourceFilter = "all" | Source;

export function matchesRow(r: DialogRow, source: SourceFilter, verdict: Verdict, query: string, only: Set<string> | null) {
  if (only && !only.has(r.key)) return false;
  if (source !== "all" && r.source !== source) return false;
  if (verdict === "fail" && r.status !== "FAIL") return false;
  if (verdict === "pass" && r.status !== "PASS") return false;
  if (verdict === "none" && (r.source === "trace" || r.status === "PASS" || r.status === "FAIL")) return false;
  if (verdict === "disputed" && !r.disputed) return false;
  const q = query.trim().toLowerCase();
  return !q || [r.title, r.topic, ...r.fails].some(s => s.toLowerCase().includes(q));
}

const SOURCE: Record<Source, string> = { log: "лог", sim: "симуляция", trace: "трейс" };

const VERDICT_WORD: Record<string, { word: string; tone: string }> = {
  FAIL: { word: "нарушение", tone: "text-lab-bad" },
  PASS: { word: "без нарушений", tone: "text-lab-ok" },
  UNMEASURED: { word: "не оценён", tone: "text-lab-warn" },
  RUNNING: { word: "идёт", tone: "text-lab-accent" },
};
const dash = <span className="text-lab-faint">—</span>;
const judgedOf = (r: DialogRow) => r.rules.filter(x => x.status === "FAIL" || x.status === "PASS").length;
const humansOf = (r: DialogRow) => { const f = r.rules.filter(x => x.status === "FAIL"); return { of: f.length, checked: f.filter(x => x.review).length }; };

const VERDICTS: { value: Verdict; label: string }[] = [
  { value: "all", label: "Все" }, { value: "fail", label: "Нарушения" }, { value: "pass", label: "Без нарушений" },
  { value: "none", label: "Не оценены" }, { value: "disputed", label: "Спорные" },
];

/** The dialogues of one source as a table: the opening words, the judge's verdict and the counts; a verdict filter and a search in one bar. */
export function DialogList({ rows, all, verdict, onVerdict, query, onQuery, rule, onClearRule, onOpen, personas }: {
  rows: DialogRow[]; all: DialogRow[];
  verdict: Verdict; onVerdict: (v: Verdict) => void; query: string; onQuery: (q: string) => void;
  rule: string | null; onClearRule: () => void; onOpen: (key: string) => void; personas: Persona[];
}) {
  const count = (v: Verdict) => all.filter(r => matchesRow(r, "all", v, "", null)).length;
  const cols: Col<DialogRow>[] = [
    {
      key: "title", label: "Диалог", sort: (a, b) => a.title.localeCompare(b.title, "ru"),
      cell: r => {
        const who = r.source === "sim" ? [personaName(personas, r.persona), r.attempt && r.attempt > 1 ? `повтор ${r.attempt}` : ""].filter(Boolean).join(" · ") : "";
        return (
          <Lead title={r.title} sub={[r.topic, who].filter(Boolean).join(" · ") || SOURCE[r.source]}
            tags={r.fails.length || r.disputed || r.status === "UNMEASURED" ? <>
              {r.fails.slice(0, 1).map(f => <Tag key={f} className="max-w-[320px]">{f}</Tag>)}
              {r.fails.length > 1 && <Tag>+{r.fails.length - 1}</Tag>}
              {r.status === "UNMEASURED" && <Tag>не оценён</Tag>}
              {r.disputed && <Tag>судьи расходятся</Tag>}
            </> : undefined} />
        );
      },
    },
    { key: "verdict", label: "Вердикт", width: "128px", sort: (a, b) => (a.status ?? "").localeCompare(b.status ?? ""),
      cell: r => { const v = r.status ? VERDICT_WORD[r.status] : undefined; return v ? <span className={cn("text-small", v.tone)}>{v.word}</span> : dash; } },
    { key: "fails", label: "Нарушено", width: "128px", align: "right", title: "Критериев с нарушением из тех, что судья смог проверить", sort: (a, b) => a.fails.length - b.fails.length,
      cell: r => (judgedOf(r) ? <Share n={r.fails.length} of={judgedOf(r)} title={`нарушено ${r.fails.length} из ${judgedOf(r)} критериев`} /> : dash) },
    { key: "second", label: "Второй судья", width: "112px", align: "right", sort: (a, b) => Number(!!a.second) - Number(!!b.second),
      cell: r => (r.second ? <span className={cn("text-small", r.disputed ? "text-lab-warn" : "text-lab-soft")}>{r.disputed ? "расходится" : "согласен"}</span> : dash) },
    { key: "people", label: "Люди", width: "72px", align: "right", sort: (a, b) => humansOf(a).checked - humansOf(b).checked,
      cell: r => { const h = humansOf(r); return h.checked ? <span className="whitespace-nowrap text-small text-lab-soft">{h.checked} из {h.of}</span> : dash; } },
  ];
  return (
    <div className="h-full overflow-auto px-4 py-4">
      <ListBar query={query} onQuery={onQuery} placeholder="Найти диалог…" label="Найти диалог"
        filter={rule ? (
          <span className="inline-flex max-w-[280px] items-center gap-1 rounded border border-white/[0.1] bg-lab-raised px-1.5 py-0.5 text-meta text-lab-text">
            <span className="truncate">нарушено: {rule}</span>
            <button type="button" onClick={onClearRule} aria-label="Снять отбор по критерию" className="text-lab-dim hover:text-lab-text"><X className="size-3" /></button>
          </span>
        ) : undefined}
        end={
          <Menu align="right"
            trigger={<span className="inline-flex h-9 items-center gap-2 rounded border border-white/[0.08] px-3 text-small text-lab-text hover:border-white/25">{VERDICTS.find(v => v.value === verdict)?.label}<ChevronDown className="size-3.5 text-lab-dim" /></span>}
            items={VERDICTS.map(v => ({ key: v.value, label: v.label, sub: `${count(v.value)}`, on: v.value === verdict, run: () => onVerdict(v.value) }))} />
        } />
      <Table className="mt-4" rows={rows} cols={cols} rowKey={r => r.key} onOpen={r => onOpen(r.key)}
        empty={<div className="px-4 py-10 text-center text-small text-lab-dim">В этом отборе диалогов нет</div>} />
      {rows.length > 0 && <p className="mt-2 text-meta text-lab-dim">{rows.length} из {all.length}</p>}
    </div>
  );
}
