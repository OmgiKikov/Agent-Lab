import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { conversationsLink, historyLink, type Check } from "../../app/links";
import { resultOf } from "../../lab/checks";
import {
  comparisonOf,
  compareSentence,
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
import { seriousFirst } from "../../lab/severity";
import { SeriousTag } from "../../product/Severity";

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
 * The line under a check's number: how its result stands to its previous check, which opens from the line. Nothing
 * when there is nothing to compare with. With `serious` — once the line of serious errors stands above — the same
 * comparison of the conversations with a serious error follows in the next line, in the same words.
 */
export function CompareLine({
  check,
  compare,
  short,
  serious,
  className,
}: {
  check: Check;
  compare: Compare | null;
  short?: boolean;
  /** The criteria of the current result marked serious, once there are any: the serious comparison follows. */
  serious?: number;
  className?: string;
}) {
  const sentence = compare && compareSentence(compare, { short });
  if (!compare || !sentence) return null;
  const grave = serious ? seriousCompareText(compare, serious) : null;
  return (
    <>
      <p className={cn("max-w-[72ch] text-read text-fg-2", className)}>
        {compare.previous ? (
          <Link to={historyLink(check, compare.previous.id)} className={link}>
            {sentence.head}
          </Link>
        ) : (
          sentence.head
        )}
        {sentence.rest}
      </p>
      {grave && <p className="max-w-[72ch] text-read text-fg-2">{grave}</p>}
    </>
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
 * What each problem had in the previous check, beside its count now: «было 6 из 52» or «раньше ошибок не было: 0 из
 * 52». A verdict only when the difference is beyond chance, and never for a re-evaluation of the same conversations.
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
 * the conversations of this result it was checked in. The criteria a person marked serious (`serious`, their keys)
 * come first and say «серьёзная», as the problems above.
 */
export function NoLongerFound({
  check,
  compare,
  serious,
}: {
  check: Check;
  compare: Compare | null;
  serious?: Set<string>;
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
                    {serious?.has(row.id) && <SeriousTag className="relative -top-px ml-2 align-middle" />}
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
