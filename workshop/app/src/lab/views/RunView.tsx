import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { Check, Copy, ExternalLink, Gavel, LayoutGrid, MessagesSquare, MousePointerClick, Play, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../api";
import { count, plural, when } from "../format";
import { Heatmap } from "../charts/Heatmap";
import { JobLine } from "../JobLine";
import { JudgeCheck } from "./JudgeCheck";
import { splitQuote } from "../findings";
import { transcript } from "../report";
import { disputed, itemKey, personaOf, previousOf, scenariosOfRun, typesOfRun } from "../logic";
import { DEFAULT_PERSONA, HUE, RULE_TEXT, STATUS_TEXT, statusHue } from "../look";
import { Modal } from "../modal";
import { useToast } from "../toast";
import type { Item, LabRun, LabState, Message, Rule, Status } from "../types";
import { useRunDetails } from "../useLab";
import { Badge, Button, Bubble, Eyebrow, Meta, Page, Panel, PersonaCard, PersonaTag, Progress, Quote, Row, Segmented, StatusBadge, StatusMark, Tabs, ToolPill } from "../ui";

/** The settings of a new run: agent, customer types, repeats. The button says how many conversations it makes. */
export function NewRun({ state, target, setTarget, onStarted }: { state: LabState; target: string; setTarget: (t: string) => void; onStarted?: () => void }) {
  const { error } = useToast();
  const deck = state.cards?.cards ?? [];
  const [repeats, setRepeats] = useState(1);
  const [types, setTypes] = useState<string[]>([DEFAULT_PERSONA]);
  const toggle = (id: string) => setTypes(t => t.includes(id) ? (t.length > 1 ? t.filter(x => x !== id) : t) : [...t, id]);
  const start = () => api("/api/runs", { target, repeats, personas: types }).then(() => onStarted?.()).catch(error);
  const total = deck.length * types.length * repeats;
  return (
    <div>
      <div className="space-y-6 px-6 py-5">
        <div>
          <Eyebrow className="mb-2.5">Агент</Eyebrow>
          <Segmented value={target} onChange={setTarget} options={state.targets.map(t => ({ value: t.id, label: t.name, title: t.note }))} />
        </div>
        <div>
          <Eyebrow>Кто пишет агенту</Eyebrow>
          <p className="mb-3 mt-1.5 text-[12px] leading-snug text-lab-dim">
            {types.length > 1 ? "Меняется только манера письма, суть обращения та же." : "Обычный клиент пишет так же, как в логе. Добавьте другие типы, чтобы проверить, устойчив ли агент к манере письма."}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {state.personas.map(p => <PersonaCard key={p.id} persona={p} on={types.includes(p.id)} onClick={() => toggle(p.id)} />)}
          </div>
        </div>
        <div>
          <Eyebrow>Повторы</Eyebrow>
          <p className="mb-3 mt-1.5 text-[12px] leading-snug text-lab-dim">Агент отвечает не всегда одинаково. Повторы показывают, насколько результат стабилен.</p>
          <Segmented value={repeats} onChange={setRepeats} options={[1, 2, 3].map(n => ({ value: n, label: n === 1 ? "Один раз" : `${n} раза` }))} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] bg-white/[0.02] px-6 py-4">
        {deck.length ? (
          <span className="text-[13px] text-lab-mute">
            {count(deck.length, "сценарий", "сценария", "сценариев")} × {types.length} {plural(types.length, "тип", "типа", "типов")} клиентов{repeats > 1 ? ` × ${repeats} повтора` : ""} = <b className="font-semibold text-lab-ink">{count(total, "разговор", "разговора", "разговоров")}</b>
          </span>
        ) : (
          <span className="text-[13px] text-lab-warn">Играть пока нечего: сначала соберите сценарии на шаге «Сценарии».</span>
        )}
        <Button variant="primary" icon={Play} disabled={state.job.running || !deck.length} onClick={start}>Запустить</Button>
      </div>
    </div>
  );
}

/** `mark`: the quote the judge cited and why it counts as a violation; drawn in the text and under it. */
export function AgentMessage({ m, mark }: { m: Message; mark?: { quote?: string; reason?: string } }) {
  const [open, setOpen] = useState(false);
  const long = m.text.length > 700;
  const calls = (m.events ?? []).map(e => e.tool.replace("Система банка · ", "")).filter((t, k, all) => all.indexOf(t) === k);
  const parts = mark?.quote ? splitQuote(m.text, mark.quote) : null;
  return (
    <div className="flex max-w-[86%] flex-col items-start gap-1.5 self-start">
      <div className="rounded-2xl rounded-bl-md border border-white/[0.08] bg-lab-surface px-4 py-3 text-[13px] leading-relaxed text-lab-text">
        <div className="whitespace-pre-wrap" style={long && !open ? { maxHeight: 220, overflow: "hidden", maskImage: "linear-gradient(#000 70%, transparent)" } : undefined}>{parts ? <>{parts[0]}<mark className="rounded-sm border-b-2 border-lab-bad bg-lab-bad/15 px-0.5 text-[#f6c9c9]">{parts[1]}</mark>{parts[2]}</> : m.text}</div>
        {long && <button className="mt-1.5 text-[12px] text-lab-accent hover:underline" onClick={() => setOpen(v => !v)}>{open ? "Свернуть" : "Показать полностью"}</button>}
      </div>
      {parts && mark?.reason && (
        <div className="max-w-[92%] border-l-2 border-lab-bad py-0.5 pl-3 text-[12px] leading-snug text-[#f3cccc]"><b className="font-semibold">✗ Нарушено.</b> {mark.reason}</div>
      )}
      {!!m.options?.length && <div className="flex flex-wrap gap-1.5">{m.options.map(o => <span key={o} className="rounded-full border border-white/[0.1] px-2.5 py-0.5 text-[12px] text-lab-mute">{o}</span>)}</div>}
      {calls.length > 0 && <div className="flex flex-wrap gap-1.5">{calls.map(c => <ToolPill key={c} name={c} />)}</div>}
      <div className="px-1 text-[11px] text-lab-dim">
        {m.ok === false ? <span className="text-lab-warn">Передал оператору · статус {m.status}</span> : `Ответил за ${m.seconds ?? "—"} с`}
      </div>
    </div>
  );
}

/** How long the agent took on each turn and what it called: the Workshop's «trajectory» for one conversation. */
function Trajectory({ item }: { item: Item }) {
  const turns = item.conversation.filter(m => m.role === "agent").map((m, i) => ({
    n: i + 1, seconds: m.seconds ?? 0, handoff: m.ok === false,
    tools: (m.events ?? []).map(e => e.tool.replace("Система банка · ", "")).filter((t, k, all) => all.indexOf(t) === k),
  }));
  if (!turns.some(t => t.seconds > 0) || (turns.length < 2 && !turns.some(t => t.tools.length))) return null;
  const total = Math.round(turns.reduce((n, t) => n + t.seconds, 0) * 10) / 10;
  const slowest = Math.max(...turns.map(t => t.seconds), 0.1);
  return (
    <Panel className="px-4 py-3">
      <div className="mb-2.5 flex items-center justify-between">
        <Eyebrow>Траектория</Eyebrow>
        <span className="font-mono text-[11px] text-lab-dim">{turns.length} {plural(turns.length, "ход", "хода", "ходов")} · {total} с</span>
      </div>
      <div className="space-y-1.5">
        {turns.map(t => (
          <div key={t.n} className="grid grid-cols-[52px_1fr_auto] items-center gap-3 text-[11px]">
            <span className="font-mono text-lab-dim">ход {t.n}</span>
            <div className="flex items-center gap-2">
              <div className={cn("h-[18px] rounded-full", t.handoff ? "bg-lab-warn/70" : "bg-lab-mute/35")} style={{ width: `${Math.max(4, (100 * t.seconds) / slowest)}%`, maxWidth: "calc(100% - 44px)" }} />
              <span className="flex-shrink-0 font-mono text-lab-mute">{t.seconds} с</span>
            </div>
            <span className="max-w-[260px] truncate font-mono text-lab-dim" title={t.tools.join(", ")}>{t.handoff ? "передал оператору" : t.tools.join(", ")}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** The conversation as it happened; the judge's verdict on top and every criterion below. */
export function Conversation({ item, state }: { item: Item; state: LabState }) {
  const order: Record<string, number> = { FAIL: 0, PASS: 1, UNKNOWN: 2, NOT_APPLICABLE: 3 };
  const rules = [...item.rules].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  const lead: Rule | undefined = rules.find(r => r.status === "FAIL") ?? rules.find(r => r.status === "PASS");
  const h = HUE[statusHue(item.status)];
  const second = item.second && ["PASS", "FAIL", "UNMEASURED"].includes(item.second.status) ? item.second : null;
  return (
    <div className="message-arrive mx-auto flex max-w-[880px] flex-col gap-7 px-6 py-6">
      <div className={cn("flex gap-4 rounded-lg border p-4", h.bg, h.border)}>
        <StatusMark status={item.status} size={30} />
        <div className="min-w-0">
          <div className="flex items-center gap-2"><Eyebrow>Вердикт судьи</Eyebrow><StatusBadge status={item.status} /></div>
          <div className="mt-2 text-[14px] leading-relaxed text-lab-text">
            {item.status === "RUNNING" ? item.stage : lead?.reason ?? item.error ?? "Судья не нашёл доказательств ни выполнения, ни нарушения."}
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
        {item.conversation.map((m, k) => m.role === "customer" ? (
          <div key={k} className="flex max-w-[80%] flex-col items-end gap-1 self-end">
            <Bubble>{m.text}</Bubble>
            {k > 0 && item.conversation[k - 1].options?.includes(m.text) && (
              <div className="inline-flex items-center gap-1 px-1 text-[11px] text-lab-dim"><MousePointerClick className="size-3" />Нажал кнопку</div>
            )}
            {k === 0 && (m.fromLog || m.rewritten) && (
              <div className="px-1 text-[11px] text-lab-dim">
                {m.fromLog ? "Первая реплика из лога" : `Реплика из лога, переписана под тип «${state.personas.find(p => p.id === personaOf(item))?.name ?? ""}»`}
              </div>
            )}
          </div>
        ) : <AgentMessage key={k} m={m} />)}
      </div>

      {rules.length > 0 && (
        <div>
          <Eyebrow className="mb-2.5">Критерии судьи</Eyebrow>
          <Panel>
            {rules.map((r, k) => (
              <Row first={!k} key={r.ruleId} className={cn("flex gap-3.5 px-4 py-3.5", r.status === "NOT_APPLICABLE" && "opacity-55")}>
                <span title={RULE_TEXT[r.status]}><StatusMark status={r.status} size={22} /></span>
                <div className="min-w-0 text-[13px]">
                  <div className="leading-snug text-lab-text">{r.rule}</div>
                  <div className="mt-1 leading-snug text-lab-dim">{r.reason}</div>
                  {r.agentQuote && <Quote who="агент" tone={r.status === "FAIL" ? "bad" : undefined}>«{r.agentQuote}»</Quote>}
                </div>
              </Row>
            ))}
          </Panel>
        </div>
      )}
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-white/15 bg-white/[0.04] px-1.5 font-mono text-[10px] leading-4 text-lab-mute">{children}</kbd>;
}

/** The conversation as text on the clipboard, for a ticket or a chat with the agent's team. */
function CopyButton({ text }: { text: () => string }) {
  const { error } = useToast();
  const [done, setDone] = useState(false);
  const copy = () => navigator.clipboard.writeText(text()).then(() => { setDone(true); window.setTimeout(() => setDone(false), 1600); }).catch(error);
  return (
    <button onClick={copy} className="inline-flex items-center gap-1 text-[12px] text-lab-dim transition-colors hover:text-lab-text">
      {done ? <Check className="size-3 text-lab-ok" strokeWidth={2.5} /> : <Copy className="size-3" />}{done ? "Скопировано" : "Копировать"}
    </button>
  );
}

function ReviewButtons({ selected, onReview }: { selected: Item; onReview: (d: "agree" | "disagree" | null) => void }) {
  if (!["PASS", "FAIL"].includes(selected.status)) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-[12px] text-lab-dim">Судья прав?</span>
      {(["agree", "disagree"] as const).map(d => {
        const on = selected.review === d;
        const Icon = d === "agree" ? Check : X;
        return (
          <button
            key={d} onClick={() => onReview(on ? null : d)} aria-pressed={on}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lab-accent/50",
              on ? cn(d === "agree" ? "bg-lab-ok" : "bg-lab-bad", "text-black") : "bg-white/[0.07] text-lab-mute hover:bg-white/[0.13] hover:text-lab-text",
            )}
          ><Icon className="size-3.5" strokeWidth={2.5} />{d === "agree" ? "Верно" : "Неверно"}</button>
        );
      })}
    </span>
  );
}

/** A run: header with the score and a live bar, then either one conversation or the whole scenario × customer matrix. */
export function RunView({ state, run, itemId, target, setTarget, onOpen }: {
  state: LabState; run: LabRun | null; itemId: string | null; target: string; setTarget: (t: string) => void; onOpen: (key?: string) => void;
}) {
  const { error } = useToast();
  const previous = run ? previousOf(state.runs, run) : null;
  const details = useRunDetails(previous ? [previous] : []);
  const [creating, setCreating] = useState(false);
  const location = useLocation();
  // «?view=judge» opens the judge check (a hash would be read by the Workshop as a trace id).
  const wantsJudge = new URLSearchParams(location.search).get("view") === "judge";
  const [view, setView] = useState<"chat" | "matrix" | "judge">(wantsJudge ? "judge" : "chat");
  useEffect(() => { if (wantsJudge) setView("judge"); }, [wantsJudge]);
  const [compare, setCompare] = useState(false);
  useEffect(() => { if (itemId) setView("chat"); }, [itemId]);
  const items = useMemo(() => run?.items ?? [], [run]);
  const selected = items.find(i => itemKey(i) === itemId) ?? items.find(i => i.status !== "RUNNING") ?? items[0];

  // J / K walk the scenarios keeping the customer type, ← / → walk the types (and repeats) of one scenario.
  // Keys are read by position, so they work on the Russian layout too.
  useEffect(() => {
    if (view !== "chat" || creating || !selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable)) return;
      const own = items.filter(i => i.cardId === selected.cardId);
      let next: Item | undefined;
      if (e.code === "ArrowRight") next = own[own.indexOf(selected) + 1];
      else if (e.code === "ArrowLeft") next = own[own.indexOf(selected) - 1];
      else if (e.code === "KeyJ" || e.code === "KeyK") {
        const scenarios = scenariosOfRun(items);
        const at = scenarios.findIndex(s => s.id === selected.cardId);
        const target = scenarios[at + (e.code === "KeyJ" ? 1 : -1)];
        if (target) next = items.find(i => i.cardId === target.id && personaOf(i) === personaOf(selected) && i.attempt === selected.attempt) ?? items.find(i => i.cardId === target.id);
      }
      if (next) { e.preventDefault(); onOpen(itemKey(next)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, creating, selected, items, onOpen]);

  if (!run) {
    return (
      <Page title="разговоры" lede="Искусственный клиент начинает с первой реплики из лога и ведёт разговор по ситуации сценария. Судья проверяет каждый разговор по критериям.">
        <Panel className="mt-5"><NewRun state={state} target={target} setTarget={setTarget} /></Panel>
        <div className="mt-3"><JobLine state={state} kind="run" /></div>
      </Page>
    );
  }

  const index = selected ? items.indexOf(selected) : -1;
  const types = typesOfRun(run, state.personas);
  const disputes = items.filter(disputed).length;
  const judgeLeft = items.filter(i => (i.status === "PASS" || i.status === "FAIL") && !i.review).length;
  const job = state.job;
  const live = job.running && job.kind === "run";
  const previousItems = previous ? details(previous)?.items ?? null : null;
  const review = (decision: "agree" | "disagree" | null) => api("/api/review", { run: run.id, index, decision }).catch(error);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 border-b border-white/[0.06]">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-6 py-3.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-lab-ink">{run.targetName}</span>
              <Badge>{run.version}</Badge>
              {live && <Badge hue="accent"><span className="size-1.5 rounded-full bg-lab-accent pulse-dot" />идёт</Badge>}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12px]">
              <Meta label="старт">{when(run.startedAt)}</Meta>
              <Meta label="разговоров">{items.length}</Meta>
              {types.length > 1 && <Meta label="типов клиентов">{types.length}</Meta>}
              {run.repeats && run.repeats > 1 ? <Meta label="повторов">{run.repeats}</Meta> : null}
              {disputes > 0 && <Meta label="судьи расходятся">{disputes} {plural(disputes, "раз", "раза", "раз")}</Meta>}
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <JobLine state={state} kind="run" bare />
            <JobLine state={state} kind="rejudge" bare />
            <span className="mr-1 text-[24px] font-medium leading-none text-lab-ink" style={{ fontFamily: '"AlphaLyrae", sans-serif' }} title="Точность прогона">{run.metric?.accuracy ?? "—"}%</span>
            {run.status !== "running" && (
              <Button size="sm" variant="ghost" icon={RotateCcw} disabled={state.job.running} title="Судья заново оценит те же разговоры, агент при этом не запускается"
                onClick={() => api(`/api/runs/${run.id}/rejudge`, {}).catch(error)}>Переоценить</Button>
            )}
            <Button size="sm" variant="primary" icon={Play} disabled={state.job.running} onClick={() => setCreating(true)}>Новый прогон</Button>
          </div>
        </div>
        {live && job.progress.total ? <Progress value={(100 * (job.progress.done ?? 0)) / job.progress.total} /> : null}
        <Tabs value={view} onChange={setView} tabs={[
          { value: "chat", label: <><MessagesSquare className="size-3.5" />Разговор</> },
          { value: "matrix", label: <><LayoutGrid className="size-3.5" />Матрица</> },
          { value: "judge", label: <><Gavel className="size-3.5" />Проверка судьи{judgeLeft ? <span className="font-mono text-[10px] text-lab-dim">{judgeLeft}</span> : null}</> },
        ]} />
        {run.error && <div className="border-t border-white/[0.06] px-6 py-2 text-[12px] text-lab-bad">{run.error}</div>}
      </div>

      {view === "chat" && selected && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/[0.06] bg-white/[0.02] px-6 py-2.5">
          <span className="text-[13px] font-medium text-lab-text">{selected.name}</span>
          {types.length > 1 && <PersonaTag personas={state.personas} id={selected.persona} />}
          {selected.attempt && selected.attempt > 1 && <Badge>повтор {selected.attempt}</Badge>}
          <span className="ml-auto flex items-center gap-4">
            <span className="hidden items-center gap-1.5 text-[11px] text-lab-dim min-[1500px]:inline-flex" title="J / K: соседние сценарии, стрелки влево и вправо: типы клиентов и повторы">
              <Kbd>J</Kbd><Kbd>K</Kbd> сценарии <Kbd>←</Kbd><Kbd>→</Kbd> типы
            </span>
            <CopyButton text={() => transcript(selected, state.personas)} />
            {selected.runId && (
              <a href={`/runs/${selected.runId}`} className="inline-flex items-center gap-1 text-[12px] text-lab-dim transition-colors hover:text-lab-text"><ExternalLink className="size-3" />Трейс в Workshop</a>
            )}
            <ReviewButtons selected={selected} onReview={review} />
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto sb">
        {view === "judge" ? (
          <JudgeCheck run={run} state={state} onReview={(index, decision) => api("/api/review", { run: run.id, index, decision }).catch(error)} onOpen={i => onOpen(itemKey(i))} />
        ) : view === "matrix" ? (
          <div className="mx-auto max-w-[1000px] px-6 py-6">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[14px] font-medium text-lab-ink">Сценарий × тип клиента</div>
                <div className="mt-0.5 text-[12px] text-lab-dim">Нажмите на клетку, чтобы открыть разговор.</div>
              </div>
              {previous && (
                <Button size="sm" variant={compare ? "secondary" : "ghost"} disabled={!previousItems} onClick={() => setCompare(v => !v)}>
                  {compare ? "Сравнение включено" : `Сравнить с ${previous.version}`}
                </Button>
              )}
            </div>
            <Panel className="p-5">
              <Heatmap
                personas={types} scenarios={scenariosOfRun(items)} items={items} previous={previousItems} compare={compare}
                accuracy={run.metric?.personas ?? (types.length === 1 ? { [types[0].id]: { accuracy: run.metric?.accuracy ?? null } } : undefined)}
                onOpen={i => onOpen(itemKey(i))}
              />
            </Panel>
          </div>
        ) : selected
          ? <Conversation key={itemKey(selected)} item={selected} state={state} />
          : <div className="flex h-full items-center justify-center text-[13px] text-lab-dim">В прогоне нет разговоров</div>}
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="Новый прогон" description="Выберите агента, кто ему пишет и сколько раз повторить.">
        <NewRun state={state} target={target} setTarget={setTarget} onStarted={() => { setCreating(false); onOpen(undefined); }} />
      </Modal>
    </div>
  );
}
