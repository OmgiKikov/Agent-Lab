import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Check, Clock, Database, FileText, Globe, Search, X } from "lucide-react";
import { plural } from "../../../lab/format";
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

/** A few lines of a prompt with the criteria marked where they are written. */
function PromptExcerpt({ source, marks, chars = 900, className }: { source: Source; marks: { quote: string; n: number }[]; chars?: number; className?: string }) {
  const { data } = useSource(source.id);
  if (!data) return <Skeleton className="h-40" />;
  const clean = data.content.replace(/\*\*/g, "").replace(/^#{2,}\s*/gm, "");
  const found = marks.map(m => ({ ...m, at: clean.indexOf(m.quote.replace(/\*\*/g, "").slice(0, 30)) })).filter(m => m.at >= 0).sort((a, b) => a.at - b.at);
  const start = Math.max(0, (found[0]?.at ?? 0) - 160);
  const text = clean.slice(start, start + chars);
  const pieces = segments(text, marks.map(m => ({ quote: m.quote.replace(/\*\*/g, ""), n: m.n })));
  return (
    <div className={cn("whitespace-pre-line text-[12px] leading-[20px] text-lab-mute", className)}>
      {start > 0 && "…"}
      {pieces.map((p, i) => p.n
        ? <span key={i}><mark className="rounded-[2px] bg-[rgba(232,145,45,0.17)] px-0.5 text-lab-text">{p.text}</mark><span className="ml-1 inline-block translate-y-[-1px] align-middle"><Mark n={p.n} size={18} /></span></span>
        : <span key={i}>{p.text}</span>)}
      …
    </div>
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

  if (!a.state) return <div className="p-6"><Skeleton className="h-64" /></div>;
  const criteria = tab === "criteria";
  const chosen = crits.find(c => c.r.id === rid) ?? null;
  const q = query.trim().toLowerCase();
  const shown = crits.filter(c => (!filter || (filter === "every" ? c.every : !c.every && c.r.topics.includes(filter))) && (!q || `${nameOf(c.r)} ${c.r.rule.text}`.toLowerCase().includes(q)));
  const marksOf = (s: Source) => crits.filter(c => c.r.rule.sourceId === s.id).map(c => ({ quote: c.r.rule.quote, n: c.n }));
  const top = a.prompts.find(s => s.rules > 0);
  const byTopic = topics.map(t => ({ ...t, n: crits.filter(c => c.r.topics.includes(t.topic)).length }));
  const maxN = Math.max(1, ...byTopic.map(t => t.n));
  const checked = !!memory.last;
  const fromPrompts = new Set(crits.map(c => c.r.rule.sourceId).filter(Boolean)).size;

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
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="relative mx-auto max-w-[1180px] px-8 pb-24 pt-10 xl:h-[720px]">
            {/* Layer 1 — the prompt, as a stack of sheets, behind on the right */}
            {top && (
              <button type="button" onClick={() => setOpen(top)} className="group mb-6 block w-full text-left xl:absolute xl:right-8 xl:top-8 xl:mb-0 xl:w-[520px]">
                <Stack depth={2}>
                  <div className="rounded-[12px] border border-white/[0.09] bg-[rgb(31,31,31)] px-5 pb-5 pt-4 transition-colors group-hover:border-white/[0.16]">
                    <div className="flex items-center gap-2 text-[11px] text-lab-dim">
                      <FileText className="size-3" /><span className="font-mono text-lab-soft">{fileOf(top).file}</span>
                      <span className="ml-auto">промпт 1 из {a.prompts.length}</span>
                    </div>
                    <PromptExcerpt source={top} marks={marksOf(top)} chars={760} className="mt-3 max-h-[300px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]" />
                  </div>
                </Stack>
              </button>
            )}

            {/* Layer 2 — the agent */}
            <div className={cn("relative z-10 rounded-[14px] bg-[rgb(35,35,35)] p-6 xl:w-[600px]", DEEP)}>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" onClick={() => setConnecting(true)} title={checked ? "Отвечал при последней проверке" : "Ещё не проверялся"}>
                  <Pill dot={checked ? "#74b98e" : "#8e969b"} className={checked ? "border-lab-ok/30 bg-lab-ok/[0.1] text-lab-ok" : undefined}>{a.way ?? "Не подключён"}</Pill>
                </button>
                <Pill icon={Globe}>СберБизнес</Pill>
                <Pill>Чат поддержки</Pill>
              </div>
              <h1 className="mt-4 text-[26px] font-medium leading-[32px] tracking-[-0.6px] text-lab-ink">Агент эквайринга</h1>
              <p className="mt-1.5 text-[13px] leading-[20px] text-lab-dim">Отвечает клиентам СберБизнеса про эквайринг: тарифы, терминалы, возвраты, зачисления.</p>
              <div className="mt-5 grid grid-cols-3 overflow-hidden rounded-[6px] border border-white/[0.08]">
                {[
                  { label: "Промпты", value: a.prompts.length, go: () => top && setOpen(top) },
                  { label: "Системы банка", value: a.tools.length },
                  { label: "Критерии", value: crits.length, go: () => setTab("criteria") },
                ].map((s, i) => (
                  <button key={s.label} type="button" onClick={s.go} disabled={!s.go} className={cn("px-3 py-2 text-left enabled:hover:bg-white/[0.03]", i > 0 && "border-l border-white/[0.08]")}>
                    <div className="text-[10px] text-lab-mute">{s.label}</div>
                    <div className="text-[17px] font-semibold leading-[24px] text-lab-ink">{s.value}</div>
                  </button>
                ))}
              </div>
              <div className="mt-5 text-[11px] text-lab-dim">Системы банка, которые он вызывает</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {a.tools.map(t => <Pill key={t.name} mono icon={Database} className="rounded-md" title={t.env}>{t.name}</Pill>)}
              </div>
              <div className="mt-5 flex items-center gap-3 border-t border-white/[0.07] pt-4 text-[11px] text-lab-dim">
                <button type="button" onClick={() => setConnecting(true)} className="text-lab-mute hover:text-lab-ink">Подключение</button>
                <span className="text-lab-faint">·</span>
                <button type="button" onClick={a.read} disabled={a.busy || !a.repo} className="text-lab-mute hover:text-lab-ink disabled:opacity-40">Прочитать код заново</button>
                <span className="text-lab-faint">·</span>
                <span className="truncate font-mono">{a.repo || "папка с кодом не указана"}</span>
              </div>
            </div>

            {/* Layer 3 — the criteria, floating over the seam, like Raindrop's Slack card */}
            <div className={cn("relative z-20 mt-6 overflow-hidden rounded-[12px] bg-[rgb(38,38,38)] xl:absolute xl:left-[590px] xl:top-[410px] xl:mt-0 xl:w-[440px]", DEEP)}>
              <div className="flex gap-3 p-4">
                <span className="w-[3px] flex-shrink-0 rounded-full bg-[rgb(232,145,45)]" />
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-semibold text-[rgb(255,196,130)]">{crits.length} {plural(crits.length, "критерий", "критерия", "критериев")}</div>
                  <div className="mt-0.5 text-[11px] text-lab-dim">из {fromPrompts} {plural(fromPrompts, "источника", "источников", "источников")} · {topics.length} {plural(topics.length, "тема", "темы", "тем")} разговоров</div>
                  <div className="mt-3 space-y-1.5">
                    {crits.slice(0, 3).map(c => (
                      <button key={c.r.id} type="button" onClick={() => { setTab("criteria"); setRid(c.r.id); }} className="flex w-full items-center gap-2 text-left text-[12px] text-lab-text hover:text-lab-ink">
                        <Mark n={c.n} size={18} /><span className="truncate">{nameOf(c.r)}</span>
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 rounded-[8px] border border-white/[0.08] px-3 pb-2 pt-2.5">
                    <div className="flex items-center justify-between text-[10px] text-lab-mute"><span>Критерии по темам</span><span className="text-[rgb(255,196,130)]">больше всего: {shortTopic(byTopic.find(t => t.n === maxN)?.topic ?? "")} · {maxN}</span></div>
                    <div className="mt-2 flex h-[54px] items-end gap-[6px]">
                      {byTopic.map(t => (
                        <span key={t.topic} title={`${t.topic}: ${t.n}`} className="flex-1 rounded-[2px]"
                          style={{ height: `${Math.max(8, (100 * t.n) / maxN)}%`, background: t.n === maxN ? "rgba(249,115,22,0.8)" : "rgba(255,255,255,0.16)" }} />
                      ))}
                    </div>
                  </div>
                  <button type="button" onClick={() => setTab("criteria")}
                    className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-[6px] bg-[rgb(96,190,160)] px-3 text-[12px] font-medium text-black hover:bg-[rgb(112,204,174)]">
                    Открыть критерии<ArrowRight className="size-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
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
                  ...byTopic.map(t => ({ key: t.topic, label: shortTopic(t.topic), n: crits.filter(c => !c.every && c.r.topics.includes(t.topic)).length, hue: t.hue }))].map(o => {
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
