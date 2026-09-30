import { useState, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";
import { plural, thousands } from "../../../lab/format";
import type { RuleEntry } from "../../../lab/problems";
import type { Source } from "../../../lab/types";
import { cn } from "@/lib/utils";
import { Skeleton } from "../../../ui/EmptyState";
import { ConnectionDrawer } from "../Connection";
import { SourceText } from "../Code";
import { fileOf, useAgent, useParam, useQuoteContext } from "./shared";

/** Raindrop's pill tabs («Recommended · First · Latest»): the chosen one on a raised fill. */
function Pills<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-1">
      {options.map(o => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={cn("h-7 rounded-md px-2.5 text-[12px] transition-colors", o.value === value ? "bg-[rgb(48,48,48)] text-lab-ink" : "text-lab-mute hover:text-lab-text")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Raindrop's boxed numbers under the issue title: a small label over a big value, cells split by hairlines. */
function Stats({ cells }: { cells: { label: string; value: ReactNode; onClick?: () => void }[] }) {
  return (
    <div className="mt-5 grid grid-cols-3 overflow-hidden rounded-lg border border-white/[0.1]">
      {cells.map((c, i) => (
        <button key={c.label} type="button" onClick={c.onClick} disabled={!c.onClick}
          className={cn("px-3 py-2.5 text-left transition-colors enabled:hover:bg-white/[0.03]", i > 0 && "border-l border-white/[0.1]")}>
          <div className="text-[11px] text-lab-dim">{c.label}</div>
          <div className="mt-1 text-[20px] leading-[26px] text-lab-ink">{c.value}</div>
        </button>
      ))}
    </div>
  );
}

function Detail({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] items-baseline gap-x-3 text-[13px]">
      <dt className="text-[11px] text-lab-mute">{label}</dt>
      <dd className="min-w-0 truncate text-lab-soft" title={title}>{children}</dd>
    </div>
  );
}

function Contract({ r, onClose }: { r: RuleEntry; onClose: () => void }) {
  const { parts, loading } = useQuoteContext(r, 160);
  const f = fileOf(r.rule);
  return (
    <aside className="w-[440px] flex-shrink-0 overflow-auto border-l border-white/[0.08] bg-lab-surface">
      <div className="flex items-start gap-3 px-5 pb-2 pt-4">
        <h2 className="min-w-0 flex-1 text-[15px] font-medium leading-[22px] text-lab-ink">{r.rule.text}</h2>
        <button type="button" onClick={onClose} aria-label="Закрыть" className="rounded p-1 text-lab-dim hover:bg-white/[0.08] hover:text-lab-text"><X className="size-4" /></button>
      </div>
      <dl className="space-y-2.5 px-5 pt-2">
        {r.rule.condition && <div><dt className="text-[11px] text-lab-mute">Когда действует</dt><dd className="mt-0.5 text-[13px] text-lab-text">{r.rule.condition}</dd></div>}
        {r.rule.acceptable && <div><dt className="text-[11px] text-lab-mute">Что не считается нарушением</dt><dd className="mt-0.5 text-[13px] text-lab-text">{r.rule.acceptable}</dd></div>}
        <div><dt className="text-[11px] text-lab-mute">Источник</dt><dd className="mt-0.5 truncate font-mono text-[12px] text-lab-soft">{f.file}{f.line && `:${f.line}`}</dd></div>
      </dl>
      <div className="mx-5 mt-4 rounded-lg bg-lab-raised whitespace-pre-line px-3.5 py-3 text-[13px] leading-[20px] text-lab-mute">
        {loading ? <Skeleton className="h-16" /> : parts
          ? <>{parts[0]}<mark className="rounded-sm bg-lab-mark/[0.17] px-0.5 text-lab-ink">{parts[1]}</mark>{parts[2]}</>
          : <>«{r.rule.quote}»</>}
      </div>
    </aside>
  );
}

/** Вариант Б · «Raindrop»: the issue page — the object with its numbers on the left, its parts on the right; criteria as the Issues table. */
export function VariantB() {
  const a = useAgent();
  const [tab, setTab] = useParam("t");
  const [rid, setRid] = useParam("c");
  const [part, setPart] = useState<"prompts" | "tools">("prompts");
  const [open, setOpen] = useState<Source | null>(null);
  const [connecting, setConnecting] = useState(false);
  if (!a.state) return <div className="p-6"><Skeleton className="h-64" /></div>;
  const criteria = tab === "criteria";
  const rule = a.rules.find(r => r.id === rid);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 flex-shrink-0 items-center gap-4 border-b border-white/[0.08] px-4">
        <span className="text-[13px] font-medium text-lab-ink">Агент эквайринга</span>
        <Pills value={criteria ? "criteria" : "agent"} onChange={v => setTab(v === "criteria" ? "criteria" : null)}
          options={[{ value: "agent", label: "Агент" }, { value: "criteria", label: <>Критерии <span className="text-lab-dim">{a.rules.length}</span></> }]} />
      </header>

      {!criteria ? (
        <div className="flex min-h-0 flex-1">
          <aside className="w-[440px] flex-shrink-0 overflow-auto border-r border-white/[0.08] px-[18px] pb-6 pt-4">
            <button type="button" onClick={() => setConnecting(true)}
              className="inline-flex h-6 items-center gap-1.5 rounded border border-lab-ok/40 bg-lab-ok/[0.1] px-2 text-[11px] text-lab-ok">
              <span className="size-1.5 rounded-full bg-lab-ok" />{a.way ?? "Не подключён"}<ChevronDown className="size-3" />
            </button>
            <h1 className="mt-3 text-[20px] leading-[26px] text-lab-ink">Агент эквайринга</h1>
            <p className="mt-1 text-[13px] text-lab-dim">Отвечает клиентам СберБизнеса в чате поддержки</p>
            <Stats cells={[
              { label: "Промпты", value: a.prompts.length, onClick: () => setPart("prompts") },
              { label: "Инструменты", value: a.tools.length, onClick: () => setPart("tools") },
              { label: "Критерии", value: a.rules.length, onClick: () => setTab("criteria") },
            ]} />
            <h2 className="mt-6 text-[13px] font-semibold text-lab-ink">Детали</h2>
            <dl className="mt-2.5 space-y-1.5">
              <Detail label="Где работает">{a.way ?? "—"}</Detail>
              <Detail label="Адрес" title={a.address}><span className="font-mono text-[12px]">{a.address.replace(/^https?:\/\//, "") || "—"}</span></Detail>
              <Detail label="Код">{a.repo || "—"}</Detail>
              <Detail label="Прочитан">{a.readDate || "—"}</Detail>
            </dl>
            <div className="mt-5 flex gap-2">
              <button type="button" onClick={() => setConnecting(true)} className="h-7 rounded-md border border-white/[0.15] bg-[rgb(40,40,40)] px-2.5 text-[12px] text-lab-text hover:bg-[rgb(48,48,48)]">Изменить подключение</button>
              <button type="button" onClick={a.read} disabled={a.busy || !a.repo} className="h-7 rounded-md px-2.5 text-[12px] text-lab-mute hover:bg-white/[0.06] hover:text-lab-text disabled:opacity-40">Прочитать код заново</button>
            </div>
          </aside>
          <section className="min-w-0 flex-1 overflow-auto">
            <div className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-2">
              <Pills value={part} onChange={setPart} options={[
                { value: "prompts", label: <>Промпты <span className="text-lab-dim">{a.prompts.length}</span></> },
                { value: "tools", label: <>Инструменты <span className="text-lab-dim">{a.tools.length}</span></> },
              ]} />
            </div>
            {part === "prompts" ? (
              <ul>
                {a.prompts.map(s => {
                  const f = fileOf(s);
                  return (
                    <li key={s.id}>
                      <button type="button" onClick={() => setOpen(s)} className="flex w-full items-center gap-4 border-b border-white/[0.06] px-4 py-2.5 text-left transition-colors hover:bg-lab-hover">
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-lab-text">{f.file}<span className="text-lab-dim">{f.line && `:${f.line}`}</span></span>
                        <span className="w-[120px] flex-shrink-0 text-right text-[12px] text-lab-dim">{thousands(s.chars)}</span>
                        <span className={cn("w-[100px] flex-shrink-0 text-right text-[12px]", s.rules ? "text-lab-text" : "text-lab-faint")}>{s.rules ? `${s.rules} ${plural(s.rules, "критерий", "критерия", "критериев")}` : "—"}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <ul>
                {a.tools.map(t => (
                  <li key={t.name} className="flex items-center gap-4 border-b border-white/[0.06] px-4 py-2.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-lab-text">{t.name}</span>
                    <span className="flex-shrink-0 font-mono text-[11px] text-lab-faint">{t.env}</span>
                  </li>
                ))}
                {a.toolsSource && <li className="px-4 py-3"><button type="button" onClick={() => setOpen(a.toolsSource!)} className="text-[12px] text-lab-mute hover:text-lab-ink">Как это прочитано из кода →</button></li>}
              </ul>
            )}
          </section>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-auto">
            <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)_200px] gap-4 border-b border-white/[0.08] bg-lab-bg px-4 py-2 text-[11px] text-lab-dim">
              <span>Критерий</span><span>Когда действует</span><span>Источник</span>
            </div>
            {a.groups.map(g => (
              <section key={g.title}>
                <div className="flex items-center gap-2 border-b border-white/[0.06] bg-lab-surface px-4 py-1.5 text-[12px] text-lab-mute">
                  <span className="truncate">{g.title}</span><span className="text-lab-faint">{g.rules.length}</span>
                </div>
                {g.rules.map(({ r }) => {
                  const f = fileOf(r.rule);
                  return (
                    <button key={r.id} type="button" onClick={() => setRid(r.id === rid ? null : r.id)} aria-current={r.id === rid || undefined}
                      className={cn("grid w-full grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)_200px] items-center gap-4 border-b border-white/[0.06] px-4 py-2 text-left transition-colors",
                        r.id === rid ? "bg-lab-active" : "hover:bg-lab-hover")}>
                      <span className="truncate text-[13px] text-lab-ink">{r.rule.text}</span>
                      <span className="truncate text-[12px] text-lab-dim">{r.rule.condition || "—"}</span>
                      <span className="truncate font-mono text-[11px] text-lab-dim">{f.file}{f.line && `:${f.line}`}</span>
                    </button>
                  );
                })}
              </section>
            ))}
          </div>
          {rule && <Contract key={rule.id} r={rule} onClose={() => setRid(null)} />}
        </div>
      )}
      <ConnectionDrawer open={connecting} onClose={() => setConnecting(false)} state={a.state} />
      <SourceText source={open} rules={open ? a.bySource.get(open.id) ?? [] : []} onClose={() => setOpen(null)} />
    </div>
  );
}
