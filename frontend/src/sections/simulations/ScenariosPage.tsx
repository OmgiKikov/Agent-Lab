import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { useKeys } from "../../app/keys";
import { useWide } from "../../app/useWide";
import { BY_CRITERIA, CHECKS, resultOf } from "../../lab/checks";
import { useCriteria } from "../../lab/criteria";
import { count, day } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { personaName } from "../../lab/look";
import { FROM_LOG } from "../../lab/runs";
import {
  controlLine,
  namedCriteria,
  failedTypes,
  outcomeOf,
  runsOf,
  useScenarios,
  type Named,
  type Outcome,
  type Played,
  type ScenarioRecord,
} from "../../lab/scenarios";
import type { Card, Persona } from "../../lab/types";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Search } from "../../ui/Search";
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
        "block w-full rounded-control px-3 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60",
        on ? "bg-selected" : "hover:bg-hover",
      )}
    >
      {children}
    </button>
  );
}

/** Why the scenario exists, in one line: the error it reproduces (the first, and how many more), or a control. */
function Reproduces({ card, record, named }: { card: Card; record?: ScenarioRecord; named: Map<string, Named> }) {
  if (!record) return <span aria-hidden className="mt-0.5 block h-[18px]" />;
  if (card.origin !== FROM_LOG)
    return (
      <span className="mt-0.5 block truncate text-small text-fg-3">
        {card.origin}: {controlLine(record.sourceStatus)}
      </span>
    );
  const [first, ...more] = record.reproduces;
  if (!first)
    return <span className="mt-0.5 block truncate text-small text-fg-2">Из ошибки в настоящем разговоре</span>;
  return (
    <span className="mt-0.5 flex min-w-0 gap-1.5 text-small text-fg-2">
      <span className="truncate">Воспроизводит: {named.get(first.ruleId)?.name ?? first.name}</span>
      {more.length > 0 && <span className="flex-shrink-0 tabular-nums text-fg-3">+{more.length}</span>}
    </span>
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

/** The order of the list: the category and the scenario of the catalog; cards without one come last. */
const scenarioKey = (c: Card) => (c.scenario ? `${c.scenario.category}\u0000${c.scenario.title}` : "\uffff");

/**
 * «Сценарии»: each scenario is a test of the error it was built from, in the check named over the list. A row says what
 * it reproduces and how it came out in the latest run that played it, beside the run before; the list filters by that
 * latest result, and the scenarios with an error play again in one go. A scenario opens with its results by run.
 */
export function ScenariosPage() {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const wide = useWide();
  const deck = state?.cards ?? null;
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
  // Grouped by the business scenarios of the catalog: a category, then its scenarios, then the cards of each.
  const shown = cards
    .filter(
      (c) =>
        (filter === "all" || outcome(c) === filter) &&
        (!q ||
          `${c.name} ${c.topic} ${c.scenario?.category ?? ""} ${c.scenario?.title ?? ""} ${c.situation} ${c.opening}`
            .toLowerCase()
            .includes(q)),
    )
    .sort((a, b) => scenarioKey(a).localeCompare(scenarioKey(b), "ru"));
  const topics = new Set(cards.map((c) => c.topic)).size;
  const id = params.get("s") ?? (wide ? (shown[0]?.id ?? null) : null);
  const card = cards.find((c) => c.id === id) ?? null;
  const pick = (next: string | null) =>
    set((n) => {
      if (next) n.set("s", next);
      else n.delete("s");
    }, wide);
  const step = (d: 1 | -1) => {
    if (!shown.length) return;
    const i = shown.findIndex((c) => c.id === id);
    pick(shown[Math.max(0, Math.min(shown.length - 1, (i < 0 ? -1 : i) + d))].id);
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

  const fromErrors = cards.filter((c) => c.origin === FROM_LOG).length;
  // A scenario the address names that is not among the ones built: said so in its place, never a blank one.
  const lost = !!params.get("s") && !card;
  const showDetail = (!!card || lost) && (wide || !!params.get("s"));
  const status: RecordState = card && records.has(card.id) ? "ready" : isError && !isFetching ? "error" : "loading";
  const busy = !!state.job.running;
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="grid min-h-0 flex-1 lg:grid-cols-[400px_minmax(0,1fr)]">
        <div className={cn("flex min-h-0 flex-col border-line lg:border-r", showDetail && !wide && "hidden")}>
          <div className="space-y-3 px-4 pb-3 pt-4">
            <p className="text-read text-fg-3">
              {cards.length && deck ? (
                <>
                  {count(cards.length, "сценарий", "сценария", "сценариев")} {BY_CRITERIA[deck.check]}, {fromErrors}
                  {"\u00a0— из ошибок в диалогах"}
                  {deck.createdAt ? ` · собраны ${day(deck.createdAt)}` : ""}
                </>
              ) : (
                "Сценариев пока нет"
              )}
            </p>
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
              <ul aria-label="Сценарии">
                {shown.map((c, i) => (
                  <li key={c.id}>
                    {c.scenario && c.scenario.id !== shown[i - 1]?.scenario?.id && (
                      <p className="px-3 pb-1 pt-4 text-small text-fg-3">
                        {c.scenario.category} · <span className="text-fg-2">{c.scenario.title}</span>
                      </p>
                    )}
                    <Row on={c.id === id} onClick={() => pick(c.id)}>
                      {topics > 1 && !c.scenario && <span className="block text-small text-fg-3">{c.topic}</span>}
                      <span className="block text-body font-medium text-fg">{c.name}</span>
                      <Reproduces card={c} record={records.get(c.id)} named={namedCriteria(c, list)} />
                      <LastResults record={records.get(c.id)} personas={state.personas} />
                    </Row>
                  </li>
                ))}
              </ul>
            )}
            {!shown.length && (filter === "all" || tests) && (
              <p className="px-3 py-10 text-center text-small text-fg-3">
                {cards.length
                  ? "Ничего не нашлось"
                  : CHECKS.some((c) => resultOf(state, c))
                    ? "Соберите сценарии из ошибок проверки."
                    : "Сценарии собираются из ошибок проверки. Сначала проверьте разговоры в разделе «Tone of voice» или «Точность»."}
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
          wide && (
            <EmptyState drop title="Выберите сценарий" className="justify-center">
              J и K листают.
            </EmptyState>
          )
        )}
      </div>
    </div>
  );
}
