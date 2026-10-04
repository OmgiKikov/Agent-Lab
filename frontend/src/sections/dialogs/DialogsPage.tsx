import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { side, type Stage } from "../../app/links";
import { useWide } from "../../app/useWide";
import { useCriteria } from "../../lab/criteria";
import { logKey, logRows, simKey, simRows } from "../../lab/dialogs";
import { longDay } from "../../lab/format";
import { runTitle, useRun } from "../../lab/runs";
import { useKeys } from "../../app/keys";
import { useLabState } from "../../lab/LabProvider";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Menu } from "../../ui/Menu";
import { UploadButton } from "../../product/UploadLogs";
import { CheckHeader } from "../checks/CheckHeader";
import { SimHeader, useSimRuns } from "../simulations/stage";
import { Dialog } from "./Dialog";
import { frozenNames, matchesRow, seriousRows, toVerdict, type Verdict } from "./model";
import { Rows } from "./Rows";

/**
 * «Разговоры» of a stage: every conversation of the export as a check judged it, or every conversation one run played;
 * one in full with the quotes the checks cited, every criterion's result and the trace. Where a number of another page
 * leads, filtered by its criterion (?rule=) or its result (?v=; `serious` — with an error by a criterion marked serious).
 */
export function DialogsPage({ stage }: { stage: Stage }) {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const wide = useWide();
  const { finished, run: simRun } = useSimRuns(state, stage === "sim" ? params.get("run") : null);
  const runId = stage === "sim" ? (simRun?.id ?? null) : null;
  const { data: problems, list: criteria } = useCriteria(stage === "sim" ? (simRun?.check ?? null) : stage, runId);
  const run = useRun(runId, state);
  const [query, setQuery] = useState("");
  const verdict = toVerdict(params.get("v"));
  const ruleId = params.get("rule");
  const set = (edit: (n: URLSearchParams) => void, replace = true) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        edit(n);
        return n;
      },
      { replace },
    );

  const all = useMemo(
    () => (stage === "sim" ? simRows(run.data) : state ? logRows(state, stage) : []),
    [stage, state, run.data],
  );
  const named = useMemo(() => (stage === "sim" ? frozenNames(criteria, all) : undefined), [stage, criteria, all]);
  const rule = ruleId ? problems?.rules.find((r) => r.id === ruleId) : undefined;
  const only = useMemo(
    () =>
      rule
        ? new Set(
            rule[side(stage)].examples
              .filter((e) => e.status === "FAIL")
              .map((e) => (stage === "sim" ? simKey(e.runId ?? "", e.index ?? 0) : logKey(e.dialogueId ?? ""))),
          )
        : null,
    [rule, stage],
  );
  const serious = useMemo(() => seriousRows(all, criteria), [all, criteria]);
  const rows = useMemo(
    () => all.filter((r) => matchesRow(r, verdict, query, only, serious)),
    [all, verdict, query, only, serious],
  );
  const key = params.get("d") ?? (wide ? (rows[0]?.key ?? null) : null);
  const selected = key ? all.find((r) => r.key === key) : undefined;
  const open = (k: string | null) =>
    set((n) => {
      if (k) n.set("d", k);
      else n.delete("d");
      n.delete("dt");
    }, wide);
  const step = (d: 1 | -1) => {
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.key === key);
    open(rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? -1 : i) + d))].key);
  };
  useKeys({ KeyJ: () => step(1), KeyK: () => step(-1) });

  const header =
    stage === "sim" ? (
      <SimHeader runId={runId} actions={false} />
    ) : (
      <CheckHeader check={stage} actions={<UploadButton variant="outline" check={stage} />} />
    );
  if (offline && !state)
    return (
      <div className="flex h-full flex-col">
        {header}
        <ServiceDown />
      </div>
    );
  if (!state)
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="p-5">
          <Skeleton className="h-[480px]" />
        </div>
      </div>
    );

  const r = run.data;
  const runMenu =
    stage === "sim" && r ? (
      finished.length > 1 ? (
        <Menu
          trigger={
            <span className="inline-flex items-center gap-1 text-small text-fg-3 hover:text-fg">
              прогон {longDay(r.startedAt)}
              <ChevronDown aria-hidden className="size-3.5" />
            </span>
          }
          items={finished.map((x) => ({
            key: x.id,
            label: `${longDay(x.startedAt)}${x.label ? ` · «${x.label}»` : ""}`,
            sub: [runTitle(x), x.metric?.measured ? `ошибка в ${x.metric.failed} из ${x.metric.measured}` : ""]
              .filter(Boolean)
              .join(" · "),
            on: x.id === runId,
            run: () =>
              set((n) => {
                n.set("run", x.id);
                n.delete("d");
                n.delete("rule");
              }),
          }))}
        />
      ) : (
        <span className="text-small text-fg-3">прогон {longDay(r.startedAt)}</span>
      )
    ) : null;
  const showDetail = !!selected && (wide || !!params.get("d"));
  const empty =
    stage === "sim"
      ? "В этом прогоне нет разговоров."
      : !state.logs.total
        ? "Диалоги ещё не загружены: кнопка «Загрузить диалоги» справа вверху."
        : "Разговоры появятся здесь, когда проверка их оценит.";
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="grid min-h-0 flex-1 lg:grid-cols-[400px_minmax(0,1fr)]">
        <Rows
          className={showDetail && !wide ? "hidden" : undefined}
          empty={empty}
          all={all}
          rows={rows}
          verdict={verdict}
          onVerdict={(v: Verdict) =>
            set((n) => {
              if (v === "all") n.delete("v");
              else n.set("v", v);
              n.delete("d");
            })
          }
          rule={rule ? (criteria.find((c) => c.r.id === rule.id) ?? null) : null}
          serious={serious}
          onClearRule={() => set((n) => n.delete("rule"))}
          query={query}
          onQuery={setQuery}
          selected={key}
          onOpen={(k) => open(k)}
          criteria={criteria}
          personas={state.personas}
          runMenu={runMenu}
        />
        {showDetail && selected ? (
          <Dialog
            key={selected.key}
            row={selected}
            criteria={criteria}
            named={named}
            onBack={wide ? undefined : () => open(null)}
          />
        ) : (
          wide && (
            <EmptyState drop title={all.length ? "Выберите разговор" : "Разговоров нет"} className="justify-center">
              {all.length ? "Слева все разговоры. J и K листают." : empty}
            </EmptyState>
          )
        )}
      </div>
    </div>
  );
}
