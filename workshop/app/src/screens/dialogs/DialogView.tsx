import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Check, CircleHelp, Download, MessageSquare, X } from "lucide-react";
import { RunDetail } from "../../components/RunDetail";
import { exampleFor, transcript, type DialogRow } from "../../lab/dialogs";
import { personaName } from "../../lab/look";
import { download } from "../../lab/problemReport";
import { useReview, useTurns, type Decision, type Example } from "../../lab/problems";
import type { Rule } from "../../lab/types";
import { useLabState } from "../../shell/LabProvider";
import { useShell } from "../../shell/ShellContext";
import { Button } from "../../ui/Button";
import { Conversation, type Mark } from "../../ui/Conversation";
import { Skeleton } from "../../ui/EmptyState";
import { Chip } from "../../ui/Chip";
import { Details, Tag, type Detail } from "../../ui/Details";
import { PillTabs } from "../../ui/PillTabs";
import { Tiles, type Tile } from "../../ui/Tiles";
import { TwoCol } from "../../ui/TwoCol";
import { JudgeCard, type JudgeRow } from "../verdicts/JudgeCard";
import { useCriteria } from "../../lab/criteria";

type Tab = "talk" | "trace" | "details";
const TABS: { value: Tab; label: string }[] = [
  { value: "talk", label: "Разговор" }, { value: "trace", label: "Трейс" }, { value: "details", label: "Детали" },
];
const textKey = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
const ORDER: Record<string, number> = { FAIL: 0, PASS: 1, UNKNOWN: 2, NOT_APPLICABLE: 3 };
const VERDICT: Record<string, { word: string; tone: string; icon: typeof Check }> = {
  FAIL: { word: "нарушение", tone: "text-lab-bad", icon: X },
  PASS: { word: "без обнаруженных нарушений", tone: "text-lab-ok", icon: Check },
  UNMEASURED: { word: "не оценён", tone: "text-lab-warn", icon: CircleHelp },
  RUNNING: { word: "идёт", tone: "text-lab-accent", icon: CircleHelp },
};
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
  const { list: criteria } = useCriteria(row.source === "sim" ? row.runId ?? null : null);
  if (row.source === "trace" && row.traceId) {
    return (
      <div className="h-full">
        <button type="button" onClick={onBack} className="m-4 inline-flex items-center gap-1.5 text-small text-lab-mute transition-colors hover:text-lab-text lg:hidden"><ArrowLeft className="size-3.5" />Диалоги</button>
        <RunDetail key={row.traceId} runId={row.traceId} />
      </div>
    );
  }
  const rules = [...row.rules].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
  const byText = new Map(criteria.map(c => [textKey(c.r.rule.text), c]));
  const secondRules = new Map((row.second?.rules ?? []).map(r => [r.ruleId, r.status]));
  const judgeRows: JudgeRow[] = rules.map((r, i) => {
    const c = byText.get(textKey(r.rule));
    const other = secondRules.get(r.ruleId);
    return {
      rule: r, n: c?.n ?? (r.status === "FAIL" ? 100 + i : undefined), name: c?.name ?? r.title ?? r.rule,
      second: r.status === "FAIL" && other ? (other === "FAIL" ? "agree" : "disagree") : null,
      review: decided[r.ruleId] !== undefined ? decided[r.ruleId] : r.review ?? null,
    };
  });
  const fails = judgeRows.filter(r => r.rule.status === "FAIL" && r.rule.agentQuote);
  const marks: Mark[] = fails.map(r => ({ quote: r.rule.agentQuote, n: r.n!, label: r.name }));
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
  const judged = rules.filter(r => r.status === "PASS" || r.status === "FAIL").length;
  const reviewed = rules.filter(r => r.status === "FAIL" && (decided[r.ruleId] !== undefined ? decided[r.ruleId] : r.review)).length;
  const tone = row.status === "FAIL" ? "bad" : row.status === "PASS" ? "ok" : row.status === "RUNNING" ? "live" : "warn";
  const tiles: Tile[] = [
    { label: "Нарушено", value: rules.filter(r => r.status === "FAIL").length, of: judged ? `из ${judged}` : undefined, title: "Критериев с нарушением из тех, что судья смог проверить" },
    { label: "Выполнено", value: kept, of: judged ? `из ${judged}` : undefined },
    { label: "Второй судья", value: row.second ? (row.disputed ? "расходится" : "согласен") : "—", title: row.second?.model },
    { label: "Люди", value: reviewed || "—", of: reviewed ? `из ${rules.filter(r => r.status === "FAIL").length}` : undefined },
  ];
  const details: Detail[] = [
    { label: "Источник", value: row.source === "log" ? "Лог" : "Симуляция" },
    ...(row.topic ? [{ label: "Тема", value: <Tag>{row.topic}</Tag> }] : []),
    ...(row.name ? [{ label: "Сценарий", value: row.name }] : []),
    ...(row.source === "sim" ? [{ label: "Клиент", value: personaName(state?.personas ?? [], row.persona) }] : []),
    ...(row.attempt && row.attempt > 1 ? [{ label: "Повтор", value: `${row.attempt}` }] : []),
    ...(row.runId ? [{ label: "Прогон", value: <Link to={`/results?run=${encodeURIComponent(row.runId)}`} className="underline decoration-white/20 underline-offset-2 hover:text-lab-ink">результаты прогона</Link> }] : []),
    ...(row.traceId ? [{ label: "Трейс", value: <Link to={`/runs/${encodeURIComponent(row.traceId)}`} className="underline decoration-white/20 underline-offset-2 hover:text-lab-ink">открыть в Workshop</Link> }] : []),
    ...(row.dialogueId ? [{ label: "Диалог", value: <span className="font-mono text-meta">{row.dialogueId}</span> }] : []),
  ];
  const left = (
    <>
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1.5 text-small text-lab-mute transition-colors hover:text-lab-text lg:hidden"><ArrowLeft className="size-3.5" />Диалоги</button>
      {verdict && <Chip tone={tone}>{verdict.word}</Chip>}
      {row.disputed && <Chip tone="warn" className="ml-1.5">судьи расходятся</Chip>}
      <h1 className="mt-2.5 line-clamp-4 text-title font-medium text-lab-ink">{row.title}</h1>
      <p className="mt-2 text-small text-lab-mute">{row.source === "log" ? "Лог" : "Симуляция"}{row.topic ? ` · тема «${row.topic}»` : ""}{who ? ` · ${who}` : ""}</p>
      <div className="mt-3 flex gap-2">
        <Button size="sm" icon={Download} disabled={!turns} onClick={() => turns && download(`dialog-${row.dialogueId ?? row.index}.md`, transcript(row, turns))}>Скачать</Button>
        <Button size="sm" icon={MessageSquare} onClick={() => shell.openAsk(row.traceId)}>Спросить</Button>
      </div>
      <Tiles className="mt-4" tiles={tiles} />
      <Details rows={details} />
    </>
  );
  const right = (
    <div className="flex min-h-full flex-col">
      <div className="flex-shrink-0 border-b border-white/[0.08] px-3 py-[7px]">
        <PillTabs<Tab> value={tab} onChange={setTab}
          tabs={TABS.filter(t => t.value !== "trace" || row.traceId)} />
      </div>
      <div className="px-4 pb-16 pt-4">
      {tab === "talk" && (
        <div>
          {loading ? <Skeleton className="h-40" />
            : error ? <p className="text-small text-lab-bad">Не удалось загрузить разговор: {error instanceof Error ? error.message : String(error)}</p>
            : turns ? <Conversation turns={turns} marks={marks} active={active ?? pinned} onActive={mark} />
            : <p className="text-read text-lab-text">{row.title}</p>}
          {rules.length > 0 && (
            <div className="mt-6">
              <JudgeCard rows={judgeRows} model={state?.models.main ?? null} active={active ?? pinned} onPick={jump}
                onDecide={row.source === "trace" ? undefined : (r, d) => decide(exampleFor(row, r.rule), d)} />
            </div>
          )}
        </div>
      )}
      {tab === "trace" && row.traceId && <div className="-mx-4 -mt-4"><RunDetail key={row.traceId} runId={row.traceId} /></div>}
      {tab === "details" && (
        <pre className="overflow-auto rounded-lg border border-white/[0.08] bg-lab-surface p-4 font-mono text-meta text-lab-mute">
          {JSON.stringify({ источник: row.source, диалог: row.dialogueId, прогон: row.runId, номер: row.index, трейс: row.traceId, вердикт: row.status, второй_судья: row.second, критерии: row.rules }, null, 2)}
        </pre>
      )}
      </div>
    </div>
  );
  return <TwoCol left={left} right={right} />;
}
