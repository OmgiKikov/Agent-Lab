import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, RotateCcw } from "lucide-react";
import { historyLink, launchLink, stageRoot, type Check } from "../../app/links";
import { useKeys } from "../../app/keys";
import { useWide } from "../../app/useWide";
import { resultOf } from "../../lab/checks";
import { logKey, logRows } from "../../lab/dialogs";
import { count, longDay, time } from "../../lab/format";
import { loadHistory, notComparedText } from "../../lab/history";
import { useLaunches } from "../../lab/launches";
import { useLabState } from "../../lab/LabProvider";
import { StageResult } from "../../product/StageResult";
import { Button, buttonClass } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Dialog } from "../dialogs/Dialog";
import { matchesRow, toVerdict, type Verdict } from "../dialogs/model";
import { Rows } from "../dialogs/Rows";
import { queueOf } from "../problems/model";
import { ProblemRow } from "../problems/ProblemRow";
import { CheckHeader } from "./CheckHeader";
import { Delta } from "./Compare";
import { savedCriteria, useSaved, type SavedCriterion } from "./saved";
import { duty } from "../../lab/criteria";
import { plainRule, RuleText } from "../criteria/RuleText";

const PART = { bad: "fail", ok: "pass", none: "none" } as const;
const NONE = new Set<string>();

/**
 * A past check from «История» on a page of its own, read as «Итог» is: which export and when, its number and how it
 * stood to the check before it, its problems, and every conversation it judged with the quotes it cited — as it was
 * saved. The latest check is «Итог» itself: its address leads there, and answers are given there only. A problem or a
 * part of the number filters the conversations below (?rule=, ?v=), one opens beside the list (?d=), as in «Разговоры».
 */
export function RunPage({ check }: { check: Check }) {
  const { id = "" } = useParams();
  // Another past check is another page: what was searched or filtered on the one before does not come along.
  return <PastCheck key={id} check={check} id={id} />;
}

function PastCheck({ check, id }: { check: Check; id: string }) {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const wide = useWide();
  const [query, setQuery] = useState("");
  const { saved, error, isLoading, refetch } = useSaved(check, id);
  const result = resultOf(state, check);
  const history = useQuery({
    queryKey: ["history", check, result?.finishedAt ?? null, String(state?.job.running)],
    queryFn: () => loadHistory(check),
    enabled: !!state,
    staleTime: Infinity,
  });
  const launches = useLaunches(check, `${state?.job.id}-${state?.job.running}`);
  // The launch this check was the recorded answers of, when it came from one: its rules and the way to run it again.
  const launch = launches.data?.launches.find((l) => l.modes.dataset?.checkId === id);
  const criteria = useMemo(() => (saved ? savedCriteria(saved, check) : []), [saved, check]);
  const all = useMemo(() => (saved ? logRows(saved.result, check) : []), [saved, check]);
  const verdict = toVerdict(params.get("v"));
  const ruleId = params.get("rule");
  const rule = ruleId ? criteria.find((c) => c.r.id === ruleId) : undefined;
  const only = useMemo(
    () =>
      rule
        ? new Set(rule.r.log.examples.filter((e) => e.status === "FAIL").map((e) => logKey(e.dialogueId ?? "")))
        : null,
    [rule],
  );
  const rows = useMemo(() => all.filter((r) => matchesRow(r, verdict, query, only)), [all, verdict, query, only]);
  const asked = params.get("d");
  const key = asked ?? (wide ? (rows[0]?.key ?? null) : null);
  const selected = key ? all.find((r) => r.key === key) : undefined;
  const set = (edit: (n: URLSearchParams) => void, replace = true) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        edit(n);
        return n;
      },
      { replace },
    );
  // On a narrow screen a conversation opened from the list is a step of its own: «Назад» goes back to the list.
  const open = (k: string | null, step = false) =>
    set((n) => {
      if (k) n.set("d", k);
      else n.delete("d");
      n.delete("dt");
    }, !step);
  const step = (d: 1 | -1) => {
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.key === key);
    open(rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? -1 : i) + d))].key);
  };
  useKeys({ KeyJ: () => step(1), KeyK: () => step(-1) });

  // A filter chosen above, or «Все разговоры», brings the conversations into view, once for each choice. The page's
  // own scroll moves: scrollIntoView would also move the frame around it, whose overflow is hidden, under the head.
  const box = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const target =
    verdict !== "all" || ruleId || location.hash === "#conversations" ? `${verdict}|${ruleId}|${location.hash}` : "";
  const scrolled = useRef("");
  useEffect(() => {
    if (!target || scrolled.current === target || !section.current || !box.current) return;
    scrolled.current = target;
    const top = section.current.getBoundingClientRect().top - box.current.getBoundingClientRect().top;
    box.current.scrollBy({ top: top - 16, behavior: "smooth" });
  });

  const header = <CheckHeader check={check} />;
  const frame = (body: ReactNode) => (
    <div className="flex h-full flex-col">
      {header}
      <div ref={box} className="min-h-0 flex-1 overflow-auto">
        {body}
      </div>
    </div>
  );
  // The latest check is the result itself, with the answers that can still be given on it.
  if (result?.checkId && result.checkId === id) return <Navigate to={stageRoot(check)} replace />;
  if (offline && !state) return frame(<ServiceDown />);
  if (error)
    return frame(
      <EmptyState
        drop
        title="Не удалось открыть проверку"
        className="py-24"
        action={
          <>
            <Button icon={RotateCcw} onClick={() => void refetch()}>
              Повторить
            </Button>
            <Link to={historyLink(check)} className={buttonClass({ variant: "ghost" })}>
              К истории проверок
            </Link>
          </>
        }
      >
        Возможно, её больше нет в истории.
      </EmptyState>,
    );
  if (isLoading || !saved)
    return frame(
      <div className="space-y-6 px-4 pt-10 lg:px-10">
        <Skeleton className="h-36 max-w-3xl" />
        <Skeleton className="h-80 max-w-5xl" />
      </div>,
    );

  const line = saved.check;
  const { failed, measured, unmeasured } = line.summary;
  // The history's line of the check says how its difference reads (direction, verdict); its own record only how it
  // stands to the one before it.
  const comparison = history.data?.checks.find((c) => c.id === line.id)?.comparison ?? line.comparison;
  const previous = history.data?.checks.find((c) => c.id === comparison.previousId);
  const comparable = (comparison.kind === "new-data" || comparison.kind === "same-data") && previous;
  const problems = queueOf(criteria, "log");
  const self = historyLink(check, line.id);
  const dialogue = selected ? saved.dialogues.find((d) => d.id === selected.dialogueId) : undefined;
  const showDetail = !!selected && (wide || !!asked);
  return frame(
    <div className="px-4 pb-24 pt-6 lg:px-10 lg:pt-8">
      <div className="max-w-[1040px]">
        <Link
          to={historyLink(check)}
          className="inline-flex items-center gap-1.5 rounded-sm text-body text-fg-3 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
        >
          <ArrowLeft aria-hidden className="size-4" />
          История проверок
        </Link>
        <p className="mt-6 break-words text-read text-fg-3">
          {line.file ? `«${line.file}» · ` : ""}проверено {longDay(line.finishedAt)}, {time(line.finishedAt)}
          {line.sampled < line.total ? ` · выборка ${line.sampled} из ${line.total}` : ""}
          {launch?.judge ? ` · правила «${launch.judge.name}», версия ${launch.judge.version}` : ""}
          {launch?.agentVersion ? ` · ${launch.agentVersion}` : ""}
          {launch && (
            <>
              {" · "}
              <Link to={launchLink(check, launch.id)} className="rounded-sm text-run hover:underline">
                запуск
              </Link>
            </>
          )}
        </p>
        <StageResult
          className="mt-4"
          failed={failed}
          checked={measured}
          unchecked={unmeasured}
          link={(part) => `${self}?v=${PART[part]}`}
          all={`${self}#conversations`}
          delta={
            comparable &&
            previous.summary.measured > 0 && (
              <Delta
                to={historyLink(check, previous.id)}
                at={previous.finishedAt}
                before={previous.summary}
                direction={comparison.direction}
                verdict={comparison.verdict}
                again={comparison.kind === "same-data"}
                label={`${previous.summary.failed} из ${previous.summary.measured} → ${failed} из ${measured}`}
              />
            )
          }
        />
        <div className="mt-6 flex max-w-[760px] flex-wrap items-center gap-x-4 gap-y-2 rounded-block bg-inset px-4 py-3">
          <p className="min-w-0 flex-1 text-body text-fg-2">
            Это прошлая проверка: разговоры и оценки сохранены такими, какими были. Ответить «ошибка или нет» можно в
            последней.
          </p>
          <Link to={stageRoot(check)} className={buttonClass({ size: "sm" })}>
            К итогу
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>
        {comparison.kind === "incompatible" && comparison.previousId && (
          <p className="mt-3 max-w-[760px] text-body text-fg-3">{notComparedText(comparison.reason)}</p>
        )}

        <section aria-label="Проблемы" className="mt-16">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line pb-3">
            <h2 className="text-title font-semibold text-fg">Проблемы</h2>
            <p className="text-read text-fg-3">
              {problems.length
                ? `Агент ошибался по ${problems.length} из ${count(criteria.length, "критерия", "критериев", "критериев")}`
                : "Ошибок не нашли"}
            </p>
          </div>
          {problems.length > 0 && (
            <>
              <p className="pt-2 text-small text-fg-3">
                Второе число показывает, в скольких разговорах удалось проверить критерий.
              </p>
              <ol className="divide-y divide-line">
                {problems.map((c, i) => (
                  <li key={c.r.id}>
                    <ProblemRow c={c} side="log" rank={i + 1} to={`${self}?rule=${encodeURIComponent(c.r.id)}`} />
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </div>

      <section ref={section} id="conversations" aria-label="Разговоры" className="mt-16 max-w-[1180px] scroll-mt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line pb-3">
          <h2 className="text-title font-semibold text-fg">Разговоры</h2>
          <p className="text-read text-fg-3">
            {count(all.length, "разговор", "разговора", "разговоров")} этой проверки
          </p>
        </div>
        <div className="mt-4 grid overflow-hidden rounded-block border border-line lg:h-[min(860px,calc(100vh-7rem))] lg:grid-cols-[360px_minmax(0,1fr)]">
          <Rows
            className={showDetail && !wide ? "hidden" : "max-h-[70vh] lg:max-h-none"}
            empty="В этой проверке нет разговоров."
            all={all}
            rows={rows}
            verdict={verdict}
            onVerdict={(v: Verdict) =>
              set((n) => {
                if (v === "all") n.delete("v");
                else n.set("v", v);
                n.delete("d");
              })
            }
            rule={rule ? { text: `Ошибка по критерию ${rule.n}: ${rule.name}` } : null}
            serious={NONE}
            onClearRule={() => set((n) => n.delete("rule"))}
            query={query}
            onQuery={setQuery}
            selected={key}
            onOpen={(k) => open(k, !wide)}
            criteria={criteria}
            personas={state?.personas ?? []}
          />
          {showDetail && selected ? (
            <Dialog
              key={selected.key}
              row={selected}
              criteria={criteria}
              onBack={wide ? undefined : () => open(null)}
              saved={{
                turns: dialogue
                  ? dialogue.messages.map((m) => ({
                      role: m.role === "user" ? ("customer" as const) : ("agent" as const),
                      text: m.content,
                    }))
                  : null,
              }}
            />
          ) : (
            wide && (
              <EmptyState drop title={all.length ? "Выберите разговор" : "Разговоров нет"} className="justify-center">
                {all.length
                  ? "Слева все разговоры этой проверки. Листайте их клавишами J и K."
                  : "В этой проверке нет разговоров."}
              </EmptyState>
            )
          )}
        </div>
      </section>

      <div className="mt-12 max-w-[1040px] space-y-4">
        <details className="border-t border-line pt-5">
          <summary className="cursor-pointer text-read font-medium text-fg">
            Критерии этой проверки · {saved.criteria.length}
          </summary>
          <ol className="mt-4 space-y-5 text-body text-fg-2">
            {saved.criteria.map((criterion, index) => (
              <li key={criterion.id}>
                <span className="font-medium text-fg">
                  {index + 1}. {criterion.name}
                </span>
                <RuleText text={criterion.text} className="mt-1" />
                <CriterionFacts criterion={criterion} />
              </li>
            ))}
          </ol>
        </details>
        <details className="border-t border-line pt-5">
          <summary className="cursor-pointer text-read font-medium text-fg">{saved.source.title}</summary>
          {saved.source.body}
        </details>
        <p className="border-t border-line pt-5 text-small text-fg-3">{saved.note}</p>
      </div>
    </div>,
  );
}

/** What a criterion of a past check said besides its text: when it applied, what was acceptable, what people
 * clarified, and the words of the rules it came from. */
function CriterionFacts({ criterion }: { criterion: SavedCriterion }) {
  const facts: [string, ReactNode][] = [
    ["Когда применяется", criterion.condition],
    ["Исключения и допустимое", criterion.acceptable ? <RuleText text={criterion.acceptable} /> : null],
    [
      "Уточнения команды",
      criterion.clarifications?.length ? (
        <ul className="list-disc space-y-0.5 pl-5">
          {criterion.clarifications.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null,
    ],
    // The rules' words without their headings («## Объём: text_volume»), as the criterion's card says them.
    [
      "Основание в правилах",
      criterion.quote && criterion.quote !== criterion.text ? `«${plainRule(duty(criterion.quote))}»` : null,
    ],
  ];
  const shown = facts.filter(([, value]) => !!value);
  if (!shown.length) return null;
  return (
    <dl className="mt-2 space-y-1.5 text-small text-fg-3">
      {shown.map(([label, value]) => (
        <div key={label}>
          <dt className="font-medium text-fg-2">{label}</dt>
          <dd className="mt-0.5 whitespace-pre-wrap">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
