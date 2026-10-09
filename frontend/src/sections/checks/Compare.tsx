import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, ChevronRight, Equal } from "lucide-react";
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
  VERDICT,
  VERDICT_WORD,
  wasText,
  type CheckLine,
  type Compare,
  type CompareRow,
  type Direction,
  type Verdict,
} from "../../lab/compare";
import { nameFromText } from "../../lab/criteria";
import { longDay } from "../../lab/format";
import { cleanPct, resultText, type Counts } from "../../lab/history";
import { useLabState } from "../../lab/LabProvider";
import type { RuleEntry } from "../../lab/problems";
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
 * «Стало лучше?» beside the number itself, as Braintrust sets a run beside its baseline: an arrow and the previous share,
 * «↑ было 42% · 3 октября», opening that check, then what may be read into the difference. Red when the errors grew
 * beyond chance, green when they fell; grey when the difference may be chance, the conversations are few, or the same
 * ones were judged again. The serious comparison follows on a line of its own. Nothing when there is nothing to compare with; when
 * the service did not answer, a quiet «Повторить».
 */
export function CompareDelta({
  check,
  compare,
  serious,
  brief,
}: {
  check: Check;
  compare: Compare | null;
  serious?: number;
  /** In a card: the chip alone, what may be read into the difference in its tooltip. */
  brief?: boolean;
}) {
  const asked = useCompare(check);
  if (!compare && asked.isError)
    return (
      <button
        type="button"
        onClick={() => void asked.refetch()}
        disabled={asked.isFetching}
        className="rounded-sm text-small text-fg-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
      >
        Сравнение с прошлой проверкой не загрузилось · Повторить
      </button>
    );
  const parts = compare && compareParts(compare);
  const overall = compare?.overall;
  if (!compare?.previous || !parts || !overall?.before.measured) return null;
  const grave = serious ? seriousCompareText(compare, serious) : null;
  return (
    <>
      <Delta
        to={historyLink(check, compare.previous.id)}
        at={compare.previous.finishedAt}
        before={overall.before}
        direction={overall.direction}
        verdict={overall.verdict}
        again={compare.kind === "same-data"}
        label={parts.value}
        title={[parts.value, brief && parts.note, grave].filter(Boolean).join("\n")}
        brief={brief}
      />
      {/* The serious errors beside the number in words, on a touch screen too: a tooltip alone is never read there. */}
      {grave && !brief && <span className="basis-full whitespace-pre-line">{grave}</span>}
    </>
  );
}

/**
 * The previous check beside a number: «↑ было 58% · 3 октября» — its share without an error found, as the number says
 * the current one (lab/history, cleanPct), the arrow up when that share grew — opening it, and what may be read into
 * the difference (lab/compare, VERDICT). Coloured only beyond chance on other conversations: green when the errors
 * fell, red when they grew; the same ones judged again say so.
 */
export function Delta({
  to,
  at,
  before,
  direction,
  verdict,
  again,
  label,
  title,
  brief,
}: {
  to: string;
  /** When the previous check finished. */
  at: string;
  before: Counts;
  direction: Direction | null | undefined;
  verdict: Verdict | null | undefined;
  /** The same conversations judged again: the difference is the evaluation's. */
  again: boolean;
  /** Both sides in words, for a screen reader: «22 из 53 (42%) → сейчас 4 из 12 (33%)». */
  label: string;
  title?: string;
  /** The chip alone: what may be read into the difference stays in the tooltip. */
  brief?: boolean;
}) {
  const telling = !again && verdict === "beyond-chance";
  // `direction` is the errors': more of them is less of the conversations without one.
  const Icon = direction === "more" ? ArrowDown : direction === "fewer" ? ArrowUp : Equal;
  const note = again ? "Повторная оценка тех же разговоров." : verdict && verdict !== "same" ? VERDICT[verdict] : "";
  return (
    <>
      <Link
        to={to}
        aria-label={`Прошлая проверка, ${longDay(at)}: ${label}`}
        title={title}
        className={cn(
          "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-small font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
          telling && direction === "more"
            ? "bg-bad/10 text-bad hover:bg-bad/15"
            : telling && direction === "fewer"
              ? "bg-ok/10 text-ok hover:bg-ok/15"
              : "bg-inset text-fg-2 hover:bg-hover",
        )}
      >
        <Icon aria-hidden className="size-3.5" />
        было {cleanPct(before)}% · {longDay(at)}
      </Link>
      {note && !brief && <span>{note}</span>}
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
      : {summary.measured ? resultText(summary) : "ни один разговор не удалось проверить"}
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
 * say «важный», as the problems above.
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
        {repeat ? "При повторной оценке ошибок не нашли" : "Ошибок в этом датасете не нашли"}
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
