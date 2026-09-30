import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowLeft, Check, CircleHelp, Download, MessageSquare, Minus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { RunDetail } from "../../components/RunDetail";
import { exampleFor, transcript, type DialogRow } from "../../lab/dialogs";
import { personaName } from "../../lab/look";
import { download, secondLine } from "../../lab/problemReport";
import { useReview, useTurns, type Decision, type Example } from "../../lab/problems";
import type { Rule } from "../../lab/types";
import { useLabState } from "../../shell/LabProvider";
import { useShell } from "../../shell/ShellContext";
import { Button } from "../../ui/Button";
import { Conversation, MarkNumber, type Mark } from "../../ui/Conversation";
import { Skeleton } from "../../ui/EmptyState";
import { Label } from "../../ui/Label";
import { Tabs } from "../../ui/Tabs";
import { VerdictChip } from "../../ui/VerdictChip";
import { ReviewButtons } from "../verdicts/Example";

type Tab = "talk" | "rules" | "trace" | "details";
const TABS: { value: Tab; label: string }[] = [
  { value: "talk", label: "Разговор" }, { value: "rules", label: "Критерии" }, { value: "trace", label: "Трейс" }, { value: "details", label: "Детали" },
];
const VERDICT: Record<string, { word: string; tone: string; icon: typeof Check }> = {
  FAIL: { word: "нарушение", tone: "text-lab-bad", icon: X },
  PASS: { word: "без обнаруженных нарушений", tone: "text-lab-ok", icon: Check },
  UNMEASURED: { word: "не оценён", tone: "text-lab-warn", icon: CircleHelp },
  RUNNING: { word: "идёт", tone: "text-lab-accent", icon: CircleHelp },
};
const RULE: Record<string, { word: string; tone: string; icon: typeof Check }> = {
  FAIL: { word: "нарушено", tone: "text-lab-bad", icon: X },
  PASS: { word: "выполнено", tone: "text-lab-ok", icon: Check },
  UNKNOWN: { word: "нет доказательств", tone: "text-lab-warn", icon: CircleHelp },
  NOT_APPLICABLE: { word: "не применимо", tone: "text-lab-dim", icon: Minus },
};
const ORDER: Record<string, number> = { FAIL: 0, PASS: 1, UNKNOWN: 2, NOT_APPLICABLE: 3 };

function RuleRow({ row, rule, n, decided, onDecide }: { row: DialogRow; rule: Rule; n?: number; decided?: Decision | null; onDecide: (e: Example, d: Decision) => void }) {
  const { state } = useLabState();
  const look = RULE[rule.status] ?? RULE.UNKNOWN;
  const example = exampleFor(row, rule);
  const shown = decided !== undefined ? { ...example, review: decided, reviewScope: decided ? ("rule" as const) : null } : example;
  const judged = rule.status === "FAIL" || rule.status === "PASS";
  return (
    <div className="border-b border-white/[0.08] py-4">
      <div className="flex items-start gap-3">
        <span className={cn("mt-0.5 inline-flex items-center gap-1 whitespace-nowrap text-meta", look.tone)}><look.icon className="size-3.5" strokeWidth={2.5} />{look.word}</span>
        <div className={cn("min-w-0 flex-1 text-small", rule.status === "NOT_APPLICABLE" ? "text-lab-dim" : "text-lab-ink")}>{rule.rule}</div>
      </div>
      {rule.status !== "NOT_APPLICABLE" && (
        <div className="mt-2 space-y-1.5 pl-[18px]">
          {rule.agentQuote && (
            <p className="flex gap-2 text-small text-lab-mute">{n && <MarkNumber n={n} />}<span>«{rule.agentQuote}»</span></p>
          )}
          <p className="text-small text-lab-text"><span className="text-lab-dim">Судья: </span>{rule.reason}</p>
          {judged && <p className="text-meta text-lab-mute">{secondLine(example, state?.models.second ?? null)}</p>}
          {judged && <div className="pt-1"><ReviewButtons example={shown} onDecide={d => onDecide(example, d)} /></div>}
        </div>
      )}
    </div>
  );
}

/** One dialogue: what was said with the judge's quotes marked, the verdict on every rule, the trace, the record. */
export function DialogView({ row, onBack }: { row: DialogRow; onBack: () => void }) {
  const [params, setParams] = useSearchParams();
  const shell = useShell();
  const review = useReview();
  const { state } = useLabState();
  const [active, setActive] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [decided, setDecided] = useState<Record<string, Decision | null>>({});
  const tab = (params.get("dt") as Tab | null) ?? "talk";
  const setTab = (t: Tab) => setParams(prev => { const n = new URLSearchParams(prev); if (t === "talk") n.delete("dt"); else n.set("dt", t); return n; }, { replace: true });
  const probe = { source: row.source === "sim" ? "sim" : "log", dialogueId: row.dialogueId, runId: row.runId, index: row.index } as Example;
  const { turns, loading, error } = useTurns(row.source === "trace" ? undefined : probe);
  if (row.source === "trace" && row.traceId) {
    return (
      <div className="h-full">
        <button type="button" onClick={onBack} className="m-4 inline-flex items-center gap-1.5 text-small text-lab-mute transition-colors hover:text-lab-text lg:hidden"><ArrowLeft className="size-3.5" />Диалоги</button>
        <RunDetail key={row.traceId} runId={row.traceId} />
      </div>
    );
  }
  const rules = [...row.rules].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
  const fails = rules.filter(r => r.status === "FAIL" && r.agentQuote);
  const numbers = new Map(fails.map((r, i) => [r.ruleId, i + 1]));
  const marks: Mark[] = fails.map((r, i) => ({ quote: r.agentQuote, n: i + 1, label: r.title || r.rule }));
  const kept = rules.filter(r => r.status === "PASS").length;
  const verdict = row.status ? VERDICT[row.status] : undefined;
  const who = row.source === "sim" ? [row.name, `клиент: ${personaName(state?.personas ?? [], row.persona)}`, row.attempt && row.attempt > 1 ? `повтор ${row.attempt}` : ""].filter(Boolean).join(" · ") : "";
  const mark = (n: number | null, pin?: boolean) => {
    if (pin) setPinned(p => (p === n ? null : n));
    setActive(n);
  };
  const jump = (n: number) => { mark(n, true); document.getElementById(`mark-${n}`)?.scrollIntoView({ block: "center", behavior: "smooth" }); };
  const decide = (example: Example, d: Decision) => {
    const next = (decided[example.ruleId] !== undefined ? decided[example.ruleId] : example.review) === d ? null : d;
    setDecided(x => ({ ...x, [example.ruleId]: next }));
    review.mutate({ example, decision: next });
  };
  return (
    <article className="message-arrive mx-auto max-w-[820px] px-6 pb-20 pt-6 lg:px-8">
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-small text-lab-mute transition-colors hover:text-lab-text lg:hidden"><ArrowLeft className="size-3.5" />Диалоги</button>
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between xl:gap-6">
        <h1 className="line-clamp-3 min-w-0 flex-1 text-title font-medium text-lab-ink">{row.title}</h1>
        <div className="flex flex-shrink-0 gap-2">
          <Button size="sm" icon={Download} disabled={!turns} onClick={() => turns && download(`dialog-${row.dialogueId ?? row.index}.md`, transcript(row, turns))}>Скачать</Button>
          <Button size="sm" icon={MessageSquare} onClick={() => shell.openAsk(row.traceId)}>Спросить</Button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-lab-dim">
        <span>{row.source === "log" ? "Лог" : "Симуляция"}</span>
        {row.topic && <><span className="text-lab-faint">·</span><span>тема «{row.topic}»</span></>}
        {who && <><span className="text-lab-faint">·</span><span>{who}</span></>}
        {verdict && <><span className="text-lab-faint">·</span><span className={cn("inline-flex items-center gap-1", verdict.tone)}><verdict.icon className="size-3.5" strokeWidth={2.5} />{verdict.word}</span></>}
        {row.disputed && <><span className="text-lab-faint">·</span><span className="text-lab-warn">судьи расходятся</span></>}
      </div>
      {(fails.length > 0 || kept > 0) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {rules.filter(r => r.status === "FAIL").map(r => <VerdictChip key={r.ruleId} label={r.title || r.rule} status="FAIL" className="max-w-[320px]" />)}
          {kept > 0 && <VerdictChip label={`${kept} из ${rules.filter(r => r.status === "PASS" || r.status === "FAIL").length} критериев`} status="PASS" />}
        </div>
      )}
      <Tabs className="mt-6" value={tab} onChange={setTab}
        tabs={TABS.filter(t => t.value !== "trace" || row.traceId).map(t => ({ ...t, count: t.value === "rules" ? row.rules.length : undefined }))} />
      {tab === "talk" && (
        <div className="mt-5">
          {loading ? <Skeleton className="h-40" />
            : error ? <p className="text-small text-lab-bad">Не удалось загрузить разговор: {error instanceof Error ? error.message : String(error)}</p>
            : turns ? <Conversation turns={turns} marks={marks} active={active ?? pinned} onActive={mark} />
            : <p className="text-read text-lab-text">{row.title}</p>}
          {fails.length > 0 && (
            <div className="mt-6 space-y-2">
              <Label>Нарушения</Label>
              {fails.map(r => {
                const n = numbers.get(r.ruleId) ?? 0;
                const on = (active ?? pinned) === n;
                return (
                  <div
                    key={r.ruleId} onMouseEnter={() => setActive(n)} onMouseLeave={() => setActive(null)} onClick={() => jump(n)}
                    className={cn("flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5 text-small text-lab-text transition-colors", on ? "border-lab-mark/50 bg-lab-mark/[0.06]" : "border-white/[0.08] hover:border-white/15")}
                  >
                    <MarkNumber n={n} active={on} />
                    <span><span className="text-lab-ink">{r.title || r.rule}</span><span className="block text-lab-mute">{r.reason}</span></span>
                  </div>
                );
              })}
              <button type="button" onClick={() => setTab("rules")} className="text-small text-lab-dim underline decoration-white/20 underline-offset-4 hover:text-lab-text">Все критерии и проверка вердиктов</button>
            </div>
          )}
        </div>
      )}
      {tab === "rules" && (
        <div className="mt-2">
          {rules.length ? rules.map(r => <RuleRow key={r.ruleId} row={row} rule={r} n={numbers.get(r.ruleId)} decided={decided[r.ruleId]} onDecide={decide} />)
            : <p className="mt-5 text-small text-lab-dim">Судья этот диалог не оценивал.</p>}
        </div>
      )}
      {tab === "trace" && row.traceId && <div className="-mx-6 mt-4 lg:-mx-8"><RunDetail key={row.traceId} runId={row.traceId} /></div>}
      {tab === "details" && (
        <pre className="mt-5 overflow-auto rounded-lg border border-white/[0.08] bg-lab-surface p-4 font-mono text-meta text-lab-mute">
          {JSON.stringify({ источник: row.source, диалог: row.dialogueId, прогон: row.runId, номер: row.index, трейс: row.traceId, вердикт: row.status, второй_судья: row.second, критерии: row.rules }, null, 2)}
        </pre>
      )}
    </article>
  );
}
