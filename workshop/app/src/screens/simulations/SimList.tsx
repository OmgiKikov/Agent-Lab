import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { plural, when } from "../../lab/format";
import { FROM_LOG, isRunning, runTitle, runTypes } from "../../lab/runs";
import type { Card, LabRun, LabState } from "../../lab/types";
import { ListRow } from "../../ui/ListRow";
import { Segmented } from "../../ui/Segmented";

export type Mode = "runs" | "scenarios";

/** «Прогоны · Сценарии» over the list column. */
export function ModeBar({ mode, onMode, runs, scenarios }: { mode: Mode; onMode: (m: Mode) => void; runs: number; scenarios: number }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-white/[0.06] bg-lab-surface px-4 py-2.5">
      <Segmented<Mode> value={mode} onChange={onMode} options={[
        { value: "runs", label: "Прогоны", count: runs },
        { value: "scenarios", label: "Сценарии", count: scenarios },
      ]} />
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-small text-lab-dim">{children}</div>;
}

/** A run: which agent, when, how many dialogues had violations out of those the judge could assess. */
function RunRow({ run, state, selected, onClick }: { run: LabRun; state: LabState; selected: boolean; onClick: () => void }) {
  const m = run.metric;
  const live = isRunning(run);
  const job = state.job.running && state.job.progress.run === run.id ? state.job.progress : null;
  const types = runTypes(run, state);
  return (
    <ListRow selected={selected} onClick={onClick}>
      <div className="truncate text-body font-medium text-lab-ink">{runTitle(run)}</div>
      {run.label && <div className="mt-0.5 truncate text-small text-lab-soft">{run.label}</div>}
      <div className="mt-1 truncate text-meta text-lab-dim">
        {when(run.startedAt)}{m ? ` · ${m.total} ${plural(m.total, "диалог", "диалога", "диалогов")}` : ""} · {types.join(", ")}{run.repeats && run.repeats > 1 ? ` · повторы ×${run.repeats}` : ""}
      </div>
      {live ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-meta text-lab-accent">
          <span className="pulse-dot size-1.5 rounded-full bg-lab-accent" />идёт{job?.total ? ` · ${job.done ?? 0} из ${job.total}` : ""}
        </div>
      ) : run.status === "failed" ? <div className="mt-1.5 truncate text-meta text-lab-bad">Прервался: {run.error}</div>
        : run.status === "stopped" ? <div className="mt-1.5 text-meta text-lab-warn">Остановлен до конца</div> : null}
      {m && m.measured > 0 && (
        <div className="mt-1.5 text-small text-lab-text">
          нарушения в <span className={cn("font-mono", m.failed && "text-lab-bad")}>{m.failed}</span> из <span className="font-mono">{m.measured}</span>
          {m.unmeasured > 0 && <span className="text-meta text-lab-warn"> · без оценки {m.unmeasured}</span>}
        </div>
      )}
    </ListRow>
  );
}

/** The runs, newest first. */
export function RunList({ runs, state, selectedId, onPick, head }: { runs: LabRun[]; state: LabState; selectedId: string | null; onPick: (id: string) => void; head: ReactNode }) {
  return (
    <div>
      {head}
      {runs.map(r => <RunRow key={r.id} run={r} state={state} selected={r.id === selectedId} onClick={() => onPick(r.id)} />)}
      {!runs.length && <Empty>Прогонов пока нет</Empty>}
    </div>
  );
}

/** A scenario: its name, topic, where it came from and how many rules it checks. */
function ScenarioRow({ card, selected, onClick }: { card: Card; selected: boolean; onClick: () => void }) {
  return (
    <ListRow selected={selected} onClick={onClick}>
      <div className="line-clamp-2 text-small font-medium text-lab-ink">{card.name}</div>
      <div className="mt-1 truncate text-meta text-lab-dim">{card.topic}</div>
      <div className="mt-1 text-meta text-lab-mute">
        {card.origin === FROM_LOG ? "ошибка из лога" : "покрытие темы"} · {card.criteria.length} {plural(card.criteria.length, "правило", "правила", "правил")}
      </div>
    </ListRow>
  );
}

/** The scenarios, grouped by topic in the order the service built them. */
export function ScenarioList({ cards, selectedId, onPick, head }: { cards: Card[]; selectedId: string | null; onPick: (id: string) => void; head: ReactNode }) {
  return (
    <div>
      {head}
      {cards.map(c => <ScenarioRow key={c.id} card={c} selected={c.id === selectedId} onClick={() => onPick(c.id)} />)}
      {!cards.length && <Empty>Сценариев пока нет</Empty>}
    </div>
  );
}
