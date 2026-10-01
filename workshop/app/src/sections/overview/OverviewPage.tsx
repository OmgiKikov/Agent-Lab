import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, Bot, ClipboardCheck, FileText, FlaskConical, Play, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { problemLink, runLink, SECTIONS } from "../../app/links";
import { useCriteria, type Criterion } from "../../lab/criteria";
import { count, longDay, pct, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import type { Problems } from "../../lab/problems";
import { queueOf as verdictQueue } from "../../lab/verdicts";
import { Button } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { AssessSheet } from "../violations/AssessSheet";
import { FirstRun } from "../violations/FirstRun";
import { ReportSheet } from "../violations/ReportSheet";
import { queueOf } from "../violations/model";
import { ProblemRow } from "../problems/ProblemRow";

/**
 * «Обзор»: how the agent is doing and what to do next, for the person who answers for it. One sentence with the honest
 * count, the split of the checked conversations, the main problems in the agent's own behaviour, the next steps, and the
 * last simulation on its own (logs and simulation are never added up).
 */
export function OverviewPage() {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const { data, list } = useCriteria(null);
  const [assess, setAssess] = useState(params.get("assess") === "1");
  const [report, setReport] = useState(params.get("report") === "1");
  // ⌘K opens either sheet by the address, also when this page is already open.
  useEffect(() => { if (params.get("assess") === "1") setAssess(true); if (params.get("report") === "1") setReport(true); }, [params]);
  const drop = (key: string) => { if (params.get(key)) setParams(prev => { const n = new URLSearchParams(prev); n.delete(key); return n; }, { replace: true }); };

  const header = (
    <Header title="Обзор"
      actions={<>
        <Button icon={RotateCcw} onClick={() => setAssess(true)} disabled={!state?.logs.total || !!state?.job.running} className="hidden sm:inline-flex">Оценить логи</Button>
        <Button variant="primary" icon={FileText} aria-label="Отчёт для письма" onClick={() => setReport(true)} disabled={!data?.log && !data?.sim}><span className="hidden sm:inline">Отчёт для письма</span></Button>
      </>}
      below={<SectionJob kinds={["discover", "run", "rejudge"]} />} />
  );
  const sheets = <>
    <AssessSheet open={assess} onClose={() => { setAssess(false); drop("assess"); }} criteria={data?.rules.length ?? 0} />
    {data && (data.log || data.sim) && <ReportSheet open={report} onClose={() => { setReport(false); drop("report"); }} data={data} list={list} />}
  </>;
  if (offline && !state) return <div className="flex h-full flex-col">{header}<ServiceDown /></div>;
  if (!state || !data) return <div className="flex h-full flex-col">{header}<div className="space-y-4 p-8"><Skeleton className="h-40" /><Skeleton className="h-80" /></div></div>;
  if (!data.log) return <div className="flex h-full flex-col">{header}<div className="min-h-0 flex-1 overflow-auto"><FirstRun onAssess={() => setAssess(true)} /></div>{sheets}</div>;

  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[1080px] space-y-6 px-4 pb-20 pt-6 lg:px-8 lg:pt-8">
          <Verdict data={data} file={state.logs.file ?? null} />
          <MainProblems list={list} />
          <div className="grid gap-6 lg:grid-cols-2">
            <NextSteps data={data} problems={list.filter(c => c.r.log.failed > 0).length} ready={state.targets.some(t => t.ready)} onReport={() => setReport(true)} />
            <Simulation data={data} />
          </div>
        </div>
      </div>
      {sheets}
    </div>
  );
}

/** The panel every block of the overview sits in: a title, an optional link to the whole, the content. */
function Panel({ title, more, children, className }: { title: string; more?: { to: string; label: string }; children: React.ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn("rounded-sheet border border-line bg-list shadow-card", className)}>
      <div className="flex items-center justify-between gap-3 px-5 pb-1 pt-4">
        <h2 className="text-lead font-semibold text-fg">{title}</h2>
        {more && <Link to={more.to} className="inline-flex items-center gap-1 rounded-sm text-small font-medium text-fg-2 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">{more.label}<ArrowRight aria-hidden className="size-3.5" /></Link>}
      </div>
      {children}
    </section>
  );
}

/** The answer first: in how many of the checked conversations the agent erred, and the split of all of them. */
function Verdict({ data, file }: { data: Problems; file: string | null }) {
  const log = data.log!;
  const failed = log.withViolations;
  const clean = Math.max(0, log.assessed - failed);
  const parts = [
    { key: "bad", n: failed, word: "с ошибкой агента", dot: "bg-bad", bar: "bg-bad" },
    { key: "ok", n: clean, word: "без обнаруженных ошибок", dot: "bg-ok", bar: "bg-ok/70" },
    { key: "none", n: log.unassessed, word: "проверить не удалось", dot: "bg-fg-4", bar: "bg-fg-4/35" },
  ].filter(p => p.n > 0);
  const total = parts.reduce((s, p) => s + p.n, 0) || 1;
  return (
    <section aria-label="Итог по логам" className="rounded-sheet border border-line bg-list px-5 py-6 shadow-card sm:px-7">
      <p className="text-small text-fg-3">Логи чата проверены {longDay(log.finishedAt)} · {count(log.sampled, "разговор", "разговора", "разговоров")}{file ? ` из выгрузки «${file}»` : ""}</p>
      <h2 className="mt-2 text-balance text-title font-semibold text-fg sm:text-page">
        {failed
          ? <>Агент ошибся в <span className="whitespace-nowrap text-bad">{failed} из {log.assessed}</span> проверенных разговоров</>
          : <>В {count(log.assessed, "проверенном разговоре", "проверенных разговорах", "проверенных разговорах")} ошибок агента не найдено</>}
      </h2>
      {failed > 0 && <p className="mt-2 text-read text-fg-2">Это {pct(failed, log.assessed)}% разговоров, где судья смог проверить хотя бы один критерий.</p>}
      <div className="mt-6 flex h-3 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label={parts.map(p => `${p.word}: ${p.n}`).join(", ")}>
        {parts.map(p => <div key={p.key} className={cn("h-full first:rounded-l-full last:rounded-r-full", p.bar)} style={{ width: `${(100 * p.n) / total}%` }} />)}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-small">
        {parts.map(p => (
          <li key={p.key} className="flex items-center gap-2 text-fg-2">
            <span aria-hidden className={cn("size-2 rounded-full", p.dot)} /><span className="font-semibold tabular-nums text-fg">{p.n}</span>{p.word}
          </li>
        ))}
      </ul>
      {log.unassessed > 0 && <p className="mt-4 max-w-[70ch] text-small text-fg-3">В {count(log.unassessed, "разговоре", "разговорах", "разговорах")} судье не хватило данных ни для одного критерия: в счёт они не входят.</p>}
    </section>
  );
}

/** The problems in the logs, most frequent first: the agent's behaviour as a sentence, how often, one real example. */
function MainProblems({ list }: { list: Criterion[] }) {
  const rows = queueOf(list, "log");
  const shown = rows.slice(0, 5);
  if (!rows.length) return null;
  return (
    <Panel title="Главные проблемы" more={{ to: SECTIONS.problems, label: rows.length > shown.length ? `Все ${rows.length}` : "Все проблемы" }}>
      <ol className="mt-2">
        {shown.map((c, i) => <li key={c.r.id} className="border-t border-line first:border-t-0"><ProblemRow c={c} side="log" rank={i + 1} to={problemLink(c.r.id)} /></li>)}
      </ol>
    </Panel>
  );
}

/** What to do next, from what the data says now: disputed verdicts, the hand-off, the check on a simulation. */
function NextSteps({ data, problems, ready, onReport }: { data: Problems; problems: number; ready: boolean; onReport: () => void }) {
  const disputed = verdictQueue(data, "disputed", null, "log").length;
  const unchecked = verdictQueue(data, "unchecked", null, "log").length;
  const steps = [
    disputed > 0
      ? { icon: ClipboardCheck, title: `Проверьте ${count(disputed, "спорный вердикт", "спорных вердикта", "спорных вердиктов")}`, sub: "Второй судья не согласен с первым. Ваше решение уточнит счёт.", to: `${SECTIONS.review}?queue=disputed` }
      : unchecked > 0
      ? { icon: ClipboardCheck, title: `Подтвердите ${count(unchecked, "найденную ошибку", "найденные ошибки", "найденных ошибок")}`, sub: "Их ещё никто не смотрел: по одной, «да» или «нет».", to: `${SECTIONS.review}?queue=unchecked` }
      : null,
    problems > 0 ? { icon: FileText, title: `Передайте ${count(problems, "проблему", "проблемы", "проблем")} разработчикам`, sub: "Лист с примерами из разговоров: в письмо или тикет.", run: onReport } : null,
    ready
      ? { icon: Play, title: "Проверьте исправление на симуляции", sub: "Синтетические клиенты сыграют сценарии из этих ошибок с вашим агентом.", to: `${SECTIONS.simulations}?play=1` }
      : { icon: Bot, title: "Подключите агента", sub: "Тогда исправления можно проверять на симуляции, не дожидаясь новых логов.", to: SECTIONS.agent },
  ].filter(Boolean) as { icon: typeof Play; title: string; sub: string; to?: string; run?: () => void }[];
  return (
    <Panel title="Что сделать">
      <ul className="mt-2 pb-2">
        {steps.map(s => {
          const body = (
            <>
              <span className="flex size-9 flex-shrink-0 items-center justify-center rounded-block bg-inset text-fg-2 ring-1 ring-line"><s.icon aria-hidden className="size-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium text-fg">{s.title}</span>
                <span className="block text-small text-fg-3">{s.sub}</span>
              </span>
              <ArrowRight aria-hidden className="size-4 flex-shrink-0 text-fg-4" />
            </>
          );
          const cls = "flex w-full items-center gap-3.5 px-5 py-3 text-left transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none";
          return <li key={s.title}>{s.to ? <Link to={s.to} className={cls}>{body}</Link> : <button type="button" onClick={s.run} className={cls}>{body}</button>}</li>;
        })}
      </ul>
    </Panel>
  );
}

/** The last simulation, on its own: when, what was played, in how many of the measured conversations the agent erred. */
function Simulation({ data }: { data: Problems }) {
  const { state } = useLabState();
  const runs = useMemo(() => [...(state?.runs ?? [])].filter(r => r.status !== "running" && r.items !== null).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)), [state?.runs]);
  const run = (data.sim && runs.find(r => r.id === data.sim!.runId)) ?? runs[0];
  if (!run) {
    return (
      <Panel title="Симуляция">
        <div className="px-5 pb-5 pt-1">
          <p className="max-w-[52ch] text-body text-fg-2">Симуляций ещё не было. Синтетические клиенты сыграют с агентом сценарии из настоящих разговоров, и ошибки найдутся до того, как их увидят клиенты.</p>
          <Link to={`${SECTIONS.simulations}?mode=scenarios`} className="mt-4 inline-flex items-center gap-1.5 text-small font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg-3"><FlaskConical aria-hidden className="size-4" />Собрать сценарии</Link>
        </div>
      </Panel>
    );
  }
  const m = run.metric;
  const measured = m?.measured ?? 0;
  const failed = m?.failed ?? 0;
  const all = run.items?.length ?? measured;
  return (
    <Panel title="Последняя симуляция" more={{ to: runLink(run.id), label: "Открыть" }}>
      <div className="px-5 pb-5 pt-1">
        <p className="text-small text-fg-3">{longDay(run.startedAt)}{run.label ? ` · «${run.label}»` : ""}</p>
        {measured > 0 ? (
          <>
            <p className="mt-2 text-title font-semibold text-fg">Ошибки в <span className="whitespace-nowrap text-bad">{failed} из {measured}</span> {plural(measured, "разговора", "разговоров", "разговоров")}</p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-well"><div className="h-full rounded-full bg-bad" style={{ width: `${Math.max(2, pct(failed, measured))}%` }} /></div>
          </>
        ) : <p className="mt-2 text-body text-fg-2">Разговоры этой симуляции ещё не оценены.</p>}
        <p className="mt-3 text-small text-fg-3">
          {all > measured ? `Ещё ${count(all - measured, "разговор", "разговора", "разговоров")} не оценены. ` : ""}Считается отдельно от логов: синтетические клиенты играют сценарии, а не настоящие обращения.
        </p>
      </div>
    </Panel>
  );
}
