import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { conversationsLink, historyLink, type Check } from "../../app/links";
import { resultOf } from "../../lab/checks";
import {
  comparisonOf,
  compareParts,
  goneText,
  noLongerFound,
  seriousCompareText,
  useCompare,
  VERDICT_WORD,
  wasText,
  type CheckLine,
  type Compare,
  type CompareRow,
} from "../../lab/compare";
import { nameFromText } from "../../lab/criteria";
import { longDay } from "../../lab/format";
import { shareText } from "../../lab/history";
import { useLabState } from "../../lab/LabProvider";
import type { RuleEntry } from "../../lab/problems";
import { seriousFirst } from "../../lab/severity";
import { SeriousTag } from "../../product/Severity";
import { Step, STEP_ACTION } from "../../product/Checklist";

/**
 * «Было → стало» of the check on the screen: its current result against its previous saved check, or, without a
 * current result, the last saved check (`none`). Null until the service answers about this very result.
 */
export function useComparison(check: Check): Compare | null {
  const { state } = useLabState();
  const { data } = useCompare(check);
  return comparisonOf(data, resultOf(state, check));
}

const link = "font-medium text-run hover:underline";

/**
 * How the result stands to its previous check, under its number (product/Checklist): a fact to know, not a step to
 * do. Compared: «Прошлая проверка: 22 из 53 (42%) → сейчас 4 из 12 (33%)», when it was and what may be read into the
 * difference, and «Открыть» that check (its export in the tooltip). With `serious` — once some criteria are serious —
 * the same comparison of the conversations with a serious error follows. Nothing when there is nothing to compare
 * with, nor when the checks are not comparable: a row saying so would leave nothing to do, and the history of the
 * checks says why. When the service did not answer, the row says so, with «Повторить».
 */
export function CompareLine({
  check,
  compare,
  serious,
}: {
  check: Check;
  compare: Compare | null;
  /** The serious criteria of the current result, once there are any: the serious comparison follows. */
  serious?: number;
}) {
  const asked = useCompare(check);
  if (!compare && asked.isError)
    return (
      <Step
        state="info"
        title="Не удалось загрузить сравнение с прошлой проверкой"
        action={
          <button
            type="button"
            onClick={() => void asked.refetch()}
            disabled={asked.isFetching}
            className={STEP_ACTION}
          >
            Повторить
          </button>
        }
      />
    );
  const parts = compare && compareParts(compare);
  if (!compare || !parts) return null;
  const grave = serious ? seriousCompareText(compare, serious) : null;
  return (
    <Step
      state="info"
      title={
        <>
          Прошлая проверка: <span className="tabular-nums">{parts.value}</span>
        </>
      }
      text={[parts.note, grave].filter(Boolean).join("\n")}
      action={
        compare.previous && (
          <Link
            to={historyLink(check, compare.previous.id)}
            title={compare.previous.file ? `Выгрузка «${compare.previous.file}»` : undefined}
            className={STEP_ACTION}
          >
            Открыть
          </Link>
        )
      }
    />
  );
}

/** «Прошлая проверка: 20 из 53 (38%) · «Выгрузка чата сентябрь 2026.xlsx» · 3 октября» — no current result yet. */
export function PreviousCheck({ check, line, className }: { check: Check; line: CheckLine; className?: string }) {
  const { summary } = line;
  return (
    <p className={cn("break-words text-read text-fg-2", className)}>
      <Link to={historyLink(check, line.id)} className={link}>
        Прошлая проверка
      </Link>
      : {summary.measured ? shareText(summary) : "ни один разговор не удалось проверить"}
      {line.file ? ` · «${line.file}»` : ""} · {longDay(line.finishedAt)}
    </p>
  );
}

/** A criterion as the comparison names it: its own name, or one made from its wording (lab/criteria, nameFromText). */
const nameOf = (row: CompareRow) => (row.name && row.name !== row.text ? row.name : nameFromText(row.text));

/**
 * What each problem had in the previous check, beside its count now: «было 6 из 52», or «было 0 из 52» for a new one.
 * A verdict only when the difference is beyond chance, and never for a re-evaluation of the same conversations.
 */
export function wasOf(compare: Compare | null): ((id: string) => ReactNode) | undefined {
  if (!compare?.criteria) return undefined;
  const rows = new Map(compare.criteria.map((row) => [row.id, row]));
  const repeat = compare.kind === "same-data";
  return (id) => {
    const row = rows.get(id);
    if (!row) return null;
    return (
      <>
        {wasText(row)}
        {!repeat && row.verdict === "beyond-chance" && <span className="block">{VERDICT_WORD["beyond-chance"]}</span>}
      </>
    );
  };
}

/**
 * Below the problems: the criteria with errors in the previous check and none now, «было 3 из 56 → 0 из 12». The
 * denominator says what it rests on, and the service's verdict always stands beside it — «мало разговоров, чтобы
 * судить», beyond chance or within it — so that «0 из 12» is never read as a conclusion about the agent. Each opens
 * the conversations of this result it was checked in. The serious criteria (`serious`, by their keys) come first and
 * say «серьёзная», as the problems above.
 */
export function NoLongerFound({
  check,
  compare,
  serious,
}: {
  check: Check;
  compare: Compare | null;
  serious?: Map<string, Pick<RuleEntry, "severity">>;
}) {
  if (!compare || (compare.kind !== "new-data" && compare.kind !== "same-data")) return null;
  const grave = (row: CompareRow) => ({ serious: !!serious?.has(row.id) });
  const rows = noLongerFound(compare).sort((a, b) => seriousFirst(grave(a), grave(b)));
  if (!rows.length) return null;
  const repeat = compare.kind === "same-data";
  return (
    <section aria-labelledby={`gone-${check}`} className="mt-12">
      <h3 id={`gone-${check}`} className="text-lead font-semibold text-fg">
        {repeat ? "При повторной оценке ошибок не нашли" : "Ошибок в этой выгрузке не нашли"}
      </h3>
      <p className="mt-1 text-body text-fg-3">
        {repeat ? "В прошлой оценке тех же разговоров ошибки по ним были." : "В прошлой проверке ошибки по ним были."}
      </p>
      <ul className="mt-2 divide-y divide-line">
        {rows.map((row) => {
          const word = !repeat && row.verdict && row.verdict !== "same" ? VERDICT_WORD[row.verdict] : null;
          return (
            <li key={row.id}>
              <Link
                to={conversationsLink(check, { rule: row.id })}
                className="group -mx-3 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 rounded-block px-3 py-3 transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none sm:grid-cols-[minmax(0,1fr)_auto_16px]"
              >
                <span className="min-w-0">
                  <span className="block text-read text-fg">
                    {nameOf(row)}
                    {serious?.has(row.id) && (
                      <SeriousTag rule={serious.get(row.id)} className="relative -top-px ml-2 align-middle" />
                    )}
                  </span>
                  {word && <span className="mt-0.5 block text-small text-fg-3">{word}</span>}
                </span>
                <span className="max-w-[11rem] pt-0.5 text-right text-body tabular-nums text-fg-2 sm:max-w-none">
                  {goneText(row)}
                </span>
                <ChevronRight
                  aria-hidden
                  className="mt-1 hidden size-4 text-fg-4 transition-transform group-hover:translate-x-0.5 sm:block"
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
