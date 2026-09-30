import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { plural } from "../../../lab/format";
import type { RuleEntry } from "../../../lab/problems";
import type { Source } from "../../../lab/types";
import { cn } from "@/lib/utils";
import { SectionHeader } from "../../../shell/SectionHeader";
import { Skeleton } from "../../../ui/EmptyState";
import { ConnectionDrawer } from "../Connection";
import { SourceText } from "../Code";
import { fileOf, useAgent, useParam, useQuoteContext } from "./shared";

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-white/[0.08] py-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[13px] font-semibold text-lab-ink">{title}</h2>
        {action}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

const Action = ({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) => (
  <button type="button" onClick={onClick} disabled={disabled} className="flex-shrink-0 text-[12px] text-lab-mute transition-colors hover:text-lab-ink disabled:opacity-40">{children}</button>
);

function Expanded({ r, onSource }: { r: RuleEntry; onSource: (id: string) => void }) {
  const { parts, loading } = useQuoteContext(r, 140);
  const f = fileOf(r.rule);
  return (
    <div className="mb-2 ml-8 mt-1 space-y-3 rounded-lg bg-lab-raised px-4 py-3.5">
      {r.rule.condition && <div className="text-[12px]"><span className="text-lab-dim">Когда действует. </span><span className="text-lab-soft">{r.rule.condition}</span></div>}
      {r.rule.acceptable && <div className="text-[12px]"><span className="text-lab-dim">Не нарушение. </span><span className="text-lab-soft">{r.rule.acceptable}</span></div>}
      <blockquote className="border-l-2 border-lab-mark/60 whitespace-pre-line pl-3 text-[12px] leading-[19px] text-lab-mute">
        {loading ? <Skeleton className="h-10" /> : parts
          ? <>{parts[0]}<span className="text-lab-ink">{parts[1]}</span>{parts[2]}</>
          : <>«{r.rule.quote}»</>}
      </blockquote>
      <div className="text-[11px] text-lab-dim">
        {f.file}{f.line && `:${f.line}`}
        {r.rule.sourceId && <> · <button type="button" onClick={() => onSource(r.rule.sourceId!)} className="underline decoration-white/20 underline-offset-2 hover:text-lab-text">весь промпт</button></>}
      </div>
    </div>
  );
}

/** Вариант В · «Документ»: one calm column to read top to bottom; criteria as a numbered contract that opens in place. */
export function VariantC() {
  const a = useAgent();
  const [tab, setTab] = useParam("t");
  const [rid, setRid] = useParam("c");
  const [open, setOpen] = useState<Source | null>(null);
  const [connecting, setConnecting] = useState(false);
  if (!a.state) return <div className="p-6"><Skeleton className="h-64" /></div>;
  const criteria = tab === "criteria";
  const openSource = (id: string) => setOpen(a.sources.find(s => s.id === id) ?? null);
  let n = 0;

  return (
    <div className="flex h-full flex-col">
      <SectionHeader crumbs={[{ label: "Агент" }]} />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[760px] px-6 pb-24 pt-10">
          <h1 className="text-[24px] font-semibold leading-[30px] tracking-[-0.4px] text-lab-ink">Агент эквайринга</h1>
          <p className="mt-1.5 text-[14px] text-lab-dim">Отвечает клиентам СберБизнеса в чате поддержки</p>

          <nav className="mt-7 flex gap-5 border-b border-white/[0.08]">
            {[{ on: !criteria, label: "Агент", go: () => setTab(null) }, { on: criteria, label: `Критерии · ${a.rules.length}`, go: () => setTab("criteria") }].map(t => (
              <button key={t.label} type="button" onClick={t.go}
                className={cn("-mb-px border-b-2 pb-2.5 text-[13px] transition-colors", t.on ? "border-lab-ink text-lab-ink" : "border-transparent text-lab-dim hover:text-lab-text")}>{t.label}</button>
            ))}
          </nav>

          {!criteria ? (
            <div className="pt-2">
              <div className="grid grid-cols-3 gap-6 py-6">
                {[
                  { n: a.prompts.length, w: plural(a.prompts.length, "промпт", "промпта", "промптов"), sub: "что ему велено" },
                  { n: a.tools.length, w: plural(a.tools.length, "инструмент", "инструмента", "инструментов"), sub: "системы банка, которые он вызывает" },
                  { n: a.rules.length, w: plural(a.rules.length, "критерий", "критерия", "критериев"), sub: "что он обязан соблюдать", go: () => setTab("criteria") },
                ].map(c => (
                  <button key={c.w} type="button" onClick={c.go} disabled={!c.go} className="group text-left">
                    <div className="text-[28px] font-medium leading-[34px] tracking-[-0.6px] text-lab-ink">{c.n}</div>
                    <div className="text-[13px] text-lab-text">{c.w}{c.go && <ChevronRight className="ml-0.5 inline size-3.5 text-lab-dim transition-transform group-hover:translate-x-0.5" />}</div>
                    <div className="mt-0.5 text-[12px] text-lab-dim">{c.sub}</div>
                  </button>
                ))}
              </div>

              <Section title="Где работает" action={<Action onClick={() => setConnecting(true)}>Изменить</Action>}>
                <div className="text-[13px] text-lab-text">{a.way ?? "Не подключён"}</div>
                {a.address && <div className="mt-0.5 truncate font-mono text-[11px] text-lab-faint" title={a.address}>{a.address}</div>}
              </Section>

              <Section title="Промпты" action={<Action onClick={a.read} disabled={a.busy || !a.repo}>Прочитать заново</Action>}>
                <p className="text-[12px] text-lab-dim">Прочитаны из кода агента{a.repo && ` (${a.repo})`}{a.readDate && `, ${a.readDate}`}.</p>
                <ul className="mt-3">
                  {a.prompts.map(s => {
                    const f = fileOf(s);
                    return (
                      <li key={s.id}>
                        <button type="button" onClick={() => setOpen(s)} className="group flex w-full items-baseline gap-2 py-1 text-left">
                          <span className="truncate font-mono text-[12px] text-lab-soft group-hover:text-lab-ink">{f.file}<span className="text-lab-faint">{f.line && `:${f.line}`}</span></span>
                          <span aria-hidden className="min-w-4 flex-1 translate-y-[-3px] border-b border-dotted border-white/[0.14]" />
                          <span className={cn("flex-shrink-0 text-[12px]", s.rules ? "text-lab-text" : "text-lab-faint")}>{s.rules ? `${s.rules} ${plural(s.rules, "критерий", "критерия", "критериев")}` : "без критериев"}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Section>

              <Section title="Инструменты" action={a.toolsSource && <Action onClick={() => setOpen(a.toolsSource!)}>Откуда</Action>}>
                <div className="flex flex-wrap gap-1.5">
                  {a.tools.map(t => <span key={t.name} title={t.env} className="rounded border border-white/[0.1] bg-lab-raised px-1.5 py-0.5 font-mono text-[11px] text-lab-soft">{t.name}</span>)}
                </div>
              </Section>
            </div>
          ) : (
            <div className="pt-6">
              <p className="text-[13px] text-lab-dim">Что агент обязан соблюдать. Каждое правило взято из его промпта дословно.</p>
              {a.groups.map(g => (
                <section key={g.title} className="mt-7">
                  <h2 className="text-[13px] font-semibold text-lab-ink">{g.title}</h2>
                  <ol className="mt-2">
                    {g.rules.map(({ r }) => {
                      n += 1;
                      const on = r.id === rid;
                      return (
                        <li key={r.id}>
                          <button type="button" onClick={() => setRid(on ? null : r.id)} aria-expanded={on}
                            className={cn("flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left transition-colors", on ? "bg-white/[0.05]" : "hover:bg-white/[0.03]")}>
                            <span className="w-6 flex-shrink-0 text-right text-[12px] tabular-nums text-lab-faint">{n}</span>
                            <span className={cn("min-w-0 flex-1 text-[13px] leading-[20px]", on ? "text-lab-ink" : "truncate text-lab-text")}>{r.rule.text}</span>
                            <ChevronRight className={cn("size-3.5 flex-shrink-0 translate-y-[2px] text-lab-faint transition-transform", on && "rotate-90")} />
                          </button>
                          {on && <Expanded r={r} onSource={openSource} />}
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
      <ConnectionDrawer open={connecting} onClose={() => setConnecting(false)} state={a.state} />
      <SourceText source={open} rules={open ? a.bySource.get(open.id) ?? [] : []} onClose={() => setOpen(null)} />
    </div>
  );
}
