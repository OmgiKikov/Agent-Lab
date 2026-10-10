import { Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../../lab/api";
import { otherKinds, type Kind } from "../../lab/criteria";
import { pct } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { NoModels } from "../settings/NoModels";
import { useToast } from "../../ui/toast";

/**
 * «Какие это ошибки»: the kinds of a criterion's errors (lab/criteria, kindsOf), each with how many of its `of` errors
 * it holds and a thin bar of their share, as a problem's row on «Итог» shows its count, then how many are of no kind.
 * A kind pressed shows only its examples; pressed again, every error.
 */
export function KindList({
  kinds,
  of,
  chosen,
  onChoose,
  className,
}: {
  kinds: Kind[];
  of: number;
  chosen: string | null;
  onChoose: (name: string | null) => void;
  className?: string;
}) {
  const other = otherKinds(kinds, of);
  return (
    <section aria-label="Какие это ошибки" className={className}>
      <h3 className="text-small font-medium text-fg-3">Какие это ошибки</h3>
      <ul className="mt-1.5">
        {kinds.map((k) => {
          const on = chosen === k.name;
          return (
            <li key={k.name}>
              <button
                type="button"
                aria-pressed={on}
                title={on ? "Показать все ошибки" : "Показать только эти ошибки"}
                onClick={() => onChoose(on ? null : k.name)}
                className={cn(
                  "-mx-2 grid w-[calc(100%+1rem)] grid-cols-[minmax(0,1fr)_auto_64px] items-center gap-x-3 rounded-sm px-2 py-1.5 text-left text-read transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
                  on ? "bg-hover font-medium text-fg" : "text-fg-2",
                )}
              >
                <span className="min-w-0">{k.name}</span>
                <span className="font-semibold tabular-nums text-fg">{k.count}</span>
                <span aria-hidden className="h-1 overflow-hidden rounded-full bg-well">
                  <span
                    className="block h-full rounded-full bg-fg/60"
                    style={{ width: `${Math.max(4, pct(k.count, of))}%` }}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {other && <p className="mt-1 text-small text-fg-3">{other}</p>}
    </section>
  );
}

/**
 * For a result checked before the model grouped errors by kind, or one it could not group then: «Сгруппировать
 * ошибки» asks it now, for every criterion of the result still without kinds, while the page waits for the task.
 */
export function GroupKinds({ className }: { className?: string }) {
  const { state, refresh } = useLabState();
  const toast = useToast();
  const grouping = !!state?.job.running && state.job.kind === "tone-kinds";
  const noModels = !!state?.models.problem;
  const group = () => api("/api/tone-of-voice/kinds", {}).then(() => refresh(), toast.error);
  return (
    <div className={className}>
      <Button icon={Layers} loading={grouping} disabled={!!state?.job.running || noModels} onClick={group}>
        {grouping ? "Группируем ошибки по видам" : "Сгруппировать ошибки по видам"}
      </Button>
      <p className="mt-1.5 text-small text-fg-3">
        Модель называет одну и ту же ошибку разными словами. Сгруппированные по смыслу, они покажут, что встречается
        чаще всего.
      </p>
      <NoModels outcome="сгруппировать ошибки не получится" className="mt-2" />
    </div>
  );
}
