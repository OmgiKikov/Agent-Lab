import { useState, type ReactNode } from "react";
import { FileText, PlugZap, RotateCcw, Wrench } from "lucide-react";
import { plural, thousands } from "../../../lab/format";
import { useSource, type RuleEntry } from "../../../lab/problems";
import type { Source } from "../../../lab/types";
import { cn } from "@/lib/utils";
import { Button } from "../../../ui/Button";
import { MarkNumber } from "../../../ui/Conversation";
import { Skeleton } from "../../../ui/EmptyState";
import { segments } from "../../../ui/highlight";
import { ConnectionDrawer } from "../Connection";
import { fileOf, useAgent, useParam, useQuoteContext } from "./shared";

/** Workshop's trace-header chip: a small uppercase key and its value. */
function Chip({ k, children }: { k: string; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="rounded bg-white/[0.09] px-1 text-[9px] font-medium uppercase leading-4 tracking-wide text-lab-dim">{k}</span>
      <span className="truncate text-[12px] text-lab-soft">{children}</span>
    </span>
  );
}
const Dot = () => <span aria-hidden className="text-lab-faint">·</span>;

/** Workshop's run-list row: rounded, the selected one lifted with a hairline. */
function Row({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-current={selected || undefined}
      className={cn("block w-full rounded-lg border p-2.5 text-left transition-colors",
        selected ? "border-white/[0.15] bg-white/[0.08]" : "border-transparent hover:bg-white/[0.04]")}>
      {children}
    </button>
  );
}

function SourceView({ source, rules, onRule }: { source: Source; rules: RuleEntry[]; onRule: (id: string) => void }) {
  const { data, isLoading } = useSource(source.id);
  const pieces = data ? segments(data.content, rules.map((r, i) => ({ quote: r.rule.quote, n: i + 1 }))) : [];
  const f = fileOf(source);
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/[0.08] bg-lab-bg/95 px-6 py-2.5 backdrop-blur">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-lab-dim" title={source.origin}>{source.origin}</span>
        <span className="flex-shrink-0 text-[12px] text-lab-mute">{rules.length ? `${rules.length} ${plural(rules.length, "критерий отмечен", "критерия отмечены", "критериев отмечены")} в тексте` : "критериев из него нет"}</span>
      </div>
      {isLoading && <div className="p-6"><Skeleton className="h-96" /></div>}
      {data && (
        <pre className="max-w-[860px] whitespace-pre-wrap px-6 py-5 font-sans text-[13px] leading-[21px] text-lab-mute" aria-label={f.file}>
          {pieces.map((p, i) => p.n
            ? <mark key={i} title={rules[p.n - 1]?.rule.text} className="rounded-sm bg-lab-mark/[0.17] px-0.5 text-lab-ink">{p.text}<button type="button" onClick={() => onRule(rules[p.n! - 1].id)} className="ml-1 inline-block translate-y-[-1px] align-middle"><MarkNumber n={p.n} /></button></mark>
            : <span key={i}>{p.text}</span>)}
        </pre>
      )}
    </div>
  );
}

function RuleView({ r, onSource }: { r: RuleEntry; onSource: (id: string) => void }) {
  const { parts, loading } = useQuoteContext(r);
  const f = fileOf(r.rule);
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="max-w-[760px] px-6 py-5">
        <h2 className="text-[17px] font-medium leading-[24px] text-lab-ink">{r.rule.text}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Chip k="Источник">{f.file}{f.line && `:${f.line}`}</Chip>
        </div>
        <dl className="mt-5 grid grid-cols-[170px_minmax(0,1fr)] gap-x-4 gap-y-3 text-[13px]">
          {r.rule.condition && <><dt className="text-lab-dim">Когда действует</dt><dd className="text-lab-text">{r.rule.condition}</dd></>}
          {r.rule.acceptable && <><dt className="text-lab-dim">Не нарушение</dt><dd className="text-lab-text">{r.rule.acceptable}</dd></>}
        </dl>
        <div className="mt-6 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-lab-dim">В промпте</span>
          {r.rule.sourceId && <button type="button" onClick={() => onSource(r.rule.sourceId!)} className="text-[12px] text-lab-mute hover:text-lab-ink">Открыть промпт →</button>}
        </div>
        <div className="mt-2 rounded-lg border border-white/[0.08] bg-lab-raised whitespace-pre-line px-4 py-3 text-[13px] leading-[21px] text-lab-mute">
          {loading ? <Skeleton className="h-16" /> : parts
            ? <>{parts[0]}<mark className="rounded-sm bg-lab-mark/[0.17] px-0.5 text-lab-ink">{parts[1]}</mark>{parts[2]}</>
            : <>«{r.rule.quote}»</>}
        </div>
      </div>
    </div>
  );
}

/** Вариант А · «Workshop»: the trace page — a header with chips, tabs, the list on the left and the item on the right. */
export function VariantA() {
  const a = useAgent();
  const [tab, setTab] = useParam("t");
  const [sel, setSel] = useParam("s");
  const [rid, setRid] = useParam("c");
  const [connecting, setConnecting] = useState(false);
  if (!a.state) return <div className="p-6"><Skeleton className="h-64" /></div>;
  const criteria = tab === "criteria";
  const source = a.sources.find(s => s.id === sel) ?? a.sources[0];
  const rule = a.rules.find(r => r.id === rid) ?? a.groups[0]?.rules[0]?.r;
  const openRule = (id: string) => { setTab("criteria"); setRid(id); };
  const openSource = (id: string) => { setTab(null); setSel(id); };
  const tabBtn = (on: boolean, label: ReactNode, go: () => void) => (
    <button type="button" onClick={go} className={cn("-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors", on ? "border-lab-ink text-lab-ink" : "border-transparent text-lab-dim hover:text-lab-text")}>{label}</button>
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex-shrink-0 border-b border-white/[0.08] px-4 pb-2.5 pt-3">
        <div className="flex items-center gap-2">
          <h1 className="min-w-0 flex-1 truncate text-[17px] font-medium text-lab-ink">Агент эквайринга</h1>
          <Button icon={PlugZap} onClick={() => setConnecting(true)}>Подключение</Button>
          <Button icon={RotateCcw} onClick={a.read} loading={a.reading} disabled={a.busy || !a.repo}>Прочитать код заново</Button>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Chip k="Где работает">{a.way ?? "не подключён"}</Chip><Dot />
          <Chip k="Код">{a.repo.split("/").pop() || "не указан"}{a.readDate && `, ${a.readDate}`}</Chip><Dot />
          <Chip k="Промпты">{a.prompts.length}</Chip><Dot />
          <Chip k="Инструменты">{a.tools.length}</Chip><Dot />
          <Chip k="Критерии">{a.rules.length}</Chip>
        </div>
      </header>
      <nav className="flex flex-shrink-0 gap-1 border-b border-white/[0.08] px-3">
        {tabBtn(!criteria, "Агент", () => setTab(null))}
        {tabBtn(criteria, <>Критерии <span className="ml-1 text-lab-dim">{a.rules.length}</span></>, () => setTab("criteria"))}
      </nav>

      <div className="flex min-h-0 flex-1">
        {!criteria ? (
          <>
            <aside className="w-[300px] flex-shrink-0 space-y-0.5 overflow-auto border-r border-white/[0.08] p-2">
              <div className="px-2.5 pb-1 pt-2 text-[11px] text-lab-dim">Прочитано из кода агента</div>
              {a.sources.map(s => {
                const f = fileOf(s);
                const Icon = s.kind === "tools" ? Wrench : FileText;
                return (
                  <Row key={s.id} selected={s.id === source?.id} onClick={() => setSel(s.id)}>
                    <div className="flex items-center gap-2">
                      <Icon className="size-3.5 flex-shrink-0 text-lab-dim" />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-lab-text">{f.file}{f.line && <span className="font-normal text-lab-dim">:{f.line}</span>}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 pl-[22px] text-[11px]">
                      <span className="text-lab-dim">{s.kind === "tools" ? `${a.tools.length} ${plural(a.tools.length, "инструмент", "инструмента", "инструментов")}` : thousands(s.chars)}</span>
                      <span className={cn("ml-auto", s.rules ? "text-lab-soft" : "text-lab-faint")}>{s.rules ? `${s.rules} ${plural(s.rules, "критерий", "критерия", "критериев")}` : "—"}</span>
                    </div>
                  </Row>
                );
              })}
            </aside>
            {source && <SourceView key={source.id} source={source} rules={a.bySource.get(source.id) ?? []} onRule={openRule} />}
          </>
        ) : (
          <>
            <aside className="w-[440px] flex-shrink-0 overflow-auto border-r border-white/[0.08] p-2">
              {a.groups.map(g => (
                <section key={g.title} className="mb-2">
                  <div className="truncate px-2.5 pb-1 pt-2 text-[11px] text-lab-dim">{g.title}</div>
                  {g.rules.map(({ r }) => (
                    <Row key={r.id} selected={r.id === rule?.id} onClick={() => setRid(r.id)}>
                      <span className="block truncate text-[13px] text-lab-text">{r.rule.text}</span>
                    </Row>
                  ))}
                </section>
              ))}
            </aside>
            {rule && <RuleView key={rule.id} r={rule} onSource={openSource} />}
          </>
        )}
      </div>
      <ConnectionDrawer open={connecting} onClose={() => setConnecting(false)} state={a.state} />
    </div>
  );
}
