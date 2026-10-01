import { ArrowUpRight, Code2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RuleEntry } from "../lab/problems";
import { Caps } from "../ui/Caps";
import { shortOrigin } from "./text";

/**
 * The criterion as the agent's code says it, word for word, with its file and line. Pointing at it lights the agent's
 * words the judge cited, and back: the requirement and its breach are read together.
 */
export function CodeQuote({ r, n, lit, onLit, onOpen }: { r: RuleEntry; n?: number; lit?: boolean; onLit?: (on: boolean) => void; onOpen?: () => void }) {
  const { quote, origin, condition, acceptable } = r.rule;
  return (
    <section>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Caps>{n ? `Критерий ${n} в коде агента` : "Критерий в коде агента"}</Caps>
        <span className="flex-1" />
        {origin && (onOpen
          ? <button type="button" onClick={onOpen} title="Открыть текст промпта с этой цитатой" className="inline-flex items-center gap-1.5 rounded-sm font-mono text-meta text-fg-2 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"><Code2 aria-hidden className="size-3.5" />{shortOrigin(origin)}<ArrowUpRight aria-hidden className="size-3.5" /></button>
          : <span className="inline-flex items-center gap-1.5 font-mono text-meta text-fg-3"><Code2 aria-hidden className="size-3.5" />{shortOrigin(origin)}</span>)}
      </div>
      <div onMouseEnter={() => onLit?.(true)} onMouseLeave={() => onLit?.(false)} className={cn("mt-2.5 border-l-2 pl-4 transition-colors duration-150", lit ? "border-warn" : "border-fg-4/60")}>
        <blockquote className="text-lead text-fg">«{quote}»</blockquote>
        {(condition || acceptable) && (
          <p className="mt-2 text-small text-fg-3">
            {condition && <><b className="font-medium text-fg-2">Когда применяется:</b> {condition} </>}
            {acceptable && <><b className="font-medium text-fg-2">Допустимо:</b> {acceptable}</>}
          </p>
        )}
      </div>
    </section>
  );
}
