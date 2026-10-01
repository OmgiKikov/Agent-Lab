import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, ArrowUpRight, Code2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { problemLink } from "../../app/links";
import type { Criterion } from "../../lab/criteria";
import { dialogOf } from "../../lab/dialogs";
import { plural } from "../../lab/format";
import type { Example } from "../../lab/problems";
import { humansOf, secondOf } from "../../lab/problemStats";
import { Count } from "../../product/Count";
import { Facts } from "../../product/Facts";
import { Reliability } from "../../product/Reliability";
import { shortOrigin } from "../../product/text";
import { Label } from "../../ui/Label";
import { Segmented } from "../../ui/Segmented";
import { type SideKey } from "./model";

export type Shown = "FAIL" | "PASS" | "UNKNOWN";

function ExampleRow({ e }: { e: Example }) {
  return (
    <li className="border-b border-line py-3.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-fg-3">
        {e.status === "FAIL" ? <Reliability example={e} /> : <span>{e.status === "PASS" ? "выполнен" : "не проверен"}</span>}
        <span aria-hidden>·</span>
        <span className="truncate">{e.source === "log" ? `лог${e.topic ? ` · ${e.topic}` : ""}` : `симуляция · ${e.name ?? ""}`}</span>
        <Link to={dialogOf(e)} className="ml-auto inline-flex items-center gap-1 text-fg-2 hover:text-fg">разговор<ArrowUpRight aria-hidden className="size-3" /></Link>
      </div>
      <p className="mt-1.5 text-small text-fg-3">Клиент: {e.opening}</p>
      {e.agentQuote && <p className="mt-1.5 text-body text-fg"><mark className={cn("rounded-sm px-0.5 text-fg", e.status === "FAIL" ? "bg-mark/70" : "bg-well")}>{e.agentQuote}</mark></p>}
      <p className="mt-1.5 text-small text-fg-2"><span className="text-fg-3">Судья: </span>{e.reason}</p>
    </li>
  );
}

/** The chosen criterion: what it requires, how it went on this side, and the dialogues behind each count. */
export function CriterionPanel({ c, side, shown, onShown, onBack, className }: {
  c: Criterion; side: SideKey; shown: Shown; onShown: (s: Shown) => void; onBack?: () => void; className?: string;
}) {
  const r = c.r;
  const s = r[side];
  const second = secondOf(s.examples);
  const humans = humansOf(s);
  const list = s.examples.filter(e => e.status === shown);
  return (
    <aside className={cn("min-h-0 overflow-auto border-line bg-side lg:border-l", className)} aria-label={`Критерий ${c.n}`}>
      {onBack && <button type="button" onClick={onBack} className="sticky top-0 z-10 flex h-11 w-full items-center gap-1.5 border-b border-line bg-side px-3 text-body text-fg-2 lg:hidden"><ArrowLeft aria-hidden className="size-4" />Критерии</button>}
      <div className="px-5 pb-10 pt-5">
        <p className="text-small text-fg-3">Критерий {c.n}</p>
        <h2 className="mt-1 text-balance text-title font-semibold text-fg">{c.name}</h2>
        <p className="mt-2 text-body text-fg-2">{r.rule.text}</p>
        {r.rule.origin && <p className="mt-2 flex items-center gap-1.5 text-meta text-fg-3" title="Где это требование записано в коде агента"><Code2 aria-hidden className="size-3.5" /><span className="font-mono">{shortOrigin(r.rule.origin)}</span></p>}
        <div className="mt-4">
          <Facts facts={[
            { label: side === "log" ? "В логах" : "В симуляции", value: <Count n={s.failed} of={s.failed + s.passed} bad /> },
            { label: "Не проверен", value: s.unknown ? `в ${s.unknown} ${plural(s.unknown, "разговоре", "разговорах", "разговорах")}` : "—" },
            { label: "Второй судья", value: second.checked ? <>согласен в <Count n={second.agree} of={second.checked} /></> : "не проверял" },
            { label: "Люди", value: humans.checked ? `подтвердили ${humans.agree}, не согласились ${humans.checked - humans.agree}` : "не проверяли" },
          ]} />
        </div>
        {s.failed > 0 && (
          <Link to={problemLink(r.id, { src: side })} className="mt-4 inline-flex items-center gap-1.5 rounded-sm text-body font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg-3">
            Разбор проблемы<ArrowRight aria-hidden className="size-4" />
          </Link>
        )}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Label>Разговоры</Label>
          <Segmented<Shown> size="sm" label="Какие разговоры" value={shown} onChange={onShown} options={[
            { value: "FAIL", label: "Нарушен", count: s.examples.filter(e => e.status === "FAIL").length },
            { value: "PASS", label: "Выполнен", count: s.examples.filter(e => e.status === "PASS").length },
            { value: "UNKNOWN", label: "Не проверен", count: s.examples.filter(e => e.status === "UNKNOWN").length },
          ]} />
        </div>
        <ul className="mt-2">{list.map((e, i) => <ExampleRow key={`${e.dialogueId ?? e.runId}-${e.index ?? i}`} e={e} />)}</ul>
        {!list.length && <p className="mt-4 text-small text-fg-3">{shown === "FAIL" ? "Нарушений этого критерия не найдено." : shown === "PASS" ? "Выполнений с доказательством нет." : "Все разговоры, где критерий встречался, оценены."}</p>}
      </div>
    </aside>
  );
}
