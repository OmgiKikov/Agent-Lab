import { useState } from "react";
import { ChevronDown, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { plural } from "../lab/format";
import { segments, splitQuote } from "./highlight";
import { VerdictChip } from "./VerdictChip";

export type ToolCall = { tool: string; article?: string; query?: string; arguments?: unknown; seconds?: number };
export type Turn = { role: "customer" | "agent"; text: string; events?: ToolCall[]; ok?: boolean; status?: string; seconds?: number };

/** A chat button the agent sent, written into the logged text as «` ` ` transition-code CODE ` ` `». */
const CONTROL = /`\s*`\s*`\s*transition-code\s*([A-Za-z0-9_-]*)\s*`\s*`\s*`/g;

/** The words the customer saw, and the buttons the agent sent with them. */
export function visible(text: string): { text: string; buttons: string[] } {
  const buttons: string[] = [];
  const clean = text.replace(CONTROL, (_, code: string) => { buttons.push(code); return ""; }).trim();
  return { text: clean, buttons };
}
export type Mark = { quote: string; n: number; label?: string };

/** The number that ties the judge's quote in the conversation to its explanation. */
export function MarkNumber({ n, active, onActive }: { n: number; active?: boolean; onActive?: (n: number | null, pin?: boolean) => void }) {
  const look = cn("inline-flex size-[22px] flex-shrink-0 items-center justify-center rounded-full border border-lab-mark/[0.44] bg-[rgb(60,44,32)] text-meta font-semibold text-[rgb(255,212,163)] transition-shadow", active && "ring-2 ring-lab-mark/40");
  return onActive
    ? <button type="button" aria-label={`Нарушение ${n}`} onMouseEnter={() => onActive(n)} onMouseLeave={() => onActive(null)} onClick={() => onActive(n, true)} className={look}>{n}</button>
    : <span className={look}>{n}</span>;
}

const secs = (n: number) => `${n.toFixed(1).replace(".", ",")} с`;

/** One tool call folded to a row «имя · время ⌄»; opened, it shows what was asked and what was read. */
function ToolRow({ call, seconds }: { call: ToolCall; seconds?: number }) {
  const name = call.tool.replace("Система банка · ", "");
  const args = call.arguments && typeof call.arguments === "object" && Object.keys(call.arguments as object).length ? JSON.stringify(call.arguments) : null;
  const detail = call.query || call.article || args;
  return (
    <details className="group w-full max-w-[560px]">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1 py-0.5 text-meta text-lab-dim transition-colors hover:text-lab-text [&::-webkit-details-marker]:hidden">
        <Wrench aria-hidden className="size-3.5 flex-shrink-0" />
        <span className="text-small font-medium text-lab-soft">{name}</span>
        {(call.seconds ?? seconds) !== undefined && <span title={call.seconds === undefined ? "Время всего ответа агента: время каждого вызова отдельно не записано" : undefined}>· {secs((call.seconds ?? seconds)!)}</span>}
        {detail && <ChevronDown aria-hidden className="size-3.5 transition-transform group-open:rotate-180" />}
      </summary>
      {detail && (
        <dl className="ml-[26px] mt-1 space-y-0.5 border-l border-white/[0.08] pl-3 text-meta text-lab-dim">
          {call.query && <div><dt className="inline">Запрос: </dt><dd className="inline text-lab-mute">{call.query}</dd></div>}
          {call.article && <div><dt className="inline">Статья: </dt><dd className="inline break-all font-mono text-lab-mute">{call.article}</dd></div>}
          {args && <div><dt className="inline">Аргументы: </dt><dd className="inline break-all font-mono text-lab-mute">{args}</dd></div>}
        </dl>
      )}
    </details>
  );
}

/** The agent's calls before this reply. Per-call time is shown when recorded; otherwise the reply's time stands on the first row. */
function ToolRows({ calls, seconds }: { calls: ToolCall[]; seconds?: number }) {
  return (
    <div className="flex w-full flex-col">
      {calls.map((c, i) => <ToolRow key={i} call={c} seconds={i === 0 && !calls.some(x => x.seconds !== undefined) ? seconds : undefined} />)}
    </div>
  );
}

function AgentTurn({ turn, marks, hover, onHover, active, onActive }: { turn: Turn; marks: Mark[]; hover?: boolean; onHover?: (on: boolean) => void; active?: number | null; onActive?: (n: number | null, pin?: boolean) => void }) {
  const { text, buttons } = visible(turn.text);
  const pieces = marks.length ? segments(text, marks) : [{ text }];
  const calls = turn.events ?? [];
  return (
    <div className="flex max-w-[92%] flex-col items-start gap-1.5 self-start">
      <div className="whitespace-pre-wrap text-read text-lab-text">
        {pieces.map((piece, i) => (piece.n ? (
          <span key={i} id={onActive ? `mark-${piece.n}` : undefined}>
            <mark
              onMouseEnter={() => { onHover?.(true); onActive?.(piece.n!); }} onMouseLeave={() => { onHover?.(false); onActive?.(null); }}
              className={cn("rounded-sm px-0.5 py-px text-lab-ink transition-colors", hover || active === piece.n ? "bg-lab-mark/[0.34]" : "bg-lab-mark/[0.17]")}
            >
              {piece.text}
            </mark>
            <span className="ml-1 inline-block translate-y-[-1px] align-middle"><MarkNumber n={piece.n} active={active === piece.n} onActive={onActive} /></span>
          </span>
        ) : <span key={i}>{piece.text}</span>))}
      </div>
      {pieces.some(p => p.n) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {marks.filter(m => m.label && pieces.some(p => p.n === m.n)).map(m => (
            <span key={m.n} className="flex min-w-0 items-center gap-1.5" onMouseEnter={() => onActive?.(m.n)} onMouseLeave={() => onActive?.(null)}>
              <MarkNumber n={m.n} active={active === m.n} onActive={onActive} /><VerdictChip label={m.label!} status="FAIL" />
            </span>
          ))}
        </div>
      )}
      {buttons.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {buttons.map((code, i) => (
            <span key={i} className="rounded-full border border-white/15 px-2.5 py-0.5 text-micro text-lab-mute" title="Кнопка, которую агент отправил в чат">
              кнопка{code ? `: ${code}` : ""}
            </span>
          ))}
        </div>
      )}
      {calls.length > 0 && <ToolRows calls={calls} seconds={turn.seconds} />}
      {turn.ok === false && <span className="text-meta text-lab-warn">Передал оператору · статус {turn.status}</span>}
    </div>
  );
}

/**
 * A conversation as a chat: the customer's teal bubble on the right, the agent's words on the left,
 * the judge's quote marked in the agent's words with its number. Turns long before the mark fold away.
 */
export function Conversation({ turns, mark, marks, hover, onHover, active, onActive }: {
  turns: Turn[]; mark?: Mark; marks?: Mark[]; hover?: boolean; onHover?: (on: boolean) => void;
  active?: number | null; onActive?: (n: number | null, pin?: boolean) => void;
}) {
  const all = marks ?? (mark ? [mark] : []);
  const at = all.length ? turns.findIndex(t => t.role === "agent" && all.some(m => splitQuote(visible(t.text).text, m.quote))) : -1;
  const [open, setOpen] = useState(false);
  const from = at > 2 && !open ? at - 1 : 0;
  return (
    <div className="flex flex-col gap-3">
      {from > 0 && (
        <button type="button" onClick={() => setOpen(true)} className="self-center rounded-full border border-white/[0.08] px-3 py-1 text-meta text-lab-dim transition-colors hover:text-lab-text">
          ещё {from} {plural(from, "реплика", "реплики", "реплик")} выше
        </button>
      )}
      {turns.slice(from).map((t, i) => {
        const index = i + from;
        return t.role === "customer"
          ? <div key={index} className="max-w-[85%] self-end whitespace-pre-wrap rounded-[10px] border border-[rgb(75_180_200/0.11)] bg-lab-user px-[11px] py-2 text-read text-[rgb(212,224,230)]">{t.text}</div>
          : <AgentTurn key={index} turn={t} marks={all} hover={hover} onHover={onHover} active={active} onActive={onActive} />;
      })}
    </div>
  );
}
