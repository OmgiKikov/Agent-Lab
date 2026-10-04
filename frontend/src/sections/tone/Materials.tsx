import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, FileText, Upload } from "lucide-react";
import { api, upload } from "../../lab/api";
import { count } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { useSource } from "../../lab/problems";
import { rememberName, rememberText, savedName, savedText, TONE_ID, toneResult } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { exportFileError, ReplaceExport, replacesResult } from "../../product/UploadLogs";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { TakeRules } from "./TakeRules";

export function Materials({ state, onNext }: { state: LabState; onNext: () => void }) {
  const { refresh } = useLabState();
  const hasSource = state.sources.some((s) => s.id === TONE_ID);
  const source = useSource(hasSource ? TONE_ID : null);
  const [text, setText] = useState(savedText);
  const [name, setName] = useState(savedName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ file?: File; next?: boolean } | null>(null);
  const edited = useRef(!!text);
  const logInput = useRef<HTMLInputElement>(null);
  const policyInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (source.data && !edited.current) {
      setText(source.data.content);
      setName(source.data.origin);
      rememberName(source.data.origin);
    }
  }, [source.data]);
  const change = (value: string) => {
    edited.current = true;
    setText(value);
    rememberText(value);
  };
  // Rules taken from another agent are this agent's now: the form shows them, not a text typed before. With criteria
  // ready, the next step is to check them.
  const taken = (criteria: boolean) => {
    edited.current = false;
    rememberText("");
    if (source.data) {
      setText(source.data.content);
      setName(source.data.origin);
    }
    if (criteria) onNext();
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const sendLogs = (file: File) =>
    run(async () => {
      await upload("/api/logs", file);
      await refresh();
    });
  const readPolicy = (file: File) =>
    run(async () => {
      if (file.size > 2_000_000) throw new Error("Файл слишком большой: не более 2 МБ.");
      const parsed = await upload<{ text: string; name: string }>("/api/tone-of-voice/read-file", file);
      change(parsed.text);
      setName(parsed.name);
      rememberName(parsed.name);
    });
  const unchanged = source.data?.content.trim() === text.trim();
  const reusable = unchanged && !!state.toneOfVoice;
  const prepare = () =>
    run(async () => {
      if (!unchanged) await api("/api/tone-of-voice/policy", { text: text.trim(), name });
      if (!reusable) await api("/api/tone-of-voice/criteria", {});
      await refresh();
      onNext();
    });
  // New rules replace the criteria and take the tone-of-voice result away, with the scenarios built from it (backend:
  // store.replace_inputs); the same rules only collect the criteria anew, and the result stays. Accuracy is not touched.
  const next = () => {
    if (toneResult(state) && !unchanged) setPending({ next: true });
    else prepare();
  };
  const deck = state.cards?.check === "tone" && !!state.cards.cards.length;
  const disabled = busy || state.job.running;
  return (
    <section aria-labelledby="materials-title">
      <h2 id="materials-title" className="text-title font-semibold text-fg">
        Добавьте разговоры и правила общения
      </h2>
      <p className="mt-2 text-read text-fg-3">Из правил соберём критерии и проверим по ним ответы агента.</p>
      <div className="mt-8 grid gap-8 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div>
          <h3 className="text-read font-semibold text-fg">Разговоры</h3>
          <p className="mt-1 text-body text-fg-3">Выгрузка чата: Excel (.xlsx) или JSONL.</p>
          <input
            ref={logInput}
            type="file"
            accept=".xlsx,.jsonl"
            className="hidden"
            aria-label="Файл разговоров"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              const wrong = exportFileError(f);
              if (wrong) setError(wrong);
              else if (replacesResult(state)) setPending({ file: f });
              else sendLogs(f);
            }}
          />
          <div className="mt-4 rounded-sheet bg-inset p-5">
            {state.logs.total ? (
              <>
                <p className="flex items-center gap-2 text-read font-medium text-fg">
                  <Check aria-hidden className="size-4 text-ok" />
                  {count(state.logs.total, "разговор", "разговора", "разговоров")}
                </p>
                <p className="mt-1 break-words text-body text-fg-3">{state.logs.file ?? "Загруженная выгрузка"}</p>
              </>
            ) : (
              <p className="text-read text-fg-2">Разговоры ещё не загружены</p>
            )}
            <Button className="mt-4" icon={Upload} disabled={disabled} onClick={() => logInput.current?.click()}>
              {state.logs.total ? "Другая выгрузка" : "Загрузить разговоры"}
            </Button>
          </div>
        </div>
        <div>
          <label htmlFor="tone-policy" className="block text-read font-semibold text-fg">
            Правила общения
          </label>
          <p className="mt-1 text-body text-fg-3">Вставьте текст или загрузите Word, TXT, Markdown.</p>
          <input
            ref={policyInput}
            type="file"
            accept=".docx,.txt,.md"
            aria-label="Файл правил общения"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) readPolicy(f);
            }}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button icon={FileText} disabled={disabled} onClick={() => policyInput.current?.click()}>
              Загрузить правила
            </Button>
            <TakeRules state={state} disabled={disabled} onTaken={taken} />
          </div>
          <textarea
            id="tone-policy"
            name="tone-policy"
            rows={9}
            value={text}
            onChange={(e) => change(e.target.value)}
            disabled={disabled}
            maxLength={50000}
            placeholder="Например: обращайтесь к клиенту на «вы», не используйте жаргон, извиняйтесь не более одного раза за разговор…"
            className="mt-3 w-full resize-y rounded-block border border-line-strong bg-canvas px-4 py-3 text-read leading-relaxed text-fg outline-none placeholder:text-fg-4 focus:border-fg-3 disabled:opacity-60"
          />
          <p className="mt-1 text-small text-fg-3">
            {text.length
              ? `${text.length.toLocaleString("ru-RU")} символов · ${name}`
              : "Нужны конкретные требования к тому, как агент общается."}
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-5 text-read text-bad">
          {error}
        </p>
      )}
      {hasSource && source.isError && (
        <div role="alert" className="mt-5 text-read text-bad">
          <p>Не удалось загрузить сохранённые правила. Повторите загрузку перед продолжением.</p>
          <Button className="mt-3" onClick={() => void source.refetch()}>
            Загрузить сохранённые правила
          </Button>
        </div>
      )}
      <div className="mt-8 border-t border-line pt-5">
        <Button
          variant="primary"
          size="lg"
          icon={ArrowRight}
          loading={busy}
          disabled={disabled || !state.logs.total || text.trim().length < 20 || (hasSource && !source.data)}
          onClick={next}
        >
          {reusable ? "Продолжить с этими критериями" : "Собрать критерии"}
        </Button>
        {!state.logs.total && <p className="mt-2 text-body text-fg-3">Сначала загрузите разговоры.</p>}
      </div>
      <ReplaceExport
        open={!!pending?.file}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const file = pending?.file;
          setPending(null);
          if (file) sendLogs(file);
        }}
      />
      <Modal
        open={!!pending?.next}
        onClose={() => setPending(null)}
        title="Собрать критерии по новым правилам?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setPending(null);
                prepare();
              }}
            >
              Собрать заново
            </Button>
          </>
        }
      >
        <p className="text-read text-fg-2">
          Правила изменились: итог tone of voice уйдёт из раздела и «Обзора», критерии соберутся заново, а ваши
          уточнения к прежним критериям не перейдут.{deck ? " Сценарии, собранные из tone of voice, сбросятся." : ""}{" "}
          Сама проверка останется в истории; итог точности не изменится.
        </p>
      </Modal>
    </section>
  );
}
