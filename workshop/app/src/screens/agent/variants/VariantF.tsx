import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lab/api";
import type { LogDialogue } from "../../../lab/problems";
import { visible } from "../../../ui/Conversation";
import { Check, ChevronDown, ChevronLeft, ChevronRight, FileText, Wrench } from "lucide-react";
import { plural, thousands } from "../../../lab/format";
import { useSource, type RuleEntry } from "../../../lab/problems";
import type { Source } from "../../../lab/types";
import { cn } from "@/lib/utils";
import { Skeleton } from "../../../ui/EmptyState";
import { segments } from "../../../ui/highlight";
import { ConnectionDrawer } from "../Connection";
import { fileOf, useAgent, useParam, useQuoteContext } from "./shared";
import { PREVIEW_NAMES } from "./names";

/*
 * Вариант Е · «Raindrop»: the page speaks in sentences with code tokens inside, the way Raindrop's Investigate does;
 * the object on the left with one pill, a teal action and a boxed row of numbers; evidence with orange numbered marks;
 * a «1 / 16 ‹ Назад  Далее ›» pager. No icon tiles, no gradients, no coloured category pills.
 */

const nameOf = (r: RuleEntry) => PREVIEW_NAMES[r.id] ?? r.title;
const EVERY = "Во всех разговорах";

// ─── Raindrop's small parts ─────────────────────────────────────────────────

/** Code inside a sentence: `module.loaders`. */
const Tok = ({ children }: { children: ReactNode }) => (
  <code className="rounded-[3px] bg-white/[0.07] px-1 py-px font-mono text-[0.86em] text-lab-soft">{children}</code>
);

/** Identifiers, links and time zones inside a rule's sentence set as code. */
function Prose({ text }: { text: string }) {
  const parts = text.split(/(\b[a-z]+[A-Z][A-Za-z0-9]+\b|\[название\]\(url\)|GMT\/UTC|UTC\+3)/g);
  return <>{parts.map((p, i) => (i % 2 ? <Tok key={i}>{p}</Tok> : <Fragment key={i}>{p}</Fragment>))}</>;
}

/** Raindrop's number in an orange ring: the mark that ties a claim to its words. */
function Mark({ n, on }: { n: number; on?: boolean }) {
  return (
    <span className={cn("inline-flex size-[20px] flex-shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold tabular-nums",
      on ? "border-[rgba(232,145,45,0.9)] bg-[rgb(92,62,30)] text-[rgb(255,222,184)]" : "border-[rgba(232,145,45,0.44)] bg-[rgb(60,44,32)] text-[rgb(255,212,163)]")}>{n}</span>
  );
}

/** Segmented tabs: 11px, the chosen one on a light fill. */
function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      {options.map(o => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={cn("h-[26px] rounded-[5px] px-2 text-[11px] font-medium transition-colors", o.value === value ? "bg-white/[0.13] text-lab-ink" : "text-lab-mute hover:text-lab-text")}>{o.label}</button>
      ))}
    </div>
  );
}

/** «1 / 3  ‹ Back  Next ›». */
function Pager({ at, total, onStep }: { at: number; total: number; onStep: (d: 1 | -1) => void }) {
  return (
    <div className="flex items-center gap-1 text-[11px]">
      <span className="mr-2 tabular-nums text-lab-dim">{at} / {total}</span>
      <button type="button" onClick={() => onStep(-1)} disabled={at <= 1} className="inline-flex h-[26px] items-center gap-0.5 rounded-[5px] px-1.5 text-lab-mute hover:text-lab-ink disabled:opacity-35"><ChevronLeft className="size-3" />Назад</button>
      <button type="button" onClick={() => onStep(1)} disabled={at >= total} className="inline-flex h-[26px] items-center gap-0.5 rounded-[5px] border border-white/[0.15] bg-[rgb(40,40,40)] px-2 text-lab-text hover:text-lab-ink disabled:opacity-35">Далее<ChevronRight className="size-3" /></button>
    </div>
  );
}

/** A tool call row: wrench, name, what it is, and a chevron. */
function ToolRow({ name, meta, tail, onClick, icon: Icon = Wrench }: { name: ReactNode; meta?: ReactNode; tail?: ReactNode; onClick?: () => void; icon?: typeof Wrench }) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick} className="group flex w-full items-center gap-2 rounded-[5px] px-1 py-1.5 text-left enabled:hover:bg-white/[0.03]">
      <Icon className="size-3 flex-shrink-0 text-lab-dim" />
      <span className="flex-shrink-0 font-mono text-[12px] font-medium text-[rgb(199,205,208)]">{name}</span>
      {meta && <span className="min-w-0 truncate text-[11px] text-lab-dim">{meta}</span>}
      {tail && <span className="ml-auto flex-shrink-0 text-[11px] text-lab-dim">{tail}</span>}
      {onClick && <ChevronDown className="size-3 flex-shrink-0 -rotate-90 text-lab-faint group-hover:text-lab-dim" />}
    </button>
  );
}

/** The one small pill over a title (Raindrop's «High ⌄»), neutral here. */
function TopPill({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick}
      className="inline-flex h-[21px] items-center gap-1 rounded-[3px] border border-white/[0.16] bg-white/[0.04] px-1.5 text-[10px] font-medium text-lab-soft enabled:hover:border-white/[0.3]">
      {children}{onClick && <ChevronDown className="size-3 text-lab-dim" />}
    </button>
  );
}

/** Raindrop's boxed numbers: small muted labels over values, cells split by hairlines. */
function StatBox({ cells }: { cells: { label: string; value: ReactNode; onClick?: () => void }[] }) {
  return (
    <div className="mt-4 grid overflow-hidden rounded-[4px] border border-white/[0.08] bg-[rgb(35,35,35)]" style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0,1fr))` }}>
      {cells.map((c, i) => (
        <button key={c.label} type="button" onClick={c.onClick} disabled={!c.onClick} className={cn("px-2 py-1.5 text-left enabled:hover:bg-white/[0.03]", i > 0 && "border-l border-white/[0.08]")}>
          <div className="text-[10px] leading-[14px] text-lab-mute">{c.label}</div>
          <div className="text-[15px] font-semibold leading-[22px] text-lab-ink">{c.value}</div>
        </button>
      ))}
    </div>
  );
}

function Details({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <section className="mt-5">
      <h2 className="text-[12px] font-semibold text-lab-ink">Детали</h2>
      <dl className="mt-2 space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[112px_minmax(0,1fr)] items-baseline gap-x-3">
            <dt className="text-[11px] text-lab-mute">{k}</dt><dd className="min-w-0 text-[11px] leading-[16px] text-[rgb(178,192,199)]">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Raindrop's customer bubble: teal, on the right. */
function Bubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-[10px] border border-[rgba(75,180,200,0.11)] bg-[rgba(75,180,200,0.14)] px-[11px] py-2 text-[12px] leading-[17px] text-[rgb(212,224,230)]">{children}</div>
    </div>
  );
}

/** A real conversation from the logs, as it went: the customer on the right, the agent's words as text. No verdict here. */
function LoggedTalk({ id }: { id: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["dialogue", id], queryFn: () => api<LogDialogue>(`/api/dialogues/${encodeURIComponent(id)}`), staleTime: Infinity });
  const [all, setAll] = useState(false);
  if (isLoading || !data) return <Skeleton className="h-28" />;
  const turns = all ? data.messages : data.messages.slice(0, 4);
  return (
    <div className="space-y-3">
      {turns.map((t, i) => t.role === "customer"
        ? <Bubble key={i}>{t.text}</Bubble>
        : <p key={i} className="whitespace-pre-line text-[12px] leading-[21.6px] text-lab-text">{visible(t.text).text}</p>)}
      {data.messages.length > 4 && <button type="button" onClick={() => setAll(v => !v)} className="text-[11px] text-lab-dim hover:text-lab-text">{all ? "Свернуть" : `Весь разговор · ${data.messages.length} ${plural(data.messages.length, "реплика", "реплики", "реплик")}`}</button>}
    </div>
  );
}

// ─── Prompt with marks ──────────────────────────────────────────────────────

function PromptText({ source, marks, chosen, onMark }: { source: Source; marks: { quote: string; n: number; id: string }[]; chosen?: string; onMark: (id: string) => void }) {
  const { data, isLoading } = useSource(source.id);
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => { ref.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [chosen, !!data]);
  if (isLoading || !data) return <Skeleton className="m-4 h-72" />;
  const clean = data.content.replace(/\*\*/g, "");
  const pieces = segments(clean, marks.map(m => ({ quote: m.quote.replace(/\*\*/g, ""), n: m.n })));
  return (
    <div className="whitespace-pre-wrap px-4 pb-16 pt-3 text-[12px] leading-[21.6px] text-lab-mute">
      {pieces.map((p, i) => {
        if (!p.n) return <Fragment key={i}>{p.text.split(/(^#{2,}\s.*$)/m).map((t, j) => /^#{2,}\s/.test(t) ? <span key={j} className="font-semibold text-lab-text">{t.replace(/^#{2,}\s*/, "")}</span> : t)}</Fragment>;
        const m = marks.find(x => x.n === p.n)!;
        const on = m.id === chosen;
        return (
          <span key={i} ref={on ? el => { ref.current = el; } : undefined} onClick={() => onMark(m.id)} className="cursor-pointer">
            <mark className={cn("rounded-[2px] px-0.5", on ? "bg-[rgba(232,145,45,0.3)] text-white" : "bg-[rgba(232,145,45,0.17)] text-lab-text")}>{p.text}</mark>
            <span className="ml-1 inline-block translate-y-[-1px] align-middle"><Mark n={p.n} on={on} /></span>
          </span>
        );
      })}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function VariantF() {
  const a = useAgent();
  const [tab, setTab] = useParam("t");
  const [rid, setRid] = useParam("c");
  const [pane, setPane] = useState<"note" | "prompts" | "tools">("note");
  const [promptAt, setPromptAt] = useState(0);
  const [connecting, setConnecting] = useState(false);

  // One numbering for the whole page: the criteria in the order of the list.
  const list = useMemo(() => {
    const topics = new Set(a.rules.flatMap(r => r.topics)).size;
    const groups = new Map<string, RuleEntry[]>();
    for (const r of a.rules) {
      const key = topics > 0 && r.topics.length === topics ? EVERY : r.topics[0] ?? EVERY;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const ordered = [...groups.entries()].sort(([x], [y]) => Number(y === EVERY) - Number(x === EVERY));
    let n = 0;
    return ordered.map(([title, rules]) => ({ title, items: rules.map(r => ({ r, n: ++n })) }));
  }, [a.rules]);
  const flat = list.flatMap(g => g.items);

  if (!a.state) return <div className="p-6"><Skeleton className="h-64" /></div>;
  const criteria = tab === "criteria";
  const chosen = flat.find(x => x.r.id === rid) ?? flat[0];
  const step = (d: 1 | -1) => { if (!chosen) return; setRid(flat[Math.max(0, Math.min(flat.length - 1, chosen.n - 1 + d))].r.id); };
  const withRules = a.prompts.filter(s => s.rules > 0);
  const top = withRules[0];
  const usedTools = a.tools.filter(t => a.rules.some(r => `${r.rule.text} ${r.rule.acceptable}`.includes(t.name)));
  const prompt = a.prompts[Math.min(promptAt, a.prompts.length - 1)];
  const marksFor = (s: Source) => flat.filter(x => x.r.rule.sourceId === s.id).map(x => ({ quote: x.r.rule.quote, n: x.n, id: x.r.id }));
  const openCriterion = (id: string) => { setTab("criteria"); setRid(id); };
  const results = a.state.discover?.results ?? [];
  const talk = (results.find(r => r.status === "PASS" && r.opening.length > 20 && r.opening.length < 120) ?? results[0])?.dialogueId ?? null;
  const topicId = new Map((a.state.discover?.topics ?? []).map(t => [t.title, t.id]));
  /** Real first messages of customers in the topics a criterion is for: how people actually ask. */
  const asks = (r: RuleEntry) => {
    const ids = new Set(r.topics.map(t => topicId.get(t)));
    const seen = new Set<string>();
    return results.filter(x => ids.has(x.topicId) && x.opening.length > 15 && x.opening.length < 140)
      .map(x => x.opening.trim()).filter(o => !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase())).slice(0, 3);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 flex-shrink-0 items-center gap-3 border-b border-white/[0.08] px-[17px]">
        <span className="text-[13px] font-medium text-lab-ink">Агент эквайринга</span>
        <span className="text-[11px] text-lab-dim">Промпты {a.prompts.length}<span className="mx-1.5">·</span>Системы банка {a.tools.length}<span className="mx-1.5">·</span>Критерии {flat.length}</span>
        <span className="ml-3"><Tabs value={criteria ? "criteria" : "agent"} onChange={v => setTab(v === "criteria" ? "criteria" : null)} options={[{ value: "agent", label: "Агент" }, { value: "criteria", label: "Критерии" }]} /></span>
      </header>

      {!criteria ? (
        <div className="flex min-h-0 flex-1">
          {/* The object */}
          <aside className="w-[384px] flex-shrink-0 overflow-auto border-r border-white/[0.08] px-[18px] pb-5 pt-[9px]">
            <TopPill onClick={() => setConnecting(true)}>{a.way ?? "Не подключён"}</TopPill>
            <h1 className="mt-2 text-[19px] font-medium leading-[23px] tracking-[-0.475px] text-lab-ink">Агент эквайринга</h1>
            <p className="mt-1.5 text-[11px] leading-[16.5px] text-lab-mute">Отвечает клиентам СберБизнеса в чате поддержки. Код — <Tok>{a.repo.split("/").pop() || "не указан"}</Tok>.</p>
            <button type="button" onClick={() => setConnecting(true)}
              className="mt-3 inline-flex h-[30px] items-center gap-1.5 rounded-[5px] border border-[rgba(75,180,200,0.35)] bg-[rgba(75,180,200,0.14)] px-2.5 text-[12px] text-[rgb(212,224,230)] hover:bg-[rgba(75,180,200,0.2)]">
              Подключение<ChevronDown className="size-3.5" />
            </button>
            <StatBox cells={[
              { label: "Промпты", value: a.prompts.length, onClick: () => setPane("prompts") },
              { label: "Системы банка", value: a.tools.length, onClick: () => setPane("tools") },
              { label: "Критерии", value: flat.length, onClick: () => setTab("criteria") },
            ]} />
            <Details rows={[
              ["Где работает", a.way ?? "—"],
              ["Адрес", <span key="a" className="block truncate font-mono text-[10px]" title={a.address}>{a.address.replace(/^https?:\/\//, "") || "—"}</span>],
              ["Код", <span key="c" className="font-mono text-[10px]">{a.repo || "—"}</span>],
              ["Прочитан", a.readDate || "—"],
            ]} />
            <button type="button" onClick={a.read} disabled={a.busy || !a.repo} className="mt-4 text-[11px] text-lab-mute hover:text-lab-ink disabled:opacity-40">Прочитать код заново →</button>
          </aside>

          {/* What was read, as a note */}
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-[41px] flex-shrink-0 items-center gap-2 border-b border-white/[0.08] px-3">
              <Tabs value={pane} onChange={setPane} options={[{ value: "note", label: "Сводка" }, { value: "prompts", label: "Промпты" }, { value: "tools", label: "Системы банка" }]} />
              {pane === "prompts" && <span className="ml-auto"><Pager at={promptAt + 1} total={a.prompts.length} onStep={d => setPromptAt(i => Math.max(0, Math.min(a.prompts.length - 1, i + d)))} /></span>}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {pane === "note" && (
                <div className="max-w-[640px] px-4 py-4 text-[12px] leading-[21.6px] text-lab-text">
                  <div className="flex items-center gap-1.5 text-[11px] text-lab-dim"><Check className="size-3" />Прочитали код агента<span className="text-lab-faint">{a.prompts.length} промптов · {a.tools.length} систем</span></div>
                  <p className="mt-2">
                    Агент отвечает по {a.prompts.length} {plural(a.prompts.length, "промпту", "промптам", "промптам")} и ходит в {a.tools.length} {plural(a.tools.length, "систему", "системы", "систем")} банка. <b className="font-semibold text-lab-ink">Из промптов взяли {flat.length} {plural(flat.length, "критерий", "критерия", "критериев")} — что агент обязан делать в разговоре.</b>
                  </p>
                  {top && (
                    <p className="mt-2">
                      Больше всего их в <Tok>{fileOf(top).file}</Tok>: {top.rules}. Ещё {withRules.length - 1} {plural(withRules.length - 1, "промпт дал", "промпта дали", "промптов дали")} по одному-три, в остальных {a.prompts.length - withRules.length} критериев не нашлось.
                    </p>
                  )}
                  <div className="mt-3">
                    {withRules.map(s => <ToolRow key={s.id} icon={FileText} name={fileOf(s).file} meta={thousands(s.chars)} tail={`${s.rules} ${plural(s.rules, "критерий", "критерия", "критериев")}`} onClick={() => { setPane("prompts"); setPromptAt(a.prompts.indexOf(s)); }} />)}
                    {a.toolsSource && usedTools.length > 0 && <ToolRow name="системы банка" meta={usedTools.map(t => t.name).join(", ")} tail={`${usedTools.length} ${plural(usedTools.length, "критерий", "критерия", "критериев")}`} onClick={() => setPane("tools")} />}
                  </div>
                  <button type="button" onClick={() => setTab("criteria")}
                    className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-[5px] border border-white/[0.12] bg-[rgb(35,35,35)] px-2.5 text-[11px] text-lab-soft hover:border-white/[0.22] hover:text-lab-ink">
                    Открыть {flat.length} {plural(flat.length, "критерий", "критерия", "критериев")}<ChevronRight className="size-3" />
                  </button>
                  {talk && (
                    <section className="mt-8 border-t border-white/[0.08] pt-4">
                      <div className="mb-3 flex items-center gap-1.5 text-[11px] text-lab-dim">Так агент разговаривает<span className="text-lab-faint">· разговор из логов</span></div>
                      <LoggedTalk id={talk} />
                    </section>
                  )}
                </div>
              )}
              {pane === "prompts" && prompt && (
                <>
                  <div className="flex items-center gap-2 px-4 pt-3 text-[11px] text-lab-dim"><FileText className="size-3" /><span className="font-mono text-lab-soft">{prompt.origin}</span><span>· {thousands(prompt.chars)}</span></div>
                  <PromptText key={prompt.id} source={prompt} marks={marksFor(prompt)} onMark={openCriterion} />
                </>
              )}
              {pane === "tools" && (
                <div className="px-3 py-3">
                  {a.tools.map(t => {
                    const rule = flat.find(x => `${x.r.rule.text} ${x.r.rule.acceptable}`.includes(t.name));
                    return <ToolRow key={t.name} name={t.name} meta={<span className="font-mono">{t.env}</span>} tail={rule ? <span className="inline-flex items-center gap-1.5 text-[rgb(255,212,163)]"><Mark n={rule.n} />{nameOf(rule.r)}</span> : undefined} onClick={rule ? () => openCriterion(rule.r.id) : undefined} />;
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* The list, as Raindrop's: grouped, two lines a row */}
          <aside className="w-[300px] flex-shrink-0 overflow-auto border-r border-white/[0.08] bg-[rgb(25,25,25)] px-2 pb-6">
            {list.map(g => (
              <section key={g.title}>
                <div className="truncate px-2 pb-1 pt-3.5 text-[10px] text-lab-dim" title={g.title}>{g.title}</div>
                {g.items.map(x => (
                  <button key={x.r.id} type="button" onClick={() => setRid(x.r.id)} aria-current={x.r.id === chosen?.r.id || undefined}
                    className={cn("block w-full rounded-[6px] px-2 py-1.5 text-left transition-colors", x.r.id === chosen?.r.id ? "bg-white/[0.08]" : "hover:bg-white/[0.035]")}>
                    <span className="block truncate text-[12px] text-lab-text">{nameOf(x.r)}</span>
                    <span className="block truncate text-[10px] text-lab-mute">{x.r.rule.text}</span>
                  </button>
                ))}
              </section>
            ))}
          </aside>
          {chosen && <CriterionPage key={chosen.r.id} x={chosen} total={flat.length} onStep={step} group={list.find(g => g.items.includes(chosen))?.title ?? ""} source={a.sources.find(s => s.id === chosen.r.rule.sourceId)} marks={(s: Source) => marksFor(s)} onMark={id => setRid(id)} asks={asks(chosen.r)} />}
        </div>
      )}
      <ConnectionDrawer open={connecting} onClose={() => setConnecting(false)} state={a.state} />
    </div>
  );
}

function CriterionPage({ x, total, onStep, group, source, marks, onMark, asks }: {
  x: { r: RuleEntry; n: number }; total: number; onStep: (d: 1 | -1) => void; group: string; source?: Source;
  marks: (s: Source) => { quote: string; n: number; id: string }[]; onMark: (id: string) => void; asks: string[];
}) {
  const [pane, setPane] = useState<"quote" | "prompt">("quote");
  const { parts, loading } = useQuoteContext(x.r, 260);
  const f = fileOf(x.r.rule);
  return (
    <div className="flex min-w-0 flex-1">
      <section className="w-[384px] flex-shrink-0 overflow-auto border-r border-white/[0.08] px-[18px] pb-6 pt-[9px]">
        <TopPill>{group === EVERY ? EVERY : group.split(",")[0]}</TopPill>
        <h1 className="mt-2 text-[19px] font-medium leading-[23px] tracking-[-0.475px] text-lab-ink">{nameOf(x.r)}</h1>
        <p className="mt-1.5 text-[11px] leading-[16.5px] text-lab-mute"><Prose text={x.r.rule.text} /></p>
        <Details rows={[
          ["Когда проверяем", x.r.rule.condition || EVERY],
          ["Так можно", x.r.rule.acceptable || "—"],
          ["Темы", group === EVERY ? EVERY : x.r.topics.join(" · ")],
          ["Источник", <span key="s" className="font-mono text-[10px]">{f.file}{f.line && `:${f.line}`}</span>],
        ]} />
      </section>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[41px] flex-shrink-0 items-center gap-2 border-b border-white/[0.08] px-3">
          <Tabs value={pane} onChange={setPane} options={[{ value: "quote", label: "Как написано" }, { value: "prompt", label: "Весь промпт" }]} />
          <span className="ml-auto"><Pager at={x.n} total={total} onStep={onStep} /></span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {pane === "quote" ? (
            <div className="max-w-[640px] px-4 py-4">
              {asks.length > 0 && (
                <section className="mb-5">
                  <div className="mb-2.5 text-[11px] text-lab-dim">Так пишут клиенты <span className="text-lab-faint">· из логов</span></div>
                  <div className="space-y-2">{asks.map(q => <Bubble key={q}>{q}</Bubble>)}</div>
                </section>
              )}
              <div className="mb-2.5 text-[11px] text-lab-dim">Что агенту велено <span className="text-lab-faint">· промпт</span></div>
              <div className="rounded-[8px] border border-white/[0.08] bg-[rgb(35,35,35)] px-[11px] py-[9px]">
                <div className="flex items-center gap-2 text-[11px] text-lab-dim"><FileText className="size-3" /><span className="font-mono text-lab-soft">{f.file}</span><span>промпт агента</span></div>
                <div className="mt-1.5 whitespace-pre-line text-[12px] leading-[21.6px] text-lab-text">
                  {loading ? <Skeleton className="h-24" /> : parts
                    ? <>{parts[0]}<mark className="rounded-[2px] bg-[rgba(232,145,45,0.17)] px-0.5 text-lab-ink">{parts[1]}</mark><span className="ml-1 inline-block translate-y-[-1px] align-middle"><Mark n={x.n} on /></span>{parts[2]}</>
                    : <>«{x.r.rule.quote}»</>}
                </div>
              </div>
              <p className="mt-3 text-[11px] leading-[16.5px] text-lab-dim">Судья проверяет каждый разговор по этой фразе, дословно. Если промпт поменяется, критерии нужно извлечь заново.</p>
            </div>
          ) : source ? <PromptText source={source} marks={marks(source)} chosen={x.r.id} onMark={onMark} /> : <p className="p-4 text-[12px] text-lab-dim">Источник не найден.</p>}
        </div>
      </section>
    </div>
  );
}
