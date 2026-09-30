import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Play } from "lucide-react";
import { personaName } from "../../lab/look";
import { FROM_LOG } from "../../lab/runs";
import type { Card, LabState } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Facts } from "../../ui/Facts";
import { Label } from "../../ui/Label";
import { Quote } from "../../ui/Quote";

function Part({ label, children }: { label: string; children: ReactNode }) {
  return <section className="mt-7"><Label className="mb-2.5">{label}</Label>{children}</section>;
}

/** A scenario: the situation, the customer's first words, the criteria it checks, the test data and the log it came from. */
export function ScenarioDetail({ card, state, onBack, onPlay }: { card: Card; state: LabState; onBack: () => void; onPlay: () => void }) {
  const openings = Object.entries(card.openings ?? {}).filter(([, text]) => text && text !== card.opening);
  const world = card.world;
  const tools = world ? Object.keys(world.tools ?? {}) : [];
  return (
    <article className="message-arrive mx-auto max-w-[760px] px-6 pb-20 pt-5 lg:px-8">
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1.5 text-small text-lab-mute transition-colors hover:text-lab-text lg:hidden">
        <ArrowLeft className="size-3.5" />Сценарии
      </button>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <h1 className="min-w-0 flex-1 text-page font-medium text-lab-ink">{card.name}</h1>
        <Button icon={Play} onClick={onPlay}>Сыграть этот сценарий</Button>
      </div>
      <Facts className="mt-3" facts={[
        { label: "Тема", value: card.topic },
        { label: "Откуда", value: card.origin === FROM_LOG ? "ошибка из лога" : "покрытие темы" },
        { label: "Критериев", value: card.criteria.length },
      ]} />
      {card.sourceDialogueId && (
        <Link to={`/logs?tab=dialogs&d=${encodeURIComponent(`log~${card.sourceDialogueId}`)}`} className="mt-4 inline-flex items-center gap-1.5 text-small text-lab-ink underline decoration-white/20 underline-offset-4 hover:decoration-white/60">
          Диалог из лога, по которому собран сценарий<ArrowRight className="size-3.5" />
        </Link>
      )}

      <Part label="Ситуация"><p className="whitespace-pre-line text-read text-lab-text">{card.situation}</p></Part>

      <Part label="Первая реплика клиента">
        <div className="max-w-[560px] rounded-xl rounded-tl-sm bg-lab-user px-3.5 py-2 text-read text-lab-ink">{card.opening}</div>
        {openings.length > 0 && (
          <div className="mt-3 space-y-2">
            {openings.map(([id, text]) => (
              <div key={id} className="flex gap-3 text-small">
                <span className="w-32 flex-shrink-0 text-meta text-lab-dim">{personaName(state.personas, id)}</span>
                <span className="min-w-0 text-lab-soft">{text}</span>
              </div>
            ))}
          </div>
        )}
      </Part>

      <Part label="Критерии, которые проверяет судья">
        <div className="space-y-4">
          {card.criteria.map(c => (
            <div key={c.id}>
              <Link to={`/rules/${encodeURIComponent(c.id)}`} className="text-body text-lab-ink hover:underline hover:decoration-white/40 hover:underline-offset-4">{c.text}</Link>
              {c.quote && <div className="mt-2"><Quote label="Промпт требует">{c.quote}</Quote></div>}
            </div>
          ))}
        </div>
      </Part>

      {world && (
        <Part label="Тестовые данные">
          <Facts facts={[
            { label: "Организация", value: world.organization.name },
            { label: "ИНН", value: <span className="font-mono">{world.organization.inn}</span> },
            { label: "Точка", value: world.organization.merchantName },
            { label: "Терминалов", value: world.terminals.length },
            ...(tools.length ? [{ label: "Инструменты", value: <span className="font-mono">{tools.join(", ")}</span> }] : []),
          ]} />
          {world.terminals.length > 0 && (
            <div className="mt-3">
              {world.terminals.map(t => (
                <div key={t.terminalId} className="flex items-baseline gap-4 border-b border-white/[0.06] py-1.5 text-small">
                  <span className="min-w-0 flex-1 text-lab-text">{t.nameForClient}</span>
                  <span className="font-mono text-meta text-lab-dim">{t.terminalId}</span>
                  <span className="font-mono text-meta text-lab-dim">{t.stateCode}</span>
                </div>
              ))}
            </div>
          )}
        </Part>
      )}
    </article>
  );
}
