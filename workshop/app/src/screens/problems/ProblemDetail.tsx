import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Copy, MessageSquare } from "lucide-react";
import { dialogOf } from "../../lab/dialogs";
import { plural } from "../../lab/format";
import { problemMarkdown, sourceLabel } from "../../lab/problemReport";
import { useReview, type Decision, type Example, type RuleEntry } from "../../lab/problems";
import { useKeys } from "../../shell/keys";
import { viewLink } from "../../shell/links";
import { useShell } from "../../shell/ShellContext";
import { Button } from "../../ui/Button";
import { Facts, type Fact } from "../../ui/Facts";
import { Label } from "../../ui/Label";
import { Quote } from "../../ui/Quote";
import { useToast } from "../../ui/toast";
import { Evidence } from "./Evidence";
import { Reproduce } from "./Reproduce";
import { SourceDrawer } from "./SourceDrawer";

const share = (side: { failed: number; passed: number }) => `${side.failed} из ${side.failed + side.passed}`;
const wide = () => window.matchMedia("(min-width: 1024px)").matches;

/** The second judge on the violations of one side: how many he checked and agreed with. */
function secondFact(examples: Example[]): string {
  const judged = examples.filter(e => e.status === "FAIL" && e.second);
  if (!judged.length) return "не проверял";
  const agree = judged.filter(e => e.second === "agree").length;
  const whole = judged.filter(e => e.secondScope === "dialogue").length;
  const scope = whole === judged.length ? " · по диалогу целиком" : whole ? ` · ${whole} по диалогу целиком` : "";
  return `согласен в ${agree} из ${judged.length}${scope}`;
}

/** One problem of one source, read top to bottom as an argument: what is wrong, what the code requires, the proof, what is unknown, what next. */
export function ProblemDetail({ p, source, runId, onBack }: { p: RuleEntry; source: "log" | "sim"; runId?: string | null; onBack: () => void }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const shell = useShell();
  const toast = useToast();
  const review = useReview();
  const [sourceOpen, setSourceOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const side = p[source];
  const violations = side.examples.filter(e => e.status === "FAIL");
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
  const humans = violations.filter(e => e.review);
  const agreed = humans.filter(e => e.review === "agree").length;
  const facts: Fact[] = [
    { label: source === "log" ? "В логах" : "В симуляции", value: share(side), onClick: () => navigate(viewLink(source, runId, "dialogs", { v: "fail", rule: p.id })), title: "Открыть диалоги, где критерий нарушен" },
    { label: "Второй судья", value: secondFact(side.examples), onClick: violations.some(e => e.second === "disagree") ? () => navigate(viewLink(source, runId, "review", { queue: "disputed", rule: p.id })) : undefined, title: "Открыть вердикты, где судьи расходятся" },
    ...(side.unknown ? [{ label: "Не проверено", value: `в ${side.unknown} ${plural(side.unknown, "диалоге", "диалогах", "диалогах")}`, title: "Судья не нашёл доказательств ни выполнения, ни нарушения" }] : []),
    { label: "Люди", value: humans.length ? `верно ${agreed} · неверно ${humans.length - agreed}` : "не проверяли", onClick: () => navigate(viewLink(source, runId, "review", { queue: "unchecked", rule: p.id })), title: "Проверить нарушения этого критерия" },
  ];
  return (
    <article className="message-arrive mx-auto max-w-[760px] px-6 pb-16 pt-5 lg:px-8">
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-small text-lab-mute transition-colors hover:text-lab-text lg:hidden">
        <ArrowLeft className="size-3.5" />Нарушения
      </button>
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between xl:gap-6">
        <h1 className="min-w-0 flex-1 text-page font-medium text-lab-ink">{p.title}</h1>
        <div className="flex flex-shrink-0 gap-2">
          <Button size="sm" icon={Copy} kbd="C" onClick={copy}>Скопировать</Button>
          <Button size="sm" icon={MessageSquare} onClick={() => shell.openAsk(example?.traceId ?? null)}>Спросить</Button>
        </div>
      </div>
      {p.topics.length > 0 && <p className="mt-1 text-meta text-lab-dim">{plural(p.topics.length, "Тема", "Темы", "Темы")}: {p.topics.join(" · ")}</p>}
      <Facts className="mt-4" facts={facts} />
      <section className="mt-6">
        <Quote label={sourceLabel(p.rule.kind)} origin={p.rule.origin || undefined} onOrigin={p.rule.sourceId ? () => setSourceOpen(true) : undefined} hover={hover} onHover={setHover}>
          {p.rule.quote}
        </Quote>
        <details className="group mt-2 pl-[18px] text-small">
          <summary className="cursor-pointer list-none text-lab-dim transition-colors hover:text-lab-text">Подробнее о критерии</summary>
          <dl className="mt-2 space-y-1">
          <div>
            <dt className="inline text-lab-dim">Как судья понимает критерий: </dt><dd className="inline text-lab-mute">{p.rule.text}</dd>
            <Link to={`/agent?tab=criteria&c=${encodeURIComponent(p.id)}`} className="ml-2 whitespace-nowrap text-lab-dim underline decoration-white/20 underline-offset-4 transition-colors hover:text-lab-text">критерий целиком</Link>
          </div>
          {p.rule.condition && <div><dt className="inline text-lab-dim">Когда применяется: </dt><dd className="inline text-lab-mute">{p.rule.condition}</dd></div>}
          {p.rule.acceptable && <div><dt className="inline text-lab-dim">Что допустимо: </dt><dd className="inline text-lab-mute">{p.rule.acceptable}</dd></div>}
          </dl>
        </details>
      </section>
      <Evidence p={p} from={source} at={at} onAt={setAt} hover={hover} onHover={setHover} onDecide={decide} />
      {source === "log" && <Reproduce p={p} />}
      <SourceDrawer open={sourceOpen} onClose={() => setSourceOpen(false)} sourceId={p.rule.sourceId} origin={p.rule.origin} quote={p.rule.quote} />
    </article>
  );
}
