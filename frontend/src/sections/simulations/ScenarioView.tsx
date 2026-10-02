import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Building2, Database, Play } from "lucide-react";
import { criterionLink } from "../../app/links";
import { duty, type Criterion } from "../../lab/criteria";
import { dialogOf } from "../../lab/dialogs";
import { plural } from "../../lab/format";
import { personaName } from "../../lab/look";
import { FROM_LOG } from "../../lab/runs";
import type { Card, LabState } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { originWord } from "./parts";

/** A scenario: the situation, how the customer begins (for each type), what the judge will check, the test data, and «Сыграть». */
export function ScenarioView({
  card,
  state,
  mine,
  onPlay,
  onBack,
}: {
  card: Card;
  state: LabState;
  mine: Criterion[];
  onPlay: () => void;
  onBack?: () => void;
}) {
  const openings = Object.entries(card.openings ?? {}).filter(([, text]) => text && text !== card.opening);
  const world = card.world;
  const tools = world ? Object.keys(world.tools ?? {}) : [];
  return (
    <article className="min-h-0 overflow-auto" aria-label={card.name}>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="sticky top-0 z-10 flex h-11 w-full items-center gap-1.5 border-b border-line bg-canvas px-3 text-body text-fg-2 lg:hidden"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Сценарии
        </button>
      )}
      <div className="max-w-4xl px-4 pb-16 pt-5 lg:px-10 lg:pt-7">
        <p className="text-small text-fg-3">
          {card.topic} · <span className="text-fg-2">{originWord(card.origin, FROM_LOG)}</span>
        </p>
        <h2 className="mt-2 text-balance text-title font-semibold text-fg">{card.name}</h2>
        <p className="mt-3 max-w-[66ch] whitespace-pre-line text-read text-fg-2">{card.situation}</p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            icon={Play}
            onClick={onPlay}
            disabled={!!state.job.running}
            title={state.job.running ? "Сейчас идёт другая задача" : undefined}
          >
            Сыграть этот сценарий
          </Button>
          {card.sourceDialogueId && (
            <Link
              to={dialogOf({ source: "log", dialogueId: card.sourceDialogueId })}
              className="inline-flex items-center gap-1 text-small text-fg-2 underline decoration-line-strong underline-offset-4 hover:text-fg"
            >
              Настоящий разговор, откуда он
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          )}
        </div>
        <section className="mt-10" aria-label="Клиент начинает так">
          <Label>Клиент начинает так</Label>
          <div className="mt-3 space-y-3 rounded-sheet bg-inset px-4 py-4 sm:px-6">
            {[
              ["обычный клиент", card.opening] as const,
              ...openings.map(([id, text]) => [personaName(state.personas, id), text] as const),
            ].map(([who, text]) => (
              <div key={who} className="flex flex-col items-end gap-1">
                <span className="text-small text-fg-3">{who}</span>
                <span className="max-w-[78%] rounded-xl rounded-br-sm bg-customer px-3 py-2 text-read text-customer-fg">
                  {text}
                </span>
              </div>
            ))}
          </div>
        </section>
        <section className="mt-10" aria-label="Что проверят">
          <Label>
            Что проверят · {mine.length || card.criteria.length}{" "}
            {plural(mine.length || card.criteria.length, "критерий", "критерия", "критериев")}
          </Label>
          <ul className="mt-2 divide-y divide-line">
            {mine.length
              ? mine.map((c) => (
                  <li key={c.r.id}>
                    <Link
                      to={criterionLink(c.r.id)}
                      className="-mx-3 grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-2 rounded-control px-3 py-3 transition-colors hover:bg-hover"
                    >
                      <span className="pt-0.5 text-small tabular-nums text-fg-3">{c.n}</span>
                      <span className="min-w-0">
                        <span className="block text-body font-medium text-fg">{c.name}</span>
                        <span className="mt-0.5 block text-small text-fg-3">«{c.r.rule.quote}»</span>
                      </span>
                      <ArrowRight aria-hidden className="mt-1 size-3.5 text-fg-4" />
                    </Link>
                  </li>
                ))
              : card.criteria.map((x) => (
                  <li key={x.id} className="py-3 text-body text-fg-2">
                    {duty(x.text)}
                  </li>
                ))}
          </ul>
        </section>
        {world && (
          <section className="mt-10" aria-label="Тестовые данные">
            <Label>Тестовые данные · подставятся вместо систем банка</Label>
            <div className="mt-3 rounded-sheet bg-inset px-4 py-4 sm:px-6">
              <p className="flex items-center gap-2 text-body text-fg">
                <Building2 aria-hidden className="size-4 text-fg-3" />
                {world.organization.name}
              </p>
              <p className="mt-1 flex flex-wrap gap-x-4 text-small text-fg-3">
                <span>
                  ИНН <span className="font-mono text-fg-2">{world.organization.inn}</span>
                </span>
                <span>точка «{world.organization.merchantName}»</span>
              </p>
              {world.terminals.length > 0 && (
                <table className="mt-3 w-full text-small">
                  <tbody>
                    {world.terminals.map((t) => (
                      <tr key={t.terminalId} className="border-t border-line">
                        <td className="py-1.5 pr-3 text-fg-2">{t.nameForClient}</td>
                        <td className="py-1.5 pr-3 font-mono text-meta text-fg-3">{t.terminalId}</td>
                        <td className="py-1.5 font-mono text-meta text-fg-4">{t.stateCode}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {tools.length > 0 && (
                <p className="mt-3 flex flex-wrap gap-1.5">
                  {tools.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 rounded border border-line-strong px-1.5 py-0.5 font-mono text-meta text-fg-3"
                    >
                      <Database aria-hidden className="size-3" />
                      {t}
                    </span>
                  ))}
                </p>
              )}
            </div>
          </section>
        )}
      </div>
    </article>
  );
}
