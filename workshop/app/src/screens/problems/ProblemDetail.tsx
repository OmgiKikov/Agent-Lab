import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Copy, MessageSquare } from "lucide-react";
import { dialogOf } from "../../lab/dialogs";
import { plural } from "../../lab/format";
import { problemMarkdown, sourceLabel } from "../../lab/problemReport";
import { useReview, type Decision, type RuleEntry } from "../../lab/problems";
import { humansOf, secondOf } from "../../lab/problemStats";
import { cn } from "@/lib/utils";
import { useKeys } from "../../shell/keys";
import { viewLink } from "../../shell/links";
import { useShell } from "../../shell/ShellContext";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { Details, Tag, type Detail } from "../../ui/Details";
import { Tiles, type Tile } from "../../ui/Tiles";
import { TwoCol } from "../../ui/TwoCol";
import { Quote } from "../../ui/Quote";
import { useToast } from "../../ui/toast";
import { modeOf, orderExamples, type EvidenceMode } from "../verdicts/EvidenceBar";
import { ExamplePane } from "../verdicts/ExamplePane";
import { Reproduce } from "./Reproduce";
import { SourceDrawer } from "./SourceDrawer";

const wide = () => window.matchMedia("(min-width: 1024px)").matches;

/** How the dialogues of one side divide: violated, fulfilled, and those the judge could not tell. One bar, every part counted. */
function Split3({ side }: { side: { failed: number; passed: number; unknown: number } }) {
  const total = side.failed + side.passed + side.unknown;
  const part = (n: number) => `${total ? (100 * n) / total : 0}%`;
  return (
    <section className="mt-6">
      <h2 className="text-heading font-semibold text-lab-ink">Диалоги</h2>
      <div className="mt-2.5 flex h-2 overflow-hidden rounded-full bg-white/[0.08]" role="img" aria-label={`нарушено ${side.failed}, выполнено ${side.passed}, не проверено ${side.unknown}`}>
        <div className="bg-lab-bad" style={{ width: part(side.failed) }} />
        <div className="bg-white/40" style={{ width: part(side.passed) }} />
        <div className="bg-lab-warn/70" style={{ width: part(side.unknown) }} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-meta text-lab-mute">
        <span><span className="mr-1 inline-block size-1.5 rounded-full bg-lab-bad" />нарушено {side.failed}</span>
        <span><span className="mr-1 inline-block size-1.5 rounded-full bg-white/40" />без нарушений {side.passed}</span>
        {side.unknown > 0 && <span><span className="mr-1 inline-block size-1.5 rounded-full bg-lab-warn/70" />не проверено {side.unknown}</span>}
      </div>
    </section>
  );
}

/** One problem of one source as Raindrop's issue page: the criterion on the left with its numbers, the proof on the right. */
export function ProblemDetail({ p, source, runId, onBack }: { p: RuleEntry; source: "log" | "sim"; runId?: string | null; onBack: () => void }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const shell = useShell();
  const toast = useToast();
  const review = useReview();
  const [sourceOpen, setSourceOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [more, setMore] = useState(false);
  const side = p[source];
  const mode = modeOf(params.get("ev"));
  const violations = orderExamples(side.examples.filter(e => e.status === "FAIL"), mode);
  const setMode = (m: EvidenceMode) => setParams(prev => { const n = new URLSearchParams(prev); if (m === "rec") n.delete("ev"); else n.set("ev", m); n.delete("example"); return n; }, { replace: true });
  const at = Math.max(0, Math.min(violations.length - 1, (Number(params.get("example")) || 1) - 1));
  const example = violations[at];
  const update = (change: (next: URLSearchParams) => void) =>
    setParams(prev => { const next = new URLSearchParams(prev); change(next); return next; }, { replace: true });
  const setAt = (n: number) => update(next => next.set("example", String(Math.max(0, Math.min(violations.length - 1, n)) + 1)));
  const decide = (d: Decision) => { if (example) review.mutate({ example, decision: example.review === d ? null : d }); };
  const copy = () => { navigator.clipboard.writeText(problemMarkdown(p, window.location.href, 1, source)).then(() => toast.notify("Разбор скопирован"), toast.error); };
  useKeys({
    ArrowLeft: () => setAt(at - 1),
    ArrowRight: () => setAt(at + 1),
    KeyV: () => decide("agree"),
    KeyN: () => decide("disagree"),
    KeyO: () => { if (example) navigate(dialogOf(example)); },
    KeyC: copy,
    Escape: () => { if (!wide()) onBack(); },
  });
  const humans = humansOf(side);
  const second = secondOf(side.examples);
  const total = side.failed + side.passed;
  const to = (view: "dialogs" | "review", extra: Record<string, string>) => navigate(viewLink(source, runId, view, extra));
  const tiles: Tile[] = [
    { label: source === "log" ? "В логах" : "В прогоне", value: side.failed, of: `из ${total}`, onClick: () => to("dialogs", { v: "fail", rule: p.id }), title: "Открыть диалоги, где критерий нарушен" },
    { label: "Без оценки", value: side.unknown, of: side.unknown ? plural(side.unknown, "диалог", "диалога", "диалогов") : undefined, title: "Судья не нашёл доказательств ни выполнения, ни нарушения" },
    { label: "Второй судья", value: second.checked ? second.agree : "—", of: second.checked ? `из ${second.checked}` : undefined, onClick: violations.some(e => e.second === "disagree") ? () => to("review", { queue: "disputed", rule: p.id }) : undefined, title: second.checked ? `Согласен в ${second.agree} из ${second.checked} нарушений${second.whole ? `, ${second.whole} оценил по диалогу целиком` : ""}` : "Не проверял" },
    { label: "Люди", value: humans.checked || "—", of: humans.checked ? `из ${humans.of}` : undefined, onClick: () => to("review", { queue: "unchecked", rule: p.id }), title: humans.checked ? `верно ${humans.agree}, неверно ${humans.checked - humans.agree}` : "Проверить нарушения этого критерия" },
  ];
  const details: Detail[] = [
    { label: "Критерий", value: <Link to={`/agent?tab=criteria&c=${encodeURIComponent(p.id)}`} className="underline decoration-white/20 underline-offset-2 hover:text-lab-ink">открыть целиком</Link> },
    { label: "Источник", value: p.rule.origin ? <button type="button" onClick={p.rule.sourceId ? () => setSourceOpen(true) : undefined} className="break-all text-left font-mono text-meta underline decoration-white/20 underline-offset-2 hover:text-lab-ink">{p.rule.origin}</button> : sourceLabel(p.rule.kind) },
    ...(p.topics.length ? [{ label: plural(p.topics.length, "Тема", "Темы", "Темы"), value: <span className="flex flex-wrap gap-1.5">{p.topics.map(t => <Tag key={t}>{t}</Tag>)}</span> }] : []),
    ...(p.rule.condition ? [{ label: "Когда", value: p.rule.condition }] : []),
    ...(p.rule.acceptable ? [{ label: "Допустимо", value: p.rule.acceptable }] : []),
    ...(humans.checked ? [{ label: "Люди", value: `верно ${humans.agree} · неверно ${humans.checked - humans.agree}` }] : []),
  ];
  const left = (
    <>
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1.5 text-small text-lab-mute transition-colors hover:text-lab-text lg:hidden"><ArrowLeft className="size-3.5" />Нарушения</button>
      <Chip tone="bad">Нарушение {source === "log" ? "в логах" : "в прогоне"}</Chip>
      <h1 className="mt-2.5 text-title font-medium text-lab-ink">{p.title}</h1>
      <p className={cn("mt-2 text-small text-lab-mute", !more && "line-clamp-3")}>{p.rule.text}</p>
      {p.rule.text.length > 150 && <button type="button" onClick={() => setMore(m => !m)} className="text-small text-lab-soft underline decoration-white/20 underline-offset-2 hover:text-lab-ink">{more ? "свернуть" : "…ещё"}</button>}
      <div className="mt-3 flex gap-2">
        <Button size="sm" icon={Copy} kbd="C" onClick={copy}>Скопировать</Button>
        <Button size="sm" icon={MessageSquare} onClick={() => shell.openAsk(example?.traceId ?? null)}>Спросить</Button>
      </div>
      <Tiles className="mt-4" tiles={tiles} />
      <Details rows={details} />
      <section className="mt-6">
        <Quote label={sourceLabel(p.rule.kind)} hover={hover} onHover={setHover}>{p.rule.quote}</Quote>
      </section>
      <Split3 side={side} />
      {source === "log" && <Reproduce p={p} />}
      <SourceDrawer open={sourceOpen} onClose={() => setSourceOpen(false)} sourceId={p.rule.sourceId} origin={p.rule.origin} quote={p.rule.quote} />
    </>
  );
  return <TwoCol left={left} right={<ExamplePane list={violations} mode={mode} onMode={setMode} at={at} onAt={setAt} hover={hover} onHover={setHover} onDecide={decide} />} />;
}
