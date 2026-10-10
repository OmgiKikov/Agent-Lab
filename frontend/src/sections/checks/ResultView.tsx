import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { conversationsLink, type Check } from "../../app/links";
import { seriousCompareText, type Compare } from "../../lab/compare";
import type { Criterion } from "../../lab/criteria";
import { pct } from "../../lab/format";
import { FEW } from "../../lab/history";
import { summarySentence } from "../../lab/problemReport";
import type { Problems } from "../../lab/problems";
import { seriousOf, type Serious } from "../../lab/severity";
import { ProposedImportant } from "../../product/Severity";
import { StageResult } from "../../product/StageResult";
import { ProblemList } from "../problems/ProblemList";
import { CompareDelta, NoLongerFound, wasOf } from "./Compare";
import type { Origin } from "./origin";

type Part = "bad" | "ok" | "none";

/** The parts of a check's number as the conversations' filter names them (`?v=`). */
export const PART = { bad: "fail", ok: "pass", none: "none" } as const;

/** A record of a check's problems with its conversations measured: what «Итог» rests on. */
export type Measured = Problems & { log: NonNullable<Problems["log"]> };

/**
 * «С нарушением важных критериев — 5 из 100 (5%)» under the number, opening those conversations: counted apart, never
 * added to it, with «важные предложила модель» while the count rests on the model's proposals. Once the check is
 * compared with its previous one, the comparison says it beside the chip instead, «было → сейчас» (checks/Compare,
 * CompareDelta).
 */
function Important({ check, serious, whose }: { check: Check; serious: Serious; whose: ReactNode }) {
  return (
    <p className="mt-1 text-read text-fg-3">
      С нарушением важных критериев —{" "}
      <Link
        to={conversationsLink(check, { v: "serious" })}
        title="Разговоры, где нарушен важный критерий"
        className="whitespace-nowrap rounded-sm font-medium text-fg-2 underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-fg-3"
      >
        {`${serious.failed}\u00a0из\u00a0${serious.measured}`}
      </Link>{" "}
      ({pct(serious.failed, serious.measured)}%){whose && <> · {whose}</>}
    </p>
  );
}

/**
 * «Итог» of a check as a measurement, the same page whichever record it rests on: the current result
 * (checks/ResultPage), or, while a new dataset waits for its first check, the check before it (checks/Start). What
 * comes first (`lead`); which dataset and which version of the agent were measured; the share without an error found
 * with the conversations where an important criterion was broken and how it stands to the check before it — «было →
 * стало» of the current result (`compare`), or the history's line of a saved one (`delta`); then the problems it is
 * made of — the ones a person marked important first, then the most frequent — each beside what it had in the
 * previous check, and the criteria whose errors are no longer found. `part` and `all` are where the parts of the
 * number open, `problem` where a problem opens when not on its own page.
 */
export function ResultView({
  check,
  data,
  list,
  origin,
  lead,
  compare,
  delta,
  part,
  all,
  problem,
}: {
  check: Check;
  data: Measured;
  list: Criterion[];
  origin: Origin;
  lead?: ReactNode;
  /** «Было → стало» of the current result (checks/Compare, useComparison); null while it is not here. */
  compare: Compare | null;
  /** How a saved check stood to the one before it: it stands in for the current result's comparison. */
  delta?: ReactNode;
  part: (part: Part) => string;
  all: string;
  problem?: (id: string) => string;
}) {
  const { log } = data;
  const serious = seriousOf(data);
  const whose = serious?.proposed ? <ProposedImportant check={check} serious={serious} /> : null;
  // Compared with the previous check, the important count stands in the comparison beside the chip.
  const compared = !!serious && !!compare && !!seriousCompareText(compare, serious.marked);
  // What was measured: «Датасет «Ноябрь» · версия агента v1.1».
  const measured = (
    origin.dataset
      ? [`Датасет «${origin.dataset}»`, origin.version && `версия агента ${origin.version}`]
      : [origin.version && `Версия агента ${origin.version}`]
  )
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="max-w-[1040px] px-4 pb-24 pt-8 lg:px-10 lg:pt-12">
      {lead}
      {measured && <p className="mb-4 break-words text-read text-fg-3">{measured}</p>}
      <StageResult
        failed={log.withViolations}
        checked={log.assessed}
        unchecked={log.unassessed}
        link={part}
        all={all}
        important={serious && !compared && <Important check={check} serious={serious} whose={whose} />}
        delta={delta ?? <CompareDelta check={check} compare={compare} serious={serious?.marked} whose={whose} />}
      />
      {log.assessed > 0 && log.assessed < FEW && (
        <p className="mt-3 text-small text-fg-3">{`Проверено меньше ${FEW}\u00a0разговоров, поэтому вывод предварительный.`}</p>
      )}
      <section aria-label="Проблемы" className="mt-16">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line pb-3">
          <h2 className="text-title font-semibold text-fg">Проблемы</h2>
          <p className="text-read text-fg-3">{summarySentence(data, "log")}</p>
        </div>
        <div className="mt-2">
          <ProblemList list={list} stage={check} was={wasOf(compare)} to={problem} />
        </div>
        <NoLongerFound check={check} compare={compare} rules={new Map(data.rules.map((r) => [r.id, r]))} />
      </section>
    </div>
  );
}
