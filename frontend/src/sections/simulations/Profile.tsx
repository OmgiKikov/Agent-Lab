import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { plural } from "../../lab/format";
import type { Card, DeckChecks, Knowledge, Observation } from "../../lab/types";
import { Label } from "../../ui/Label";
import { Tag } from "../../ui/Tag";

/** What the agent did, as the card's reactions name it (backend/lab/domain/cards.py, TRIGGERS). */
const TRIGGER: Record<string, string> = {
  unclear_question: "непонятный вопрос",
  repeated_clarification: "переспросил",
  wrong_object: "не тот объект",
  inapplicable_instruction: "неприменимая инструкция",
  no_progress: "нет продвижения",
  identifier_request: "спросил номер или реквизиты",
  choice_offer: "предложил выбрать",
  instruction: "инструкция",
  handoff_offer: "предложил оператора",
  resolved: "ответил на вопрос",
};
/** What the customer did in reply (backend/lab/domain/cards.py, ACTIONS). */
const ACTION: Record<string, string> = {
  answer: "ответил",
  give_detail: "уточнил подробность",
  dont_know: "сказал, что не знает",
  ask_how: "спросил, как именно",
  ask_meaning: "переспросил",
  correct_object: "поправил агента",
  report_obstacle: "сказал, что мешает",
  report_result: "сообщил результат",
  choose_option: "выбрал вариант",
  decline_handoff: "остался в чате",
  ask_human: "попросил специалиста",
  restate: "повторил задачу",
  accept: "принял ответ",
};
const CHANNEL: Record<string, string> = { WEB: "сайт банка", MOBILE: "приложение банка" };
const ENTRY: Record<string, string> = {
  first_message: "задача в первом сообщении",
  after_greeting: "задача после приветствия",
  after_other_topic: "задача после другого вопроса",
};
const IDENTIFIER: Record<string, string> = {
  knows: "знает",
  unknown: "не знает",
  looks_up: "посмотрит, если спросят",
};
/** Fewer customer messages than this tell a manner by chance: one message is no habit. */
const MANNER_FROM = 3;

/** Where an item stands in the log: a hover shows the customer's words it rests on. */
const cited = (x: { n: number; quote: string }) => `Реплика ${x.n}: «${x.quote}»`;
const messages = (n: number) => `${n} ${plural(n, "сообщение", "сообщения", "сообщений")}`;

function Itemized({ items }: { items: (Knowledge | Observation)[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((x) => (
        <li key={`${x.n}-${"text" in x ? x.text : x.action}`} title={cited(x)} className="text-body text-fg">
          {"text" in x ? (
            x.text
          ) : (
            <>
              <span className="text-fg-3">уже пробовал:</span> {x.action} — {x.result}
            </>
          )}
          {"access" in x && x.access === "believes" && <span className="text-fg-3"> · так считает</span>}
        </li>
      ))}
    </ul>
  );
}

/** One column of «Что знает и когда скажет»: when, how many, the facts; a dash when there are none. */
function When({ label, items, accent }: { label: string; items: (Knowledge | Observation)[]; accent: string }) {
  return (
    <div className="rounded-control border border-line p-3">
      <div className="mb-2 flex items-center gap-2">
        <span aria-hidden className={cn("size-2 rounded-full", accent)} />
        <Label className="text-fg-2">{label}</Label>
        <span className="text-small tabular-nums text-fg-4">{items.length}</span>
      </div>
      {items.length ? <Itemized items={items} /> : <p className="text-body text-fg-4">—</p>}
    </div>
  );
}

function Block({ label, children, aside }: { label: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mt-8" aria-label={label}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-body font-semibold text-fg">{label}</h3>
        {aside}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * The head of a card: the customer's task, how they begin, and in a few marks where and how the logged conversation
 * went — how many messages of the customer the card stands on, said in warning when it is one.
 */
export function TaskHead({ card, openings }: { card: Card; openings: (readonly [string, string])[] }) {
  const said = card.style?.messages;
  const marks = [
    card.episode?.channel && CHANNEL[card.episode.channel],
    card.episode?.entry && ENTRY[card.episode.entry],
  ].filter(Boolean) as string[];
  return (
    <div className="mt-6 rounded-sheet bg-inset p-4 sm:p-5">
      <Label>Задача клиента</Label>
      <p className="mt-1 text-lead font-semibold text-fg">
        {card.goal?.task ?? card.name}
        {card.goal?.object && <span className="font-normal text-fg-3"> · {card.goal.object}</span>}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {marks.map((m) => (
          <Tag key={m}>{m}</Tag>
        ))}
        {said !== undefined && (
          <Tag
            tone={said < 2 ? "warn" : "neutral"}
            title={said < 2 ? "Карточка стоит на одном сообщении клиента: остальное в ней — допущения" : undefined}
          >
            в логе {messages(said)} клиента
          </Tag>
        )}
      </div>
      <div className="mt-4 space-y-2">
        {[["Начинает так", card.opening] as const, ...openings].map(([who, text]) => (
          <div key={who} className="flex flex-col items-end gap-1">
            <span className="text-small text-fg-3">{who}</span>
            <span className="max-w-[85%] rounded-xl rounded-br-sm bg-customer px-3 py-2 text-read text-customer-fg">
              {text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** How the customer writes, in marks; said to be by chance when it rests on fewer than MANNER_FROM messages. */
function Manner({ card }: { card: Card }) {
  const s = card.style;
  if (!s || !s.messages) return null;
  const share = (v: number | null, yes: string, no: string) => (v === null ? null : v >= 0.5 ? yes : no);
  const words = Math.round(s.words);
  const marks = [
    `≈${words} ${plural(words, "слово", "слова", "слов")} в сообщении`,
    s.greeting ? "здоровается" : "без приветствия",
    s.polite ? "вежливые слова" : "без вежливых слов",
    share(s.capital, "с заглавной", "со строчной"),
    share(s.endMark, "знак в конце", "без знака в конце"),
  ].filter(Boolean) as string[];
  const thin = s.messages < MANNER_FROM;
  return (
    <Block
      label="Как пишет"
      aside={
        thin && (
          <Tag tone="warn" title="Манеру не узнать по одному-двум сообщениям: эти метки случайны">
            по {s.messages} {s.messages % 10 === 1 && s.messages % 100 !== 11 ? "сообщению" : "сообщениям"} — ненадёжно
          </Tag>
        )
      }
    >
      <div className={cn("flex flex-wrap gap-1.5", thin && "opacity-60")}>
        {marks.map((m) => (
          <span key={m} className="rounded-full bg-well px-2.5 py-1 text-small text-fg-2">
            {m}
          </span>
        ))}
      </div>
    </Block>
  );
}

/**
 * The customer of a scenario as its profile, to be scanned: what they know and when they say it, side by side; what
 * they do not know and their numbers; what trying gives; how they reacted to the agent; how they write. What the log
 * does not establish is folded. Each item shows the log's words on hover.
 */
export function Profile({ card, folds }: { card: Card; folds: ReactNode }) {
  const known = (card.knowledge ?? []).filter((k) => k.access !== "does_not_know");
  const before = (card.observations ?? []).filter((o) => o.when === "before");
  const told = (d: Knowledge["disclose"]) => [
    ...known.filter((k) => k.disclose === d),
    ...before.filter((o) =>
      d === "opening" ? o.disclose === "opening" : d === "when_relevant" && o.disclose !== "opening",
    ),
  ];
  const unknown = (card.knowledge ?? []).filter((k) => k.access === "does_not_know");
  const trying = (card.observations ?? []).filter((o) => o.when === "during");
  const ids = Object.values(card.identifiers ?? {});
  const audit = card.checks?.audit;
  const warnings = [
    ...(audit?.agentWords ?? []).map((w) => `В тексте для клиента фраза агента: «${w}»`),
    ...(audit?.criteriaWords ?? []).map((w) => `В тексте для клиента слова критерия: «${w}»`),
    ...(audit?.goalAhead ?? []).map((w) => `В задаче уже есть то, что клиент сказал позже: ${w}`),
  ];
  return (
    <div>
      {warnings.length > 0 && (
        <div className="mt-6 rounded-control border border-warn/30 bg-warn/5 px-3 py-2">
          {warnings.map((w) => (
            <p key={w} className="text-small text-warn">
              {w}
            </p>
          ))}
        </div>
      )}
      <Block label="Что знает и когда скажет">
        <div className="grid gap-3 md:grid-cols-3">
          <When label="Сразу" items={told("opening")} accent="bg-run" />
          <When label="Когда к месту" items={told("when_relevant")} accent="bg-ok" />
          <When label="Если спросят" items={told("on_request")} accent="bg-fg-4" />
        </div>
        {(unknown.length > 0 || ids.length > 0) && (
          <dl className="mt-4 grid gap-x-6 gap-y-2 text-body sm:grid-cols-[150px_minmax(0,1fr)]">
            {unknown.length > 0 && (
              <>
                <dt className="text-fg-3">Не знает</dt>
                <dd>
                  <Itemized items={unknown} />
                </dd>
              </>
            )}
            {ids.length > 0 && (
              <>
                <dt className="text-fg-3">Номера и реквизиты</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {ids.map((x) => (
                    <Tag
                      key={x.label}
                      tone={x.value === "knows" ? "ok" : "neutral"}
                      title={
                        x.basis === "assumption"
                          ? "Лог этого не показывает: так играет синтетический клиент"
                          : "Из лога"
                      }
                    >
                      {x.label}: {IDENTIFIER[x.value] ?? x.value}
                    </Tag>
                  ))}
                </dd>
              </>
            )}
          </dl>
        )}
      </Block>
      {trying.length > 0 && (
        <Block label="Если попробует">
          <ul className="space-y-1.5">
            {trying.map((o) => (
              <li key={`${o.n}-${o.action}`} title={cited(o)} className="flex items-start gap-2 text-body">
                <span className="text-fg-2">{o.action}</span>
                <ArrowRight aria-hidden className="mt-1 size-3.5 flex-shrink-0 text-fg-4" />
                <span className="text-fg">{o.result}</span>
              </li>
            ))}
          </ul>
        </Block>
      )}
      {!!card.reactions?.length && (
        <Block label="Как реагировал на агента">
          <ul className="space-y-1.5">
            {card.reactions.map((r) => (
              <li
                key={`${r.n}-${r.trigger}`}
                title={`Агент: «${r.agentQuote}» · ${cited(r)}`}
                className="flex flex-wrap items-center gap-1.5 text-body"
              >
                <span className="rounded-full border border-line px-2 py-0.5 text-small text-fg-2">
                  агент: {TRIGGER[r.trigger] ?? r.trigger}
                </span>
                <ArrowRight aria-hidden className="size-3.5 text-fg-4" />
                <span className="text-fg">{r.actions.map((a) => ACTION[a] ?? a).join(", ")}</span>
              </li>
            ))}
          </ul>
        </Block>
      )}
      <Manner card={card} />
      <section className="mt-8 space-y-2 border-t border-line pt-4" aria-label="Подробнее">
        {!!card.notEstablished?.length && (
          <details className="group">
            <summary className={summaryClass}>
              Лог не устанавливает · {card.notEstablished.length}
              <Fold />
            </summary>
            <ul className="mt-2 max-w-[66ch] list-disc space-y-1 pl-5 text-body text-fg-2">
              {card.notEstablished.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </details>
        )}
        {folds}
      </section>
    </div>
  );
}

export const summaryClass =
  "inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-small text-fg-3 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 [&::-webkit-details-marker]:hidden";

/** «›» that turns when its folded block opens. */
export function Fold() {
  return (
    <span aria-hidden className="transition-transform group-open:rotate-90">
      ›
    </span>
  );
}

/**
 * The deck's checks in a line or two: how many texts for the customer copy the agent's words or the criteria, or put in
 * the goal what the customer said later; and how customers answered when the agent asked for an identifier.
 */
export function DeckCheckLine({ checks }: { checks: DeckChecks }) {
  const found = [
    checks.agentWords && `фразы агента — ${checks.agentWords}`,
    checks.criteriaWords && `слова критериев — ${checks.criteriaWords}`,
    checks.goalAhead && `задача забегает вперёд — ${checks.goalAhead}`,
  ].filter(Boolean);
  const answers = Object.entries(checks.identifierAnswers).map(([a, n]) => `${ACTION[a] ?? a} — ${n}`);
  return (
    <div className="text-small">
      <p className={found.length ? "text-warn" : "text-fg-3"}>
        {found.length
          ? `Тексты для клиента: ${found.join(", ")}`
          : "Тексты для клиента без фраз агента и слов критериев"}
      </p>
      {answers.length > 0 && <p className="text-fg-3">Когда агент спрашивал номер: {answers.join(", ")}</p>}
    </div>
  );
}
