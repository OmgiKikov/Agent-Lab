import { useState } from "react";
import { MousePointerClick } from "lucide-react";
import { cn } from "@/lib/utils";
import { splitQuote } from "../findings";
import { plural } from "../format";
import { disputed, personaOf } from "../logic";
import { HUE, RULE_TEXT, STATUS_TEXT, statusHue } from "../look";
import type { Item, LabState, Message, Rule, Status } from "../types";
import { Bubble, Eyebrow, Panel, Quote, Row, StatusBadge, StatusMark, ToolPill } from "../ui";

type ConversationData = Pick<Item, "status" | "rules" | "conversation" | "error" | "second" | "persona"> & {
  stage?: string;
};

/** `mark`: the quote the judge cited and why it counts as a violation; drawn in the text and under it. */
export function AgentMessage({ m, mark }: { m: Message; mark?: { quote?: string; reason?: string } }) {
  const [open, setOpen] = useState(false);
  const long = m.text.length > 700;
  const calls = (m.events ?? [])
    .map((e) => e.tool.replace("Система банка · ", ""))
    .filter((t, k, all) => all.indexOf(t) === k);
  const parts = mark?.quote ? splitQuote(m.text, mark.quote) : null;
  return (
    <div className="flex max-w-[86%] flex-col items-start gap-1.5 self-start">
      <div className="rounded-2xl rounded-bl-md border border-white/[0.08] bg-lab-surface px-4 py-3 text-[13px] leading-relaxed text-lab-text">
        <div
          className="whitespace-pre-wrap"
          style={
            long && !open
              ? { maxHeight: 220, overflow: "hidden", maskImage: "linear-gradient(#000 70%, transparent)" }
              : undefined
          }
        >
          {parts ? (
            <>
              {parts[0]}
              <mark className="rounded-sm border-b-2 border-lab-bad bg-lab-bad/15 px-0.5 text-[#f6c9c9]">
                {parts[1]}
              </mark>
              {parts[2]}
            </>
          ) : (
            m.text
          )}
        </div>
        {long && (
          <button className="mt-1.5 text-[12px] text-lab-accent hover:underline" onClick={() => setOpen((v) => !v)}>
            {open ? "Свернуть" : "Показать полностью"}
          </button>
        )}
      </div>
      {parts && mark?.reason && (
        <div className="max-w-[92%] border-l-2 border-lab-bad py-0.5 pl-3 text-[12px] leading-snug text-[#f3cccc]">
          <b className="font-semibold">✗ Нарушено.</b> {mark.reason}
        </div>
      )}
      {!!m.options?.length && (
        <div className="flex flex-wrap gap-1.5">
          {m.options.map((o) => (
            <span key={o} className="rounded-full border border-white/[0.1] px-2.5 py-0.5 text-[12px] text-lab-mute">
              {o}
            </span>
          ))}
        </div>
      )}
      {calls.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {calls.map((c) => (
            <ToolPill key={c} name={c} />
          ))}
        </div>
      )}
      {(m.ok === false || m.seconds != null) && (
        <div className="px-1 text-[11px] text-lab-dim">
          {m.ok === false ? (
            <span className="text-lab-warn">Передал оператору · статус {m.status}</span>
          ) : (
            `Ответил за ${m.seconds} с`
          )}
        </div>
      )}
    </div>
  );
}

/** How long the agent took on each turn and what it called: the conversation's trajectory for one conversation. */
function Trajectory({ item }: { item: ConversationData }) {
  const turns = item.conversation
    .filter((m) => m.role === "agent")
    .map((m, i) => ({
      n: i + 1,
      seconds: m.seconds ?? 0,
      handoff: m.ok === false,
      tools: (m.events ?? [])
        .map((e) => e.tool.replace("Система банка · ", ""))
        .filter((t, k, all) => all.indexOf(t) === k),
    }));
  if (!turns.some((t) => t.seconds > 0) || (turns.length < 2 && !turns.some((t) => t.tools.length))) return null;
  const total = Math.round(turns.reduce((n, t) => n + t.seconds, 0) * 10) / 10;
  const slowest = Math.max(...turns.map((t) => t.seconds), 0.1);
  return (
    <Panel className="px-4 py-3">
      <div className="mb-2.5 flex items-center justify-between">
        <Eyebrow>Траектория</Eyebrow>
        <span className="font-mono text-[11px] text-lab-dim">
          {turns.length} {plural(turns.length, "ход", "хода", "ходов")} · {total} с
        </span>
      </div>
      <div className="space-y-1.5">
        {turns.map((t) => (
          <div key={t.n} className="grid grid-cols-[52px_1fr_auto] items-center gap-3 text-[11px]">
            <span className="font-mono text-lab-dim">ход {t.n}</span>
            <div className="flex items-center gap-2">
              <div
                className={cn("h-[18px] rounded-full", t.handoff ? "bg-lab-warn/70" : "bg-lab-mute/35")}
                style={{ width: `${Math.max(4, (100 * t.seconds) / slowest)}%`, maxWidth: "calc(100% - 44px)" }}
              />
              <span className="flex-shrink-0 font-mono text-lab-mute">{t.seconds} с</span>
            </div>
            <span className="max-w-[260px] truncate font-mono text-lab-dim" title={t.tools.join(", ")}>
              {t.handoff ? "передал оператору" : t.tools.join(", ")}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** The conversation as it happened; the judge's verdict on top and every criterion below. */
export function Conversation({ item, state }: { item: ConversationData; state: LabState }) {
  const order: Record<string, number> = { FAIL: 0, PASS: 1, UNKNOWN: 2, NOT_APPLICABLE: 3 };
  const rules = [...item.rules].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  const lead: Rule | undefined = rules.find((r) => r.status === "FAIL") ?? rules.find((r) => r.status === "PASS");
  const h = HUE[statusHue(item.status)];
  const second = item.second && ["PASS", "FAIL", "UNMEASURED"].includes(item.second.status) ? item.second : null;
  return (
    <div className="message-arrive mx-auto flex max-w-[880px] flex-col gap-7 px-6 py-6">
      <div className={cn("flex gap-4 rounded-lg border p-4", h.bg, h.border)}>
        <StatusMark status={item.status} size={30} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Eyebrow>Вердикт судьи</Eyebrow>
            <StatusBadge status={item.status} />
          </div>
          <div className="mt-2 text-[14px] leading-relaxed text-lab-text">
            {item.status === "RUNNING"
              ? item.stage
              : (lead?.reason ?? item.error ?? "Судья не нашёл доказательств ни выполнения, ни нарушения.")}
          </div>
          {second && (
            <div className={cn("mt-2 text-[12px]", disputed(item) ? "text-lab-warn" : "text-lab-dim")}>
              Второй судья {disputed(item) ? `оценил иначе: ${STATUS_TEXT[second.status as Status]}` : "согласен"}
            </div>
          )}
        </div>
      </div>

      <Trajectory item={item} />

      <div className="flex flex-col gap-4">
        {item.conversation.map((m, k) =>
          m.role === "customer" ? (
            <div key={k} className="flex max-w-[80%] flex-col items-end gap-1 self-end">
              <Bubble>{m.text}</Bubble>
              {k > 0 && item.conversation[k - 1].options?.includes(m.text) && (
                <div className="inline-flex items-center gap-1 px-1 text-[11px] text-lab-dim">
                  <MousePointerClick className="size-3" />
                  Нажал кнопку
                </div>
              )}
              {k === 0 && (m.fromLog || m.rewritten) && (
                <div className="px-1 text-[11px] text-lab-dim">
                  {m.fromLog
                    ? "Первая реплика из лога"
                    : `Реплика из лога, переписана под тип «${state.personas.find((p) => p.id === personaOf(item))?.name ?? ""}»`}
                </div>
              )}
            </div>
          ) : (
            <AgentMessage key={k} m={m} />
          ),
        )}
      </div>

      {rules.length > 0 && (
        <div>
          <Eyebrow className="mb-2.5">Критерии судьи</Eyebrow>
          <Panel>
            {rules.map((r, k) => (
              <Row
                first={!k}
                key={r.ruleId}
                className={cn("flex gap-3.5 px-4 py-3.5", r.status === "NOT_APPLICABLE" && "opacity-55")}
              >
                <span title={RULE_TEXT[r.status]}>
                  <StatusMark status={r.status} size={22} />
                </span>
                <div className="min-w-0 text-[13px]">
                  <div className="leading-snug text-lab-text">{r.rule}</div>
                  <div className="mt-1 leading-snug text-lab-dim">{r.reason}</div>
                  {r.agentQuote && (
                    <Quote who="агент" tone={r.status === "FAIL" ? "bad" : undefined}>
                      «{r.agentQuote}»
                    </Quote>
                  )}
                </div>
              </Row>
            ))}
          </Panel>
        </div>
      )}
    </div>
  );
}
