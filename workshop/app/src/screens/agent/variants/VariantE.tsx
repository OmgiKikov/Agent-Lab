import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Bot, Check, Clock, Database, FileText, FolderGit2, Globe, ListChecks, PlugZap, RotateCcw, Search } from "lucide-react";
import { plural } from "../../../lab/format";
import type { RuleEntry } from "../../../lab/problems";
import type { Source } from "../../../lab/types";
import { cn } from "@/lib/utils";
import { Drawer } from "../../../ui/Drawer";
import { Skeleton } from "../../../ui/EmptyState";
import { ConnectionDrawer, useConnectionMemory } from "../Connection";
import { SourceText } from "../Code";
import { fileOf, useAgent, useParam, useQuoteContext } from "./shared";
import { PREVIEW_NAMES } from "./names";

const nameOf = (r: RuleEntry) => PREVIEW_NAMES[r.id] ?? r.title;
const shortTopic = (t: string) => t.split(",")[0].trim();
/** Muted hues for the topics of conversations, as Linear's labels: the dot and a faint tint carry the colour. */
const HUES = ["#6DB3F2", "#A57CF5", "#5FC98A", "#F0AD4E", "#4FCAE3", "#E28A80", "#C9B458"];

// ─── Pills ──────────────────────────────────────────────────────────────────

function Pill({ children, dot, hue, icon: Icon, mono, className, title }: {
  children: ReactNode; dot?: string; hue?: string; icon?: typeof Globe; mono?: boolean; className?: string; title?: string;
}) {
  return (
    <span title={title}
      className={cn("inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-full border px-2 text-[11px] leading-none", mono && "font-mono", className)}
      style={hue ? { background: `${hue}14`, borderColor: `${hue}33`, color: `color-mix(in srgb, ${hue} 55%, #e1e8ec)` } : undefined}>
      {dot && <span className="size-1.5 flex-shrink-0 rounded-full" style={{ background: dot }} />}
      {Icon && <Icon className="size-3 flex-shrink-0 opacity-80" />}
      <span className="truncate">{children}</span>
    </span>
  );
}
const neutral = "border-white/[0.1] bg-white/[0.04] text-lab-soft";

function Count({ n, className }: { n: number; className?: string }) {
  return <span className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-white/[0.1] px-1.5 text-[11px] tabular-nums text-lab-text", className)}>{n}</span>;
}

/** Orange pips, one per criterion: how much of a prompt became rules, at a glance. */
function Pips({ n, max = 12 }: { n: number; max?: number }) {
  if (!n) return <span className="text-[11px] text-lab-faint">—</span>;
  return (
    <span className="flex items-center gap-[3px]" title={`${n} ${plural(n, "критерий", "критерия", "критериев")}`}>
      {Array.from({ length: Math.min(n, max) }, (_, i) => <span key={i} className="size-[5px] rounded-full bg-lab-mark" />)}
      {n > max && <span className="ml-0.5 text-[10px] text-lab-mark">+{n - max}</span>}
    </span>
  );
}

// ─── Cards ──────────────────────────────────────────────────────────────────

function Card({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  const look = cn("rounded-xl border border-white/[0.08] bg-[rgb(35,35,35)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]", onClick && "text-left transition-[border-color,transform] hover:-translate-y-px hover:border-white/[0.16]", className);
  return onClick ? <button type="button" onClick={onClick} className={look}>{children}</button> : <div className={look}>{children}</div>;
}

function CardHead({ icon: Icon, title, count, action }: { icon: typeof Globe; title: string; count?: number; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-7 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04]"><Icon className="size-3.5 text-lab-soft" /></span>
      <span className="text-[13px] font-medium text-lab-ink">{title}</span>
      {count !== undefined && <Count n={count} />}
      <span className="ml-auto">{action}</span>
    </div>
  );
}

const Ghost = ({ onClick, icon: Icon, children, disabled }: { onClick: () => void; icon?: typeof Globe; children: ReactNode; disabled?: boolean }) => (
  <button type="button" onClick={onClick} disabled={disabled}
    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-white/[0.1] bg-white/[0.03] px-2.5 text-[12px] text-lab-soft transition-colors hover:border-white/[0.18] hover:text-lab-ink disabled:opacity-40">
    {Icon && <Icon className="size-3.5" />}{children}
  </button>
);

// ─── Criteria ───────────────────────────────────────────────────────────────

type Crit = { r: RuleEntry; every: boolean; hues: { topic: string; hue: string }[] };

function CritPills({ c, max = 2 }: { c: Crit; max?: number }) {
  if (c.every) return <Pill icon={Globe} className={neutral}>Во всех разговорах</Pill>;
  return (
    <>
      {c.hues.slice(0, max).map(h => <Pill key={h.topic} dot={h.hue} hue={h.hue} title={h.topic}>{shortTopic(h.topic)}</Pill>)}
      {c.hues.length > max && <Pill className={neutral}>+{c.hues.length - max}</Pill>}
    </>
  );
}

function CritCard({ c, onOpen }: { c: Crit; onOpen: () => void }) {
  const f = fileOf(c.r.rule);
  return (
    <Card onClick={onOpen} className="flex flex-col p-4">
      <div className="flex flex-wrap items-center gap-1.5"><CritPills c={c} /></div>
      <div className="mt-3 text-[15px] font-medium leading-[21px] text-lab-ink">{nameOf(c.r)}</div>
      <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-[19px] text-lab-dim">{c.r.rule.text}</p>
      <div className="mt-auto space-y-1.5 border-t border-white/[0.06] pt-3 text-[12px]" style={{ marginTop: 14 }}>
        {c.r.rule.acceptable && (
          <div className="flex items-start gap-2"><Check className="mt-[3px] size-3 flex-shrink-0 text-lab-ok" /><span className="line-clamp-1 text-lab-soft">{c.r.rule.acceptable}</span></div>
        )}
        {c.r.rule.condition && (
          <div className="flex items-start gap-2"><Clock className="mt-[3px] size-3 flex-shrink-0 text-lab-dim" /><span className="line-clamp-1 text-lab-mute">{c.r.rule.condition}</span></div>
        )}
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-lab-faint"><FileText className="size-3" /><span className="truncate font-mono">{f.file}</span></div>
    </Card>
  );
}

function CritDetail({ c, onClose, onSource }: { c: Crit | null; onClose: () => void; onSource: (id: string) => void }) {
  const { parts, loading } = useQuoteContext(c?.r, 320);
  const f = c ? fileOf(c.r.rule) : null;
  return (
    <Drawer open={!!c} onClose={onClose} title={c ? nameOf(c.r) : ""} sub={c ? "Критерий · что агент обязан делать" : undefined}>
      {c && f && (
        <div className="space-y-6 px-5 py-5">
          <div className="flex flex-wrap gap-1.5"><CritPills c={c} max={7} /></div>
          <p className="text-[15px] leading-[23px] text-lab-ink">{c.r.rule.text}</p>
          <div className="grid grid-cols-2 gap-3">
            <Card className="p-3.5">
              <div className="flex items-center gap-1.5 text-[11px] text-lab-ok"><Check className="size-3" />Так можно</div>
              <p className="mt-1.5 text-[13px] leading-[19px] text-lab-text">{c.r.rule.acceptable || "—"}</p>
            </Card>
            <Card className="p-3.5">
              <div className="flex items-center gap-1.5 text-[11px] text-lab-mute"><Clock className="size-3" />Когда проверяем</div>
              <p className="mt-1.5 text-[13px] leading-[19px] text-lab-text">{c.r.rule.condition || "Во всех разговорах"}</p>
            </Card>
          </div>
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-lab-mute">Как написано в промпте</span>
              {c.r.rule.sourceId && <button type="button" onClick={() => onSource(c.r.rule.sourceId!)} className="text-[12px] text-lab-mute hover:text-lab-ink">Весь промпт →</button>}
            </div>
            <div className="mt-2 whitespace-pre-line rounded-xl border border-lab-mark/[0.25] bg-[rgb(36,32,28)] px-4 py-3.5 text-[13px] leading-[21px] text-lab-mute">
              {loading ? <Skeleton className="h-24" /> : parts
                ? <>{parts[0]}<mark className="rounded-sm bg-lab-mark/[0.22] px-0.5 text-white">{parts[1]}</mark>{parts[2]}</>
                : <>«{c.r.rule.quote}»</>}
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-lab-dim"><FileText className="size-3" /><span className="font-mono">{f.file}{f.line && `:${f.line}`}</span></div>
          </div>
        </div>
      )}
    </Drawer>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

/** Вариант Д · «Детали»: a bento of cards for the agent, criteria as cards with topic pills; details in a sheet. */
export function VariantE() {
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
    const crits: Crit[] = a.rules.map(r => ({ r, every: topics.length > 0 && r.topics.length === topics.length, hues: r.topics.map(t => ({ topic: t, hue: hueOf.get(t)! })) }));
    crits.sort((x, y) => Number(y.every) - Number(x.every) || x.hues.length - y.hues.length);
    return { crits, topics };
  }, [a.rules]);

  if (!a.state) return <div className="p-6"><Skeleton className="h-64" /></div>;
  const criteria = tab === "criteria";
  const chosen = crits.find(c => c.r.id === rid) ?? null;
  const q = query.trim().toLowerCase();
  const shown = crits.filter(c => (!filter || (filter === "every" ? c.every : !c.every && c.r.topics.includes(filter)))
    && (!q || `${nameOf(c.r)} ${c.r.rule.text}`.toLowerCase().includes(q)));
  const maxChars = Math.max(1, ...a.prompts.map(s => s.chars));
  const usedTools = new Set(a.tools.filter(t => a.rules.some(r => `${r.rule.text} ${r.rule.acceptable}`.includes(t.name))).map(t => t.name));
  const checked = !!memory.last;

  const tabs = (
    <div className="flex items-center gap-0.5 rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
      {[{ key: null, icon: Bot, label: "Агент" }, { key: "criteria", icon: ListChecks, label: "Критерии", n: crits.length }].map(t => (
        <button key={t.label} type="button" onClick={() => setTab(t.key)}
          className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors", (t.key === "criteria") === criteria ? "bg-[rgb(52,52,52)] text-lab-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]" : "text-lab-mute hover:text-lab-text")}>
          <t.icon className="size-3.5" />{t.label}{t.n !== undefined && <span className="text-lab-dim">{t.n}</span>}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 flex-shrink-0 items-center gap-3 border-b border-white/[0.08] px-4">
        <span className="flex size-6 items-center justify-center rounded-md bg-[linear-gradient(135deg,#F5B461,#E8912D_50%,#B8602A)]"><Bot className="size-3.5 text-black/80" /></span>
        <span className="text-[13px] font-medium text-lab-ink">Агент эквайринга</span>
        <span className="text-lab-faint">/</span>
        {tabs}
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {!criteria ? (
          <div className="mx-auto grid max-w-[1160px] grid-cols-12 gap-3 px-6 pb-16 pt-6">
            {/* Hero */}
            <Card className="col-span-12 flex flex-col p-6 lg:col-span-8">
              <div className="flex items-start gap-4">
                <span className="flex size-14 flex-shrink-0 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#F5B461,#E8912D_50%,#B8602A)] shadow-[0_8px_24px_-8px_rgba(232,145,45,0.6)]"><Bot className="size-7 text-black/80" /></span>
                <div className="min-w-0 flex-1">
                  <h1 className="text-[24px] font-semibold leading-[30px] tracking-[-0.5px] text-lab-ink">Агент эквайринга</h1>
                  <p className="mt-1 text-[13px] text-lab-dim">Отвечает клиентам СберБизнеса в чате поддержки</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Pill dot={checked ? "#74b98e" : "#8e969b"} className={checked ? "border-lab-ok/30 bg-lab-ok/[0.1] text-lab-ok" : neutral} title={checked ? "Отвечал при последней проверке" : "Ещё не проверялся"}>{a.way ?? "Не подключён"}</Pill>
                    <Pill icon={Globe} className={neutral}>СберБизнес</Pill>
                    <Pill className={neutral}>Чат поддержки</Pill>
                  </div>
                </div>
              </div>
              <div className="mt-8 grid grid-cols-3 gap-3">
                {[
                  { n: a.prompts.length, w: plural(a.prompts.length, "промпт", "промпта", "промптов"), sub: "что ему велено" },
                  { n: a.tools.length, w: plural(a.tools.length, "система банка", "системы банка", "систем банка"), sub: "что он вызывает" },
                  { n: a.rules.length, w: plural(a.rules.length, "критерий", "критерия", "критериев"), sub: "что обязан соблюдать", go: true },
                ].map(s => (
                  <button key={s.w} type="button" disabled={!s.go} onClick={() => setTab("criteria")}
                    className={cn("group rounded-lg border px-3.5 py-3 text-left transition-colors", s.go ? "border-lab-mark/[0.3] bg-lab-mark/[0.06] hover:border-lab-mark/[0.5]" : "border-white/[0.06] bg-white/[0.02]")}>
                    <div className="flex items-baseline gap-1.5">
                      <span className={cn("text-[26px] font-medium leading-[32px] tracking-[-0.6px]", s.go ? "text-[rgb(255,212,163)]" : "text-lab-ink")}>{s.n}</span>
                      <span className="text-[13px] text-lab-text">{s.w}</span>
                      {s.go && <ArrowRight className="ml-auto size-3.5 text-lab-mark transition-transform group-hover:translate-x-0.5" />}
                    </div>
                    <div className="text-[11px] text-lab-dim">{s.sub}</div>
                  </button>
                ))}
              </div>
            </Card>

            {/* Connection + code */}
            <div className="col-span-12 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:col-span-4 lg:grid-cols-1">
              <Card className="p-4">
                <CardHead icon={PlugZap} title="Подключение" action={<Ghost onClick={() => setConnecting(true)}>Изменить</Ghost>} />
                <div className="mt-3 text-[15px] text-lab-ink">{a.way ?? "Не подключён"}</div>
                {a.address && <div className="mt-2"><Pill mono dot={checked ? "#74b98e" : "#8e969b"} className={cn(neutral, "rounded-md")} title={a.address}>{a.address.replace(/^https?:\/\//, "")}</Pill></div>}
              </Card>
              <Card className="p-4">
                <CardHead icon={FolderGit2} title="Код агента" action={<Ghost icon={RotateCcw} onClick={a.read} disabled={a.busy || !a.repo}>Заново</Ghost>} />
                <div className="mt-3"><Pill mono icon={FolderGit2} className={cn(neutral, "rounded-md")}>{a.repo || "папка не указана"}</Pill></div>
                <div className="mt-2 text-[12px] text-lab-dim">{a.readDate ? `Прочитан ${a.readDate}` : "Прочитан из папки с кодом"}</div>
              </Card>
            </div>

            {/* Prompts */}
            <Card className="col-span-12 p-4 lg:col-span-7">
              <CardHead icon={FileText} title="Промпты" count={a.prompts.length} />
              <ul className="mt-3 space-y-0.5">
                {a.prompts.map(s => {
                  const f = fileOf(s);
                  return (
                    <li key={s.id}>
                      <button type="button" onClick={() => setOpen(s)} className="grid w-full grid-cols-[minmax(0,1fr)_110px_90px] items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]">
                        <span className="truncate font-mono text-[12px] text-lab-soft">{f.file}</span>
                        <span className="h-1 overflow-hidden rounded-full bg-white/[0.06]"><span className="block h-full rounded-full bg-white/25" style={{ width: `${(100 * s.chars) / maxChars}%` }} /></span>
                        <span className="flex justify-end"><Pips n={s.rules} max={8} /></span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-2 flex items-center gap-4 px-2 text-[11px] text-lab-dim">
                <span className="flex items-center gap-1.5"><span className="h-1 w-5 rounded-full bg-white/25" />длина</span>
                <span className="flex items-center gap-1.5"><span className="size-[5px] rounded-full bg-lab-mark" />критерий из промпта</span>
              </div>
            </Card>

            {/* Tools */}
            <Card className="col-span-12 p-4 lg:col-span-5">
              <CardHead icon={Database} title="Системы банка" count={a.tools.length} action={a.toolsSource && <Ghost onClick={() => setOpen(a.toolsSource!)}>Откуда</Ghost>} />
              <p className="mt-2 text-[12px] text-lab-dim">Инструменты, которые агент вызывает, чтобы ответить клиенту</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {a.tools.map(t => (
                  <Pill key={t.name} mono icon={Database} dot={usedTools.has(t.name) ? "#E8912D" : undefined} title={usedTools.has(t.name) ? `${t.env} · есть критерий` : t.env}
                    className={cn("rounded-md", usedTools.has(t.name) ? "border-lab-mark/[0.35] bg-lab-mark/[0.08] text-[rgb(255,212,163)]" : neutral)}>{t.name}</Pill>
                ))}
              </div>
            </Card>
          </div>
        ) : (
          <div className="mx-auto max-w-[1160px] px-6 pb-16 pt-6">
            <div className="flex flex-wrap items-end gap-4">
              <div className="min-w-0 flex-1">
                <h1 className="flex items-center gap-2.5 text-[22px] font-semibold tracking-[-0.4px] text-lab-ink">Критерии <Count n={crits.length} className="h-5 text-[12px]" /></h1>
                <p className="mt-1 text-[13px] text-lab-dim">Что агент обязан делать. Каждый критерий — фраза из его промпта.</p>
              </div>
              <label className="flex h-8 w-[240px] items-center gap-2 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 focus-within:border-white/[0.22]">
                <Search className="size-3.5 text-lab-dim" />
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Найти критерий" className="min-w-0 flex-1 bg-transparent text-[12px] text-lab-ink outline-none placeholder:text-lab-faint" />
              </label>
            </div>
            <div className="mt-5 flex flex-wrap gap-1.5">
              {[{ key: null as string | null, label: "Все", n: crits.length }, { key: "every", label: "Во всех разговорах", n: crits.filter(c => c.every).length, icon: Globe },
                ...topics.map(t => ({ key: t.topic, label: shortTopic(t.topic), hue: t.hue, n: crits.filter(c => !c.every && c.r.topics.includes(t.topic)).length }))].map(o => {
                const on = filter === o.key;
                const hue = "hue" in o ? o.hue : undefined;
                const Icon = "icon" in o ? o.icon : undefined;
                return (
                  <button key={o.label} type="button" onClick={() => setFilter(on ? null : o.key)} title={o.key && o.key !== "every" ? o.key : undefined}
                    className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors", on ? "border-white/[0.3] bg-white/[0.1] text-lab-ink" : "border-white/[0.08] text-lab-mute hover:border-white/[0.16] hover:text-lab-text")}>
                    {hue && <span className="size-1.5 rounded-full" style={{ background: hue }} />}
                    {Icon && <Icon className="size-3" />}
                    {o.label}<span className="text-lab-dim">{o.n}</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
              {shown.map(c => <CritCard key={c.r.id} c={c} onOpen={() => setRid(c.r.id)} />)}
            </div>
            {!shown.length && <p className="mt-10 text-center text-[13px] text-lab-dim">Ничего не нашлось</p>}
          </div>
        )}
      </div>

      <CritDetail c={chosen} onClose={() => setRid(null)} onSource={id => setOpen(a.sources.find(s => s.id === id) ?? null)} />
      <ConnectionDrawer open={connecting} onClose={() => setConnecting(false)} state={a.state} />
      <SourceText source={open} rules={open ? a.bySource.get(open.id) ?? [] : []} onClose={() => setOpen(null)} />
    </div>
  );
}
