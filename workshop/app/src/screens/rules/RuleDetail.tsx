import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, ListChecks } from "lucide-react";
import { dialogOf } from "../../lab/dialogs";
import { plural } from "../../lab/format";
import { sourceLabel } from "../../lab/problemReport";
import { useReview, type Decision, type Example, type Problems, type RuleEntry } from "../../lab/problems";
import { useKeys } from "../../shell/keys";
import { viewLink } from "../../shell/links";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { Facts, type Fact } from "../../ui/Facts";
import { Label } from "../../ui/Label";
import { Quote } from "../../ui/Quote";
import { Segmented } from "../../ui/Segmented";
import { SourceDrawer } from "../problems/SourceDrawer";
import { EvidenceAll, EvidenceBar, modeOf, orderExamples, type EvidenceMode } from "../verdicts/EvidenceBar";
import { ConversationBox, ExampleMeta, JudgeNote, useExample } from "../verdicts/Example";
import { disputedCount } from "./RuleList";

type Tab = "FAIL" | "PASS" | "UNKNOWN";
const TAB_TITLE: Record<Tab, string> = { FAIL: "Нарушено", PASS: "Выполнено", UNKNOWN: "Не проверено" };
const wide = () => window.matchMedia("(min-width: 1024px)").matches;

function side(label: string, s: RuleEntry["log"], present: boolean): Fact {
  if (!present) return { label, value: "не было" };
  const parts = [`нарушено ${s.failed}`, `выполнено ${s.passed}`];
  if (s.unknown) parts.push(`не проверено ${s.unknown}`);
  return { label, value: parts.join(" · ") };
}

/** One criterion: what the code requires, how the agent keeps it in the logs and the run, and every verdict behind the counts. */
export function RuleDetail({ r, data, onBack }: { r: RuleEntry; data: Problems; onBack: () => void }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const review = useReview();
  const [sourceOpen, setSourceOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const examples = [...r.log.examples, ...r.sim.examples];
  const counts: Record<Tab, number> = { FAIL: r.log.failed + r.sim.failed, PASS: r.log.passed + r.sim.passed, UNKNOWN: r.log.unknown + r.sim.unknown };
  const wanted = params.get("vt") as Tab | null;
  const tab: Tab = wanted && counts[wanted] ? wanted : (["FAIL", "PASS", "UNKNOWN"] as Tab[]).find(t => counts[t]) ?? "FAIL";
  const mode = modeOf(params.get("ev"));
  const list = orderExamples(examples.filter(e => e.status === tab), mode);
  const at = Math.max(0, Math.min(list.length - 1, (Number(params.get("example")) || 1) - 1));
  const example: Example | undefined = list[at];
  const view = useExample(example);
  const update = (change: (next: URLSearchParams) => void) =>
    setParams(prev => { const next = new URLSearchParams(prev); change(next); return next; }, { replace: true });
  const setAt = (n: number) => update(next => next.set("example", String(Math.max(0, Math.min(list.length - 1, n)) + 1)));
  const setTab = (t: Tab) => update(next => { next.set("vt", t); next.delete("example"); });
  const setMode = (m: EvidenceMode) => update(next => { if (m === "rec") next.delete("ev"); else next.set("ev", m); next.delete("example"); });
  const decide = (d: Decision) => { if (example && example.status !== "UNKNOWN") review.mutate({ example, decision: example.review === d ? null : d }); };
  useKeys({
    ArrowLeft: () => setAt(at - 1),
    ArrowRight: () => setAt(at + 1),
    KeyV: () => decide("agree"),
    KeyN: () => decide("disagree"),
    KeyO: () => { if (example) navigate(dialogOf(example)); },
    Escape: () => { if (!wide()) onBack(); },
  });
  const src: "log" | "sim" = r.log.failed + r.log.passed ? "log" : "sim";
  const simRun = data.sim?.runId;
  const violated = counts.FAIL > 0;
  const disputes = disputedCount(r);
  const s = r.secondJudge;
  const facts: Fact[] = [
    side("В логах", r.log, !!data.log),
    side("В симуляции", r.sim, !!data.sim),
    {
      label: "Судьи расходятся",
      value: disputes ? `в ${disputes} ${plural(disputes, "вердикте", "вердиктах", "вердиктах")}` : s.checked ? "нет" : "второй судья не проверял",
      onClick: disputes ? () => navigate(viewLink(src, simRun, "review", { queue: "disputed", rule: r.id })) : undefined,
    },
    {
      label: "Люди",
      value: r.human.agree + r.human.disagree ? `верно ${r.human.agree} · неверно ${r.human.disagree}` : "не проверяли",
      onClick: counts.FAIL ? () => navigate(viewLink(src, simRun, "review", { queue: "all", rule: r.id })) : undefined,
    },
  ];
  return (
    <article className="message-arrive mx-auto max-w-[760px] px-6 pb-20 pt-6 lg:px-8">
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-small text-lab-mute transition-colors hover:text-lab-text lg:hidden">
        <ArrowLeft className="size-3.5" />Критерии
      </button>
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between xl:gap-6">
        <h1 className="min-w-0 flex-1 text-page font-medium text-lab-ink">{r.rule.text}</h1>
        {counts.FAIL + counts.PASS > 0 && (
          <Button size="sm" icon={ListChecks} onClick={() => navigate(viewLink(src, simRun, "review", { queue: disputes ? "disputed" : "all", rule: r.id }))}>Проверить вердикты</Button>
        )}
      </div>
      {violated ? (
        <Link to={viewLink(r.log.failed ? "log" : "sim", simRun, "problems", { p: r.id })} className="mt-2 inline-flex items-center gap-1.5 text-small text-lab-bad transition-colors hover:text-lab-text">
          Нарушается: {r.title}<ArrowRight className="size-3.5" />
        </Link>
      ) : counts.PASS ? <p className="mt-2 text-small text-lab-ok">Нарушений не найдено</p> : null}
      <Facts className="mt-4" facts={facts} />
      <section className="mt-8">
        <Quote label={sourceLabel(r.rule.kind)} origin={r.rule.origin || undefined} onOrigin={r.rule.sourceId ? () => setSourceOpen(true) : undefined} hover={hover} onHover={setHover}>
          {r.rule.quote}
        </Quote>
        {(r.rule.condition || r.rule.acceptable || r.topics.length > 0) && (
          <dl className="mt-3 space-y-1 pl-[18px] text-small">
            {r.rule.condition && <div><dt className="inline text-lab-dim">Когда применяется: </dt><dd className="inline text-lab-mute">{r.rule.condition}</dd></div>}
            {r.rule.acceptable && <div><dt className="inline text-lab-dim">Что допустимо: </dt><dd className="inline text-lab-mute">{r.rule.acceptable}</dd></div>}
            {r.topics.length > 0 && <div><dt className="inline text-lab-dim">{plural(r.topics.length, "Тема", "Темы", "Темы")}: </dt><dd className="inline text-lab-mute">{r.topics.join(" · ")}</dd></div>}
          </dl>
        )}
      </section>
      <section className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Label>Вердикты</Label>
          <Segmented value={tab} onChange={setTab} options={(["FAIL", "PASS", "UNKNOWN"] as Tab[]).filter(t => counts[t]).map(t => ({ value: t, label: TAB_TITLE[t], count: counts[t] }))} />
        </div>
        <div className="mt-2"><EvidenceBar mode={mode} onMode={setMode} at={at} total={list.length} onAt={setAt} /></div>
        {mode === "all" && list.length ? <EvidenceAll list={list} onPick={i => { update(next => { next.delete("ev"); next.set("example", String(i + 1)); }); }} /> : null}
        {mode === "all" && list.length ? null : example ? (
          <>
            <div className="mt-3"><ExampleMeta example={example} /></div>
            <ConversationBox className="mt-2" view={view} example={example} hover={hover} onHover={setHover} />
            <div className="mt-3"><JudgeNote example={example} marked={view.marked} onDecide={decide} /></div>
          </>
        ) : <EmptyState title="Вердиктов пока нет">Критерий появился при извлечении, но ни в одном оценённом диалоге судья его ещё не применял.</EmptyState>}
      </section>
      <SourceDrawer open={sourceOpen} onClose={() => setSourceOpen(false)} sourceId={r.rule.sourceId} origin={r.rule.origin} quote={r.rule.quote} />
    </article>
  );
}
