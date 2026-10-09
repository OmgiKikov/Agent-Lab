import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, Database, FileText, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { AGENT } from "../../app/agent";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { criterionLink, launchLink } from "../../app/links";
import { api } from "../../lab/api";
import { useCriteria } from "../../lab/criteria";
import { count, day, plural, thousands } from "../../lab/format";
import { useAgent } from "../../lab/agents";
import { useLabState } from "../../lab/LabProvider";
import { codeSources } from "../../lab/tone";
import { Button, buttonClass } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { useToast } from "../../ui/toast";
import { nameOf } from "../criteria/model";
import type { AgentContext } from "./ContextFields";
import { ConnectionForm } from "./Connection";
import { ACCURACY } from "../../app/product";

/** The characters of prompts the criteria planner takes (backend/lab/agents/sources.py, MAX_TOTAL). */
const BUDGET = "60\u00a0000";

/**
 * «Агент»: who is checked and what the product knows of it — how to reach it, and what was read from its code: when
 * and from which folder the last read that succeeded took it (the service's `sourcesRead`), and the prompts it found
 * that did not fit the planner's budget, so no criterion comes from them.
 */
export function AgentPage() {
  const [params] = useSearchParams();
  const back = params.get("return");
  const { state, offline, refresh } = useLabState();
  const toast = useToast();
  const criteria = useCriteria("code");
  const agent = useAgent();
  const context = useQuery({
    queryKey: ["agent-context", AGENT],
    queryFn: () => api<AgentContext>("/api/agent/context"),
  });
  const codeAt = context.data?.repositoryUrl || state?.settings.repo;
  const { list } = criteria;
  const [reading, setReading] = useState(false);
  // The instructions left out of the planner's budget: a few in view, the rest on a press (99 of them filled the page).
  const [allOver, setAllOver] = useState(false);
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
        <>
          {(back === "tone" || back === "code") && (
            <Link to={launchLink(back)} className={buttonClass()}>
              К новой проверке
            </Link>
          )}
          {/* The agent's code gives the criteria of Точность, hidden in the first release (app/product). */}
          {ACCURACY && (
            <Button
              variant="primary"
              icon={RotateCcw}
              loading={reading}
              disabled={busy || !codeAt}
              onClick={readCode}
              title={codeAt ? `Код агента: ${codeAt}` : "Сначала укажите, где код агента"}
            >
              {codeSources(state).length ? "Прочитать код заново" : "Прочитать код"}
            </Button>
          )}
        </>
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
        <div
          className={cn(
            "grid gap-x-12 gap-y-10 px-4 pb-16 pt-6 lg:px-10 lg:pt-8",
            ACCURACY ? "max-w-6xl lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]" : "max-w-2xl",
          )}
        >
          <div>
            <h2 className="text-title font-semibold text-fg">Карточка агента</h2>
            <p className="mb-5 mt-1 text-small text-fg-3">
              {ACCURACY
                ? "Кто этот агент, как с ним связаться, где его код и что о нём должен знать судья. Для проверки записанных разговоров нужно только имя."
                : "Кто этот агент и как с ним связаться. Для проверки записанных разговоров нужно только имя, подключение — для вопросов живому агенту."}
            </p>
            {context.isError ? (
              <LoadFailed
                title="Не удалось загрузить карточку"
                error={context.error}
                onRetry={() => context.refetch()}
              />
            ) : context.data && agent ? (
              <ConnectionForm
                // One form per agent: saving never starts it afresh, so a refused save keeps what the person typed.
                key={agent.id}
                state={state}
                agent={agent}
                context={context.data}
                onSaved={() => context.refetch()}
              />
            ) : (
              <Skeleton className="h-[420px]" />
            )}
          </div>
          {ACCURACY && (
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
                  "Код ещё не прочитан. Укажите в карточке, где код агента — папку или ссылку на репозиторий, — сохраните и нажмите «Прочитать код»."
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
                    {(allOver ? over : over.slice(0, 5)).map((origin) => (
                      <li key={origin} className="break-all font-mono text-meta text-fg-3">
                        {origin}
                      </li>
                    ))}
                  </ul>
                  {over.length > 5 && (
                    <button
                      type="button"
                      onClick={() => setAllOver((v) => !v)}
                      className="mt-1 rounded-sm font-medium text-run hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
                    >
                      {allOver ? "Свернуть" : `Показать все ${over.length}`}
                    </button>
                  )}
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
          )}
        </div>
      </div>
    </div>
  );
}
