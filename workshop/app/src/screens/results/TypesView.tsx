import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { personaOf, scenariosOfRun, typesOfRun } from "../../lab/logic";
import type { Item, LabRun } from "../../lab/types";
import { useLabState } from "../../shell/LabProvider";
import { Label } from "../../ui/Label";

const finished = (i: Item) => i.status === "PASS" || i.status === "FAIL";

/** One paired bar: how many dialogues broke a criterion, how many did not, each «N из M» (measured ones only). */
function Pair({ failed, measured, href }: { failed: number; measured: number; href?: string }) {
  const passed = measured - failed;
  const body = (
    <div className="space-y-1.5">
      {([["Нарушения", failed, "bg-lab-bad", "text-lab-bad"], ["Без нарушений", passed, "bg-lab-ok", "text-lab-ok"]] as const).map(([label, n, fill, tone]) => (
        <div key={label} className="flex items-center gap-3">
          <span className="w-[104px] flex-shrink-0 text-meta text-lab-dim">{label}</span>
          <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
            <div className={cn("h-full rounded-full", fill)} style={{ width: `${measured ? (100 * n) / measured : 0}%` }} />
          </div>
          <span className="w-[72px] flex-shrink-0 text-right text-body text-lab-ink"><span className={n ? tone : undefined}>{n}</span> <span className="text-meta text-lab-dim">из {measured}</span></span>
        </div>
      ))}
    </div>
  );
  return href ? <Link to={href} className="block rounded-md transition-colors hover:bg-lab-hover">{body}</Link> : body;
}

/** «По типам клиентов»: the same dialogues cut by who played the customer, as paired bars; then scenario by scenario. */
export function TypesView({ run, items, hrefOf }: { run: LabRun; items: Item[]; hrefOf: (index: number) => string }) {
  const { state } = useLabState();
  const types = typesOfRun(run, state?.personas ?? []);
  const scenarios = scenariosOfRun(items);
  const measuredOf = (own: Item[]) => own.filter(finished);
  return (
    <div className="mx-auto max-w-[860px] px-6 pb-16 pt-6">
      <Label>По типам клиентов</Label>
      <div className={cn("mt-3 grid gap-4", types.length > 1 && "md:grid-cols-2")}>
        {types.map(t => {
          const own = items.filter(i => personaOf(i) === t.id);
          const done = measuredOf(own);
          const skipped = own.length - done.length;
          return (
            <section key={t.id} className="rounded-lg border border-white/[0.07] bg-lab-surface p-4">
              <div className="text-body font-medium text-lab-ink">{t.name}</div>
              <div className="mb-3 text-meta text-lab-dim">{own.length} диалогов{skipped > 0 && `, без оценки ${skipped}`}</div>
              {done.length ? <Pair failed={done.filter(i => i.status === "FAIL").length} measured={done.length} /> : <p className="text-meta text-lab-dim">Оценённых диалогов нет</p>}
            </section>
          );
        })}
      </div>
      <Label className="mt-10">По сценариям</Label>
      <div className="mt-2">
        {scenarios.map(s => (
          <div key={s.id} className="border-b border-white/[0.06] py-3">
            <Link to={`/scenarios?s=${encodeURIComponent(s.id)}`} className="text-body text-lab-ink hover:underline hover:decoration-white/40 hover:underline-offset-4">{s.name}</Link>
            <div className={cn("mt-2 grid gap-x-8 gap-y-3", types.length > 1 && "md:grid-cols-2")}>
              {types.map(t => {
                const own = items.filter(i => i.cardId === s.id && personaOf(i) === t.id);
                const done = measuredOf(own);
                const first = own.find(i => i.status === "FAIL") ?? own[0];
                return (
                  <div key={t.id}>
                    {types.length > 1 && <div className="mb-1 text-meta text-lab-mute">{t.name}</div>}
                    {!own.length ? <span className="text-meta text-lab-faint">не играли</span>
                      : !done.length ? <span className="text-meta text-lab-warn">не оценён</span>
                      : <Pair failed={done.filter(i => i.status === "FAIL").length} measured={done.length} href={first ? hrefOf(items.indexOf(first)) : undefined} />}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
