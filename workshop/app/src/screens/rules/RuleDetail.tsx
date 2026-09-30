import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ListChecks } from "lucide-react";
import { dialogOf } from "../../lab/dialogs";
import { plural } from "../../lab/format";
import { sourceLabel } from "../../lab/problemReport";
import { useReview, type Decision, type Example, type Problems, type RuleEntry } from "../../lab/problems";
import { useKeys } from "../../shell/keys";
import { viewLink } from "../../shell/links";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { Chip } from "../../ui/Chip";
import { Details, Tag, type Detail } from "../../ui/Details";
import { PillTabs } from "../../ui/PillTabs";
import { Tiles, type Tile } from "../../ui/Tiles";
import { TwoCol } from "../../ui/TwoCol";
import { Quote } from "../../ui/Quote";
import { SourceDrawer } from "../problems/SourceDrawer";
import { modeOf, orderExamples, type EvidenceMode } from "../verdicts/EvidenceBar";
import { ExamplePane } from "../verdicts/ExamplePane";
import { disputedCount } from "./RuleList";

type Tab = "FAIL" | "PASS" | "UNKNOWN";
const TAB_TITLE: Record<Tab, string> = { FAIL: "Нарушено", PASS: "Выполнено", UNKNOWN: "Не проверено" };
const wide = () => window.matchMedia("(min-width: 1024px)").matches;

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
  const to = (view: "review", extra: Record<string, string>) => navigate(viewLink(src, simRun, view, extra));
  const sideTile = (label: string, x: RuleEntry["log"], present: boolean): Tile => (present && x.failed + x.passed
    ? { label, value: x.failed, of: `из ${x.failed + x.passed}`, title: `нарушено ${x.failed}, выполнено ${x.passed}${x.unknown ? `, не проверено ${x.unknown}` : ""}` }
    : { label, value: "—", title: "не было" });
  const people = r.human.agree + r.human.disagree;
  const tiles: Tile[] = [
    sideTile("В логах", r.log, !!data.log),
    sideTile("В прогоне", r.sim, !!data.sim),
    { label: "Спорные", value: disputes || (s.checked ? 0 : "—"), onClick: disputes ? () => to("review", { queue: "disputed", rule: r.id }) : undefined, title: s.checked ? "Вердиктов, где второй судья не согласен" : "Второй судья не проверял" },
    { label: "Люди", value: people || "—", of: people ? `верно ${r.human.agree}` : undefined, onClick: counts.FAIL ? () => to("review", { queue: "all", rule: r.id }) : undefined },
  ];
  const details: Detail[] = [
    { label: "Источник", value: r.rule.origin ? <button type="button" onClick={r.rule.sourceId ? () => setSourceOpen(true) : undefined} className="break-all text-left font-mono text-meta underline decoration-white/20 underline-offset-2 hover:text-lab-ink">{r.rule.origin}</button> : sourceLabel(r.rule.kind) },
    ...(r.topics.length ? [{ label: plural(r.topics.length, "Тема", "Темы", "Темы"), value: <span className="flex flex-wrap gap-1.5">{r.topics.map(t => <Tag key={t}>{t}</Tag>)}</span> }] : []),
    ...(r.rule.condition ? [{ label: "Когда", value: r.rule.condition }] : []),
    ...(r.rule.acceptable ? [{ label: "Допустимо", value: r.rule.acceptable }] : []),
    ...(violated ? [{ label: "Нарушение", value: <Link to={viewLink(r.log.failed ? "log" : "sim", simRun, "problems", { p: r.id })} className="underline decoration-white/20 underline-offset-2 hover:text-lab-ink">{r.title}</Link> }] : []),
  ];
  const left = (
    <>
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1.5 text-small text-lab-mute transition-colors hover:text-lab-text lg:hidden"><ArrowLeft className="size-3.5" />Критерии</button>
      {violated ? <Chip tone="bad">Нарушается</Chip> : counts.PASS ? <Chip tone="ok">Без обнаруженных нарушений</Chip> : <Chip tone="mute">Не проверялся</Chip>}
      <h1 className="mt-2.5 text-title font-medium text-lab-ink">{r.rule.text}</h1>
      {counts.FAIL + counts.PASS > 0 && (
        <div className="mt-3"><Button size="sm" icon={ListChecks} onClick={() => to("review", { queue: disputes ? "disputed" : "all", rule: r.id })}>Проверить вердикты</Button></div>
      )}
      <Tiles className="mt-4" tiles={tiles} />
      <Details rows={details} />
      <section className="mt-6"><Quote label={sourceLabel(r.rule.kind)} hover={hover} onHover={setHover}>{r.rule.quote}</Quote></section>
      <SourceDrawer open={sourceOpen} onClose={() => setSourceOpen(false)} sourceId={r.rule.sourceId} origin={r.rule.origin} quote={r.rule.quote} />
    </>
  );
  const kinds = (["FAIL", "PASS", "UNKNOWN"] as Tab[]).filter(t => counts[t]);
  const right = counts.FAIL + counts.PASS + counts.UNKNOWN === 0
    ? <EmptyState title="Вердиктов пока нет">Критерий появился при извлечении, но ни в одном оценённом диалоге судья его ещё не применял.</EmptyState>
    : (
      <div className="flex min-h-full flex-col">
        <div className="flex-shrink-0 border-b border-white/[0.08] px-3 py-[7px]">
          <PillTabs<Tab> label="Вердикты" value={tab} onChange={setTab} tabs={kinds.map(t => ({ value: t, label: TAB_TITLE[t], count: counts[t] }))} />
        </div>
        <ExamplePane list={list} mode={mode} onMode={setMode} at={at} onAt={setAt} hover={hover} onHover={setHover} onDecide={decide} />
      </div>
    );
  return <TwoCol left={left} right={right} />;
}
