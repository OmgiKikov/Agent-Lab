import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, FileText, ListChecks, Play, Wrench, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../api";
import { normRule, type Compared, type Dialog } from "../criteria";
import { splitQuote } from "../findings";
import { cap, count, plural } from "../format";
import { disputed } from "../logic";
import { personaName } from "../look";
import { criterionReport } from "../report";
import { sourceName } from "../story";
import { useToast } from "../toast";
import type { LabState, Rule } from "../types";
import type { Scope } from "../useScope";
import { Badge, Bubble, Button, EmptyState, IconButton, Kbd, Page, Panel, PersonaIcon, PersonaTag, Quote, Section, Segmented, Skeleton } from "../ui";
import { AgentMessage } from "./RunView";

type Tab = "fail" | "pass";

const KIND_ICON: Record<string, LucideIcon> = { prompt: FileText, tools: Wrench, knowledge: BookOpen };
const KIND_FROM: Record<string, string> = { prompt: "Из промпта", tools: "Из инструментов", knowledge: "Из базы знаний" };
const CHANGE: Record<string, { hue: "bad" | "ok" | "mute"; text: (now?: string, before?: string) => string }> = {
  new: { hue: "bad", text: now => `новое в ${now}` }, remains: { hue: "mute", text: (_, before) => `есть и в ${before}` }, fixed: { hue: "ok", text: () => "исправлено" },
};

/** The file a criterion was read from: the discovery keeps the source id of every rule, the criterion keeps only its kind. */
function originPath(state: LabState, key: string): string | undefined {
  for (const t of state.discover?.topics ?? []) for (const r of t.rules) if (normRule(r.text) === key && r.sourceId) return state.sources.find(s => s.id === r.sourceId)?.origin;
}

/** Where the criterion comes from: the line of the agent's own source it was taken from. The main thing about it, so it is the loudest block after the title. */
function Origin({ quote, kind, path }: { quote?: string; kind?: string; path?: string }) {
  if (!quote && !kind) return null;
  const Icon = KIND_ICON[kind ?? ""] ?? FileText;
  return (
    <Panel className="mt-5 bg-lab-card px-5 py-4">
      <div className="flex items-center gap-2 text-caption font-medium text-lab-mute">
        <Icon className="size-3.5 flex-shrink-0" />
        <span className="flex-shrink-0">{KIND_FROM[kind ?? ""] ?? "Из источника агента"}</span>
        {path && <span className="ml-auto min-w-0 truncate font-mono font-normal" title={path}>{path}</span>}
      </div>
      {quote && <blockquote className="mt-2.5 border-l-2 border-lab-strong pl-3.5 text-pretty text-lead text-lab-ink">«{quote}»</blockquote>}
    </Panel>
  );
}

/** A share of violations as a thin bar, like in the criteria table. */
function ShareBar({ failed, total }: { failed: number; total: number }) {
  return <span className="block h-1.5 overflow-hidden rounded-full bg-white/[0.07]"><span className="block h-full rounded-full bg-lab-bad/70" style={{ width: `${total ? (100 * failed) / total : 0}%` }} /></span>;
}

/** Same shape as the loaded screen. */
function Loading({ onBack }: { onBack: () => void }) {
  return (
    <Page crumb={{ label: "Критерии", onClick: onBack }} title="Критерий">
      <Skeleton className="mt-8 h-14 w-3/4" />
      <Skeleton className="mt-5 h-[104px]" />
      <Skeleton className="mt-4 h-5 w-2/3" />
      <Skeleton className="mt-10 h-[420px]" />
    </Page>
  );
}

/** One criterion: where it comes from, how it does, and the dialogues that show it, with the judge's quote marked in the agent's answer. */
export function CriterionView({ state, scope, criterionKey, onBack, onTrace, go }: {
  state: LabState; scope: Scope; criterionKey: string; scopeBar?: ReactNode; onBack: () => void; onTrace: (id: string) => void; go: (to: string) => void;
}) {
  const entry = scope.compared.find(c => c.criterion.key === criterionKey);
  if (!scope.ready) return <Loading onBack={onBack} />;
  if (!entry) {
    return (
      <Page crumb={{ label: "Критерии", onClick: onBack }} title="Критерий">
        <EmptyState className="mt-10" icon={ListChecks} title="Такого критерия нет" action={<Button onClick={onBack}>Ко всем критериям</Button>}>
          {scope.finished ? `В версии ${scope.finished.version} он не встречается: он мог пропасть после смены версии, или адрес устарел.` : "Он не встречается в оценённых диалогах: адрес мог устареть."}
        </EmptyState>
      </Page>
    );
  }
  // Keyed, so that the picked tab, the dialogue and the local verdicts start over for the next criterion.
  return <Detail key={criterionKey} state={state} scope={scope} entry={entry} onBack={onBack} onTrace={onTrace} go={go} />;
}

function Detail({ state, scope, entry, onBack, onTrace, go }: { state: LabState; scope: Scope; entry: Compared; onBack: () => void; onTrace: (id: string) => void; go: (to: string) => void }) {
  const { error } = useToast();
  const c = entry.criterion;
  const [picked, setPicked] = useState<Tab | null>(null);
  const [at, setAt] = useState(0);
  const [decided, setDecided] = useState<Record<string, "agree" | "disagree" | null>>({});
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const tab: Tab = picked ?? (c.failing.length ? "fail" : "pass");
  const list = tab === "fail" ? c.failing : c.passing;
  const cur = Math.min(at, Math.max(0, list.length - 1));
  const dialog: Dialog | undefined = list[cur];
  const pick = (t: Tab) => { setPicked(t); setAt(0); };

  // ← / → and J / K walk the dialogues (by key position, so the Russian layout works too); typing in a field is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable)) return;
      const step = e.code === "ArrowRight" || e.code === "KeyJ" ? 1 : e.code === "ArrowLeft" || e.code === "KeyK" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      setAt(a => Math.max(0, Math.min(list.length - 1, Math.min(a, list.length - 1) + step)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list.length]);

  // Keep the chosen dialogue in view inside the list, without scrolling the page.
  useEffect(() => {
    const box = listRef.current;
    const el = box?.querySelector<HTMLElement>("[aria-current='true']");
    if (!box || !el) return;
    if (el.offsetTop < box.scrollTop + 8) box.scrollTop = el.offsetTop - 8;
    else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight - 8) box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight + 8;
  }, [cur, tab]);

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

  const simFailing = c.failing.filter(d => d.item);
  const cardIds = [...new Set(simFailing.map(d => d.item!.cardId))];
  const personaIds = [...new Set(simFailing.map(d => d.persona ?? "default"))];
  const recheck = () => {
    setBusy(true);
    api("/api/runs", { target: scope.finished!.target, cardIds, personas: personaIds, repeats: 1 }).then(() => go("/lab/dialogs")).catch(error).finally(() => setBusy(false));
  };
  const copy = () => navigator.clipboard.writeText(criterionReport(c, state.personas)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(error);

  // Facts: how often, where, what changed, how far the second judge agrees.
  const { sim, log } = c.by;
  const nSim = sim.failed + sim.passed, nLog = log.failed + log.passed;
  const withSecond = simFailing.filter(d => d.item!.second && ["PASS", "FAIL", "UNMEASURED"].includes(d.item!.second!.status));
  const secondAgree = withSecond.filter(d => !disputed(d.item!)).length;
  const ch = entry.change ? CHANGE[entry.change] : null;
  const num = (text: string) => <b className="font-semibold tabular-nums text-lab-ink">{text}</b>;
  const dialogs = (n: number) => plural(n, "диалога", "диалогов", "диалогов");
  const facts: ReactNode[] = [];
  if (nSim) facts.push(sim.failed ? <>Нарушен в {num(`${sim.failed} из ${nSim}`)} {dialogs(nSim)} симулятора</> : <>Не нарушен ни в одном из {num(String(nSim))} {dialogs(nSim)} симулятора</>);
  if (nLog) facts.push(nSim ? <>{num(`${log.failed} из ${nLog}`)} реальных</> : log.failed ? <>Нарушен в {num(`${log.failed} из ${nLog}`)} реальных {dialogs(nLog)}</> : <>Не нарушен ни в одном из {num(String(nLog))} реальных {dialogs(nLog)}</>);
  if (!nSim && !nLog) facts.push(entry.before ? `Было нарушено в ${count(entry.before, "диалоге", "диалогах", "диалогах")} версии ${scope.previous?.version}` : "Нигде не проверяется");
  if (ch) facts.push(<Badge hue={ch.hue}>{ch.text(scope.finished?.version, scope.previous?.version)}</Badge>);
  if (withSecond.length) facts.push(<>второй судья согласен в {num(`${secondAgree} из ${withSecond.length}`)}</>);

  // Customer types: how often the criterion is violated in the dialogues of each.
  const byType = state.personas
    .map(p => {
      const failed = c.failing.filter(d => d.origin === "sim" && d.persona === p.id).length;
      return { p, failed, total: failed + c.passing.filter(d => d.origin === "sim" && d.persona === p.id).length };
    })
    .filter(t => t.total > 0);
  const share = (t: { failed: number; total: number }) => t.failed / t.total;
  const worst = [...byType].sort((a, b) => share(b) - share(a))[0];
  const evenly = byType.length > 1 && byType.every(t => share(t) === share(byType[0]));
  const typesHint = !worst || !worst.failed ? "Ни у одного типа клиентов критерий не нарушен."
    : evenly ? "У всех типов клиентов примерно одинаково."
      : `Чаще всего у типа «${worst.p.name}»: ${worst.failed} из ${worst.total}.`;

  // Versions: the share of simulator dialogues that violate it, in each of the latest versions.
  const past = scope.history(c.key);
  const bars = scope.versions.map((v, i) => ({ v, share: past[i] == null ? null : 100 - past[i]!, now: v === scope.finished?.version }));
  const measured = bars.filter(b => b.share !== null).length;

  const tabs = (
    <Segmented value={tab} onChange={pick} options={[
      { value: "fail", label: <>Нарушено <span className="tabular-nums text-lab-mute">{c.failing.length}</span></> },
      { value: "pass", label: <>Выполнено <span className="tabular-nums text-lab-mute">{c.passing.length}</span></> },
    ]} />
  );
  const opener = dialog && (item
    ? <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => go(`/lab/dialogs/${encodeURIComponent(dialog.key)}`)}>Открыть весь диалог</Button>
    : dialog.traceId
      ? <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => onTrace(dialog.traceId!)}>Открыть весь диалог</Button>
      : <span className="text-caption text-lab-mute">Полный диалог не сохранён в Workshop</span>);
  const tone = tab === "fail" ? "bad" : "ok";

  return (
    <Page crumb={{ label: "Критерии", onClick: onBack }} title={c.title}>
      <h2 className="mt-8 max-w-[860px] text-balance text-title font-semibold text-lab-ink">{c.title}</h2>
      <Origin quote={c.quote} kind={c.kind} path={originPath(state, c.key)} />
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-body text-lab-text">
        {facts.map((f, i) => <span key={i} className="inline-flex items-center gap-3">{i > 0 && <span aria-hidden className="text-lab-faint">·</span>}<span>{f}</span></span>)}
      </div>

      <Section title="Диалоги" className="mt-8">
        {!dialog && (
          <Panel className="overflow-hidden">
            <div className="border-b border-lab-line p-3">{tabs}</div>
            <EmptyState
              className="rounded-none border-0 bg-transparent" icon={ListChecks} title={tab === "fail" ? "Нарушений нет" : "Выполнений нет"}
              action={(tab === "fail" ? c.passing : c.failing).length > 0 && <Button onClick={() => pick(tab === "fail" ? "pass" : "fail")}>{tab === "fail" ? `Показать выполненные · ${c.passing.length}` : `Показать нарушения · ${c.failing.length}`}</Button>}
            >
              {tab === "fail" ? "В оценённых диалогах критерий не нарушен." : "Ни в одном оценённом диалоге критерий не подтверждён."}
            </EmptyState>
          </Panel>
        )}
        {dialog && (
          <Panel className="overflow-hidden md:grid md:min-h-[360px] md:grid-cols-[280px_minmax(0,1fr)]">
            <div className="hidden min-h-0 flex-col border-r border-lab-line md:flex md:max-h-[640px]">
              <div className="border-b border-lab-line p-3">{tabs}</div>
              <div ref={listRef} className="relative min-h-0 flex-1 overflow-auto p-2">
                {list.map((d, k) => (
                  <button
                    key={d.key} onClick={() => setAt(k)} aria-current={k === cur ? "true" : undefined}
                    className={cn("lab-focus-inset block w-full rounded-lg px-3 py-2.5 text-left transition-colors duration-100", k === cur ? "bg-lab-active" : "hover:bg-lab-raised")}
                  >
                    <span className={cn("line-clamp-2 block text-body", k === cur ? "text-lab-ink" : "text-lab-text")} title={d.opening}>{d.opening}</span>
                    <span className="mt-0.5 block truncate text-caption text-lab-mute">{cap(sourceName(d))} · {d.origin === "sim" && d.persona ? personaName(state.personas, d.persona) : d.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex min-h-0 min-w-0 flex-col md:max-h-[640px]">
              <div className="border-b border-lab-line p-3 md:hidden">{tabs}</div>
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-lab-line px-5 py-3">
                <Badge>{cap(sourceName(dialog))}</Badge>
                {dialog.origin === "sim" && byType.length > 1 && <PersonaTag personas={state.personas} id={dialog.persona} />}
                {dialog.attempt && dialog.attempt > 1 ? <Badge>повтор {dialog.attempt}</Badge> : null}
                <span className="min-w-0 flex-1 truncate text-body text-lab-mute" title={dialog.label}>{dialog.label}</span>
                {opener}
              </div>

              <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
                <div className="flex flex-col gap-3">
                  {item ? (
                    <>
                      {item.conversation.map((m, k) => m.role === "customer"
                        ? <div key={k} className="flex max-w-[80%] flex-col items-end gap-1 self-end"><Bubble>{m.text}</Bubble></div>
                        : <AgentMessage key={k} m={m} mark={tab === "fail" && k === quoteAt ? { quote: rule?.agentQuote, reason: rule?.reason } : undefined} />)}
                      {rule && (tab === "pass" || quoteAt < 0) && (
                        <Quote who={tab === "fail" ? "Судья: нарушено" : "Судья: выполнено"} tone={tone}>{rule.reason}{tab === "fail" && rule.agentQuote ? <> Цитата агента: «{rule.agentQuote}»</> : null}</Quote>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="flex max-w-[80%] flex-col items-end gap-1 self-end"><Bubble>{dialog.opening}</Bubble></div>
                      {rule?.agentQuote && <Quote who="Агент" tone={tone}>«{rule.agentQuote}»</Quote>}
                      {rule?.reason && <div className="mt-1"><div className="text-caption font-medium text-lab-mute">Судья</div><p className="mt-0.5 max-w-[640px] text-pretty text-reading text-lab-text">{rule.reason}</p></div>}
                    </>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-lab-line px-5 py-3">
                {item && index >= 0 ? (
                  <>
                    <Button
                      size="sm" icon={Check} aria-pressed={decision === "agree"} onClick={() => review("agree")}
                      className={cn(decision === "agree" && "border-lab-ok/25 bg-lab-ok/10 text-lab-ok hover:border-lab-ok/30 hover:bg-lab-ok/15")}
                    >Судья прав</Button>
                    <Button
                      size="sm" icon={X} aria-pressed={decision === "disagree"} onClick={() => review("disagree")}
                      className={cn(decision === "disagree" && "border-lab-warn/25 bg-lab-warn/10 text-lab-warn hover:border-lab-warn/30 hover:bg-lab-warn/15")}
                    >Судья ошибся</Button>
                  </>
                ) : <span className="text-caption text-lab-mute">Вердикты по реальным диалогам пока нельзя сверить с человеком.</span>}
                <span className="ml-auto flex items-center gap-1">
                  <span className="mr-1 hidden items-center gap-1 lg:inline-flex"><Kbd>←</Kbd><Kbd>→</Kbd></span>
                  <IconButton icon={ChevronLeft} label="Предыдущий диалог" className="size-7" disabled={cur === 0} onClick={() => setAt(cur - 1)} />
                  <span className="min-w-[56px] text-center text-caption tabular-nums text-lab-mute">{cur + 1} из {list.length}</span>
                  <IconButton icon={ChevronRight} label="Следующий диалог" className="size-7" disabled={cur >= list.length - 1} onClick={() => setAt(cur + 1)} />
                </span>
              </div>
            </div>
          </Panel>
        )}
      </Section>

      {(byType.length > 1 || bars.length > 0) && (
        <div className={cn("mt-10 grid gap-x-6 gap-y-10", byType.length > 1 && bars.length > 0 && "lg:grid-cols-2")}>
          {byType.length > 1 && (
            <Section title="По типам клиентов" hint={typesHint} className="mt-0 flex flex-col [&>:last-child]:flex-1">
              <Panel className="px-5 py-4">
                <div className="grid grid-cols-[minmax(0,168px)_1fr_auto] items-center gap-x-4 gap-y-3">
                  {byType.map(t => (
                    <div key={t.p.id} className="contents">
                      <span className="flex min-w-0 items-center gap-2.5 text-body text-lab-text" title={t.p.note}><PersonaIcon id={t.p.id} size={24} /><span className="truncate">{t.p.name}</span></span>
                      <ShareBar failed={t.failed} total={t.total} />
                      <span className="w-[96px] text-right text-body tabular-nums text-lab-mute"><b className={cn("font-semibold", t.failed ? "text-lab-ink" : "text-lab-text")}>{t.failed}</b> из {t.total}</span>
                    </div>
                  ))}
                </div>
              </Panel>
            </Section>
          )}
          {bars.length > 0 && (
            <Section title="По версиям" hint="Доля диалогов симулятора, где критерий нарушен" className="mt-0 flex flex-col [&>:last-child]:flex-1">
              <Panel className="px-5 py-4">
                {measured > 1 ? (
                  <div className="flex items-end justify-around gap-2">
                    {bars.map(b => (
                      <div key={b.v} className="flex min-w-0 flex-1 flex-col items-center gap-1.5" title={b.share === null ? `В версии ${b.v} не проверялся` : `В версии ${b.v} нарушен в ${b.share}% диалогов симулятора`}>
                        <span className={cn("text-caption tabular-nums", b.now ? "font-semibold text-lab-ink" : "text-lab-mute")}>{b.share === null ? "—" : `${b.share}%`}</span>
                        <span className="flex h-20 w-full max-w-[44px] items-end overflow-hidden rounded-md bg-white/[0.07]">
                          {b.share ? <span className={cn("block w-full rounded-md", b.now ? "bg-lab-accent" : "bg-lab-mute/50")} style={{ height: `${Math.max(b.share, 4)}%` }} /> : null}
                        </span>
                        <span className={cn("max-w-full truncate text-caption tabular-nums", b.now ? "font-semibold text-lab-ink" : "text-lab-mute")}>{b.v}</span>
                      </div>
                    ))}
                  </div>
                ) : <p className="text-body text-lab-mute">Пока проверена одна версия. Поправьте агента и проверьте снова: здесь появится динамика.</p>}
              </Panel>
            </Section>
          )}
        </div>
      )}

      <Section title="После правки">
        <Panel className="flex flex-wrap items-center gap-x-6 gap-y-4 px-5 py-4">
          <p className="min-w-[240px] max-w-[560px] flex-1 text-pretty text-body text-lab-text">
            {cardIds.length
              ? <>Поправьте агента и перепроверьте {count(cardIds.length, "сценарий", "сценария", "сценариев")}, где критерий нарушался: остальные диалоги пересчитывать не нужно.</>
              : log.failed
                ? "Нарушения только в реальных диалогах: симулятор их не воспроизводит. Когда поправите агента, проверьте версию целиком."
                : "Сейчас критерий нигде не нарушен. Проверяйте версию целиком после правок агента."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {cardIds.length > 0 && scope.finished && (
              <Button variant="primary" icon={Play} loading={busy} disabled={state.job.running} title={state.job.running ? "Сейчас идёт другая работа: дождитесь её конца" : undefined} onClick={recheck}>
                Перепроверить {count(cardIds.length, "сценарий", "сценария", "сценариев")}
              </Button>
            )}
            <Button icon={copied ? Check : Copy} onClick={copy}>{copied ? "Скопировано" : "Скопировать описание"}</Button>
          </div>
        </Panel>
      </Section>
    </Page>
  );
}
