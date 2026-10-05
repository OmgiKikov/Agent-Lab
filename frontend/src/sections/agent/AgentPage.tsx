import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Database, FileText, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { criterionLink } from "../../app/links";
import { api } from "../../lab/api";
import { useCriteria } from "../../lab/criteria";
import { count, day, plural, thousands } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { codeSources } from "../../lab/tone";
import { Button } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { useToast } from "../../ui/toast";
import { nameOf } from "../criteria/model";
import { ConnectionForm } from "./Connection";

/** The characters of prompts the criteria planner takes (backend/lab/agents/sources.py, MAX_TOTAL). */
const BUDGET = "60\u00a0000";

/**
 * «Агент»: who is checked and what the product knows of it — how to reach it, and what was read from its code: when
 * and from which folder the last read that succeeded took it (the service's `sourcesRead`), and the prompts it found
 * that did not fit the planner's budget, so no criterion comes from them.
 */
export function AgentPage() {
  const { state, offline, refresh } = useLabState();
  const toast = useToast();
  const criteria = useCriteria("code");
  const { list } = criteria;
  const [reading, setReading] = useState(false);
  const busy = !!state?.job.running || reading;
  const readCode = () => {
    setReading(true);
    api("/api/sources", {})
      .then(() => refresh())
      .catch(toast.error)
      .finally(() => setReading(false));
  };
  const header = (
    <Header
      title="Агент"
      actions={
        <Button
          variant="primary"
          icon={RotateCcw}
          loading={reading}
          disabled={busy || !state?.settings.repo}
          onClick={readCode}
          title={
            state?.settings.repo ? `Папка с кодом: ${state.settings.repo}` : "Сначала укажите папку с кодом агента"
          }
        >
          {codeSources(state).length ? "Прочитать код заново" : "Прочитать код"}
        </Button>
      }
      below={<SectionJob kinds={["sources"]} />}
    />
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
          <Skeleton className="h-[420px]" />
        </div>
      </div>
    );
  const sources = codeSources(state).sort((a, b) => b.rules - a.rules || b.chars - a.chars);
  const read = state.sourcesRead;
  const over = read?.overBudget ?? [];
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid max-w-6xl gap-x-12 gap-y-10 px-4 pb-16 pt-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:px-10 lg:pt-8">
          <div>
            <h2 className="text-title font-semibold text-fg">Подключение</h2>
            <p className="mb-5 mt-1 text-small text-fg-3">
              Где работает агент и как с ним связаться. Это нужно только для симуляций.
            </p>
            <ConnectionForm
              key={`${state.settings.prodUrl}|${state.settings.repo}|${state.settings.epk.join(" ")}`}
              state={state}
            />
          </div>
          <section aria-label="Код агента">
            <h2 className="text-title font-semibold text-fg">Код агента</h2>
            <p className={cn("mt-1 text-small text-fg-3", sources.length && over.length ? "mb-3" : "mb-5")}>
              {sources.length ? (
                <>
                  {plural(sources.length, "Прочитан", "Прочитано", "Прочитано")}{" "}
                  {count(sources.length, "источник", "источника", "источников")}
                  {read ? ` ${day(read.readAt)}` : ""}
                  {read?.repo ? (
                    <>
                      {" "}
                      из <span className="font-mono">{read.repo}</span>
                    </>
                  ) : null}
                  . {plural(sources.length, "Из него", "Из них", "Из них")} дословно берутся критерии точности.
                </>
              ) : (
                "Код ещё не прочитан. Выберите «Запуск из кода», укажите папку с кодом и прочитайте код."
              )}
            </p>
            {sources.length > 0 && over.length > 0 && (
              <div className="mb-5 text-small">
                <p className="text-warn">
                  {count(over.length, "инструкция", "инструкции", "инструкций")}{" "}
                  {plural(over.length, "не вошла", "не вошли", "не вошли")} в лимит {BUDGET}
                  {"\u00a0"}знаков. Критерии из {plural(over.length, "неё", "них", "них")} не собраны.
                </p>
                <ul className="mt-1 space-y-0.5">
                  {over.map((origin) => (
                    <li key={origin} className="break-all font-mono text-meta text-fg-3">
                      {origin}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {sources.length > 0 && (
              <>
                <Label>Инструкции и инструменты</Label>
                {/* How many criteria each file gave comes from the record of the check: said only once it came. */}
                {criteria.error && (
                  <LoadFailed title="Не удалось загрузить критерии" error={criteria.error} onRetry={criteria.retry} />
                )}
                <ul className="mt-2 divide-y divide-line">
                  {sources.map((s) => {
                    const mine = list.filter((c) => c.r.rule.sourceId === s.id);
                    const broken = mine.filter((c) => c.r.log.failed > 0).length;
                    const { file, dir } = nameOf(s);
                    const Icon = s.kind === "tools" ? Database : FileText;
                    return (
                      <li key={s.id}>
                        <Link
                          to={criterionLink("code", null, { f: s.id, view: "code" })}
                          className="-mx-3 grid grid-cols-[20px_minmax(0,1fr)_auto_16px] items-center gap-3 rounded-control px-3 py-3 transition-colors hover:bg-hover"
                        >
                          <Icon aria-hidden className="size-4 text-fg-3" />
                          <span className="min-w-0">
                            <span className="block truncate font-mono text-small text-fg">{file}</span>
                            <span className="block truncate font-mono text-meta text-fg-3">
                              {dir} · {thousands(s.chars)}
                            </span>
                          </span>
                          <div className="text-right text-small text-fg-3">
                            {criteria.loading ? (
                              <Skeleton className="ml-auto h-4 w-20" />
                            ) : criteria.error ? null : mine.length ? (
                              <>
                                {mine.length} {plural(mine.length, "критерий", "критерия", "критериев")}
                                {broken ? (
                                  <>
                                    , <span className="text-bad">{broken} с ошибкой</span>
                                  </>
                                ) : (
                                  ""
                                )}
                              </>
                            ) : (
                              "критериев нет"
                            )}
                          </div>
                          <ArrowRight aria-hidden className="size-3.5 text-fg-4" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
