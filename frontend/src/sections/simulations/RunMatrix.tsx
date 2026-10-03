import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { scenariosLink } from "../../app/links";
import { personaOf, scenariosOfRun, typesOfRun } from "../../lab/logic";
import { useLabState } from "../../lab/LabProvider";
import { ENTER, stagger } from "../../product/motion";
import type { Item, LabRun } from "../../lab/types";
import { DOT, Dot, dotOf } from "./parts";

/**
 * The run's signature: scenarios down, types of customers across, every conversation one dot — so where the agent breaks
 * is seen at once, by situation and by the kind of customer. A dot opens its conversation.
 */
export function RunMatrix({
  run,
  items,
  hrefOf,
  scores,
}: {
  run: LabRun;
  items: Item[];
  hrefOf: (index: number) => string;
  scores?: boolean;
}) {
  const { state } = useLabState();
  const types = typesOfRun(run, state?.personas ?? []);
  const scenarios = scenariosOfRun(items);
  const index = new Map(items.map((item, i) => [item, i]));
  const shown = (["FAIL", "PASS", "UNMEASURED", "RUNNING"] as const).filter(
    (k) => k !== "RUNNING" || items.some((i) => i.status === "RUNNING"),
  );
  return (
    <div className="mt-5">
      <ul className="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-small text-fg-3">
        {shown.map((k) => (
          <li key={k} className="flex items-center gap-1.5">
            <Dot status={k} className="size-2.5" />
            {DOT[k].word}
          </li>
        ))}
      </ul>
      <div className="-mx-4 overflow-x-auto px-4">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr>
              <th className="pb-3 pr-4 align-bottom text-small font-medium text-fg-3">Сценарий</th>
              {types.map((t) => {
                // The service's per-type numbers when it has them, else counted from the conversations themselves.
                const own = items.filter((i) => personaOf(i) === t.id && (i.status === "PASS" || i.status === "FAIL"));
                const score = run.metric?.personas?.[t.id] ?? {
                  measured: own.length,
                  passed: own.filter((i) => i.status === "PASS").length,
                };
                return (
                  <th key={t.id} className="min-w-[112px] px-3 pb-3 align-bottom font-normal">
                    <div className="text-body font-medium text-fg">{t.name}</div>
                    {scores && score && score.measured > 0 && (
                      <div className="mt-0.5 text-small text-fg-3">
                        ошибка в {score.measured - score.passed} из {score.measured}
                      </div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-line border-t border-line">
            {scenarios.map((s, i) => (
              <tr
                key={s.id}
                className={cn("group/row transition-colors hover:bg-hover/60", ENTER)}
                style={stagger(i, 30, 600)}
              >
                <td className="max-w-[380px] py-3 pr-4 text-body text-fg">
                  <Link
                    to={scenariosLink(s.id)}
                    className="rounded-sm hover:underline hover:decoration-fg-4 hover:underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
                  >
                    {s.name}
                  </Link>
                </td>
                {types.map((t) => {
                  const own = items.filter((i) => i.cardId === s.id && personaOf(i) === t.id);
                  return (
                    <td key={t.id} className="px-3 py-3">
                      {!own.length ? (
                        <span className="text-small text-fg-4">—</span>
                      ) : (
                        <span className="flex gap-1.5">
                          {own.map((i) => (
                            <Link
                              key={index.get(i)}
                              to={hrefOf(index.get(i) ?? 0)}
                              title={`${t.name}: ${dotOf(i.status).word}`}
                              aria-label={`${s.name}, ${t.name}: ${dotOf(i.status).word}`}
                              className="group/dot grid size-6 place-items-center rounded-full transition-colors hover:bg-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
                            >
                              <Dot status={i.status} className="group-hover/dot:scale-125" />
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
