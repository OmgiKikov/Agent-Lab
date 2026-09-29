import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Check, Copy, ExternalLink, MousePointerClick, Play, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../api";
import { count, plural } from "../format";
import { splitQuote } from "../findings";
import { transcript } from "../report";
import { disputed, itemKey, personaOf, scenarioStatus, scenariosOfRun, typesOfRun } from "../logic";
import { DEFAULT_PERSONA, HUE, RULE_TEXT, STATUS_TEXT, personaLook, personaName, statusHue } from "../look";
import { useToast } from "../toast";
import type { Item, LabRun, LabState, Message, Rule, Status } from "../types";
import { Badge, Bubble, Button, Chip, EmptyState, Field, Input, Kbd, Page, Panel, PersonaCard, PersonaTag, Progress, Segmented, StatusBadge, StatusIcon, StatusMark, ToolPill } from "../ui";

const secondsText = (s?: number) => (s === undefined ? "—" : String(s).replace(".", ","));

/** «Проверить версию»: which agent, who writes to it, how many times, and what changed. The footer says how many dialogues it makes. */
export function NewRun({ state, target, setTarget, onStarted }: { state: LabState; target: string; setTarget: (t: string) => void; onStarted?: () => void }) {
  const { error } = useToast();
  const deck = state.cards?.cards ?? [];
  const [repeats, setRepeats] = useState(1);
  const [types, setTypes] = useState<string[]>([DEFAULT_PERSONA]);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setTypes(t => t.includes(id) ? (t.length > 1 ? t.filter(x => x !== id) : t) : [...t, id]);
  const start = () => {
    setBusy(true);
    api("/api/runs", { target, repeats, personas: types, label: label.trim() }).then(() => onStarted?.()).catch(error).finally(() => setBusy(false));
  };
  const total = deck.length * types.length * repeats;
  const note = state.targets.find(t => t.id === target)?.note;
  return (
    <div>
      <div className="space-y-6 px-6 pb-6 pt-3">
        <Field label="Что изменили в этой версии" hint="Подпись версии в списке версий и на графике. Можно оставить пустым.">
          <Input value={label} onChange={e => setLabel(e.target.value)} maxLength={120} placeholder="Например: тариф запрашивается до ответа о комиссии" />
        </Field>
        <div>
          <div className="mb-1.5 text-body font-medium text-lab-ink">Агент</div>
          <Segmented value={target} onChange={setTarget} options={state.targets.map(t => ({ value: t.id, label: t.name, title: t.note }))} />
          {note && <p className="mt-1.5 text-caption text-lab-mute">{note}</p>}
        </div>
        <div>
          <div className="text-body font-medium text-lab-ink">Кто пишет агенту</div>
          <p className="mb-3 mt-0.5 text-caption text-lab-mute">
            {types.length > 1 ? "Меняется только манера письма, суть обращения та же." : "Обычный клиент пишет так же, как в логе. Добавьте другие типы, чтобы проверить, устойчив ли агент к манере письма."}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {state.personas.map(p => <PersonaCard key={p.id} persona={p} on={types.includes(p.id)} onClick={() => toggle(p.id)} />)}
          </div>
        </div>
        <div>
          <div className="text-body font-medium text-lab-ink">Повторы</div>
          <p className="mb-3 mt-0.5 text-caption text-lab-mute">Агент отвечает не всегда одинаково: повторы показывают, стабилен ли ответ, и сужают погрешность числа.</p>
          <Segmented value={repeats} onChange={setRepeats} options={[1, 2, 3].map(n => ({ value: n, label: n === 1 ? "Один раз" : `${n} раза` }))} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-lab-line px-6 py-4">
        {deck.length ? (
          <span className="text-body tabular-nums text-lab-mute">
            {count(deck.length, "сценарий", "сценария", "сценариев")} × {types.length} {plural(types.length, "тип", "типа", "типов")} клиентов{repeats > 1 ? ` × ${count(repeats, "повтор", "повтора", "повторов")}` : ""} = <b className="font-semibold text-lab-ink">{count(total, "диалог", "диалога", "диалогов")}</b>
          </span>
        ) : (
          <span className="text-body text-lab-warn">Играть пока нечего: сначала соберите сценарии на шаге «Сценарии».</span>
        )}
        <Button variant="primary" icon={Play} loading={busy} disabled={state.job.running || !deck.length} onClick={start}>Запустить проверку</Button>
      </div>
    </div>
  );
}

/** One answer of the agent. `mark`: the quote the judge cited and why it is a violation — highlighted in the text and explained under it. */
export function AgentMessage({ m, mark }: { m: Message; mark?: { quote?: string; reason?: string } }) {
  const [open, setOpen] = useState(false);
  const long = m.text.length > 700;
  const calls = (m.events ?? []).map(e => e.tool.replace("Система банка · ", "")).filter((t, k, all) => all.indexOf(t) === k);
  const parts = mark?.quote ? splitQuote(m.text, mark.quote) : null;
  return (
    <div className="flex max-w-[88%] flex-col items-start gap-1.5 self-start">
      <div className={cn("rounded-2xl rounded-bl-md border bg-lab-panel px-4 py-3 text-reading text-lab-text", parts ? "border-lab-bad/30" : "border-lab-line")}>
        <div className="whitespace-pre-wrap" style={long && !open ? { maxHeight: 220, overflow: "hidden", maskImage: "linear-gradient(#000 70%, transparent)" } : undefined}>
          {parts ? <>{parts[0]}<mark className="rounded-sm bg-lab-bad/15 px-0.5 text-lab-ink underline decoration-lab-bad decoration-2 underline-offset-4">{parts[1]}</mark>{parts[2]}</> : m.text}
        </div>
        {long && <button className="lab-focus mt-1.5 rounded-sm text-body font-medium text-lab-accent transition-colors duration-100 hover:text-lab-ink" onClick={() => setOpen(v => !v)}>{open ? "Свернуть" : "Показать полностью"}</button>}
      </div>
      {parts && mark?.reason && (
        <div className="flex max-w-full gap-2 pl-1 text-body text-lab-text">
          <X className="mt-[3px] size-3.5 flex-shrink-0 text-lab-bad" strokeWidth={2.75} />
          <span><b className="font-semibold text-lab-ink">Нарушено.</b> {mark.reason}</span>
        </div>
      )}
      {!!m.options?.length && <div className="flex flex-wrap gap-1.5">{m.options.map(o => <span key={o} className="rounded-full border border-lab-edge px-2.5 py-0.5 text-caption text-lab-mute">{o}</span>)}</div>}
      {calls.length > 0 && <div className="flex flex-wrap gap-1.5">{calls.map(c => <ToolPill key={c} name={c} />)}</div>}
      <div className="px-1 text-caption text-lab-mute">
        {m.ok === false ? <span className="text-lab-warn">Передал оператору вместо ответа · статус {m.status}</span> : `Ответил за ${secondsText(m.seconds)} с`}
      </div>
    </div>
  );
}

/** How long the agent took on each turn and what it called: the trajectory of one dialogue. */
function Trajectory({ item }: { item: Item }) {
  const turns = item.conversation.filter(m => m.role === "agent").map((m, i) => ({
    n: i + 1, seconds: m.seconds ?? 0, handoff: m.ok === false,
    tools: (m.events ?? []).map(e => e.tool.replace("Система банка · ", "")).filter((t, k, all) => all.indexOf(t) === k),
  }));
  if (!turns.some(t => t.seconds > 0) || (turns.length < 2 && !turns.some(t => t.tools.length))) return null;
  const total = Math.round(turns.reduce((n, t) => n + t.seconds, 0) * 10) / 10;
  const slowest = Math.max(...turns.map(t => t.seconds), 0.1);
  return (
    <section aria-label="Ходы агента" className="rounded-xl border border-lab-line px-4 py-3">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <span className="text-caption font-medium text-lab-mute">Ходы агента</span>
        <span className="text-caption tabular-nums text-lab-mute">{count(turns.length, "ход", "хода", "ходов")} · {secondsText(total)} с</span>
      </div>
      <div className="space-y-1.5">
        {turns.map(t => (
          <div key={t.n} className="grid grid-cols-[44px_1fr_minmax(0,220px)] items-center gap-3 text-caption">
            <span className="tabular-nums text-lab-mute">ход {t.n}</span>
            <div className="flex min-w-0 items-center gap-2">
              <div className={cn("h-2 rounded-full", t.handoff ? "bg-lab-warn/70" : "bg-lab-mute/40")} style={{ width: `${Math.max(3, (100 * t.seconds) / slowest)}%`, maxWidth: "calc(100% - 48px)" }} />
              <span className="flex-shrink-0 tabular-nums text-lab-text">{secondsText(t.seconds)} с</span>
            </div>
            <span className={cn("truncate", t.handoff ? "text-lab-warn" : "text-lab-mute")} title={t.tools.join(", ")}>{t.handoff ? "передал оператору" : t.tools.join(", ")}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const VERDICT: Record<string, string> = { PASS: "Судья: без нарушений", FAIL: "Судья: есть нарушение", UNMEASURED: "Судья: нет данных", UNKNOWN: "Судья: нет данных", RUNNING: "Диалог идёт" };

/** The dialogue as it happened: the judge's verdict on top, the conversation, then every criterion the judge checked. */
export function Conversation({ item, state }: { item: Item; state: LabState }) {
  const order: Record<string, number> = { FAIL: 0, PASS: 1, UNKNOWN: 2, NOT_APPLICABLE: 3 };
  const rules = [...item.rules].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  const lead: Rule | undefined = rules.find(r => r.status === "FAIL") ?? rules.find(r => r.status === "PASS");
  const failed = rules.filter(r => r.status === "FAIL");
  const hue = statusHue(item.status);
  const second = item.second && ["PASS", "FAIL", "UNMEASURED"].includes(item.second.status) ? item.second : null;
  // The first answer the judge quoted: its quote is drawn right in the text.
  const markAt = failed.length ? item.conversation.findIndex(m => m.role === "agent" && failed.some(r => splitQuote(m.text, r.agentQuote))) : -1;
  const markRule = markAt >= 0 ? failed.find(r => splitQuote(item.conversation[markAt].text, r.agentQuote)) : undefined;
  return (
    <div className="message-arrive mx-auto flex max-w-[800px] flex-col gap-6 px-6 py-6">
      <section className={cn("flex gap-3.5 rounded-xl border p-4", HUE[hue].border, item.status === "PASS" ? "bg-lab-panel" : HUE[hue].bg)} aria-label="Вердикт судьи">
        <StatusMark status={item.status} size={28} />
        <div className="min-w-0">
          <div className="text-body font-semibold text-lab-ink">{VERDICT[item.status] ?? STATUS_TEXT[item.status as Status]}{failed.length > 1 ? ` · ${count(failed.length, "критерий", "критерия", "критериев")}` : ""}</div>
          <div className="mt-1 text-reading text-lab-text">
            {item.status === "RUNNING" ? item.stage : lead?.reason ?? item.error ?? "Судья не нашёл в диалоге доказательств ни выполнения, ни нарушения."}
          </div>
          {second && (
            <div className={cn("mt-2 inline-flex items-center gap-1.5 text-body", disputed(item) ? "text-lab-warn" : "text-lab-mute")}>
              {disputed(item) ? <StatusIcon status="UNKNOWN" size={13} /> : <Check className="size-3.5" strokeWidth={2.5} />}
              Второй судья {disputed(item) ? `оценил иначе: ${STATUS_TEXT[second.status as Status]}` : "согласен"}
            </div>
          )}
        </div>
      </section>

      <Trajectory item={item} />

      <div className="flex flex-col gap-4">
        {item.conversation.map((m, k) => m.role === "customer" ? (
          <div key={k} className="flex max-w-[80%] flex-col items-end gap-1 self-end">
            <Bubble>{m.text}</Bubble>
            {k > 0 && item.conversation[k - 1].options?.includes(m.text) && (
              <div className="inline-flex items-center gap-1 px-1 text-caption text-lab-mute"><MousePointerClick className="size-3" />Нажал кнопку</div>
            )}
            {k === 0 && (m.fromLog || m.rewritten) && (
              <div className="px-1 text-caption text-lab-mute">
                {m.fromLog ? "Первая реплика из реального диалога" : `Реплика из реального диалога, переписана под тип «${personaName(state.personas, personaOf(item))}»`}
              </div>
            )}
          </div>
        ) : <AgentMessage key={k} m={m} mark={k === markAt && markRule ? { quote: markRule.agentQuote, reason: markRule.reason } : undefined} />)}
      </div>

      {rules.length > 0 && (
        <section aria-label="Критерии судьи">
          <h3 className="mb-2.5 text-body font-semibold text-lab-ink">Что проверил судья</h3>
          <Panel>
            {rules.map((r, k) => (
              <div key={r.ruleId} className={cn("flex gap-3.5 px-4 py-3.5", k > 0 && "border-t border-lab-line", r.status === "NOT_APPLICABLE" && "opacity-60")}>
                <span title={RULE_TEXT[r.status]}><StatusMark status={r.status} size={22} /></span>
                <div className="min-w-0">
                  <div className="text-body font-medium text-lab-ink">{r.rule}</div>
                  <div className="mt-0.5 text-body text-lab-mute">{r.reason}</div>
                  {r.agentQuote && (
                    <blockquote className={cn("mt-2 border-l-2 pl-3 text-body", r.status === "FAIL" ? "border-lab-bad/70 text-lab-text" : "border-lab-strong text-lab-mute")}>«{r.agentQuote}»</blockquote>
                  )}
                </div>
              </div>
            ))}
          </Panel>
        </section>
      )}
    </div>
  );
}

/** The dialogue as text on the clipboard, for a ticket or a chat with the agent's team. */
function CopyButton({ text }: { text: () => string }) {
  const { error } = useToast();
  const [done, setDone] = useState(false);
  const copy = () => navigator.clipboard.writeText(text()).then(() => { setDone(true); window.setTimeout(() => setDone(false), 1600); }).catch(error);
  return <Button size="sm" variant="ghost" icon={done ? Check : Copy} onClick={copy}>{done ? "Скопировано" : "Копировать"}</Button>;
}

/** «Судья прав?» — a person's word on this verdict; it feeds the trust in the number. */
function ReviewButtons({ selected, onReview }: { selected: Item; onReview: (d: "agree" | "disagree" | null) => void }) {
  if (!["PASS", "FAIL"].includes(selected.status)) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="hidden text-body text-lab-mute lg:inline">Судья прав?</span>
      {(["agree", "disagree"] as const).map(d => {
        const on = selected.review === d;
        return (
          <Button
            key={d} size="sm" variant={on ? (d === "agree" ? "primary" : "danger") : "secondary"} icon={d === "agree" ? Check : X}
            aria-pressed={on} onClick={() => onReview(on ? null : d)}
          >{d === "agree" ? "Верно" : "Неверно"}</Button>
        );
      })}
    </span>
  );
}

/** The version's scenarios, each with its customer types and repeats: the list beside a dialogue. */
function ScenarioList({ state, run, selected, onOpen }: { state: LabState; run: LabRun; selected: Item; onOpen: (key: string) => void }) {
  const items = run.items ?? [];
  const [onlyFailed, setOnlyFailed] = useState(false);
  const multi = typesOfRun(run, state.personas).length > 1;
  const failed = items.filter(i => i.status === "FAIL").length;
  const all = scenariosOfRun(items);
  const scenarios = all.filter(s => !onlyFailed || items.some(i => i.cardId === s.id && i.status === "FAIL"));
  return (
    <aside className="hidden w-[288px] flex-shrink-0 flex-col border-r border-lab-line lg:flex" aria-label="Сценарии версии">
      <div className="px-4 pb-2 pt-4 text-caption font-medium text-lab-mute">Сценарии версии {run.version} · {all.length}</div>
      {failed > 0 && (
        <div className="flex gap-1.5 px-3 pb-2">
          <Chip on={!onlyFailed} onClick={() => setOnlyFailed(false)}>Все</Chip>
          <Chip on={onlyFailed} onClick={() => setOnlyFailed(true)} count={failed} hue="bad">С нарушениями</Chip>
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-px overflow-auto px-2 pb-3">
        {scenarios.map(({ id, name }) => {
          const own = items.filter(i => i.cardId === id);
          const status = scenarioStatus(own);
          const active = own.includes(selected);
          return (
            <div key={id} className={cn("rounded-lg px-2.5 py-2", active && "bg-lab-active")}>
              <button className="lab-focus flex w-full items-center gap-2.5 rounded-sm text-left" onClick={() => onOpen(itemKey(own[0]))}>
                <StatusIcon status={status} size={13} className={cn("flex-shrink-0", status === "PASS" ? "text-lab-faint" : HUE[statusHue(status)].text)} />
                <span className={cn("min-w-0 flex-1 truncate text-body", active ? "text-lab-ink" : "text-lab-text")} title={name}>{name}</span>
              </button>
              {own.length > 1 && (
                <div className="mt-1.5 flex flex-wrap gap-1 pl-[22px]">
                  {own.map(i => {
                    const on = i === selected;
                    const quiet = i.status === "PASS";
                    const h = HUE[statusHue(i.status)];
                    const Icon = personaLook(i.persona).icon;
                    return (
                      <button
                        key={itemKey(i)} onClick={() => onOpen(itemKey(i))}
                        title={`${personaName(state.personas, i.persona)}${i.attempt && i.attempt > 1 ? ` · повтор ${i.attempt}` : ""}: ${STATUS_TEXT[i.status]}`}
                        className={cn(
                          "lab-focus inline-flex h-6 min-w-[28px] items-center justify-center gap-1 rounded-md px-1.5 transition-colors duration-100",
                          quiet ? "text-lab-mute" : h.text,
                          on ? cn(quiet ? "bg-lab-raised" : h.bgStrong, "ring-1 ring-current") : cn(quiet ? "bg-white/[0.04] hover:bg-lab-raised" : h.bg),
                        )}
                      >
                        {multi && <Icon className="size-3 opacity-70" />}
                        <StatusIcon status={i.status} size={11} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {!scenarios.length && <div className="px-3 py-8 text-center text-body text-lab-mute">Нарушений нет</div>}
      </div>
    </aside>
  );
}

/** One simulated dialogue of a version, with the version's scenarios beside it. J / K walk the scenarios, ← / → the customer types and repeats. */
export function RunView({ state, run, itemId, target, setTarget, onOpen }: {
  state: LabState; run: LabRun | null; itemId: string | null; target: string; setTarget: (t: string) => void; onOpen: (key?: string) => void;
}) {
  const { error } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  // Addresses of the earlier layout: the judge check and the matrix have their own screens now.
  const legacyView = new URLSearchParams(location.search).get("view");
  useEffect(() => {
    if (legacyView === "judge") navigate("/lab/judge/check", { replace: true });
    else if (legacyView === "matrix") navigate("/lab/dialogs?view=map", { replace: true });
  }, [legacyView, navigate]);
  const items = useMemo(() => run?.items ?? [], [run]);
  const selected = items.find(i => itemKey(i) === itemId) ?? items.find(i => i.status !== "RUNNING") ?? items[0];

  useEffect(() => {
    if (!selected) return;
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
        const to = scenarios[at + (e.code === "KeyJ" ? 1 : -1)];
        if (to) next = items.find(i => i.cardId === to.id && personaOf(i) === personaOf(selected) && i.attempt === selected.attempt) ?? items.find(i => i.cardId === to.id);
      }
      if (next) { e.preventDefault(); onOpen(itemKey(next)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, items, onOpen]);

  if (!run) {
    return (
      <Page title="Диалоги" narrow>
        <EmptyState className="mt-8" title="Версия ещё не проверялась">Симулятор клиента сыграет сценарии с агентом, судья оценит каждый диалог. Настройте проверку и запустите.</EmptyState>
        <Panel className="mt-4"><NewRun state={state} target={target} setTarget={setTarget} /></Panel>
      </Page>
    );
  }

  const index = selected ? items.indexOf(selected) : -1;
  const types = typesOfRun(run, state.personas);
  const live = state.job.running && state.job.kind === "run";
  const review = (decision: "agree" | "disagree" | null) => api("/api/review", { run: run.id, index, decision }).catch(error);

  return (
    <div className="flex h-full flex-col">
      <header className="flex-shrink-0 border-b border-lab-line">
        <div className="flex h-14 items-center gap-2 px-6">
          <button onClick={() => navigate("/lab/dialogs")} className="lab-focus -ml-1.5 rounded-md px-1.5 py-1 text-body text-lab-mute transition-colors duration-100 hover:text-lab-ink">Диалоги</button>
          <span className="text-body text-lab-faint" aria-hidden>/</span>
          <h1 className="min-w-0 truncate text-body font-semibold text-lab-ink">{selected?.name ?? `Версия ${run.version}`}</h1>
          {selected && <StatusBadge status={selected.status} />}
          <div className="ml-auto flex flex-shrink-0 items-center gap-1.5">
            {selected && <ReviewButtons selected={selected} onReview={review} />}
            {selected && <CopyButton text={() => transcript(selected, state.personas)} />}
            {selected?.runId && <a href={`/runs/${selected.runId}`} className="lab-focus hidden h-7 items-center gap-1.5 rounded-md px-2.5 text-caption font-medium text-lab-mute transition-colors duration-100 hover:bg-lab-raised hover:text-lab-ink md:inline-flex"><ExternalLink className="size-3.5" />Трейс</a>}
            {run.status !== "running" && (
              <Button size="sm" variant="ghost" icon={RotateCcw} disabled={state.job.running} className="hidden md:inline-flex"
                title="Судья заново оценит те же диалоги; агент при этом не запускается" onClick={() => api(`/api/runs/${run.id}/rejudge`, {}).catch(error)}>Переоценить</Button>
            )}
          </div>
        </div>
        {selected && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 pb-3">
            <Badge>Версия {run.version}</Badge>
            {types.length > 1 && <PersonaTag personas={state.personas} id={selected.persona} />}
            {selected.attempt && selected.attempt > 1 ? <Badge>повтор {selected.attempt}</Badge> : null}
            {disputed(selected) && <Badge hue="warn">судьи расходятся</Badge>}
            <span className="ml-auto hidden items-center gap-1.5 text-caption text-lab-mute xl:inline-flex">
              <Kbd>J</Kbd><Kbd>K</Kbd> сценарии<span className="w-2" /><Kbd>←</Kbd><Kbd>→</Kbd> типы и повторы
            </span>
          </div>
        )}
        {live && state.job.progress.total ? <Progress value={(100 * (state.job.progress.done ?? 0)) / state.job.progress.total} /> : null}
        {run.error && <div className="border-t border-lab-line px-6 py-2 text-body text-lab-bad">{run.error}</div>}
      </header>

      <div className="flex min-h-0 flex-1">
        {selected && <ScenarioList state={state} run={run} selected={selected} onOpen={key => onOpen(key)} />}
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          {selected
            ? <Conversation key={itemKey(selected)} item={selected} state={state} />
            : <div className="flex h-full items-center justify-center text-body text-lab-mute">В проверке нет диалогов</div>}
        </div>
      </div>
    </div>
  );
}
