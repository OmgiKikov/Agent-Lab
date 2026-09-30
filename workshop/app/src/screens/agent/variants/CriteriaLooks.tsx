import { useMemo, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { RuleEntry } from "../../../lab/problems";
import { cn } from "@/lib/utils";
import { SectionHeader } from "../../../shell/SectionHeader";
import { Skeleton } from "../../../ui/EmptyState";
import { fileOf, useAgent, useParam, useQuoteContext } from "./shared";
import { PREVIEW_NAMES } from "./names";

const EVERY = "Во всех диалогах";
/** «Ставка, тариф и комиссия по эквайрингу» → «Ставка»: the topic's first words, as a tag. */
const short = (topic: string) => topic.split(",")[0].trim();
const nameOf = (r: RuleEntry) => PREVIEW_NAMES[r.id] ?? r.title;

type Scoped = { r: RuleEntry; every: boolean; scopes: string[] };

function useScoped() {
  const a = useAgent();
  return useMemo(() => {
    const topics = [...new Set(a.rules.flatMap(r => r.topics))];
    const all: Scoped[] = a.rules.map(r => ({ r, every: topics.length > 0 && r.topics.length === topics.length, scopes: r.topics.map(short) }));
    all.sort((x, y) => Number(y.every) - Number(x.every));
    return { a, topics, all };
  }, [a]);
}

function Scope({ s }: { s: Scoped }) {
  const tags = s.every ? [EVERY] : s.scopes;
  return (
    <span className="flex min-w-0 flex-wrap justify-end gap-1">
      {tags.slice(0, 2).map(t => <span key={t} className="truncate rounded border border-white/[0.1] px-1.5 text-[11px] leading-[18px] text-lab-mute">{t}</span>)}
      {tags.length > 2 && <span className="text-[11px] leading-[18px] text-lab-dim">+{tags.length - 2}</span>}
    </span>
  );
}

/** The criterion as a contract: its name, the full rule, when it applies, what is fine, the prompt's own words. */
function Contract({ s, onClose }: { s: Scoped; onClose: () => void }) {
  const { r } = s;
  const { parts, loading } = useQuoteContext(r, 160);
  const f = fileOf(r.rule);
  const row = (label: string, value: ReactNode) => (
    <div><dt className="text-[11px] text-lab-mute">{label}</dt><dd className="mt-0.5 text-[13px] leading-[20px] text-lab-text">{value}</dd></div>
  );
  return (
    <aside className="w-[460px] flex-shrink-0 overflow-auto border-l border-white/[0.08] bg-lab-surface">
      <div className="flex items-start gap-3 px-5 pt-4">
        <h2 className="min-w-0 flex-1 text-[17px] font-medium leading-[24px] text-lab-ink">{nameOf(r)}</h2>
        <button type="button" onClick={onClose} aria-label="Закрыть" className="rounded p-1 text-lab-dim hover:bg-white/[0.08] hover:text-lab-text"><X className="size-4" /></button>
      </div>
      <p className="px-5 pt-1.5 text-[13px] leading-[20px] text-lab-soft">{r.rule.text}</p>
      <dl className="space-y-3 px-5 pt-5">
        {row("Где действует", s.every ? EVERY : r.topics.join(" · "))}
        {r.rule.condition && row("Когда именно", r.rule.condition)}
        {r.rule.acceptable && row("Что не считается нарушением", r.rule.acceptable)}
      </dl>
      <div className="px-5 pb-6 pt-5">
        <div className="text-[11px] text-lab-mute">Как написано в промпте · <span className="font-mono">{f.file}{f.line && `:${f.line}`}</span></div>
        <div className="mt-1.5 whitespace-pre-line rounded-lg bg-lab-raised px-3.5 py-3 text-[13px] leading-[20px] text-lab-mute">
          {loading ? <Skeleton className="h-16" /> : parts
            ? <>{parts[0]}<mark className="rounded-sm bg-lab-mark/[0.17] px-0.5 text-lab-ink">{parts[1]}</mark>{parts[2]}</>
            : <>«{r.rule.quote}»</>}
        </div>
      </div>
    </aside>
  );
}

/** 1 · A list: the name in bold, the rule in one line, where it applies as tags. */
function Look1({ all, topics, sel, onSel }: { all: Scoped[]; topics: string[]; sel?: string; onSel: (id: string) => void }) {
  const [filter, setFilter] = useState<string | null>(null);
  const shown = all.filter(s => !filter || (filter === EVERY ? s.every : s.r.topics.includes(filter)));
  const chips = [{ key: null, label: "Все", n: all.length }, { key: EVERY, label: EVERY, n: all.filter(s => s.every).length },
    ...topics.map(t => ({ key: t, label: short(t), n: all.filter(s => s.r.topics.includes(t)).length }))];
  return (
    <div className="min-w-0 flex-1 overflow-auto">
      <div className="flex flex-wrap gap-1.5 border-b border-white/[0.08] px-5 py-3">
        {chips.map(c => (
          <button key={c.label} type="button" onClick={() => setFilter(c.key)}
            className={cn("h-7 rounded-md border px-2.5 text-[12px] transition-colors", filter === c.key ? "border-white/[0.2] bg-[rgb(48,48,48)] text-lab-ink" : "border-white/[0.08] text-lab-mute hover:text-lab-text")}>
            {c.label} <span className="text-lab-dim">{c.n}</span>
          </button>
        ))}
      </div>
      {shown.map(s => (
        <button key={s.r.id} type="button" onClick={() => onSel(s.r.id)}
          className={cn("grid w-full grid-cols-[260px_minmax(0,1fr)_auto] items-center gap-5 border-b border-white/[0.06] px-5 py-3 text-left transition-colors", s.r.id === sel ? "bg-lab-active" : "hover:bg-lab-hover")}>
          <span className="truncate text-[13px] font-medium text-lab-ink">{nameOf(s.r)}</span>
          <span className="truncate text-[13px] text-lab-dim">{s.r.rule.text}</span>
          <Scope s={s} />
        </button>
      ))}
    </div>
  );
}

/** 2 · Cards: each criterion a card with its name, two lines of the rule and where it applies. */
function Look2({ all, sel, onSel }: { all: Scoped[]; sel?: string; onSel: (id: string) => void }) {
  const every = all.filter(s => s.every), rest = all.filter(s => !s.every);
  const grid = (items: Scoped[]) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
      {items.map(s => (
        <button key={s.r.id} type="button" onClick={() => onSel(s.r.id)}
          className={cn("flex min-h-[132px] flex-col rounded-[9px] border bg-[rgb(35,35,35)] p-4 text-left transition-colors", s.r.id === sel ? "border-white/[0.3]" : "border-white/[0.08] hover:border-white/[0.18]")}>
          <span className="text-[14px] font-medium leading-[20px] text-lab-ink">{nameOf(s.r)}</span>
          <span className="mt-1.5 line-clamp-2 text-[12px] leading-[18px] text-lab-dim">{s.r.rule.text}</span>
          <span className="mt-auto flex pt-3"><Scope s={s} /></span>
        </button>
      ))}
    </div>
  );
  return (
    <div className="min-w-0 flex-1 overflow-auto px-6 pb-10 pt-5">
      <h3 className="text-[13px] font-semibold text-lab-ink">{EVERY}</h3>
      <p className="mt-0.5 text-[12px] text-lab-dim">Агент обязан соблюдать в каждом разговоре</p>
      <div className="mt-3">{grid(every)}</div>
      <h3 className="mt-8 text-[13px] font-semibold text-lab-ink">В разговорах на определённую тему</h3>
      <p className="mt-0.5 text-[12px] text-lab-dim">Действуют, только когда клиент спрашивает о своём</p>
      <div className="mt-3">{grid(rest)}</div>
    </div>
  );
}

/** 3 · By topic: the topics of conversations on the left, what the agent must do in the chosen one on the right. */
function Look3({ all, topics, sel, onSel }: { all: Scoped[]; topics: string[]; sel?: string; onSel: (id: string) => void }) {
  const [topic, setTopic] = useState<string>(EVERY);
  const items = topic === EVERY ? all.filter(s => s.every) : all.filter(s => !s.every && s.r.topics.includes(topic));
  const menu = [{ key: EVERY, label: EVERY, n: all.filter(s => s.every).length }, ...topics.map(t => ({ key: t, label: t, n: all.filter(s => !s.every && s.r.topics.includes(t)).length }))];
  return (
    <div className="flex min-w-0 flex-1">
      <nav className="w-[300px] flex-shrink-0 overflow-auto border-r border-white/[0.08] p-2">
        <div className="px-2.5 pb-1.5 pt-2 text-[11px] text-lab-dim">О чём разговор</div>
        {menu.map(m => (
          <button key={m.key} type="button" onClick={() => setTopic(m.key)}
            className={cn("flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors", topic === m.key ? "bg-white/[0.08] text-lab-ink" : "text-lab-mute hover:bg-white/[0.04] hover:text-lab-text")}>
            <span className="min-w-0 flex-1">{m.label}</span><span className="flex-shrink-0 text-lab-dim">{m.n}</span>
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-auto px-7 pb-10 pt-6">
        <h3 className="text-[17px] font-medium text-lab-ink">{topic === EVERY ? "В любом разговоре агент обязан" : "Когда клиент спрашивает об этом, агент обязан"}</h3>
        {topic !== EVERY && <p className="mt-1 text-[13px] text-lab-dim">{topic}</p>}
        <ol className="mt-5 space-y-1">
          {items.map((s, i) => (
            <li key={s.r.id}>
              <button type="button" onClick={() => onSel(s.r.id)}
                className={cn("flex w-full gap-4 rounded-lg px-3 py-3 text-left transition-colors", s.r.id === sel ? "bg-white/[0.07]" : "hover:bg-white/[0.035]")}>
                <span className="w-5 flex-shrink-0 pt-px text-right text-[13px] tabular-nums text-lab-faint">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium text-lab-ink">{nameOf(s.r)}</span>
                  <span className="mt-1 block text-[13px] leading-[20px] text-lab-dim">{s.r.rule.text}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Preview of three looks for the «Критерии» tab (?v=k1|k2|k3). */
export function CriteriaLooks({ look }: { look: "k1" | "k2" | "k3" }) {
  const { a, topics, all } = useScoped();
  const [sel, setSel] = useParam("c");
  if (!a.state) return <div className="p-6"><Skeleton className="h-64" /></div>;
  const chosen = all.find(s => s.r.id === sel);
  const onSel = (id: string) => setSel(id === sel ? null : id);
  return (
    <div className="flex h-full flex-col">
      <SectionHeader crumbs={[{ label: "Агент эквайринга" }]} />
      <nav className="flex flex-shrink-0 gap-1 border-b border-white/[0.08] px-3">
        <span className="-mb-px border-b-2 border-transparent px-3 py-2 text-[13px] text-lab-dim">Агент</span>
        <span className="-mb-px border-b-2 border-lab-ink px-3 py-2 text-[13px] text-lab-ink">Критерии <span className="ml-1 text-lab-dim">{all.length}</span></span>
      </nav>
      <div className="flex min-h-0 flex-1">
        {look === "k1" && <Look1 all={all} topics={topics} sel={sel ?? undefined} onSel={onSel} />}
        {look === "k2" && <Look2 all={all} sel={sel ?? undefined} onSel={onSel} />}
        {look === "k3" && <Look3 all={all} topics={topics} sel={sel ?? undefined} onSel={onSel} />}
        {chosen && <Contract key={chosen.r.id} s={chosen} onClose={() => setSel(null)} />}
      </div>
    </div>
  );
}
