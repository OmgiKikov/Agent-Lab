import { Fragment, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { api } from "../../../lab/api";
import type { RuleEntry, SourceText } from "../../../lab/problems";
import { cn } from "@/lib/utils";
import { SectionHeader } from "../../../shell/SectionHeader";
import { useKeys } from "../../../shell/keys";
import { Skeleton } from "../../../ui/EmptyState";
import { segments, splitQuote } from "../../../ui/highlight";
import { fileOf, useAgent, useParam } from "./shared";
import { PREVIEW_NAMES } from "./names";

const EVERY = "Во всех разговорах";
const nameOf = (r: RuleEntry) => PREVIEW_NAMES[r.id] ?? r.title;
/** The prompt as a person reads it: no markdown stars. */
const plain = (t: string) => t.replace(/\*\*/g, "");

/** A number in Raindrop's orange ring, the mark that ties a criterion to its words in the prompt. */
function Num({ n, on, size = "md" }: { n: number; on?: boolean; size?: "sm" | "md" }) {
  return (
    <span className={cn("inline-flex flex-shrink-0 items-center justify-center rounded-full border font-semibold tabular-nums transition-colors",
      size === "sm" ? "size-[18px] text-[10px]" : "size-[22px] text-[11px]",
      on ? "border-lab-mark bg-lab-mark text-black" : "border-lab-mark/[0.44] bg-[rgb(60,44,32)] text-[rgb(255,212,163)]")}>{n}</span>
  );
}

/** Plain prompt text with its «### ЗАГОЛОВКИ» set as headings. */
function Prose({ text }: { text: string }) {
  const parts = text.split(/(^#{2,}\s.*$)/m);
  return <>{parts.map((part, i) => /^#{2,}\s/.test(part)
    ? <span key={i} className="mt-3 block text-[12px] font-semibold tracking-[0.02em] text-lab-soft">{part.replace(/^#{2,}\s*/, "")}</span>
    : <Fragment key={i}>{i > 0 && /^#{2,}\s/.test(parts[i - 1]) ? part.replace(/^[ \t]*\n/, "") : part}</Fragment>)}</>;
}

type Numbered = { r: RuleEntry; n: number; every: boolean };

/** Критерии как разметка промпта: the rules on the left, the agent's own prompt on the right with every rule marked where it is written. */
export function CriteriaStory() {
  const a = useAgent();
  const [sel, setSel] = useParam("c");
  const ids = useMemo(() => [...new Set(a.rules.flatMap(r => (r.rule.sourceId ? [r.rule.sourceId] : [])))], [a.rules]);
  const texts = useQueries({ queries: ids.map(id => ({ queryKey: ["source", id], queryFn: () => api<SourceText>(`/api/sources/${encodeURIComponent(id)}`), staleTime: Infinity })) });
  const content = new Map(ids.map((id, i) => [id, texts[i]?.data ? plain(texts[i].data!.content) : null]));
  const ready = texts.every(t => !t.isLoading);

  // Numbers follow the prompts as they are read: the source with most rules first, then where the quote stands in it.
  const numbered: Numbered[] = useMemo(() => {
    const topics = new Set(a.rules.flatMap(r => r.topics)).size;
    const order = a.sources.map(s => s.id);
    const at = (r: RuleEntry) => { const c = r.rule.sourceId ? content.get(r.rule.sourceId) : null; const p = c ? splitQuote(c, plain(r.rule.quote)) : null; return p ? p[0].length : 1e9; };
    return [...a.rules]
      .sort((x, y) => order.indexOf(x.rule.sourceId ?? "") - order.indexOf(y.rule.sourceId ?? "") || at(x) - at(y))
      .map((r, i) => ({ r, n: i + 1, every: topics > 0 && r.topics.length === topics }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.rules, a.sources, ready]);

  const chosen = numbered.find(x => x.r.id === sel) ?? numbered[0];
  const sourceId = chosen?.r.rule.sourceId ?? null;
  const source = a.sources.find(s => s.id === sourceId);
  const text = sourceId ? content.get(sourceId) : null;
  const here = numbered.filter(x => x.r.rule.sourceId === sourceId);
  const pieces = text ? segments(text, here.map(x => ({ quote: plain(x.r.rule.quote), n: x.n }))) : [];
  const markRef = useRef<HTMLElement | null>(null);
  useEffect(() => { markRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [chosen?.r.id, !!text]);
  const step = (d: 1 | -1) => { if (!chosen) return; const next = numbered[Math.max(0, Math.min(numbered.length - 1, chosen.n - 1 + d))]; setSel(next.r.id); };
  useKeys({ KeyJ: () => step(1), KeyK: () => step(-1), ArrowDown: () => step(1), ArrowUp: () => step(-1) });

  if (!a.state) return <div className="p-6"><Skeleton className="h-64" /></div>;
  const scope = (x: Numbered) => (x.every ? EVERY : x.r.topics.map(t => t.split(",")[0].trim()).join(", "));
  const f = source ? fileOf(source) : null;

  const callout = (x: Numbered): ReactNode => (
    <span className="my-3 block rounded-[9px] border border-lab-mark/[0.35] bg-[rgb(38,33,28)] px-4 py-3.5 font-sans text-[13px] leading-[20px] [white-space:normal]">
      <span className="flex items-center gap-2.5"><Num n={x.n} on /><span className="text-[15px] font-medium text-lab-ink">{nameOf(x.r)}</span></span>
      <span className="mt-2 block text-lab-text">{x.r.rule.text}</span>
      <span className="mt-3 grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12px]">
        <span className="text-lab-dim">Где действует</span><span className="text-lab-soft">{x.every ? EVERY : x.r.topics.join(" · ")}</span>
        {x.r.rule.condition && <><span className="text-lab-dim">Когда именно</span><span className="text-lab-soft">{x.r.rule.condition}</span></>}
        {x.r.rule.acceptable && <><span className="text-lab-dim">Не нарушение</span><span className="text-lab-soft">{x.r.rule.acceptable}</span></>}
      </span>
    </span>
  );

  return (
    <div className="flex h-full flex-col">
      <SectionHeader crumbs={[{ label: "Агент эквайринга" }]} />
      <nav className="flex flex-shrink-0 gap-1 border-b border-white/[0.08] px-3">
        <span className="-mb-px border-b-2 border-transparent px-3 py-2 text-[13px] text-lab-dim">Агент</span>
        <span className="-mb-px border-b-2 border-lab-ink px-3 py-2 text-[13px] text-lab-ink">Критерии <span className="ml-1 text-lab-dim">{numbered.length}</span></span>
      </nav>
      <div className="flex min-h-0 flex-1">
        <aside className="w-[380px] flex-shrink-0 overflow-auto border-r border-white/[0.08] px-2 pb-6 pt-4">
          <p className="px-3 pb-3 text-[12px] leading-[18px] text-lab-dim">Что агент обязан делать. Каждое правило — фраза из его промпта: справа видно, где она написана.</p>
          {numbered.map(x => (
            <button key={x.r.id} type="button" onClick={() => setSel(x.r.id)} aria-current={x.r.id === chosen?.r.id || undefined}
              className={cn("flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors", x.r.id === chosen?.r.id ? "bg-white/[0.08]" : "hover:bg-white/[0.04]")}>
              <span className="pt-px"><Num n={x.n} size="sm" on={x.r.id === chosen?.r.id} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-lab-ink">{nameOf(x.r)}</span>
                <span className="block truncate text-[11px] text-lab-dim">{scope(x)}</span>
              </span>
            </button>
          ))}
        </aside>
        <section className="min-w-0 flex-1 overflow-auto">
          {f && source && (
            <div className="sticky top-0 z-10 flex items-baseline gap-3 border-b border-white/[0.08] bg-lab-bg/95 px-8 py-2.5 backdrop-blur">
              <span className="text-[13px] text-lab-text">{source.kind === "tools" ? "Список инструментов агента" : "Промпт агента"}</span>
              {source.kind !== "tools" && <span className="min-w-0 truncate font-mono text-[11px] text-lab-dim" title={source.origin}>{f.file}{f.line && `:${f.line}`}</span>}
              <span className="ml-auto flex-shrink-0 text-[12px] text-lab-dim">правил из него: {here.length}</span>
            </div>
          )}
          {!text ? <div className="p-8"><Skeleton className="h-96" /></div> : (
            <div className="max-w-[820px] whitespace-pre-wrap px-8 pb-24 pt-6 text-[14px] leading-[23px] text-lab-mute">
              {chosen && !pieces.some(p => p.n === chosen.n) && (
                <>{callout(chosen)}<span className="mb-4 block text-[12px] text-lab-warn">Этой фразы нет в нынешнем тексте промпта дословно: возможно, промпт поменялся после извлечения.</span></>
              )}
              {pieces.map((p, i) => {
                if (!p.n) return <Prose key={i} text={p.text} />;
                const x = numbered.find(y => y.n === p.n)!;
                const on = x.r.id === chosen?.r.id;
                return (
                  <Fragment key={i}>
                    <mark ref={on ? el => { markRef.current = el; } : undefined} onClick={() => setSel(x.r.id)}
                      className={cn("cursor-pointer rounded-sm px-0.5 transition-colors", on ? "bg-lab-mark/[0.3] text-white" : "bg-lab-mark/[0.14] text-lab-ink hover:bg-lab-mark/[0.22]")}>
                      {p.text}<span className="ml-1 inline-block translate-y-[-1px] align-middle"><Num n={x.n} size="sm" on={on} /></span>
                    </mark>
                    {on && callout(x)}
                  </Fragment>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
