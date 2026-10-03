import { useEffect, useRef } from "react";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Criterion } from "../../lab/criteria";
import type { DialogRow } from "../../lab/dialogs";
import { personaName } from "../../lab/look";
import type { Persona } from "../../lab/types";
import { Menu } from "../../ui/Menu";
import { Search } from "../../ui/Search";
import { criteriaByRule, matchesRow, VERDICTS, type Verdict } from "./model";

/** A conversation's result as a sign and a word: colour never stands alone. */
export function VerdictWord({ status, className }: { status: DialogRow["status"]; className?: string }) {
  const [word, dot, text] =
    status === "FAIL"
      ? ["ошибка", "bg-bad", "text-bad"]
      : status === "PASS"
        ? ["без ошибок", "bg-ok", "text-ok"]
        : status === "RUNNING"
          ? ["идёт", "bg-run", "text-run"]
          : status
            ? ["не проверен", "border border-dashed border-fg-3", "text-fg-3"]
            : [null, "", ""];
  if (!word) return null;
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-small", text, className)}>
      <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />
      {word}
    </span>
  );
}

function Row({
  r,
  on,
  onOpen,
  numbers,
  personas,
}: {
  r: DialogRow;
  on: boolean;
  onOpen: () => void;
  numbers: number[];
  personas: Persona[];
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (on) ref.current?.scrollIntoView({ block: "nearest" });
  }, [on]);
  const who =
    r.source === "sim"
      ? [personaName(personas, r.persona), r.attempt && r.attempt > 1 ? `повтор ${r.attempt}` : ""]
          .filter(Boolean)
          .join(" · ")
      : "";
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      aria-current={on ? "true" : undefined}
      className={cn(
        "block w-full rounded-control px-3 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60",
        on ? "bg-selected" : "hover:bg-hover",
      )}
    >
      <span className="flex items-center gap-2">
        <VerdictWord status={r.status} />
        {r.disputed && <span className="text-small text-warn">· проверки разошлись</span>}
      </span>
      <span className="mt-1 line-clamp-2 text-body text-fg">{r.title}</span>
      <span className="mt-1 flex flex-wrap gap-x-1.5 text-small text-fg-3">
        {r.topic && <span className="truncate">{r.topic}</span>}
        {who && (
          <>
            <span aria-hidden>·</span>
            <span>{who}</span>
          </>
        )}
        {numbers.length > 0 && (
          <>
            <span aria-hidden>·</span>
            <span>
              ошибка по {numbers.length > 1 ? "критериям" : "критерию"}{" "}
              <span className="tabular-nums text-fg-2">{numbers.join(", ")}</span>
            </span>
          </>
        )}
      </span>
    </button>
  );
}

/** The conversations of one stage: which result, one criterion, a search; one row per conversation. */
export function Rows({
  empty,
  all,
  rows,
  verdict,
  onVerdict,
  rule,
  onClearRule,
  query,
  onQuery,
  selected,
  onOpen,
  criteria,
  personas,
  runMenu,
  className,
}: {
  empty: string;
  all: DialogRow[];
  rows: DialogRow[];
  verdict: Verdict;
  onVerdict: (v: Verdict) => void;
  rule: Criterion | null;
  onClearRule: () => void;
  query: string;
  onQuery: (q: string) => void;
  selected: string | null;
  onOpen: (key: string) => void;
  criteria: Criterion[];
  personas: Persona[];
  runMenu?: React.ReactNode;
  className?: string;
}) {
  const find = criteriaByRule(criteria);
  const numbers = (r: DialogRow) =>
    [
      ...new Set(
        r.rules
          .filter((x) => x.status === "FAIL")
          .flatMap((x) => {
            const c = find(r.source, x.ruleId);
            return c ? [c.n] : [];
          }),
      ),
    ].sort((a, b) => a - b);
  const count = (v: Verdict) => all.filter((r) => matchesRow(r, v, "", null)).length;
  const current = VERDICTS.find((v) => v.value === verdict)!;
  return (
    <div className={cn("flex min-h-0 flex-col border-line lg:border-r", className)}>
      <div className="space-y-3 px-4 pb-3 pt-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Menu
            trigger={
              <span className="inline-flex items-center gap-1.5 text-body font-semibold text-fg">
                {current.label}
                <span className="font-normal tabular-nums text-fg-3">{count(verdict)}</span>
                <ChevronDown aria-hidden className="size-4 text-fg-3" />
              </span>
            }
            items={VERDICTS.map((v) => ({
              key: v.value,
              label: v.label,
              sub: `${count(v.value)}`,
              on: v.value === verdict,
              run: () => onVerdict(v.value),
            }))}
          />
          {runMenu}
        </div>
        <Search value={query} onChange={onQuery} placeholder="Найти по словам клиента" />
        {rule && (
          <span className="flex items-center gap-2 rounded-full bg-hover py-1 pl-3 pr-1.5 text-small text-fg">
            <span className="min-w-0 flex-1 truncate">
              Ошибка по критерию {rule.n}: {rule.name}
            </span>
            <button
              type="button"
              onClick={onClearRule}
              aria-label="Снять отбор по критерию"
              className="grid size-6 place-items-center rounded-full text-fg-3 transition-colors hover:bg-selected hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2" role="list" aria-label="Разговоры">
        {rows.map((r) => (
          <Row
            key={r.key}
            r={r}
            on={r.key === selected}
            onOpen={() => onOpen(r.key)}
            numbers={numbers(r)}
            personas={personas}
          />
        ))}
        {!rows.length && (
          <p className="px-3 py-10 text-center text-small text-fg-3">
            {all.length ? "В этом отборе разговоров нет" : empty}
          </p>
        )}
      </div>
      {rows.length > 0 && (
        <div className="border-t border-line px-4 py-2 text-small text-fg-3">
          {rows.length} из {all.length}
        </div>
      )}
    </div>
  );
}
