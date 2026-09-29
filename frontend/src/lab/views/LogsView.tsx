import { useRef, useState } from "react";
import { FileText, ShieldCheck, TriangleAlert, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropPixelGrid } from "../../components/DropPixelGrid";
import { post, upload } from "../api";
import { plural, pct, when } from "../format";
import { JobLine } from "../JobLine";
import { Confirm } from "../modal";
import { useToast } from "../toast";
import type { LabState } from "../types";
import { Badge, Button, EmptyState, Eyebrow, inputClass, Page, Panel, titleFont } from "../ui";

const LEDE =
  "Настоящие разговоры из выгрузки чата. Судья проверяет их по критериям агента; сам агент при этом не запускается, судья оценивает только то, что уже было сказано.";

function DropZone({ busy, onFile, onPick }: { busy: boolean; onFile: (f: File) => void; onPick: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      className={cn(
        "flex flex-col items-center rounded-2xl border border-dashed px-8 py-14 text-center transition-colors",
        over ? "border-lab-accent/70 bg-lab-accent/[0.06]" : "border-white/[0.16] bg-white/[0.02]",
      )}
    >
      <div className="mb-5">
        <DropPixelGrid px={2} gap={1.5} fillRgb="142,157,166" />
      </div>
      <div className="text-[18px] font-medium text-lab-ink" style={titleFont}>
        Перетащите выгрузку сюда
      </div>
      <div className="mt-2 max-w-[420px] text-[13px] leading-relaxed text-lab-dim">
        Или выберите файл на компьютере. Выгрузка будет сохранена в Agent Lab.
      </div>
      <Button className="mt-6" variant="primary" icon={Upload} loading={busy} onClick={onPick}>
        Выбрать файл
      </Button>
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
          <span className="text-lab-accent">CLIENT:</span> Не проходит оплата картой на терминале
          <br />
          <span className="text-lab-ok">AGENT:</span> Подскажите, пожалуйста, номер терминала
        </div>
      </div>
    </Panel>
  );
}

export function LogsView({ state, onGo, onCriteria }: { state: LabState; onGo: () => void; onCriteria: () => void }) {
  const { error } = useToast();
  const d = state.discover;
  const [sample, setSample] = useState(d?.sampled ?? 60);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = (replan = false) => post("/api/discover", { count: sample, replan }).catch(error);
  const load = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      await upload("/api/logs", file);
    } catch (e) {
      error(e);
    }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  };
  const picker = (
    <input
      ref={fileRef}
      type="file"
      accept=".xlsx,.jsonl"
      className="hidden"
      onChange={(e) => load(e.target.files?.[0])}
    />
  );

  if (!state.logs.total) {
    return (
      <Page title="логи" lede={LEDE}>
        <div className="mt-5">
          <DropZone busy={busy} onFile={load} onPick={() => fileRef.current?.click()} />
        </div>
        <FormatHint />
        {picker}
      </Page>
    );
  }

  const noSources = !state.sources.length;
  const toolbar = (
    <div className="mt-5 flex flex-wrap items-center gap-2">
      <Button variant="primary" icon={FileText} disabled={state.job.running || noSources} onClick={() => run(false)}>
        {d ? "Оценить заново" : "Оценить логи"}
      </Button>
      <select
        value={sample}
        onChange={(e) => setSample(+e.target.value)}
        aria-label="Сколько разговоров оценить"
        className={cn(inputClass, "w-auto cursor-pointer pr-8")}
      >
        {[20, 40, 60, 100, 200].map((n) => (
          <option key={n} value={n}>
            {n} {plural(n, "разговор", "разговора", "разговоров")}
          </option>
        ))}
      </select>
      <JobLine state={state} kind="discover" />
      <div className="ml-auto flex items-center gap-1">
        <span className="mr-2 text-[12px] text-lab-dim">В выгрузке {state.logs.total}</span>
        <Button
          size="sm"
          variant="ghost"
          icon={Upload}
          loading={busy}
          disabled={state.job.running}
          onClick={() => fileRef.current?.click()}
        >
          Новая выгрузка
        </Button>
        {d && (
          <Button size="sm" variant="ghost" disabled={state.job.running} onClick={() => setConfirm(true)}>
            Новые правила
          </Button>
        )}
      </div>
      {noSources && (
        <div className="flex w-full items-center gap-2 text-[12px] text-lab-warn">
          <TriangleAlert className="size-3.5" />
          Судье пока не на что опереться.
          <button className="underline underline-offset-2 hover:text-lab-ink" onClick={onGo}>
            Соберите контекст агента
          </button>
        </div>
      )}
      {picker}
    </div>
  );

  if (!d) {
    return (
      <Page title="логи" lede={LEDE}>
        {toolbar}
        <EmptyState
          className="mt-5"
          icon={FileText}
          title={`Выгрузка загружена: ${state.logs.total} ${plural(state.logs.total, "разговор", "разговора", "разговоров")}`}
        >
          Нажмите «Оценить логи»: судья проверит выбранное число разговоров и покажет, какие правила промпта агент
          нарушает чаще всего.
        </EmptyState>
      </Page>
    );
  }

  const s = d.summary;
  const rules = d.topics.reduce((n, t) => n + t.rules.length, 0);
  const topics = d.topics
    .map((t) => {
      const own = d.results.filter((r) => r.topicId === t.id && (r.status === "PASS" || r.status === "FAIL"));
      return {
        id: t.id,
        title: t.title,
        rules: t.rules.length,
        checked: own.length,
        failed: own.filter((r) => r.status === "FAIL").length,
      };
    })
    .sort((a, b) => (b.checked ? b.failed / b.checked : 0) - (a.checked ? a.failed / a.checked : 0));
  return (
    <Page title="логи" lede={LEDE}>
      {toolbar}
      <Confirm
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => run(true)}
        title="Выделить правила заново?"
        action="Выделить заново"
      >
        Следующая оценка пойдёт по новым правилам, поэтому её нельзя будет сравнить с текущей.
      </Confirm>
      <Panel className="mt-5 overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-5 py-4">
          <div>
            <div className="text-[28px] font-medium leading-none text-lab-ink" style={titleFont}>
              {s.checked}
              <span className="ml-1.5 text-[14px] text-lab-mute">из {state.logs.total}</span>
            </div>
            <div className="mt-1 text-[11px] text-lab-dim">
              {plural(s.checked, "разговор оценён", "разговора оценено", "разговоров оценено")} · {when(d.finishedAt)}
            </div>
          </div>
          <div>
            <div
              className={cn("text-[28px] font-medium leading-none", s.failed ? "text-lab-bad" : "text-lab-ink")}
              style={titleFont}
            >
              {s.failed}
            </div>
            <div className="mt-1 text-[11px] text-lab-dim">
              {plural(s.failed, "с нарушением", "с нарушениями", "с нарушениями")}
            </div>
          </div>
          <div>
            <div className="text-[28px] font-medium leading-none text-lab-ink" style={titleFont}>
              {rules}
            </div>
            <div className="mt-1 text-[11px] text-lab-dim">
              {plural(rules, "критерий", "критерия", "критериев")} в {d.topics.length}{" "}
              {plural(d.topics.length, "теме", "темах", "темах")}
            </div>
          </div>
          {s.secondJudge && (
            <Badge hue="ok" icon={ShieldCheck}>
              второй судья согласен в {pct(s.secondJudge.agree, s.secondJudge.checked)}
            </Badge>
          )}
          <Button className="ml-auto" variant="primary" onClick={onCriteria}>
            Открыть критерии
          </Button>
        </div>
      </Panel>
      <div className="mb-2.5 mt-7">
        <h2 className="text-[14px] font-medium text-lab-text">Темы и критерии</h2>
        <p className="mt-0.5 text-[11px] text-lab-dim">
          Каждый разговор попадает в одну тему и проверяется по её критериям. Что именно нарушается, смотрите на экранах
          «Критерии» и «Диалоги»: там логи и симулятор считаются вместе.
        </p>
      </div>
      <Panel className="overflow-hidden">
        {topics.map((t) => (
          <div key={t.id} className="flex items-center gap-4 border-t border-white/[0.06] px-5 py-3 first:border-t-0">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-lab-text">{t.title}</div>
              <div className="mt-0.5 text-[11px] text-lab-dim">
                {t.rules} {plural(t.rules, "критерий", "критерия", "критериев")}
              </div>
            </div>
            <div className="hidden w-[140px] min-[820px]:block">
              <div className="h-1 overflow-hidden rounded-full bg-white/[0.07]">
                <div
                  className="h-full rounded-full bg-lab-bad"
                  style={{ width: `${t.checked ? (100 * t.failed) / t.checked : 0}%` }}
                />
              </div>
            </div>
            <div className="w-[120px] text-right font-mono text-[11px] text-lab-dim">
              {t.checked ? (
                <>
                  нарушений <span className={t.failed ? "text-lab-bad" : "text-lab-mute"}>{t.failed}</span> из{" "}
                  {t.checked}
                </>
              ) : (
                "не проверялась"
              )}
            </div>
          </div>
        ))}
      </Panel>
    </Page>
  );
}
