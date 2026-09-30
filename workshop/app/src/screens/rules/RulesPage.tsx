import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ListChecks, RotateCcw } from "lucide-react";
import { api } from "../../lab/api";
import { day, plural } from "../../lab/format";
import { useProblems, type Problems } from "../../lab/problems";
import type { LabState } from "../../lab/types";
import { decisions } from "../../lab/verdicts";
import { JobStrip } from "../../shell/Activity";
import { useKeys } from "../../shell/keys";
import { useLabState } from "../../shell/LabProvider";
import { LINKS } from "../../shell/links";
import { SectionHeader } from "../../shell/SectionHeader";
import { Button } from "../../ui/Button";
import { Facts, type Fact } from "../../ui/Facts";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Modal } from "../../ui/Modal";
import { Split } from "../../ui/Split";
import { useToast } from "../../ui/toast";
import { RuleDetail } from "./RuleDetail";
import { RuleList, matchesRule, type RuleFilter } from "./RuleList";

/** Where the rules come from and how far the verdicts can be trusted, as one line of run meta. */
function Summary({ data, state }: { data: Problems; state: LabState }) {
  const files = new Set(data.rules.map(r => r.rule.origin)).size;
  const logJudge = state.discover?.summary.secondJudge;
  const run = data.sim ? state.runs.find(r => r.id === data.sim?.runId) : undefined;
  const simJudge = run?.metric?.secondJudge;
  const people = decisions(data);
  const checked = people.agree + people.disagree;
  const facts: Fact[] = [
    { label: "Источников", value: String(files) },
    ...(data.log?.rulesSince ? [{ label: "Зафиксированы", value: day(data.log.rulesSince) }] : []),
    ...(logJudge ? [{ label: "Второй судья", value: `согласен в ${logJudge.agree} из ${logJudge.checked} (логи)${simJudge ? ` · ${simJudge.agree} из ${simJudge.checked} (симуляция)` : ""}` }] : []),
    { label: "Люди", value: checked ? `проверили ${checked}: верно ${people.agree}, неверно ${people.disagree}` : "не проверяли" },
  ];
  return <Facts facts={facts} className="flex-shrink-0 border-b border-white/[0.06] px-4 py-2" />;
}

/** «Извлечь заново»: new rules from the code; the old ones stop counting, so it asks first. */
function Reextract({ open, onClose }: { open: boolean; onClose: () => void }) {
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
      open={open} onClose={onClose} title="Извлечь правила заново"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" onClick={start} loading={starting} disabled={!!state?.job.running}>Извлечь и оценить {count} {plural(count, "диалог", "диалога", "диалогов")}</Button>
      </>}
    >
      <p className="text-small text-lab-mute">
        Судья прочитает промпты и инструменты агента заново, извлечёт правила и оценит по ним {count} {plural(count, "диалог", "диалога", "диалогов")} логов.
        Прежние правила перестанут действовать: счёты, ссылки на проблемы и решения людей по вердиктам начнутся заново.
      </p>
      <p className="mt-3 text-small text-lab-mute">Нужно, когда агент поменялся: новый промпт, новые инструменты.</p>
    </Modal>
  );
}

/** Правила: what the agent must do, quoted from its code, with every verdict behind the counts. */
export function RulesPage() {
  const { ruleId } = useParams<{ ruleId?: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { state, offline } = useLabState();
  const runId = params.get("run");
  const { data } = useProblems(runId);
  const [filter, setFilter] = useState<RuleFilter>("all");
  const [query, setQuery] = useState("");
  const [reextract, setReextract] = useState(false);
  const all = data?.rules ?? [];
  const shown = useMemo(() => all.filter(r => matchesRule(r, filter, query)), [all, filter, query]);
  const selected = ruleId ? all.find(r => r.id === ruleId) : undefined;
  const keep = runId ? `?run=${encodeURIComponent(runId)}` : "";
  const open = (id: string) => navigate(`/rules/${id}${keep}`);
  useEffect(() => {
    if (!ruleId && shown[0] && window.matchMedia("(min-width: 1024px)").matches) navigate(`/rules/${shown[0].id}${keep}`, { replace: true });
  }, [ruleId, shown, keep, navigate]);
  const step = (d: 1 | -1) => {
    if (!shown.length) return;
    const at = shown.findIndex(r => r.id === ruleId);
    open(shown[at < 0 ? 0 : Math.max(0, Math.min(shown.length - 1, at + d))].id);
  };
  useKeys({ KeyJ: () => step(1), ArrowDown: () => step(1), KeyK: () => step(-1), ArrowUp: () => step(-1) });

  if (offline && !state) return <ServiceDown />;
  const busy = !!state?.job.running;
  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        crumbs={[{ label: "Проблемы", to: "/problems" }, { label: "Все правила" }]}
        actions={<>
          <Button className="hidden sm:inline-flex" icon={RotateCcw} onClick={() => setReextract(true)} disabled={busy || !state?.discover} title={busy ? "Сейчас идёт другая задача" : undefined}>Извлечь заново</Button>
          <Button variant="primary" icon={ListChecks} onClick={() => navigate(LINKS.review)} disabled={!all.length}>Проверить вердикты</Button>
        </>}
        below={<JobStrip kinds={["discover"]} />}
      />
      {!state || (state.discover && !data) ? <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div>
        : !state.discover || !data ? (
          <EmptyState drop title="Правил пока нет" className="flex-1" action={<Link to="/problems" className="text-small text-lab-ink underline underline-offset-4">К первым шагам</Link>}>
            Правила извлекаются из кода агента при первой оценке логов.
          </EmptyState>
        ) : (
          <>
            <Summary data={data} state={state} />
            <Split
              showDetail={!!ruleId}
              list={<RuleList rules={shown} all={all} problems={data.problems.length} selectedId={ruleId ?? null} filter={filter} onFilter={setFilter} query={query} onQuery={setQuery} onPick={open} />}
              detail={selected ? <RuleDetail key={selected.id} r={selected} data={data} onBack={() => navigate(`/rules${keep}`)} />
                : <EmptyState title={ruleId ? "Этого правила нет в текущей оценке" : "Выберите правило слева"}>{ruleId ? "Правила могли извлечь заново." : null}</EmptyState>}
            />
          </>
        )}
      <Reextract open={reextract} onClose={() => setReextract(false)} />
    </div>
  );
}
