import { useRef, useState } from "react";
import { FileText, SlidersHorizontal, TriangleAlert, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, upload } from "../api";
import { count, plural, whenLong } from "../format";
import { JobLine } from "../JobLine";
import { Confirm } from "../modal";
import { setupSteps } from "../nav";
import { NextStep, SetupSteps } from "../Setup";
import { useToast } from "../toast";
import type { LabState } from "../types";
import { Button, EmptyState, Label, LinkButton, Page, Section, Stat, Strip, inputClass } from "../ui";

function DropZone({ busy, onFile, onPick }: { busy: boolean; onFile: (f: File) => void; onPick: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
      className={cn("lab-dots flex flex-col items-center rounded-lg border border-dashed px-8 py-14 text-center transition-colors duration-100", over ? "border-lab-accent/70 bg-lab-accent/[0.05]" : "border-lab-strong")}
    >
      <span className="mb-5 inline-flex size-11 items-center justify-center rounded-lg border border-lab-line bg-lab-canvas text-lab-mute"><Upload className="size-5" /></span>
      <div className="text-lead font-medium text-lab-ink">Перетащите выгрузку сюда</div>
      <div className="mt-1.5 max-w-[440px] text-body text-lab-mute">Или выберите файл. Он остаётся на этом компьютере.</div>
      <Button className="mt-6" variant="primary" icon={Upload} loading={busy} onClick={onPick}>Выбрать файл</Button>
      <div className="mt-3 font-mono text-micro text-lab-faint">.XLSX ИЛИ .JSONL</div>
    </div>
  );
}

/** What the export must look like, drawn as the sheet itself. */
function FormatHint() {
  return (
    <Section title="Какой должна быть выгрузка" hint="лист «Данные», в каждой строке один диалог">
      <div className="overflow-hidden rounded-lg border border-lab-line">
        <div className="grid grid-cols-[120px_1fr] text-body">
          <div className="lab-label border-b border-lab-line bg-lab-panel px-4 py-2 text-lab-mute">Id диалога</div>
          <div className="lab-label border-b border-lab-line bg-lab-panel px-4 py-2 text-lab-mute">Текст</div>
          <div className="px-4 py-3 font-mono text-caption text-lab-mute">48213</div>
          <div className="px-4 py-3 font-mono text-caption text-lab-mute">
            <span className="text-lab-text">CLIENT:</span> Не проходит оплата картой на терминале<br />
            <span className="text-lab-text">AGENT:</span> Подскажите, пожалуйста, номер терминала
          </div>
        </div>
      </div>
    </Section>
  );
}

/** Step 2: the real dialogues. The judge reads what the agent already said — the agent is not run. */
export function LogsView({ state, onGo, onCriterion }: { state: LabState; onGo: () => void; onCriterion: (rule: string) => void }) {
  const { error } = useToast();
  const d = state.discover;
  const [sample, setSample] = useState(d?.sampled ?? 60);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
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
  const nav = <SetupSteps state={state} current="logs" />;
  const cardsDone = setupSteps(state)[2].done;
  const noSources = !state.sources.length;
  const page = { title: "Подготовка", icon: SlidersHorizontal, bare: true, nav, narrow: true };

  if (!state.logs.total) {
    return (
      <Page {...page} primary={null}>
        <header className="pt-10">
          <Label>Шаг 2 · логи</Label>
          <h2 className="mt-3 text-display font-medium text-lab-ink">Загрузите реальные диалоги.</h2>
          <p className="mt-2 max-w-[680px] text-pretty text-lead text-lab-soft">Судья проверит записанные разговоры агента по критериям, не запуская самого агента.</p>
        </header>
        <div className="mt-8"><DropZone busy={busy} onFile={load} onPick={() => fileRef.current?.click()} /></div>
        <FormatHint />
        {picker}
      </Page>
    );
  }

  const actions = (
    <>
      <Button size="sm" variant="ghost" icon={Upload} loading={busy} collapse disabled={state.job.running} onClick={() => fileRef.current?.click()} title="Загрузить новую выгрузку">Новая выгрузка</Button>
      {d && <Button size="sm" variant="ghost" className="max-sm:hidden" disabled={state.job.running} onClick={() => setConfirm(true)} title="Выделить критерии из источников заново">Новые критерии</Button>}
    </>
  );
  const evaluate = <Button variant={d ? "secondary" : "primary"} icon={FileText} disabled={state.job.running || noSources} onClick={() => run(false)}>{d ? "Оценить заново" : "Оценить логи"}</Button>;
  const toolbar = (
    <div className="mt-6 flex flex-wrap items-center gap-2">
      <select value={sample} onChange={e => setSample(+e.target.value)} aria-label="Сколько диалогов оценить" className={cn(inputClass, "w-auto cursor-pointer pr-8")}>
        {[20, 40, 60, 100, 200].map(n => <option key={n} value={n}>{count(n, "диалог", "диалога", "диалогов")}</option>)}
      </select>
      <span className="text-body text-lab-mute">из {state.logs.total} в выгрузке</span>
      <JobLine state={state} kind="discover" />
      {noSources && (
        <div className="flex w-full items-center gap-2 text-body text-lab-warn">
          <TriangleAlert className="size-4" />Судье пока не на что опереться: нет критериев.
          <LinkButton onClick={onGo}>Подключите агента</LinkButton>
        </div>
      )}
      {picker}
    </div>
  );

  if (!d) {
    return (
      <Page {...page} actions={actions} primary={evaluate}>
        <header className="pt-10">
          <Label>Шаг 2 · логи</Label>
          <h2 className="mt-3 text-display font-medium text-lab-ink">Выгрузка загружена: {count(state.logs.total, "диалог", "диалога", "диалогов")}.</h2>
          <p className="mt-2 max-w-[680px] text-pretty text-lead text-lab-soft">Выберите, сколько диалогов оценить: судья выделит критерии из источников агента и проверит по ним каждый диалог.</p>
        </header>
        {toolbar}
        <EmptyState icon={FileText} title="Диалоги ещё не оценены">Нажмите «Оценить логи»: судья проверит выбранное число диалогов по критериям агента.</EmptyState>
      </Page>
    );
  }

  const s = d.summary;
  const rules = d.topics.reduce((n, t) => n + t.rules.length, 0);
  // The service's own list of recurring violations (discover.summarize): one per quote of the source, most frequent first.
  const patterns = s.patterns ?? [];
  const topPattern = patterns[0];
  const topics = d.topics.map(t => {
    const own = d.results.filter(r => r.topicId === t.id && (r.status === "PASS" || r.status === "FAIL"));
    return { id: t.id, title: t.title, rules: t.rules.length, checked: own.length, failed: own.filter(r => r.status === "FAIL").length };
  }).sort((a, b) => (b.checked ? b.failed / b.checked : 0) - (a.checked ? a.failed / a.checked : 0));

  return (
    <Page {...page} actions={actions} primary={evaluate}>
      <Confirm open={confirm} onClose={() => setConfirm(false)} onConfirm={() => run(true)} title="Выделить критерии заново?" action="Выделить заново" danger>
        Критерии будут выделены из источников заново: следующая оценка логов пойдёт по новому списку, а не по тому, что зафиксирован сейчас.
      </Confirm>
      <header className="pt-10">
        <Label>Шаг 2 · логи · оценены {whenLong(d.finishedAt)}</Label>
        <h2 className="mt-3 text-balance text-display font-medium text-lab-ink">Нарушения в {s.failed} из {count(s.measured, "реального диалога", "реальных диалогов", "реальных диалогов")}.</h2>
        {topPattern && <p className="mt-2 max-w-[720px] text-pretty text-lead text-lab-soft">Чаще всего: «{topPattern.rule}» — {count(topPattern.count, "диалог", "диалога", "диалогов")}.</p>}
      </header>
      {toolbar}
      <Strip className="mt-4">
        <Stat label="Оценено" value={s.checked} sub={`из ${state.logs.total} в выгрузке`} />
        <Stat label="С нарушениями" value={s.failed} hue={s.failed ? "bad" : undefined} sub={s.unmeasured ? `ещё ${s.unmeasured} без данных` : plural(s.failed, "диалог", "диалога", "диалогов")} />
        <Stat label="Критериев" value={rules} sub={`в ${count(d.topics.length, "теме", "темах", "темах")}`} />
        {s.secondJudge && <Stat label="Второй судья согласен" value={`${s.secondJudge.agree} из ${s.secondJudge.checked}`} sub={s.secondJudge.model} />}
      </Strip>

      {patterns.length > 0 && (
        <Section title="Нарушения" count={patterns.length} hint="по цитате источника, чаще всего сверху">
          <div className="divide-y divide-lab-line rounded-lg border border-lab-line bg-lab-panel">
            {patterns.map(p => (
              <button key={p.quote} onClick={() => onCriterion(p.rule)} className="lab-focus-inset group flex w-full items-center gap-4 px-4 py-2.5 text-left transition-colors duration-100 hover:bg-white/[0.03]">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-lab-ink" title={p.rule}>{p.rule}</span>
                  <span className="block truncate text-caption text-lab-mute" title={p.quote}>«{p.quote}» · {p.topics.join(", ")}</span>
                </span>
                <span className="flex-shrink-0 whitespace-nowrap text-body tabular-nums text-lab-mute">{count(p.count, "диалог", "диалога", "диалогов")}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section title="Темы" count={topics.length} hint="справа — диалоги темы с нарушением">
        <div className="divide-y divide-lab-line rounded-lg border border-lab-line bg-lab-panel">
          {topics.map(t => (
            <div key={t.id} className="flex items-center gap-4 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-body text-lab-ink">{t.title}</div>
                <div className="text-caption text-lab-mute">{count(t.rules, "критерий", "критерия", "критериев")}</div>
              </div>
              <div className="hidden w-[140px] sm:block">
                <div className="h-1 overflow-hidden rounded-sm bg-white/[0.07]"><div className="h-full bg-lab-bad/80" style={{ width: `${t.checked ? (100 * t.failed) / t.checked : 0}%` }} /></div>
              </div>
              <div className="w-[96px] whitespace-nowrap text-right text-body tabular-nums text-lab-mute" title={t.checked ? `С нарушением ${t.failed} из ${t.checked} диалогов темы` : undefined}>
                {t.checked ? <><span className={t.failed ? "font-medium text-lab-ink" : ""}>{t.failed}</span> из {t.checked}</> : "не проверялась"}
              </div>
            </div>
          ))}
        </div>
      </Section>
      <NextStep done={cardsDone} title="Соберите сценарии для симулятора" hint="Из оценённых диалогов получатся ситуации клиента: симулятор сыграет их с каждой новой версией агента." to="/lab/checks" cta={cardsDone ? "К сценариям" : "Собрать сценарии"} />
    </Page>
  );
}
