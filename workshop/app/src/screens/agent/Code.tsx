import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, FileText, Wrench } from "lucide-react";
import { plural, thousands } from "../../lab/format";
import { useProblems, useSource, type RuleEntry } from "../../lab/problems";
import type { LabState, Source } from "../../lab/types";
import { Drawer } from "../../ui/Drawer";
import { EmptyState, Skeleton } from "../../ui/EmptyState";
import { MarkNumber } from "../../ui/Conversation";
import { Label } from "../../ui/Label";
import { ListRow } from "../../ui/ListRow";
import { segments } from "../../ui/highlight";

const KIND: Record<string, string> = { prompt: "Промпт", tools: "Инструменты" };

/** A source in full with every criterion quoted from it marked and numbered; each criterion opens in «Критерии». */
function SourceText({ source, rules, onClose }: { source: Source | null; rules: RuleEntry[]; onClose: () => void }) {
  const { data, isLoading, error } = useSource(source?.id);
  const marks = rules.map((r, i) => ({ quote: r.rule.quote, n: i + 1 }));
  const pieces = data ? segments(data.content, marks) : [];
  const found = new Set(pieces.flatMap(p => (p.n ? [p.n] : [])));
  return (
    <Drawer open={!!source} onClose={onClose} title={source?.origin ?? ""} sub={source ? `${KIND[source.kind] ?? source.kind} · ${thousands(source.chars)} · ${source.rules} ${plural(source.rules, "критерий", "критерия", "критериев")}` : undefined}>
      {rules.length > 0 && (
        <div className="border-b border-white/[0.06] px-5 py-4">
          <Label className="mb-2">Критерии из этого источника</Label>
          <ol className="space-y-2">
            {rules.map((r, i) => (
              <li key={r.id} className="flex items-start gap-2.5">
                <MarkNumber n={i + 1} />
                <Link to={`/agent?tab=criteria&c=${encodeURIComponent(r.id)}`} className="min-w-0 flex-1 text-small text-lab-text hover:text-lab-ink hover:underline hover:decoration-white/40 hover:underline-offset-4">
                  {r.rule.text}<ArrowUpRight className="ml-1 inline size-3.5 text-lab-dim" />
                </Link>
                {data && !found.has(i + 1) && <span className="flex-shrink-0 text-meta text-lab-warn">цитаты нет в тексте</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
      {isLoading && <div className="p-5"><Skeleton className="h-64" /></div>}
      {!!error && <p className="p-5 text-small text-lab-bad">Не удалось открыть источник: {error instanceof Error ? error.message : String(error)}</p>}
      {data && (
        <pre className="whitespace-pre-wrap px-5 py-4 font-sans text-small text-lab-mute">
          {pieces.map((p, i) => p.n
            ? <mark key={i} className="rounded-sm border-b-2 border-lab-mark bg-lab-mark/[0.18] px-0.5 text-lab-ink">{p.text}<span className="ml-1 inline-block translate-y-[-1px] align-middle"><MarkNumber n={p.n} /></span></mark>
            : <span key={i}>{p.text}</span>)}
        </pre>
      )}
    </Drawer>
  );
}

/** Код: what was read from the agent's code — its prompts and its tools — and how many rules each gave. */
export function Code({ state, openId, onOpen }: { state: LabState; openId: string | null; onOpen: (id: string | null) => void }) {
  const { data } = useProblems(null);
  const bySource = useMemo(() => {
    const out = new Map<string, RuleEntry[]>();
    for (const r of data?.rules ?? []) if (r.rule.sourceId) out.set(r.rule.sourceId, [...(out.get(r.rule.sourceId) ?? []), r]);
    return out;
  }, [data]);
  const sources = [...state.sources].sort((a, b) => b.rules - a.rules);
  const total = sources.reduce((n, s) => n + s.rules, 0);
  const open = sources.find(s => s.id === openId) ?? null;
  if (!sources.length) {
    return (
      <EmptyState drop title="Код агента ещё не прочитан">
        Укажите папку с кодом во вкладке «Подключение» и нажмите «Прочитать код»: из промптов и описаний инструментов выделятся критерии, дословными цитатами.
      </EmptyState>
    );
  }
  return (
    <div className="mx-auto max-w-[960px] px-6 pb-20 pt-6 lg:px-8">
      <p className="text-read text-lab-text">
        {total} {plural(total, "критерий", "критерия", "критериев")} из {sources.filter(s => s.rules).length} {plural(sources.filter(s => s.rules).length, "источника", "источников", "источников")};
        всего прочитано {sources.length} {plural(sources.length, "источник", "источника", "источников")}.
      </p>
      <div className="mt-4 border-t border-white/[0.06]">
        {sources.map(s => {
          const Icon = s.kind === "tools" ? Wrench : FileText;
          return (
            <ListRow key={s.id} selected={s.id === openId} onClick={() => onOpen(s.id)}>
              <div className="flex items-center gap-3">
                <Icon className="size-4 flex-shrink-0 text-lab-dim" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-small text-lab-text" title={s.origin}>{s.origin}</div>
                  <div className="mt-0.5 text-meta text-lab-dim">{KIND[s.kind] ?? s.kind} · {thousands(s.chars)}</div>
                </div>
                <span className={s.rules ? "flex-shrink-0 text-small text-lab-text" : "flex-shrink-0 text-small text-lab-faint"}>критериев: <span className="font-mono">{s.rules}</span></span>
              </div>
            </ListRow>
          );
        })}
      </div>
      <SourceText source={open} rules={open ? bySource.get(open.id) ?? [] : []} onClose={() => onOpen(null)} />
    </div>
  );
}
