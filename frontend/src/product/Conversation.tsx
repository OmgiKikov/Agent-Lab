import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronDown, Database } from "lucide-react";
import { cn } from "@/lib/utils";
import { masked, MASKS } from "../lab/dialogs";
import { count, plural } from "../lab/format";
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
  named,
  marks,
  stepMarks,
  lit,
  onLit,
}: {
  turn: Turn;
  /** The first reply of the agent says who it is; the next ones are known by their side. */
  named: boolean;
  marks: Mark[];
  stepMarks: Mark[];
  lit?: Lit;
  onLit?: OnLit;
}) {
  const { text, buttons } = visible(turn.text);
  // The buttons the client saw under the reply: a simulated agent sends them by their words; an export keeps only their
  // codes, which say something to the agent's developers alone (sections/dialogs/Dialog, «Для разработчика»).
  const options = turn.options ?? [];
  const sent = buttons.length + options.length;
  const pieces = marks.length ? segments(text, marks) : [{ text }];
  const calls = turn.events ?? [];
  const said = [named && "Агент", turn.seconds !== undefined && `ответил за ${secs(turn.seconds)}`].filter(Boolean);
  return (
    <div className="flex max-w-[88%] flex-col items-start gap-1.5 self-start">
      {said.length > 0 && <span className="px-1 text-small text-fg-3">{said.join(" · ")}</span>}
      {calls.length > 0 && (
        <ol aria-label="Что агент сделал перед ответом" className="flex w-full flex-col border-l border-line pl-1.5">
          {calls.map((c, i) => (
            <Step key={i} call={c} marks={stepMarks} lit={lit} onLit={onLit} />
          ))}
        </ol>
      )}
      <div className="min-w-0 rounded-2xl rounded-tl-md bg-list px-3.5 py-2.5 ring-1 ring-line">
        <p className="whitespace-pre-wrap text-read text-fg">
          {!named && <span className="sr-only">Агент: </span>}
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
      </div>
      {sent > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pl-1 text-small text-fg-3">
          <span>
            {sent === 1 ? "Агент отправил кнопку" : `Агент отправил ${count(sent, "кнопку", "кнопки", "кнопок")}`}
            {options.length > 0 && ":"}
          </span>
          {options.map((option, i) => (
            <span key={i} className="rounded-full bg-list px-3 py-1 text-fg-2 ring-1 ring-line-strong">
              {option}
            </span>
          ))}
        </div>
      )}
      {turn.ok === false && <p className="px-1 text-small text-warn">Передал оператору · статус {turn.status}</p>}
    </div>
  );
}

/**
 * A conversation as the chat looked: the customer's bubbles on the right, the agent's on the left with the judge's quote
 * marked in yellow and numbered. Turns long before the mark fold into «ещё N реплик выше». When the export masked the
 * client's data, one quiet line above says what the marks stand for.
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
  const at = marks.length ? turns.findIndex(shown) : -1;
  const [open, setOpen] = useState(false);
  const from = at > 2 && !open ? at - 1 : 0;
  // Who speaks is said once for each side, at its first turn shown; then the side and the colour say it.
  const firstCustomer = turns.findIndex((t, i) => i >= from && t.role === "customer");
  const firstAgent = turns.findIndex((t, i) => i >= from && t.role !== "customer");
  return (
    <div className="flex flex-col gap-4">
      {masked(turns) && <p className="text-small text-fg-3">{MASKS}</p>}
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
      {turns.slice(from).map((t, i) =>
        t.role === "customer" ? (
          <div key={i + from} className="flex max-w-[80%] flex-col items-end gap-1.5 self-end">
            {i + from === firstCustomer && <span className="px-1 text-small text-fg-3">Клиент</span>}
            <div className="whitespace-pre-wrap rounded-2xl rounded-tr-md bg-customer px-3.5 py-2.5 text-read text-customer-fg">
              {i + from !== firstCustomer && <span className="sr-only">Клиент: </span>}
              {t.text}
            </div>
          </div>
        ) : (
          <AgentTurn
            key={i + from}
            turn={t}
            named={i + from === firstAgent}
            marks={placed.words}
            stepMarks={placed.steps}
            lit={lit}
            onLit={onLit}
          />
        ),
      )}
    </div>
  );
}
