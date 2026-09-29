import { useEffect, useState } from "react";
import { ArrowLeft, Check, Copy, ExternalLink, Play, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../api";
import { KIND_LABEL, normRule, rate, type Dialog, type Tally } from "../criteria";
import { splitQuote } from "../findings";
import { plural } from "../format";
import { disputed } from "../logic";
import { personaName } from "../look";
import { criterionReport } from "../report";
import { useToast } from "../toast";
import type { LabState, Rule } from "../types";
import type { Scope } from "../useScope";
import { Badge, Bubble, Button, Chip, EmptyState, Eyebrow, Page, Panel, PersonaTag, Quote, Skeleton } from "../ui";
import { AgentMessage } from "./RunView";

const CHANGE: Record<string, { hue: "bad" | "ok" | "mute"; text: (v?: string) => string }> = {
  new: { hue: "bad", text: v => `новое в ${v}` }, remains: { hue: "mute", text: v => `есть и в ${v}` }, fixed: { hue: "ok", text: () => "исправлено" },
};

const share = (t: Tally) => { const r = rate(t); return r === null ? "—" : `${Math.round(100 * r)}%`; };

/** One criterion: how it does, and the dialogues that show it — with the judge's quote marked in the agent's answer. */
export function CriterionView({ state, scope, criterionKey, scopeBar, onBack, onTrace, go }: {
  state: LabState; scope: Scope; criterionKey: string; scopeBar: React.ReactNode; onBack: () => void; onTrace: (id: string) => void; go: (to: string) => void;
}) {
  const { error } = useToast();
  const entry = scope.compared.find(c => c.criterion.key === criterionKey);
  const c = entry?.criterion;
  const [tab, setTab] = useState<"fail" | "pass">("fail");
  const [at, setAt] = useState(0);
  const [decided, setDecided] = useState<Record<string, "agree" | "disagree" | null>>({});
  const [copied, setCopied] = useState(false);
  useEffect(() => { setAt(0); setTab("fail"); }, [criterionKey]);
  useEffect(() => { setAt(0); }, [tab]);

  const back = <Button size="sm" icon={ArrowLeft} onClick={onBack}>Все критерии</Button>;
  if (!scope.ready) return <Page wide title="критерий" nav={scopeBar}><Skeleton className="mt-5 h-[400px]" /></Page>;
  if (!c || !entry) {
    return <Page wide title="критерий" nav={scopeBar} actions={back}><EmptyState className="mt-5" title="Такого критерия в этой выборке нет">Возможно, выбран другой источник или версия. Переключите их наверху.</EmptyState></Page>;
  }

  const list = tab === "fail" ? c.failing : c.passing;
  const dialog: Dialog | undefined = list[Math.min(at, list.length - 1)];
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
  const check = () => api("/api/runs", { target: scope.finished!.target, cardIds, personas: personaIds, repeats: 1 }).then(() => go("/lab/dialogs")).catch(error);
  const copy = () => navigator.clipboard.writeText(criterionReport(c, state.personas)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(error);

  const withSecond = simFailing.filter(d => d.item!.second && ["PASS", "FAIL", "UNMEASURED"].includes(d.item!.second!.status));
  const secondAgree = withSecond.filter(d => !disputed(d.item!)).length;
  const types = state.personas.filter(p => scope.dialogs.some(d => d.origin === "sim" && d.persona === p.id));
  const total = c.passed + c.failed;
  const ch = entry.change ? CHANGE[entry.change] : null;
  const sourceName = (d: Dialog) => d.origin === "log" ? "лог" : "симулятор";

  return (
    <Page
      wide title={c.title} nav={scopeBar} actions={back}
      lede={
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          {total ? <span>Нарушено в <b className="text-lab-text">{c.failed} из {total}</b> диалогов</span> : <span>Сейчас нигде не нарушено</span>}
          {c.by.log.passed + c.by.log.failed > 0 && c.by.sim.passed + c.by.sim.failed > 0 && <span>логи {share(c.by.log)} · симулятор {share(c.by.sim)} выполняется</span>}
          {ch && <Badge hue={ch.hue}>{ch.text(entry.change === "remains" ? scope.previous?.version : scope.finished?.version)}</Badge>}
          {withSecond.length > 0 && <span>второй судья согласен в {secondAgree} из {withSecond.length}</span>}
        </span>
      }
    >
      {c.rule !== c.title && <div className="mt-4 text-[12px] text-lab-dim">Критерий: <span className="text-lab-soft">{c.rule}</span></div>}
      <div className="mt-3 flex gap-1.5">
        <Chip on={tab === "fail"} onClick={() => setTab("fail")} count={c.failing.length}>Нарушения</Chip>
        <Chip on={tab === "pass"} onClick={() => setTab("pass")} count={c.passing.length}>Выполнено</Chip>
      </div>

      {!dialog ? (
        <EmptyState className="mt-3" title={tab === "fail" ? "Нарушений нет" : "Выполнений нет"}>{tab === "fail" ? "В выбранных диалогах критерий не нарушен." : "В выбранных диалогах критерий не подтверждён."}</EmptyState>
      ) : (
        <div className="mt-3 grid items-start gap-4 min-[1100px]:grid-cols-[250px_minmax(0,1fr)_300px]">
          <Panel className="max-h-[640px] overflow-auto p-2 sb">
            <Eyebrow className="px-2.5 py-2">{list.length} {plural(list.length, "диалог", "диалога", "диалогов")}</Eyebrow>
            {list.map((d, k) => (
              <button key={d.key} onClick={() => setAt(k)} className={cn("block w-full rounded-lg border px-2.5 py-2 text-left transition-colors", k === at ? "border-white/15 bg-white/[0.08]" : "border-transparent hover:bg-white/[0.04]")}>
                <span className="line-clamp-2 block text-[12px] font-medium text-lab-text">{d.opening}</span>
                <span className="mt-0.5 block text-[11px] text-lab-dim">{sourceName(d)}{d.origin === "sim" && d.persona ? ` · ${personaName(state.personas, d.persona)}` : d.label ? ` · ${d.label}` : ""}</span>
              </button>
            ))}
          </Panel>

          <Panel className="flex flex-col gap-3 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{sourceName(dialog)}</Badge>
              {dialog.origin === "sim" && types.length > 1 && <PersonaTag personas={state.personas} id={dialog.persona} />}
              <span className="text-[12px] text-lab-mute">{dialog.label}</span>
              <Badge hue={tab === "fail" ? "bad" : "ok"}>{tab === "fail" ? "нарушено" : "выполнено"}</Badge>
            </div>
            {item ? (
              <>
                {quoteAt < 0 && rule && tab === "fail" && (
                  <div className="border-l-2 border-lab-bad py-0.5 pl-3 text-[12px] leading-snug text-[#f3cccc]"><b className="font-semibold">✗ Нарушено.</b> {rule.reason}{rule.agentQuote ? <> Цитата: «{rule.agentQuote}»</> : null}</div>
                )}
                {item.conversation.map((m, k) => m.role === "customer"
                  ? <div key={k} className="flex max-w-[80%] flex-col items-end gap-1 self-end"><Bubble>{m.text}</Bubble></div>
                  : <AgentMessage key={k} m={m} mark={tab === "fail" && k === quoteAt ? { quote: rule?.agentQuote, reason: rule?.reason } : undefined} />)}
              </>
            ) : (
              <div className="space-y-3">
                <div className="flex max-w-[80%] flex-col items-end gap-1 self-end"><Bubble>{dialog.opening}</Bubble></div>
                {rule?.agentQuote && <Quote who="агент" tone={tab === "fail" ? "bad" : "ok"}>«{rule.agentQuote}»</Quote>}
                {rule?.reason && <p className="text-[13px] leading-relaxed text-lab-soft">{rule.reason}</p>}
                {dialog.traceId
                  ? <Button size="sm" icon={ExternalLink} onClick={() => onTrace(dialog.traceId!)}>Открыть весь разговор</Button>
                  : <p className="text-[11px] text-lab-dim">Полный разговор из лога не сохранён в Workshop.</p>}
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
              {item && index >= 0 ? (
                <>
                  <Button size="sm" variant={decision === "agree" ? "primary" : "secondary"} icon={Check} onClick={() => review("agree")}>Верно</Button>
                  <Button size="sm" variant={decision === "disagree" ? "danger" : "secondary"} icon={X} onClick={() => review("disagree")}>Неверно, судья ошибся</Button>
                </>
              ) : <span className="text-[11px] text-lab-dim">Вердикты логов проверяются на экране «Судья», когда там появится очередь для них.</span>}
              <span className="ml-auto flex items-center gap-1.5">
                <Button size="sm" variant="ghost" disabled={at === 0} onClick={() => setAt(a => a - 1)}>←</Button>
                <span className="font-mono text-[11px] text-lab-dim">{at + 1} / {list.length}</span>
                <Button size="sm" variant="ghost" disabled={at >= list.length - 1} onClick={() => setAt(a => a + 1)}>→</Button>
              </span>
            </div>
          </Panel>

          <div className="flex flex-col gap-4">
            <Panel className="p-4">
              <div className="text-[14px] font-medium text-lab-text">Почему так случается</div>
              <p className="mt-2 text-[12px] leading-relaxed text-lab-soft">{rule?.reason ? <>Судья пишет: «{rule.reason}»</> : `Критерий нарушен в ${c.failed} из ${total} диалогов.`}</p>
              <Eyebrow className="mb-2 mt-4">где проверено</Eyebrow>
              <div className="grid grid-cols-[92px_1fr_44px] items-center gap-x-2 gap-y-1.5 text-[11px]">
                {(["log", "sim"] as const).filter(o => c.by[o].passed + c.by[o].failed > 0).map(o => (
                  <div key={o} className="contents">
                    <span className="truncate text-lab-mute">{o === "log" ? "настоящие логи" : "симулятор"}</span>
                    <span className="h-1 overflow-hidden rounded-full bg-white/[0.07]"><span className="block h-full rounded-full bg-lab-bad" style={{ width: `${100 * (1 - (rate(c.by[o]) ?? 1))}%` }} /></span>
                    <span className="text-right font-mono text-lab-text">{c.by[o].failed}/{c.by[o].passed + c.by[o].failed}</span>
                  </div>
                ))}
              </div>
              {types.length > 1 && (
                <>
                  <Eyebrow className="mb-2 mt-4">по типам клиентов</Eyebrow>
                  <div className="grid grid-cols-[92px_1fr_38px] items-center gap-x-2 gap-y-1.5 text-[11px]">
                    {types.map(t => {
                      const played = scope.dialogs.filter(d => d.origin === "sim" && d.persona === t.id && (d.status === "PASS" || d.status === "FAIL")).length;
                      const hit = simFailing.filter(d => d.persona === t.id).length;
                      return (
                        <div key={t.id} className="contents">
                          <span className="truncate text-lab-mute">{t.name}</span>
                          <span className="h-1 overflow-hidden rounded-full bg-white/[0.07]"><span className="block h-full rounded-full bg-lab-bad" style={{ width: `${played ? (100 * hit) / played : 0}%` }} /></span>
                          <span className="text-right font-mono text-lab-text">{hit}/{played}</span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </Panel>
            {(c.quote || c.kind) && (
              <Panel className="p-4">
                <div className="text-[14px] font-medium text-lab-text">Откуда критерий</div>
                {c.quote && <Quote who={c.kind ? `в источнике: ${KIND_LABEL[c.kind] ?? c.kind}` : "в промпте"}>«{c.quote}»</Quote>}
              </Panel>
            )}
            <Panel className="p-4">
              <div className="text-[14px] font-medium text-lab-text">После правки</div>
              <p className="mt-1.5 text-[11px] leading-snug text-lab-dim">Агента правите вы сами.{cardIds.length ? <> Когда поправите, перепроверьте только те {cardIds.length} {plural(cardIds.length, "сценарий", "сценария", "сценариев")}, где это случилось.</> : " Когда поправите, прогоните симулятор и сравните версии."}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {cardIds.length > 0 && scope.finished && <Button variant="primary" icon={Play} disabled={state.job.running} onClick={check}>Перепроверить эти сценарии</Button>}
                <Button icon={copied ? Check : Copy} onClick={copy}>{copied ? "Скопировано" : "Скопировать описание"}</Button>
              </div>
            </Panel>
          </div>
        </div>
      )}
    </Page>
  );
}
