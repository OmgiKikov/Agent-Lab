import { useEffect, useRef, useState } from "react";
import { ArrowRight, FileText } from "lucide-react";
import { api, upload } from "../../lab/api";
import { plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { useSource } from "../../lab/problems";
import { rememberName, rememberText, savedName, savedText, TONE_ID, toneResult } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { ExportPicker } from "../../product/ExportPicker";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { clarificationsOf, clarifiedText, toneDeck } from "./Criteria";
import { TakeRules } from "./TakeRules";

/**
 * The first step: which export to take the conversations from, and the rules of communication the criteria come from.
 */
export function Materials({
  state,
  exportId,
  onExport,
  onNext,
}: {
  state: LabState;
  exportId: string | null;
  onExport: (id: string) => void;
  onNext: () => void;
}) {
  const { refresh } = useLabState();
  const hasSource = state.sources.some((s) => s.id === TONE_ID);
  const source = useSource(hasSource ? TONE_ID : null);
  const [text, setText] = useState(savedText);
  const [name, setName] = useState(savedName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const edited = useRef(!!text);
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
  const readPolicy = (file: File) =>
    run(async () => {
      if (file.size > 2_000_000) throw new Error("Файл больше 2 МБ. Вставьте правила текстом.");
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
  // New rules replace the criteria and take the tone-of-voice result away, with the clarifications people confirmed
  // and the scenarios built from it (backend: store.replace_inputs): asked first whenever one of them is there. The same
  // rules only collect the criteria anew, and the result stays. Accuracy is not touched.
  const deck = toneDeck(state);
  const clarified = clarificationsOf(state.toneOfVoice);
  const next = () => {
    if (!unchanged && (toneResult(state) || clarified || deck)) setPending(true);
    else prepare();
  };
  const disabled = busy || state.job.running;
  return (
    <section aria-labelledby="materials-title">
      <h2 id="materials-title" className="text-title font-semibold text-fg">
        Выгрузка и правила общения
      </h2>
      <p className="mt-2 text-read text-fg-3">
        Из правил соберём критерии и проверим по ним ответы агента в разговорах выбранной выгрузки.
      </p>
      <div className="mt-8 grid gap-8 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div>
          <h3 className="text-read font-semibold text-fg">Выгрузка</h3>
          <p className="mt-1 text-body text-fg-3">Из какой выгрузки взять разговоры.</p>
          <div className="mt-4">
            <ExportPicker value={exportId} onChange={onExport} disabled={disabled} />
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
              ? `${text.length.toLocaleString("ru-RU")}\u00a0${plural(text.length, "символ", "символа", "символов")} · ${name}`
              : "Опишите конкретно, как агент должен общаться с клиентами."}
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
          <p>Не удалось загрузить сохранённые правила.</p>
          <Button className="mt-3" onClick={() => void source.refetch()}>
            Загрузить снова
          </Button>
        </div>
      )}
      <div className="mt-8 border-t border-line pt-5">
        <Button
          variant="primary"
          size="lg"
          icon={ArrowRight}
          loading={busy}
          disabled={disabled || !exportId || text.trim().length < 20 || (hasSource && !source.data)}
          onClick={next}
        >
          {reusable ? "К критериям" : "Собрать критерии"}
        </Button>
        {!exportId && <p className="mt-2 text-body text-fg-3">Сначала загрузите выгрузку.</p>}
      </div>
      <Modal
        open={pending}
        onClose={() => setPending(false)}
        title="Собрать критерии по новым правилам?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(false)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setPending(false);
                prepare();
              }}
            >
              Собрать критерии
            </Button>
          </>
        }
      >
        <p className="text-read text-fg-2">
          {toneResult(state) ? "Итог tone of voice уйдёт в «Историю». " : ""}
          Критерии соберутся заново по новым правилам.
          {deck ? " Сценарии, собранные из tone of voice, сбросятся." : ""} Итог точности не изменится.
        </p>
        {clarified > 0 && (
          <p className="mt-3 text-read text-fg-2">
            {clarifiedText(clarified, "У прежних критериев")} {clarified === 1 ? "Оно пропадёт" : "Они пропадут"},
            потому что правила изменились.
          </p>
        )}
      </Modal>
    </section>
  );
}
