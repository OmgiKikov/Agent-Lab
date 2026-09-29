import { useRef, useState } from "react";
import { FileText, ShieldCheck, TriangleAlert, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, upload } from "../api";
import { count, pct, plural, whenLong } from "../format";
import { JobLine } from "../JobLine";
import { Confirm } from "../modal";
import { setupSteps } from "../nav";
import { NextStep, SetupSteps } from "../Setup";
import { useToast } from "../toast";
import type { LabState } from "../types";
import { Badge, Button, EmptyState, inputClass, LinkButton, Page, Panel, Section } from "../ui";

function DropZone({ busy, onFile, onPick }: { busy: boolean; onFile: (f: File) => void; onPick: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
      className={cn("flex flex-col items-center rounded-xl border border-dashed px-8 py-14 text-center transition-colors duration-100", over ? "border-lab-accent/70 bg-lab-accent/5" : "border-lab-strong bg-lab-panel")}
    >
      <span className="mb-5 inline-flex size-11 items-center justify-center rounded-xl bg-lab-raised text-lab-mute"><Upload className="size-5" /></span>
      <div className="text-title font-semibold text-lab-ink">Перетащите выгрузку сюда</div>
      <div className="mt-1.5 max-w-[440px] text-body text-lab-mute">Или выберите файл на компьютере. Он остаётся здесь и никуда не отправляется.</div>
      <Button className="mt-6" variant="primary" icon={Upload} loading={busy} onClick={onPick}>Выбрать файл</Button>
      <div className="mt-3 text-caption text-lab-mute">.xlsx или .jsonl</div>
    </div>
  );
}

/** What the export must look like, drawn as the sheet itself. */
function FormatHint() {
  return (
    <Section title="Какой должна быть выгрузка" hint="Excel, лист «Данные»: в каждой строке — один диалог">
      <Panel className="overflow-hidden">
        <div className="grid grid-cols-[140px_1fr] text-body">
          <div className="border-b border-lab-line bg-lab-card px-5 py-2 font-medium text-lab-text">Id диалога</div>
          <div className="border-b border-lab-line bg-lab-card px-5 py-2 font-medium text-lab-text">Текст</div>
          <div className="px-5 py-3 font-mono text-caption text-lab-mute">48213</div>
          <div className="px-5 py-3 font-mono text-caption text-lab-mute">
            <span className="text-lab-text">CLIENT:</span> Не проходит оплата картой на терминале<br />
            <span className="text-lab-text">AGENT:</span> Подскажите, пожалуйста, номер терминала
          </div>
        </div>
      </Panel>
    </Section>
  );
}

/** Step 2: the real dialogues. The judge reads what the agent already said — the agent is not run. */
export function LogsView({ state, onGo, onCriteria }: { state: LabState; onGo: () => void; onCriteria: () => void }) {
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

  if (!state.logs.total) {
    return (
      <Page title="Логи" bare nav={nav} lede="Реальных диалогов пока нет. Загрузите выгрузку чата: судья проверит записанные разговоры агента по критериям, не запуская самого агента.">
        <div className="mt-6"><DropZone busy={busy} onFile={load} onPick={() => fileRef.current?.click()} /></div>
        <FormatHint />
        {picker}
      </Page>
    );
  }

  const noSources = !state.sources.length;
  const actions = (
    <>
      <Button size="sm" variant="ghost" icon={Upload} loading={busy} disabled={state.job.running} onClick={() => fileRef.current?.click()}>Новая выгрузка</Button>
      {d && <Button size="sm" variant="ghost" disabled={state.job.running} onClick={() => setConfirm(true)} title="Выделить критерии из источников заново">Новые критерии</Button>}
    </>
  );
  const toolbar = (
    <div className="mt-6 flex flex-wrap items-center gap-2">
      <Button variant={d ? "secondary" : "primary"} icon={FileText} disabled={state.job.running || noSources} onClick={() => run(false)}>{d ? "Оценить заново" : "Оценить логи"}</Button>
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
      <Page title="Логи" bare nav={nav} actions={actions} lede={`Выгрузка загружена: ${count(state.logs.total, "диалог", "диалога", "диалогов")}. Оцените их — судья проверит выбранное число диалогов по критериям агента.`}>
        {toolbar}
        <EmptyState className="mt-6" icon={FileText} title="Диалоги ещё не оценены">Выберите, сколько диалогов оценить, и нажмите «Оценить логи». На 20 диалогов уходит около минуты.</EmptyState>
      </Page>
    );
  }

  const s = d.summary;
  const rules = d.topics.reduce((n, t) => n + t.rules.length, 0);
  const topPattern = [...(s.patterns ?? [])].sort((a, b) => b.count - a.count)[0];
  const topics = d.topics.map(t => {
    const own = d.results.filter(r => r.topicId === t.id && (r.status === "PASS" || r.status === "FAIL"));
    return { id: t.id, title: t.title, rules: t.rules.length, checked: own.length, failed: own.filter(r => r.status === "FAIL").length };
  }).sort((a, b) => (b.checked ? b.failed / b.checked : 0) - (a.checked ? a.failed / a.checked : 0));
  const lede = `Нарушения в ${s.failed} из ${count(s.checked, "оценённого диалога", "оценённых диалогов", "оценённых диалогов")}${topPattern ? `; чаще всего — «${topPattern.rule}» (${count(topPattern.count, "диалог", "диалога", "диалогов")})` : ""}.`;

  return (
    <Page title="Логи" bare nav={nav} actions={actions} lede={lede}>
      <Confirm open={confirm} onClose={() => setConfirm(false)} onConfirm={() => run(true)} title="Выделить критерии заново?" action="Выделить заново" danger>
        Следующая оценка пойдёт по новым критериям, и её нельзя будет сравнить с прошлыми версиями.
      </Confirm>
      {toolbar}
      <Panel className="mt-5 grid gap-6 p-5 sm:grid-cols-3">
        <div>
          <div className="text-metric font-semibold tabular-nums text-lab-ink">{s.checked}<span className="ml-1.5 text-body font-normal text-lab-mute">из {state.logs.total}</span></div>
          <div className="mt-1 text-caption text-lab-mute">{plural(s.checked, "диалог оценён", "диалога оценено", "диалогов оценено")} · {whenLong(d.finishedAt)}</div>
        </div>
        <div>
          <div className={cn("text-metric font-semibold tabular-nums", s.failed ? "text-lab-bad" : "text-lab-ink")}>{s.failed}</div>
          <div className="mt-1 text-caption text-lab-mute">{plural(s.failed, "с нарушением", "с нарушениями", "с нарушениями")}{s.unmeasured ? ` · ещё ${s.unmeasured} без данных` : ""}</div>
        </div>
        <div>
          <div className="text-metric font-semibold tabular-nums text-lab-ink">{rules}</div>
          <div className="mt-1 text-caption text-lab-mute">{plural(rules, "критерий", "критерия", "критериев")} в {count(d.topics.length, "теме", "темах", "темах")}</div>
          {s.secondJudge && <Badge hue="ok" icon={ShieldCheck} className="mt-2">второй судья согласен в {pct(s.secondJudge.agree, s.secondJudge.checked)}%</Badge>}
        </div>
      </Panel>

      <Section title="Темы" hint="Каждый диалог попадает в одну тему и проверяется по её критериям; справа — сколько диалогов темы с нарушением" right={<LinkButton onClick={onCriteria}>Все критерии</LinkButton>}>
        <Panel className="overflow-hidden">
          {topics.map((t, k) => (
            <div key={t.id} className={cn("flex items-center gap-4 px-5 py-3", k > 0 && "border-t border-lab-line")}>
              <div className="min-w-0 flex-1">
                <div className="text-body text-lab-ink">{t.title}</div>
                <div className="mt-0.5 text-caption text-lab-mute">{count(t.rules, "критерий", "критерия", "критериев")}</div>
              </div>
              <div className="hidden w-[160px] sm:block">
                <div className="h-1 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full rounded-full bg-lab-bad/70" style={{ width: `${t.checked ? (100 * t.failed) / t.checked : 0}%` }} /></div>
              </div>
              <div className="w-[120px] whitespace-nowrap text-right text-body tabular-nums text-lab-mute" title={t.checked ? `С нарушением ${t.failed} из ${t.checked} диалогов темы` : undefined}>
                {t.checked ? <><span className={t.failed ? "font-semibold text-lab-ink" : ""}>{t.failed}</span> из {t.checked}</> : "не проверялась"}
              </div>
            </div>
          ))}
        </Panel>
      </Section>
      <NextStep done={cardsDone} title="Соберите сценарии для симулятора" hint="Из оценённых диалогов получатся ситуации клиента: симулятор сыграет их с каждой новой версией агента." to="/lab/checks" cta={cardsDone ? "К сценариям" : "Собрать сценарии"} />
    </Page>
  );
}
