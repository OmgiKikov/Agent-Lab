import { useState } from "react";
import { ChevronDown, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { plural } from "../lab/format";
import { visible, type ToolCall, type Turn } from "../ui/Conversation";
import { segments, splitQuote } from "../ui/highlight";
import { Caps } from "../ui/Caps";
import { MarkNo } from "./MarkNo";

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
    <div className="flex gap-3">
      <Caps className="hidden w-14 flex-shrink-0 pt-1 text-fg-4 sm:block">Агент</Caps>
      <div className="min-w-0 max-w-[62ch] flex-1 space-y-2">
        {calls.length > 0 && <div className="-ml-1.5 flex flex-col items-start">{calls.map((c, i) => <ToolRow key={i} call={c} seconds={i === 0 && !calls.some(x => x.seconds !== undefined) ? turn.seconds : undefined} />)}</div>}
        <p className="whitespace-pre-wrap text-read text-fg">
          {pieces.map((piece, i) => (piece.n ? (
            <span key={i}>
              <mark
                id={`mark-${piece.n}`} onMouseEnter={() => onLit?.(true, piece.n)} onMouseLeave={() => onLit?.(false, piece.n)}
                className={cn("scroll-mt-24 rounded-sm border-b-2 border-warn px-px text-fg transition-colors duration-150", lit === true || lit === piece.n ? "bg-warn/35" : "bg-warn/20")}
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
        {turn.ok === false && <p className="text-meta text-warn">Передал оператору · статус {turn.status}</p>}
      </div>
    </div>
  );
}

/**
 * A conversation as a chat: the customer's bubble on the right, the agent's words on the left with the judge's quote
 * marked and numbered. Turns long before the mark fold into «ещё N реплик выше».
 */
export function Conversation({ turns, marks = [], lit, onLit }: { turns: Turn[]; marks?: Mark[]; lit?: Lit; onLit?: (on: boolean, n?: number) => void }) {
  const at = marks.length ? turns.findIndex(t => t.role === "agent" && marks.some(m => splitQuote(visible(t.text).text, m.quote))) : -1;
  const [open, setOpen] = useState(false);
  const from = at > 2 && !open ? at - 1 : 0;
  return (
    <div className="flex flex-col gap-3">
      {from > 0 && (
        <button type="button" onClick={() => setOpen(true)} className="border-b border-dashed border-line pb-2.5 text-center text-meta text-fg-4 transition-colors hover:text-fg-2">
          ещё {from} {plural(from, "реплика", "реплики", "реплик")} выше
        </button>
      )}
      {turns.slice(from).map((t, i) => (t.role === "customer"
        ? <div key={i + from} className="max-w-[78%] self-end whitespace-pre-wrap rounded-xl rounded-br-sm bg-customer px-3 py-2 text-read text-customer-fg">{t.text}</div>
        : <AgentTurn key={i + from} turn={t} marks={marks} lit={lit} onLit={onLit} />))}
    </div>
  );
}
