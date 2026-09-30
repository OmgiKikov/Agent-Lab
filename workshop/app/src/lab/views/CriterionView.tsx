import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, FileText, ListChecks, Play, Wrench, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../api";
import { AgentMessage, CustomerMessage } from "../Conversation";
import { normRule, sourceName, type Criterion, type Dialog } from "../criteria";
import { splitQuote } from "../findings";
import { cap, count } from "../format";
import { personaName } from "../look";
import { criterionReport } from "../report";
import { useToast } from "../toast";
import type { LabState, Rule } from "../types";
import type { Scope } from "../useScope";
import { Bubble, Button, EmptyState, IconButton, Kbd, Label, Meta, Page, PersonaIcon, Segmented, Skeleton, Verdict } from "../ui";

type Tab = "fail" | "pass";

const KIND_ICON: Record<string, LucideIcon> = { prompt: FileText, tools: Wrench, knowledge: BookOpen };
const KIND_FROM: Record<string, string> = { prompt: "Из промпта", tools: "Из инструментов", knowledge: "Из базы знаний" };

/** The file a criterion was read from: the discovery keeps the source id of every rule, the criterion keeps only its kind. */
function originPath(state: LabState, key: string): string | undefined {
  for (const t of state.discover?.topics ?? []) for (const r of t.rules) if (normRule(r.text) === key && r.sourceId) return state.sources.find(s => s.id === r.sourceId)?.origin;
}

/** A fact of the claim: a mono label, the value, and an optional bar of the share. */
function Fact({ label, children, share }: { label: string; children: ReactNode; share?: number }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <Label className="w-[112px] flex-shrink-0">{label}</Label>
      <span className="min-w-0 flex-1 text-body tabular-nums text-lab-text">{children}</span>
      {share !== undefined && <span className="h-1 w-16 flex-shrink-0 overflow-hidden rounded-sm bg-white/[0.07]"><span className="block h-full bg-lab-bad/80" style={{ width: `${100 * share}%` }} /></span>}
    </div>
  );
}

/** Same shape as the loaded screen. */
function Loading({ onBack, back }: { onBack: () => void; back: string }) {
  return (
    <Page crumb={{ label: back, onClick: onBack }} title="Критерий" full>
      <div className="mx-auto grid max-w-[1280px] gap-10 pt-8 lg:grid-cols-[380px_minmax(0,1fr)]">
        <div><Skeleton className="h-5 w-24" /><Skeleton className="mt-4 h-14" /><Skeleton className="mt-6 h-24" /><Skeleton className="mt-6 h-40" /></div>
        <Skeleton className="h-[520px]" />
      </div>
    </Page>
  );
}

/** One criterion, Raindrop's issue detail: the claim on the left (what, where from, how often), the evidence on the right (the dialogues). */
export function CriterionView({ state, scope, criterionKey, onBack, onTrace, go }: {
  state: LabState; scope: Scope; criterionKey: string; scopeBar?: ReactNode; onBack: () => void; onTrace: (id: string) => void; go: (to: string) => void;
}) {
  const entry = scope.criteria.find(c => c.key === criterionKey);
  const back = scope.finished ? `Версия ${scope.finished.version}` : "Версия";
  if (!scope.ready) return <Loading onBack={onBack} back={back} />;
  if (!entry) {
    return (
      <Page crumb={{ label: back, onClick: onBack }} title="Критерий">
        <EmptyState icon={ListChecks} title="Такого критерия нет" action={<Button onClick={onBack}>К версии</Button>}>
          {scope.finished ? `В версии ${scope.finished.version} он не встречается: он мог пропасть после смены версии, или адрес устарел.` : "Он не встречается в оценённых диалогах: адрес мог устареть."}
        </EmptyState>
      </Page>
    );
  }
  // Keyed, so that the picked tab, the dialogue and the local verdicts start over for the next criterion.
  return <Detail key={criterionKey} state={state} scope={scope} entry={entry} back={back} onBack={onBack} onTrace={onTrace} go={go} />;
}

function Detail({ state, scope, entry, back, onBack, onTrace, go }: { state: LabState; scope: Scope; entry: Criterion; back: string; onBack: () => void; onTrace: (id: string) => void; go: (to: string) => void }) {
  const { error } = useToast();
  const c = entry;
  const [picked, setPicked] = useState<Tab | null>(null);
  const [at, setAt] = useState(0);
  const [decided, setDecided] = useState<Record<string, "agree" | "disagree" | null>>({});
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const tab: Tab = picked ?? (c.failing.length ? "fail" : "pass");
  const list = tab === "fail" ? c.failing : c.passing;
  const cur = Math.min(at, Math.max(0, list.length - 1));
  const dialog: Dialog | undefined = list[cur];
  const pick = (t: Tab) => { setPicked(t); setAt(0); };

  const ruleOf = (d: Dialog): Rule | undefined => d.rules.find(r => normRule(r.rule) === c.key && r.status === (tab === "fail" ? "FAIL" : "PASS")) ?? d.rules.find(r => normRule(r.rule) === c.key);
  const rule = dialog ? ruleOf(dialog) : undefined;
  const item = dialog?.item;
  const runItems = scope.finished?.items ?? [];
  const index = item ? runItems.indexOf(item) : -1;
  const quoteAt = item ? item.conversation.findIndex(m => m.role === "agent" && splitQuote(m.text, rule?.agentQuote)) : -1;
  const decision = dialog ? (dialog.key in decided ? decided[dialog.key] : item?.review ?? null) : null;
  const review = (d: "agree" | "disagree") => {
    if (!dialog || index < 0 || !scope.finished) return;
    const next = decision === d ? null : d;
    setDecided(x => ({ ...x, [dialog.key]: next }));
    api("/api/review", { run: scope.finished.id, index, decision: next }).catch(error);
  };

  // ← / → and J / K walk the dialogues, 1 / 2 answer «is the judge right» (by key position, so the Russian layout works too).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable)) return;
      if (e.code === "Digit1" || e.code === "Digit2") { e.preventDefault(); review(e.code === "Digit1" ? "agree" : "disagree"); return; }
      const step = e.code === "ArrowRight" || e.code === "KeyJ" ? 1 : e.code === "ArrowLeft" || e.code === "KeyK" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      setAt(a => Math.max(0, Math.min(list.length - 1, Math.min(a, list.length - 1) + step)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const simFailing = c.failing.filter(d => d.item);
  const cardIds = [...new Set(simFailing.map(d => d.item!.cardId))];
  const personaIds = [...new Set(simFailing.map(d => d.persona ?? "default"))];
  const recheck = () => {
    setBusy(true);
    api("/api/runs", { target: scope.finished!.target, cardIds, personas: personaIds, repeats: 1 }).then(() => go("/lab/overview")).catch(error).finally(() => setBusy(false));
  };
  const copy = () => navigator.clipboard.writeText(criterionReport(c, state.personas)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(error);

  const { sim, log } = c.by;
  const nSim = sim.failed + sim.passed, nLog = log.failed + log.passed;
  const was = scope.previousCriteria.get(c.key)?.by.sim;
  const chip = c.failed > 0 ? { text: "нарушается", hue: "bad" as const } : { text: "выполняется", hue: "mute" as const };

  const byType = state.personas
    .map(p => {
      const failed = c.failing.filter(d => d.origin === "sim" && d.persona === p.id).length;
      return { p, failed, total: failed + c.passing.filter(d => d.origin === "sim" && d.persona === p.id).length };
    })
    .filter(t => t.total > 0);
  const past = scope.history(c.key);
  const bars = past.map(v => (v === null ? null : 100 - v));
  const KindIcon = KIND_ICON[c.kind ?? ""] ?? FileText;
  const path = originPath(state, c.key);

  const opener = dialog && (item
    ? <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => go(`/lab/dialogs/${encodeURIComponent(dialog.key)}`)}>Весь диалог</Button>
    : dialog.traceId
      ? <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => onTrace(dialog.traceId!)}>Весь диалог</Button>
      : null);

  return (
    <Page
      crumb={{ label: back, onClick: onBack }} title={c.title} full
      actions={<Button size="sm" variant="ghost" icon={copied ? Check : Copy} collapse onClick={copy}>{copied ? "Скопировано" : "Копировать"}</Button>}
      primary={cardIds.length > 0 && scope.finished
        ? <Button variant="primary" icon={Play} loading={busy} collapse disabled={state.job.running} title={state.job.running ? "Сейчас идёт другая работа" : "Поправили агента? Перепроверьте только эти сценарии"} onClick={recheck}>Перепроверить {count(cardIds.length, "сценарий", "сценария", "сценариев")}</Button>
        : undefined}
    >
      <div className="mx-auto grid max-w-[1280px] gap-x-12 gap-y-10 pt-8 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* The claim */}
        <aside className="min-w-0 lg:sticky lg:top-[76px] lg:self-start">
          <Verdict hue={chip.hue}>{chip.text}</Verdict>
          <h2 className="mt-3 text-balance text-title font-medium text-lab-ink">{c.title}</h2>

          {(c.quote || c.kind) && (
            <figure className="mt-6">
              <figcaption className="flex items-center gap-2">
                <KindIcon className="size-3.5 text-lab-mute" />
                <Label>{KIND_FROM[c.kind ?? ""] ?? "Из источника агента"}</Label>
              </figcaption>
              {c.quote && <blockquote className="mt-2 border-l-2 border-lab-strong pl-3 text-pretty text-reading text-lab-ink">«{c.quote}»</blockquote>}
              {path && <div className="mt-2 truncate font-mono text-micro text-lab-faint" title={path}>{path}</div>}
            </figure>
          )}

          <div className="mt-6 divide-y divide-lab-line border-y border-lab-line">
            {nSim > 0 && <Fact label="Симулятор" share={sim.failed / nSim}>{sim.failed ? <>нарушен в <b className="font-medium text-lab-ink">{sim.failed}</b> из {nSim}</> : <>не нарушен ни в одном из {nSim}</>}</Fact>}
            {nLog > 0 && <Fact label="Реальные" share={log.failed / nLog}>{log.failed ? <>нарушен в <b className="font-medium text-lab-ink">{log.failed}</b> из {nLog}</> : <>не нарушен ни в одном из {nLog}</>}</Fact>}
            {scope.previous && was && was.failed + was.passed > 0 && <Fact label={`В ${scope.previous.version}`}>нарушен в {was.failed} из {was.failed + was.passed}</Fact>}
          </div>

          {bars.filter(v => v !== null).length > 1 && (
            <div className="mt-6">
              <Label>Нарушения по версиям</Label>
              <div className="mt-3 flex items-end gap-4">
                {bars.map((v, i) => (
                  <div key={scope.versions[i] ?? i} className="flex flex-col items-center gap-1.5" title={v === null ? `В ${scope.versions[i]} не проверялся` : `В ${scope.versions[i]}: нарушен в ${v}% диалогов`}>
                    <span className={cn("font-mono text-micro tabular-nums", i === bars.length - 1 ? "text-lab-ink" : "text-lab-mute")}>{v === null ? "—" : `${v}%`}</span>
                    <span className="flex h-10 items-end" aria-hidden>
                      <span className={cn("w-3 rounded-[1px]", v === null ? "bg-white/[0.06]" : i === bars.length - 1 ? (v > 0 ? "bg-lab-bad" : "bg-lab-mute") : "bg-white/25")} style={{ height: v === null ? 2 : Math.max(2, Math.round((40 * v) / 100)) }} />
                    </span>
                    <span className={cn("font-mono text-micro tabular-nums", i === bars.length - 1 ? "text-lab-ink" : "text-lab-mute")}>{scope.versions[i]}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {byType.length > 1 && (
            <div className="mt-6">
              <Label>По типам клиентов</Label>
              <div className="mt-2 space-y-1.5">
                {byType.map(t => (
                  <div key={t.p.id} className="flex items-center gap-2.5 text-body" title={t.p.note}>
                    <PersonaIcon id={t.p.id} size={20} />
                    <span className="min-w-0 flex-1 truncate text-lab-text">{t.p.name}</span>
                    <span className="tabular-nums text-lab-mute"><b className={cn("font-medium", t.failed ? "text-lab-ink" : "text-lab-soft")}>{t.failed}</b> из {t.total}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* The evidence */}
        <section className="min-w-0" aria-label="Диалоги">
          <div className="flex flex-wrap items-center gap-3">
            <Segmented value={tab} onChange={pick} options={[
              { value: "fail", label: <>Нарушено <span className="tabular-nums text-lab-mute">{c.failing.length}</span></> },
              { value: "pass", label: <>Выполнено <span className="tabular-nums text-lab-mute">{c.passing.length}</span></> },
            ]} />
            {list.length > 0 && (
              <span className="ml-auto flex items-center gap-1">
                <span className="mr-1 hidden items-center gap-1 xl:inline-flex"><Kbd>←</Kbd><Kbd>→</Kbd></span>
                <IconButton icon={ChevronLeft} label="Предыдущий диалог" className="size-7" disabled={cur === 0} onClick={() => setAt(cur - 1)} />
                <span className="min-w-[56px] text-center font-mono text-micro tabular-nums text-lab-mute">{cur + 1} из {list.length}</span>
                <IconButton icon={ChevronRight} label="Следующий диалог" className="size-7" disabled={cur >= list.length - 1} onClick={() => setAt(cur + 1)} />
              </span>
            )}
          </div>

          {!dialog ? (
            <EmptyState icon={ListChecks} title={tab === "fail" ? "Нарушений нет" : "Выполнений нет"}
              action={(tab === "fail" ? c.passing : c.failing).length > 0 && <Button onClick={() => pick(tab === "fail" ? "pass" : "fail")}>{tab === "fail" ? `Показать выполненные · ${c.passing.length}` : `Показать нарушения · ${c.failing.length}`}</Button>}>
              {tab === "fail" ? "В оценённых диалогах критерий не нарушен." : "Ни в одном оценённом диалоге критерий не подтверждён."}
            </EmptyState>
          ) : (
            <div className="mt-4 overflow-hidden rounded-lg border border-lab-line bg-lab-panel">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-lab-line px-5 py-3">
                <Meta label={cap(sourceName(dialog))}>{dialog.origin === "sim" && dialog.persona ? personaName(state.personas, dialog.persona) : dialog.label}</Meta>
                {dialog.origin === "sim" && <span className="min-w-0 flex-1 truncate text-body text-lab-soft" title={dialog.label}>{dialog.label}</span>}
                {dialog.origin !== "sim" && <span className="flex-1" />}
                {opener}
              </div>
              <div className="flex flex-col gap-5 px-5 py-6">
                {item ? (
                  <>
                    {item.conversation.map((m, k) => m.role === "customer"
                      ? <CustomerMessage key={k} m={m} />
                      : <AgentMessage key={k} m={m} mark={k === quoteAt ? { quote: rule?.agentQuote, reason: rule?.reason, status: rule?.status } : undefined} />)}
                    {rule && quoteAt < 0 && (
                      <div className={cn("flex gap-2 rounded-md border px-3 py-2 text-body", tab === "fail" ? "border-lab-bad/25 bg-lab-bad/[0.06]" : "border-lab-ok/20 bg-lab-ok/[0.05]")}>
                        {tab === "fail" ? <X className="mt-[3px] size-3.5 flex-shrink-0 text-lab-bad" strokeWidth={2.75} /> : <Check className="mt-[3px] size-3.5 flex-shrink-0 text-lab-ok" strokeWidth={2.75} />}
                        <span className="text-lab-text">{rule.reason}{tab === "fail" && rule.agentQuote ? <> Агент: «{rule.agentQuote}»</> : null}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="flex max-w-[82%] flex-col items-end self-end"><Label className="mb-1.5">Клиент</Label><Bubble>{dialog.opening}</Bubble></div>
                    {rule?.agentQuote && (
                      <div className="self-start"><Label className="mb-1.5">Агент</Label><div className="text-reading text-lab-text"><mark className="lab-marker">{rule.agentQuote}</mark></div></div>
                    )}
                    {rule?.reason && (
                      <div className={cn("flex gap-2 self-start rounded-md border px-3 py-2 text-body", tab === "fail" ? "border-lab-bad/25 bg-lab-bad/[0.06]" : "border-lab-ok/20 bg-lab-ok/[0.05]")}>
                        {tab === "fail" ? <X className="mt-[3px] size-3.5 flex-shrink-0 text-lab-bad" strokeWidth={2.75} /> : <Check className="mt-[3px] size-3.5 flex-shrink-0 text-lab-ok" strokeWidth={2.75} />}
                        <span className="text-lab-text">{rule.reason}</span>
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-lab-line px-5 py-3">
                {item && index >= 0 ? (
                  <>
                    <span className="mr-1 text-body text-lab-mute">Судья прав?</span>
                    <Button size="sm" icon={Check} kbd="1" aria-pressed={decision === "agree"} onClick={() => review("agree")}
                      className={cn(decision === "agree" && "border-lab-ok/30 bg-lab-ok/10 text-lab-ok hover:bg-lab-ok/15")}>Верно</Button>
                    <Button size="sm" icon={X} kbd="2" aria-pressed={decision === "disagree"} onClick={() => review("disagree")}
                      className={cn(decision === "disagree" && "border-lab-bad/30 bg-lab-bad/10 text-lab-bad hover:bg-lab-bad/15")}>Неверно</Button>
                  </>
                ) : <span className="text-caption text-lab-mute">Вердикты по реальным диалогам пока не сверяются с человеком.</span>}
              </div>
            </div>
          )}
        </section>
      </div>
    </Page>
  );
}
