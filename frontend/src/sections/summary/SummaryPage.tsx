import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import { Copy, FileDown, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { SECTIONS } from "../../app/links";
import { answersOf, answersSentence } from "../../lab/answers";
import { api } from "../../lab/api";
import { CHECK_NAME, CHECKS, resultOf } from "../../lab/checks";
import { compareSentence, seriousCompareText } from "../../lab/compare";
import { duty, useCriteria, type Criterion } from "../../lab/criteria";
import { pct } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { copyReport, useReportAgent } from "../../lab/problemReport";
import { useProblems, type Example, type LogDialogue } from "../../lab/problems";
import { humansOf } from "../../lab/problemStats";
import { splitQuote } from "../../lab/quote";
import {
  chosenOf,
  daysText,
  fullDay,
  howOf,
  madeText,
  problemAnswers,
  readChosen,
  rechecked,
  SUMMARY_WHAT,
  summaryMarkdown,
  writeChosen,
  type Chosen,
  type Summary,
  type SummaryCheck,
  type SummaryExample,
  type SummaryProblem,
} from "../../lab/summary";
import { seriousOf, severityLines, standingOf, type Serious, type Standing } from "../../lab/severity";
import type { Check } from "../../lab/types";
import { SeriousTag } from "../../product/Severity";
import { StageResult } from "../../product/StageResult";
import { visible } from "../../product/text";
import { Button, buttonClass } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { useToast } from "../../ui/toast";
import { useComparison } from "../checks/Compare";
import { queueOf, violationsOf } from "../problems/model";

/** The example a problem shows: one the people did not refute, else its first; with the words the check pointed at. */
const exampleFor = (examples: Example[]) => examples.find((e) => e.review !== "disagree") ?? examples[0];

/**
 * The agent's reply with the words the check pointed at, and the customer's message before it. Without the
 * conversation at hand, or when the words are not in a reply (a step the agent took), only the words and the first
 * message of the customer.
 */
function exampleOf(e: Example, dialogue: LogDialogue | undefined): SummaryExample | null {
  if (!e.agentQuote) return null;
  const messages = dialogue?.messages ?? [];
  const at = messages.findIndex((m) => m.role === "assistant" && splitQuote(visible(m.content).text, e.agentQuote));
  const before = messages.slice(0, Math.max(0, at)).filter((m) => m.role === "user");
  const customer = at < 0 ? e.opening : (before[before.length - 1]?.content ?? null);
  return {
    customer: customer ? visible(customer).text : null,
    reply: at < 0 ? null : visible(messages[at].content).text,
    quote: e.agentQuote,
    refuted: e.review === "disagree",
  };
}

/**
 * «Сводка для руководителя» (/summary): one page of the agent for someone who does not use the product — each check's
 * number with its denominator, its conversations with a serious error and whose decision that is (how many criteria
 * people checked of the automatic check's proposals), the same number with people's answers, how it stands to the
 * check's previous check, and the problems the person ticked (the serious ones by default), each with what the agent
 * must do, its count, people's answers and one reply of the agent.
 * The ticks are kept in this browser, per agent; «Скачать PDF» prints the page (no navigation, buttons or ticks; A4),
 * «Скопировать для письма» puts the same on the clipboard. Numbers, answers and examples; no verdict on the agent.
 * Both wait for the agent's name and for the problems: what could not be loaded says so, with «Повторить».
 */
export function SummaryPage() {
  const { state, offline } = useLabState();
  // The letter and the PDF are named after the agent: never sent under a placeholder while its name is unknown.
  const agent = useReportAgent();
  const toast = useToast();
  const criteria: Record<Check, ReturnType<typeof useCriteria>> = {
    tone: useCriteria(resultOf(state, "tone") ? "tone" : null),
    code: useCriteria(resultOf(state, "code") ? "code" : null),
  };
  // The same records as the criteria's, for whether they failed to load: then «Главное» says so instead of waiting.
  const loads: Record<Check, ReturnType<typeof useProblems>> = {
    tone: useProblems(resultOf(state, "tone") ? "tone" : null),
    code: useProblems(resultOf(state, "code") ? "code" : null),
  };
  const compares = { tone: useComparison("tone"), code: useComparison("code") };
  const [stored, setStored] = useState<Chosen>(readChosen);

  // The tab, and the PDF saved from it, are named after the summary and its agent while the page is open.
  useEffect(() => {
    if (!agent.name) return;
    const before = document.title;
    document.title = `Сводка для руководителя — ${agent.name}`;
    return () => {
      document.title = before;
    };
  }, [agent.name]);

  // The checks with a result, each with its problems, serious first, then the most frequent — of that very result,
  // not of one replaced meanwhile (null until they are at hand) — its serious count, and the ones ticked: by default
  // the serious problems, else the three most frequent.
  const checks = CHECKS.filter((c) => resultOf(state, c));
  const problems = {} as Record<Check, Criterion[] | null>;
  const serious = {} as Record<Check, Serious | null>;
  const standing = {} as Record<Check, Standing | null>;
  const ticked = {} as Record<Check, Set<string>>;
  for (const check of CHECKS) {
    const { data, list } = criteria[check];
    const current = data?.log?.finishedAt === resultOf(state, check)?.finishedAt;
    problems[check] = current ? queueOf(list, "log") : null;
    serious[check] = current ? seriousOf(data) : null;
    standing[check] = current && data?.log?.assessed ? standingOf(data) : null;
    const own = problems[check] ?? [];
    ticked[check] = chosenOf(
      stored[check],
      own.map((c) => c.r.id),
      own.filter((c) => c.r.serious).map((c) => c.r.id),
    );
  }
  const examples = checks.flatMap((check) =>
    (problems[check] ?? [])
      .filter((c) => ticked[check].has(c.r.id))
      .map((c) => exampleFor(violationsOf(c, "log")))
      .filter((e): e is Example => !!e),
  );
  // The conversations of the ticked examples, as «Весь разговор» reads them (lab/problems, useTurns): one cache.
  const dialogues = useQueries({
    queries: examples.map((e) => ({
      queryKey: ["dialogue", e.dialogueId, e.check, state?.logs.updatedAt],
      queryFn: () =>
        api<LogDialogue>(`/api/logs/${encodeURIComponent(e.dialogueId ?? "")}${e.check ? `?check=${e.check}` : ""}`),
      staleTime: Infinity,
    })),
  });
  const dialogueOf = (e: Example) => dialogues[examples.indexOf(e)]?.data;

  const toggle = (check: Check, id: string) => {
    const ids = [...ticked[check]];
    const next = { ...stored, [check]: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] };
    setStored(next);
    writeChosen(next);
  };

  const summary: Summary | null = state
    ? {
        // Told only once the name is at hand (`ready`): the page waits for it, never shows another.
        agent: agent.name ?? "",
        file: state.logs.file ?? null,
        days: [...new Set(checks.map((c) => fullDay(resultOf(state, c)!.finishedAt)))],
        madeAt: new Date().toISOString(),
        checks: checks.map((check): SummaryCheck => {
          const result = resultOf(state, check)!;
          const compare = compares[check];
          const sentence = compare && compareSentence(compare);
          const ids = ticked[check];
          return {
            check,
            day: fullDay(result.finishedAt),
            measured: result.summary.measured,
            failed: result.summary.failed,
            unmeasured: result.summary.unmeasured,
            answers: answersOf(result)!,
            serious: serious[check],
            severity: standing[check] ? severityLines(standing[check], serious[check], "people") : [],
            compare: sentence ? `${sentence.head}${sentence.rest}` : null,
            seriousCompare: compare && serious[check] ? seriousCompareText(compare, serious[check].marked) : null,
            problems: (problems[check] ?? []).map((c): SummaryProblem => {
              const s = c.r.log;
              const people = humansOf(s);
              const e = ids.has(c.r.id) ? exampleFor(violationsOf(c, "log")) : undefined;
              return {
                id: c.r.id,
                chosen: ids.has(c.r.id),
                serious: c.r.serious,
                severity: c.r.severity,
                title: c.r.title,
                duty: duty(c.r.rule.text),
                failed: s.failed,
                checked: s.failed + s.passed,
                yes: people.agree,
                no: people.checked - people.agree,
                example: e ? exampleOf(e, dialogueOf(e)) : null,
              };
            }),
          };
        }),
      }
    : null;
  const ready = !!summary && !!agent.name && checks.every((c) => problems[c]) && dialogues.every((d) => !d.isLoading);

  const copy = () => {
    if (summary) copyReport(summaryMarkdown(summary)).then(() => toast.notify("Сводка скопирована"), toast.error);
  };

  const header = (
    <div className="print:hidden">
      <Header
        title="Сводка для руководителя"
        crumbs={[{ label: "Обзор", to: SECTIONS.overview }]}
        actions={
          checks.length > 0 && (
            <>
              <Button icon={Copy} aria-label="Скопировать для письма" disabled={!ready} onClick={copy}>
                <span className="hidden sm:inline">Скопировать для письма</span>
              </Button>
              <Button
                variant="primary"
                icon={FileDown}
                aria-label="Скачать PDF"
                disabled={!ready}
                onClick={() => window.print()}
              >
                <span className="hidden sm:inline">Скачать PDF</span>
              </Button>
            </>
          )
        }
      />
    </div>
  );
  const page = (body: ReactNode) => (
    <div className="flex h-full flex-col print:block print:h-auto">
      {header}
      <div className="min-h-0 flex-1 overflow-auto print:overflow-visible">{body}</div>
    </div>
  );
  if (offline && !state) return page(<ServiceDown />);
  if (!summary)
    return page(
      <div className="max-w-[860px] space-y-6 px-4 pt-10 lg:px-10">
        <Skeleton className="h-28" />
        <Skeleton className="h-72" />
      </div>,
    );
  if (!summary.checks.length)
    return page(
      <EmptyState
        drop
        title="Здесь будет сводка для руководителя"
        className="h-full justify-center"
        action={
          <Link to={SECTIONS.overview} className={buttonClass()}>
            Открыть обзор
          </Link>
        }
      >
        Она собирается из итогов проверок. Проверьте разговоры, и здесь появятся числа, ответы людей и главные проблемы.
      </EmptyState>,
    );

  const several = summary.days.length > 1;
  return page(
    <article className="max-w-[860px] px-4 pb-24 pt-8 lg:px-10 lg:pt-12 print:max-w-none print:p-0">
      {/* On paper the page has no head: the title goes on the sheet. */}
      <p className="hidden text-read text-fg-3 print:block">Сводка для руководителя</p>
      {agent.name ? (
        <h2 className="text-page font-semibold text-fg print:mt-1">{agent.name}</h2>
      ) : agent.failed ? (
        <Failed text="Не удалось загрузить имя агента." onRetry={agent.retry} />
      ) : (
        <Skeleton className="h-10 w-72 max-w-full" />
      )}
      <p className="mt-2 break-words text-read text-fg-2">
        {summary.file ? `Выгрузка «${summary.file}» · ` : ""}
        {daysText(summary.days)}
      </p>

      {summary.checks.map((c) => (
        <CheckPart key={c.check} c={c} dated={several} />
      ))}

      <section aria-labelledby="summary-main" className="mt-14 border-t border-line pt-8 print:mt-10">
        <h3 id="summary-main" className="text-title font-semibold text-fg print:break-after-avoid">
          Главное
        </h3>
        <p className="mt-1 max-w-[68ch] text-body text-fg-3 print:hidden">
          В PDF и письмо войдут только отмеченные проблемы.{" "}
          {summary.checks.some((c) => c.problems.some((p) => p.serious))
            ? "Сразу отмечены серьёзные, а где их нет, три самые частые."
            : "Сразу отмечены три самые частые проблемы каждой проверки."}
        </p>
        {summary.checks.map((c) => (
          <CheckProblems
            key={c.check}
            c={c}
            loading={!problems[c.check]}
            failed={loads[c.check].isError && !problems[c.check]}
            onRetry={() => void loads[c.check].refetch()}
            onToggle={(id) => toggle(c.check, id)}
          />
        ))}
      </section>

      <footer className="mt-14 border-t border-line pt-5 text-small text-fg-3 print:mt-10 print:break-inside-avoid">
        <p className="font-medium text-fg-2">Как считали</p>
        <ul className="mt-1.5 max-w-[80ch] space-y-1">
          {howOf(summary).map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>{madeText(summary)}</li>
        </ul>
      </footer>
    </article>,
  );
}

/**
 * One check: its number as «Итог» shows it, with its serious errors and whose decision they are, people's answers, its
 * previous check and who found the errors.
 */
function CheckPart({ c, dated }: { c: SummaryCheck; dated: boolean }) {
  // People's answers count the checked conversations: with none checked there is no «0 из 0» to give.
  const answers = c.measured ? answersSentence(c.answers, "people") : null;
  const found = rechecked(c.answers);
  return (
    <section aria-label={CHECK_NAME[c.check]} className="mt-12 break-inside-avoid print:mt-8">
      <h3 className="text-title font-semibold text-fg">
        {CHECK_NAME[c.check]}
        {dated && <span className="font-normal text-fg-3"> · проверено {c.day}</span>}
      </h3>
      <p className="mt-1 max-w-[68ch] text-body text-fg-3">{SUMMARY_WHAT[c.check]}</p>
      <StageResult size="display" className="mt-5" failed={c.failed} checked={c.measured} unchecked={c.unmeasured} />
      <div className="mt-4 max-w-[72ch] space-y-1 text-read text-fg-2">
        {c.severity.map((line, i) =>
          line.kind === "count" ? (
            <p key={i}>
              {line.head} — <span className="whitespace-nowrap font-semibold text-fg">{line.share}</span>.
            </p>
          ) : (
            <p key={i}>{line.text}</p>
          ),
        )}
        {answers && (
          <p>
            {answers.head} — <span className="whitespace-nowrap font-semibold text-fg">{answers.share}</span>
            {answers.rest}
          </p>
        )}
        {c.compare && <p>{c.compare}</p>}
        {c.seriousCompare && <p className="whitespace-pre-line">{c.seriousCompare}</p>}
        {found && <p>{found}</p>}
      </div>
    </section>
  );
}

/** What could not be loaded, and «Повторить»; on screen only, the PDF waits for it. */
function Failed({ text, onRetry, className }: { text: string; onRetry: () => void; className?: string }) {
  return (
    <div className={cn("print:hidden", className)}>
      <p role="alert" className="text-read text-fg-2">
        {text}
      </p>
      <Button className="mt-3" icon={RotateCcw} onClick={onRetry}>
        Повторить
      </Button>
    </div>
  );
}

/**
 * «Главное» of one check: every problem with its tick; a ticked one with what it is, its answers and one reply. While
 * the problems load, their place; if they could not be loaded, that and «Повторить».
 */
function CheckProblems({
  c,
  loading,
  failed,
  onRetry,
  onToggle,
}: {
  c: SummaryCheck;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  onToggle: (id: string) => void;
}) {
  const any = c.problems.some((p) => p.chosen);
  return (
    <div className={cn("mt-8", !any && "print:hidden")}>
      {/* On paper a heading never stays at the foot of a sheet without its first problem. */}
      <h4 className="text-lead font-semibold text-fg print:break-after-avoid">{CHECK_NAME[c.check]}</h4>
      {failed ? (
        <Failed className="mt-2" text="Не удалось загрузить проблемы." onRetry={onRetry} />
      ) : loading ? (
        <Skeleton className="mt-3 h-40" />
      ) : !c.problems.length ? (
        <p className="mt-2 text-read text-fg-3">
          {c.measured ? "Автоматическая проверка ошибок не нашла." : "Ни один разговор не удалось проверить."}
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {c.problems.map((p) => (
            <ProblemItem key={p.id} p={p} onToggle={() => onToggle(p.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** A ticked problem in full; one not ticked as its name and count, on the screen only. */
function ProblemItem({ p, onToggle }: { p: SummaryProblem; onToggle: () => void }) {
  const id = `summary-${p.id}`;
  return (
    <li className={cn("flex items-start gap-3 py-5 print:break-inside-avoid", !p.chosen && "py-3 print:hidden")}>
      <input
        id={id}
        type="checkbox"
        checked={p.chosen}
        onChange={onToggle}
        className="mt-1.5 size-4 flex-shrink-0 accent-primary print:hidden"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <label
            htmlFor={id}
            className={cn(
              "min-w-0 cursor-pointer",
              p.chosen ? "text-lead font-semibold text-fg" : "text-read text-fg-2",
            )}
          >
            {p.title}
            {p.serious && <SeriousTag rule={p} className="relative -top-px ml-2 align-middle font-normal" />}
          </label>
          <span className="whitespace-nowrap text-read tabular-nums text-fg-2">
            <span className="font-semibold text-fg">{p.failed}</span> из {p.checked}{" "}
            <span className="text-fg-3">({pct(p.failed, p.checked)}%)</span>
          </span>
        </div>
        {p.chosen && (
          <>
            <p className="mt-1.5 max-w-[68ch] text-read text-fg-2">
              <span className="text-fg-3">Агент должен: </span>
              {p.duty}
            </p>
            <p className="mt-1 text-read text-fg-2">{problemAnswers(p)}</p>
            {p.example && <Reply e={p.example} />}
          </>
        )}
      </div>
    </li>
  );
}

/** One reply of the agent, as the customer saw it, with the words the check pointed at marked. */
function Reply({ e }: { e: SummaryExample }) {
  const parts = e.reply ? splitQuote(e.reply, e.quote) : null;
  return (
    <div className="mt-3 max-w-[72ch] space-y-1.5 rounded-block bg-inset px-4 py-3 text-read">
      {e.customer && (
        <p className="whitespace-pre-line text-fg-2">
          <span className="font-medium text-fg-3">Клиент: </span>
          {e.customer}
        </p>
      )}
      <p className="whitespace-pre-line text-fg">
        <span className="font-medium text-fg-3">Агент: </span>
        {parts ? (
          <>
            {parts[0]}
            <mark className="rounded-sm bg-mark px-0.5 text-fg">{parts[1]}</mark>
            {parts[2]}
          </>
        ) : (
          <mark className="rounded-sm bg-mark px-0.5 text-fg">«{e.quote}»</mark>
        )}
      </p>
      {e.refuted && <p className="text-small text-fg-3">Люди ответили, что здесь ошибки нет.</p>}
    </div>
  );
}
