import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { CHANGE_WORD, changeOf, recordedTurns } from "../../lab/replays";
import type { ReplayItem, Rule, Turn } from "../../lab/types";
import { Conversation, type Mark } from "../../product/Conversation";
import { MarkNo } from "../../product/MarkNo";
import { VerdictWord } from "../dialogs/Rows";

/** Each criterion of the check by its id: its number and name, as the check numbers them. */
export type Numbered = Map<string, { n: number; name: string }>;

/** How a change reads: better in green, worse in red, the rest quiet. */
export const CHANGE_TONE: Record<string, string> = {
  fixed: "text-ok",
  broken: "text-bad",
  failing: "text-fg-2",
  passing: "text-fg-3",
  unmeasured: "text-fg-3",
  running: "text-run",
};

/**
 * One side of a pair: the conversation as it went, the agent's words the judge cited marked with their criterion's
 * number, and under it the criteria it broke, each with the judge's reason.
 */
function Side({
  title,
  status,
  rules,
  turns,
  numbered,
  note,
}: {
  title: string;
  status: ReplayItem["status"];
  rules: Rule[];
  turns: Turn[];
  numbered: Numbered;
  note?: string | null;
}) {
  const [lit, setLit] = useState<number | null>(null);
  const failed = rules.filter((r) => r.status === "FAIL");
  const marks: Mark[] = failed.flatMap((r) => {
    const c = numbered.get(r.ruleId);
    return c && r.agentQuote ? [{ quote: r.agentQuote, n: c.n }] : [];
  });
  return (
    <section aria-label={title} className="min-w-0">
      <div className="flex items-center gap-3">
        <h3 className="text-lead font-semibold text-fg">{title}</h3>
        <VerdictWord status={status} />
      </div>
      {note && <p className="mt-1 text-small text-fg-3">{note}</p>}
      <div className="mt-3 rounded-sheet bg-inset px-4 pb-5 pt-4">
        {turns.length ? (
          <Conversation turns={turns} marks={marks} lit={lit} onLit={(on, n) => setLit(on && n ? n : null)} />
        ) : (
          <p className="text-body text-fg-3">Разговор ещё не начался.</p>
        )}
      </div>
      {failed.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          {failed.map((r) => {
            const c = numbered.get(r.ruleId);
            return (
              <li
                key={r.ruleId}
                onMouseEnter={() => c && setLit(c.n)}
                onMouseLeave={() => setLit(null)}
                className={cn("flex gap-2 py-3", c && lit === c.n && "bg-hover")}
              >
                {c ? <MarkNo n={c.n} on={lit === c.n} className="mt-0.5" /> : <span className="w-4" />}
                <span className="min-w-0">
                  <span className="block text-body font-medium text-fg">{c?.name ?? r.title ?? r.ruleId}</span>
                  {r.reason && <span className="mt-0.5 block text-body text-fg-2">{r.reason}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * One customer met again: the recorded conversation and the one played now, side by side on a wide screen, one under
 * the other on a phone, each with the criteria it broke. The same first message starts both.
 */
export function Pair({ item, numbered, onBack }: { item: ReplayItem; numbered: Numbered; onBack?: () => void }) {
  const change = changeOf(item);
  const now =
    item.status === "RUNNING"
      ? item.stage || "играется"
      : item.status === "UNMEASURED" && item.error
        ? item.error
        : null;
  return (
    <article className="min-h-0 overflow-auto" aria-label={item.opening}>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="sticky top-0 z-10 flex h-11 w-full items-center gap-1.5 border-b border-line bg-canvas px-3 text-body text-fg-2 lg:hidden"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Все клиенты
        </button>
      )}
      <div className="px-4 pb-16 pt-6 lg:px-8 lg:pt-8">
        <p className={cn("text-small font-medium", CHANGE_TONE[change])}>{CHANGE_WORD[change]}</p>
        <h2 className="mt-1 text-balance text-title font-semibold text-fg">«{item.opening}»</h2>
        <p className="mt-1 text-small text-fg-3">
          Первая реплика у обоих разговоров одна и та же. Дальше в разговоре «сейчас» клиента играет модель.
        </p>
        <div className="mt-6 grid gap-8 xl:grid-cols-2">
          <Side
            title="В записи"
            status={item.before.status}
            rules={item.before.rules}
            turns={recordedTurns(item)}
            numbered={numbered}
          />
          <Side
            title="Сейчас"
            status={item.status}
            rules={item.rules}
            turns={item.conversation}
            numbered={numbered}
            note={now}
          />
        </div>
      </div>
    </article>
  );
}
