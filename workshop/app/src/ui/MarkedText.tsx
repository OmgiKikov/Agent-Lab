import { Fragment, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { segments } from "./highlight";
import { Mark, MARK_TEXT } from "./Mark";

/** «### РОЛЬ» lines of a prompt set as small headings; the rest as it is. */
function Plain({ text }: { text: string }) {
  const parts = text.split(/(^#{2,}\s.*$)/m);
  return <>{parts.map((t, i) => /^#{2,}\s/.test(t)
    ? <span key={i} className="font-semibold text-lab-soft">{t.replace(/^#{2,}\s*/, "")}</span>
    : <Fragment key={i}>{t}</Fragment>)}</>;
}

/**
 * A long text (a prompt) with the words of each criterion marked and numbered. The mark `on` is lit and scrolled
 * into view; a click on a mark reports its number.
 */
export function MarkedText({ text, marks, on, onMark, className }: {
  text: string; marks: { quote: string; n: number }[]; on?: number; onMark?: (n: number) => void; className?: string;
}) {
  const clean = text.replace(/\*\*/g, "");
  const pieces = segments(clean, marks.map(m => ({ quote: m.quote.replace(/\*\*/g, ""), n: m.n })));
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => { ref.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [on, text]);
  return (
    <div className={cn("whitespace-pre-wrap text-[12.5px] leading-[20px] text-lab-mute", className)}>
      {pieces.map((p, i) => p.n
        ? (
          <span key={i} ref={p.n === on ? el => { ref.current = el; } : undefined} onClick={onMark ? () => onMark(p.n!) : undefined} className={onMark ? "cursor-pointer" : undefined}>
            <mark className={cn(MARK_TEXT, p.n === on && "bg-[rgba(232,145,45,0.34)] text-white")}>{p.text}</mark>
            <span className="ml-1 inline-block translate-y-[-1px] align-middle"><Mark n={p.n} size={18} on={p.n === on} /></span>
          </span>
        )
        : <Plain key={i} text={p.text} />)}
    </div>
  );
}
