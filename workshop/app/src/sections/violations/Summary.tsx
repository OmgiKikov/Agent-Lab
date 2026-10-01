import { Link } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { day, plural } from "../../lab/format";
import type { Problems } from "../../lab/problems";
import { runTitle } from "../../lab/runs";
import { useLabState } from "../../shell/LabProvider";
import { SECTIONS } from "../../app/links";
import { Menu } from "../../ui/Menu";

const link = "rounded-sm text-fg-2 decoration-line-strong decoration-dotted underline underline-offset-4 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60";

/**
 * The answer first, then where it comes from: one sentence of the result, and the chain of numbers it is built from.
 * Every link opens what it counts; the logs and the simulation are told apart and never added up.
 */
export function Summary({ data, onRun }: { data: Problems; onRun: (runId: string) => void }) {
  const { state } = useLabState();
  const total = data.rules.length;
  const broken = data.rules.filter(r => r.log.failed > 0).length;
  const runs = [...(state?.runs ?? [])].filter(r => r.status !== "running" && r.metric).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const log = data.log;
  const sim = data.sim;
  const criteria = `${total} ${plural(total, "критерий", "критерия", "критериев")}`;
  return (
    <div className="border-b border-line px-4 pb-4 pt-4 lg:px-5">
      <h2 className="text-balance text-title font-semibold text-fg">
        {log
          ? broken
            ? <>В логах агент нарушает <span className="whitespace-nowrap text-bad">{broken} из {total}</span> своих критериев</>
            : <>Судья не нашёл нарушений ни одного из {criteria} в {log.assessed} {plural(log.assessed, "диалоге", "диалогах", "диалогах")} логов</>
          : sim ? <>Логи ещё не оценены; в симуляции нарушены {data.rules.filter(r => r.sim.failed > 0).length} из {criteria}</> : null}
      </h2>
      <div className="mt-1.5 flex flex-col items-start gap-1 text-small text-fg-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2">
        <Link to={SECTIONS.criteria} className={link}>{criteria} из кода агента</Link>
        {log && <><span aria-hidden className="hidden text-fg-4 sm:inline">·</span><Link to="/dialogs" className={link}>{log.assessed} из {log.sampled} диалогов логов оценены {day(log.finishedAt)}</Link></>}
        {log && log.unassessed > 0 && <><span aria-hidden className="hidden text-fg-4 sm:inline">·</span><Link to="/dialogs?v=none" className={link}>{log.unassessed} без оценки</Link></>}
        <span aria-hidden className="hidden text-fg-4 sm:inline">·</span>
        {sim && runs.length ? (
          <Menu
            trigger={<span className={`${link} inline-flex items-center gap-1`}>симуляция: прогон {day(sim.finishedAt)}, нарушения в {sim.withViolations} из {sim.dialogs}<ChevronDown aria-hidden className="size-3.5" /></span>}
            items={runs.map(r => ({ key: r.id, label: `${r.label || runTitle(r)}`, sub: `${day(r.startedAt)}${r.metric ? ` · нарушения в ${r.metric.failed} из ${r.metric.measured}` : ""}`, on: r.id === sim.runId, run: () => onRun(r.id) }))}
          />
        ) : <Link to={SECTIONS.simulations} className={link}>симуляций ещё не было</Link>}
      </div>
    </div>
  );
}
