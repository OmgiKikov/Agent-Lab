import { useEffect, useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Hammer } from "lucide-react";
import { day } from "../../lab/format";
import { api } from "../../lab/api";
import { FROM_LOG } from "../../lab/runs";
import { JobStrip } from "../../shell/Activity";
import { useKeys } from "../../shell/keys";
import { useLabState } from "../../shell/LabProvider";
import { SectionHeader } from "../../shell/SectionHeader";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Summary } from "../../ui/Summary";
import { Split } from "../../ui/Split";
import { useToast } from "../../ui/toast";
import { inOrigin, ScenarioList, type Origin } from "./ScenarioList";
import { ScenarioDetail } from "./ScenarioDetail";

const wide = () => window.matchMedia("(min-width: 1024px)").matches;
const link = "text-small text-lab-ink underline underline-offset-4";

/** Сценарии: the business-scenario cards built from the assessed logs, for the synthetic customers to play. */
export function ScenariosPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { state, offline, refresh } = useLabState();
  const toast = useToast();
  const cards = useMemo(() => state?.cards?.cards ?? [], [state?.cards]);
  const query = params.get("q") ?? "";
  const origin = (params.get("origin") as Origin | null) ?? "all";
  const setParam = (k: string, v: string | null) => setParams(prev => { const n = new URLSearchParams(prev); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const q = query.trim().toLowerCase();
  const order = useMemo(() => {
    const shown = cards.filter(c => inOrigin(c, origin) && (!q || `${c.name} ${c.topic} ${c.situation}`.toLowerCase().includes(q)));
    return [...shown.reduce((m, c) => m.set(c.topic, [...(m.get(c.topic) ?? []), c]), new Map<string, typeof cards>()).values()].flat().map(c => c.id);
  }, [cards, origin, q]);
  const sel = params.get("s");
  const card = cards.find(c => c.id === sel);

  useEffect(() => {
    if (!card && order[0] && wide()) setParam("s", order[0]);
  }, [card, order[0]]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = (d: 1 | -1) => {
    if (!order.length) return;
    const at = order.indexOf(sel ?? "");
    setParam("s", order[at < 0 ? 0 : Math.max(0, Math.min(order.length - 1, at + d))]);
  };
  useKeys({ KeyJ: () => step(1), ArrowDown: () => step(1), KeyK: () => step(-1), ArrowUp: () => step(-1) });

  if (offline && !state) return <ServiceDown />;
  const busy = !!state?.job.running;
  const build = () => api("/api/cards", {}).then(() => refresh()).catch(toast.error);
  const fromErrors = cards.filter(c => c.origin === FROM_LOG).length;
  const topics = new Set(cards.map(c => c.topic)).size;

  const empty = !state?.discover
    ? <EmptyState drop title="Сначала нужна оценка логов">Сценарии собираются из оценённых логов. <Link to="/logs" className={link}>Открыть логи</Link></EmptyState>
    : <EmptyState drop title="Сценариев пока нет" action={<Button variant="primary" icon={Hammer} disabled={busy} onClick={build}>Собрать сценарии</Button>} />;

  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        crumbs={[{ label: "Сценарии", to: card ? "/scenarios" : undefined }, ...(card ? [{ label: card.name }] : [])]}
        actions={<Button variant="primary" icon={Hammer} onClick={build} disabled={busy || !state?.discover}
          title={busy ? "Сейчас идёт другая задача" : !state?.discover ? "Сначала оцените логи" : "Собрать сценарии из оценённых логов"}>Собрать сценарии</Button>}
        below={<JobStrip kinds={["cards"]} />}
      />
      {!state ? <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div> : !cards.length ? empty : (
        <>
          <Summary stats={[
            { label: "Сценариев", value: cards.length, active: origin === "all", onClick: () => setParam("origin", null), title: state?.cards?.createdAt ? `Собраны ${day(state.cards.createdAt)}` : undefined },
            { label: "Из ошибок логов", value: fromErrors, of: `из ${cards.length}`, active: origin === "errors", onClick: () => setParam("origin", "errors") },
            { label: "Покрытие тем", value: cards.length - fromErrors, of: `из ${cards.length}`, active: origin === "coverage", onClick: () => setParam("origin", "coverage") },
            { label: "Тем", value: topics },
          ]} />
          <Split
            showDetail={!!card}
            list={<ScenarioList cards={cards} selectedId={card?.id ?? null} onPick={id => setParam("s", id)} query={query} onQuery={v => setParam("q", v || null)} origin={origin} onOrigin={o => setParam("origin", o === "all" ? null : o)} />}
            detail={card
              ? <ScenarioDetail key={card.id} card={card} state={state} onBack={() => setParam("s", null)} onPlay={() => navigate(`/simulations?play=${encodeURIComponent(card.id)}`)} />
              : <EmptyState title="Выберите сценарий" />}
          />
        </>
      )}
    </div>
  );
}
