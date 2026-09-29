import { useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileText, ShieldCheck, TriangleAlert, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropPixelGrid } from "../../components/DropPixelGrid";
import { api, upload } from "../api";
import { plural, pct, when } from "../format";
import { JobLine } from "../JobLine";
import { Confirm } from "../modal";
import { useToast } from "../toast";
import type { LabState } from "../types";
import { Badge, Button, EmptyState, Eyebrow, inputClass, Page, Panel, Quote, Row, Section, StackBar, titleFont } from "../ui";

/** The service lists every violating conversation of a pattern; show a few, the rest on request. */
const EXAMPLES_SHOWN = 3;

const LEDE = "Разговоры из выгрузки проверяются по правилам из промпта агента. Сам агент при этом не запускается: судья оценивает только то, что уже было сказано.";

function DropZone({ busy, onFile, onPick }: { busy: boolean; onFile: (f: File) => void; onPick: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
      className={cn(
        "flex flex-col items-center rounded-2xl border border-dashed px-8 py-14 text-center transition-colors",
        over ? "border-lab-accent/70 bg-lab-accent/[0.06]" : "border-white/[0.16] bg-white/[0.02]",
      )}
    >
      <div className="mb-5"><DropPixelGrid px={2} gap={1.5} fillRgb="142,157,166" /></div>
      <div className="text-[18px] font-medium text-lab-ink" style={titleFont}>Перетащите выгрузку сюда</div>
      <div className="mt-2 max-w-[420px] text-[13px] leading-relaxed text-lab-dim">Или выберите файл на компьютере. Он остаётся здесь и никуда не отправляется.</div>
      <Button className="mt-6" variant="primary" icon={Upload} loading={busy} onClick={onPick}>Выбрать файл</Button>
      <div className="mt-3 font-mono text-[11px] text-lab-dim">.xlsx или .jsonl</div>
    </div>
  );
}

/** What the export must look like, drawn as the sheet itself. */
function FormatHint() {
  return (
    <Panel className="mt-5 overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3">
        <Eyebrow>Какой должна быть выгрузка</Eyebrow>
        <span className="text-[12px] text-lab-dim">Excel, лист «Данные»</span>
      </div>
      <div className="grid grid-cols-[150px_1fr] font-mono text-[12px]">
        <div className="border-b border-white/[0.06] bg-white/[0.03] px-5 py-2 text-lab-soft">Id диалога</div>
        <div className="border-b border-white/[0.06] bg-white/[0.03] px-5 py-2 text-lab-soft">Текст</div>
        <div className="px-5 py-3 text-lab-mute">48213</div>
        <div className="px-5 py-3 leading-relaxed text-lab-mute">
          <span className="text-lab-accent">CLIENT:</span> Не проходит оплата картой на терминале<br />
          <span className="text-lab-ok">AGENT:</span> Подскажите, пожалуйста, номер терминала
        </div>
      </div>
    </Panel>
  );
}

export function LogsView({ state, onOpen, onGo, nav }: { state: LabState; onOpen: (runId: string) => void; onGo: () => void; nav?: React.ReactNode }) {
  const { error } = useToast();
  const d = state.discover;
  const [sample, setSample] = useState(d?.sampled ?? 60);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set([0]));
  const [more, setMore] = useState<Set<number>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  const run = (replan = false) => api("/api/discover", { count: sample, replan }).catch(error);
  const load = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { await upload("/api/logs", file); } catch (e) { error(e); }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  };
  const picker = <input ref={fileRef} type="file" accept=".xlsx,.jsonl" className="hidden" onChange={e => load(e.target.files?.[0])} />;

  if (!state.logs.total) {
    return (
      <Page title="подключение" lede={LEDE} nav={nav}>
        <div className="mt-5"><DropZone busy={busy} onFile={load} onPick={() => fileRef.current?.click()} /></div>
        <FormatHint />
        {picker}
      </Page>
    );
  }

  const noSources = !state.sources.length;
  const toolbar = (
    <div className="mt-5 flex flex-wrap items-center gap-2">
      <Button variant="primary" icon={FileText} disabled={state.job.running || noSources} onClick={() => run(false)}>{d ? "Оценить заново" : "Оценить логи"}</Button>
      <select value={sample} onChange={e => setSample(+e.target.value)} aria-label="Сколько разговоров оценить" className={cn(inputClass, "w-auto cursor-pointer pr-8")}>
        {[20, 40, 60, 100, 200].map(n => <option key={n} value={n}>{n} {plural(n, "разговор", "разговора", "разговоров")}</option>)}
      </select>
      <JobLine state={state} kind="discover" />
      <div className="ml-auto flex items-center gap-1">
        <span className="mr-2 text-[12px] text-lab-dim">В выгрузке {state.logs.total}</span>
        <Button size="sm" variant="ghost" icon={Upload} loading={busy} disabled={state.job.running} onClick={() => fileRef.current?.click()}>Новая выгрузка</Button>
        {d && <Button size="sm" variant="ghost" disabled={state.job.running} onClick={() => setConfirm(true)}>Новые правила</Button>}
      </div>
      {noSources && (
        <div className="flex w-full items-center gap-2 text-[12px] text-lab-warn">
          <TriangleAlert className="size-3.5" />Судье пока не на что опереться.
          <button className="underline underline-offset-2 hover:text-lab-ink" onClick={onGo}>Соберите контекст агента</button>
        </div>
      )}
      {picker}
    </div>
  );

  if (!d) {
    return (
      <Page title="подключение" lede={LEDE} nav={nav}>
        {toolbar}
        <EmptyState className="mt-5" icon={FileText} title={`Выгрузка загружена: ${state.logs.total} ${plural(state.logs.total, "разговор", "разговора", "разговоров")}`}>
          Нажмите «Оценить логи»: судья проверит выбранное число разговоров и покажет, какие правила промпта агент нарушает чаще всего.
        </EmptyState>
      </Page>
    );
  }

  const s = d.summary;
  const rules = d.topics.reduce((n, t) => n + t.rules.length, 0);
  const byDialogue = new Map(d.results.map(r => [r.dialogueId, r]));
  const topics = d.topics
    .map(t => {
      const own = d.results.filter(r => r.topicId === t.id && (r.status === "PASS" || r.status === "FAIL"));
      return { id: t.id, title: t.title, checked: own.length, failed: own.filter(r => r.status === "FAIL").length };
    })
    .filter(t => t.checked)
    .sort((a, b) => b.failed / b.checked - a.failed / a.checked || b.failed - a.failed)
    .slice(0, 6);
  const top = Math.max(1, ...s.patterns.map(p => p.count));
  const toggle = (i: number) => setOpen(prev => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next; });

  return (
    <Page title="подключение" lede={LEDE} nav={nav}>
      {toolbar}
      <Confirm open={confirm} onClose={() => setConfirm(false)} onConfirm={() => run(true)} title="Выделить правила заново?" action="Выделить заново">
        Следующая оценка пойдёт по новым правилам, поэтому её нельзя будет сравнить с текущей.
      </Confirm>

      <div className="mt-5 grid gap-4 min-[1100px]:grid-cols-[1.25fr_1fr]">
        <Panel className="p-5">
          <Eyebrow>Разговоров с нарушением</Eyebrow>
          <div className="mt-3 flex items-baseline gap-3">
            <span className="text-[60px] font-medium leading-none text-lab-ink" style={titleFont}>{pct(s.failed, s.checked)}<span className="ml-0.5 text-[30px] text-lab-mute">%</span></span>
            <span className="text-[13px] text-lab-mute">{s.failed} из {s.checked} проверенных</span>
          </div>
          <StackBar className="mt-5" parts={[{ value: s.passed, hue: "ok" }, { value: s.failed, hue: "bad" }, { value: s.unmeasured, hue: "warn" }]} />
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-lab-mute">
            <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-lab-ok" />без нарушений · {s.passed}</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-lab-bad" />с нарушением · {s.failed}</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-lab-warn" />нет данных · {s.unmeasured}</span>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/[0.06] pt-4 text-[12px] text-lab-dim">
            <span>Проверка по {rules} {plural(rules, "правилу", "правилам", "правилам")} в {d.topics.length} {plural(d.topics.length, "теме", "темах", "темах")}</span>
            {s.secondJudge && (
              <Badge hue={s.secondJudge.agree / s.secondJudge.checked >= 0.8 ? "ok" : "warn"} icon={ShieldCheck}>
                второй судья согласен в {pct(s.secondJudge.agree, s.secondJudge.checked)}%
              </Badge>
            )}
          </div>
        </Panel>

        <Panel className="p-5">
          <Eyebrow>Где нарушений больше всего</Eyebrow>
          <div className="mt-4 space-y-3.5">
            {topics.map(t => (
              <div key={t.id}>
                <div className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span className="min-w-0 truncate text-lab-text" title={t.title}>{t.title}</span>
                  <span className="flex-shrink-0 font-mono text-[11px] text-lab-dim">{t.failed} из {t.checked}</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full rounded-full bg-lab-bad" style={{ width: `${pct(t.failed, t.checked)}%` }} /></div>
              </div>
            ))}
            {!topics.length && <div className="text-[12px] text-lab-dim">Нет проверенных разговоров по темам</div>}
          </div>
        </Panel>
      </div>

      <Section title="Частые нарушения" hint="Правила промпта, которые агент нарушает чаще всего. Раскройте строку, чтобы увидеть примеры.">
        <Panel>
          {s.patterns.map((p, i) => {
            const opened = open.has(i);
            return (
              <Row first={!i} key={i}>
                <button
                  onClick={() => toggle(i)} aria-expanded={opened}
                  className="grid w-full grid-cols-[76px_1fr_auto] items-start gap-5 px-5 py-4 text-left transition-colors hover:bg-white/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-lab-accent/50"
                >
                  <div>
                    <div className="text-[28px] font-medium leading-none text-lab-bad" style={titleFont}>{p.count}</div>
                    <div className="mt-1 text-[11px] text-lab-dim">{plural(p.count, "разговор", "разговора", "разговоров")}</div>
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full rounded-full bg-lab-bad" style={{ width: `${pct(p.count, top)}%` }} /></div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[14px] font-medium text-lab-ink">{p.titles[0] || p.rule}</div>
                    <div className="mt-1 text-[13px] leading-snug text-lab-mute">{p.rule}</div>
                    <div className="mt-2.5 flex flex-wrap gap-1.5">{p.topics.map(t => <Badge key={t}>{t}</Badge>)}</div>
                  </div>
                  <ChevronDown className={cn("mt-1 size-4 text-lab-dim transition-transform", opened && "rotate-180")} />
                </button>
                {opened && (
                  <div className="space-y-3 px-5 pb-5 pl-[116px]">
                    <Quote who="в промпте">«{p.quote}»</Quote>
                    {p.examples.slice(0, more.has(i) ? undefined : EXAMPLES_SHOWN).map(ex => {
                      const trace = byDialogue.get(ex.dialogueId)?.runId;
                      return (
                        <div key={ex.dialogueId} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
                          <Quote who="клиент">{ex.opening}</Quote>
                          {ex.agentQuote && <Quote who="агент" tone="bad">«{ex.agentQuote}»</Quote>}
                          <div className="mt-3 flex items-start justify-between gap-4 text-[12px] leading-snug text-lab-dim">
                            <span className="min-w-0">{ex.reason}</span>
                            {trace && (
                              <button onClick={() => onOpen(trace)} className="inline-flex flex-shrink-0 items-center gap-0.5 text-lab-accent hover:underline">
                                Открыть разговор<ChevronRight className="size-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {p.examples.length > EXAMPLES_SHOWN && !more.has(i) && (
                      <Button size="sm" variant="ghost" onClick={() => setMore(prev => new Set(prev).add(i))}>Показать ещё {p.examples.length - EXAMPLES_SHOWN}</Button>
                    )}
                  </div>
                )}
              </Row>
            );
          })}
          {!s.patterns.length && <div className="p-10 text-center text-[13px] text-lab-dim">Нарушений не найдено</div>}
        </Panel>
      </Section>

      <p className="mt-5 text-[12px] leading-relaxed text-lab-dim">
        Судья {d.model}. Вердикт засчитывается, только если есть цитата из ответа агента. Правила от {when(d.rulesSince ?? d.finishedAt)}, оценка от {when(d.finishedAt)}.
      </p>
    </Page>
  );
}
