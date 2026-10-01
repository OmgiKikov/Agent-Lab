import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowUpRight, ChevronLeft, ChevronRight, ClipboardCheck, Code2, Send } from "lucide-react";
import { Header } from "../../app/Header";
import { useKeys } from "../../app/keys";
import { criterionLink, problemLink, SECTIONS } from "../../app/links";
import { dialogOf } from "../../lab/dialogs";
import { useCriteria } from "../../lab/criteria";
import { count, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { useReview, type Decision, type Example } from "../../lab/problems";
import { humansOf, secondOf } from "../../lab/problemStats";
import { ExampleCard } from "../../product/ExampleCard";
import { shortOrigin } from "../../product/text";
import { SourceSheet } from "../../product/SourceSheet";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Label } from "../../ui/Label";
import { Segmented } from "../../ui/Segmented";
import { Reproduce } from "../violations/Reproduce";
import { checked, violationsOf, type SideKey } from "../violations/model";
import { Handoff } from "./Handoff";

const enc = encodeURIComponent;

/** A fact of the problem as a tile: a label, the value in words with its numbers, a link to what it is made of. */
function Fact({ label, children, to, title }: { label: string; children: React.ReactNode; to?: string; title?: string }) {
  const body = <><span className="block text-small text-fg-3">{label}</span><span className="mt-1 block text-body text-fg-2">{children}</span></>;
  const cls = "block rounded-block border border-line bg-list px-4 py-3 shadow-card";
  return to ? <Link to={to} title={title} className={`${cls} transition-colors hover:border-line-strong hover:bg-hover`}>{body}</Link> : <div className={cls}>{body}</div>;
}

const big = (n: number, of: number, bad?: boolean) => <><b className={`text-lead font-semibold tabular-nums ${bad ? "text-bad" : "text-fg"}`}>{n}</b> из {of}</>;

/**
 * One problem, read like a case: on the left what the agent does wrong and how often, what it must do, the brief for the
 * developers; on the right the proof, example after example, each with the judge's reason first and the person's answer.
 * The prompt's own words, the file and the models sit under «Для разработчика».
 */
export function ProblemPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { state, offline } = useLabState();
  const runParam = params.get("src") === "sim" ? params.get("run") : null;
  const { data, list } = useCriteria(runParam);
  const review = useReview();
  const [lit, setLit] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [source, setSource] = useState(false);
  const c = list.find(x => x.r.id === id);
  const set = (edit: (n: URLSearchParams) => void) => setParams(prev => { const n = new URLSearchParams(prev); edit(n); return n; }, { replace: true });

  const side: SideKey = params.get("src") === "sim" || (c && !c.r.log.failed && c.r.sim.failed) ? "sim" : "log";
  const examples = c ? violationsOf(c, side) : [];
  const at = Math.max(0, Math.min(examples.length - 1, Number(params.get("e") ?? 0) || 0));
  const example = examples[at];
  const go = (n: number) => set(p => { if (n) p.set("e", String(n)); else p.delete("e"); });
  const decide = (e: Example, d: Decision) => review.mutate({ example: e, decision: e.review === d ? null : d });
  useKeys({
    ArrowLeft: () => go(Math.max(0, at - 1)),
    ArrowRight: () => go(Math.min(examples.length - 1, at + 1)),
    KeyV: () => { if (example) decide(example, "agree"); },
    KeyN: () => { if (example) decide(example, "disagree"); },
    KeyO: () => { if (example) navigate(dialogOf(example)); },
  });

  const title = c?.r.title ?? "Проблема";
  const header = (
    <Header title={title} crumbs={[{ label: "Проблемы", to: SECTIONS.problems }]}
      actions={c && <Button variant="primary" icon={Send} aria-label="Задача для разработчика" onClick={() => setHandoff(true)}><span className="hidden sm:inline">Задача для разработчика</span></Button>} />
  );
  if (offline && !state) return <div className="flex h-full flex-col">{header}<ServiceDown /></div>;
  if (!data) return <div className="flex h-full flex-col">{header}<div className="grid gap-6 p-8 xl:grid-cols-2"><Skeleton className="h-96" /><Skeleton className="h-96" /></div></div>;
  if (!c) {
    return (
      <div className="flex h-full flex-col">{header}
        <EmptyState drop title="Такой проблемы больше нет" className="h-full justify-center" action={<Button onClick={() => navigate(SECTIONS.problems)}>Все проблемы</Button>}>
          Её могли переоценить: после новой оценки логов критерии и их счёт меняются.
        </EmptyState>
      </div>
    );
  }

  const r = c.r;
  const s = r[side];
  const sides = ([["log", "Логи"], ["sim", "Симуляция"]] as const).filter(([k]) => r[k].failed > 0);
  const second = secondOf(s.examples);
  const humans = humansOf(s);
  const simQuery = side === "sim" && data.sim ? `src=sim&run=${enc(data.sim.runId)}&` : "";
  const link = `${window.location.origin}${problemLink(r.id, side === "sim" ? { src: "sim", run: data.sim?.runId } : {})}`;
  const { quote, origin, condition, acceptable } = r.rule;

  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto grid max-w-[1320px] gap-x-10 gap-y-8 px-4 pb-20 pt-6 lg:px-8 lg:pt-8 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <aside className="min-w-0 space-y-7" aria-label="Что не так">
            <div>
              <h2 className="text-balance text-page font-semibold text-fg">{r.title}</h2>
              {r.topics.length > 0 && <p className="mt-2 text-small text-fg-3">{r.topics.join(" · ")}</p>}
            </div>

            <section aria-label="Что должен делать агент">
              <Label>Что должен делать агент</Label>
              <p className="mt-1.5 text-read text-fg">{r.rule.text}</p>
              {(condition || acceptable) && (
                <dl className="mt-3 space-y-1.5 text-small text-fg-2">
                  {condition && <div><dt className="inline font-medium text-fg">Когда это важно: </dt><dd className="inline">{condition}</dd></div>}
                  {acceptable && <div><dt className="inline font-medium text-fg">Допустимо: </dt><dd className="inline">{acceptable}</dd></div>}
                </dl>
              )}
            </section>

            <section aria-label="Насколько часто" className="grid grid-cols-2 gap-3">
              <Fact label="В логах" to={r.log.failed ? `${SECTIONS.dialogs}?v=fail&rule=${enc(r.id)}` : undefined} title="Разговоры логов, где агент это нарушил">
                {checked(r.log) ? <>{big(r.log.failed, checked(r.log), r.log.failed > 0)} {plural(checked(r.log), "разговора", "разговоров", "разговоров")}</> : "не проверялось"}
              </Fact>
              <Fact label="В симуляции" to={r.sim.failed && data.sim ? `${SECTIONS.dialogs}?src=sim&run=${enc(data.sim.runId)}&v=fail&rule=${enc(r.id)}` : undefined} title="Разговоры симуляции, где агент это нарушил">
                {checked(r.sim) ? <>{big(r.sim.failed, checked(r.sim), r.sim.failed > 0)} {plural(checked(r.sim), "разговора", "разговоров", "разговоров")}</> : data.sim ? "не проверялось" : "симуляций не было"}
              </Fact>
              <Fact label="Второй судья" to={second.checked > second.agree ? `${SECTIONS.review}?${simQuery}queue=disputed&rule=${enc(r.id)}` : undefined} title="Вердикты, где судьи расходятся">
                {second.checked ? <>согласен в {big(second.agree, second.checked)}</> : "ещё не проверял"}
              </Fact>
              <Fact label="Люди" to={`${SECTIONS.review}?${simQuery}queue=unchecked&rule=${enc(r.id)}`} title="Проверить вердикты по этой проблеме">
                {humans.checked ? <>подтвердили <b className="font-semibold text-fg">{humans.agree}</b>, не согласились <b className="font-semibold text-fg">{humans.checked - humans.agree}</b></> : "ещё не проверяли"}
              </Fact>
            </section>
            {s.unknown > 0 && <p className="-mt-3 text-small text-fg-3">Ещё в {count(s.unknown, "разговоре", "разговорах", "разговорах")} на эти темы проверить не удалось: судье не хватило данных. В счёт они не входят.</p>}

            <div className="flex flex-wrap gap-2">
              <Button icon={ClipboardCheck} onClick={() => navigate(`${SECTIONS.review}?${simQuery}queue=${humans.checked < humans.of ? "unchecked" : "all"}&rule=${enc(r.id)}`)}>Проверить вердикты</Button>
            </div>

            <details className="group rounded-block border border-line bg-list px-4 py-3 shadow-card">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-body font-medium text-fg-2 transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
                <Code2 aria-hidden className="size-4 text-fg-3" />Для разработчика<span aria-hidden className="ml-auto text-fg-3 transition-transform group-open:rotate-90">›</span>
              </summary>
              <div className="mt-3 space-y-3 text-small text-fg-2">
                <div>
                  <span className="text-fg-3">Требование в промпте агента</span>
                  <blockquote className="mt-1 border-l-2 border-mark-strong pl-3 text-body text-fg">«{quote}»</blockquote>
                </div>
                {origin && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono text-meta text-fg-2">{shortOrigin(origin)}</span>
                    {r.rule.sourceId && <button type="button" onClick={() => setSource(true)} className="inline-flex items-center gap-1 rounded-sm font-medium text-run hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">Текст промпта<ArrowUpRight aria-hidden className="size-3.5" /></button>}
                    <Link to={criterionLink(r.id, { view: "code" })} className="inline-flex items-center gap-1 rounded-sm font-medium text-run hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">В коде агента<ArrowUpRight aria-hidden className="size-3.5" /></Link>
                  </div>
                )}
                <p className="text-fg-3">Судьи: <span className="font-mono text-meta text-fg-2">{[state?.models.main, state?.models.second].filter(Boolean).join(" · ")}</span></p>
              </div>
            </details>
          </aside>

          <main className="min-w-0 space-y-4" aria-label="Примеры">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2 className="text-lead font-semibold text-fg">Примеры</h2>
              {sides.length > 1 && <Segmented<SideKey> size="sm" label="Откуда примеры" value={side} onChange={v => set(p => { if (v === "sim") { p.set("src", "sim"); if (data.sim) p.set("run", data.sim.runId); } else { p.delete("src"); p.delete("run"); } p.delete("e"); })} options={sides.map(([k, l]) => ({ value: k, label: l, count: r[k].failed }))} />}
              <span className="flex-1" />
              {examples.length > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="mr-1 text-small tabular-nums text-fg-3">{at + 1} из {examples.length}</span>
                  <Button size="sm" icon={ChevronLeft} aria-label="Предыдущий пример" kbd="←" disabled={at <= 0} onClick={() => go(at - 1)} />
                  <Button size="sm" icon={ChevronRight} aria-label="Следующий пример" kbd="→" disabled={at >= examples.length - 1} onClick={() => go(at + 1)} />
                </span>
              )}
            </div>
            {example ? <ExampleCard example={example} lit={lit} onLit={setLit} onDecide={d => decide(example, d)} /> : <p className="text-small text-fg-3">Примеров нет.</p>}
            {side === "log" && <div className="pt-4"><Reproduce r={r} /></div>}
          </main>
        </div>
      </div>
      <Handoff open={handoff} onClose={() => setHandoff(false)} r={r} side={side} link={link} />
      <SourceSheet open={source} onClose={() => setSource(false)} sourceId={r.rule.sourceId} origin={r.rule.origin} quote={r.rule.quote} />
    </div>
  );
}
