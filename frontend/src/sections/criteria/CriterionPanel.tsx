import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, ArrowUpRight, Code2, FileText, PencilLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { problemLink, type Check } from "../../app/links";
import { duty, type Criterion } from "../../lab/criteria";
import { dialogOf, topicOf } from "../../lab/dialogs";
import { useLabState } from "../../lab/LabProvider";
import { askedOf, type Example } from "../../lab/problems";
import { answeredText, humansOf, humansText, misreadDetail, misreadOf, secondOf } from "../../lab/problemStats";
import { CLARIFIED_SINCE, toneJudgedByOther, toneReadAsChecked } from "../../lab/tone";
import { Count } from "../../product/Count";
import { Facts } from "../../product/Facts";
import { Reliability } from "../../product/Reliability";
import { SeverityControl } from "../../product/Severity";
import { shortOrigin } from "../../product/text";
import { Button } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { Segmented } from "../../ui/Segmented";
import { checked, errorIn } from "../problems/model";
import { Clarify } from "../tone/Clarify";
import { type SideKey } from "./model";
import { RuleText } from "./RuleText";

export type Shown = "FAIL" | "PASS" | "UNKNOWN";

/** One verdict of the criterion: how it is backed, where it was said when that says something, and its words. */
function ExampleRow({ e }: { e: Example }) {
  // Tone of voice names its one topic as the check itself, which says nothing in the check's own section (topicOf).
  const place = e.source === "log" ? topicOf({ check: e.check, topic: e.topic }) : `Симуляции · ${e.name ?? ""}`;
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-fg-3">
        {e.status === "FAIL" ? (
          <Reliability example={e} />
        ) : (
          <span>{e.status === "PASS" ? "без ошибки" : "не удалось проверить"}</span>
        )}
        {place && (
          <>
            <span aria-hidden>·</span>
            <span className="truncate">{place}</span>
          </>
        )}
        <Link to={dialogOf(e)} className="ml-auto inline-flex items-center gap-1 text-fg-2 hover:text-fg">
          разговор
          <ArrowUpRight aria-hidden className="size-3" />
        </Link>
      </div>
      <p className="mt-1.5 text-small text-fg-3">Клиент: {askedOf(e)}</p>
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
 * The chosen criterion: what it requires, «Важный критерий» (with the automatic check's proposal, its reason and
 * «Подтвердить», while no person decided), how it went in this stage — «N из M» of the checked conversations where it
 * applies, as «Итог» counts it — and the conversations behind each count. When people's answers show the model reads
 * it otherwise than they do, it says so, with «Уточнить критерий» on the result of the criteria in force.
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
  bare,
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
  /** In a sheet that names the criterion itself (ToneCriteria): no number and name of its own. */
  bare?: boolean;
  className?: string;
}) {
  const { state } = useLabState();
  const [clarifying, setClarifying] = useState(false);
  const r = c.r;
  const s = r[side];
  const second = secondOf(s.examples);
  const humans = humansOf(s);
  const misread = misreadOf(s);
  // A criterion of tone of voice is clarified on the result judged by the criteria in force, as on its problem's page.
  const finishedAt = state?.checks.tone?.finishedAt;
  const inForce =
    check === "tone" && side === "log" && !!state?.toneOfVoice && !!finishedAt && !toneJudgedByOther(state);
  const clarifiable = inForce && toneReadAsChecked(state, s.ruleIds[0]);
  // Under a tab, the verdicts its number counts (Side); the ones in conversations the check could not check as a whole
  // are said apart.
  const verdicts = s.examples.filter((e) => e.status === shown);
  const list = verdicts.filter((e) => e.counted !== false);
  const apart = verdicts.length - list.length;
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
        {!bare && (
          <>
            <p className="text-small text-fg-3">Критерий {c.n}</p>
            <h2 className="mt-1 text-balance text-title font-semibold text-fg">{c.name}</h2>
          </>
        )}
        <RuleText text={duty(r.rule.text)} className={cn("text-body text-fg-2", !bare && "mt-2")} />
        {r.rule.origin &&
          (r.rule.kind === "tone-of-voice" ? (
            <p className="mt-2 flex items-center gap-1.5 text-small text-fg-3" title="Где записан критерий">
              <FileText aria-hidden className="size-3.5" />
              <span>{r.rule.origin}</span>
            </p>
          ) : (
            <p
              className="mt-2 flex items-center gap-1.5 text-small text-fg-3"
              title="Где критерий записан в коде агента"
            >
              <Code2 aria-hidden className="size-3.5" />
              <span className="font-mono">{shortOrigin(r.rule.origin)}</span>
            </p>
          ))}
        <SeverityControl check={check} rule={r} className="mt-4" />
        <div className="mt-4">
          <Facts
            facts={[
              {
                label: side === "log" ? "Ошибка в разговорах, где он применим" : "Ошибка в симуляции",
                value: <Count n={s.failed} of={checked(s)} bad />,
                title: `Ошибка ${errorIn(s)}`,
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
                        "не с чем сравнить"
                      ),
                    },
                  ]
                : []),
              { label: "Ваши ответы", value: humans.checked ? answeredText(humans) : humansText(humans) },
            ]}
          />
        </div>
        {misread && (
          <div className="mt-4">
            <p className="text-body text-warn">{misreadDetail(misread)}</p>
            {clarifiable && (
              <Button icon={PencilLine} className="mt-3" onClick={() => setClarifying(true)}>
                Уточнить критерий
              </Button>
            )}
            {inForce && !clarifiable && <p className="mt-2 text-small text-fg-3">{CLARIFIED_SINCE}</p>}
          </div>
        )}
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
          {/* The counts are the check's own, as above (lab/problems, Side), and so are the rows under them. */}
          <Segmented<Shown>
            size="sm"
            label="Какие разговоры"
            value={shown}
            onChange={onShown}
            options={[
              { value: "FAIL", label: "С ошибкой", count: s.failed },
              { value: "PASS", label: "Без ошибки", count: s.passed },
              { value: "UNKNOWN", label: "Не проверено", count: s.unknown },
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
                ? "Разговоров без ошибки нет."
                : "Критерий удалось проверить во всех разговорах, где он встречался."}
          </p>
        )}
        {apart > 0 && (
          <p className="mt-3 text-small text-fg-3">
            {apart === 1
              ? "Ещё 1 — в разговоре, который не удалось проверить целиком; в счёт он не входит."
              : `Ещё ${apart} — в\u00a0разговорах, которые не удалось проверить целиком; в счёт они не входят.`}
          </p>
        )}
      </div>
      {clarifying && finishedAt && <Clarify r={r} finishedAt={finishedAt} onClose={() => setClarifying(false)} />}
    </aside>
  );
}
