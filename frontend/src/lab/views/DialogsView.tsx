import { useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { measured, type Dialog } from "../criteria";
import { plural } from "../format";
import { LOG_TEXT, personaName } from "../look";
import type { LabState } from "../types";
import type { Scope } from "../useScope";
import { Badge, Chip, Dot, EmptyState, inputClass, Page, Panel, Skeleton } from "../ui";

const FILTERS: { id: string; label: string }[] = [{ id: "all", label: "Все" }, { id: "FAIL", label: "С нарушениями" }, { id: "PASS", label: "Без нарушений" }, { id: "UNMEASURED", label: "Нет данных" }];
const RANK: Record<string, number> = { FAIL: 0, UNMEASURED: 1, UNKNOWN: 1, RUNNING: 1, PASS: 2 };
const PAGE = 100;

/** What the judge said about a dialogue as a row of small squares, one per criterion: red where it was broken. */
function Verdicts({ d }: { d: Dialog }) {
  const rules = d.rules.filter(r => r.status === "PASS" || r.status === "FAIL");
  if (!rules.length) return null;
  return (
    <span className="inline-flex gap-[3px]" title={`${rules.filter(r => r.status === "FAIL").length} нарушено из ${rules.length} критериев`}>
      {rules.slice(0, 10).map((r, k) => <i key={k} className={cn("size-[10px] rounded-[3px]", r.status === "FAIL" ? "bg-lab-bad/60 ring-1 ring-lab-bad/70" : "bg-white/[0.08]")} />)}
    </span>
  );
}

/** Every dialogue of the chosen scope, real or simulated: the evidence the criteria are counted from. */
export function DialogsView({ state, scope, scopeBar, onOpen }: { state: LabState; scope: Scope; scopeBar: React.ReactNode; onOpen: (d: Dialog) => void }) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: scope.dialogs.length };
    for (const d of scope.dialogs) { const k = measured(d) ? d.status : "UNMEASURED"; c[k] = (c[k] ?? 0) + 1; }
    return c;
  }, [scope.dialogs]);
  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () => scope.dialogs
      .filter(d => (filter === "all" || (measured(d) ? d.status : "UNMEASURED") === filter) && (!q || `${d.opening} ${d.label}`.toLowerCase().includes(q)))
      .sort((a, b) => (RANK[a.status] ?? 1) - (RANK[b.status] ?? 1)),
    [scope.dialogs, filter, q],
  );
  const title = "диалоги";
  const lede = "Разговоры, по которым считаются критерии: настоящие из логов и сыгранные симулятором. Каждый оценён судьёй по каждому критерию.";

  if (!scope.ready) return <Page wide title={title} lede={lede} nav={scopeBar}><Skeleton className="mt-5 h-[400px]" /></Page>;
  if (!scope.dialogs.length) {
    return <Page wide title={title} lede={lede} nav={scopeBar}><EmptyState className="mt-5" drop title="Диалогов пока нет">Добавьте их кнопкой справа сверху: оцените логи или прогоните симулятор.</EmptyState></Page>;
  }
  return (
    <Page wide title={title} lede={lede} nav={scopeBar}>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {FILTERS.filter(f => f.id === "all" || counts[f.id]).map(f => <Chip key={f.id} on={filter === f.id} onClick={() => { setFilter(f.id); setLimit(PAGE); }} count={counts[f.id]}>{f.label}</Chip>)}
        <div className="relative ml-auto w-full max-w-[280px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-lab-dim" />
          <input value={query} onChange={e => { setQuery(e.target.value); setLimit(PAGE); }} placeholder="Поиск по первой реплике" className={cn(inputClass, "h-7 pl-8 text-[12px]")} />
        </div>
      </div>
      <Panel className="mt-3 overflow-hidden">
        {rows.slice(0, limit).map(d => {
          const fail = d.rules.find(r => r.status === "FAIL");
          return (
            <button
              key={d.key} onClick={() => onOpen(d)}
              className={cn("flex w-full items-center gap-4 border-t border-white/[0.06] px-5 py-3 text-left transition-colors first:border-t-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/50", "hover:bg-white/[0.025]")}
            >
              <Dot status={d.status} quiet />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-lab-text">{d.opening}</span>
                <span className="mt-0.5 block truncate text-[11px] text-lab-dim">{d.label}{d.origin === "sim" && d.persona && d.persona !== "default" ? ` · ${personaName(state.personas, d.persona)}` : ""}{d.attempt && d.attempt > 1 ? ` · повтор ${d.attempt}` : ""}</span>
              </span>
              <span className="hidden w-[210px] flex-shrink-0 truncate text-[12px] min-[900px]:block"><span className={fail ? "text-lab-bad" : "text-lab-dim"}>{fail ? fail.title || fail.rule : LOG_TEXT[d.status] ?? ""}</span></span>
              <span className="hidden w-[110px] flex-shrink-0 min-[1100px]:block"><Verdicts d={d} /></span>
              <span className="flex w-[84px] flex-shrink-0 justify-end"><Badge>{d.origin === "log" ? "лог" : "симулятор"}</Badge></span>
              <ChevronRight className="size-4 flex-shrink-0 text-lab-faint" />
            </button>
          );
        })}
        {!rows.length && <div className="px-5 py-10 text-center text-[12px] text-lab-dim">Ничего не нашлось</div>}
        {rows.length > limit && (
          <button onClick={() => setLimit(l => l + PAGE)} className="w-full border-t border-white/[0.06] px-5 py-3 text-[12px] text-lab-dim transition-colors hover:bg-white/[0.025] hover:text-lab-soft">
            Показать ещё {Math.min(PAGE, rows.length - limit)} из {rows.length - limit} {plural(rows.length - limit, "оставшегося", "оставшихся", "оставшихся")}
          </button>
        )}
      </Panel>
    </Page>
  );
}
