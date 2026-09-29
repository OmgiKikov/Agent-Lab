import { useMemo, useState } from "react";
import { FlaskConical, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../api";
import { plural } from "../format";
import { JobLine } from "../JobLine";
import { DEFAULT_PERSONA, personaName } from "../look";
import { useToast } from "../toast";
import type { Card, LabState } from "../types";
import { Badge, Bubble, Button, Chip, EmptyState, Input, Page, PersonaIcon, Segmented, Stat } from "../ui";

/** How the service names the two kinds of scenarios (lab/cards.py). */
export const FROM_ERROR = "Ошибка из лога";
export const COVERAGE = "Покрытие темы";

export function OriginBadge({ origin }: { origin: string }) {
  return (
    <Badge hue="mute">
      {origin === FROM_ERROR && <span className="size-1.5 rounded-full bg-lab-bad" />}
      {origin}
    </Badge>
  );
}

function ScenarioCard({ card, state, onPick }: { card: Card; state: LabState; onPick: () => void }) {
  const covered = state.personas.filter(p => p.id !== DEFAULT_PERSONA && card.openings?.[p.id]);
  return (
    <button
      onClick={onPick}
      className="group flex flex-col gap-3 rounded-lg border border-white/[0.07] bg-lab-surface p-4 text-left transition-all duration-150 hover:-translate-y-px hover:border-white/[0.18] hover:bg-white/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lab-accent/50"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[11px] text-lab-dim">{card.topic}</span>
        <OriginBadge origin={card.origin} />
      </div>
      <div className="text-[14px] font-medium leading-snug text-lab-ink">{card.name}</div>
      <Bubble className="line-clamp-2 self-start">{card.opening}</Bubble>
      <div className="mt-auto flex items-center justify-between pt-1 text-[12px] text-lab-dim">
        <span>{card.criteria.length} {plural(card.criteria.length, "критерий", "критерия", "критериев")}</span>
        {covered.length > 0 && (
          <span className="flex items-center gap-1" title={`Есть реплики: ${covered.map(p => personaName(state.personas, p.id)).join(", ")}`}>
            {covered.map(p => <PersonaIcon key={p.id} id={p.id} size={20} />)}
          </span>
        )}
      </div>
    </button>
  );
}

export function CardsView({ state, onPick }: { state: LabState; onPick: (id: string) => void }) {
  const { error } = useToast();
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

  return (
    <Page
      wide title="набор проверок"
      lede="Сценарии, которые симулятор играет за клиента при каждой проверке агента. Ситуация взята из реального разговора, критерии из правил промпта; симулятор их не видит."
      actions={<>
        <Button variant="primary" icon={FlaskConical} disabled={state.job.running || !state.discover} onClick={() => api("/api/cards", {}).catch(error)}>{deck.length ? "Собрать заново" : "Собрать сценарии"}</Button>
        <JobLine state={state} kind="cards" />
        {!state.discover && !state.job.running && <span className="text-[11px] text-lab-dim">Сначала оцените логи</span>}
      </>}
    >
      {deck.length === 0 ? (
        <EmptyState className="mt-5" drop title="Сценариев пока нет">
          {state.discover ? "Нажмите «Собрать сценарии»: из оценённых логов получатся ситуации клиента с критериями проверки." : "Сначала оцените логи на шаге «Логи», потом соберите из них сценарии."}
        </EmptyState>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3 min-[1100px]:grid-cols-4">
            <Stat label="Сценариев" value={deck.length} sub={`в ${topics.length} ${plural(topics.length, "теме", "темах", "темах")}`} />
            <Stat label="Из ошибок в логах" value={fromErrors} sub="агент уже ошибался в таких ситуациях" />
            <Stat label="Покрытие тем" value={deck.length - fromErrors} sub="агент отвечал верно: проверяем, что так и останется" />
            {others.length > 0 && <Stat label="Типы клиентов" value={`${full}/${deck.length}`} sub="сценариев с репликами для всех типов" />}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <div className="relative w-[260px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-lab-dim" />
              <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Поиск по названию или реплике" className="pl-9" />
            </div>
            <Segmented value={origin} onChange={setOrigin} options={[{ value: "all", label: "Все" }, { value: "errors", label: "Из ошибок" }, { value: "coverage", label: "Покрытие" }]} />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Chip on={topic === null} onClick={() => setTopic(null)} count={deck.length}>Все темы</Chip>
            {topics.map(([name, n]) => <Chip key={name} on={topic === name} onClick={() => setTopic(topic === name ? null : name)} count={n}>{name}</Chip>)}
          </div>

          <div className="mt-5 grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
            {shown.map(c => <ScenarioCard key={c.id} card={c} state={state} onPick={() => onPick(c.id)} />)}
          </div>
          {!shown.length && <div className={cn("mt-10 text-center text-[13px] text-lab-dim")}>Под фильтр ничего не подошло</div>}
        </>
      )}
    </Page>
  );
}
