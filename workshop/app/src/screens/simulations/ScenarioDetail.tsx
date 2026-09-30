import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Play } from "lucide-react";
import { dialogPath, logKey } from "../../lab/dialogs";
import { personaName } from "../../lab/look";
import { useProblems } from "../../lab/problems";
import { FROM_LOG } from "../../lab/runs";
import type { Card, LabState } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Facts } from "../../ui/Facts";
import { Label } from "../../ui/Label";
import { Quote } from "../../ui/Quote";

function Part({ label, children }: { label: string; children: ReactNode }) {
  return <section className="mt-8"><Label className="mb-3">{label}</Label>{children}</section>;
}

/** A scenario for the simulator: the situation, the customer's first words, the rules it checks and the test data. */
export function ScenarioDetail({ card, state, onBack, onPlay }: { card: Card; state: LabState; onBack: () => void; onPlay: () => void }) {
  const { data } = useProblems(null);
  const known = new Set((data?.rules ?? []).map(r => r.id));
  const openings = Object.entries(card.openings ?? {}).filter(([, text]) => text && text !== card.opening);
  const world = card.world;
  const tools = world ? Object.keys(world.tools ?? {}) : [];
  return (
    <article className="message-arrive mx-auto max-w-[760px] px-6 pb-20 pt-6 lg:px-8">
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-small text-lab-mute transition-colors hover:text-lab-text lg:hidden">
        <ArrowLeft className="size-3.5" />Сценарии
      </button>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <h1 className="min-w-0 flex-1 text-page font-semibold text-lab-ink">{card.name}</h1>
        <Button icon={Play} onClick={onPlay} disabled={state.job.running} title={state.job.running ? "Сейчас идёт другая задача" : undefined}>Сыграть этот сценарий</Button>
      </div>
      <Facts className="mt-5" facts={[
        { label: "Тема", value: card.topic },
        { label: "Откуда", value: card.origin === FROM_LOG ? "ошибка из лога" : "покрытие темы" },
        { label: "Правил", value: card.criteria.length },
      ]} />
      {card.sourceDialogueId && (
        <Link to={dialogPath(logKey(card.sourceDialogueId))} className="mt-5 inline-flex items-center gap-1.5 text-small text-lab-ink underline decoration-white/20 underline-offset-4 hover:decoration-white/60">
          Диалог логов, из которого собран сценарий<ArrowRight className="size-3.5" />
        </Link>
      )}

      <Part label="Ситуация">
        <p className="whitespace-pre-line text-read text-lab-text">{card.situation}</p>
      </Part>

      <Part label="Первая реплика клиента">
        <div className="max-w-[560px] rounded-xl rounded-tl-sm bg-lab-user px-4 py-2.5 text-read text-lab-ink">{card.opening}</div>
        {openings.length > 0 && (
          <div className="mt-4 space-y-3">
            {openings.map(([id, text]) => (
              <div key={id}>
                <div className="text-meta text-lab-dim">{personaName(state.personas, id)}</div>
                <div className="mt-1 text-small text-lab-soft">{text}</div>
              </div>
            ))}
          </div>
        )}
      </Part>

      <Part label="Правила, которые проверяет судья">
        <div className="space-y-6">
          {card.criteria.map(c => (
            <div key={c.id}>
              {known.has(c.id)
                ? <Link to={`/rules/${encodeURIComponent(c.id)}`} className="text-body text-lab-ink hover:underline hover:decoration-white/40 hover:underline-offset-4">{c.text}</Link>
                : <div className="text-body text-lab-ink">{c.text}</div>}
              {c.quote && <div className="mt-3"><Quote label="Промпт требует">{c.quote}</Quote></div>}
            </div>
          ))}
        </div>
      </Part>

      {world && (
        <Part label="Тестовые данные для заглушек">
          <Facts facts={[
            { label: "Организация", value: world.organization.name },
            { label: "ИНН", value: <span className="font-mono">{world.organization.inn}</span> },
            { label: "Точка", value: world.organization.merchantName },
          ]} />
          {world.organization.address && <p className="mt-3 text-small text-lab-mute">{world.organization.address}</p>}
          {world.terminals.length > 0 && (
            <div className="mt-4">
              {world.terminals.map(t => (
                <div key={t.terminalId} className="flex items-baseline gap-4 border-b border-white/[0.06] py-2 text-small">
                  <span className="min-w-0 flex-1 text-lab-text">{t.nameForClient}</span>
                  <span className="font-mono text-meta text-lab-dim">{t.terminalId}</span>
                  <span className="font-mono text-meta text-lab-dim">{t.stateCode}</span>
                </div>
              ))}
            </div>
          )}
          {tools.length > 0 && <p className="mt-3 text-meta text-lab-dim">Ответы инструментов: <span className="font-mono">{tools.join(", ")}</span></p>}
        </Part>
      )}
    </article>
  );
}
