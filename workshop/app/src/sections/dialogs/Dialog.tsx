import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, Download, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { RunDetail } from "../../components/RunDetail";
import type { Criterion } from "../../lab/criteria";
import { exampleFor, transcript, type DialogRow } from "../../lab/dialogs";
import { day } from "../../lab/format";
import { personaName } from "../../lab/look";
import { download, secondLine } from "../../lab/problemReport";
import { useReview, useTurns, type Decision, type Example } from "../../lab/problems";
import type { Rule } from "../../lab/types";
import { Conversation, type Mark } from "../../product/Conversation";
import { Facts } from "../../product/Facts";
import { MarkNo } from "../../product/MarkNo";
import { ReviewButtons } from "../../product/ReviewButtons";
import { useLabState } from "../../lab/LabProvider";
import { useShell } from "../../app/ShellContext";
import { Button } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { Skeleton } from "../../ui/EmptyState";
import { Segmented } from "../../ui/Segmented";
import { VerdictWord } from "./Rows";
import { criteriaByText } from "./model";

type Tab = "talk" | "trace" | "details";
const ORDER: Record<string, number> = { FAIL: 0, PASS: 1, UNKNOWN: 2, NOT_APPLICABLE: 3 };
const WORD: Record<string, [string, string]> = { FAIL: ["нарушен", "text-bad"], PASS: ["выполнен", "text-ok"], UNKNOWN: ["не проверен", "text-fg-3"], NOT_APPLICABLE: ["не применим", "text-fg-3"] };

/** Every criterion the judge looked at in this dialogue: broken first with its quote's number, then kept, then undecided. */
function Verdicts({ row, rules, find, lit, onLit, onDecide, decided }: {
  row: DialogRow; rules: Rule[]; find: (t: string) => Criterion | undefined; lit: number | null; onLit: (n: number | null) => void;
  onDecide: (e: Example, d: Decision) => void; decided: Record<string, Decision | null>;
}) {
  const { state } = useLabState();
  return (
    <section className="mt-7" aria-label="Вердикты судьи">
      <Label>Вердикты судьи · {rules.length}</Label>
      <ul className="mt-2 border-t border-line">
        {rules.map(r => {
          const c = find(r.rule);
          const e = exampleFor(row, r);
          const shown = { ...e, review: decided[r.ruleId] !== undefined ? decided[r.ruleId] : e.review };
          const [word, tone] = WORD[r.status] ?? [r.status, "text-fg-3"];
          const n = c?.n;
          return (
            <li key={r.ruleId} onMouseEnter={() => n && r.status === "FAIL" && onLit(n)} onMouseLeave={() => onLit(null)}
              className={cn("grid grid-cols-[24px_minmax(0,1fr)] gap-x-2 border-b border-line py-3.5 transition-colors", n && lit === n && "bg-raised/60")}>
              <span className="pt-0.5">{r.status === "FAIL" && r.agentQuote && n ? <MarkNo n={n} on={lit === n} /> : <span className="text-meta tabular-nums text-fg-4">{n ?? "·"}</span>}</span>
              <div className="min-w-0">
                <p className="text-body text-fg"><span className="font-medium">{c?.name ?? r.title ?? r.rule}</span> <span className={cn("text-small", tone)}>· {word}</span></p>
                <p className="mt-1 text-small text-fg-2"><span className="text-fg-3">Судья: </span>{r.reason}</p>
                {r.status === "FAIL" && <p className="mt-1 text-small text-fg-3">{secondLine(e, state?.models.second ?? null)}</p>}
                {(r.status === "FAIL" || r.status === "PASS") && row.source !== "trace" && <div className="mt-2"><ReviewButtons example={shown} onDecide={d => onDecide(shown, d)} /></div>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** One dialogue: what was said with the judge's quotes numbered by their criteria, every verdict, the trace and the record. */
export function Dialog({ row, criteria, onBack }: { row: DialogRow; criteria: Criterion[]; onBack?: () => void }) {
  const [params, setParams] = useSearchParams();
  const { state } = useLabState();
  const shell = useShell();
  const review = useReview();
  const [lit, setLit] = useState<number | null>(null);
  const [decided, setDecided] = useState<Record<string, Decision | null>>({});
  const raw = params.get("dt");
  const tab: Tab = raw === "trace" || raw === "details" ? raw : "talk";
  const setTab = (t: Tab) => setParams(prev => { const n = new URLSearchParams(prev); if (t === "talk") n.delete("dt"); else n.set("dt", t); return n; }, { replace: true });
  const probe = { source: row.source === "sim" ? "sim" : "log", dialogueId: row.dialogueId, runId: row.runId, index: row.index } as Example;
  const { turns, loading, error } = useTurns(row.source === "trace" ? undefined : probe);
  const find = criteriaByText(criteria);
  if (row.source === "trace" && row.traceId) {
    return (
      <div className="min-h-0 overflow-auto">
        {onBack && <button type="button" onClick={onBack} className="sticky top-0 z-10 flex h-11 w-full items-center gap-1.5 border-b border-line bg-canvas px-3 text-body text-fg-2 lg:hidden"><ArrowLeft aria-hidden className="size-4" />Разговоры</button>}
        <RunDetail key={row.traceId} runId={row.traceId} />
      </div>
    );
  }
  const rules = [...row.rules].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
  const marks: Mark[] = rules.filter(r => r.status === "FAIL" && r.agentQuote).flatMap(r => { const c = find(r.rule); return c ? [{ quote: r.agentQuote, n: c.n }] : []; });
  const judged = rules.filter(r => r.status === "PASS" || r.status === "FAIL").length;
  const broken = rules.filter(r => r.status === "FAIL").length;
  const kept = rules.filter(r => r.status === "PASS").length;
  const run = row.runId ? state?.runs.find(r => r.id === row.runId) : undefined;
  const where = row.source === "log"
    ? ["лог", row.topic].filter(Boolean).join(" · ")
    : ["симуляция", run ? day(run.startedAt) : "", row.name, `клиент: ${personaName(state?.personas ?? [], row.persona)}`, row.attempt && row.attempt > 1 ? `повтор ${row.attempt}` : ""].filter(Boolean).join(" · ");
  const decide = (e: Example, d: Decision) => {
    const next = e.review === d ? null : d;
    setDecided(x => ({ ...x, [e.ruleId]: next }));
    review.mutate({ example: e, decision: next });
  };
  const reviewed = rules.filter(r => r.status === "FAIL" && (decided[r.ruleId] !== undefined ? decided[r.ruleId] : r.review)).length;
  return (
    <article className="min-h-0 overflow-auto" aria-label={row.title}>
      {onBack && <button type="button" onClick={onBack} className="sticky top-0 z-10 flex h-11 w-full items-center gap-1.5 border-b border-line bg-canvas px-3 text-body text-fg-2 lg:hidden"><ArrowLeft aria-hidden className="size-4" />Разговоры</button>}
      <div className="max-w-4xl px-4 pb-16 pt-5 lg:px-10 lg:pt-7">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><VerdictWord status={row.status} />{row.disputed && <span className="text-meta text-warn">судьи расходятся</span>}<span className="text-meta text-fg-3">{where}</span></div>
        <div className="mt-2 flex items-start gap-5">
          <h2 className="min-w-0 flex-1 text-balance text-title font-semibold text-fg">{row.title}</h2>
          <div className="hidden flex-shrink-0 items-center gap-1 sm:flex">
            <Button icon={Download} disabled={!turns} onClick={() => turns && download(`dialog-${row.dialogueId ?? row.index}.md`, transcript(row, turns))}>Скачать</Button>
            <Button variant="ghost" icon={MessageSquare} aria-label="Спросить ассистента об этом разговоре" onClick={() => shell.openAsk(row.traceId)} />
          </div>
        </div>
        <div className="mt-5">
          <Facts facts={[
            { label: "Нарушено", value: judged ? <><span className={cn("font-semibold tabular-nums", broken && "text-bad")}>{broken}</span> <span className="text-fg-3">из</span> <span className="tabular-nums">{judged}</span></> : "—", title: "Критериев с нарушением из тех, что судья смог проверить" },
            { label: "Выполнено", value: judged ? <><span className="tabular-nums">{kept}</span> <span className="text-fg-3">из</span> <span className="tabular-nums">{judged}</span></> : "—" },
            { label: "Второй судья", value: row.second ? (row.disputed ? "вынес другой вердикт" : "согласен") : "не проверял", title: row.second?.model },
            { label: "Люди", value: reviewed ? `проверили ${reviewed} из ${broken}` : "ещё не проверяли" },
          ]} />
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Segmented<Tab> size="sm" label="Что показать" value={tab} onChange={setTab}
            options={[{ value: "talk", label: "Разговор" }, ...(row.traceId ? [{ value: "trace" as Tab, label: "Трейс" }] : []), { value: "details", label: "Детали" }]} />
          {row.traceId && <Link to={`/runs/${encodeURIComponent(row.traceId)}`} className="ml-auto inline-flex items-center gap-1 text-small text-fg-3 hover:text-fg">в Workshop<ArrowUpRight aria-hidden className="size-3.5" /></Link>}
        </div>
        {tab === "talk" && (
          <>
            <div className="mt-4 rounded-block border border-line bg-inset px-4 pb-4 pt-3.5">
              {loading ? <Skeleton className="h-40" />
                : error ? <p className="text-small text-bad">Не удалось загрузить разговор: {error instanceof Error ? error.message : String(error)}</p>
                : turns ? <Conversation turns={turns} marks={marks} lit={lit} onLit={(on, n) => setLit(on && n ? n : null)} />
                : <p className="text-read text-fg">{row.title}</p>}
            </div>
            {rules.length > 0 && <Verdicts row={row} rules={rules} find={find} lit={lit} onLit={setLit} onDecide={decide} decided={decided} />}
          </>
        )}
        {tab === "trace" && row.traceId && <div className="mt-4 overflow-hidden rounded-block border border-line"><RunDetail key={row.traceId} runId={row.traceId} /></div>}
        {tab === "details" && (
          <pre className="mt-4 overflow-auto rounded-block border border-line bg-inset p-4 font-mono text-meta text-fg-3">
            {JSON.stringify({ источник: row.source, разговор: row.dialogueId, прогон: row.runId, номер: row.index, трейс: row.traceId, вердикт: row.status, второй_судья: row.second, критерии: row.rules }, null, 2)}
          </pre>
        )}
      </div>
    </article>
  );
}
