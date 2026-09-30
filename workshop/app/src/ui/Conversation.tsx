import { useState } from "react";
import { cn } from "@/lib/utils";
import { plural } from "../lab/format";
import { segments, splitQuote } from "./highlight";

export type Turn = { role: "customer" | "agent"; text: string; events?: { tool: string }[]; ok?: boolean; status?: string };

/** A chat button the agent sent, written into the logged text as «` ` ` transition-code CODE ` ` `». */
const CONTROL = /`\s*`\s*`\s*transition-code\s*([A-Za-z0-9_-]*)\s*`\s*`\s*`/g;

/** The words the customer saw, and the buttons the agent sent with them. */
export function visible(text: string): { text: string; buttons: string[] } {
  const buttons: string[] = [];
  const clean = text.replace(CONTROL, (_, code: string) => { buttons.push(code); return ""; }).trim();
  return { text: clean, buttons };
}
export type Mark = { quote: string; n: number };

/** The number that ties the judge's quote in the conversation to its explanation. */
export function MarkNumber({ n }: { n: number }) {
  return <span className="inline-flex size-4 flex-shrink-0 items-center justify-center rounded-full bg-lab-mark font-mono text-micro font-medium text-black">{n}</span>;
}

function AgentTurn({ turn, marks, hover, onHover }: { turn: Turn; marks: Mark[]; hover?: boolean; onHover?: (on: boolean) => void }) {
  const { text, buttons } = visible(turn.text);
  const pieces = marks.length ? segments(text, marks) : [{ text }];
  const tools = [...new Set((turn.events ?? []).map(e => e.tool.replace("Система банка · ", "")))];
  return (
    <div className="flex max-w-[92%] flex-col items-start gap-1.5 self-start">
      <div className="whitespace-pre-wrap text-read text-lab-text">
        {pieces.map((piece, i) => (piece.n ? (
          <span key={i}>
            <mark
              onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)}
              className={cn("rounded-sm border-b-2 border-lab-mark px-0.5 text-lab-ink transition-colors", hover ? "bg-lab-mark/[0.34]" : "bg-lab-mark/[0.18]")}
            >
              {piece.text}
            </mark>
            <span className="ml-1 inline-block translate-y-[-1px] align-middle"><MarkNumber n={piece.n} /></span>
          </span>
        ) : <span key={i}>{piece.text}</span>))}
      </div>
      {buttons.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {buttons.map((code, i) => (
            <span key={i} className="rounded-full border border-white/15 px-2.5 py-0.5 font-mono text-micro text-lab-mute" title="Кнопка, которую агент отправил в чат">
              кнопка{code ? `: ${code}` : ""}
            </span>
          ))}
        </div>
      )}
      {tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tools.map(name => <span key={name} className="rounded border border-white/15 bg-white/[0.06] px-2 py-0.5 text-meta text-lab-soft">{name}</span>)}
        </div>
      )}
      {turn.ok === false && <span className="text-meta text-lab-warn">Передал оператору · статус {turn.status}</span>}
    </div>
  );
}

/**
 * A conversation as a chat: the customer's teal bubble on the right, the agent's words on the left,
 * the judge's quote marked in the agent's words with its number. Turns long before the mark fold away.
 */
export function Conversation({ turns, mark, marks, hover, onHover }: {
  turns: Turn[]; mark?: Mark; marks?: Mark[]; hover?: boolean; onHover?: (on: boolean) => void;
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
          ? <div key={index} className="max-w-[85%] self-end whitespace-pre-wrap rounded-2xl rounded-br-md bg-lab-user px-3.5 py-2 text-read text-lab-text">{t.text}</div>
          : <AgentTurn key={index} turn={t} marks={all} hover={hover} onHover={onHover} />;
      })}
    </div>
  );
}
