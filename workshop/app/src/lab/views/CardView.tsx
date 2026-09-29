import { ChevronRight } from "lucide-react";
import { count, whenLong } from "../format";
import { scenarioStatus } from "../logic";
import { useRunDetails } from "../useLab";
import { DEFAULT_PERSONA, personaName } from "../look";
import type { Card, LabState } from "../types";
import { Badge, Bubble, Page, Panel, PersonaIcon, Quote, Row, Section, StatusBadge } from "../ui";
import { OriginBadge } from "./CardsView";

const FROM: Record<string, string> = { prompt: "Из промпта", tools: "Из описания инструментов", knowledge: "Из базы знаний" };

/** One scenario: the customer's situation, how each customer type opens, what the judge will check, and how it went in recent versions. */
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
    <Page title={card.name} crumb={{ label: "Сценарии", onClick: onBack }} bare wide>
      <div className="mt-8 flex flex-wrap items-center gap-2 text-body text-lab-mute">
        <span>{card.topic}</span><span aria-hidden>·</span><OriginBadge origin={card.origin} /><span aria-hidden>·</span><span>{count(card.criteria.length, "критерий", "критерия", "критериев")}</span>
      </div>
      <h2 className="mt-2 text-balance text-title font-semibold text-lab-ink">{card.name}</h2>

      <div className="grid gap-x-8 min-[1100px]:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <Section className="mt-6" title="Ситуация клиента" hint="Её знает только симулятор; агент видит лишь реплики">
            <Panel className="px-5 py-4 text-reading text-lab-text">{card.situation}</Panel>
          </Section>

          <Section title={openings.length > 1 ? "Как начинают разные типы клиентов" : "Первая реплика клиента"} hint={openings.length > 1 ? "Ситуация та же, меняется только манера письма" : "Взята из реального диалога"}>
            <Panel>
              {openings.map((row, i) => (
                <Row first={!i} key={row.id} className="grid grid-cols-1 items-start gap-2 px-5 py-3.5 sm:grid-cols-[180px_1fr] sm:gap-4">
                  <span className="flex items-center gap-2.5 text-body text-lab-text">
                    <PersonaIcon id={row.id} size={24} />
                    <span>
                      {personaName(state.personas, row.id)}
                      {row.id === DEFAULT_PERSONA && <span className="block text-caption text-lab-mute">из реального диалога</span>}
                    </span>
                  </span>
                  <div className="flex"><Bubble>{row.text}</Bubble></div>
                </Row>
              ))}
            </Panel>
          </Section>

          <Section title="Что проверит судья" hint="Каждый критерий — с цитатой из источника, откуда он взят">
            <Panel>
              {card.criteria.map((c, i) => (
                <Row first={!i} key={c.id} className="flex gap-4 px-5 py-4">
                  <span className="mt-px flex size-6 flex-shrink-0 items-center justify-center rounded-full bg-lab-raised text-caption font-semibold tabular-nums text-lab-mute">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="text-reading text-lab-ink">{c.text}</div>
                    <Quote who={FROM[state.sources.find(src => src.id === c.sourceId)?.kind ?? "prompt"] ?? "Из источника"}>«{c.quote}»</Quote>
                  </div>
                </Row>
              ))}
            </Panel>
          </Section>
        </div>

        <aside className="min-w-0 min-[1100px]:sticky min-[1100px]:top-20 min-[1100px]:self-start">
          <Section className="mt-6" title="В последних версиях">
            {history.length ? (
              <Panel>
                {history.map(({ run, own }, i) => {
                  const done = own.filter(x => x.status === "PASS" || x.status === "FAIL");
                  const passed = done.filter(x => x.status === "PASS").length;
                  return (
                    <Row first={!i} key={run.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="text-body font-medium text-lab-ink">Версия {run.version}</div>
                        <div className="truncate text-caption text-lab-mute">{run.label || whenLong(run.startedAt)}</div>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-2.5">
                        {own.length > 1 && <span className="text-caption tabular-nums text-lab-mute" title={count(own.length, "диалог", "диалога", "диалогов")}>{passed} из {done.length}</span>}
                        <StatusBadge status={scenarioStatus(own)} />
                      </div>
                    </Row>
                  );
                })}
              </Panel>
            ) : <Panel className="px-4 py-4 text-body text-lab-mute">{loading ? "Загружаю результаты…" : "Этот сценарий ещё не играли."}</Panel>}
          </Section>

          {card.world && (
            <Section title="Данные в системах банка" hint="Заглушки, которые видит агент в этом сценарии">
              <Panel className="p-4">
                <div className="text-body font-semibold text-lab-ink">{card.world.organization.name}</div>
                <div className="mt-0.5 font-mono text-caption text-lab-mute">ИНН {card.world.organization.inn}</div>
                <div className="mt-2 text-body text-lab-text">{card.world.organization.merchantName}, {card.world.organization.address}</div>
                <div className="mb-2 mt-4 text-caption font-medium text-lab-mute">Терминалы</div>
                <div className="flex flex-col gap-1.5">
                  {card.world.terminals.map(t => (
                    <div key={t.terminalId} className="flex items-center justify-between gap-2 text-body text-lab-text">
                      <span className="truncate">{t.nameForClient} <span className="font-mono text-caption text-lab-mute">{t.terminalId}</span></span>
                      {t.stateCode === "BLOCKED" && <Badge hue="bad">заблокирован</Badge>}
                    </div>
                  ))}
                </div>
                {Object.entries(card.world.tools).map(([name, value]) => (
                  <details key={name} className="group mt-3 border-t border-lab-line pt-3">
                    <summary className="lab-focus flex cursor-pointer list-none items-center gap-1.5 rounded-sm font-mono text-caption text-lab-text marker:hidden hover:text-lab-ink">
                      <ChevronRight className="size-3.5 text-lab-mute transition-transform duration-100 group-open:rotate-90" />{name}
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-lab-canvas p-3 text-caption text-lab-mute">{JSON.stringify(value, null, 2)}</pre>
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
