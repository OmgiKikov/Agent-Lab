import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowLeft, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Criterion } from "../../lab/criteria";
import { exampleFor, transcript, twoChecks, type DialogRow } from "../../lab/dialogs";
import { longDay, plural } from "../../lab/format";
import { personaName } from "../../lab/look";
import { download, secondLine } from "../../lab/problemReport";
import { useReview, useTurns, type Decision, type Example } from "../../lab/problems";
import type { Rule } from "../../lab/types";
import { Conversation, type Mark } from "../../product/Conversation";
import { Facts } from "../../product/Facts";
import { MarkNo } from "../../product/MarkNo";
import { ReviewButtons } from "../../product/ReviewButtons";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/EmptyState";
import { Segmented } from "../../ui/Segmented";
import { VerdictWord } from "./Rows";
import { criteriaByRule, type Named } from "./model";

type Tab = "talk" | "details";
const ORDER: Record<string, number> = { FAIL: 0, PASS: 1, UNKNOWN: 2, NOT_APPLICABLE: 3 };
const WORD: Record<string, [string, string]> = {
  FAIL: ["ошибка", "text-bad"],
  PASS: ["без ошибки", "text-ok"],
  UNKNOWN: ["не удалось проверить", "text-fg-3"],
  NOT_APPLICABLE: ["не относится к разговору", "text-fg-3"],
};

/** Every criterion the checks looked at in this conversation: errors first with their quote's number, then kept, then undecided. */
function Verdicts({
  rules,
  find,
  named,
  shownOf,
  lit,
  onLit,
  onDecide,
}: {
  rules: Rule[];
  find: (ruleId: string) => Criterion | undefined;
  named?: Named;
  shownOf: (r: Rule) => Example;
  lit: number | null;
  onLit: (n: number | null) => void;
  onDecide: (e: Example, d: Decision) => void;
}) {
  return (
    <section className="mt-10" aria-label="Проверка по критериям">
      <h3 className="text-lead font-semibold text-fg">
        Проверка по критериям <span className="font-normal tabular-nums text-fg-3">{rules.length}</span>
      </h3>
      <ul className="mt-3 divide-y divide-line">
        {rules.map((r) => {
          // A criterion that applied nowhere in a run is not among the problems: its frozen name and number stand in.
          const c = find(r.ruleId) ?? named?.get(r.ruleId);
          const shown = shownOf(r);
          // With one model there is no second check to speak of: the line is empty, and so is the place.
          const second = r.status === "FAIL" ? secondLine(shown, null) : "";
          const [word, tone] = WORD[r.status] ?? [r.status, "text-fg-3"];
          const n = c?.n;
          return (
            <li
              key={r.ruleId}
              onMouseEnter={() => n && r.status === "FAIL" && onLit(n)}
              onMouseLeave={() => onLit(null)}
              className={cn(
                "-mx-3 grid grid-cols-[24px_minmax(0,1fr)] gap-x-2 rounded-control px-3 py-4 transition-colors",
                n && lit === n && "bg-hover",
              )}
            >
              <span className="pt-0.5">
                {r.status === "FAIL" && r.agentQuote && n ? (
                  <MarkNo n={n} on={lit === n} />
                ) : (
                  <span className="text-small tabular-nums text-fg-4">{n ?? "·"}</span>
                )}
              </span>
              <div className="min-w-0">
                <p className="text-body text-fg">
                  <span className="font-medium">{c?.name ?? r.title ?? r.rule}</span>{" "}
                  <span className={cn("text-small", tone)}>· {word}</span>
                </p>
                <p className="mt-1 text-read text-fg-2">{r.reason}</p>
                {second && <p className="mt-1 text-small text-fg-3">{second}</p>}
                {(r.status === "FAIL" || r.status === "PASS") && (
                  <div className="mt-3">
                    <ReviewButtons size="sm" example={shown} onDecide={(d) => onDecide(shown, d)} />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** One conversation: what was said with the quotes the checks cited, numbered by their criteria; every criterion's result and the record. */
export function Dialog({
  row,
  criteria,
  named,
  onBack,
}: {
  row: DialogRow;
  criteria: Criterion[];
  /** Names and numbers of a run's criteria that applied nowhere in it (sections/dialogs/model.ts, frozenNames). */
  named?: Named;
  onBack?: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const { state } = useLabState();
  const review = useReview();
  const [lit, setLit] = useState<number | null>(null);
  // Answers shown at once, by result and verdict: a new check or a changed verdict does not inherit them.
  const [decided, setDecided] = useState<Record<string, Decision | null>>({});
  const raw = params.get("dt");
  const tab: Tab = raw === "details" ? raw : "talk";
  const setTab = (t: Tab) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (t === "talk") n.delete("dt");
        else n.set("dt", t);
        return n;
      },
      { replace: true },
    );
  const probe = {
    source: row.source === "sim" ? "sim" : "log",
    check: row.check,
    dialogueId: row.dialogueId,
    runId: row.runId,
    index: row.index,
  } as Example;
  const { turns, loading, error } = useTurns(probe);
  const byRule = criteriaByRule(criteria);
  const find = (ruleId: string) => byRule(row.source, ruleId);
  const rules = [...row.rules].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
  const marks: Mark[] = rules
    .filter((r) => r.status === "FAIL" && r.agentQuote)
    .flatMap((r) => {
      const c = find(r.ruleId);
      return c ? [{ quote: r.agentQuote, n: c.n }] : [];
    });
  const judged = rules.filter((r) => r.status === "PASS" || r.status === "FAIL").length;
  const broken = rules.filter((r) => r.status === "FAIL").length;
  const kept = rules.filter((r) => r.status === "PASS").length;
  const checks = twoChecks(row.status, row.second);
  const run = row.runId ? state?.runs.find((r) => r.id === row.runId) : undefined;
  const where =
    row.source === "log"
      ? ["Диалоги", row.topic].filter(Boolean).join(" · ")
      : [
          "Симуляция",
          run ? longDay(run.startedAt) : "",
          row.name,
          `клиент: ${personaName(state?.personas ?? [], row.persona)}`,
          row.attempt && row.attempt > 1 ? `повтор ${row.attempt}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
  // The check's result this conversation comes from; the service takes an answer only on it.
  const finishedAt = row.source === "log" && row.check ? state?.checks[row.check]?.finishedAt : null;
  const keyOf = (e: Example) => `${finishedAt ?? ""}|${e.ruleId}|${e.status}`;
  const shownOf = (r: Rule): Example => {
    const e = exampleFor(row, r);
    const k = keyOf(e);
    // The person's own answer here is on this criterion (as lab/problems withDecision puts it).
    return k in decided ? { ...e, review: decided[k], reviewScope: decided[k] ? "rule" : null } : e;
  };
  const decide = (e: Example, d: Decision) => {
    const next = e.review === d ? null : d;
    const k = keyOf(e);
    setDecided((x) => ({ ...x, [k]: next }));
    // Refused (the result changed, a check is running) or lost: the buttons show what the service has again.
    review.mutateAsync({ example: e, decision: next, finishedAt }).catch(() =>
      setDecided((x) => {
        if (x[k] !== next) return x;
        const n = { ...x };
        delete n[k];
        return n;
      }),
    );
  };
  const reviewed = rules.filter((r) => r.status === "FAIL" && shownOf(r).review).length;
  return (
    <article className="min-h-0 overflow-auto" aria-label={row.title}>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="sticky top-0 z-10 flex h-11 w-full items-center gap-1.5 border-b border-line bg-canvas px-3 text-body text-fg-2 lg:hidden"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Разговоры
        </button>
      )}
      <div className="max-w-4xl px-4 pb-16 pt-6 lg:px-10 lg:pt-8">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <VerdictWord status={row.status} />
          {row.disputed && <span className="text-small text-warn">модели разошлись</span>}
          <span className="text-small text-fg-3">{where}</span>
        </div>
        <div className="mt-2 flex items-start gap-5">
          <h2 className="min-w-0 flex-1 text-balance text-title font-semibold text-fg">{row.title}</h2>
          <div className="hidden flex-shrink-0 items-center gap-1 sm:flex">
            <Button
              icon={Download}
              disabled={!turns}
              onClick={() => turns && download(`dialog-${row.dialogueId ?? row.index}.md`, transcript(row, turns))}
            >
              Скачать
            </Button>
          </div>
        </div>
        <div className="mt-5">
          <Facts
            facts={[
              {
                label: "Ошибка",
                value: judged ? (
                  <>
                    <span className={cn("font-semibold tabular-nums", broken && "text-bad")}>{broken}</span>{" "}
                    <span className="text-fg-3">из</span> <span className="tabular-nums">{judged}</span>{" "}
                    <span className="text-fg-3">{plural(judged, "критерия", "критериев", "критериев")}</span>
                  </>
                ) : (
                  "—"
                ),
                title: "Из критериев, которые удалось проверить в этом разговоре",
              },
              {
                label: "Без ошибки",
                value: judged ? (
                  <>
                    <span className="tabular-nums">{kept}</span> <span className="text-fg-3">из</span>{" "}
                    <span className="tabular-nums">{judged}</span>
                  </>
                ) : (
                  "—"
                ),
              },
              // Only when a second check looked at this conversation: «проверено один раз» read as a person's check.
              ...(checks
                ? [
                    {
                      label: "Две проверки",
                      value: checks === "agree" ? "совпали" : "разошлись",
                      title: row.second?.model,
                    },
                  ]
                : []),
              { label: "Ваши ответы", value: reviewed ? `${reviewed}\u00a0из\u00a0${broken}` : "ещё нет" },
            ]}
          />
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Segmented<Tab>
            size="sm"
            label="Что показать"
            value={tab}
            onChange={setTab}
            options={[
              { value: "talk", label: "Разговор" },
              { value: "details", label: "Детали" },
            ]}
          />
        </div>
        {tab === "talk" && (
          <>
            <div className="mt-4 rounded-sheet bg-inset px-4 pb-5 pt-4 sm:px-6">
              {loading ? (
                <Skeleton className="h-40" />
              ) : error ? (
                <>
                  <p className="text-small text-bad">Не удалось загрузить разговор.</p>
                  <p className="mt-1 text-small text-fg-3">{error instanceof Error ? error.message : String(error)}</p>
                </>
              ) : turns ? (
                <Conversation turns={turns} marks={marks} lit={lit} onLit={(on, n) => setLit(on && n ? n : null)} />
              ) : (
                <p className="text-read text-fg">{row.title}</p>
              )}
            </div>
            {rules.length > 0 && (
              <Verdicts
                rules={rules}
                find={find}
                named={named}
                shownOf={shownOf}
                lit={lit}
                onLit={setLit}
                onDecide={decide}
              />
            )}
          </>
        )}
        {tab === "details" && (
          <pre className="mt-4 overflow-auto rounded-block bg-inset p-4 font-mono text-meta text-fg-3">
            {JSON.stringify(
              {
                источник: row.source,
                разговор: row.dialogueId,
                прогон: row.runId,
                номер: row.index,
                итог: row.status,
                вторая_проверка: row.second,
                критерии: row.rules,
              },
              null,
              2,
            )}
          </pre>
        )}
      </div>
    </article>
  );
}
