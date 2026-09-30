import { ChevronDown } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { day, plural, when } from "../../lab/format";
import type { Problems } from "../../lab/problems";
import type { LabRun } from "../../lab/types";
import { LINKS } from "../../shell/links";
import { Facts, type Fact } from "../../ui/Facts";
import { Menu } from "../../ui/Menu";

/** Where the numbers come from, as Raindrop's run meta: one line, each piece opens its section. */
export function Summary({ data, runs, runId, onRun }: { data: Problems; runs: LabRun[]; runId: string | null; onRun: (id: string) => void }) {
  const navigate = useNavigate();
  const finished = runs.filter(r => r.finishedAt && r.status !== "running");
  const current = runId ?? data.sim?.runId;
  const facts: Fact[] = [
    { label: "Нарушается", value: `${data.problems.length} из ${data.rules.length} ${plural(data.rules.length, "правила", "правил", "правил")}`, onClick: () => navigate(LINKS.rules) },
  ];
  if (data.log) {
    facts.push({ label: "Логи", value: `оценено ${data.log.assessed} из ${data.log.sampled} · ${day(data.log.finishedAt)}`, onClick: () => navigate(`${LINKS.dialogs}?source=log`) });
    if (data.log.unassessed) facts.push({ label: "Без оценки", value: String(data.log.unassessed), onClick: () => navigate(`${LINKS.dialogs}?source=log&verdict=none`) });
  }
  facts.push({
    label: "Симуляция",
    value: finished.length ? (
      <Menu
        trigger={<span className="inline-flex items-center gap-1 text-small text-lab-soft hover:text-lab-ink">{data.sim ? `${data.sim.target} · ${day(data.sim.finishedAt)}` : "не выбрана"}<ChevronDown className="size-3" /></span>}
        items={finished.map(r => ({
          key: r.id, label: `${r.targetName} · ${r.version}`, on: r.id === current, run: () => onRun(r.id),
          sub: `${when(r.startedAt)} · ${r.metric?.total ?? 0} ${plural(r.metric?.total ?? 0, "диалог", "диалога", "диалогов")}`,
        }))}
      />
    ) : "не было",
  });
  return <Facts facts={facts} className="flex-shrink-0 border-b border-white/[0.06] px-4 py-2" />;
}
