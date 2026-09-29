import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Copy, Play, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../api";
import { compareFindings, deriveFindings, type Change } from "../findings";
import { plural } from "../format";
import { disputed, personaOf, typesOfRun } from "../logic";
import { personaName } from "../look";
import { findingReport } from "../report";
import { useToast } from "../toast";
import type { LabRun, LabState } from "../types";
import { useRunContext } from "../useRunContext";
import { Badge, Bubble, Button, Chip, EmptyState, Eyebrow, Page, Panel, PersonaTag, Quote, Skeleton } from "../ui";
import { FindingRow } from "./FindingRow";
import { AgentMessage } from "./RunView";
import { splitQuote } from "../findings";

const FILTERS: { id: "all" | Change; label: string }[] = [{ id: "all", label: "Все" }, { id: "new", label: "Новые" }, { id: "remains", label: "Остались" }, { id: "fixed", label: "Исправлено" }];

/** All findings of the latest check, with what changed since the previous one. */
export function FindingsView({ state, run, onFinding }: { state: LabState; run: LabRun | null; onFinding: (key: string) => void }) {
  const { finished, previous, previousItems } = useRunContext(state, run);
  const items = useMemo(() => finished?.items ?? [], [finished]);
  const compared = useMemo(() => compareFindings(deriveFindings(items), previousItems ? deriveFindings(previousItems) : null), [items, previousItems]);
  const [filter, setFilter] = useState<"all" | Change>("all");
  const played = finished ? typesOfRun(finished, state.personas).length : 0;
  const count = (c: Change) => compared.filter(x => x.change === c).length;
  const shown = compared.filter(c => filter === "all" || c.change === filter);
  return (
    <Page wide title="находки" lede="Правила, которые агент нарушает в разговорах, сгруппированные по смыслу. Откройте находку, чтобы увидеть разговоры и цитату, за которую судья поставил провал.">
      {!state.runs.length ? (
        <EmptyState className="mt-5" drop title="Находок пока нет">Они появятся после первой проверки агента.</EmptyState>
      ) : !finished ? (
        <Skeleton className="mt-5 h-[300px]" />
      ) : (
        <>
          <div className="mt-5 flex flex-wrap gap-1.5">
            {FILTERS.filter(f => f.id === "all" || previous).map(f => (
              <Chip key={f.id} on={filter === f.id} onClick={() => setFilter(f.id)} count={f.id === "all" ? compared.length : count(f.id)}>{f.label}</Chip>
            ))}
          </div>
          {shown.length ? (
            <Panel className="mt-3 overflow-hidden">
              {shown.map(c => <FindingRow key={c.finding.key + c.change} item={c} personas={state.personas} played={played} previousVersion={previous?.version} onOpen={() => onFinding(c.finding.key)} />)}
            </Panel>
          ) : <EmptyState className="mt-3" title="Здесь пусто">Под этот фильтр находок нет.</EmptyState>}
        </>
      )}
    </Page>
  );
}

/** One finding: its conversations, the one on screen with the judge's quote marked, why it happens, what to do. */
export function FindingView({ state, run, findingKey, onBack, go }: { state: LabState; run: LabRun | null; findingKey: string; onBack: () => void; go: (to: string) => void }) {
  const { error } = useToast();
  const { finished, previous, previousItems } = useRunContext(state, run);
  const items = useMemo(() => finished?.items ?? [], [finished]);
  const finding = useMemo(() => deriveFindings(items).find(f => f.key === findingKey), [items, findingKey]);
  const change = useMemo(() => (finding ? compareFindings([finding], previousItems ? deriveFindings(previousItems) : null)[0]?.change : null), [finding, previousItems]);
  const [at, setAt] = useState(0);
  const [decided, setDecided] = useState<Record<number, "agree" | "disagree" | null>>({});
  const [copied, setCopied] = useState(false);
  useEffect(() => { setAt(0); }, [findingKey]);

  if (!finished) return <Page wide title="находка"><Skeleton className="mt-5 h-[400px]" /></Page>;
  if (!finding) {
    return (
      <Page wide title="находка" actions={<Button size="sm" icon={ArrowLeft} onClick={onBack}>Все находки</Button>}>
        <EmptyState className="mt-5" title="Такой находки уже нет">В этой проверке правило не нарушено. Возможно, её исправили.</EmptyState>
      </Page>
    );
  }

  const item = finding.items[Math.min(at, finding.items.length - 1)];
  const index = items.indexOf(item);
  const failRule = item.rules.find(r => r.status === "FAIL" && r.rule.trim().toLowerCase().replace(/\s+/g, " ") === finding.key) ?? item.rules.find(r => r.status === "FAIL");
  const quoteAt = item.conversation.findIndex(m => m.role === "agent" && splitQuote(m.text, failRule?.agentQuote));
  const decision = index in decided ? decided[index] : item.review ?? null;
  const review = (d: "agree" | "disagree") => {
    const next = decision === d ? null : d;
    setDecided(x => ({ ...x, [index]: next }));
    api("/api/review", { run: finished.id, index, decision: next }).catch(error);
  };

  const types = typesOfRun(finished, state.personas);
  const withSecond = finding.items.filter(i => i.second && ["PASS", "FAIL", "UNMEASURED"].includes(i.second.status));
  const secondAgree = withSecond.filter(i => !disputed(i)).length;
  const criterion = state.cards?.cards.flatMap(c => c.criteria).find(c => c.text.trim().toLowerCase().replace(/\s+/g, " ") === finding.key);
  const cardIds = [...new Set(finding.items.map(i => i.cardId))];
  const personaIds = [...new Set(finding.items.map(personaOf))];
  const check = () => api("/api/runs", { target: finished.target, cardIds, personas: personaIds, repeats: 1 }).then(() => go("/lab/runs")).catch(error);
  const copy = () => navigator.clipboard.writeText(findingReport(finding, state.personas, criterion?.quote)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(error);

  return (
    <Page
      wide title={finding.title}
      lede={<span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1"><span>Нарушено в <b className="text-lab-text">{finding.count} из {finding.measured}</b> разговоров</span>{change && <Badge hue={change === "new" ? "bad" : change === "fixed" ? "ok" : "mute"}>{change === "new" ? `новая в ${finished.version}` : change === "remains" ? `есть и в ${previous?.version}` : "исправлена"}</Badge>}{withSecond.length > 0 && <span>второй судья согласен в {secondAgree} из {withSecond.length}</span>}</span>}
      actions={<Button size="sm" icon={ArrowLeft} onClick={onBack}>Все находки</Button>}
    >
      {finding.rule !== finding.title && <div className="mt-4 text-[12px] text-lab-dim">Правило: <span className="text-lab-soft">{finding.rule}</span></div>}
      <div className={cn("grid items-start gap-4 min-[1100px]:grid-cols-[250px_minmax(0,1fr)_300px]", finding.rule !== finding.title ? "mt-3" : "mt-5")}>
        <Panel className="p-2">
          <Eyebrow className="px-2.5 py-2">{finding.count} {plural(finding.count, "разговор", "разговора", "разговоров")}</Eyebrow>
          {finding.items.map((it, k) => (
            <button key={k} onClick={() => setAt(k)} className={cn("block w-full rounded-lg border px-2.5 py-2 text-left transition-colors", k === at ? "border-white/15 bg-white/[0.08]" : "border-transparent hover:bg-white/[0.04]")}>
              <span className="line-clamp-2 block text-[12px] font-medium text-lab-text">{it.conversation[0]?.text}</span>
              <span className="mt-0.5 block text-[11px] text-lab-dim">{personaName(state.personas, it.persona)}{it.attempt && it.attempt > 1 ? ` · повтор ${it.attempt}` : ""}</span>
            </button>
          ))}
        </Panel>

        <Panel className="flex flex-col gap-3 p-5">
          <div className="flex flex-wrap items-center gap-2">
            {types.length > 1 && <PersonaTag personas={state.personas} id={item.persona} />}
            <span className="text-[12px] text-lab-mute">{item.name}</span>
            <Badge hue="bad">провален</Badge>
          </div>
          {quoteAt < 0 && failRule && (
            <div className="border-l-2 border-lab-bad py-0.5 pl-3 text-[12px] leading-snug text-[#f3cccc]"><b className="font-semibold">✗ Нарушено.</b> {failRule.reason}{failRule.agentQuote ? <> Цитата: «{failRule.agentQuote}»</> : null}</div>
          )}
          {item.conversation.map((m, k) => m.role === "customer"
            ? <div key={k} className="flex max-w-[80%] flex-col items-end gap-1 self-end"><Bubble>{m.text}</Bubble></div>
            : <AgentMessage key={k} m={m} mark={k === quoteAt ? { quote: failRule?.agentQuote, reason: failRule?.reason } : undefined} />)}
          <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
            <Button size="sm" variant={decision === "agree" ? "primary" : "secondary"} icon={Check} onClick={() => review("agree")}>Верно</Button>
            <Button size="sm" variant={decision === "disagree" ? "danger" : "secondary"} icon={X} onClick={() => review("disagree")}>Неверно, судья ошибся</Button>
            <span className="ml-auto flex items-center gap-1.5">
              <Button size="sm" variant="ghost" disabled={at === 0} onClick={() => setAt(a => a - 1)}>←</Button>
              <span className="font-mono text-[11px] text-lab-dim">{at + 1} / {finding.count}</span>
              <Button size="sm" variant="ghost" disabled={at >= finding.count - 1} onClick={() => setAt(a => a + 1)}>→</Button>
            </span>
          </div>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel className="p-4">
            <div className="text-[14px] font-medium text-lab-text">Почему так случается</div>
            <p className="mt-2 text-[12px] leading-relaxed text-lab-soft">
              Правило нарушено в {finding.count} из {finding.measured} разговоров{failRule?.reason ? <>. Судья пишет: «{failRule.reason}»</> : ""}
            </p>
            {types.length > 1 && (
              <>
                <Eyebrow className="mb-2 mt-4">по типам клиентов</Eyebrow>
                <div className="grid grid-cols-[92px_1fr_38px] items-center gap-x-2 gap-y-1.5 text-[11px]">
                  {types.map(t => {
                    const played = items.filter(i => personaOf(i) === t.id).length;
                    const hit = finding.byPersona[t.id] ?? 0;
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
          {criterion && (
            <Panel className="p-4">
              <div className="text-[14px] font-medium text-lab-text">Откуда правило</div>
              <Quote who="в промпте">«{criterion.quote}»</Quote>
            </Panel>
          )}
          <Panel className="p-4">
            <div className="text-[14px] font-medium text-lab-text">После правки</div>
            <p className="mt-1.5 text-[11px] leading-snug text-lab-dim">Агента правите вы сами. Когда поправите, перепроверьте только те {cardIds.length} {plural(cardIds.length, "сценарий", "сценария", "сценариев")}, где это случилось.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="primary" icon={Play} disabled={state.job.running} onClick={check}>Перепроверить эти сценарии</Button>
              <Button icon={copied ? Check : Copy} onClick={copy}>{copied ? "Скопировано" : "Скопировать описание"}</Button>
            </div>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
