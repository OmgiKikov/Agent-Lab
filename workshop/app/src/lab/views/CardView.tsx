import { ChevronRight } from "lucide-react";
import { count, when } from "../format";
import { scenarioStatus } from "../logic";
import { useRunDetails } from "../useLab";
import { DEFAULT_PERSONA, personaName } from "../look";
import type { Card, LabState } from "../types";
import { Bubble, Label, Page, PersonaIcon, Section, StatusBadge, Verdict } from "../ui";
import { OriginBadge } from "./CardsView";

const FROM: Record<string, string> = { prompt: "из промпта", tools: "из инструментов", knowledge: "из базы знаний" };

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
      <header className="pt-10">
        <div className="flex flex-wrap items-center gap-2"><OriginBadge origin={card.origin} /><Label>{card.topic}</Label></div>
        <h2 className="mt-3 text-balance text-display font-medium text-lab-ink">{card.name}</h2>
        <p className="mt-2 max-w-[760px] text-pretty text-lead text-lab-soft">{card.situation}</p>
        <p className="mt-2 text-caption text-lab-mute">Ситуацию знает только симулятор клиента; агент видит лишь реплики.</p>
      </header>

      <div className="grid gap-x-10 min-[1100px]:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <Section title={openings.length > 1 ? "Как начинают разные клиенты" : "Первая реплика клиента"} count={openings.length > 1 ? openings.length : undefined}>
            <div className="divide-y divide-lab-line rounded-lg border border-lab-line bg-lab-panel">
              {openings.map(row => (
                <div key={row.id} className="grid grid-cols-1 items-start gap-2 px-4 py-3 sm:grid-cols-[170px_1fr] sm:gap-4">
                  <span className="flex items-center gap-2.5 text-body text-lab-text">
                    <PersonaIcon id={row.id} size={22} />
                    <span>{personaName(state.personas, row.id)}{row.id === DEFAULT_PERSONA && <span className="block text-caption text-lab-mute">из реального диалога</span>}</span>
                  </span>
                  <div className="flex"><Bubble>{row.text}</Bubble></div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Что проверит судья" count={card.criteria.length}>
            <div className="divide-y divide-lab-line rounded-lg border border-lab-line bg-lab-panel">
              {card.criteria.map((c, i) => (
                <div key={c.id} className="flex gap-4 px-4 py-3.5">
                  <span className="mt-0.5 font-mono text-micro tabular-nums text-lab-faint">{String(i + 1).padStart(2, "0")}</span>
                  <div className="min-w-0">
                    <div className="text-reading text-lab-ink">{c.text}</div>
                    <blockquote className="mt-1.5 border-l-2 border-lab-strong pl-2.5 text-caption text-lab-mute">
                      «{c.quote}» <span className="text-lab-faint">· {FROM[state.sources.find(src => src.id === c.sourceId)?.kind ?? "prompt"] ?? "из источника"}</span>
                    </blockquote>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </div>

        <aside className="min-w-0 min-[1100px]:sticky min-[1100px]:top-20 min-[1100px]:self-start">
          <Section title="В последних версиях">
            {history.length ? (
              <div className="divide-y divide-lab-line rounded-lg border border-lab-line bg-lab-panel">
                {history.map(({ run, own }) => {
                  const done = own.filter(x => x.status === "PASS" || x.status === "FAIL");
                  const passed = done.filter(x => x.status === "PASS").length;
                  return (
                    <div key={run.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <div className="text-body text-lab-ink">Версия {run.version}</div>
                        <div className="truncate font-mono text-micro text-lab-mute">{when(run.startedAt)}</div>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-2.5">
                        {own.length > 1 && <span className="text-caption tabular-nums text-lab-mute" title={count(own.length, "диалог", "диалога", "диалогов")}>{passed} из {done.length}</span>}
                        <StatusBadge status={scenarioStatus(own)} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <p className="rounded-lg border border-lab-line px-4 py-3 text-body text-lab-mute">{loading ? "Загружаю результаты…" : "Этот сценарий ещё не играли."}</p>}
          </Section>

          {card.world && (
            <Section title="Данные в системах банка" hint="заглушки">
              <div className="rounded-lg border border-lab-line bg-lab-panel p-4">
                <div className="text-body font-medium text-lab-ink">{card.world.organization.name}</div>
                <div className="mt-0.5 font-mono text-micro text-lab-mute">ИНН {card.world.organization.inn}</div>
                <div className="mt-2 text-body text-lab-soft">{card.world.organization.merchantName}, {card.world.organization.address}</div>
                <Label className="mb-2 mt-4">Терминалы</Label>
                <div className="flex flex-col gap-1.5">
                  {card.world.terminals.map(t => (
                    <div key={t.terminalId} className="flex items-center justify-between gap-2 text-body text-lab-text">
                      <span className="truncate">{t.nameForClient} <span className="font-mono text-micro text-lab-mute">{t.terminalId}</span></span>
                      {t.stateCode === "BLOCKED" && <Verdict hue="bad">заблокирован</Verdict>}
                    </div>
                  ))}
                </div>
                {Object.entries(card.world.tools).map(([name, value]) => (
                  <details key={name} className="group mt-3 border-t border-lab-line pt-3">
                    <summary className="lab-focus flex cursor-pointer list-none items-center gap-1.5 rounded-sm font-mono text-caption text-lab-text marker:hidden hover:text-lab-ink">
                      <ChevronRight className="size-3.5 text-lab-mute transition-transform duration-100 group-open:rotate-90" />{name}
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-lab-canvas p-3 text-caption text-lab-mute">{JSON.stringify(value, null, 2)}</pre>
                  </details>
                ))}
              </div>
            </Section>
          )}
        </aside>
      </div>
    </Page>
  );
}
