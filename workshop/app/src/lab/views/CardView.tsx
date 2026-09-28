import { ArrowLeft } from "lucide-react";
import { plural, when } from "../format";
import { scenarioStatus } from "../logic";
import { useRunDetails } from "../useLab";
import { DEFAULT_PERSONA, personaName } from "../look";
import type { Card, LabState } from "../types";
import { Badge, Bubble, Button, Eyebrow, Page, Panel, PersonaIcon, Quote, Row, Section, StatusBadge } from "../ui";
import { OriginBadge } from "./CardsView";

/** One scenario: the situation, how each customer type opens, and what the judge will check. */
export function CardView({ card, state, onBack }: { card: Card; state: LabState; onBack: () => void }) {
  // /api/state lists runs without conversations: the few latest are fetched to see how this scenario went.
  const latest = state.runs.filter(r => r.status !== "running" && r.metric?.total).slice(0, 5);
  const details = useRunDetails(latest);
  const history = latest.map(run => ({ run, own: details(run)?.items?.filter(i => i.cardId === card.id) ?? [] })).filter(x => x.own.length);
  const loading = latest.length > 0 && latest.some(r => !details(r));
  const openings = [
    { id: DEFAULT_PERSONA, text: card.opening },
    ...state.personas.filter(p => card.openings?.[p.id]).map(p => ({ id: p.id, text: card.openings![p.id] })),
  ];
  return (
    <Page
      wide title={card.name}
      lede={<span className="inline-flex items-center gap-2"><span className="font-mono">{card.topic}</span><OriginBadge origin={card.origin} /></span>}
      actions={<Button size="sm" icon={ArrowLeft} onClick={onBack}>Все сценарии</Button>}
    >
      <div className="grid gap-x-8 min-[1100px]:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <Section className="mt-5" title="Ситуация клиента">
            <Panel className="px-5 py-4 text-[14px] leading-relaxed text-lab-soft">{card.situation}</Panel>
          </Section>

          <Section title={openings.length > 1 ? "Первая реплика у разных типов клиентов" : "Первая реплика клиента"} hint={openings.length > 1 ? "Ситуация та же, меняется только манера письма" : "Взята из реального разговора"}>
            <Panel>
              {openings.map((row, i) => (
                <Row first={!i} key={row.id} className="grid grid-cols-[170px_1fr] items-start gap-4 px-5 py-3.5">
                  <span className="flex items-center gap-2.5 text-[12px] text-lab-soft">
                    <PersonaIcon id={row.id} size={26} />
                    <span>
                      {personaName(state.personas, row.id)}
                      {row.id === DEFAULT_PERSONA && <span className="block font-mono text-[10px] text-lab-dim">из лога</span>}
                    </span>
                  </span>
                  <div className="flex"><Bubble>{row.text}</Bubble></div>
                </Row>
              ))}
            </Panel>
          </Section>

          <Section title="Критерии оценки" hint="Судья проверяет каждый критерий по ответам агента">
            <Panel>
              {card.criteria.map((c, i) => (
                <Row first={!i} key={c.id} className="flex gap-4 px-5 py-4">
                  <span className="mt-px flex size-6 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.07] font-mono text-[11px] text-lab-mute">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="text-[14px] leading-snug text-lab-text">{c.text}</div>
                    <Quote who="в промпте">«{c.quote}»</Quote>
                  </div>
                </Row>
              ))}
            </Panel>
          </Section>
        </div>

        <aside className="min-w-0 min-[1100px]:sticky min-[1100px]:top-6 min-[1100px]:self-start">
          <Section className="mt-5" title="Результаты в прогонах">
            {history.length ? (
              <Panel>
                {history.map(({ run, own }, i) => {
                  const done = own.filter(x => x.status === "PASS" || x.status === "FAIL");
                  const passed = done.filter(x => x.status === "PASS").length;
                  return (
                    <Row first={!i} key={run.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] text-lab-text">{run.targetName}</div>
                        <div className="font-mono text-[11px] text-lab-dim">{run.version} · {when(run.startedAt)}</div>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-2.5">
                        {own.length > 1 && <span className="font-mono text-[11px] text-lab-dim" title={`${own.length} ${plural(own.length, "разговор", "разговора", "разговоров")}`}>{passed}/{done.length}</span>}
                        <StatusBadge status={scenarioStatus(own)} />
                      </div>
                    </Row>
                  );
                })}
              </Panel>
            ) : <Panel className="px-4 py-4 text-[12px] text-lab-dim">{loading ? "Загружаю результаты…" : "Этот сценарий ещё не запускали."}</Panel>}
          </Section>

          {card.world && (
            <Section title="Данные в системах банка" hint="Заглушки, которые видит агент">
              <Panel className="p-4">
                <div className="text-[13px] font-medium text-lab-text">{card.world.organization.name}</div>
                <div className="mt-0.5 font-mono text-[11px] text-lab-dim">ИНН {card.world.organization.inn}</div>
                <div className="mt-2 text-[12px] leading-snug text-lab-mute">{card.world.organization.merchantName}, {card.world.organization.address}</div>
                <Eyebrow className="mb-2 mt-4">Терминалы</Eyebrow>
                <div className="flex flex-col gap-1.5">
                  {card.world.terminals.map(t => (
                    <div key={t.terminalId} className="flex items-center justify-between gap-2 text-[12px] text-lab-soft">
                      <span className="truncate">{t.nameForClient} <span className="font-mono text-[11px] text-lab-dim">{t.terminalId}</span></span>
                      {t.stateCode === "BLOCKED" && <Badge hue="bad">заблокирован</Badge>}
                    </div>
                  ))}
                </div>
                {Object.entries(card.world.tools).map(([name, value]) => (
                  <details key={name} className="group mt-3 border-t border-white/[0.06] pt-3">
                    <summary className="cursor-pointer list-none font-mono text-[11px] text-lab-accent marker:hidden hover:underline">{name}</summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-white/[0.03] p-3 font-mono text-[11px] text-lab-mute">{JSON.stringify(value, null, 2)}</pre>
                  </details>
                ))}
              </Panel>
            </Section>
          )}
        </aside>
      </div>
    </Page>
  );
}
