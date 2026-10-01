import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Database, FileText, RotateCcw } from "lucide-react";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { SECTIONS } from "../../app/links";
import { api } from "../../lab/api";
import { useCriteria } from "../../lab/criteria";
import { day, plural, thousands } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { useToast } from "../../ui/toast";
import { nameOf } from "../criteria/model";
import { ConnectionForm } from "./Connection";

const READ_AT = "lab.agent.sourcesReadAt";
const readAt = () => { try { return localStorage.getItem(READ_AT); } catch { return null; } };

/** «Агент»: who is checked and what the product knows of it — how to reach it, and what was read from its code. */
export function AgentPage() {
  const { state, offline, refresh } = useLabState();
  const toast = useToast();
  const { list } = useCriteria(null);
  const [reading, setReading] = useState(false);
  const busy = !!state?.job.running || reading;
  const readCode = () => {
    setReading(true);
    api("/api/sources", {}).then(() => { try { localStorage.setItem(READ_AT, new Date().toISOString()); } catch { /* a nicety */ } return refresh(); }).catch(toast.error).finally(() => setReading(false));
  };
  const header = (
    <Header title="Агент"
      actions={<Button variant="primary" icon={RotateCcw} loading={reading} disabled={busy || !state?.settings.repo} onClick={readCode}
        title={state?.settings.repo ? `Папка с кодом: ${state.settings.repo}` : "Сначала укажите папку с кодом агента"}>{state?.sources.length ? "Прочитать код заново" : "Прочитать код"}</Button>}
      below={<SectionJob kinds={["sources", "names"]} />} />
  );
  if (offline && !state) return <div className="flex h-full flex-col">{header}<ServiceDown /></div>;
  if (!state) return <div className="flex h-full flex-col">{header}<div className="p-5"><Skeleton className="h-[420px]" /></div></div>;
  const sources = [...state.sources].sort((a, b) => b.rules - a.rules || b.chars - a.chars);
  const date = day(readAt());
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid max-w-6xl gap-x-12 gap-y-10 px-4 pb-16 pt-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:px-10 lg:pt-8">
          <div>
            <h2 className="text-title font-semibold text-fg">Подключение</h2>
            <p className="mb-5 mt-1 text-small text-fg-3">Где работает агент и как до него достучаться. Нужно для симуляций; оценка логов агента не запускает.</p>
            <ConnectionForm key={`${state.settings.prodUrl}|${state.settings.repo}|${state.settings.epk.join(" ")}`} state={state} />
            <section aria-label="Трейсы" className="mt-12">
              <h2 className="text-title font-semibold text-fg">Трейсы</h2>
              <p className="mt-1 text-small text-fg-3">Что агент делал внутри каждого разговора: вызовы моделей и инструментов, как их записал Workshop.</p>
              <Link to={SECTIONS.traces} className="mt-3 inline-flex items-center gap-1 text-read font-medium text-run hover:underline">Открыть трейсы<ArrowRight aria-hidden className="size-4" /></Link>
            </section>
          </div>
          <section aria-label="Код агента">
            <h2 className="text-title font-semibold text-fg">Код агента</h2>
            <p className="mb-5 mt-1 text-small text-fg-3">
              {sources.length
                ? <>Прочитано {sources.length} {plural(sources.length, "источник", "источника", "источников")}{date ? ` ${date}` : ""}{state.settings.repo ? <> из <span className="font-mono">{state.settings.repo}</span></> : null}. Из них критерии берутся дословно.</>
                : "Код ещё не прочитан. Укажите папку с кодом в «Запуск из кода» и нажмите «Прочитать код»."}
            </p>
            {sources.length > 0 && (
              <>
                <Label>Промпты и инструменты</Label>
                <ul className="mt-2 divide-y divide-line">
                  {sources.map(s => {
                    const mine = list.filter(c => c.r.rule.sourceId === s.id);
                    const broken = mine.filter(c => c.r.log.failed > 0).length;
                    const { file, dir } = nameOf(s);
                    const Icon = s.kind === "tools" ? Database : FileText;
                    return (
                      <li key={s.id}>
                        <Link to={`${SECTIONS.criteria}?f=${encodeURIComponent(s.id)}&view=code`} className="-mx-3 grid grid-cols-[20px_minmax(0,1fr)_auto_16px] items-center gap-3 rounded-control px-3 py-3 transition-colors hover:bg-hover">
                          <Icon aria-hidden className="size-4 text-fg-3" />
                          <span className="min-w-0"><span className="block truncate font-mono text-small text-fg">{file}</span><span className="block truncate font-mono text-meta text-fg-3">{dir} · {thousands(s.chars)}</span></span>
                          <span className="text-right text-small text-fg-3">{mine.length ? <>{mine.length} {plural(mine.length, "критерий", "критерия", "критериев")}{broken ? <>, <span className="text-bad">{broken} с ошибкой</span></> : ""}</> : "критериев нет"}</span>
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
