import { useMemo } from "react";
import { ArrowRight, Scale } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { count } from "../format";
import { disputed, itemKey, personaOf } from "../logic";
import { personaName, STATUS_TEXT } from "../look";
import type { Item, LabRun, LabState } from "../types";
import { useRunContext } from "../useRunContext";
import { Button, EmptyState, Hero, Kbd, Label, Numbers, Page, Section, Skeleton, StatusIcon } from "../ui";

const dialogs = (n: number) => count(n, "диалога", "диалогов", "диалогов");

/** Dialogues of the check with the service's own marks: the second judge's other verdict, or a person's «неверно». */
function DialogRows({ items, state, empty, right }: { items: Item[]; state: LabState; empty: string; right: (i: Item) => string }) {
  const navigate = useNavigate();
  if (!items.length) return <p className="rounded-lg border border-lab-line px-4 py-4 text-body text-lab-mute">{empty}</p>;
  return (
    <div className="divide-y divide-lab-line rounded-lg border border-lab-line bg-lab-panel">
      {items.map(i => (
        <button key={itemKey(i)} onClick={() => navigate(`/lab/dialogs/${encodeURIComponent(itemKey(i))}`)}
          className="lab-focus-inset group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-100 hover:bg-white/[0.03]">
          <StatusIcon status={i.status} size={12} className={i.status === "FAIL" ? "text-lab-bad" : "text-lab-mute"} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body text-lab-text">{i.name}</span>
            <span className="block truncate text-caption text-lab-mute">{personaName(state.personas, personaOf(i))}{i.attempt && i.attempt > 1 ? ` · повтор ${i.attempt}` : ""}</span>
          </span>
          <span className="flex-shrink-0 text-caption text-lab-mute">{right(i)}</span>
          <ArrowRight className="size-3.5 flex-shrink-0 text-lab-faint group-hover:text-lab-mute" />
        </button>
      ))}
    </div>
  );
}

/**
 * The judge's side of a check, as the service measures it (lab/metric.py): the second judge's agreement, the stability of repeats,
 * and a person's review of the verdicts. No level or threshold of its own: the numbers, and the dialogues behind them.
 */
export function TrustView({ state, run, onJudge }: { state: LabState; run: LabRun | null; onJudge: (runId: string) => void }) {
  const { finished } = useRunContext(state, run);
  const items = useMemo(() => finished?.items ?? [], [finished]);
  const split = useMemo(() => items.filter(disputed), [items]);
  const wrong = useMemo(() => items.filter(i => i.review === "disagree"), [items]);

  if (!state.runs.length) {
    return <Page title="Судья" icon={Scale}><EmptyState icon={Scale} title="Пока нечего сверять">Второй судья, повторы и сверка с человеком считаются по диалогам проверки версии. Проверьте версию агента хотя бы раз.</EmptyState></Page>;
  }
  if (!finished?.metric) return <Page title="Судья" icon={Scale}><Skeleton className="mt-10 h-4 w-1/2" /><Skeleton className="mt-4 h-[104px]" /></Page>;

  const m = finished.metric;
  const left = items.filter(i => (i.status === "PASS" || i.status === "FAIL") && !i.review).length;
  const reviewed = m.human?.reviewed ?? 0;

  return (
    <Page
      title="Судья" icon={Scale}
      primary={<Button variant="primary" disabled={!left} onClick={() => onJudge(finished.id)}>{reviewed ? `Продолжить сверку · ${left}` : "Сверить судью"}<ArrowRight className="size-3.5" /></Button>}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-8 text-caption text-lab-mute">
        <span className="inline-flex items-center gap-2"><Label>Версия</Label>{finished.version} · {count(m.measured, "оценённый диалог", "оценённых диалога", "оценённых диалогов")}</span>
        <span className="inline-flex items-center gap-2"><Label>Сверка</Label>ответ клавишами <Kbd>1</Kbd><Kbd>2</Kbd></span>
      </header>

      <Numbers className="mt-8" hero={
        <Hero
          label="Судья прав по сверке"
          value={m.human ? `${m.human.agree} из ${m.human.reviewed}` : "—"}
          sub={m.human ? `человек согласен с вердиктом судьи · сверено ${m.human.reviewed} из ${dialogs(m.total)}` : "Сверки ещё не было: ответьте на нескольких диалогах, верен ли вердикт."}
        />
      } facts={[
        { label: "Второй судья", value: m.secondJudge ? `согласен в ${m.secondJudge.agree} из ${m.secondJudge.checked}` : "не оценивал эти диалоги", title: m.secondJudge?.model },
        { label: "Повторы", value: m.repeats ? `одинаковый результат в ${m.repeats.stable} из ${m.repeats.scenarios}` : "проверка без повторов" },
        { label: "Ещё не сверено", value: count(left, "диалог", "диалога", "диалогов"), onClick: left ? () => onJudge(finished.id) : undefined },
      ]} />

      <div className="grid gap-x-8 lg:grid-cols-2">
        <Section title="Судьи расходятся" count={split.length || undefined} hint={split.length ? "второй судья вынес другой вердикт" : undefined}>
          <DialogRows items={split} state={state} empty="Второй судья согласен со всеми вердиктами." right={i => `второй: ${STATUS_TEXT[i.second!.status as keyof typeof STATUS_TEXT] ?? i.second!.status}`} />
        </Section>
        <Section title="Человек не согласен с судьёй" count={wrong.length || undefined}>
          <DialogRows items={wrong} state={state} empty={reviewed ? "Со всеми сверенными вердиктами человек согласен." : "Сверки ещё не было."} right={i => `судья: ${STATUS_TEXT[i.status]}`} />
        </Section>
      </div>

      <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-lab-line pt-4 text-caption text-lab-mute">
        <span className="inline-flex items-center gap-2"><Label>Судья и клиент</Label><span className="font-mono">{state.models.main ?? "новейшая из каталога"}</span></span>
        <span className="inline-flex items-center gap-2"><Label>Второй судья</Label><span className="font-mono">{state.models.second ?? "новейшая из каталога"}</span></span>
        <span className="inline-flex items-center gap-2"><Label>Через</Label>{state.models.via}</span>
      </div>
    </Page>
  );
}
