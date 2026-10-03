import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import type { Criterion } from "../../lab/criteria";
import { plural } from "../../lab/format";
import { secondOf } from "../../lab/problemStats";
import type { Source } from "../../lab/types";
import { firstLine, spansOf, toneOf, worst, type SideKey, type Span, type Tone } from "./model";

const BAR: Record<Tone, string> = { bad: "bg-bad", ok: "bg-ok/80", unknown: "stripe-unknown", none: "bg-fg-4/40" };
const MARK: Record<Tone, string> = {
  bad: "bg-bad/[0.12] decoration-bad",
  ok: "bg-ok/[0.07] decoration-ok/60",
  unknown: "decoration-fg-4 decoration-dashed",
  none: "decoration-fg-4/50 decoration-dotted",
};

/** What a criterion's line says about it on this side: the count with its denominator, the second judge, people. */
function Lens({ c, side, on, onSelect }: { c: Criterion; side: SideKey; on: boolean; onSelect: () => void }) {
  const s = c.r[side];
  const tone = toneOf(c.r, side);
  const second = secondOf(s.examples);
  const checked = s.failed + s.passed;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={on}
      className={cn(
        "flex w-full flex-wrap items-center gap-x-2 rounded-sm py-0.5 text-left font-sans text-small transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
        on ? "text-fg-2" : "text-fg-3 hover:text-fg-2",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          tone === "bad" ? "bg-bad" : tone === "ok" ? "bg-ok" : "border border-dashed border-fg-4",
        )}
      />
      <span>Критерий {c.n}</span>
      <span aria-hidden>·</span>
      {tone === "bad" && (
        <span className="font-medium text-bad">
          ошибка в {s.failed} из {checked}
        </span>
      )}
      {tone === "ok" && (
        <span className="font-medium text-fg-2">
          ошибок не найдено в {s.passed} из {checked}
        </span>
      )}
      {tone === "unknown" && (
        <span className="font-medium text-fg-2">
          не проверен в {s.unknown} {plural(s.unknown, "разговоре", "разговорах", "разговорах")}: нет доказательств
        </span>
      )}
      {tone === "none" && <span>не встречался в этих разговорах</span>}
      {tone === "bad" && second.checked > 0 && (
        <>
          <span aria-hidden>·</span>
          <span>
            две проверки совпали в {second.agree} из {second.checked}
          </span>
        </>
      )}
      {tone !== "unknown" && s.unknown > 0 && (
        <>
          <span aria-hidden>·</span>
          <span>не проверен в {s.unknown}</span>
        </>
      )}
    </button>
  );
}

/**
 * A source of criteria as written — the agent's prompt, or the person's rules of communication — with its criteria in
 * place: each quote lit by what the check found on this side, the count over it, a bar in the margin. The line numbers
 * are the source's own.
 */
export function CodeView({
  label,
  source,
  content,
  items,
  side,
  selected,
  onSelect,
}: {
  label: string;
  source: Source;
  content: string;
  items: Criterion[];
  side: SideKey;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { spans, missing } = useMemo(() => spansOf(content, items), [content, items]);
  const lines = useMemo(() => {
    let at = 0;
    return content.split("\n").map((text) => {
      const start = at;
      at += text.length + 1;
      return { text, start, end: start + text.length };
    });
  }, [content]);
  const first = firstLine(source);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected) return;
    box.current
      ?.querySelector<HTMLElement>(`[data-lens="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selected, source.id]);
  return (
    <div ref={box} className="min-h-0 overflow-auto bg-canvas py-3" role="region" aria-label={label}>
      {lines.map((line, i) => {
        const here = spans.filter((s) => s.start < line.end + 1 && s.end > line.start);
        const opens = spans.filter((s) => s.start >= line.start && s.start <= line.end);
        const tone = worst(here.map((s) => toneOf(s.c.r, side)));
        const heading = /^#{1,6}\s/.test(line.text);
        return (
          <div key={i}>
            {opens.map((s) => (
              <div key={s.c.r.id} data-lens={s.c.r.id} className="grid grid-cols-[4px_56px_minmax(0,1fr)] pt-2">
                <span />
                <span />
                <span className="pr-6">
                  <Lens c={s.c} side={side} on={s.c.r.id === selected} onSelect={() => onSelect(s.c.r.id)} />
                </span>
              </div>
            ))}
            <div className="grid grid-cols-[4px_56px_minmax(0,1fr)]">
              <span className={cn(tone && BAR[tone])} />
              <span aria-hidden className="select-none pr-4 text-right font-mono text-meta leading-6 text-fg-4">
                {first + i}
              </span>
              <span
                className={cn(
                  "whitespace-pre-wrap break-words pr-6 text-body leading-6",
                  heading ? "font-semibold text-fg" : "text-fg-2",
                )}
              >
                {line.text ? (
                  <Pieces
                    text={line.text}
                    offset={line.start}
                    spans={here}
                    side={side}
                    selected={selected}
                    onSelect={onSelect}
                  />
                ) : (
                  "\u00a0"
                )}
              </span>
            </div>
          </div>
        );
      })}
      {missing.length > 0 && (
        <p className="mx-6 mt-6 border-t border-line pt-3 font-sans text-small text-warn">
          {missing.length === 1 ? "Цитаты одного критерия" : `Цитат ${missing.length} критериев`} нет в нынешнем тексте:
          он мог измениться после того, как критерии собрали ({missing.map((c) => c.n).join(", ")}).
        </p>
      )}
    </div>
  );
}

function Pieces({
  text,
  offset,
  spans,
  side,
  selected,
  onSelect,
}: {
  text: string;
  offset: number;
  spans: Span[];
  side: SideKey;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const out: JSX.Element[] = [];
  let pos = 0;
  for (const s of spans) {
    const a = Math.max(0, s.start - offset);
    const b = Math.min(text.length, s.end - offset);
    if (b <= pos) continue;
    if (a > pos) out.push(<span key={`t${pos}`}>{text.slice(pos, a)}</span>);
    const tone = toneOf(s.c.r, side);
    const on = s.c.r.id === selected;
    out.push(
      <span
        key={`m${a}`}
        role="button"
        tabIndex={-1}
        onClick={() => onSelect(s.c.r.id)}
        title={`Критерий ${s.c.n}`}
        className={cn(
          "cursor-pointer rounded-sm underline decoration-2 underline-offset-4 transition-colors",
          MARK[tone],
          on ? "bg-warn/20 text-fg decoration-warn" : "text-fg",
        )}
      >
        {text.slice(Math.max(a, pos), b)}
      </span>,
    );
    pos = b;
  }
  if (pos < text.length) out.push(<span key={`t${pos}`}>{text.slice(pos)}</span>);
  return <>{out}</>;
}
