import { useEffect, useRef, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Criterion } from "../../lab/criteria";
import { topicOf, type DialogRow } from "../../lab/dialogs";
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
            ? ["не удалось проверить", "border border-dashed border-fg-3", "text-fg-3"]
            : [null, "", ""];
  if (!word) return null;
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-small", text, className)}>
      <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />
      {word}
    </span>
  );
}

/**
 * One conversation in the list: its result, the client's first words, and the criteria it broke by their names, so
 * nobody has to remember what a criterion's number stands for.
 */
function Row({
  r,
  on,
  onOpen,
  broken,
  personas,
}: {
  r: DialogRow;
  on: boolean;
  onOpen: () => void;
  broken: string[];
  personas: Persona[];
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Into view inside the list only: scrollIntoView also moves the page when the list stands lower on it
    // (checks/RunPage), and a page whose overflow is hidden moves under its own head.
    const row = ref.current;
    const list = row?.closest<HTMLElement>("[data-list]");
    if (!on || !row || !list) return;
    const r = row.getBoundingClientRect();
    const b = list.getBoundingClientRect();
    if (r.top < b.top) list.scrollTop -= b.top - r.top;
    else if (r.bottom > b.bottom) list.scrollTop += r.bottom - b.bottom;
  }, [on]);
  const where = [
    topicOf(r),
    r.source === "sim" ? personaName(personas, r.persona) : "",
    r.attempt && r.attempt > 1 ? `повтор ${r.attempt}` : "",
  ].filter(Boolean);
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
        {r.disputed && <span className="text-small text-warn">· модели разошлись</span>}
      </span>
      <span className="mt-1 line-clamp-2 text-body text-fg">{r.title}</span>
      {where.length + broken.length > 0 && (
        <span className="mt-1 line-clamp-2 text-small text-fg-3">
          {where.join(" · ")}
          {where.length > 0 && broken.length > 0 && " · "}
          {broken.length > 0 && <span className="text-fg-2">{broken.join(", ")}</span>}
        </span>
      )}
    </button>
  );
}

/**
 * The conversations of one stage: which result, one criterion, a search; one row per conversation. `pending` stands
 * in the list's place while what it is made of loads or after it failed: no counts then, and no «нет разговоров».
 * `note` — one line under the list about what it lacks.
 */
export function Rows({
  empty,
  pending,
  note,
  all,
  rows,
  verdict,
  onVerdict,
  rule,
  serious,
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
  pending?: ReactNode;
  note?: string | null;
  all: DialogRow[];
  rows: DialogRow[];
  verdict: Verdict;
  onVerdict: (v: Verdict) => void;
  /**
   * The filter by one criterion in words, «Ошибка по критерию 3: …»; `gone` — the address names a criterion this list
   * does not have, and the words say so.
   */
  rule: { text: string; gone?: boolean } | null;
  /** The conversations with a serious error (model, seriousRows). */
  serious: Set<string>;
  onClearRule: () => void;
  query: string;
  onQuery: (q: string) => void;
  selected: string | null;
  onOpen: (key: string) => void;
  criteria: Criterion[];
  personas: Persona[];
  runMenu?: ReactNode;
  className?: string;
}) {
  const find = criteriaByRule(criteria);
  // The criteria a conversation broke, by their names in the order of their numbers.
  const broken = (r: DialogRow) =>
    [
      ...new Map(
        r.rules
          .filter((x) => x.status === "FAIL")
          .flatMap((x) => {
            const c = find(r.source, x.ruleId);
            return c ? [[c.n, c.name] as const] : [];
          }),
      ),
    ]
      .sort((a, b) => a[0] - b[0])
      .map(([, name]) => name);
  const count = (v: Verdict) => all.filter((r) => matchesRow(r, v, "", null, serious)).length;
  const current = VERDICTS.find((v) => v.value === verdict)!;
  // Offered once they can hold something, or when an address asks for them: «Нарушен важный критерий» once a criterion
  // is important, «Модели разошлись» once a second model checked some of these conversations (LAB_SECOND_MODEL).
  const offered: Partial<Record<Verdict, boolean>> = {
    serious: criteria.some((c) => c.r.serious),
    disputed: all.some((r) => !!r.second),
  };
  const verdicts = VERDICTS.filter((v) => offered[v.value] !== false || v.value === verdict);
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col border-line lg:border-r", className)}>
      <div className="space-y-3 px-4 pb-3 pt-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Menu
            trigger={
              <span className="inline-flex items-center gap-1.5 text-body font-semibold text-fg">
                {current.label}
                {!pending && <span className="font-normal tabular-nums text-fg-3">{count(verdict)}</span>}
                <ChevronDown aria-hidden className="size-4 text-fg-3" />
              </span>
            }
            items={verdicts.map((v) => ({
              key: v.value,
              label: v.label,
              sub: pending ? undefined : `${count(v.value)}`,
              on: v.value === verdict,
              run: () => onVerdict(v.value),
            }))}
          />
          {runMenu}
        </div>
        <Search value={query} onChange={onQuery} placeholder="Найти по словам клиента" />
        {rule && (
          <span
            className={cn(
              "flex items-center gap-2 py-1 pl-3 pr-1.5 text-small",
              rule.gone ? "rounded-control bg-inset text-fg-2" : "rounded-full bg-hover text-fg",
            )}
          >
            <span className={cn("min-w-0 flex-1", !rule.gone && "truncate")}>{rule.text}</span>
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
      <div data-list className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {pending ? (
          <div className="px-2">{pending}</div>
        ) : (
          <>
            {rows.length > 0 && (
              <ul aria-label="Разговоры">
                {rows.map((r) => (
                  <li key={r.key}>
                    <Row
                      r={r}
                      on={r.key === selected}
                      onOpen={() => onOpen(r.key)}
                      broken={broken(r)}
                      personas={personas}
                    />
                  </li>
                ))}
              </ul>
            )}
            {!rows.length && (
              <p className="px-3 py-10 text-center text-small text-fg-3">
                {all.length ? "В этом отборе разговоров нет." : empty}
              </p>
            )}
          </>
        )}
      </div>
      {!pending && (rows.length > 0 || note) && (
        <div className="border-t border-line px-4 py-2 text-small text-fg-3">
          {rows.length > 0 && (
            <p>
              {rows.length}
              {"\u00a0"}из{"\u00a0"}
              {all.length}
            </p>
          )}
          {note && <p className={cn(rows.length > 0 && "mt-1")}>{note}</p>}
        </div>
      )}
    </div>
  );
}
