import { useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../../lab/api";
import { plural, when } from "../../lab/format";
import { personaName } from "../../lab/look";
import { personaOf } from "../../lab/logic";
import { isRunning, runTitle, runTypes, simDialog, useRun } from "../../lab/runs";
import type { Item, LabRun, LabState } from "../../lab/types";
import { useLabState } from "../../shell/LabProvider";
import { Button } from "../../ui/Button";
import { EmptyState, Skeleton } from "../../ui/EmptyState";
import { Facts, type Fact } from "../../ui/Facts";
import { Tabs } from "../../ui/Tabs";
import { useToast } from "../../ui/toast";
import { RunMatrix, Sign } from "./RunMatrix";

type Tab = "dialogs" | "matrix" | "violations";

function DialogRows({ run, items, state }: { run: LabRun; items: Item[]; state: LabState }) {
  const many = new Set(items.map(personaOf)).size > 1;
  return (
    <div>
      {items.map((item, index) => {
        const fails = [...new Set(item.rules.filter(r => r.status === "FAIL").map(r => r.title || r.rule))];
        const who = [many || item.persona ? personaName(state.personas, item.persona) : "", item.attempt && item.attempt > 1 ? `повтор ${item.attempt}` : ""].filter(Boolean);
        return (
          <Link key={index} to={simDialog(run.id, index)} className="flex gap-3 border-b border-white/[0.06] py-3 transition-colors hover:bg-lab-hover">
            <Sign status={item.status} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-small text-lab-ink">{item.name}</div>
              <div className="mt-0.5 truncate text-meta text-lab-dim">{[item.topic, ...who].join(" · ")}</div>
              {fails.length > 0 && <div className="mt-0.5 truncate text-meta text-lab-bad">{fails[0]}{fails.length > 1 && ` и ещё ${fails.length - 1}`}</div>}
              {item.status === "UNMEASURED" && <div className="mt-0.5 truncate text-meta text-lab-warn">не оценён{item.error ? `: ${item.error}` : ""}</div>}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

/** The rules this run found violated, most frequent first, each with the number of its dialogues. */
function Violations({ run, items }: { run: LabRun; items: Item[] }) {
  const rules = useMemo(() => {
    const byRule = new Map<string, { id: string; title: string; n: number }>();
    for (const item of items) {
      for (const r of item.rules) {
        if (r.status !== "FAIL") continue;
        const own = byRule.get(r.ruleId) ?? { id: r.ruleId, title: r.title || r.rule, n: 0 };
        own.n += 1;
        byRule.set(r.ruleId, own);
      }
    }
    return [...byRule.values()].sort((a, b) => b.n - a.n);
  }, [items]);
  const q = `?run=${encodeURIComponent(run.id)}`;
  return (
    <div className="mt-4">
      <Link to={`/problems${q}`} className="inline-flex items-center gap-1.5 text-small text-lab-ink underline decoration-white/20 underline-offset-4 hover:decoration-white/60">
        Открыть проблемы этого прогона<ArrowRight className="size-3.5" />
      </Link>
      {rules.length ? (
        <div className="mt-4">
          {rules.map(r => (
            <Link key={r.id} to={`/problems/${encodeURIComponent(r.id)}${q}`} className="flex items-baseline gap-4 border-b border-white/[0.06] py-3 transition-colors hover:bg-lab-hover">
              <span className="min-w-0 flex-1 text-small text-lab-ink">{r.title}</span>
              <span className="flex-shrink-0 text-meta text-lab-mute">в <span className="font-mono text-lab-text">{r.n}</span> {plural(r.n, "диалоге", "диалогах", "диалогах")}</span>
            </Link>
          ))}
        </div>
      ) : <p className="mt-4 text-small text-lab-dim">Судья не нашёл нарушений в диалогах этого прогона.</p>}
    </div>
  );
}

/** A run in full: which agent played what, what the judges found, and its dialogues. */
export function RunDetail({ summary, state, onBack }: { summary: LabRun; state: LabState; onBack: () => void }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useLabState();
  const toast = useToast();
  const { data: run, isLoading, error } = useRun(summary.id, state);
  const tab = (params.get("tab") as Tab | null) ?? "dialogs";
  const setTab = (t: Tab) => setParams(prev => { const n = new URLSearchParams(prev); if (t === "dialogs") n.delete("tab"); else n.set("tab", t); return n; }, { replace: true });
  const items = run?.items ?? [];
  const m = summary.metric;
  const rejudge = () => api(`/api/runs/${encodeURIComponent(summary.id)}/rejudge`, {}).then(() => refresh()).catch(toast.error);
  const dialogs = `/dialogs?source=sim&run=${encodeURIComponent(summary.id)}`;

  const facts: Fact[] = [{ label: "Дата", value: when(summary.startedAt) }];
  if (m) {
    facts.push({ label: "Диалогов", value: m.total });
    if (m.measured) facts.push({ label: "Нарушения", value: `в ${m.failed} из ${m.measured}`, onClick: () => navigate(`${dialogs}&verdict=fail`), title: "Открыть диалоги с нарушениями" });
    if (m.unmeasured) facts.push({ label: "Без оценки", value: m.unmeasured, onClick: () => navigate(`${dialogs}&verdict=none`), title: "Открыть диалоги, которые судья не смог оценить" });
    if (m.secondJudge?.checked) facts.push({ label: "Второй судья", value: `согласен в ${m.secondJudge.agree} из ${m.secondJudge.checked}`, title: m.secondJudge.model });
    if (m.repeats && m.repeats.attempts > 1) facts.push({ label: "Повторы", value: `одинаково в ${m.repeats.stable} из ${m.repeats.scenarios}`, title: "Сценарии, где все повторы получили один вердикт" });
    if (m.human?.reviewed) facts.push({ label: "Проверено людьми", value: `верно в ${m.human.agree} из ${m.human.reviewed}` });
  }
  facts.push({ label: "Типы клиентов", value: runTypes(summary, state).join(", ") });

  return (
    <article className="message-arrive mx-auto max-w-[960px] px-6 pb-20 pt-6 lg:px-8">
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-small text-lab-mute transition-colors hover:text-lab-text lg:hidden">
        <ArrowLeft className="size-3.5" />Прогоны
      </button>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-page font-semibold text-lab-ink">{runTitle(summary)}</h1>
          {summary.label && <p className="mt-1 text-read text-lab-soft">{summary.label}</p>}
        </div>
        <Button
          icon={RotateCcw} onClick={rejudge} disabled={state.job.running || isRunning(summary)}
          title={state.job.running ? "Сейчас идёт другая задача" : "Судьи оценят диалоги этого прогона заново; агента не вызываем"}
        >
          Переоценить
        </Button>
      </div>
      {isRunning(summary) && <p className="mt-3 text-small text-lab-accent">Прогон идёт: диалоги появляются по мере готовности.</p>}
      {summary.status === "failed" && <p className="mt-3 text-small text-lab-bad">Прогон прервался: {summary.error}</p>}
      {summary.status === "stopped" && <p className="mt-3 text-small text-lab-warn">Прогон остановлен до конца: недоигранные диалоги не оценены.</p>}
      <Facts facts={facts} className="mt-5" />
      <Tabs<Tab> className="mt-6" value={tab} onChange={setTab} tabs={[
        { value: "dialogs", label: "Диалоги", count: items.length },
        { value: "matrix", label: "Сценарии × типы клиентов" },
        { value: "violations", label: "Нарушения" },
      ]} />
      {isLoading ? <Skeleton className="mt-4 h-64" />
        : error ? <p className="mt-4 text-small text-lab-bad">Не удалось открыть прогон: {error instanceof Error ? error.message : String(error)}</p>
        : !run || !items.length ? <EmptyState title="Диалогов пока нет">{isRunning(summary) ? "Первые появятся, когда агент ответит." : "В этом прогоне не сыграно ни одного диалога."}</EmptyState>
        : tab === "matrix" ? <RunMatrix run={run} items={items} state={state} />
        : tab === "violations" ? <Violations run={run} items={items} />
        : <DialogRows run={run} items={items} state={state} />}
      <p className={cn("mt-6 text-meta text-lab-dim", !m?.measured && "hidden")}>
        Нарушение — судья нашёл хотя бы одно нарушенное правило. Не оценённые диалоги не входят в знаменатель.
      </p>
    </article>
  );
}
