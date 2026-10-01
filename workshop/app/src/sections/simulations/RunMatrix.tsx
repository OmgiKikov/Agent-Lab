import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { scenariosLink } from "../../app/links";
import { cellOf, personaOf, scenariosOfRun, typesOfRun } from "../../lab/logic";
import { useLabState } from "../../lab/LabProvider";
import type { Item, LabRun, Status } from "../../lab/types";

const SIGN: Record<string, { sign: string; word: string; tone: string }> = {
  FAIL: { sign: "✗", word: "нарушение", tone: "text-bad" },
  PASS: { sign: "✓", word: "без обнаруженных нарушений", tone: "text-ok" },
  RUNNING: { sign: "…", word: "идёт", tone: "text-run" },
  UNMEASURED: { sign: "?", word: "не оценён", tone: "text-warn" },
};
const signOf = (status: Status) => SIGN[status] ?? SIGN.UNMEASURED;

/** The verdict of one dialogue as a sign; its word is in the title and in the legend. */
export function Sign({ status, className }: { status: Status; className?: string }) {
  const s = signOf(status);
  return <span title={s.word} aria-label={s.word} className={cn("w-3 flex-shrink-0 text-center text-small font-semibold", s.tone, className)}>{s.sign}</span>;
}

/** Scenarios down, customer types across: each cell the verdicts of that scenario for that type, one sign per repeat. */
export function RunMatrix({ run, items, hrefOf, scores }: { run: LabRun; items: Item[]; hrefOf: (index: number) => string; scores?: boolean }) {
  const { state } = useLabState();
  const types = typesOfRun(run, state?.personas ?? []);
  const scenarios = scenariosOfRun(items);
  const index = new Map(items.map((item, i) => [item, i]));
  return (
    <div className="mt-4">
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-meta text-fg-3">
        {["FAIL", "PASS", "UNMEASURED"].map(k => <span key={k}><span className={cn("font-semibold", SIGN[k].tone)}>{SIGN[k].sign}</span> {SIGN[k].word}</span>)}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line">
              <th className="py-2 pr-4 align-bottom text-small font-medium text-fg-3">Сценарий</th>
              {types.map(t => {
                // The service's per-type numbers when it has them, else counted from the dialogues themselves.
                const own = items.filter(i => personaOf(i) === t.id && (i.status === "PASS" || i.status === "FAIL"));
                const score = run.metric?.personas?.[t.id] ?? { measured: own.length, passed: own.filter(i => i.status === "PASS").length };
                return (
                  <th key={t.id} className="min-w-[110px] px-3 py-2 align-bottom font-normal">
                    <div className="text-small text-fg">{t.name}</div>
                    {scores && score && score.measured > 0 && <div className="mt-0.5 text-meta text-fg-3">нарушения в {score.measured - score.passed} из {score.measured}</div>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {scenarios.map(s => (
              <tr key={s.id} className="border-b border-line">
                <td className="max-w-[360px] py-2.5 pr-4 text-small text-fg">
                  <Link to={scenariosLink(s.id)} className="rounded-sm hover:underline hover:decoration-fg-4 hover:underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">{s.name}</Link>
                </td>
                {types.map(t => {
                  const cell = cellOf(items, s.id, t.id);
                  const own = items.filter(i => i.cardId === s.id && personaOf(i) === t.id);
                  return (
                    <td key={t.id} className="px-3 py-2.5">
                      {cell.state === "NONE" ? <span className="text-meta text-fg-4">—</span> : (
                        <span className="inline-flex gap-1.5">
                          {own.map(i => (
                            <Link key={index.get(i)} to={hrefOf(index.get(i) ?? 0)} className="rounded px-0.5 transition-colors hover:bg-hover">
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
