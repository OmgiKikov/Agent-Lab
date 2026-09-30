import { useState, type ReactNode } from "react";
import { Check, CircleHelp, MousePointerClick, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { splitQuote } from "./findings";
import { count } from "./format";
import { disputed, personaOf } from "./logic";
import { HUE, RULE_TEXT, STATUS_TEXT, personaName, statusHue } from "./look";
import type { Item, LabState, Message, Rule, Status } from "./types";
import { Bubble, Label, StatusMark, ToolPill } from "./ui";

const secondsText = (s?: number) => (s === undefined ? "—" : String(s).replace(".", ","));

/** Who speaks, Raindrop's way: a mono label over the turn, with the facts of the turn after it. */
function Speaker({ who, children, right }: { who: string; children?: ReactNode; right?: boolean }) {
  return (
    <div className={cn("mb-1.5 flex items-center gap-2 text-caption text-lab-mute", right && "justify-end")}>
      <Label className={right ? "order-2" : undefined}>{who}</Label>
      {children && <span className={cn("min-w-0 truncate", right && "order-1")}>{children}</span>}
    </div>
  );
}

/** The customer's turn: Raindrop's teal bubble on the right. */
export function CustomerMessage({ m, pressed, note }: { m: Message; pressed?: boolean; note?: string }) {
  return (
    <div className="flex max-w-[82%] flex-col items-end self-end">
      <Speaker who="Клиент" right>{note}</Speaker>
      <Bubble>{m.text}</Bubble>
      {pressed && <div className="mt-1 inline-flex items-center gap-1 px-1 text-caption text-lab-mute"><MousePointerClick className="size-3" />нажал кнопку</div>}
    </div>
  );
}

/**
 * The agent's turn: plain text on the canvas, as in Workshop. `mark` is the judge's quote and why it matters:
 * the quote is drawn as a marker over the words, the reason is pinned right under them.
 */
export function AgentMessage({ m, mark }: { m: Message; mark?: { quote?: string; reason?: string; status?: string } }) {
  const [open, setOpen] = useState(false);
  const long = m.text.length > 700;
  const calls = (m.events ?? []).map(e => e.tool.replace("Система банка · ", "")).filter((t, k, all) => all.indexOf(t) === k);
  const parts = mark?.quote ? splitQuote(m.text, mark.quote) : null;
  const fail = mark?.status !== "PASS";
  return (
    <div className="flex max-w-[92%] flex-col items-start self-start">
      <Speaker who="Агент">
        {m.ok === false ? <span className="text-lab-warn">передал оператору · статус {m.status}</span> : `${secondsText(m.seconds)} с`}
      </Speaker>
      <div className="whitespace-pre-wrap text-reading text-lab-text" style={long && !open ? { maxHeight: 220, overflow: "hidden", maskImage: "linear-gradient(#000 70%, transparent)" } : undefined}>
        {parts ? <>{parts[0]}<mark className="lab-marker">{parts[1]}</mark>{parts[2]}</> : m.text}
      </div>
      {long && <button className="lab-focus mt-1 rounded-sm text-caption text-lab-soft underline decoration-white/20 underline-offset-4 hover:text-lab-ink" onClick={() => setOpen(v => !v)}>{open ? "Свернуть" : "Показать полностью"}</button>}
      {parts && mark?.reason && (
        <div className={cn("mt-2 flex max-w-full gap-2 rounded-md border px-3 py-2 text-body", fail ? "border-lab-bad/25 bg-lab-bad/[0.06]" : "border-lab-ok/20 bg-lab-ok/[0.05]")}>
          {fail ? <X className="mt-[3px] size-3.5 flex-shrink-0 text-lab-bad" strokeWidth={2.75} /> : <Check className="mt-[3px] size-3.5 flex-shrink-0 text-lab-ok" strokeWidth={2.75} />}
          <span className="text-lab-text"><b className="font-medium text-lab-ink">{fail ? "Нарушено." : "Выполнено."}</b> {mark.reason}</span>
        </div>
      )}
      {!!m.options?.length && <div className="mt-2 flex flex-wrap gap-1.5">{m.options.map(o => <span key={o} className="rounded-md border border-lab-edge px-2 py-0.5 text-caption text-lab-mute">{o}</span>)}</div>}
      {calls.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{calls.map(c => <ToolPill key={c} name={c} />)}</div>}
    </div>
  );
}

/** The judge's verdict on the whole dialogue: one line with a mark, and whether the second judge agrees. */
export function VerdictLine({ item }: { item: Item }) {
  const rules = item.rules;
  const failed = rules.filter(r => r.status === "FAIL");
  const lead: Rule | undefined = failed[0] ?? rules.find(r => r.status === "PASS");
  const second = item.second && ["PASS", "FAIL", "UNMEASURED"].includes(item.second.status) ? item.second : null;
  const split = disputed(item);
  const word = item.status === "FAIL" ? `Нарушение${failed.length > 1 ? ` · ${count(failed.length, "критерий", "критерия", "критериев")}` : ""}` : item.status === "PASS" ? "Без нарушений" : item.status === "RUNNING" ? "Диалог идёт" : "Нет данных";
  return (
    <section className="flex gap-3" aria-label="Вердикт судьи">
      <StatusMark status={item.status} size={22} loud />
      <div className="min-w-0 flex-1">
        <div className={cn("text-body font-medium", HUE[statusHue(item.status)].text)}>{word}</div>
        <div className="mt-0.5 text-reading text-lab-text">
          {item.status === "RUNNING" ? item.stage : lead?.reason ?? item.error ?? "Судья не нашёл в диалоге доказательств ни выполнения, ни нарушения."}
        </div>
        {second && (
          <div className={cn("mt-1.5 inline-flex items-center gap-1.5 text-caption", split ? "text-lab-warn" : "text-lab-mute")}>
            {split ? <CircleHelp className="size-3.5" /> : <Check className="size-3.5" strokeWidth={2.5} />}
            Второй судья {split ? `оценил иначе: ${STATUS_TEXT[second.status as Status]}` : "согласен"}
          </div>
        )}
      </div>
    </section>
  );
}

/** Every criterion the judge checked in the dialogue: violations first, each with the reason and the agent's words. */
export function RulesList({ rules }: { rules: Rule[] }) {
  const order: Record<string, number> = { FAIL: 0, PASS: 1, UNKNOWN: 2, NOT_APPLICABLE: 3 };
  const sorted = [...rules].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  if (!sorted.length) return null;
  return (
    <section aria-label="Критерии судьи">
      <Label className="mb-2">Что проверил судья · {sorted.length}</Label>
      <div className="divide-y divide-lab-line rounded-lg border border-lab-line">
        {sorted.map(r => (
          <div key={r.ruleId} className={cn("flex gap-3 px-4 py-3", r.status === "NOT_APPLICABLE" && "opacity-60")}>
            <span title={RULE_TEXT[r.status]} className="mt-px"><StatusMark status={r.status} size={18} loud={r.status === "FAIL"} /></span>
            <div className="min-w-0">
              <div className={cn("text-body", r.status === "FAIL" ? "text-lab-ink" : "text-lab-text")}>{r.rule}</div>
              <div className="mt-0.5 text-caption text-lab-mute">{r.reason}</div>
              {r.agentQuote && <blockquote className={cn("mt-1.5 border-l-2 pl-2.5 text-caption", r.status === "FAIL" ? "border-lab-bad/60 text-lab-soft" : "border-lab-strong text-lab-mute")}>«{r.agentQuote}»</blockquote>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The dialogue as it happened: the judge's verdict on top, the turns, the judge's quote marked in the agent's words,
 * then every criterion the judge checked. `focus` marks one criterion's quote instead of the first violation's.
 */
export function Conversation({ item, state, focus, compact }: { item: Item; state: LabState; focus?: Rule; compact?: boolean }) {
  const failed = item.rules.filter(r => r.status === "FAIL");
  const target = focus ?? failed[0];
  const markAt = target ? item.conversation.findIndex(m => m.role === "agent" && splitQuote(m.text, target.agentQuote)) : -1;
  const personaNote = (k: number, m: Message) => (k === 0 && (m.fromLog || m.rewritten)
    ? (m.fromLog ? "первая реплика из реального диалога" : `переписана под тип «${personaName(state.personas, personaOf(item))}»`)
    : undefined);
  return (
    <div className="message-arrive flex flex-col gap-7">
      {!compact && <VerdictLine item={item} />}
      <div className="flex flex-col gap-5">
        {item.conversation.map((m, k) => m.role === "customer"
          ? <CustomerMessage key={k} m={m} note={personaNote(k, m)} pressed={k > 0 && !!item.conversation[k - 1].options?.includes(m.text)} />
          : <AgentMessage key={k} m={m} mark={k === markAt && target ? { quote: target.agentQuote, reason: target.reason, status: target.status } : undefined} />)}
      </div>
      {!compact && <RulesList rules={item.rules} />}
    </div>
  );
}
