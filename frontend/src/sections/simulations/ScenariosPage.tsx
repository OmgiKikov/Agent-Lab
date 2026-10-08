import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { useKeys } from "../../app/keys";
import { useWide } from "../../app/useWide";
import { deckCriteria } from "../../lab/checks";
import { useCriteria } from "../../lab/criteria";
import { count, day } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { personaName } from "../../lab/look";
import { useCatalog } from "../../lab/catalog";
import { CatalogTable, ScenarioTree, TreeHead, treeOf } from "./Catalog";
import { DeckCheckLine } from "./Profile";
import {
  namedCriteria,
  failedTypes,
  outcomeOf,
  runsOf,
  useScenarios,
  type Outcome,
  type Played,
  type ScenarioRecord,
} from "../../lab/scenarios";
import type { Card, Persona } from "../../lab/types";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Search } from "../../ui/Search";
import { Tag } from "../../ui/Tag";
import { Dot, dotOf } from "./parts";
import { ScenarioView, type RecordState } from "./ScenarioView";
import { SimHeader } from "./stage";

/** Which scenarios the list shows, by how each came out in the latest run that played it (?v=). */
type Filter = "all" | Outcome;
const toFilter = (raw: string | null): Filter =>
  raw === "fail" || raw === "pass" || raw === "none" || raw === "unplayed" ? raw : "all";
const FILTERS: { value: Filter; label: string; dot?: "FAIL" | "PASS" | "UNMEASURED" | "NONE" }[] = [
  { value: "all", label: "Все" },
  { value: "fail", label: "С ошибкой в последнем прогоне", dot: "FAIL" },
  { value: "pass", label: "Без найденных ошибок", dot: "PASS" },
  { value: "none", label: "Не удалось проверить", dot: "UNMEASURED" },
  { value: "unplayed", label: "Не играли", dot: "NONE" },
];

function Row({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (on) ref.current?.scrollIntoView({ block: "nearest" });
  }, [on]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-current={on ? "true" : undefined}
      className={cn(
        "block w-full rounded-control px-2.5 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60",
        on ? "bg-selected" : "hover:bg-hover",
      )}
    >
      {children}
    </button>
  );
}

/** The conversations of one run by type of customer, each type once, its repeats together. */
const byType = (plays: Played[]) => {
  const types = new Map<string, Played[]>();
  for (const p of plays) types.set(p.persona, [...(types.get(p.persona) ?? []), p]);
  return [...types.entries()];
};

/**
 * The scenario's own result in the latest run that played it, a dot per conversation with its type of customer, and
 * under it the run before, after «в прошлом прогоне»: two observations side by side, no word about which is better.
 */
function LastResults({ record, personas }: { record?: ScenarioRecord; personas: Persona[] }) {
  if (!record) return <span aria-hidden className="mt-2 block h-[18px]" />;
  const [latest, previous] = runsOf(record.history, personas);
  if (!latest)
    return (
      <span className="mt-2 flex items-center gap-1.5 text-small text-fg-3">
        <Dot status="NONE" className="size-2.5" />
        не играли
      </span>
    );
  const said = (plays: Played[]) => plays.map((p) => dotOf(p.status).word).join(", ");
  return (
    <span className="mt-2 block space-y-1 text-small text-fg-3">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {byType(latest.plays).map(([persona, plays]) => (
          <span key={persona} className="inline-flex items-center gap-1.5" title={said(plays)}>
            {plays.map((p) => (
              <Dot key={p.index} status={p.status} className="size-2.5" />
            ))}
            {personaName(personas, persona)}
            <span className="sr-only">: {said(plays)}</span>
          </span>
        ))}
      </span>
      {previous && (
        <span className="flex flex-wrap items-center gap-1.5">
          в прошлом прогоне
          {previous.plays.map((p) => (
            <span key={p.index} title={`${personaName(personas, p.persona)}: ${dotOf(p.status).word}`}>
              <Dot status={p.status} className="size-2.5" />
            </span>
          ))}
          <span className="sr-only">
            :{" "}
            {byType(previous.plays)
              .map(([persona, plays]) => `${personaName(personas, persona)} — ${said(plays)}`)
              .join("; ")}
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * «Сценарии»: the customers of real conversations as a tree of the catalog — clusters, their business scenarios, the
 * cards of each, every row with its conversations and cards — judged by the criteria of the check named over the list.
 * A card says its set and, once played, how it came out in the latest run that played it, beside the run before; the
 * list filters by that latest result, and the scenarios with an error play again in one go. A card opens with its
 * results by run; with none open, the catalog at a glance.
 */
export function ScenariosPage() {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const wide = useWide();
  const deck = state?.cards ?? null;
  const catalog = useCatalog(state);
  const { list } = useCriteria(deck?.check ?? null);
  const { data: tests, isError, isFetching, error, refetch } = useScenarios(state);
  const [query, setQuery] = useState("");
  const set = (edit: (n: URLSearchParams) => void, replace = true) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        edit(n);
        return n;
      },
      { replace },
    );
  const cards = useMemo(() => state?.cards?.cards ?? [], [state?.cards]);
  const records = useMemo(() => new Map((tests?.cards ?? []).map((r) => [r.id, r])), [tests]);
  const outcome = (c: Card): Outcome | null => (records.has(c.id) ? outcomeOf(records.get(c.id)?.history) : null);
  const counts = Object.fromEntries(
    FILTERS.map((f) => [
      f.value,
      f.value === "all" ? cards.length : cards.filter((c) => outcome(c) === f.value).length,
    ]),
  ) as Record<Filter, number>;
  const failing = cards.filter((c) => outcome(c) === "fail").map((c) => c.id);
  // The customer types that met the error: replaying only the default type would not reproduce it.
  const failingTypes = [...new Set(failing.flatMap((id) => failedTypes(records.get(id)?.history)))];
  const filter = toFilter(params.get("v"));
  const q = query.trim().toLowerCase();
  const narrowed = filter !== "all" || !!q;
  const matching = cards.filter(
    (c) =>
      (filter === "all" || outcome(c) === filter) &&
      (!q ||
        `${c.name} ${c.topic} ${c.scenario?.category ?? ""} ${c.scenario?.title ?? ""} ${c.situation} ${c.opening}`
          .toLowerCase()
          .includes(q)),
  );
  // The tree of the catalog: clusters, their scenarios, the cards of each; the cards in the order the tree shows them.
  const tree = treeOf(matching, catalog, !narrowed);
  const shown = tree.flatMap((cluster) => cluster.scenarios.flatMap((s) => s.cards));
  const id = params.get("s");
  const card = cards.find((c) => c.id === id) ?? null;
  // Which nodes are open: as the person left them; else the way to the card being looked at, and everything while the
  // list is narrowed by a filter or a search.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const onPath = (node: string) => !!card && (card.scenario?.id === node || card.scenario?.categoryId === node);
  const isOpen = (node: string) => toggled[node] ?? (narrowed || onPath(node));
  const toggle = (node: string) => setToggled((t) => ({ ...t, [node]: !isOpen(node) }));
  const everything = tree.flatMap((c) => [c.id, ...c.scenarios.map((s) => s.id)]);
  const allOpen = everything.every(isOpen);
  const openAll = (open: boolean) => setToggled(Object.fromEntries(everything.map((node) => [node, open])));
  const pick = (next: Card | null) => {
    if (next?.scenario) setToggled((t) => ({ ...t, [next.scenario!.categoryId]: true, [next.scenario!.id]: true }));
    set((n) => {
      if (next) n.set("s", next.id);
      else n.delete("s");
    }, wide);
  };
  const step = (d: 1 | -1) => {
    if (!shown.length) return;
    const i = shown.findIndex((c) => c.id === id);
    pick(shown[Math.max(0, Math.min(shown.length - 1, (i < 0 ? -1 : i) + d))]);
  };
  useKeys({ KeyJ: () => step(1), KeyK: () => step(-1) });

  const header = <SimHeader runId={null} />;
  if (offline && !state)
    return (
      <div className="flex h-full flex-col">
        {header}
        <ServiceDown />
      </div>
    );
  if (!state)
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="p-5">
          <Skeleton className="h-[480px]" />
        </div>
      </div>
    );

  // A scenario the address names that is not among the ones built: said so in its place, never a blank one.
  const lost = !!params.get("s") && !card;
  const showDetail = (!!card || lost) && (wide || !!params.get("s"));
  const status: RecordState = card && records.has(card.id) ? "ready" : isError && !isFetching ? "error" : "loading";
  const busy = !!state.job.running;
  // Built before any check, the cards cannot be played: no line of results under each of them.
  const judged = cards.some((c) => c.criteria.length);
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="grid min-h-0 flex-1 lg:grid-cols-[440px_minmax(0,1fr)]">
        <div className={cn("flex min-h-0 flex-col border-line lg:border-r", showDetail && !wide && "hidden")}>
          <div className="space-y-3 px-4 pb-3 pt-4">
            <p className="text-read text-fg-3">
              {cards.length && deck ? (
                <>
                  {count(cards.length, "карточка клиента", "карточки клиентов", "карточек клиентов")}{" "}
                  {deckCriteria(deck.check)}
                  {deck.createdAt ? ` · собраны ${day(deck.createdAt)}` : ""}
                </>
              ) : (
                "Сценариев пока нет"
              )}
            </p>
            {cards.length > 0 && deck?.checks && <DeckCheckLine checks={deck.checks} />}
            {cards.length > 0 && tests && (
              <div role="radiogroup" aria-label="Итог в последнем прогоне" className="flex flex-wrap gap-1.5">
                {FILTERS.filter((f) => f.value !== "none" || counts.none > 0).map((f) => {
                  const on = f.value === filter;
                  return (
                    <button
                      key={f.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={!counts[f.value] && !on}
                      onClick={() =>
                        set((n) => {
                          if (f.value === "all") n.delete("v");
                          else n.set("v", f.value);
                          n.delete("s");
                        })
                      }
                      className={cn(
                        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-small transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 disabled:pointer-events-none disabled:opacity-40",
                        on ? "border-fg-3 bg-selected text-fg" : "border-line text-fg-2 hover:bg-hover hover:text-fg",
                      )}
                    >
                      {f.dot && <Dot status={f.dot} className="size-2" />}
                      {f.label}
                      <span className="tabular-nums text-fg-3">{counts[f.value]}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Search value={query} onChange={setQuery} placeholder="Найти сценарий" className="flex-1" />
              {failing.length > 0 && (
                <Button
                  size="sm"
                  icon={Play}
                  disabled={busy}
                  title={
                    busy
                      ? "Сейчас идёт другая задача"
                      : `Сыграть ${count(failing.length, "сценарий", "сценария", "сценариев")} с ошибкой в последнем прогоне`
                  }
                  onClick={() =>
                    set((n) => {
                      n.set("play", failing.join(","));
                      n.set("types", failingTypes.join(","));
                    }, false)
                  }
                >
                  Сыграть с ошибкой
                </Button>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 pb-4">
            {shown.length > 0 && (
              <TreeHead
                action={
                  <button
                    type="button"
                    onClick={() => openAll(!allOpen)}
                    className="rounded-sm text-fg-3 underline decoration-line-strong underline-offset-4 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
                  >
                    {allOpen ? "Свернуть всё" : "Раскрыть всё"}
                  </button>
                }
              />
            )}
            {/* A filter by the last results waits for them; when they could not be loaded, that and «Повторить». */}
            {filter !== "all" &&
              !tests &&
              (isError && !isFetching ? (
                <LoadFailed
                  title="Не удалось загрузить итоги сценариев"
                  error={error}
                  onRetry={() => void refetch()}
                  className="px-2"
                />
              ) : (
                <Skeleton className="mx-2 mt-2 h-40" />
              ))}
            {shown.length > 0 && (
              <ScenarioTree
                tree={tree}
                isOpen={isOpen}
                onToggle={toggle}
                renderCard={(c) => (
                  <Row on={c.id === id} onClick={() => pick(c)}>
                    <span className="block text-body font-medium text-fg">{c.name}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-small text-fg-3">
                      {c.sets?.includes("stress") ? <Tag tone="warn">стрессовый</Tag> : "представительный"}
                    </span>
                    {judged && <LastResults record={records.get(c.id)} personas={state.personas} />}
                  </Row>
                )}
              />
            )}
            {!shown.length && (filter === "all" || tests) && (
              <p className="px-3 py-10 text-center text-small text-fg-3">
                {cards.length
                  ? "Ничего не нашлось"
                  : busy && state.job.kind === "cards"
                    ? "Сценарии собираются: ход виден в строке выше. Страницу можно закрыть, собранное сохранится."
                    : state.logs.total
                      ? "Соберите сценарии из разговоров выгрузки."
                      : "Загрузите диалоги: сценарии собираются из разговоров выгрузки."}
              </p>
            )}
          </div>
        </div>
        {showDetail && card ? (
          <ScenarioView
            key={card.id}
            card={card}
            record={records.get(card.id)}
            status={status}
            check={deck?.check ?? null}
            state={state}
            named={namedCriteria(card, list)}
            onPlay={() => set((n) => n.set("play", card.id), false)}
            onBack={wide ? undefined : () => pick(null)}
          />
        ) : showDetail && lost ? (
          <EmptyState
            drop
            title="Такого сценария нет"
            className="justify-center"
            action={<Button onClick={() => pick(null)}>Все сценарии</Button>}
          >
            Сценария из ссылки нет среди собранных. Новые сценарии заменяют прежние.
          </EmptyState>
        ) : (
          wide &&
          (cards.length ? (
            <CatalogTable tree={treeOf(cards, catalog, true)} catalog={catalog} onScenario={(s) => pick(s.cards[0])} />
          ) : (
            <EmptyState drop title="Выберите сценарий" className="justify-center">
              J и K листают.
            </EmptyState>
          ))
        )}
      </div>
    </div>
  );
}
