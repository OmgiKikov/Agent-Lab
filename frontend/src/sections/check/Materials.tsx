import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, FileText, Upload } from "lucide-react";
import { api, upload } from "../../lab/api";
import { count } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { useSource } from "../../lab/problems";
import { rememberName, rememberText, savedName, savedText, TONE_ID } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";

export function Materials({ state, onNext }: { state: LabState; onNext: () => void }) {
  const { refresh } = useLabState();
  const source = useSource(state.sources.some((s) => s.id === TONE_ID) ? TONE_ID : null);
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
  const prepare = () =>
    run(async () => {
      await api("/api/tone-of-voice/policy", { text: text.trim(), name });
      await api("/api/tone-of-voice/criteria", {});
      await refresh();
      onNext();
    });
  const next = () => {
    if (state.discover) setPending({ next: true });
    else prepare();
  };
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
              if (f) {
                if (state.discover || state.toneOfVoice) setPending({ file: f });
                else sendLogs(f);
              }
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
            Правила tone of voice
          </label>
          <p className="mt-1 text-body text-fg-3">Вставьте текст или загрузите Word, TXT, Markdown.</p>
          <input
            ref={policyInput}
            type="file"
            accept=".docx,.txt,.md"
            aria-label="Файл правил tone of voice"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) readPolicy(f);
            }}
          />
          <Button className="mt-3" icon={FileText} disabled={disabled} onClick={() => policyInput.current?.click()}>
            Загрузить правила
          </Button>
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
      <div className="mt-8 border-t border-line pt-5">
        <Button
          variant="primary"
          size="lg"
          icon={ArrowRight}
          loading={busy}
          disabled={disabled || !state.logs.total || text.trim().length < 20}
          onClick={next}
        >
          Собрать критерии
        </Button>
        {!state.logs.total && <p className="mt-2 text-body text-fg-3">Сначала загрузите разговоры.</p>}
      </div>
      <Modal
        open={!!pending}
        onClose={() => setPending(null)}
        title="Начать новую проверку?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const p = pending;
                setPending(null);
                if (p?.file) sendLogs(p.file);
                else if (p?.next) prepare();
              }}
            >
              Продолжить
            </Button>
          </>
        }
      >
        <p className="text-read text-fg-2">
          Текущая оценка разговоров и собранные сценарии будут заменены. Сохранённые прогоны симуляций останутся
          доступны.
        </p>
      </Modal>
    </section>
  );
}
