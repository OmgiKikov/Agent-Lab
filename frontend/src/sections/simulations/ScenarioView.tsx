import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, ArrowUpRight, Building2, Database, Play } from "lucide-react";
import { criterionLink, runLink, type Check } from "../../app/links";
import { BY_CRITERIA, CHECK_NAME } from "../../lab/checks";
import { duty } from "../../lab/criteria";
import { dialogOf } from "../../lab/dialogs";
import { count, longDay, time } from "../../lab/format";
import { personaName } from "../../lab/look";
import { FROM_LOG, isRunning, runTitle } from "../../lab/runs";
import { controlLine, firstSentence, runsOf, type Named, type Played, type ScenarioRecord } from "../../lab/scenarios";
import type { Card, Criterion as CardCriterion, LabState, Persona } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/EmptyState";
import { Label } from "../../ui/Label";
import { Tag } from "../../ui/Tag";
import { Dot, dotOf, originWord } from "./parts";

/** How the scenario's record stands: still loading, failed to load, or here (possibly empty). */
export type RecordState = "loading" | "error" | "ready";

const WORD_TONE: Record<Played["status"], string> = { FAIL: "text-bad", PASS: "text-ok", UNMEASURED: "text-fg-3" };
const summaryClass =
  "inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-small text-fg-3 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 [&::-webkit-details-marker]:hidden";

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-10" aria-label={label}>
      <Label>{label}</Label>
      {children}
    </section>
  );
}

/** «›» that turns when its folded block opens. */
function Fold() {
  return (
    <span aria-hidden className="transition-transform group-open:rotate-90">
      ›
    </span>
  );
}

/**
 * «Что воспроизводит»: the criteria the agent failed in the real conversation the scenario comes from, each with the
 * agent's words there, marked as everywhere the checks cite them. A control says what its conversation showed.
 */
function Reproduced({
  card,
  record,
  named,
  check,
}: {
  card: Card;
  record: ScenarioRecord;
  named: Map<string, Named>;
  check: Check | null;
}) {
  if (card.origin !== FROM_LOG)
    return (
      <p className="mt-2 max-w-[66ch] text-read text-fg-2">
        {card.origin}: {controlLine(record.sourceStatus)}. Сценарий проверяет ту же ситуацию с синтетическими клиентами.
      </p>
    );
  if (!record.reproduces.length)
    return (
      <p className="mt-2 max-w-[66ch] text-read text-fg-2">
        Сценарий собран из ошибки в настоящем разговоре. В нынешнем итоге проверки этой ошибки нет.
      </p>
    );
  return (
    <ul className="mt-2 divide-y divide-line">
      {record.reproduces.map((r) => {
        const own = named.get(r.ruleId);
        const name = own?.name ?? r.name;
        return (
          <li key={r.ruleId} className="grid grid-cols-[32px_minmax(0,1fr)] gap-2 py-3">
            <span className="pt-0.5 text-small tabular-nums text-fg-3">{own?.n ?? ""}</span>
            <div className="min-w-0">
              {own?.c && check ? (
                <Link
                  to={criterionLink(check, own.c.r.id)}
                  className="rounded-sm text-body font-medium text-fg decoration-line-strong underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
                >
                  {name}
                </Link>
              ) : (
                <p className="text-body font-medium text-fg">{name}</p>
              )}
              {r.agentQuote ? (
                <blockquote className="mt-1.5 whitespace-pre-wrap break-words text-read text-fg">
                  <span className="sr-only">Слова агента: </span>
                  <mark className="rounded-sm bg-mark px-0.5 text-fg">{r.agentQuote}</mark>
                </blockquote>
              ) : (
                <p className="mt-1 text-small text-fg-3">
                  Слова агента здесь не сохранены. Они есть в настоящем разговоре.
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** One conversation of a run: the type of customer, its result in a word, the criteria it failed; it opens there. */
function PlayCell({ p, personas, named }: { p: Played; personas: Persona[]; named: Map<string, Named> }) {
  const failed = p.failed.map((f) => named.get(f.ruleId)?.name ?? f.name);
  return (
    <Link
      to={dialogOf({ source: "sim", runId: p.run, index: p.index })}
      className="group/cell -mx-2 flex items-start gap-2 rounded-control px-2 py-1 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
    >
      <Dot status={p.status} className="mt-[3px] size-3" />
      <span className="min-w-0 flex-1 text-body">
        <span className="text-fg">
          {personaName(personas, p.persona)}
          {p.attempt > 1 ? ` · повтор ${p.attempt}` : ""}
        </span>
        <span className="text-fg-3"> — </span>
        <span className={WORD_TONE[p.status]}>{dotOf(p.status).word}</span>
        {failed.length > 0 && <span className="text-fg-2">: {failed.join(", ")}</span>}
      </span>
      <ArrowUpRight
        aria-hidden
        className="mt-0.5 size-3.5 flex-shrink-0 text-fg-4 opacity-0 transition-opacity group-hover/cell:opacity-100"
      />
    </Link>
  );
}

/**
 * «Результаты»: the scenario's own result in every run of its check that played it, newest first — each type of
 * customer with its word and, for an error, the criteria. Observations side by side, never a verdict on the agent.
 */
function Results({
  record,
  state,
  named,
  onPlay,
}: {
  record: ScenarioRecord;
  state: LabState;
  named: Map<string, Named>;
  onPlay: () => void;
}) {
  const runs = runsOf(record.history, state.personas);
  if (!runs.length)
    return (
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-read text-fg-2">Ещё не играли.</p>
        <Button
          size="sm"
          icon={Play}
          onClick={onPlay}
          disabled={!!state.job.running}
          title={state.job.running ? "Сейчас идёт другая задача" : undefined}
        >
          Сыграть этот сценарий
        </Button>
      </div>
    );
  return (
    <ul className="mt-2 divide-y divide-line">
      {runs.map((r) => {
        const summary = state.runs.find((x) => x.id === r.run);
        return (
          <li key={r.run} className="grid gap-x-6 gap-y-1.5 py-3 sm:grid-cols-[190px_minmax(0,1fr)]">
            <div className="min-w-0 pt-1">
              <Link
                to={runLink(r.run)}
                className="block truncate rounded-sm text-body font-medium text-fg decoration-line-strong underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
                title="Открыть итог прогона"
              >
                {r.label ? `«${r.label}»` : summary ? runTitle(summary) : "Прогон"}
              </Link>
              <span className="block text-small text-fg-3">
                {longDay(r.startedAt)}, {time(r.startedAt)}
                {summary && isRunning(summary) ? " · идёт" : ""}
              </span>
            </div>
            <ul>
              {r.plays.map((p) => (
                <li key={p.index}>
                  <PlayCell p={p} personas={state.personas} named={named} />
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

/** One criterion the runs will check: its number and name, linked to the check's criteria, or its duty. */
function CriterionRow({
  x,
  own,
  check,
  reproduced,
}: {
  x: CardCriterion;
  own?: Named;
  check: Check | null;
  reproduced?: boolean;
}) {
  const tag = reproduced && (
    <Tag tone="bad" className="mt-1.5">
      ошибка в настоящем разговоре
    </Tag>
  );
  if (!own?.c || !check)
    return (
      <li className="py-3">
        <span className="block text-body text-fg-2">{duty(x.text)}</span>
        {tag}
      </li>
    );
  return (
    <li>
      <Link
        to={criterionLink(check, own.c.r.id)}
        className="-mx-3 grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-2 rounded-control px-3 py-3 transition-colors hover:bg-hover"
      >
        <span className="pt-0.5 text-small tabular-nums text-fg-3">{own.n}</span>
        <span className="min-w-0">
          <span className="block text-body font-medium text-fg">{own.name}</span>
          <span className="mt-0.5 line-clamp-2 text-small text-fg-3">«{own.c.r.rule.quote}»</span>
          {tag}
        </span>
        <ArrowRight aria-hidden className="mt-1 size-3.5 text-fg-4" />
      </Link>
    </li>
  );
}

/**
 * A scenario is a test of the error it was built from: what it reproduces (the criterion the agent failed in the real
 * conversation, with its words), its own result in each run, the customer in a sentence (the full instruction for the
 * synthetic customer folded), how each type of customer begins, what will be checked (the reproduced criteria first),
 * the test data, and «Сыграть этот сценарий».
 */
export function ScenarioView({
  card,
  record,
  status,
  check,
  state,
  named,
  onPlay,
  onBack,
}: {
  card: Card;
  /** The scenario as a test (GET /api/scenarios); missing while it loads. */
  record?: ScenarioRecord;
  status: RecordState;
  /** The check whose errors the scenarios were built from. */
  check: Check | null;
  state: LabState;
  /** The scenario's criteria as the check numbers and names them. */
  named: Map<string, Named>;
  onPlay: () => void;
  onBack?: () => void;
}) {
  const openings = Object.entries(card.openings ?? {}).filter(([, text]) => text && text !== card.opening);
  const world = card.world;
  const tools = world ? Object.keys(world.tools ?? {}) : [];
  const busy = !!state.job.running;
  const summary = firstSentence(card.situation);
  const reproduced = new Set((record?.reproduces ?? []).map((r) => r.ruleId));
  // By the check's number; a criterion the check does not number goes last, in the scenario's order.
  const byNumber = (a: CardCriterion, b: CardCriterion) =>
    (named.get(a.id)?.n ?? Number.MAX_SAFE_INTEGER) - (named.get(b.id)?.n ?? Number.MAX_SAFE_INTEGER);
  const first = card.criteria.filter((x) => reproduced.has(x.id)).sort(byNumber);
  const rest = card.criteria.filter((x) => !reproduced.has(x.id)).sort(byNumber);
  const pending =
    status === "loading" ? (
      <Skeleton className="mt-3 h-16 max-w-2xl" />
    ) : (
      <p className="mt-2 text-read text-fg-3">Не удалось загрузить. Обновите страницу.</p>
    );
  // Tone of voice has one topic, named as the check: the topic is said only when it adds something.
  const topic = check && card.topic !== CHECK_NAME[check] ? card.topic : null;
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
          {card.scenario ? `${card.scenario.category} · ${card.scenario.title} · ` : ""}
          {topic ? `${topic} · ` : ""}
          <span className="text-fg-2">{originWord(card.origin, FROM_LOG)}</span>
          {check ? ` · ${BY_CRITERIA[check]}` : ""}
        </p>
        <h2 className="mt-2 text-balance text-title font-semibold text-fg">{card.name}</h2>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            icon={Play}
            onClick={onPlay}
            disabled={busy}
            title={busy ? "Сейчас идёт другая задача" : undefined}
          >
            Сыграть этот сценарий
          </Button>
          {card.sourceDialogueId && check && (
            <Link
              to={dialogOf({ source: "log", dialogueId: card.sourceDialogueId, check })}
              className="inline-flex items-center gap-1 text-small text-fg-2 underline decoration-line-strong underline-offset-4 hover:text-fg"
            >
              Настоящий разговор, из которого собран
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          )}
        </div>
        <Section label="Что воспроизводит">
          {record ? <Reproduced card={card} record={record} named={named} check={check} /> : pending}
        </Section>
        <Section label="Результаты">
          {record ? <Results record={record} state={state} named={named} onPlay={onPlay} /> : pending}
        </Section>
        <Section label="Клиент">
          <p className="mt-2 max-w-[66ch] text-read text-fg">{summary}</p>
          {summary !== card.situation.trim() && (
            <details className="group mt-2">
              <summary className={summaryClass}>
                Как это играет синтетический клиент
                <Fold />
              </summary>
              <p className="mt-2 max-w-[66ch] whitespace-pre-line text-read text-fg-2">{card.situation}</p>
            </details>
          )}
        </Section>
        <Section label="Клиент начинает так">
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
        </Section>
        <Section label={`Что проверят · ${count(card.criteria.length, "критерий", "критерия", "критериев")}`}>
          {first.length > 0 && (
            <ul className="mt-2 divide-y divide-line">
              {first.map((x) => (
                <CriterionRow key={x.id} x={x} own={named.get(x.id)} check={check} reproduced />
              ))}
            </ul>
          )}
          {rest.length > 0 &&
            (first.length ? (
              <details className="group border-t border-line pt-3">
                <summary className={summaryClass}>
                  и ещё {count(rest.length, "критерий", "критерия", "критериев")}
                  <Fold />
                </summary>
                <ul className="mt-1 divide-y divide-line">
                  {rest.map((x) => (
                    <CriterionRow key={x.id} x={x} own={named.get(x.id)} check={check} />
                  ))}
                </ul>
              </details>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {rest.map((x) => (
                  <CriterionRow key={x.id} x={x} own={named.get(x.id)} check={check} />
                ))}
              </ul>
            ))}
        </Section>
        {world && (
          <Section label="Тестовые данные вместо систем банка">
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
          </Section>
        )}
      </div>
    </article>
  );
}
