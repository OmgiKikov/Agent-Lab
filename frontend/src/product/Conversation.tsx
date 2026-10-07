import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronDown, Database } from "lucide-react";
import { cn } from "@/lib/utils";
import { plural } from "../lab/format";
import type { ToolCall, Turn } from "../lab/types";
import { segments } from "../lab/quote";
import { MarkNo } from "./MarkNo";
import { articleWords, cites, fetchArticle, inWords, isKnowledge, placeQuotes, systemName } from "./steps";
import { visible } from "./text";

export type Mark = { quote: string; n: number };

const secs = (n: number) => `${n.toFixed(1).replace(".", ",")} с`;

const argumentsOf = (call: ToolCall): [string, string][] =>
  call.arguments && typeof call.arguments === "object"
    ? Object.entries(call.arguments as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === "string" ? v : JSON.stringify(v),
      ])
    : [];

/** The article the agent read, as its knowledge base holds it; fetched when the step is opened. */
function ArticleText({ id }: { id: string }) {
  const article = useQuery({
    queryKey: ["article", id],
    queryFn: () => fetchArticle(id),
    staleTime: Infinity,
    retry: false,
  });
  if (article.isLoading) return <p className="text-small text-fg-3">Загружаем статью…</p>;
  if (!article.data) return <p className="text-small text-fg-3">Статьи нет в базе знаний агента на этом компьютере.</p>;
  return (
    <div className="space-y-1.5">
      <p className="text-body font-medium text-fg">{article.data.title}</p>
      <p className="max-h-72 overflow-y-auto whitespace-pre-wrap text-small text-fg-2">{article.data.text}</p>
    </div>
  );
}

/**
 * One step of the agent before its reply: what it searched in its knowledge base and which article it got, or which bank
 * system it called. A step the check cites as evidence carries the criterion's number, like a quote in the reply.
 */
function Step({ call, marks, lit, onLit }: { call: ToolCall; marks: Mark[]; lit?: Lit; onLit?: OnLit }) {
  const [open, setOpen] = useState(false);
  const knowledge = isKnowledge(call);
  const args = argumentsOf(call);
  const openable = knowledge ? !!call.article : args.length > 0;
  const n = marks.find((m) => cites(call, m.quote))?.n;
  const on = n !== undefined && (lit === true || lit === n);
  const Icon = knowledge ? BookOpen : Database;
  const name = (text: string) =>
    n !== undefined ? (
      <mark
        id={`mark-${n}`}
        className={cn(
          "scroll-mt-24 rounded-sm px-0.5 text-fg transition-colors duration-150",
          on ? "bg-mark" : "bg-mark/60",
        )}
      >
        {text}
      </mark>
    ) : (
      <span className="text-fg-2">{text}</span>
    );
  return (
    <li>
      <button
        type="button"
        disabled={!openable}
        aria-expanded={openable ? open : undefined}
        onClick={() => setOpen(!open)}
        onMouseEnter={() => n !== undefined && onLit?.(true, n)}
        onMouseLeave={() => n !== undefined && onLit?.(false, n)}
        className="flex w-full items-start gap-2 rounded-control px-1.5 py-1 text-left text-small text-fg-3 transition-colors enabled:hover:bg-hover"
      >
        <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0">
          {knowledge ? (
            <>
              Искал в базе знаний
              {call.query && <> «{call.query}»</>}
              {call.article && <> → {name(articleWords(call.article))}</>}
            </>
          ) : (
            <>Запросил в системе банка {name(systemName(call))}</>
          )}
          {call.seconds !== undefined && <> · {secs(call.seconds)}</>}
          {n !== undefined && <MarkNo n={n} on={on} className="ml-1 -translate-y-px align-middle" />}
        </span>
        {openable && (
          <ChevronDown
            aria-hidden
            className={cn("ml-auto mt-0.5 size-3.5 shrink-0 transition-transform", open && "rotate-180")}
          />
        )}
      </button>
      {open && (
        <div className="mb-1.5 ml-7 mt-0.5 border-l border-line pl-3">
          {knowledge && call.article ? (
            <ArticleText id={call.article} />
          ) : (
            <dl className="space-y-0.5 text-small">
              {args.map(([key, value]) => (
                <div key={key}>
                  <dt className="inline text-fg-3">{key}: </dt>
                  <dd className="inline break-all text-fg-2">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </li>
  );
}

type Lit = boolean | number | null;
type OnLit = (on: boolean, n?: number) => void;

function AgentTurn({
  turn,
  marks,
  stepMarks,
  lit,
  onLit,
}: {
  turn: Turn;
  marks: Mark[];
  stepMarks: Mark[];
  lit?: Lit;
  onLit?: OnLit;
}) {
  const { text, buttons } = visible(turn.text);
  // An export writes the buttons into the text by their codes; a simulated agent sends them by their words.
  const chips = [...buttons.map((code) => `кнопка${code ? `: ${code}` : ""}`), ...(turn.options ?? [])];
  const pieces = marks.length ? segments(text, marks) : [{ text }];
  const calls = turn.events ?? [];
  return (
    <div className="flex max-w-[88%] flex-col items-start gap-1.5 self-start">
      <span className="px-1 text-small text-fg-3">
        Агент{turn.seconds !== undefined && ` · ответил за ${secs(turn.seconds)}`}
      </span>
      {calls.length > 0 && (
        <ol aria-label="Что агент сделал перед ответом" className="flex w-full flex-col border-l border-line pl-1.5">
          {calls.map((c, i) => (
            <Step key={i} call={c} marks={stepMarks} lit={lit} onLit={onLit} />
          ))}
        </ol>
      )}
      <div className="min-w-0 space-y-2 rounded-2xl rounded-tl-md bg-list px-3.5 py-2.5 shadow-card ring-1 ring-line">
        <p className="whitespace-pre-wrap text-read text-fg">
          {pieces.map((piece, i) =>
            piece.n ? (
              <span key={i}>
                <mark
                  id={`mark-${piece.n}`}
                  onMouseEnter={() => onLit?.(true, piece.n)}
                  onMouseLeave={() => onLit?.(false, piece.n)}
                  className={cn(
                    "scroll-mt-24 rounded-sm px-0.5 text-fg transition-colors duration-150",
                    lit === true || lit === piece.n ? "bg-mark" : "bg-mark/60",
                  )}
                >
                  {piece.text}
                </mark>
                <MarkNo
                  n={piece.n}
                  on={lit === true || lit === piece.n}
                  className="ml-1 -translate-y-px align-middle"
                />
              </span>
            ) : (
              <span key={i}>{piece.text}</span>
            ),
          )}
        </p>
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chips.map((chip, i) => (
              <span
                key={i}
                title="Кнопка, которую агент отправил в чат"
                className="rounded-full border border-line-strong px-2.5 py-0.5 text-small text-fg-3"
              >
                {chip}
              </span>
            ))}
          </div>
        )}
      </div>
      {turn.ok === false && <p className="px-1 text-small text-warn">Передал оператору · статус {turn.status}</p>}
    </div>
  );
}

type Shown = { turn: Turn; again: number };

/** What the customer saw of a turn, for telling a repeat: its words without the export's button codes and the full
 * stop an export sometimes leaves after them, with its buttons. */
const seen = (t: Turn) => {
  const { text, buttons } = visible(t.text);
  return [text.replace(/[\s.]+$/u, ""), ...buttons, ...(t.options ?? [])].join("\u0000");
};

/**
 * The same question with the same answer, again and again in a row — an export often writes them so, or the customer
 * repeated and the agent answered alike: shown once, with how many times more (`again`). Nothing is dropped from the
 * conversation the judge read; a reply with steps of the agent is never folded.
 */
function folded(turns: Turn[]): Shown[] {
  const out: Shown[] = [];
  let i = 0;
  while (i < turns.length) {
    const asked = turns[i];
    const answered = turns[i + 1];
    if (asked.role !== "customer" || answered?.role !== "agent" || answered.events?.length) {
      out.push({ turn: asked, again: 0 });
      i += 1;
      continue;
    }
    let next = i + 2;
    while (
      turns[next]?.role === "customer" &&
      seen(turns[next]) === seen(asked) &&
      turns[next + 1]?.role === "agent" &&
      seen(turns[next + 1]) === seen(answered) &&
      !turns[next + 1].events?.length
    )
      next += 2;
    out.push({ turn: asked, again: 0 }, { turn: answered, again: (next - i) / 2 - 1 });
    i = next;
  }
  return out;
}

/**
 * A conversation as the chat looked: the customer's bubbles on the right, the agent's on the left with the judge's quote
 * marked in yellow and numbered. Turns long before the mark fold into «ещё N реплик выше»; an exchange repeated word for
 * word in a row is shown once, saying how many times more it came.
 */
export function Conversation({
  turns,
  marks = [],
  lit,
  onLit,
}: {
  turns: Turn[];
  marks?: Mark[];
  lit?: Lit;
  onLit?: OnLit;
}) {
  // A quote of the agent's words is marked in the reply; a quote of a tool call, on the step it names.
  const placed = placeQuotes(turns, marks);
  const shown = (t: Turn) =>
    placed.words.some((m) => inWords(t, m.quote)) ||
    (t.role === "agent" && (t.events ?? []).some((c) => placed.steps.some((m) => cites(c, m.quote))));
  const items = folded(turns);
  const at = marks.length ? items.findIndex((item) => shown(item.turn)) : -1;
  const [open, setOpen] = useState(false);
  const from = at > 2 && !open ? at - 1 : 0;
  return (
    <div className="flex flex-col gap-4">
      {from > 0 && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="self-center rounded-full border border-line bg-list px-3 py-1 text-small text-fg-3 shadow-card transition-colors hover:text-fg"
        >
          ещё {from}
          {"\u00a0"}
          {plural(from, "реплика", "реплики", "реплик")} выше
        </button>
      )}
      {items.slice(from).map(({ turn: t, again }, i) =>
        t.role === "customer" ? (
          <div key={i + from} className="flex max-w-[80%] flex-col items-end gap-1.5 self-end">
            <span className="px-1 text-small text-fg-3">Клиент</span>
            <div className="whitespace-pre-wrap rounded-2xl rounded-tr-md bg-customer px-3.5 py-2.5 text-read text-customer-fg">
              {t.text}
            </div>
          </div>
        ) : (
          <div key={i + from} className="flex flex-col gap-2">
            <AgentTurn turn={t} marks={placed.words} stepMarks={placed.steps} lit={lit} onLit={onLit} />
            {again > 0 && (
              <p className="self-center rounded-full border border-dashed border-line-strong px-3 py-1 text-small text-fg-3">
                Этот вопрос и ответ повторились ещё {again}
                {"\u00a0"}
                {plural(again, "раз", "раза", "раз")} подряд — так в выгрузке
              </p>
            )}
          </div>
        ),
      )}
    </div>
  );
}
