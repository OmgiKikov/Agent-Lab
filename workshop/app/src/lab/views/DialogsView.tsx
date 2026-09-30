import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Check, Copy, ExternalLink, MessagesSquare, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { RunDetail } from "@/components/RunDetail";
import { api } from "../api";
import { Heatmap } from "../charts/Heatmap";
import { Conversation } from "../Conversation";
import { measured, type Dialog } from "../criteria";
import { count } from "../format";
import { useLabContext } from "../LabContext";
import { disputed, itemKey, personaOf, scenariosOfRun, typesOfRun } from "../logic";
import { personaLook, personaName, STATUS_TEXT } from "../look";
import { transcript } from "../report";
import { useToast } from "../toast";
import type { Item, LabState } from "../types";
import type { Scope } from "../useScope";
import { Button, Chip, EmptyState, Label, Meta, Page, Panel, Progress, Skeleton, StatusIcon, inputClass } from "../ui";

type Filter = "all" | "FAIL" | "disputed" | "UNMEASURED" | "PASS";
const FILTERS: { id: Filter; label: string; hue?: "bad" | "warn" }[] = [
  { id: "all", label: "Все" }, { id: "FAIL", label: "Нарушения", hue: "bad" }, { id: "disputed", label: "Спорные", hue: "warn" },
  { id: "UNMEASURED", label: "Нет данных" }, { id: "PASS", label: "Без нарушений" },
];
const RANK: Record<string, number> = { FAIL: 0, UNMEASURED: 1, UNKNOWN: 1, RUNNING: 1, PASS: 2 };
const PAGE = 120;

const outcome = (d: Dialog) => (measured(d) ? d.status : "UNMEASURED");
const isDisputed = (d: Dialog) => !!d.item && disputed(d.item);
const keyOf = (d: Dialog) => (d.origin === "sim" ? d.key : d.traceId ?? d.key);

/** A dialogue's verdict as a mark: a pass is quiet, a violation loud, a gap amber. */
function Mark({ status }: { status: string }) {
  const s = measured({ status } as Dialog) ? status : "UNKNOWN";
  return (
    <span className={cn("mt-0.5 inline-flex size-[18px] flex-shrink-0 items-center justify-center rounded",
      s === "FAIL" ? "bg-lab-bad/15 text-lab-bad" : s === "PASS" ? "text-lab-faint" : "bg-lab-warn/10 text-lab-warn")}>
      <StatusIcon status={s} size={11} />
    </span>
  );
}

/** The list column, Workshop's run list: search, what to show, and every dialogue as one row. */
function DialogList({ state, scope, selected, onOpen, rows, setRows }: {
  state: LabState; scope: Scope; selected: string | null; onOpen: (d: Dialog) => void; rows: Dialog[]; setRows: (r: Dialog[]) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pool = scope.sims;
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: pool.length, FAIL: 0, PASS: 0, UNMEASURED: 0, disputed: 0 };
    for (const d of pool) { c[outcome(d) as Filter] = (c[outcome(d) as Filter] ?? 0) + 1; if (isDisputed(d)) c.disputed++; }
    return c;
  }, [pool]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => pool
      .filter(d => (filter === "all" || (filter === "disputed" ? isDisputed(d) : outcome(d) === filter)) && (!q || `${d.opening} ${d.label}`.toLowerCase().includes(q)))
      .sort((a, b) => (RANK[a.status] ?? 1) - (RANK[b.status] ?? 1)),
    [pool, filter, q],
  );
  useEffect(() => { setRows(shown); }, [shown, setRows]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[aria-current='true']")?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key === "/" && !(el && ["INPUT", "TEXTAREA"].includes(el.tagName))) { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside className="flex w-full flex-shrink-0 flex-col border-r border-lab-line bg-lab-panel md:w-[340px]" aria-label="Список диалогов">
      <div className="space-y-2.5 border-b border-lab-line p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-lab-faint" />
          <input ref={searchRef} value={query} onChange={e => { setQuery(e.target.value); setLimit(PAGE); }} placeholder="Поиск по первой реплике" aria-label="Поиск по диалогам" className={cn(inputClass, "pl-8")} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.filter(f => f.id === "all" || counts[f.id]).map(f => (
            <Chip key={f.id} on={filter === f.id} hue={f.hue} count={counts[f.id]} onClick={() => { setFilter(f.id); setLimit(PAGE); }}>{f.label}</Chip>
          ))}
        </div>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-1.5">
        {shown.slice(0, limit).map(d => {
          const on = keyOf(d) === selected;
          const openable = d.origin === "sim" || !!d.traceId;
          const who = d.origin === "sim" && d.persona && d.persona !== "default" ? personaName(state.personas, d.persona) : null;
          const fail = d.rules.find(r => r.status === "FAIL");
          return (
            <button
              key={d.key} onClick={() => openable && onOpen(d)} disabled={!openable} aria-current={on ? "true" : undefined}
              title={openable ? undefined : "Полный текст этого диалога не сохранён в Workshop"}
              className={cn("lab-focus-inset flex w-full gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors duration-100",
                on ? "bg-white/[0.08]" : openable ? "hover:bg-white/[0.04]" : "cursor-default opacity-60")}
            >
              <Mark status={d.status} />
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-body", on ? "text-lab-ink" : "text-lab-text")}>{d.opening}</span>
                <span className="mt-0.5 block truncate text-caption text-lab-mute">
                  {fail ? <span className="text-lab-bad/90">{fail.title || fail.rule}</span> : [d.label, who].filter(Boolean).join(" · ")}
                  {isDisputed(d) && <span className="text-lab-warn"> · спорный</span>}
                </span>
              </span>
            </button>
          );
        })}
        {!shown.length && <div className="px-4 py-12 text-center text-body text-lab-mute">Под эти условия диалогов нет</div>}
        {shown.length > limit && (
          <button onClick={() => setLimit(l => l + PAGE)} className="lab-focus-inset w-full rounded-md px-3 py-2.5 text-body text-lab-mute hover:bg-white/[0.04] hover:text-lab-ink">
            Показать ещё {Math.min(PAGE, shown.length - limit)} из {shown.length - limit}
          </button>
        )}
      </div>
    </aside>
  );
}

/** One simulated dialogue: who and what, the judge's verdict, the turns, and a person's word on the verdict. */
function SimDetail({ state, item, run }: { state: LabState; item: Item; run: NonNullable<Scope["finished"]> }) {
  const { error } = useToast();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [local, setLocal] = useState<"agree" | "disagree" | null | undefined>(undefined);
  useEffect(() => { setLocal(undefined); }, [item]);
  const items = run.items ?? [];
  const index = items.indexOf(item);
  const decision = local === undefined ? item.review ?? null : local;
  const review = (d: "agree" | "disagree") => {
    const next = decision === d ? null : d;
    setLocal(next);
    api("/api/review", { run: run.id, index, decision: next }).catch(error);
  };
  const siblings = items.filter(i => i.cardId === item.cardId);
  const multi = typesOfRun(run, state.personas).length > 1;
  const decidable = item.status === "PASS" || item.status === "FAIL";
  const copy = () => navigator.clipboard.writeText(transcript(item, state.personas)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(error);

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-lab-line px-5 py-4 sm:px-6">
        <button onClick={() => navigate("/lab/dialogs")} className="lab-focus -ml-1 mb-2 inline-flex items-center gap-1 rounded-sm px-1 text-caption text-lab-mute hover:text-lab-ink md:hidden">← Все диалоги</button>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
          <h2 className="min-w-0 flex-1 text-lead font-medium text-lab-ink sm:truncate" title={item.name}>{item.name}</h2>
          <div className="-ml-2.5 flex flex-shrink-0 flex-wrap items-center gap-1.5 sm:ml-0">
            <Button size="sm" variant="ghost" icon={copied ? Check : Copy} onClick={copy}>{copied ? "Скопировано" : "Копировать"}</Button>
            {item.runId && <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => navigate(`/runs/${item.runId}`)}>Трейс</Button>}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Meta label="Версия">{run.version}</Meta>
          <Meta label="Тема">{item.topic}</Meta>
          {item.attempt && item.attempt > 1 ? <Meta label="Повтор">{item.attempt}</Meta> : null}
        </div>
        {multi && siblings.length > 1 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5" aria-label="Тот же сценарий с другими клиентами">
            <Label className="mr-1">Клиент</Label>
            {siblings.map(i => {
              const on = i === item;
              const Icon = personaLook(personaOf(i)).icon;
              return (
                <button key={itemKey(i)} onClick={() => navigate(`/lab/dialogs/${encodeURIComponent(itemKey(i))}`, { replace: true })}
                  className={cn("lab-focus inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-caption transition-colors duration-100",
                    on ? "border-lab-strong bg-white/[0.08] text-lab-ink" : "border-lab-line text-lab-mute hover:text-lab-ink")}
                  title={`${personaName(state.personas, personaOf(i))}: ${STATUS_TEXT[i.status]}`}>
                  <Icon className="size-3" />{personaName(state.personas, personaOf(i))}{i.attempt && i.attempt > 1 ? ` · ${i.attempt}` : ""}
                  <StatusIcon status={i.status} size={11} className={i.status === "FAIL" ? "text-lab-bad" : i.status === "PASS" ? "text-lab-faint" : "text-lab-warn"} />
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex-1 px-5 py-7 sm:px-6">
        <div className="mx-auto max-w-[760px]"><Conversation item={item} state={state} /></div>
      </div>
      {decidable && (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-lab-line bg-lab-canvas/95 px-5 py-3 backdrop-blur-md sm:px-6">
          <span className="mr-1 text-body text-lab-mute"><span className="hidden sm:inline">Вердикт «{STATUS_TEXT[item.status]}» верный?</span><span className="sm:hidden">Судья прав?</span></span>
          <Button size="sm" icon={Check} aria-pressed={decision === "agree"} onClick={() => review("agree")}
            className={cn(decision === "agree" && "border-lab-ok/30 bg-lab-ok/10 text-lab-ok hover:bg-lab-ok/15")}>Верно</Button>
          <Button size="sm" icon={X} aria-pressed={decision === "disagree"} onClick={() => review("disagree")}
            className={cn(decision === "disagree" && "border-lab-bad/30 bg-lab-bad/10 text-lab-bad hover:bg-lab-bad/15")}>Неверно</Button>
          <span className="ml-auto hidden font-mono text-micro text-lab-faint lg:inline">J K — диалоги · / — поиск</span>
        </div>
      )}
    </div>
  );
}

/** The version's scenario × customer type map: where it breaks, at a glance. */
function MapView({ state, scope, onOpen }: { state: LabState; scope: Scope; onOpen: (key: string) => void }) {
  const { openNewRun } = useLabContext();
  const run = scope.finished;
  const items = run?.items ?? [];
  if (!run || !items.length) {
    return <EmptyState className="mx-auto" title="Карты пока нет" action={<Button variant="primary" onClick={openNewRun} disabled={!state.cards?.cards.length}>Проверить версию</Button>}>Карта показывает, какие сценарии агент проваливает и с какими типами клиентов. Она появится после первой проверки версии.</EmptyState>;
  }
  const personas = typesOfRun(run, state.personas);
  const scenarios = scenariosOfRun(items);
  const m = run.metric;
  return (
    <div className="mx-auto w-full max-w-[1200px] px-5 pb-20 sm:px-8">
      <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Label>Сценарий × тип клиента</Label>
          {m && (
            <p className="mt-1.5 text-reading text-lab-text">
              Без нарушений {m.passed} из {count(m.measured, "диалога", "диалогов", "диалогов")}{m.repeats && m.repeats.stable < m.repeats.scenarios ? `; на повторах результат разный в ${m.repeats.scenarios - m.repeats.stable} из ${m.repeats.scenarios}` : ""}.
            </p>
          )}
        </div>
      </div>
      <Panel className="mt-4 p-5">
        <Heatmap personas={personas} scenarios={scenarios} items={items} accuracy={m?.personas} onOpen={i => onOpen(itemKey(i))} />
      </Panel>
    </div>
  );
}

/**
 * Every dialogue the numbers are made of — the version's simulated ones and the real logs — laid out as Workshop lays out traces:
 * the list on the left, the dialogue on the right. «Карта» shows the version as scenario × customer type instead.
 */
export function DialogsView({ state, scope, itemId, onOpen }: { state: LabState; scope: Scope; itemId: string | null; onOpen: (key: string, replace?: boolean) => void }) {
  const [params] = useSearchParams();
  const view = params.get("view") === "map" ? "map" : "list";
  const [rows, setRows] = useState<Dialog[]>([]);
  const run = scope.finished;
  const selected = itemId ? scope.dialogs.find(d => keyOf(d) === itemId || d.key === itemId) ?? null : null;
  const live = state.job.running && state.job.kind === "run";

  // The first dialogue opens by itself where the list and the dialogue sit side by side, as the first trace does in Workshop;
  // on a phone the list comes first. J / K walk the list as it is filtered.
  const wideScreen = typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;
  useEffect(() => { if (view === "list" && !itemId && rows[0] && wideScreen) onOpen(keyOf(rows[0]), true); }, [view, itemId, rows, onOpen, wideScreen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || view !== "list") return;
      const el = e.target as HTMLElement | null;
      if (el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable)) return;
      const step = e.code === "KeyJ" || e.code === "ArrowDown" ? 1 : e.code === "KeyK" || e.code === "ArrowUp" ? -1 : 0;
      if (!step || !rows.length) return;
      e.preventDefault();
      const at = rows.findIndex(d => keyOf(d) === itemId);
      const next = rows[Math.max(0, Math.min(rows.length - 1, at + step))];
      if (next) onOpen(keyOf(next), true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, itemId, onOpen, view]);

  const title = "Диалоги";
  if (!scope.ready) return <Page title={title} icon={MessagesSquare} fill><div className="w-[340px] border-r border-lab-line p-3"><Skeleton className="h-8" /><Skeleton className="mt-3 h-[420px]" /></div><div className="flex-1 p-8"><Skeleton className="h-[480px]" /></div></Page>;
  if (!scope.dialogs.length) {
    return (
      <Page title={title} icon={MessagesSquare}>
        <EmptyState icon={MessagesSquare} title="Диалогов пока нет">Оцените реальные диалоги на шаге «Логи» или проверьте версию агента: судья оценит каждый диалог по критериям.</EmptyState>
      </Page>
    );
  }
  if (view === "map") {
    return <Page title={title} icon={MessagesSquare} count={scope.sims.length} full><MapView state={state} scope={scope} onOpen={key => onOpen(key)} /></Page>;
  }
  return (
    <Page title={title} icon={MessagesSquare} count={scope.dialogs.length} fill>
      <div className={cn("min-h-0 w-full md:w-auto", selected ? "hidden md:flex" : "flex")}>
        <DialogList state={state} scope={scope} selected={selected ? keyOf(selected) : null} onOpen={d => onOpen(keyOf(d))} rows={rows} setRows={setRows} />
      </div>
      <div className={cn("relative min-h-0 min-w-0 flex-1 flex-col overflow-auto", selected ? "flex" : "hidden md:flex")}>
        {live && (
          <div className="border-b border-lab-line bg-lab-accent/[0.06] px-6 py-2 text-body text-lab-text">
            Идёт проверка новой версии · {state.job.progress.done ?? 0} из {state.job.progress.total ?? "…"}. Её диалоги появятся здесь, когда она закончится.
            {state.job.progress.total ? <Progress className="mt-2" value={(100 * (state.job.progress.done ?? 0)) / state.job.progress.total} /> : null}
          </div>
        )}
        {selected?.item && run
          ? <SimDetail state={state} item={selected.item} run={run} />
          : selected?.traceId
            ? <RunDetail key={selected.traceId} runId={selected.traceId} />
            : <div className="flex flex-1 items-center justify-center text-body text-lab-mute">Выберите диалог слева</div>}
      </div>
    </Page>
  );
}
