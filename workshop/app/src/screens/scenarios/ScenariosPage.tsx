import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Building2, Database, FileWarning, Hammer, Layers, Play, Search } from "lucide-react";
import { api } from "../../lab/api";
import { useCriteria, type Criterion, type Topic } from "../../lab/criteria";
import { day, plural } from "../../lab/format";
import { personaName } from "../../lab/look";
import { FROM_LOG } from "../../lab/runs";
import type { Card, LabState } from "../../lab/types";
import { JobStrip } from "../../shell/Activity";
import { FirstRun } from "../../shell/FirstRun";
import { useKeys } from "../../shell/keys";
import { useLabState } from "../../shell/LabProvider";
import { LINKS } from "../../shell/links";
import { SectionHeader } from "../../shell/SectionHeader";
import { Bubble } from "../../ui/Bubble";
import { Button } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Mark, MarkStack } from "../../ui/Mark";
import { Chips, Pill } from "../../ui/Pill";
import { Caption, Floating, PageTitle, Tile, TileGrid, WithFloating } from "../../ui/Tile";
import { useToast } from "../../ui/toast";
import { cn } from "@/lib/utils";

const quoteKey = (q: string) => q.replace(/\s+/g, " ").trim().toLowerCase();

/** The product's numbered criteria a scenario checks, found by the prompt's words they stand on. */
function useCardCriteria(criteria: Criterion[]) {
  return useMemo(() => {
    const byQuote = new Map(criteria.map(c => [quoteKey(c.r.rule.quote), c]));
    return (card: Card) => card.criteria.flatMap(x => { const c = byQuote.get(quoteKey(x.quote)); return c ? [c] : []; }).sort((a, b) => a.n - b.n);
  }, [criteria]);
}

function TopicPill({ topic, topics }: { topic: string; topics: Topic[] }) {
  const t = topics.find(x => x.topic === topic);
  return <Pill dot={t?.hue} hue={t?.hue} title={topic}>{t?.short ?? topic.split(",")[0]}</Pill>;
}

const OriginPill = ({ card }: { card: Card }) => card.origin === FROM_LOG
  ? <Pill icon={FileWarning} className="border-lab-bad/30 bg-lab-bad/[0.08] text-[rgb(236,170,162)]" title="Собран из разговора, где агент нарушил критерий">Из ошибки</Pill>
  : <Pill icon={Layers} title="Собран, чтобы покрыть тему">Покрытие</Pill>;

function ScenarioTile({ card, ns, topics, on, onOpen }: { card: Card; ns: number[]; topics: Topic[]; on: boolean; onOpen: () => void }) {
  return (
    <Tile on={on} onClick={onOpen} className="min-h-[200px]">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5"><TopicPill topic={card.topic} topics={topics} /><OriginPill card={card} /></div>
      </div>
      <div className="mt-3 text-[14px] font-medium leading-[20px] text-lab-ink">{card.name}</div>
      <Bubble clamp className="mt-3">{card.opening}</Bubble>
      <div className="mt-auto flex items-center gap-2 pt-4 text-[11.5px] text-lab-dim">
        <span className="min-w-0 flex-1 truncate">{card.world?.organization.name ?? `${card.criteria.length} ${plural(card.criteria.length, "критерий", "критерия", "критериев")}`}</span>
        <MarkStack ns={ns} max={5} />
      </div>
    </Tile>
  );
}

function ScenarioPanel({ card, state, mine, topics, onClose }: { card: Card; state: LabState; mine: Criterion[]; topics: Topic[]; onClose: () => void }) {
  const navigate = useNavigate();
  const [more, setMore] = useState(false);
  const openings = Object.entries(card.openings ?? {}).filter(([, text]) => text && text !== card.opening);
  const world = card.world;
  const tools = world ? Object.keys(world.tools ?? {}) : [];
  return (
    <Floating onClose={onClose} head={<><TopicPill topic={card.topic} topics={topics} /><OriginPill card={card} /></>}>
      <h2 className="text-[20px] font-medium leading-[26px] tracking-[-0.4px] text-lab-ink">{card.name}</h2>
      <p className={cn("mt-2 whitespace-pre-line text-[13px] leading-[20px] text-lab-soft", !more && "line-clamp-5")}>{card.situation}</p>
      {card.situation.length > 300 && <button type="button" onClick={() => setMore(m => !m)} className="mt-1 text-[12px] text-lab-mute underline decoration-white/20 underline-offset-2 hover:text-lab-ink">{more ? "свернуть" : "вся ситуация"}</button>}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={Play} onClick={() => navigate(`/simulations?play=${encodeURIComponent(card.id)}`)}>Сыграть этот сценарий</Button>
        {card.sourceDialogueId && card.origin === FROM_LOG && (
          <Link to={`/logs?tab=dialogs&d=${encodeURIComponent(`log~${card.sourceDialogueId}`)}`} className="inline-flex items-center gap-1 text-[12px] text-lab-mute hover:text-lab-ink">Разговор из лога, откуда он<ArrowRight className="size-3" /></Link>
        )}
      </div>

      <Caption className="mt-6">Клиент начинает так</Caption>
      <div className="mt-2 space-y-3 rounded-[12px] border border-white/[0.08] bg-[rgb(33,33,33)] px-4 py-3.5">
        <Bubble who="обычный клиент">{card.opening}</Bubble>
        {openings.map(([id, text]) => <Bubble key={id} who={personaName(state.personas, id)}>{text}</Bubble>)}
      </div>

      <Caption className="mt-6">{mine.length ? `Судья проверит · ${mine.length} ${plural(mine.length, "критерий", "критерия", "критериев")}` : "Критерии"}</Caption>
      <div className="mt-2 overflow-hidden rounded-[10px] border border-white/[0.08]">
        {mine.length ? mine.map(c => (
          <Link key={c.r.id} to={`${LINKS.criteria}?c=${encodeURIComponent(c.r.id)}`} className="flex items-center gap-2.5 border-b border-white/[0.06] bg-[rgb(35,35,35)] px-3 py-2 transition-colors last:border-b-0 hover:bg-[rgb(40,40,40)]">
            <Mark n={c.n} /><span className="min-w-0 flex-1 truncate text-[12.5px] text-lab-text">{c.name}</span><ArrowRight className="size-3 text-lab-faint" />
          </Link>
        )) : card.criteria.map(x => <div key={x.id} className="border-b border-white/[0.06] bg-[rgb(35,35,35)] px-3 py-2 text-[12.5px] text-lab-text last:border-b-0">{x.text}</div>)}
      </div>

      {world && (
        <>
          <Caption className="mt-6">Тестовые данные · подставятся вместо систем банка</Caption>
          <div className="mt-2 rounded-[12px] border border-white/[0.08] bg-[rgb(33,33,33)] px-4 py-3.5">
            <div className="flex items-center gap-2 text-[13px] text-lab-ink"><Building2 className="size-3.5 text-lab-dim" />{world.organization.name}</div>
            <div className="mt-1 flex flex-wrap gap-x-4 text-[11.5px] text-lab-dim">
              <span>ИНН <span className="font-mono text-lab-soft">{world.organization.inn}</span></span>
              <span>точка «{world.organization.merchantName}»</span>
            </div>
            {world.terminals.length > 0 && (
              <div className="mt-3 space-y-1">
                {world.terminals.map(t => (
                  <div key={t.terminalId} className="flex items-baseline gap-3 text-[12px]">
                    <span className="min-w-0 flex-1 truncate text-lab-text">{t.nameForClient}</span>
                    <span className="font-mono text-[11px] text-lab-dim">{t.terminalId}</span>
                    <span className="font-mono text-[11px] text-lab-faint">{t.stateCode}</span>
                  </div>
                ))}
              </div>
            )}
            {tools.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{tools.map(t => <Pill key={t} mono icon={Database} className="rounded-md">{t}</Pill>)}</div>}
          </div>
        </>
      )}
    </Floating>
  );
}

type OriginFilter = "errors" | "coverage";

/** Сценарии: business-scenario cards built from the assessed logs — for synthetic customers to play with the agent. */
export function ScenariosPage() {
  const [params, setParams] = useSearchParams();
  const { state, offline, refresh } = useLabState();
  const toast = useToast();
  const { list, topics } = useCriteria(null);
  const criteriaOf = useCardCriteria(list);
  const cards = useMemo(() => state?.cards?.cards ?? [], [state?.cards]);
  const [origin, setOrigin] = useState<OriginFilter | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const sel = params.get("s");
  const setSel = (id: string | null) => setParams(prev => { const n = new URLSearchParams(prev); if (id) n.set("s", id); else n.delete("s"); return n; }, { replace: true });
  const q = query.trim().toLowerCase();
  const shown = cards.filter(c => (!origin || (origin === "errors" ? c.origin === FROM_LOG : c.origin !== FROM_LOG)) && (!topic || c.topic === topic)
    && (!q || `${c.name} ${c.topic} ${c.situation} ${c.opening}`.toLowerCase().includes(q)));
  const at = shown.findIndex(c => c.id === sel);
  useKeys({ KeyJ: () => shown.length && setSel(shown[Math.min(shown.length - 1, at + 1)].id), KeyK: () => shown.length && setSel(shown[Math.max(0, at - 1)].id) });
  if (offline && !state) return <ServiceDown />;

  const busy = !!state?.job.running;
  const build = () => api("/api/cards", {}).then(() => refresh()).catch(toast.error);
  const card = cards.find(c => c.id === sel) ?? null;
  const fromErrors = cards.filter(c => c.origin === FROM_LOG).length;
  const cardTopics = [...new Set(cards.map(c => c.topic))];
  const hints = [{ title: "Из ошибок логов", text: "Разговор, где агент нарушил критерий, становится сценарием." }, { title: "Покрытие тем", text: "По сценарию на тему, чтобы проверить и то, что работает." }, { title: "Что дальше", text: "Клиенты-симуляторы сыграют сценарии с агентом." }];
  const buildButton = (
    <Button variant="primary" icon={Hammer} onClick={build} disabled={busy || !state?.discover}
      title={busy ? "Сейчас идёт другая задача" : !state?.discover ? "Сначала оцените логи" : "Собрать сценарии из оценённых логов"}>{cards.length ? "Собрать заново" : "Собрать сценарии"}</Button>
  );

  let body;
  if (!state) body = <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div>;
  else if (!cards.length) {
    body = !state.discover
      ? <FirstRun here="scenarios" title="Сценарии собираются из оценённых логов" action={<Link to="/logs"><Button variant="primary">Открыть логи</Button></Link>} hints={hints}>Сначала оцените логи: по их нарушениям строятся карточки для синтетических клиентов.</FirstRun>
      : <FirstRun here="scenarios" title="Сценариев пока нет" action={buildButton} hints={hints}>Карточка описывает ситуацию, первую реплику клиента и критерии, по которым судья проверит ответ.</FirstRun>;
  } else {
    body = (
      <WithFloating open={!!card} panel={card && <ScenarioPanel key={card.id} card={card} state={state} mine={criteriaOf(card)} topics={topics} onClose={() => setSel(null)} />}>
        <PageTitle title="Сценарии" sub={`ситуации для синтетических клиентов${state.cards?.createdAt ? ` · собраны ${day(state.cards.createdAt)}` : ""}`} actions={<>
          <label className="flex h-8 w-[200px] items-center gap-2 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 focus-within:border-white/[0.22]">
            <Search className="size-3.5 text-lab-dim" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Найти сценарий" className="min-w-0 flex-1 bg-transparent text-[12px] text-lab-ink outline-none placeholder:text-lab-faint" />
          </label>
          {buildButton}
        </>} />
        <Chips<OriginFilter> className="mt-4" value={origin} onChange={setOrigin} options={[
          { value: null, label: "Все", count: cards.length },
          { value: "errors", label: "Из ошибок логов", count: fromErrors, icon: FileWarning },
          { value: "coverage", label: "Покрытие тем", count: cards.length - fromErrors, icon: Layers },
        ]} />
        <Chips<string> className="mt-2" value={topic} onChange={setTopic} options={cardTopics.map(t => {
          const x = topics.find(y => y.topic === t);
          return { value: t, label: x?.short ?? t.split(",")[0], dot: x?.hue, title: t, count: cards.filter(c => c.topic === t).length };
        })} />
        <div className="mt-5">
          <TileGrid>{shown.map(c => <ScenarioTile key={c.id} card={c} ns={criteriaOf(c).map(x => x.n)} topics={topics} on={c.id === sel} onOpen={() => setSel(c.id === sel ? null : c.id)} />)}</TileGrid>
          {!shown.length && <p className="mt-10 text-center text-[13px] text-lab-dim">Ничего не нашлось</p>}
        </div>
        <p className="mt-4 text-[11px] text-lab-faint">{cards.length} {plural(cards.length, "сценарий", "сценария", "сценариев")} · номера — критерии, по которым судья проверит разговор · J и K листают</p>
      </WithFloating>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <SectionHeader crumbs={[{ label: "Сценарии" }]} meta={cards.length ? `${cards.length} · ${cardTopics.length} ${plural(cardTopics.length, "тема", "темы", "тем")}` : undefined} below={<JobStrip kinds={["cards"]} />} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
    </div>
  );
}
