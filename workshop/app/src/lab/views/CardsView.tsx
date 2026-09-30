import { useMemo, useState } from "react";
import { ArrowRight, FlaskConical, Search, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../api";
import { count, plural } from "../format";
import { JobLine } from "../JobLine";
import { useLabContext } from "../LabContext";
import { DEFAULT_PERSONA, personaName } from "../look";
import { NextStep, SetupSteps } from "../Setup";
import { useToast } from "../toast";
import type { Card, LabState } from "../types";
import { Button, Chip, EmptyState, Input, Label, Page, PersonaIcon, Segmented, Verdict } from "../ui";

/** How the service names the two kinds of scenarios (lab/cards.py). */
export const FROM_ERROR = "Ошибка из лога";
export const COVERAGE = "Покрытие темы";

/** Where a scenario comes from: a violation the agent already made in a real dialogue, or a topic it handled well. */
export function OriginBadge({ origin }: { origin: string }) {
  return origin === FROM_ERROR
    ? <Verdict hue="bad" title="Агент уже ошибался в такой ситуации">из ошибки</Verdict>
    : <Verdict title="Агент отвечал верно: проверяем, что так и останется">покрытие</Verdict>;
}

/** One scenario as a row: where it comes from, its name, how the customer opens, what the judge checks. */
function ScenarioRow({ card, state, onPick }: { card: Card; state: LabState; onPick: () => void }) {
  const covered = state.personas.filter(p => p.id !== DEFAULT_PERSONA && card.openings?.[p.id]);
  return (
    <button onClick={onPick} className="lab-focus-inset group flex w-full items-center gap-4 px-4 py-3 text-left transition-colors duration-100 hover:bg-white/[0.03]">
      <span className="w-[92px] flex-shrink-0 max-sm:hidden"><OriginBadge origin={card.origin} /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-reading text-lab-ink">{card.name}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2">
          <span className="flex-shrink-0 sm:hidden"><OriginBadge origin={card.origin} /></span>
          <span className="truncate text-caption text-lab-mute">«{card.opening}»</span>
        </span>
      </span>
      <span className="hidden w-[180px] flex-shrink-0 truncate text-caption text-lab-mute lg:block" title={card.topic}>{card.topic}</span>
      <span className="hidden w-[84px] flex-shrink-0 items-center justify-end gap-1 sm:flex" title={covered.length ? `Есть реплики: ${covered.map(p => personaName(state.personas, p.id)).join(", ")}` : undefined}>
        {covered.slice(0, 4).map(p => <PersonaIcon key={p.id} id={p.id} size={18} />)}
      </span>
      <span className="w-[80px] flex-shrink-0 text-right text-caption tabular-nums text-lab-mute max-sm:hidden">{count(card.criteria.length, "критерий", "критерия", "критериев")}</span>
      <ArrowRight className="size-3.5 flex-shrink-0 text-lab-faint transition-colors duration-100 group-hover:text-lab-mute" />
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
  const q = query.trim().toLowerCase();
  const shown = deck.filter(c =>
    (origin === "all" || (origin === "errors") === (c.origin === FROM_ERROR)) &&
    (!topic || c.topic === topic) &&
    (!q || c.name.toLowerCase().includes(q) || c.opening.toLowerCase().includes(q)));

  const build = (
    <Button variant={deck.length ? "secondary" : "primary"} icon={FlaskConical} disabled={state.job.running || !state.discover} onClick={() => api("/api/cards", {}).catch(error)}
      title={!state.discover ? "Сначала оцените реальные диалоги: шаг «Логи»" : undefined}>
      {deck.length ? "Собрать заново" : "Собрать сценарии"}
    </Button>
  );

  return (
    <Page title="Подготовка" icon={SlidersHorizontal} count={undefined} bare nav={<SetupSteps state={state} current="checks" />} primary={build}>
      <header className="pt-10">
        <Label>Шаг 3 · сценарии</Label>
        <h2 className="mt-3 text-balance text-display font-medium text-lab-ink">
          {deck.length ? `${count(deck.length, "сценарий", "сценария", "сценариев")} для симулятора.` : "Соберите сценарии для симулятора."}
        </h2>
        <p className="mt-2 max-w-[720px] text-pretty text-lead text-lab-soft">
          {deck.length
            ? `${fromErrors} — из ошибок, которые агент уже делал в реальных диалогах, ${deck.length - fromErrors} — темы, где он отвечал верно. Каждую версию агента симулятор играет по ним.`
            : state.discover ? "Ситуация клиента берётся из реального диалога, критерии — из промптов агента." : "Сценарии собираются из оценённых реальных диалогов. Сначала пройдите шаг «Логи»."}
        </p>
        <div className="mt-4"><JobLine state={state} kind="cards" /></div>
      </header>

      {deck.length === 0 ? (
        <EmptyState icon={FlaskConical} title="Сценариев пока нет">
          {state.discover ? "Нажмите «Собрать сценарии»: ситуация берётся из реального диалога, критерии — из промптов агента, симулятор их не видит." : "Оцените реальные диалоги на шаге «Логи», потом соберите из них сценарии."}
        </EmptyState>
      ) : (
        <>
          <div className="mt-8 flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-[280px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-lab-faint" />
              <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Поиск по названию или реплике" aria-label="Поиск по сценариям" className="pl-8" />
            </div>
            <Segmented value={origin} onChange={setOrigin} options={[{ value: "all", label: "Все" }, { value: "errors", label: "Из ошибок" }, { value: "coverage", label: "Покрытие" }]} />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Chip on={topic === null} onClick={() => setTopic(null)} count={deck.length}>Все темы</Chip>
            {topics.map(([name, n]) => <Chip key={name} on={topic === name} onClick={() => setTopic(topic === name ? null : name)} count={n}>{name}</Chip>)}
          </div>
          <div className="mt-4 divide-y divide-lab-line overflow-hidden rounded-lg border border-lab-line bg-lab-panel">
            {shown.map(c => <ScenarioRow key={c.id} card={c} state={state} onPick={() => onPick(c.id)} />)}
          </div>
          {!shown.length && <div className={cn("mt-10 text-center text-body text-lab-mute")}>Под эти условия сценариев нет</div>}
          <NextStep
            done={state.runs.length > 0} title="Проверьте версию агента"
            hint={`Симулятор сыграет ${plural(deck.length, "этот сценарий", "эти сценарии", "эти сценарии")} с агентом, судья оценит каждый диалог — появится вердикт.`}
            to="/lab/overview" cta={state.runs.length ? "К версии" : "Проверить версию"} onClick={state.runs.length ? undefined : openNewRun}
          />
        </>
      )}
    </Page>
  );
}
