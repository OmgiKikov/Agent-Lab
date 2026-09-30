import { Link } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { day, plural, when } from "../../lab/format";
import { summarySentence } from "../../lab/problemReport";
import type { Problems } from "../../lab/problems";
import type { LabRun } from "../../lab/types";
import { LINKS } from "../../shell/links";
import { Menu } from "../../ui/Menu";

const Dot = () => <span className="text-lab-faint">·</span>;
const piece = "transition-colors hover:text-lab-text";

/** The answer in one sentence, and where its numbers come from: each piece opens its section. */
export function Summary({ data, runs, runId, onRun }: { data: Problems; runs: LabRun[]; runId: string | null; onRun: (id: string) => void }) {
  const total = data.rules.length;
  const finished = runs.filter(r => r.finishedAt && r.status !== "running");
  const current = runId ?? data.sim?.runId;
  return (
    <div className="flex-shrink-0 border-b border-white/[0.06] px-6 py-5">
      <h1 className="text-page font-semibold text-lab-ink">{summarySentence(data)}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-lab-mute">
        <Link to={LINKS.rules} className={piece}>{total} {plural(total, "правило", "правила", "правил")} из кода агента</Link>
        {data.log && (
          <>
            <Dot />
            <Link to={LINKS.dialogs} className={piece}>
              {data.log.assessed} из {data.log.sampled} {plural(data.log.sampled, "диалога", "диалогов", "диалогов")} логов {plural(data.log.assessed, "оценён", "оценены", "оценены")} {day(data.log.finishedAt)}
            </Link>
            {data.log.unassessed > 0 && <><Dot /><span>без оценки {data.log.unassessed}</span></>}
          </>
        )}
        <Dot />
        {finished.length ? (
          <Menu
            trigger={<span className={`inline-flex items-center gap-1 ${piece}`}>симуляция: {data.sim ? `${data.sim.target} · ${day(data.sim.finishedAt)}` : "не выбрана"}<ChevronDown className="size-3.5" /></span>}
            items={finished.map(r => ({
              key: r.id,
              label: `${r.targetName} · ${r.version}`,
              sub: `${when(r.startedAt)} · ${r.metric?.total ?? 0} ${plural(r.metric?.total ?? 0, "диалог", "диалога", "диалогов")}`,
              on: r.id === current,
              run: () => onRun(r.id),
            }))}
          />
        ) : <Link to={LINKS.simulations} className={piece}>симуляции не было</Link>}
      </div>
    </div>
  );
}
