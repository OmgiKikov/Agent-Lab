import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Check, ChevronDown, Clock, Database, FileText, Globe, RotateCcw, Search, X } from "lucide-react";
import { plural, thousands } from "../../../lab/format";
import { useSource, type RuleEntry } from "../../../lab/problems";
import type { Source } from "../../../lab/types";
import { cn } from "@/lib/utils";
import { Skeleton } from "../../../ui/EmptyState";
import { segments } from "../../../ui/highlight";
import { ConnectionDrawer, useConnectionMemory } from "../Connection";
import { SourceText } from "../Code";
import { fileOf, useAgent, useParam, useQuoteContext } from "./shared";
import { PREVIEW_NAMES } from "./names";

/*
 * Вариант Ж · «Слои»: rich parts (pills, cards, marks) laid in layers, the way Raindrop's own landing floats
 * a Slack card over the app window. No gradients, no icon tiles, colour only on topics and the orange evidence.
 */

const nameOf = (r: RuleEntry) => PREVIEW_NAMES[r.id] ?? r.title;
const shortTopic = (t: string) => t.split(",")[0].trim();
const HUES = ["#6DB3F2", "#A57CF5", "#5FC98A", "#F0AD4E", "#4FCAE3", "#E28A80", "#C9B458"];
const EVERY = "Во всех разговорах";
const DEEP = "shadow-[0_28px_70px_-18px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.09)]";

function Pill({ children, dot, hue, icon: Icon, mono, className, title }: {
  children: ReactNode; dot?: string; hue?: string; icon?: typeof Globe; mono?: boolean; className?: string; title?: string;
}) {
  return (
    <span title={title}
      className={cn("inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-full border px-2 text-[11px] leading-none", !hue && "border-white/[0.1] bg-white/[0.04] text-lab-soft", mono && "font-mono", className)}
      style={hue ? { background: `${hue}12`, borderColor: `${hue}30`, color: `color-mix(in srgb, ${hue} 50%, #e1e8ec)` } : undefined}>
      {dot && <span className="size-1.5 flex-shrink-0 rounded-full" style={{ background: dot }} />}
      {Icon && <Icon className="size-3 flex-shrink-0 opacity-75" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

function Mark({ n, on, size = 20 }: { n: number; on?: boolean; size?: number }) {
  return (
    <span style={{ width: size, height: size }} className={cn("inline-flex flex-shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold tabular-nums",
      on ? "border-[rgba(232,145,45,0.9)] bg-[rgb(92,62,30)] text-[rgb(255,222,184)]" : "border-[rgba(232,145,45,0.44)] bg-[rgb(60,44,32)] text-[rgb(255,212,163)]")}>{n}</span>
  );
}

/** Cards laid on each other: the ones behind peek out below and to the right, like a stack of sheets. */
function Stack({ children, depth = 2, className }: { children: ReactNode; depth?: number; className?: string }) {
  return (
    <div className={cn("relative", className)}>
      {Array.from({ length: depth }, (_, i) => depth - i).map(d => (
        <div key={d} aria-hidden className="absolute inset-0 rounded-[12px] border border-white/[0.07] bg-[rgb(33,33,33)]"
          style={{ transform: `translate(${d * 10}px, ${d * 10}px)`, opacity: 1 - d * 0.28 }} />
      ))}
      <div className="relative">{children}</div>
    </div>
  );
}

type Crit = { r: RuleEntry; n: number; every: boolean; hues: { topic: string; hue: string }[] };

function Scope({ c, max = 2 }: { c: Crit; max?: number }) {
  if (c.every) return <Pill icon={Globe}>{EVERY}</Pill>;
  return (
    <>
      {c.hues.slice(0, max).map(h => <Pill key={h.topic} dot={h.hue} hue={h.hue} title={h.topic}>{shortTopic(h.topic)}</Pill>)}
      {c.hues.length > max && <Pill>+{c.hues.length - max}</Pill>}
    </>
  );
}

// ─── Criteria: cards and a floating inspector ───────────────────────────────

function CritCard({ c, on, onOpen }: { c: Crit; on: boolean; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen}
      className={cn("group relative flex min-h-[150px] flex-col rounded-[10px] border bg-[rgb(35,35,35)] p-4 text-left transition-[border-color,transform,box-shadow]",
        on ? "border-[rgba(232,145,45,0.55)] shadow-[0_0_0_3px_rgba(232,145,45,0.12)]" : "border-white/[0.08] hover:-translate-y-px hover:border-white/[0.18]")}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5"><Scope c={c} /></div>
        <Mark n={c.n} on={on} />
      </div>
      <div className="mt-3 text-[14px] font-medium leading-[20px] text-lab-ink">{nameOf(c.r)}</div>
      <p className="mt-1 line-clamp-2 text-[12px] leading-[18px] text-lab-dim">{c.r.rule.text}</p>
      {c.r.rule.acceptable && (
        <div className="mt-auto flex items-start gap-2 pt-3 text-[11.5px]"><Check className="mt-[2px] size-3 flex-shrink-0 text-lab-ok" /><span className="line-clamp-1 text-lab-soft">{c.r.rule.acceptable}</span></div>
      )}
    </button>
  );
}

function Inspector({ c, source, marksOf, onClose, onPrompt }: { c: Crit; source?: Source; marksOf: (s: Source) => { quote: string; n: number }[]; onClose: () => void; onPrompt: () => void }) {
  const { parts, loading } = useQuoteContext(c.r, 220);
  const f = fileOf(c.r.rule);
  return (
    <aside className={cn("absolute bottom-3 right-3 top-3 z-30 flex w-[520px] flex-col overflow-hidden rounded-[14px] bg-[rgb(29,29,29)]", DEEP, "animate-in fade-in-0 slide-in-from-right-4")}>
      <div className="flex items-center gap-2 border-b border-white/[0.08] px-4 py-2.5">
        <Mark n={c.n} on />
        <span className="text-[11px] text-lab-dim">Критерий {c.n}</span>
        <button type="button" onClick={onClose} aria-label="Закрыть" className="ml-auto rounded-md p-1 text-lab-dim hover:bg-white/[0.08] hover:text-lab-text"><X className="size-4" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 pb-8 pt-4">
        <div className="flex flex-wrap gap-1.5"><Scope c={c} max={7} /></div>
        <h2 className="mt-3 text-[20px] font-medium leading-[26px] tracking-[-0.4px] text-lab-ink">{nameOf(c.r)}</h2>
        <p className="mt-2 text-[13px] leading-[20px] text-lab-soft">{c.r.rule.text}</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="rounded-[8px] border border-white/[0.08] bg-[rgb(35,35,35)] p-3">
            <div className="flex items-center gap-1.5 text-[11px] text-lab-ok"><Check className="size-3" />Так можно</div>
            <p className="mt-1 text-[12px] leading-[18px] text-lab-text">{c.r.rule.acceptable || "—"}</p>
          </div>
          <div className="rounded-[8px] border border-white/[0.08] bg-[rgb(35,35,35)] p-3">
            <div className="flex items-center gap-1.5 text-[11px] text-lab-mute"><Clock className="size-3" />Когда проверяем</div>
            <p className="mt-1 text-[12px] leading-[18px] text-lab-text">{c.r.rule.condition || EVERY}</p>
          </div>
        </div>
        <div className="mt-6 text-[11px] text-lab-dim">Как написано в промпте</div>
        <Stack depth={2} className="mb-5 mr-5 mt-2">
          <div className="rounded-[12px] border border-[rgba(232,145,45,0.28)] bg-[rgb(37,33,29)] px-4 py-3.5">
            <div className="flex items-center gap-2 text-[11px] text-lab-dim"><FileText className="size-3" /><span className="font-mono text-lab-soft">{f.file}</span></div>
            <div className="mt-2 whitespace-pre-line text-[12.5px] leading-[20px] text-lab-mute">
              {loading ? <Skeleton className="h-20" /> : parts
                ? <>{parts[0]}<mark className="rounded-[2px] bg-[rgba(232,145,45,0.22)] px-0.5 text-white">{parts[1]}</mark><span className="ml-1 inline-block translate-y-[-1px] align-middle"><Mark n={c.n} on size={18} /></span>{parts[2]}</>
                : <>«{c.r.rule.quote}»</>}
            </div>
            {source && (
              <button type="button" onClick={onPrompt} className="mt-3 inline-flex items-center gap-1 text-[11px] text-lab-mute hover:text-lab-ink">
                Весь промпт · {marksOf(source).length} {plural(marksOf(source).length, "критерий", "критерия", "критериев")} в нём<ArrowRight className="size-3" />
              </button>
            )}
          </div>
        </Stack>
      </div>
    </aside>
  );
}

// ─── Parts of the agent: cards and a floating inspector ─────────────────────

type Tool = { name: string; env: string; where: string[] };
type Part = { id: string; kind: "prompt" | "tool"; source?: Source; tool?: Tool; ns: number[] };
type PartFilter = null | "prompt" | "tool" | "rules";

/** The prompt's first real sentence, as a person would describe it: no headings, no markdown. */
function firstSentence(content: string) {
  const line = content.replace(/\*\*/g, "").split("\n").map(l => l.trim()).find(l => l && !/^#{1,}\s/.test(l) && /[А-Яа-яA-Za-z]{3}/.test(l)) ?? "";
  const cut = line.search(/[.!?](\s|$)/);
  return cut > 20 ? line.slice(0, cut + 1) : line;
}

/** Criteria numbers overlapping like a stack of avatars: which rules come from this part. */
function MarkStack({ ns, max = 4 }: { ns: number[]; max?: number }) {
  if (!ns.length) return <span className="text-[11px] text-lab-faint">без критериев</span>;
  return (
    <span className="flex items-center">
      {ns.slice(0, max).map((n, i) => <span key={n} className={cn("rounded-full ring-2 ring-[rgb(35,35,35)]", i > 0 && "-ml-1.5")}><Mark n={n} /></span>)}
      {ns.length > max && <span className="ml-1 text-[11px] text-[rgb(255,196,130)]">+{ns.length - max}</span>}
    </span>
  );
}

function PartCard({ x, on, onOpen }: { x: Part; on: boolean; onOpen: () => void }) {
  const { data } = useSource(x.source?.id);
  const f = x.source ? fileOf(x.source) : null;
  return (
    <button type="button" onClick={onOpen}
      className={cn("group relative flex min-h-[150px] flex-col rounded-[10px] border bg-[rgb(35,35,35)] p-4 text-left transition-[border-color,transform,box-shadow]",
        on ? "border-[rgba(232,145,45,0.55)] shadow-[0_0_0_3px_rgba(232,145,45,0.12)]" : "border-white/[0.08] hover:-translate-y-px hover:border-white/[0.18]")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">{x.kind === "prompt" ? <Pill icon={FileText}>Промпт</Pill> : <Pill icon={Database}>Система банка</Pill>}</div>
        <MarkStack ns={x.ns} />
      </div>
      <div className="mt-3 truncate font-mono text-[13px] text-lab-ink">
        {x.kind === "prompt" && f ? <>{f.file.replace(/\.py$/, "")}<span className="text-lab-faint">.py</span></> : x.tool?.name}
      </div>
      <p className="mt-1 line-clamp-2 text-[12px] leading-[18px] text-lab-dim">
        {x.kind === "prompt" ? (data ? firstSentence(data.content) : "…") : x.tool?.where.length ? `Вызывается в ${x.tool.where.join(", ")}` : x.tool?.env}
      </p>
      <div className="mt-auto flex items-center gap-2 pt-3 text-[11.5px] text-lab-dim">
        {x.kind === "prompt" && x.source ? <>{thousands(x.source.chars)}{f?.line && <span className="text-lab-faint">· строка {f.line}</span>}</> : <span className="truncate font-mono text-[10.5px] text-lab-faint">{x.tool?.env}</span>}
      </div>
    </button>
  );
}

function PartInspector({ x, crits, marks, onClose, onCriterion }: { x: Part; crits: Crit[]; marks: { quote: string; n: number }[]; onClose: () => void; onCriterion: (id: string) => void }) {
  const { data, isLoading } = useSource(x.source?.id);
  const mine = crits.filter(c => x.ns.includes(c.n));
  const f = x.source ? fileOf(x.source) : null;
  const clean = data ? data.content.replace(/\*\*/g, "") : "";
  const pieces = data ? segments(clean, marks.map(m => ({ quote: m.quote.replace(/\*\*/g, ""), n: m.n }))) : [];
  return (
    <aside className={cn("absolute bottom-3 right-3 top-3 z-30 flex w-[520px] flex-col overflow-hidden rounded-[14px] bg-[rgb(29,29,29)]", DEEP, "animate-in fade-in-0 slide-in-from-right-4")}>
      <div className="flex items-center gap-2 border-b border-white/[0.08] px-4 py-2.5">
        {x.kind === "prompt" ? <Pill icon={FileText}>Промпт</Pill> : <Pill icon={Database}>Система банка</Pill>}
        <button type="button" onClick={onClose} aria-label="Закрыть" className="ml-auto rounded-md p-1 text-lab-dim hover:bg-white/[0.08] hover:text-lab-text"><X className="size-4" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 pb-8 pt-4">
        <h2 className="break-all font-mono text-[16px] leading-[22px] text-lab-ink">{x.kind === "prompt" ? f?.file : x.tool?.name}</h2>
        <p className="mt-1 break-all font-mono text-[11px] text-lab-dim">{x.kind === "prompt" ? x.source?.origin : x.tool?.env}</p>
        <div className="mt-5 text-[11px] text-lab-dim">{mine.length ? `Критерии отсюда · ${mine.length}` : "Критериев отсюда нет"}</div>
        {mine.length > 0 && (
          <div className="mt-2 overflow-hidden rounded-[10px] border border-white/[0.08]">
            {mine.map(c => (
              <button key={c.r.id} type="button" onClick={() => onCriterion(c.r.id)} className="flex w-full items-center gap-2.5 border-b border-white/[0.06] bg-[rgb(35,35,35)] px-3 py-2 text-left last:border-b-0 hover:bg-[rgb(40,40,40)]">
                <Mark n={c.n} /><span className="min-w-0 flex-1 truncate text-[12.5px] text-lab-text">{nameOf(c.r)}</span><ArrowRight className="size-3 text-lab-faint" />
              </button>
            ))}
          </div>
        )}
        {x.kind === "tool" && x.tool && (
          <>
            <div className="mt-5 text-[11px] text-lab-dim">Где вызывается</div>
            <div className="mt-2 flex flex-wrap gap-1.5">{x.tool.where.map(w => <Pill key={w} mono className="rounded-md">{w}</Pill>)}</div>
          </>
        )}
        {x.kind === "prompt" && (
          <>
            <div className="mt-6 text-[11px] text-lab-dim">Текст промпта</div>
            <div className="mt-2 rounded-[12px] border border-white/[0.08] bg-[rgb(33,33,33)] px-4 py-3.5">
              {isLoading || !data ? <Skeleton className="h-64" /> : (
                <div className="whitespace-pre-wrap text-[12.5px] leading-[20px] text-lab-mute">
                  {pieces.map((p, i) => p.n
                    ? <span key={i}><mark className="rounded-[2px] bg-[rgba(232,145,45,0.2)] px-0.5 text-lab-text">{p.text}</mark><span className="ml-1 inline-block translate-y-[-1px] align-middle"><Mark n={p.n} size={18} /></span></span>
                    : <span key={i}>{p.text.split(/(^#{2,}\s.*$)/m).map((t, j) => /^#{2,}\s/.test(t) ? <span key={j} className="font-semibold text-lab-soft">{t.replace(/^#{2,}\s*/, "")}</span> : t)}</span>)}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function VariantG() {
  const a = useAgent();
  const memory = useConnectionMemory();
  const [tab, setTab] = useParam("t");
  const [rid, setRid] = useParam("c");
  const [filter, setFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [open, setOpen] = useState<Source | null>(null);

  const { crits, topics } = useMemo(() => {
    const topics = [...new Set(a.rules.flatMap(r => r.topics))].map((t, i) => ({ topic: t, hue: HUES[i % HUES.length] }));
    const hueOf = new Map(topics.map(t => [t.topic, t.hue]));
    const list = a.rules.map(r => ({ r, every: topics.length > 0 && r.topics.length === topics.length, hues: r.topics.map(t => ({ topic: t, hue: hueOf.get(t)! })) }));
    list.sort((x, y) => Number(y.every) - Number(x.every) || (x.hues[0]?.topic ?? "").localeCompare(y.hues[0]?.topic ?? ""));
    return { crits: list.map((c, i) => ({ ...c, n: i + 1 })) as Crit[], topics };
  }, [a.rules]);

  const [pid, setPid] = useParam("p");
  const [partFilter, setPartFilter] = useState<PartFilter>(null);
  if (!a.state) return <div className="p-6"><Skeleton className="h-64" /></div>;
  const criteria = tab === "criteria";
  const parts: Part[] = [
    ...a.prompts.map(s => ({ id: s.id, kind: "prompt" as const, source: s, ns: crits.filter(c => c.r.rule.sourceId === s.id).map(c => c.n) })),
    ...a.tools.map(t => ({ id: `tool:${t.name}`, kind: "tool" as const, tool: t, ns: crits.filter(c => `${c.r.rule.text} ${c.r.rule.acceptable}`.includes(t.name)).map(c => c.n) })),
  ];
  const part = parts.find(x => x.id === pid) ?? null;
  const chosen = crits.find(c => c.r.id === rid) ?? null;
  const q = query.trim().toLowerCase();
  const shown = crits.filter(c => (!filter || (filter === "every" ? c.every : !c.every && c.r.topics.includes(filter))) && (!q || `${nameOf(c.r)} ${c.r.rule.text}`.toLowerCase().includes(q)));
  const marksOf = (s: Source) => crits.filter(c => c.r.rule.sourceId === s.id).map(c => ({ quote: c.r.rule.quote, n: c.n }));
  const checked = !!memory.last;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 flex-shrink-0 items-center gap-3 border-b border-white/[0.08] px-[17px]">
        <span className="text-[13px] font-medium text-lab-ink">Агент эквайринга</span>
        <div className="flex items-center gap-0.5">
          {[{ key: null, label: "Агент" }, { key: "criteria", label: `Критерии ${crits.length}` }].map(t => (
            <button key={t.label} type="button" onClick={() => setTab(t.key)}
              className={cn("h-[26px] rounded-[5px] px-2 text-[11px] font-medium transition-colors", (t.key === "criteria") === criteria ? "bg-white/[0.13] text-lab-ink" : "text-lab-mute hover:text-lab-text")}>{t.label}</button>
          ))}
        </div>
      </header>

      {!criteria ? (
        <div className="relative min-h-0 flex-1">
          <div className="h-full overflow-auto">
            <div className={cn("px-6 pb-16 pt-6 transition-[padding]", part ? "xl:pr-[548px]" : "")}>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-[20px] font-medium tracking-[-0.4px] text-lab-ink">Из чего он сделан</h1>
                <span className="text-[12px] text-lab-dim">промпты и системы банка, прочитанные из его кода</span>
                <div className="ml-auto flex items-center gap-2">
                  <button type="button" onClick={() => setConnecting(true)} title={checked ? "Отвечал при последней проверке" : "Ещё не проверялся"}
                    className={cn("inline-flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[12px] transition-colors", checked ? "border-lab-ok/30 bg-lab-ok/[0.08] text-lab-ok hover:border-lab-ok/50" : "border-white/[0.1] bg-white/[0.03] text-lab-soft hover:border-white/[0.2]")}>
                    <span className={cn("size-1.5 rounded-full", checked ? "bg-lab-ok" : "bg-lab-dim")} />{a.way ?? "Не подключён"}<ChevronDown className="size-3.5 opacity-70" />
                  </button>
                  <button type="button" onClick={a.read} disabled={a.busy || !a.repo} title={a.repo}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 text-[12px] text-lab-soft transition-colors hover:border-white/[0.2] hover:text-lab-ink disabled:opacity-40">
                    <RotateCcw className="size-3.5" />Прочитать код заново
                  </button>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {[
                  { key: null as PartFilter, label: "Всё", n: parts.length },
                  { key: "prompt" as PartFilter, label: "Промпты", n: a.prompts.length, icon: FileText },
                  { key: "tool" as PartFilter, label: "Системы банка", n: a.tools.length, icon: Database },
                  { key: "rules" as PartFilter, label: "С критериями", n: parts.filter(x => x.ns.length).length, mark: true },
                ].map(o => {
                  const on = partFilter === o.key;
                  return (
                    <button key={o.label} type="button" onClick={() => setPartFilter(on ? null : o.key)}
                      className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors", on ? "border-white/[0.3] bg-white/[0.1] text-lab-ink" : "border-white/[0.08] text-lab-mute hover:border-white/[0.16] hover:text-lab-text")}>
                      {o.icon && <o.icon className="size-3" />}
                      {o.mark && <span className="size-1.5 rounded-full bg-[rgb(232,145,45)]" />}
                      {o.label}<span className="text-lab-dim">{o.n}</span>
                    </button>
                  );
                })}
              </div>
              <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
                {parts.filter(x => !partFilter || (partFilter === "rules" ? x.ns.length > 0 : x.kind === partFilter)).map(x => (
                  <PartCard key={x.id} x={x} on={x.id === pid} onOpen={() => setPid(x.id === pid ? null : x.id)} />
                ))}
              </div>
            </div>
          </div>
          {part && <PartInspector key={part.id} x={part} crits={crits} marks={part.source ? marksOf(part.source) : []} onClose={() => setPid(null)} onCriterion={id => { setPid(null); setTab("criteria"); setRid(id); }} />}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          <div className="h-full overflow-auto">
            <div className={cn("px-6 pb-16 pt-6 transition-[padding]", chosen ? "xl:pr-[548px]" : "")}>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-[20px] font-medium tracking-[-0.4px] text-lab-ink">Критерии</h1>
                <span className="text-[12px] text-lab-dim">что агент обязан делать · фразы из его промптов</span>
                <label className="ml-auto flex h-8 w-[220px] items-center gap-2 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 focus-within:border-white/[0.22]">
                  <Search className="size-3.5 text-lab-dim" />
                  <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Найти" className="min-w-0 flex-1 bg-transparent text-[12px] text-lab-ink outline-none placeholder:text-lab-faint" />
                </label>
              </div>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {[{ key: null as string | null, label: "Все", n: crits.length }, { key: "every", label: EVERY, n: crits.filter(c => c.every).length },
                  ...topics.map(t => ({ key: t.topic, label: shortTopic(t.topic), n: crits.filter(c => !c.every && c.r.topics.includes(t.topic)).length, hue: t.hue }))].map(o => {
                  const on = filter === o.key;
                  return (
                    <button key={o.label} type="button" onClick={() => setFilter(on ? null : o.key)}
                      className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors", on ? "border-white/[0.3] bg-white/[0.1] text-lab-ink" : "border-white/[0.08] text-lab-mute hover:border-white/[0.16] hover:text-lab-text")}>
                      {"hue" in o && o.hue && <span className="size-1.5 rounded-full" style={{ background: o.hue }} />}
                      {o.key === "every" && <Globe className="size-3" />}
                      {o.label}<span className="text-lab-dim">{o.n}</span>
                    </button>
                  );
                })}
              </div>
              <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
                {shown.map(c => <CritCard key={c.r.id} c={c} on={c.r.id === rid} onOpen={() => setRid(c.r.id === rid ? null : c.r.id)} />)}
              </div>
            </div>
          </div>
          {chosen && <Inspector key={chosen.r.id} c={chosen} source={a.sources.find(s => s.id === chosen.r.rule.sourceId)} marksOf={marksOf} onClose={() => setRid(null)} onPrompt={() => setOpen(a.sources.find(s => s.id === chosen.r.rule.sourceId) ?? null)} />}
        </div>
      )}
      <ConnectionDrawer open={connecting} onClose={() => setConnecting(false)} state={a.state} />
      <SourceText source={open} rules={open ? a.bySource.get(open.id) ?? [] : []} onClose={() => setOpen(null)} />
    </div>
  );
}
