import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { plural } from "../../lab/format";
import type { Card, Knowledge } from "../../lab/types";
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
const IDENTIFIER: Record<string, string> = {
  knows: "знает",
  unknown: "не знает",
  looks_up: "посмотрит, если спросят",
};
/** When the customer says a fact: a word and a dot each, in the order a conversation reaches them. */
const WHEN: Record<Knowledge["disclose"], { word: string; dot: string; order: number }> = {
  opening: { word: "сразу", dot: "bg-run", order: 0 },
  when_relevant: { word: "по ходу", dot: "bg-ok", order: 1 },
  on_request: { word: "если спросят", dot: "bg-fg-4", order: 2 },
};
/** Fewer customer messages than this tell a manner by chance: one message is no habit. */
const MANNER_FROM = 3;

/** Where an item stands in the log: a hover shows the customer's words it rests on. */
const cited = (x: { n: number; quote: string }) => `Реплика ${x.n}: «${x.quote}»`;
const messages = (n: number) => `${n} ${plural(n, "сообщение", "сообщения", "сообщений")}`;

/** When a fact is said, as a quiet mark after it. */
function When({ disclose }: { disclose: Knowledge["disclose"] }) {
  const w = WHEN[disclose];
  return (
    <span className="ml-1.5 inline-flex items-center gap-1 whitespace-nowrap text-small text-fg-3">
      <span aria-hidden className={cn("size-1.5 rounded-full", w.dot)} />
      {w.word}
    </span>
  );
}

/** One line of the profile: what it is about, and its items; a line with nothing to say is not drawn. */
function Row({ label, children, aside }: { label: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-1 border-t border-line py-3 first:border-t-0 sm:grid-cols-[120px_minmax(0,1fr)]">
      <dt className="pt-px text-body text-fg-3">
        {label}
        {aside && <div className="mt-1">{aside}</div>}
      </dt>
      <dd className="min-w-0 text-body text-fg">{children}</dd>
    </div>
  );
}

function Lines({ children }: { children: ReactNode }) {
  return <ul className="space-y-1.5">{children}</ul>;
}

/**
 * The head of a card: the customer's task, how they begin, and in a mark or two where the logged conversation went
 * and how many messages of the customer the card stands on, said in warning when it is one.
 */
export function TaskHead({ card, openings }: { card: Card; openings: (readonly [string, string])[] }) {
  const said = card.style?.messages;
  const channel = card.episode?.channel ? CHANNEL[card.episode.channel] : undefined;
  return (
    <div className="mt-6 rounded-sheet bg-inset p-4 sm:p-5">
      <Label>Задача клиента</Label>
      <p className="mt-1 text-lead font-semibold text-fg">
        {card.goal?.task ?? card.name}
        {card.goal?.object && <span className="font-normal text-fg-3"> · {card.goal.object}</span>}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {channel && <Tag>{channel}</Tag>}
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

/** How the customer writes, as marks in a line; said to be by chance when it rests on fewer than MANNER_FROM messages. */
function manner(card: Card): { marks: string[]; thin: boolean } | null {
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
  return { marks, thin: s.messages < MANNER_FROM };
}

/**
 * The customer of a scenario as a short profile, one line per kind of thing the log shows and only the lines it shows:
 * what they know (each fact with when they say it), what they already tried, what they do not know, what trying gives,
 * their numbers, how they met the agent, how they write. What the log does not establish is folded with the rest.
 */
export function Profile({ card, folds }: { card: Card; folds: ReactNode }) {
  const known = (card.knowledge ?? [])
    .filter((k) => k.access !== "does_not_know")
    .sort((a, b) => WHEN[a.disclose].order - WHEN[b.disclose].order);
  const tried = (card.observations ?? []).filter((o) => o.when === "before");
  const unknown = (card.knowledge ?? []).filter((k) => k.access === "does_not_know");
  const trying = (card.observations ?? []).filter((o) => o.when === "during");
  // Identifiers with the same answer in one phrase: «номер терминала, ИНН — посмотрит, если спросят».
  const ids = new Map<string, string[]>();
  for (const x of Object.values(card.identifiers ?? {})) ids.set(x.value, [...(ids.get(x.value) ?? []), x.label]);
  const writes = manner(card);
  return (
    <div>
      <dl className="mt-6 rounded-sheet border border-line px-4 py-1">
        {known.length > 0 && (
          <Row label="Знает">
            <Lines>
              {known.map((k) => (
                <li key={`${k.n}-${k.text}`} title={cited(k)}>
                  {k.text}
                  {k.access === "believes" && <span className="text-fg-3"> · так считает</span>}
                  <When disclose={k.disclose} />
                </li>
              ))}
            </Lines>
          </Row>
        )}
        {tried.length > 0 && (
          <Row label="Уже пробовал">
            <Lines>
              {tried.map((o) => (
                <li key={`${o.n}-${o.action}`} title={cited(o)}>
                  {o.action} — {o.result}
                  <When disclose={o.disclose} />
                </li>
              ))}
            </Lines>
          </Row>
        )}
        {unknown.length > 0 && (
          <Row label="Не знает">
            <Lines>
              {unknown.map((k) => (
                <li key={`${k.n}-${k.text}`} title={cited(k)}>
                  {k.text}
                </li>
              ))}
            </Lines>
          </Row>
        )}
        {trying.length > 0 && (
          <Row label="Если попробует">
            <Lines>
              {trying.map((o) => (
                <li key={`${o.n}-${o.action}`} title={cited(o)} className="flex flex-wrap items-center gap-x-2">
                  <span className="text-fg-2">{o.action}</span>
                  <ArrowRight aria-hidden className="size-3.5 text-fg-4" />
                  <span>{o.result}</span>
                </li>
              ))}
            </Lines>
          </Row>
        )}
        {ids.size > 0 && (
          <Row label="Номера">
            <Lines>
              {[...ids].map(([value, labels]) => (
                <li key={value}>
                  {labels.join(", ")} <span className="text-fg-3">— {IDENTIFIER[value] ?? value}</span>
                </li>
              ))}
            </Lines>
          </Row>
        )}
        {!!card.reactions?.length && (
          <Row label="На агента">
            <Lines>
              {card.reactions.map((r) => (
                <li
                  key={`${r.n}-${r.trigger}`}
                  title={`Агент: «${r.agentQuote}» · ${cited(r)}`}
                  className="flex flex-wrap items-center gap-x-2"
                >
                  <span className="text-fg-3">{TRIGGER[r.trigger] ?? r.trigger}</span>
                  <ArrowRight aria-hidden className="size-3.5 text-fg-4" />
                  <span>{r.actions.map((a) => ACTION[a] ?? a).join(", ")}</span>
                </li>
              ))}
            </Lines>
          </Row>
        )}
        {writes && (
          <Row
            label="Пишет"
            aside={
              writes.thin && (
                <Tag tone="warn" title="Манеру не узнать по одному-двум сообщениям: эти метки случайны">
                  ненадёжно
                </Tag>
              )
            }
          >
            <p className={cn("text-fg-2", writes.thin && "text-fg-3")}>{writes.marks.join(" · ")}</p>
          </Row>
        )}
      </dl>
      <section className="mt-6 space-y-2" aria-label="Подробнее">
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

type BriefPart =
  | { kind: "line"; label?: string; note?: string; text: string }
  | { kind: "list"; title: string; note?: string; items: string[] };

/** «Заголовок (пояснение)» as the title and its note. */
const titled = (head: string) => {
  const found = head.match(/^(.*?)\s*\((.*)\)$/);
  return found ? { title: found[1], note: found[2] } : { title: head, note: undefined };
};

/**
 * The text the synthetic customer reads (cards.brief) in its parts: a block is a line ending with «:» and its «- »
 * items; a line «Название: текст» is a labelled line; the rest are sentences.
 */
export function briefParts(text: string): BriefPart[] {
  const parts: BriefPart[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const last = parts[parts.length - 1];
    if (line.startsWith("- ")) {
      if (last?.kind === "list") last.items.push(line.slice(2));
      else parts.push({ kind: "list", title: "", items: [line.slice(2)] });
    } else if (line.endsWith(":")) {
      parts.push({ kind: "list", ...titled(line.slice(0, -1)), items: [] });
    } else {
      const found = line.match(/^([^:.«»]{2,70}?):\s+(.+)$/);
      if (found) {
        const { title, note } = titled(found[1]);
        parts.push({ kind: "line", label: title, note, text: found[2] });
      } else parts.push({ kind: "line", text: line });
    }
  }
  return parts;
}

/** «Условие: текст» with the condition quiet, so what the customer does stands out; any other text as it is. */
function Said({ text }: { text: string }) {
  const found = text.match(/^([^:«»]{2,60}?):\s+(.+)$/);
  if (!found) return <>{text}</>;
  return (
    <>
      <span className="text-fg-3">{found[1]}:</span> {found[2]}
    </>
  );
}

/** A labelled line's sentences one under another: «задача. Речь о: …. Готово, когда …» reads as three lines. */
const sentences = (text: string) => text.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z])/);

/**
 * The text the synthetic customer reads, laid out to be read: its sentences, its labelled lines, each block a titled
 * list; the manner as marks. The words are the text's own: what the model reads is what the person sees.
 */
export function Brief({ text }: { text: string }) {
  return (
    <div className="mt-3 space-y-4 rounded-sheet border border-line bg-canvas p-4 sm:p-5">
      {briefParts(text).map((part, i) =>
        part.kind === "list" ? (
          <div key={i}>
            {part.title && (
              <p className="text-small font-medium text-fg-2">
                {part.title}
                {part.note && <span className="font-normal text-fg-4"> · {part.note}</span>}
              </p>
            )}
            <ul className="mt-1.5 space-y-1">
              {part.items.map((item) => (
                <li key={item} className="flex gap-2 text-body text-fg">
                  <span aria-hidden className="mt-[9px] size-1 flex-shrink-0 rounded-full bg-fg-4" />
                  <span>
                    <Said text={item} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : part.label === "Как ты пишешь" ? (
          <div key={i}>
            <p className="text-small font-medium text-fg-2">{part.label}</p>
            <p className="mt-1.5 flex flex-wrap gap-1.5">
              {part.text
                .replace(/\.$/, "")
                .split("; ")
                .map((mark) => (
                  <span key={mark} className="rounded-full bg-well px-2.5 py-0.5 text-small text-fg-2">
                    {mark}
                  </span>
                ))}
            </p>
          </div>
        ) : part.label ? (
          <div key={i}>
            <p className="text-small font-medium text-fg-2">
              {part.label}
              {part.note && <span className="font-normal text-fg-4"> · {part.note}</span>}
            </p>
            <div className="mt-1 space-y-0.5 text-body text-fg">
              {sentences(part.text).map((sentence) => (
                <p key={sentence}>
                  <Said text={sentence} />
                </p>
              ))}
            </div>
          </div>
        ) : (
          <p key={i} className="text-body text-fg-2">
            {part.text}
          </p>
        ),
      )}
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
