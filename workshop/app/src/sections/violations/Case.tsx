import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Copy, MessageSquare, Play } from "lucide-react";
import type { Criterion } from "../../lab/criteria";
import { dialogOf } from "../../lab/dialogs";
import { plural } from "../../lab/format";
import { problemMarkdown } from "../../lab/problemReport";
import { useReview, type Decision, type Example } from "../../lab/problems";
import { humansOf, secondOf } from "../../lab/problemStats";
import { CodeQuote } from "../../product/CodeQuote";
import { Count } from "../../product/Count";
import { Facts, type Fact } from "../../product/Facts";
import { SourceSheet } from "../../product/SourceSheet";
import { useKeys } from "../../app/keys";
import { useShell } from "../../app/ShellContext";
import { Button } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { useToast } from "../../ui/toast";
import { Evidence } from "./Evidence";
import { checked, violationsOf, type SideKey } from "./model";
import { Reproduce } from "./Reproduce";

const enc = encodeURIComponent;

/**
 * One violation, read top to bottom as an argument: what the agent does wrong, how often, what the code requires,
 * the agent's words that prove it, what stays unknown, and how to play it again.
 */
export function Case({ c, side, onSide, at, onAt, runId, hasLog, hasSim, onBack }: {
  c: Criterion; side: SideKey; onSide: (s: SideKey) => void; at: number; onAt: (n: number) => void;
  runId: string | null; hasLog: boolean; hasSim: boolean; onBack?: () => void;
}) {
  const r = c.r;
  const navigate = useNavigate();
  const shell = useShell();
  const toast = useToast();
  const review = useReview();
  const [lit, setLit] = useState(false);
  const [source, setSource] = useState(false);
  const list = violationsOf(c, side);
  const now = Math.max(0, Math.min(list.length - 1, at));
  const example = list[now];
  const decide = (e: Example, d: Decision) => review.mutate({ example: e, decision: e.review === d ? null : d });
  const copy = () => navigator.clipboard.writeText(problemMarkdown(r, window.location.href, 1, side)).then(() => toast.notify("Разбор скопирован"), toast.error);
  useKeys({
    ArrowLeft: () => onAt(Math.max(0, now - 1)),
    ArrowRight: () => onAt(Math.min(list.length - 1, now + 1)),
    KeyV: () => { if (example) decide(example, "agree"); },
    KeyN: () => { if (example) decide(example, "disagree"); },
    KeyO: () => { if (example) navigate(dialogOf(example)); },
    KeyC: copy,
    Escape: () => onBack?.(),
  });
  const s = r[side];
  const second = secondOf(s.examples);
  const humans = humansOf(s);
  const disputed = s.examples.some(e => e.status === "FAIL" && e.second === "disagree");
  const review$ = (queue: string) => `/review?${side === "sim" && runId ? `src=sim&run=${enc(runId)}&` : ""}queue=${queue}&rule=${enc(r.id)}`;
  const facts: Fact[] = [
    ...(hasLog ? [{ label: "В логах", value: <Count n={r.log.failed} of={checked(r.log)} bad />, to: `/dialogs?v=fail&rule=${enc(r.id)}`, title: "Диалоги логов, где критерий нарушен, из тех, где его удалось проверить" }] : []),
    ...(hasSim ? [{ label: "В симуляции", value: <Count n={r.sim.failed} of={checked(r.sim)} bad />, to: `/dialogs?src=sim${runId ? `&run=${enc(runId)}` : ""}&v=fail&rule=${enc(r.id)}`, title: "Диалоги прогона, где критерий нарушен" }] : []),
    { label: "Второй судья", value: second.checked ? <>согласен в <Count n={second.agree} of={second.checked} /></> : "не проверял", to: disputed ? review$("disputed") : undefined, title: disputed ? "Открыть вердикты, где судьи расходятся" : undefined },
    { label: "Люди", value: humans.checked ? <>верно <span className="font-mono">{humans.agree}</span> · неверно <span className="font-mono">{humans.checked - humans.agree}</span></> : "ещё не проверяли", to: review$("unchecked"), title: "Проверить вердикты этого критерия" },
  ];
  return (
    <article className="min-h-0 overflow-auto" aria-label={r.title}>
      {onBack && (
        <button type="button" onClick={onBack} className="sticky top-0 z-10 flex h-11 w-full items-center gap-1.5 border-b border-line bg-canvas px-3 text-body text-fg-2 lg:hidden">
          <ArrowLeft aria-hidden className="size-4" />Нарушения
        </button>
      )}
      <div className="max-w-4xl px-4 pb-16 pt-5 lg:px-10 lg:pt-7">
        <div className="flex items-start gap-5">
          <h2 className="min-w-0 flex-1 text-balance text-title font-semibold text-fg">{r.title}</h2>
          <div className="hidden flex-shrink-0 items-center gap-1 sm:flex">
            <Button icon={Play} onClick={() => document.getElementById("reproduce")?.scrollIntoView({ behavior: "smooth", block: "start" })}>Воспроизвести</Button>
            <Button variant="ghost" icon={Copy} aria-label="Скопировать разбор" kbd="C" onClick={copy} />
            <Button variant="ghost" icon={MessageSquare} aria-label="Спросить ассистента об этом нарушении" onClick={() => shell.openAsk(example?.traceId ?? null)} />
          </div>
        </div>
        {r.topics.length > 0 && <p className="mt-1.5 text-small text-fg-3">{r.topics.join(" · ")}</p>}
        <div className="mt-5"><Facts facts={facts} /></div>
        <div className="mt-6">
          <CodeQuote r={r} n={c.n} lit={lit} onLit={setLit} onOpen={r.rule.sourceId ? () => setSource(true) : undefined} />
        </div>
        <div className="mt-7">
          <Evidence list={list} at={now} onAt={onAt} side={side} onSide={onSide} counts={{ log: violationsOf(c, "log").length, sim: violationsOf(c, "sim").length }} lit={lit} onLit={setLit} onDecide={decide} />
        </div>
        {s.unknown > 0 && (
          <section className="mt-7" aria-label="Не известно">
            <Label>Не известно</Label>
            <p className="mt-2 max-w-[62ch] text-body text-fg-2">
              В {s.unknown} {plural(s.unknown, "диалоге", "диалогах", "диалогах")} этих тем критерий не проверен: судья не нашёл доказательств ни выполнения, ни нарушения. В счёт «{s.failed} из {checked(s)}» они не входят.
            </p>
          </section>
        )}
        {side === "log" && <div className="mt-7"><Reproduce r={r} /></div>}
      </div>
      <SourceSheet open={source} onClose={() => setSource(false)} sourceId={r.rule.sourceId} origin={r.rule.origin} quote={r.rule.quote} />
    </article>
  );
}
