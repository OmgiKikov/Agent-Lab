import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronRight, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Heatmap, mapFacts } from "../charts/Heatmap";
import { measured, type Dialog } from "../criteria";
import { count, plural } from "../format";
import { useLabContext } from "../LabContext";
import { disputed, itemKey, scenariosOfRun, typesOfRun } from "../logic";
import { personaName } from "../look";
import type { LabState } from "../types";
import { bySource, type Scope, type SourceFilter } from "../useScope";
import { Badge, Button, Chip, EmptyState, inputClass, Page, Panel, Segmented, Skeleton, StatusIcon } from "../ui";

type Filter = "all" | "FAIL" | "PASS" | "UNMEASURED" | "disputed";
const FILTERS: { id: Filter; label: string; hue?: "bad" | "warn" }[] = [
  { id: "all", label: "Все" }, { id: "FAIL", label: "С нарушениями", hue: "bad" }, { id: "PASS", label: "Без нарушений" },
  { id: "UNMEASURED", label: "Нет данных" }, { id: "disputed", label: "Судьи расходятся", hue: "warn" },
];
const RANK: Record<string, number> = { FAIL: 0, UNMEASURED: 1, UNKNOWN: 1, RUNNING: 1, PASS: 2 };
const PAGE = 100;

const outcome = (d: Dialog) => (measured(d) ? d.status : "UNMEASURED");
const isDisputed = (d: Dialog) => !!d.item && disputed(d.item);

/** A dialogue's verdict as a mark: a pass is quiet, a violation loud, a gap amber. */
function Mark({ status }: { status: string }) {
  const s = measured({ status } as Dialog) ? status : "UNKNOWN";
  return (
    <span className={cn("inline-flex size-5 flex-shrink-0 items-center justify-center rounded-full",
      s === "FAIL" ? "bg-lab-bad/15 text-lab-bad" : s === "PASS" ? "text-lab-faint" : "bg-lab-warn/10 text-lab-warn")}>
      <StatusIcon status={s} size={12} />
    </span>
  );
}

/** The version's scenario × customer type map: where it breaks, at a glance. */
function MapView({ state, scope, onOpen }: { state: LabState; scope: Scope; onOpen: (key: string) => void }) {
  const { openNewRun } = useLabContext();
  // Off by default: the map first answers «where does it break»; the arrows of the comparison are one click away.
  const [compare, setCompare] = useState(false);
  const run = scope.finished;
  const items = run?.items ?? [];
  if (!run || !items.length) {
    return <EmptyState className="mt-6" title="Карты пока нет" action={<Button variant="primary" onClick={openNewRun} disabled={!state.cards?.cards.length}>Проверить версию</Button>}>Карта показывает, какие сценарии агент проваливает и с какими типами клиентов. Она появится после первой проверки версии.</EmptyState>;
  }
  const personas = typesOfRun(run, state.personas);
  const scenarios = scenariosOfRun(items);
  const facts = mapFacts(items, personas, scenarios);
  const previous = scope.previous;
  return (
    <>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-[720px] text-pretty text-reading text-lab-text">
          Версия {run.version}: без нарушений {facts.seen - facts.broken} из {count(facts.seen, "пары", "пар", "пар")} «сценарий × тип клиента»
          {facts.mixed ? `, в ${facts.mixed} результат меняется от повтора к повтору` : ""}. Нажмите на клетку, чтобы открыть диалог.
        </p>
        {previous && scope.prevSims.length > 0 && <Chip on={compare} onClick={() => setCompare(c => !c)}>сравнить с {previous.version}</Chip>}
      </div>
      <Panel className="mt-4 p-5">
        <Heatmap personas={personas} scenarios={scenarios} items={items} previous={previous ? scope.prevSims.map(d => d.item!).filter(Boolean) : null}
          previousVersion={previous?.version} compare={compare} onOpen={i => onOpen(itemKey(i))} />
      </Panel>
    </>
  );
}

/** Every dialogue: the version's simulated ones and the real logs — the evidence behind every number. */
export function DialogsView({ state, scope, onOpen }: { state: LabState; scope: Scope; scopeBar?: React.ReactNode; onOpen: (d: Dialog) => void }) {
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "map" ? "map" : "list";
  const setView = (v: "list" | "map") => setParams(p => { const next = new URLSearchParams(p); if (v === "map") next.set("view", "map"); else next.delete("view"); return next; }, { replace: true });
  const [filter, setFilter] = useState<Filter>("all");
  const [src, setSrc] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const pool = useMemo(() => bySource(scope.dialogs, src), [scope.dialogs, src]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: pool.length, FAIL: 0, PASS: 0, UNMEASURED: 0, disputed: 0 };
    for (const d of pool) { c[outcome(d) as Filter] = (c[outcome(d) as Filter] ?? 0) + 1; if (isDisputed(d)) c.disputed++; }
    return c;
  }, [pool]);
  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () => pool
      .filter(d => (filter === "all" || (filter === "disputed" ? isDisputed(d) : outcome(d) === filter)) && (!q || `${d.opening} ${d.label}`.toLowerCase().includes(q)))
      .sort((a, b) => (RANK[a.status] ?? 1) - (RANK[b.status] ?? 1)),
    [pool, filter, q],
  );
  const reset = () => setLimit(PAGE);

  const viewSwitch = <Segmented value={view} onChange={setView} options={[{ value: "list", label: "Список" }, { value: "map", label: "Карта" }]} />;
  if (!scope.ready) return <Page title="Диалоги" wide actions={viewSwitch}><Skeleton className="mt-6 h-5 w-2/3" /><Skeleton className="mt-6 h-[420px]" /></Page>;
  if (!scope.dialogs.length) {
    return <Page title="Диалоги" wide actions={viewSwitch}><EmptyState className="mt-6" title="Диалогов пока нет">Оцените реальные диалоги на шаге «Логи» или проверьте версию агента на симуляторе: судья оценит каждый диалог по критериям.</EmptyState></Page>;
  }

  const sims = scope.sims.length, logs = scope.logs.length;
  const failed = scope.dialogs.filter(d => d.status === "FAIL").length;
  const disputes = scope.sims.filter(isDisputed).length;
  const lede = [
    `${count(scope.dialogs.length, "диалог", "диалога", "диалогов")}: ${[sims ? `${sims} из симулятора версии ${scope.finished?.version ?? ""}` : "", logs ? `${logs} ${plural(logs, "реальный", "реальных", "реальных")}` : ""].filter(Boolean).join(" и ")}.`,
    failed ? `С нарушениями — ${failed}.` : "Нарушений нет.",
    disputes ? `Судьи расходятся в ${count(disputes, "диалоге", "диалогах", "диалогах")}.` : "",
  ].filter(Boolean).join(" ");

  return (
    <Page title="Диалоги" count={scope.dialogs.length} wide actions={viewSwitch}>
      {view === "map" ? <MapView state={state} scope={scope} onOpen={key => onOpen({ key, origin: "sim" } as Dialog)} /> : (
        <>
          <p className="mt-6 max-w-[760px] text-pretty text-reading text-lab-text">{lede}</p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {FILTERS.filter(f => f.id === "all" || counts[f.id]).map(f => (
              <Chip key={f.id} on={filter === f.id} hue={f.hue} count={counts[f.id]} onClick={() => { setFilter(f.id); reset(); }}>{f.label}</Chip>
            ))}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {sims > 0 && logs > 0 && (
                <Segmented value={src} onChange={v => { setSrc(v); reset(); }} options={[
                  { value: "all", label: "Все" }, { value: "sim", label: "Симулятор", title: "Диалоги, которые сыграл симулятор клиента с этой версией" },
                  { value: "log", label: "Реальные", title: "Записанные диалоги агента в проде" },
                ]} />
              )}
              <div className="relative w-full sm:w-[240px]">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-lab-mute" />
                <input value={query} onChange={e => { setQuery(e.target.value); reset(); }} placeholder="Поиск по первой реплике" aria-label="Поиск по диалогам" className={cn(inputClass, "pl-8")} />
              </div>
            </div>
          </div>
          <Panel className="mt-3 overflow-hidden">
            {rows.slice(0, limit).map((d, k) => {
              const fail = d.rules.find(r => r.status === "FAIL");
              const open = d.origin === "sim" || !!d.traceId;
              const who = d.origin === "sim" && d.persona && d.persona !== "default" ? personaName(state.personas, d.persona) : null;
              return (
                <button
                  key={d.key} onClick={() => open && onOpen(d)} disabled={!open}
                  title={open ? undefined : "Полный текст этого диалога не сохранён в Workshop"}
                  className={cn("lab-focus-inset group flex w-full items-center gap-3.5 px-4 py-3 text-left transition-colors duration-100", k > 0 && "border-t border-lab-line", open ? "hover:bg-lab-raised/60" : "cursor-default")}
                >
                  <Mark status={d.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-reading text-lab-ink">{d.opening}</span>
                    <span className="mt-0.5 block truncate text-caption text-lab-mute">
                      {[d.label, who, d.attempt && d.attempt > 1 ? `повтор ${d.attempt}` : null].filter(Boolean).join(" · ")}
                      {isDisputed(d) && <span className="text-lab-warn"> · судьи расходятся</span>}
                    </span>
                  </span>
                  <span className="hidden w-[280px] flex-shrink-0 truncate text-body lg:block">
                    {fail ? <span className="text-lab-bad" title={fail.rule}>{fail.title || fail.rule}</span> : <span className="text-lab-mute">{measured(d) ? "без нарушений" : "нет данных"}</span>}
                  </span>
                  <span className="hidden w-[84px] flex-shrink-0 justify-end md:flex"><Badge>{d.origin === "log" ? "реальный" : "симулятор"}</Badge></span>
                  <ChevronRight className={cn("size-4 flex-shrink-0", open ? "text-lab-faint group-hover:text-lab-mute" : "text-transparent")} />
                </button>
              );
            })}
            {!rows.length && <div className="px-5 py-12 text-center text-body text-lab-mute">Под эти условия диалогов нет</div>}
            {rows.length > limit && (
              <button onClick={() => setLimit(l => l + PAGE)} className="lab-focus-inset w-full border-t border-lab-line px-5 py-3 text-body text-lab-mute transition-colors duration-100 hover:bg-lab-raised/60 hover:text-lab-ink">
                Показать ещё {Math.min(PAGE, rows.length - limit)} из {rows.length - limit}
              </button>
            )}
          </Panel>
        </>
      )}
    </Page>
  );
}
