import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { cellOf, personaOf, scenariosOfRun, typesOfRun } from "../../lab/logic";
import type { Item, LabRun, LabState, Status } from "../../lab/types";

const SIGN: Record<string, { sign: string; word: string; tone: string }> = {
  FAIL: { sign: "✗", word: "нарушение", tone: "text-lab-bad" },
  PASS: { sign: "✓", word: "без обнаруженных нарушений", tone: "text-lab-ok" },
  RUNNING: { sign: "…", word: "идёт", tone: "text-lab-accent" },
  UNMEASURED: { sign: "?", word: "не оценён", tone: "text-lab-warn" },
};
const signOf = (status: Status) => SIGN[status] ?? SIGN.UNMEASURED;

/** The verdict of one dialogue as a sign; its word is in the title and in the legend. */
export function Sign({ status, className }: { status: Status; className?: string }) {
  const s = signOf(status);
  return <span title={s.word} aria-label={s.word} className={cn("w-3 flex-shrink-0 text-center font-mono text-small", s.tone, className)}>{s.sign}</span>;
}

/** Scenarios down, customer types across: each cell the verdicts of that scenario for that type, one sign per repeat. */
export function RunMatrix({ run, items, state, hrefOf, scores }: { run: LabRun; items: Item[]; state: LabState; hrefOf: (index: number) => string; scores?: boolean }) {
  const types = typesOfRun(run, state.personas);
  const scenarios = scenariosOfRun(items);
  const index = new Map(items.map((item, i) => [item, i]));
  return (
    <div className="mt-4">
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-meta text-lab-dim">
        {["FAIL", "PASS", "UNMEASURED"].map(k => <span key={k}><span className={cn("font-mono", SIGN[k].tone)}>{SIGN[k].sign}</span> {SIGN[k].word}</span>)}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-white/[0.08]">
              <th className="py-2 pr-4 align-bottom font-mono text-label font-normal uppercase tracking-[0.08em] text-lab-dim">Сценарий</th>
              {types.map(t => {
                // The service's per-type numbers when it has them, else counted from the dialogues themselves.
                const own = items.filter(i => personaOf(i) === t.id && (i.status === "PASS" || i.status === "FAIL"));
                const score = run.metric?.personas?.[t.id] ?? { measured: own.length, passed: own.filter(i => i.status === "PASS").length };
                return (
                  <th key={t.id} className="min-w-[110px] px-3 py-2 align-bottom font-normal">
                    <div className="text-small text-lab-text">{t.name}</div>
                    {scores && score && score.measured > 0 && <div className="mt-0.5 text-meta text-lab-dim">нарушения в {score.measured - score.passed} из {score.measured}</div>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {scenarios.map(s => (
              <tr key={s.id} className="border-b border-white/[0.06]">
                <td className="max-w-[360px] py-2.5 pr-4 text-small text-lab-ink">
                  <Link to={`/scenarios?s=${encodeURIComponent(s.id)}`} className="hover:underline hover:decoration-white/40 hover:underline-offset-4">{s.name}</Link>
                </td>
                {types.map(t => {
                  const cell = cellOf(items, s.id, t.id);
                  const own = items.filter(i => i.cardId === s.id && personaOf(i) === t.id);
                  return (
                    <td key={t.id} className="px-3 py-2.5">
                      {cell.state === "NONE" ? <span className="text-meta text-lab-faint">—</span> : (
                        <span className="inline-flex gap-1.5">
                          {own.map(i => (
                            <Link key={index.get(i)} to={hrefOf(index.get(i) ?? 0)} className="rounded px-0.5 transition-colors hover:bg-lab-hover">
                              <Sign status={i.status} />
                            </Link>
                          ))}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
