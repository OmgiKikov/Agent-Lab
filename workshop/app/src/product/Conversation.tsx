import { useState } from "react";
import { ChevronDown, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { plural } from "../lab/format";
import type { ToolCall, Turn } from "../lab/types";
import { segments, splitQuote } from "../lab/quote";
import { MarkNo } from "./MarkNo";
import { visible } from "./text";

export type Mark = { quote: string; n: number };

const secs = (n: number) => `${n.toFixed(1).replace(".", ",")} с`;

/** A tool call folded to a row «имя · время»; opened, what was asked and what was read. */
function ToolRow({ call, seconds }: { call: ToolCall; seconds?: number }) {
  const name = call.tool.replace("Система банка · ", "");
  const args = call.arguments && typeof call.arguments === "object" && Object.keys(call.arguments as object).length ? JSON.stringify(call.arguments) : null;
  const detail = call.query || call.article || args;
  const time = call.seconds ?? seconds;
  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-control px-1.5 py-0.5 text-meta text-fg-3 transition-colors hover:bg-hover hover:text-fg-2 [&::-webkit-details-marker]:hidden">
        <Wrench aria-hidden className="size-3.5" />
        <span className="font-mono text-fg-2">{name}</span>
        {time !== undefined && <span>· {secs(time)}</span>}
        {detail && <ChevronDown aria-hidden className="size-3.5 transition-transform group-open:rotate-180" />}
      </summary>
      {detail && (
        <dl className="ml-6 mt-1 space-y-0.5 border-l border-line pl-3 text-meta text-fg-3">
          {call.query && <div><dt className="inline">Запрос: </dt><dd className="inline text-fg-2">{call.query}</dd></div>}
          {call.article && <div><dt className="inline">Статья: </dt><dd className="inline break-all font-mono text-fg-2">{call.article}</dd></div>}
          {args && <div><dt className="inline">Аргументы: </dt><dd className="inline break-all font-mono text-fg-2">{args}</dd></div>}
        </dl>
      )}
    </details>
  );
}

type Lit = boolean | number | null;

function AgentTurn({ turn, marks, lit, onLit }: { turn: Turn; marks: Mark[]; lit?: Lit; onLit?: (on: boolean, n?: number) => void }) {
  const { text, buttons } = visible(turn.text);
  const pieces = marks.length ? segments(text, marks) : [{ text }];
  const calls = turn.events ?? [];
  return (
    <div className="flex max-w-[88%] flex-col items-start gap-1.5 self-start">
      <span className="px-1 text-meta text-fg-3">Агент</span>
      {calls.length > 0 && <div className="flex flex-col items-start">{calls.map((c, i) => <ToolRow key={i} call={c} seconds={i === 0 && !calls.some(x => x.seconds !== undefined) ? turn.seconds : undefined} />)}</div>}
      <div className="min-w-0 space-y-2 rounded-2xl rounded-tl-md bg-list px-3.5 py-2.5 shadow-card ring-1 ring-line">
        <p className="whitespace-pre-wrap text-read text-fg">
          {pieces.map((piece, i) => (piece.n ? (
            <span key={i}>
              <mark
                id={`mark-${piece.n}`} onMouseEnter={() => onLit?.(true, piece.n)} onMouseLeave={() => onLit?.(false, piece.n)}
                className={cn("scroll-mt-24 rounded-sm px-0.5 text-fg transition-colors duration-150", lit === true || lit === piece.n ? "bg-mark" : "bg-mark/60")}
              >
                {piece.text}
              </mark>
              <MarkNo n={piece.n} on={lit === true || lit === piece.n} className="ml-1 -translate-y-px align-middle" />
            </span>
          ) : <span key={i}>{piece.text}</span>))}
        </p>
        {buttons.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {buttons.map((code, i) => <span key={i} title="Кнопка, которую агент отправил в чат" className="rounded-full border border-line-strong px-2.5 py-0.5 text-meta text-fg-3">кнопка{code ? `: ${code}` : ""}</span>)}
          </div>
        )}
      </div>
      {turn.ok === false && <p className="px-1 text-meta text-warn">Передал оператору · статус {turn.status}</p>}
    </div>
  );
}

/**
 * A conversation as the chat looked: the customer's bubbles on the right, the agent's on the left with the judge's quote
 * marked in yellow and numbered. Turns long before the mark fold into «ещё N реплик выше».
 */
export function Conversation({ turns, marks = [], lit, onLit }: { turns: Turn[]; marks?: Mark[]; lit?: Lit; onLit?: (on: boolean, n?: number) => void }) {
  const at = marks.length ? turns.findIndex(t => t.role === "agent" && marks.some(m => splitQuote(visible(t.text).text, m.quote))) : -1;
  const [open, setOpen] = useState(false);
  const from = at > 2 && !open ? at - 1 : 0;
  return (
    <div className="flex flex-col gap-4">
      {from > 0 && (
        <button type="button" onClick={() => setOpen(true)} className="self-center rounded-full border border-line bg-list px-3 py-1 text-meta text-fg-3 shadow-card transition-colors hover:text-fg">
          ещё {from} {plural(from, "реплика", "реплики", "реплик")} выше
        </button>
      )}
      {turns.slice(from).map((t, i) => (t.role === "customer"
        ? (
          <div key={i + from} className="flex max-w-[80%] flex-col items-end gap-1.5 self-end">
            <span className="px-1 text-meta text-fg-3">Клиент</span>
            <div className="whitespace-pre-wrap rounded-2xl rounded-tr-md bg-customer px-3.5 py-2.5 text-read text-customer-fg">{t.text}</div>
          </div>
        )
        : <AgentTurn key={i + from} turn={t} marks={marks} lit={lit} onLit={onLit} />))}
    </div>
  );
}
