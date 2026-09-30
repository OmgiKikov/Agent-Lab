import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Copy, MessageSquare } from "lucide-react";
import { plural } from "../../lab/format";
import { problemMarkdown, sourceLabel } from "../../lab/problemReport";
import { useReview, type Decision, type Problems, type RuleEntry } from "../../lab/problems";
import { useKeys } from "../../shell/keys";
import { LINKS } from "../../shell/links";
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

function secondFact(p: RuleEntry): string {
  const s = p.secondJudge;
  if (!s.checked) return "не проверял";
  const scope = s.byDialogue === s.checked ? " · по диалогу целиком" : s.byDialogue ? ` · ${s.byDialogue} по диалогу целиком` : "";
  return `согласен в ${s.agree} из ${s.checked}${scope}`;
}

/** One problem, read top to bottom as an argument: what is wrong, what the code requires, the proof, what is unknown, what next. */
export function ProblemDetail({ p, data, onBack }: { p: RuleEntry; data: Problems; onBack: () => void }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const shell = useShell();
  const toast = useToast();
  const review = useReview();
  const [sourceOpen, setSourceOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const from: "log" | "sim" = params.get("from") === "sim" && p.sim.failed ? "sim" : p.log.failed ? "log" : "sim";
  const violations = p[from].examples.filter(e => e.status === "FAIL");
  const at = Math.max(0, Math.min(violations.length - 1, (Number(params.get("example")) || 1) - 1));
  const example = violations[at];
  const update = (change: (next: URLSearchParams) => void) =>
    setParams(prev => { const next = new URLSearchParams(prev); change(next); return next; }, { replace: true });
  const setAt = (n: number) => update(next => next.set("example", String(Math.max(0, Math.min(violations.length - 1, n)) + 1)));
  const setFrom = (f: "log" | "sim") => update(next => { next.set("from", f); next.delete("example"); });
  const decide = (d: Decision) => { if (example) review.mutate({ example, decision: example.review === d ? null : d }); };
  const copy = () => { navigator.clipboard.writeText(problemMarkdown(p, window.location.href)).then(() => toast.notify("Разбор скопирован"), toast.error); };
  useKeys({
    ArrowLeft: () => setAt(at - 1),
    ArrowRight: () => setAt(at + 1),
    KeyV: () => decide("agree"),
    KeyN: () => decide("disagree"),
    KeyO: () => { if (example?.traceId) navigate(LINKS.trace(example.traceId)); },
    KeyC: copy,
    Escape: () => { if (!wide()) onBack(); },
  });
  const facts: Fact[] = [
    { label: "В логах", value: p.log.failed ? share(p.log) : "—", onClick: p.log.failed && from !== "log" ? () => setFrom("log") : undefined, title: "Нарушено в диалогах логов из тех, где правило удалось проверить" },
    { label: "В симуляции", value: data.sim ? share(p.sim) : "не было", onClick: p.sim.failed && from !== "sim" ? () => setFrom("sim") : undefined, title: "Нарушено в диалогах выбранного прогона" },
    { label: "Второй судья", value: secondFact(p) },
    { label: "Люди", value: p.human.agree + p.human.disagree ? `верно ${p.human.agree} · неверно ${p.human.disagree}` : "не проверяли" },
  ];
  const unknown = p.log.unknown + p.sim.unknown;
  return (
    <article className="message-arrive mx-auto max-w-[760px] px-6 pb-20 pt-6 lg:px-8">
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-small text-lab-mute transition-colors hover:text-lab-text lg:hidden">
        <ArrowLeft className="size-3.5" />Проблемы
      </button>
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between xl:gap-6">
        <h1 className="min-w-0 flex-1 text-page font-semibold text-lab-ink">{p.title}</h1>
        <div className="flex flex-shrink-0 gap-2">
          <Button size="sm" icon={Copy} kbd="C" onClick={copy}>Скопировать</Button>
          <Button size="sm" icon={MessageSquare} onClick={() => shell.openAsk(example?.traceId ?? null)}>Спросить</Button>
        </div>
      </div>
      {p.topics.length > 0 && <p className="mt-1.5 text-small text-lab-dim">{plural(p.topics.length, "Тема", "Темы", "Темы")}: {p.topics.join(" · ")}</p>}
      <Facts className="mt-6" facts={facts} />
      <section className="mt-8">
        <Quote label={sourceLabel(p.rule.kind)} origin={p.rule.origin || undefined} onOrigin={p.rule.sourceId ? () => setSourceOpen(true) : undefined} hover={hover} onHover={setHover}>
          {p.rule.quote}
        </Quote>
        <dl className="mt-3 space-y-1 pl-[18px] text-small">
          <div><dt className="inline text-lab-dim">Как судья понимает правило: </dt><dd className="inline text-lab-mute">{p.rule.text}</dd></div>
          {p.rule.condition && <div><dt className="inline text-lab-dim">Когда применяется: </dt><dd className="inline text-lab-mute">{p.rule.condition}</dd></div>}
          {p.rule.acceptable && <div><dt className="inline text-lab-dim">Что допустимо: </dt><dd className="inline text-lab-mute">{p.rule.acceptable}</dd></div>}
        </dl>
      </section>
      <Evidence p={p} from={from} onFrom={setFrom} at={at} onAt={setAt} hover={hover} onHover={setHover} onDecide={decide} />
      {unknown > 0 && (
        <section className="mt-10">
          <Label>Не известно</Label>
          <p className="mt-2 text-small text-lab-mute">
            В {unknown} {plural(unknown, "диалоге", "диалогах", "диалогах")} правило не проверено: судья не нашёл доказательств ни выполнения, ни нарушения.
          </p>
        </section>
      )}
      <Reproduce p={p} />
      <SourceDrawer open={sourceOpen} onClose={() => setSourceOpen(false)} sourceId={p.rule.sourceId} origin={p.rule.origin} quote={p.rule.quote} />
    </article>
  );
}
