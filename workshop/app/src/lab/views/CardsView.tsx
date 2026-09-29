import { useMemo, useState } from "react";
import { FlaskConical, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../api";
import { count, plural } from "../format";
import { JobLine } from "../JobLine";
import { useLabContext } from "../LabContext";
import { DEFAULT_PERSONA, personaName } from "../look";
import { NextStep, SetupSteps } from "../Setup";
import { useToast } from "../toast";
import type { Card, LabState } from "../types";
import { Badge, Bubble, Button, Chip, EmptyState, Input, Page, PersonaIcon, Segmented } from "../ui";

/** How the service names the two kinds of scenarios (lab/cards.py). */
export const FROM_ERROR = "Ошибка из лога";
export const COVERAGE = "Покрытие темы";

/** Where a scenario comes from: a violation the agent already made in a real dialogue, or a topic it handled well. */
export function OriginBadge({ origin }: { origin: string }) {
  return origin === FROM_ERROR
    ? <Badge hue="bad" title="Агент уже ошибался в такой ситуации">из ошибки</Badge>
    : <Badge title="Агент отвечал верно: проверяем, что так и останется">покрытие темы</Badge>;
}

function ScenarioCard({ card, state, onPick }: { card: Card; state: LabState; onPick: () => void }) {
  const covered = state.personas.filter(p => p.id !== DEFAULT_PERSONA && card.openings?.[p.id]);
  return (
    <button
      onClick={onPick}
      className="lab-focus group flex flex-col gap-3 rounded-xl border border-lab-line bg-lab-panel p-4 text-left transition-colors duration-100 hover:border-lab-edge hover:bg-lab-card"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-caption text-lab-mute">{card.topic}</span>
        <OriginBadge origin={card.origin} />
      </div>
      <div className="text-reading font-semibold text-lab-ink">{card.name}</div>
      <Bubble className="line-clamp-2 self-start">{card.opening}</Bubble>
      <div className="mt-auto flex items-center justify-between pt-1 text-caption text-lab-mute">
        <span>{count(card.criteria.length, "критерий", "критерия", "критериев")}</span>
        {covered.length > 0 && (
          <span className="flex items-center gap-1" title={`Есть реплики: ${covered.map(p => personaName(state.personas, p.id)).join(", ")}`}>
            {covered.map(p => <PersonaIcon key={p.id} id={p.id} size={20} />)}
          </span>
        )}
      </div>
    </button>
  );
}

/** Step 3: the situations the customer simulator plays with every version of the agent. */
export function CardsView({ state, onPick }: { state: LabState; onPick: (id: string) => void }) {
  const { error } = useToast();
  const { openNewRun } = useLabContext();
  const deck = useMemo(() => state.cards?.cards ?? [], [state.cards]);
  const [query, setQuery] = useState("");
  const [origin, setOrigin] = useState<"all" | "errors" | "coverage">("all");
  const [topic, setTopic] = useState<string | null>(null);

  const topics = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of deck) m.set(c.topic, (m.get(c.topic) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [deck]);
  const fromErrors = deck.filter(c => c.origin === FROM_ERROR).length;
  const others = state.personas.filter(p => p.id !== DEFAULT_PERSONA);
  const full = others.length ? deck.filter(c => others.every(p => c.openings?.[p.id])).length : 0;
  const q = query.trim().toLowerCase();
  const shown = deck.filter(c =>
    (origin === "all" || (origin === "errors") === (c.origin === FROM_ERROR)) &&
    (!topic || c.topic === topic) &&
    (!q || c.name.toLowerCase().includes(q) || c.opening.toLowerCase().includes(q)));

  const actions = (
    <>
      <JobLine state={state} kind="cards" bare />
      <Button size="sm" variant={deck.length ? "secondary" : "primary"} icon={FlaskConical} disabled={state.job.running || !state.discover} onClick={() => api("/api/cards", {}).catch(error)}
        title={!state.discover ? "Сначала оцените реальные диалоги на шаге «Логи»" : undefined}>
        {deck.length ? "Собрать заново" : "Собрать сценарии"}
      </Button>
    </>
  );
  const lede = deck.length
    ? `${count(deck.length, "сценарий", "сценария", "сценариев")} в ${count(topics.length, "теме", "темах", "темах")}: ${fromErrors} — из ошибок, которые агент уже делал в реальных диалогах, ${deck.length - fromErrors} — покрытие тем, где он отвечал верно.${others.length ? ` Реплики для всех типов клиентов есть у ${full} из ${deck.length}.` : ""}`
    : state.discover ? "Сценариев пока нет. Соберите их: из оценённых диалогов получатся ситуации клиента с критериями проверки." : "Сценарии собираются из оценённых реальных диалогов. Сначала пройдите шаг «Логи».";

  return (
    <Page title="Сценарии" count={deck.length || undefined} bare wide nav={<SetupSteps state={state} current="checks" />} actions={actions} lede={lede}>
      {deck.length === 0 ? (
        <EmptyState className="mt-6" icon={FlaskConical} title="Сценариев пока нет">
          {state.discover ? "Нажмите «Собрать сценарии»: ситуация берётся из реального диалога, критерии — из промптов агента, симулятор их не видит." : "Оцените реальные диалоги на шаге «Логи», потом соберите из них сценарии."}
        </EmptyState>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <div className="relative w-full sm:w-[260px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-lab-mute" />
              <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Поиск по названию или реплике" aria-label="Поиск по сценариям" className="pl-8" />
            </div>
            <Segmented value={origin} onChange={setOrigin} options={[{ value: "all", label: "Все" }, { value: "errors", label: "Из ошибок" }, { value: "coverage", label: "Покрытие" }]} />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Chip on={topic === null} onClick={() => setTopic(null)} count={deck.length}>Все темы</Chip>
            {topics.map(([name, n]) => <Chip key={name} on={topic === name} onClick={() => setTopic(topic === name ? null : name)} count={n}>{name}</Chip>)}
          </div>

          <div className="mt-5 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {shown.map(c => <ScenarioCard key={c.id} card={c} state={state} onPick={() => onPick(c.id)} />)}
          </div>
          {!shown.length && <div className={cn("mt-10 text-center text-body text-lab-mute")}>Под эти условия сценариев нет</div>}
          <NextStep
            done={state.runs.length > 0} title="Проверьте версию агента"
            hint={`Симулятор сыграет ${plural(deck.length, "этот сценарий", "эти сценарии", "эти сценарии")} с агентом, судья оценит каждый диалог — появится вердикт по версии.`}
            to="/lab/overview" cta={state.runs.length ? "К сводке" : "Проверить версию"} onClick={state.runs.length ? undefined : openNewRun}
          />
        </>
      )}
    </Page>
  );
}
