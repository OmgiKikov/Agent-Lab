import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Play } from "lucide-react";
import { personaName } from "../../lab/look";
import { FROM_LOG } from "../../lab/runs";
import type { Card, LabState } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { Details, Tag, type Detail } from "../../ui/Details";
import { PillTabs } from "../../ui/PillTabs";
import { Quote } from "../../ui/Quote";
import { Tiles } from "../../ui/Tiles";
import { TwoCol } from "../../ui/TwoCol";

type Tab = "talk" | "criteria" | "data";

const link = "underline decoration-white/20 underline-offset-2 hover:text-lab-ink";

/** A scenario as Raindrop's issue page: the situation and its numbers on the left; the customer's words, the criteria and the test data on the right. */
export function ScenarioDetail({ card, state, onBack, onPlay }: { card: Card; state: LabState; onBack: () => void; onPlay: () => void }) {
  const [tab, setTab] = useState<Tab>("talk");
  const [more, setMore] = useState(false);
  const openings = Object.entries(card.openings ?? {}).filter(([, text]) => text && text !== card.opening);
  const world = card.world;
  const tools = world ? Object.keys(world.tools ?? {}) : [];
  const details: Detail[] = [
    { label: "Тема", value: <Tag>{card.topic}</Tag> },
    { label: "Откуда", value: card.origin === FROM_LOG ? "ошибка из лога" : "покрытие темы" },
    ...(card.sourceDialogueId ? [{ label: "Диалог", value: <Link to={`/logs?tab=dialogs&d=${encodeURIComponent(`log~${card.sourceDialogueId}`)}`} className={link}>диалог из лога, по которому собран сценарий</Link> }] : []),
    ...(world ? [
      { label: "Организация", value: world.organization.name },
      { label: "ИНН", value: <span className="font-mono text-meta">{world.organization.inn}</span> },
      { label: "Точка", value: world.organization.merchantName },
    ] : []),
  ];
  const left = (
    <>
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1.5 text-small text-lab-mute transition-colors hover:text-lab-text lg:hidden"><ArrowLeft className="size-3.5" />Сценарии</button>
      <Chip tone="mute">{card.origin === FROM_LOG ? "Ошибка из лога" : "Покрытие темы"}</Chip>
      <h1 className="mt-2.5 text-title font-medium text-lab-ink">{card.name}</h1>
      <p className={more ? "mt-2 whitespace-pre-line text-small text-lab-mute" : "mt-2 line-clamp-3 text-small text-lab-mute"}>{card.situation}</p>
      {card.situation.length > 150 && <button type="button" onClick={() => setMore(m => !m)} className="text-small text-lab-soft underline decoration-white/20 underline-offset-2 hover:text-lab-ink">{more ? "свернуть" : "…ещё"}</button>}
      <div className="mt-3"><Button variant="primary" icon={Play} onClick={onPlay}>Сыграть этот сценарий</Button></div>
      <Tiles className="mt-4" tiles={[
        { label: "Критериев", value: card.criteria.length, onClick: () => setTab("criteria") },
        { label: "Реплик клиента", value: 1 + openings.length, onClick: () => setTab("talk"), title: "Первая реплика и её версии по типам клиентов" },
        ...(world ? [{ label: "Терминалов", value: world.terminals.length, onClick: () => setTab("data") }] : []),
        ...(tools.length ? [{ label: "Инструментов", value: tools.length, onClick: () => setTab("data") }] : []),
      ]} />
      <Details rows={details} />
    </>
  );
  const right = (
    <div className="flex min-h-full flex-col">
      <div className="flex-shrink-0 border-b border-white/[0.08] px-3 py-[7px]">
        <PillTabs<Tab> value={tab} onChange={setTab} tabs={[
          { value: "talk", label: "Реплика клиента" },
          { value: "criteria", label: "Критерии", count: card.criteria.length },
          ...(world ? [{ value: "data" as const, label: "Тестовые данные" }] : []),
        ]} />
      </div>
      <div className="px-4 pb-16 pt-4">
        {tab === "talk" && (
          <div>
            <div className="ml-auto max-w-[560px] rounded-[10px] border border-[rgb(75_180_200/0.11)] bg-lab-user px-[11px] py-2 text-read text-[rgb(212,224,230)]">{card.opening}</div>
            {openings.length > 0 && (
              <section className="mt-8">
                <h2 className="text-heading font-semibold text-lab-ink">По типам клиентов</h2>
                <div className="mt-2">
                  {openings.map(([id, text]) => (
                    <div key={id} className="flex gap-4 border-b border-white/[0.08] py-2.5 text-small">
                      <span className="w-36 flex-shrink-0 text-meta text-lab-mute">{personaName(state.personas, id)}</span>
                      <span className="min-w-0 text-lab-soft">{text}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
        {tab === "criteria" && (
          <div className="space-y-5">
            {card.criteria.map(c => (
              <div key={c.id}>
                <Link to={`/agent/criteria?c=${encodeURIComponent(c.id)}`} className="text-small font-medium text-lab-ink hover:underline hover:decoration-white/40 hover:underline-offset-4">{c.text}</Link>
                {c.quote && <div className="mt-2"><Quote label="Промпт требует">{c.quote}</Quote></div>}
              </div>
            ))}
          </div>
        )}
        {tab === "data" && world && (
          <div>
            {tools.length > 0 && <p className="mb-4 text-small text-lab-mute">Инструменты: <span className="font-mono text-meta text-lab-soft">{tools.join(", ")}</span></p>}
            <h2 className="text-heading font-semibold text-lab-ink">Терминалы</h2>
            <div className="mt-2">
              {world.terminals.map(t => (
                <div key={t.terminalId} className="flex items-baseline gap-4 border-b border-white/[0.08] py-2 text-small">
                  <span className="min-w-0 flex-1 text-lab-text">{t.nameForClient}</span>
                  <span className="font-mono text-meta text-lab-dim">{t.terminalId}</span>
                  <span className="font-mono text-meta text-lab-dim">{t.stateCode}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
  return <TwoCol left={left} right={right} />;
}
