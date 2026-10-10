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
import { cleanPct, resultText, useHistory, type Counts, type SavedCheck } from "../../lab/history";
import { useLabState } from "../../lab/LabProvider";
import type { RuleEntry } from "../../lab/problems";
import { inQuotes } from "../../lab/quote";
import { seriousFirst } from "../../lab/severity";
import { SeriousTag } from "../../product/Severity";
import { useOrigins } from "./origin";

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
 * «↑ было 42% · v1.0» (the version of the agent whose answers that check judged, else the day it finished), opening
 * that check, then what may be read into the difference. Red when the errors grew beyond chance, green when they fell;
 * grey when the difference may be chance, the conversations are few, or the same ones were judged again. The serious
 * comparison follows on a line of its own, with `whose` after it: whose decision the important criteria are, when not
 * the person's. Nothing when there is nothing to compare with; when the service did not answer, a quiet «Повторить».
 */
export function CompareDelta({
  check,
  compare,
  serious,
  whose,
  brief,
}: {
  check: Check;
  compare: Compare | null;
  serious?: number;
  whose?: ReactNode;
  /** In a card: the chip alone, what may be read into the difference in its tooltip. */
  brief?: boolean;
}) {
  const asked = useCompare(check);
  const origins = useOrigins(check);
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
        version={origins(compare.previous.id, null, compare.previous.file).version}
        before={overall.before}
        direction={overall.direction}
        verdict={overall.verdict}
        again={compare.kind === "same-data"}
        label={parts.value}
        title={[parts.value, brief && parts.note, grave].filter(Boolean).join("\n")}
        brief={brief}
      />
      {/* The serious errors beside the number in words, on a touch screen too: a tooltip alone is never read there. */}
      {grave && !brief && <SeriousShift text={grave} whose={whose} />}
    </>
  );
}

/**
 * The serious errors of both checks in words (lab/compare, seriousCompareText), its first line followed by whose
 * decision the important criteria are, when that is said.
 */
function SeriousShift({ text, whose }: { text: string; whose?: ReactNode }) {
  const [head, ...rest] = text.split("\n");
  return (
    <span className="basis-full">
      {whose ? (
        <>
          {head.replace(/\.$/, "")} · {whose}
        </>
      ) : (
        head
      )}
      {rest.map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    </span>
  );
}

/**
 * The previous check beside a number: «↑ было 58% · v1.0» — its share without an error found, as the number says the
 * current one (lab/history, cleanPct), the arrow up when that share grew, and the version of the agent whose answers it
 * judged, else the day it finished — opening it, and what may be read into the difference (lab/compare, VERDICT).
 * Coloured only beyond chance on other conversations: green when the errors fell, red when they grew; the same ones
 * judged again say so.
 */
export function Delta({
  to,
  at,
  version,
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
  /** The version of the agent whose answers the previous check judged, when it is known. */
  version?: string;
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
        aria-label={`Прошлая проверка, ${longDay(at)}${version ? `, версия агента ${version}` : ""}: ${label}`}
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
        было {cleanPct(before)}% · <span className="max-w-[12rem] truncate">{version || longDay(at)}</span>
      </Link>
      {note && !brief && <span>{note}</span>}
    </>
  );
}

/**
 * How a saved check stood to the one before it, beside its number (checks/RunPage, and «Итог» while a new dataset waits
 * for its first check): as the history's line of it says, nothing when the two are not compared.
 */
export function SavedDelta({ check, line }: { check: Check; line: SavedCheck }) {
  const history = useHistory(check);
  const origins = useOrigins(check);
  const comparison = history.data?.checks.find((c) => c.id === line.id)?.comparison ?? line.comparison;
  const previous = history.data?.checks.find((c) => c.id === comparison.previousId);
  const compared = comparison.kind === "new-data" || comparison.kind === "same-data";
  if (!compared || !previous?.summary.measured) return null;
  return (
    <Delta
      to={historyLink(check, previous.id)}
      at={previous.finishedAt}
      version={origins(previous.id, null, previous.file).version}
      before={previous.summary}
      direction={comparison.direction}
      verdict={comparison.verdict}
      again={comparison.kind === "same-data"}
      label={`${previous.summary.failed} из ${previous.summary.measured} → ${line.summary.failed} из ${line.summary.measured}`}
    />
  );
}

/**
 * «Прошлая проверка: 62% без найденных ошибок · 20 из 53 с ошибкой · датасет «Сентябрь» · 3 октября» — no current
 * result yet.
 */
export function PreviousCheck({ check, line, className }: { check: Check; line: CheckLine; className?: string }) {
  const { summary } = line;
  const { dataset } = useOrigins(check)(line.id, null, line.file);
  return (
    <p className={cn("break-words text-read text-fg-2", className)}>
      <Link to={historyLink(check, line.id)} className={link}>
        Прошлая проверка
      </Link>
      : {summary.measured ? resultText(summary) : "ни один разговор не удалось проверить"}
      {dataset ? ` · датасет ${inQuotes(dataset)}` : ""} · {longDay(line.finishedAt)}
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

/** How a criterion the current result no longer has stands: nobody marked it. */
const ORDINARY: Pick<RuleEntry, "serious" | "severity"> = { serious: false, severity: { by: null, proposed: null } };

/**
 * Below the problems: the criteria with errors in the previous check and none now, «было 3 из 56 → 0 из 12». The
 * denominator says what it rests on, and the service's verdict always stands beside it — «мало разговоров, чтобы
 * судить», beyond chance or within it — so that «0 из 12» is never read as a conclusion about the agent. Each opens
 * the conversations of this result it was checked in. With the criteria of the result (`rules`, by their keys) the
 * ones a person marked important come first, and the important ones say so, as the problems above.
 */
export function NoLongerFound({
  check,
  compare,
  rules,
}: {
  check: Check;
  compare: Compare | null;
  rules?: Map<string, RuleEntry>;
}) {
  if (!compare || (compare.kind !== "new-data" && compare.kind !== "same-data")) return null;
  const marks = (row: CompareRow) => rules?.get(row.id) ?? ORDINARY;
  const rows = noLongerFound(compare).sort((a, b) => seriousFirst(marks(a), marks(b)));
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
                    <SeriousTag rule={marks(row)} className="relative -top-px ml-2 align-middle" />
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
