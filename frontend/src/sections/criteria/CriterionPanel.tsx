import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, ArrowUpRight, Code2, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { problemLink, type Check } from "../../app/links";
import { duty, type Criterion } from "../../lab/criteria";
import { dialogOf } from "../../lab/dialogs";
import { plural } from "../../lab/format";
import type { Example } from "../../lab/problems";
import { humansOf, secondOf } from "../../lab/problemStats";
import { Count } from "../../product/Count";
import { Facts } from "../../product/Facts";
import { Reliability } from "../../product/Reliability";
import { SeveritySwitch } from "../../product/Severity";
import { shortOrigin } from "../../product/text";
import { Label } from "../../ui/Label";
import { Segmented } from "../../ui/Segmented";
import { type SideKey } from "./model";

export type Shown = "FAIL" | "PASS" | "UNKNOWN";

function ExampleRow({ e }: { e: Example }) {
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-fg-3">
        {e.status === "FAIL" ? (
          <Reliability example={e} />
        ) : (
          <span>{e.status === "PASS" ? "без ошибки" : "не удалось проверить"}</span>
        )}
        <span aria-hidden>·</span>
        <span className="truncate">
          {e.source === "log" ? `Диалоги${e.topic ? ` · ${e.topic}` : ""}` : `Симуляции · ${e.name ?? ""}`}
        </span>
        <Link to={dialogOf(e)} className="ml-auto inline-flex items-center gap-1 text-fg-2 hover:text-fg">
          разговор
          <ArrowUpRight aria-hidden className="size-3" />
        </Link>
      </div>
      <p className="mt-1.5 text-small text-fg-3">Клиент: {e.opening}</p>
      {e.agentQuote && (
        <p className="mt-1.5 text-body text-fg">
          <mark className={cn("rounded-sm px-0.5 text-fg", e.status === "FAIL" ? "bg-mark/70" : "bg-well")}>
            {e.agentQuote}
          </mark>
        </p>
      )}
      <p className="mt-1.5 text-small text-fg-2">{e.reason}</p>
    </li>
  );
}

/**
 * The chosen criterion: what it requires, the person's mark «Серьёзная ошибка», how it went in this stage, and the
 * conversations behind each count.
 */
export function CriterionPanel({
  c,
  check,
  side,
  runId,
  twice,
  shown,
  onShown,
  onBack,
  className,
}: {
  c: Criterion;
  check: Check;
  side: SideKey;
  runId?: string | null;
  /** A second model checked this side: only then is there anything to say about two checks. */
  twice: boolean;
  shown: Shown;
  onShown: (s: Shown) => void;
  onBack?: () => void;
  className?: string;
}) {
  const r = c.r;
  const s = r[side];
  const second = secondOf(s.examples);
  const humans = humansOf(s);
  const list = s.examples.filter((e) => e.status === shown);
  return (
    <aside
      className={cn("min-h-0 overflow-auto border-line bg-side lg:border-l", className)}
      aria-label={`Критерий ${c.n}`}
    >
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="sticky top-0 z-10 flex h-11 w-full items-center gap-1.5 border-b border-line bg-side px-3 text-body text-fg-2 lg:hidden"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Критерии
        </button>
      )}
      <div className="px-5 pb-10 pt-5">
        <p className="text-small text-fg-3">Критерий {c.n}</p>
        <h2 className="mt-1 text-balance text-title font-semibold text-fg">{c.name}</h2>
        <p className="mt-2 text-body text-fg-2">{duty(r.rule.text)}</p>
        {r.rule.origin &&
          (r.rule.kind === "tone-of-voice" ? (
            <p className="mt-2 flex items-center gap-1.5 text-small text-fg-3" title="Где это требование записано">
              <FileText aria-hidden className="size-3.5" />
              <span>{r.rule.origin}</span>
            </p>
          ) : (
            <p
              className="mt-2 flex items-center gap-1.5 text-small text-fg-3"
              title="Где это требование записано в коде агента"
            >
              <Code2 aria-hidden className="size-3.5" />
              <span className="font-mono">{shortOrigin(r.rule.origin)}</span>
            </p>
          ))}
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1">
          <SeveritySwitch check={check} rule={r} />
          <span className="text-small text-fg-3">
            {r.serious
              ? "Ошибки по этому критерию идут первыми и считаются отдельно."
              : "Без отметки ошибка незначительная."}
          </span>
        </div>
        <div className="mt-4">
          <Facts
            facts={[
              {
                label: side === "log" ? "Ошибка в диалогах" : "Ошибка в симуляции",
                value: <Count n={s.failed} of={s.failed + s.passed} bad />,
              },
              {
                label: "Не удалось проверить",
                value: s.unknown ? `в ${s.unknown} ${plural(s.unknown, "разговоре", "разговорах", "разговорах")}` : "—",
              },
              ...(twice
                ? [
                    {
                      label: "Две проверки",
                      value: second.checked ? (
                        <>
                          совпали в <Count n={second.agree} of={second.checked} />
                        </>
                      ) : (
                        "проверено один раз"
                      ),
                    },
                  ]
                : []),
              {
                label: "Ваши ответы",
                value: humans.checked
                  ? `подтвердили ${humans.agree}, не согласились ${humans.checked - humans.agree}`
                  : "ещё нет",
              },
            ]}
          />
        </div>
        {s.failed > 0 && (
          <Link
            to={problemLink(r.id, side === "sim" ? "sim" : check, runId)}
            className="mt-4 inline-flex items-center gap-1.5 rounded-sm text-body font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg-3"
          >
            Разбор проблемы
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        )}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Label>Разговоры</Label>
          <Segmented<Shown>
            size="sm"
            label="Какие разговоры"
            value={shown}
            onChange={onShown}
            options={[
              { value: "FAIL", label: "С ошибкой", count: s.examples.filter((e) => e.status === "FAIL").length },
              { value: "PASS", label: "Без ошибки", count: s.examples.filter((e) => e.status === "PASS").length },
              {
                value: "UNKNOWN",
                label: "Не проверено",
                count: s.examples.filter((e) => e.status === "UNKNOWN").length,
              },
            ]}
          />
        </div>
        <ul className="mt-2 divide-y divide-line">
          {list.map((e, i) => (
            <ExampleRow key={`${e.dialogueId ?? e.runId}-${e.index ?? i}`} e={e} />
          ))}
        </ul>
        {!list.length && (
          <p className="mt-4 text-small text-fg-3">
            {shown === "FAIL"
              ? "Ошибок по этому критерию не найдено."
              : shown === "PASS"
                ? "Разговоров без ошибки с доказательством нет."
                : "Все разговоры, где критерий встречался, проверены."}
          </p>
        )}
      </div>
    </aside>
  );
}
