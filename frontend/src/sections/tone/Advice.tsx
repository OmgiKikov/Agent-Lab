import { useState } from "react";
import { Check, Copy, WandSparkles } from "lucide-react";
import { api } from "../../lab/api";
import { useLabState } from "../../lab/LabProvider";
import type { Example } from "../../lab/problems";
import type { ToneDraft } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";

type Suggestion = { text: string; explanation: string };

/** A model suggestion is always previewed; only the user's explicit save changes a criterion. */
export function Advice({
  mode,
  example,
  finishedAt,
  draft,
  onClose,
}: {
  mode: "rewrite" | "clarify";
  example: Example;
  finishedAt: string;
  draft: ToneDraft;
  onClose: () => void;
}) {
  const { state, refresh } = useLabState();
  const [openingRevision] = useState(draft.revision);
  const [note, setNote] = useState("");
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clarify = mode === "clarify";
  const stale = state?.toneOfVoice?.revision !== openingRevision || state?.checks.tone?.finishedAt !== finishedAt;
  const busy = pending || !!state?.job.running;
  const generate = async () => {
    setPending(true);
    setError(null);
    try {
      const value = await api<Suggestion>("/api/tone-of-voice/advice", {
        finishedAt,
        dialogueId: example.dialogueId,
        ruleId: example.ruleId,
        mode,
        ...(clarify ? { note: note.trim() } : {}),
      });
      setSuggestion(value);
      setText(value.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
      await refresh();
    }
  };
  const apply = async () => {
    setPending(true);
    setError(null);
    try {
      await api("/api/tone-of-voice/clarification", {
        revision: openingRevision,
        ruleId: example.ruleId,
        text: text.trim(),
      });
      setSaved(true);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <Sheet open onClose={onClose} title={clarify ? "Уточнить критерий" : "Переформулировать ответ"}>
      <div className="space-y-6 px-5 py-6 sm:px-7">
        <div>
          <p className="text-small font-medium text-fg-3">Слова агента</p>
          <blockquote className="mt-2 whitespace-pre-wrap rounded-block bg-inset p-4 text-read text-fg">
            {example.agentQuote || "Цитата не сохранена. Откройте разговор целиком."}
          </blockquote>
        </div>
        {saved ? (
          <div role="status" className="space-y-3">
            <p className="flex items-center gap-2 text-lead font-semibold text-fg">
              <Check className="size-5 text-ok" />
              Уточнение сохранено
            </p>
            <p className="text-read text-fg-2">
              Оно применится в следующей проверке. Этот итог посчитан по предыдущей версии критериев.
            </p>
            <Button size="lg" onClick={onClose}>
              Готово
            </Button>
          </div>
        ) : (
          <>
            {clarify ? (
              <div>
                <label htmlFor="clarification-note" className="text-read font-medium text-fg">
                  Почему этот случай допустим?
                </label>
                <p className="mt-1 text-body text-fg-3">
                  Опишите условие или исключение. Модель предложит уточнение, и до сохранения его можно изменить.
                </p>
                <textarea
                  id="clarification-note"
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    setSuggestion(null);
                  }}
                  maxLength={2000}
                  rows={4}
                  disabled={pending}
                  className="mt-3 w-full rounded-control border border-line-strong bg-canvas p-3 text-read text-fg focus:outline-none focus:ring-2 focus:ring-run/60"
                />
              </div>
            ) : (
              <p className="text-read text-fg-2">
                Модель предложит, как переписать ответ по этому критерию. Прежде чем использовать вариант, проверьте,
                что смысл, условия и обязательные формулировки сохранились.
              </p>
            )}
            {!suggestion && (
              <Button
                size="lg"
                variant="primary"
                icon={WandSparkles}
                loading={pending}
                disabled={busy || stale || (clarify && note.trim().length < 10)}
                onClick={generate}
              >
                {clarify ? "Предложить уточнение" : "Предложить формулировку"}
              </Button>
            )}
            {suggestion && (
              <div className="space-y-3 border-t border-line pt-6">
                <label htmlFor="advice-text" className="text-read font-semibold text-fg">
                  {clarify ? "Уточнение для следующей проверки" : "Предложенный вариант"}
                </label>
                {clarify ? (
                  <textarea
                    id="advice-text"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    maxLength={2000}
                    rows={6}
                    className="w-full rounded-control border border-line-strong bg-canvas p-3 text-read text-fg focus:outline-none focus:ring-2 focus:ring-run/60"
                  />
                ) : (
                  <blockquote className="whitespace-pre-wrap rounded-block bg-inset p-4 text-lead text-fg">
                    {suggestion.text}
                  </blockquote>
                )}
                <p className="text-read text-fg-2">{suggestion.explanation}</p>
                {clarify ? (
                  <>
                    <p className="text-body text-fg-3">
                      Документ с правилами не изменится. Уточнение добавится к критерию отдельно.
                    </p>
                    <Button
                      size="lg"
                      variant="primary"
                      loading={pending}
                      disabled={busy || stale || text.trim().length < 10 || text.length > 2000}
                      onClick={apply}
                    >
                      Сохранить уточнение
                    </Button>
                  </>
                ) : (
                  <Button
                    size="lg"
                    icon={copied ? Check : Copy}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(suggestion.text);
                        setCopied(true);
                      } catch {
                        setError("Не удалось скопировать. Выделите текст и скопируйте вручную.");
                      }
                    }}
                  >
                    {copied ? "Скопировано" : "Скопировать вариант"}
                  </Button>
                )}
              </div>
            )}
            {stale && (
              <p role="alert" className="text-read text-warn">
                Проверка или критерии изменились. Закройте окно и откройте находку заново.
              </p>
            )}
            {error && (
              <p role="alert" className="text-read text-bad">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
