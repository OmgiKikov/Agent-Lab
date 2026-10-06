import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { liveLink, type Check } from "../../app/links";
import { useLabState } from "../../lab/LabProvider";
import { replaysOf } from "../../lab/replays";
import { ChangeLine, replayMeta, useBasisWords } from "./ReplayNumbers";
import type { ReplaySummary } from "../../lab/types";

const STATUS: Record<ReplaySummary["status"], string | null> = {
  running: "идёт",
  done: null,
  failed: "не удалась",
  stopped: "остановлена",
};

function Row({ check, r }: { check: Check; r: ReplaySummary }) {
  const basis = useBasisWords(r);
  const { before, now, pairs } = r.summary;
  return (
    <li>
      <Link
        to={liveLink(check, { id: r.id })}
        className="flex w-full items-start gap-3 rounded-control px-1 py-4 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run"
      >
        <div className="min-w-0 flex-1">
          <p className="text-read text-fg-2">
            {pairs ? (
              <>
                в записях <span className="font-semibold tabular-nums">{before.failed}</span> из {before.measured} →
                сейчас{" "}
                <span className={now.failed ? "font-semibold tabular-nums text-bad" : "font-semibold tabular-nums"}>
                  {now.failed}
                </span>{" "}
                из {now.measured} с ошибкой агента
              </>
            ) : (
              "Ни один разговор не удалось сравнить с записью"
            )}
            {STATUS[r.status] && <span className="ml-2 text-small text-fg-3">{STATUS[r.status]}</span>}
          </p>
          <p className="mt-1 break-words text-small text-fg-3">
            {replayMeta(r)} · клиенты из итога: {basis}
          </p>
          <ChangeLine r={r} className="mt-1 text-small" />
        </div>
        <ArrowRight aria-hidden className="mt-1 size-4 shrink-0 text-fg-3" />
      </Link>
    </li>
  );
}

/** The checks of the live agent of a check, under its saved checks: each opens its pairs. */
export function LiveHistory({ check }: { check: Check }) {
  const { state } = useLabState();
  const list = replaysOf(state, check);
  if (!list.length) return null;
  return (
    <section aria-labelledby="live-history" className="mt-12">
      <h2 id="live-history" className="text-title font-semibold text-fg">
        Живой агент на тех же клиентах
      </h2>
      <p className="mt-1 max-w-[64ch] text-read text-fg-3">
        Каждая проверка сохраняется со своими разговорами: записью и разговором сейчас для каждого клиента.
      </p>
      <ul className="mt-4 divide-y divide-line">
        {list.map((r) => (
          <Row key={r.id} check={check} r={r} />
        ))}
      </ul>
    </section>
  );
}
