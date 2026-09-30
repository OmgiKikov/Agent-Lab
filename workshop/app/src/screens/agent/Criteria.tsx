import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../lab/api";
import { day, plural } from "../../lab/format";
import { useProblems, type Problems } from "../../lab/problems";
import type { LabState } from "../../lab/types";
import { decisions } from "../../lab/verdicts";
import { useKeys } from "../../shell/keys";
import { useLabState } from "../../shell/LabProvider";
import { Button } from "../../ui/Button";
import { EmptyState, Skeleton } from "../../ui/EmptyState";
import { Summary, type Stat } from "../../ui/Summary";
import { Modal } from "../../ui/Modal";
import { Split } from "../../ui/Split";
import { useToast } from "../../ui/toast";
import { RuleDetail } from "../rules/RuleDetail";
import { RuleList, matchesRule, type RuleFilter } from "../rules/RuleList";

/** How many criteria there are and how far the verdicts can be trusted: big numbers, the first three filter the list. */
function CriteriaSummary({ data, state, filter, onFilter }: { data: Problems; state: LabState; filter: RuleFilter; onFilter: (f: RuleFilter) => void }) {
  const files = new Set(data.rules.map(r => r.rule.origin)).size;
  const logJudge = state.discover?.summary.secondJudge;
  const people = decisions(data);
  const checked = people.agree + people.disagree;
  const violated = data.rules.filter(r => matchesRule(r, "violated", "")).length;
  const disputed = data.rules.filter(r => matchesRule(r, "disputed", "")).length;
  const stats: Stat[] = [
    { label: "Критериев", value: data.rules.length, active: filter === "all", onClick: () => onFilter("all"), title: data.log?.rulesSince ? `Зафиксированы ${day(data.log.rulesSince)}` : undefined },
    { label: "Нарушаются", value: violated, of: `из ${data.rules.length}`, active: filter === "violated", onClick: () => onFilter("violated") },
    ...(disputed ? [{ label: "Судьи расходятся", value: disputed, of: `из ${data.rules.length}`, active: filter === "disputed", onClick: () => onFilter("disputed") }] : []),
    ...(logJudge ? [{ label: "Второй судья согласен", value: logJudge.agree, of: `из ${logJudge.checked} в логах` }] : []),
    { label: "Проверено людьми", value: checked, of: checked ? `верно ${people.agree}` : "" },
    { label: "Источников", value: files },
  ];
  return <Summary stats={stats} />;
}

/** «Извлечь заново»: new criteria from the code; the old ones stop counting, so it asks first. */
export function Reextract({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, refresh } = useLabState();
  const toast = useToast();
  const [starting, setStarting] = useState(false);
  const count = state?.discover?.sampled ?? 100;
  const start = async () => {
    setStarting(true);
    try {
      await api("/api/discover", { count, replan: true });
      onClose();
      await refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setStarting(false);
    }
  };
  return (
    <Modal
      open={open} onClose={onClose} title="Извлечь критерии заново"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" onClick={start} loading={starting} disabled={!!state?.job.running}>Извлечь и оценить {count} {plural(count, "диалог", "диалога", "диалогов")}</Button>
      </>}
    >
      <p className="text-small text-lab-mute">
        Судья прочитает промпты и инструменты агента заново, извлечёт критерии и оценит по ним {count} {plural(count, "диалог", "диалога", "диалогов")} логов.
        Прежние критерии перестанут действовать: счёты, ссылки на нарушения и решения людей по вердиктам начнутся заново.
      </p>
      <p className="mt-3 text-small text-lab-mute">Нужно, когда агент поменялся: новый промпт, новые инструменты.</p>
    </Modal>
  );
}

/** Критерии: what the agent must do, quoted from its code, with every verdict behind the counts (?c= selects one). */
export function Criteria() {
  const [params, setParams] = useSearchParams();
  const { state } = useLabState();
  const { data } = useProblems(null);
  const [filter, setFilter] = useState<RuleFilter>("all");
  const [query, setQuery] = useState("");
  const all = data?.rules ?? [];
  const shown = useMemo(() => all.filter(r => matchesRule(r, filter, query)), [all, filter, query]);
  const id = params.get("c");
  const selected = id ? all.find(r => r.id === id) : undefined;
  const open = (next: string | null, replace = false) => setParams(prev => {
    const n = new URLSearchParams(prev);
    if (next) n.set("c", next); else n.delete("c");
    n.delete("vt"); n.delete("example");
    return n;
  }, { replace });
  useEffect(() => {
    if (!id && shown[0] && window.matchMedia("(min-width: 1024px)").matches) open(shown[0].id, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, shown]);
  const step = (d: 1 | -1) => {
    if (!shown.length) return;
    const at = shown.findIndex(r => r.id === id);
    open(shown[at < 0 ? 0 : Math.max(0, Math.min(shown.length - 1, at + d))].id, true);
  };
  useKeys({ KeyJ: () => step(1), ArrowDown: () => step(1), KeyK: () => step(-1), ArrowUp: () => step(-1) });

  if (!state || (state.discover && !data)) return <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div>;
  if (!state.discover || !data) {
    return (
      <EmptyState drop title="Критериев пока нет" className="h-full">
        {state.sources.length ? "Критерии извлекаются из кода агента при первой оценке логов." : "Критерии извлекаются из кода агента: сначала прочитайте код."}
      </EmptyState>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <CriteriaSummary data={data} state={state} filter={filter} onFilter={setFilter} />
      <Split
        showDetail={!!id}
        list={<RuleList rules={shown} selectedId={id} filter={filter} onFilter={setFilter} query={query} onQuery={setQuery} onPick={k => open(k)} />}
        detail={selected ? <RuleDetail key={selected.id} r={selected} data={data} onBack={() => open(null)} />
          : <EmptyState title={id ? "Этого критерия нет в текущей оценке" : "Выберите критерий слева"}>{id ? "Критерии могли извлечь заново." : null}</EmptyState>}
      />
    </div>
  );
}
