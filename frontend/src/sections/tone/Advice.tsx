import { useState } from "react";
import { Check, Copy, WandSparkles } from "lucide-react";
import { api } from "../../lab/api";
import { useLabState } from "../../lab/LabProvider";
import type { Example } from "../../lab/problems";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";

export type Suggestion = { text: string; explanation: string };

/**
 * «Как ответить правильно» on an error: the model proposes how the agent's words could read by the criterion. Always a
 * preview to copy, never a change: the rules, the quote and the verdict stay as they are.
 */
export function Advice({
  example,
  finishedAt,
  onClose,
}: {
  example: Example;
  finishedAt: string;
  onClose: () => void;
}) {
  const { state, refresh } = useLabState();
  const [openingRevision] = useState(state?.toneOfVoice?.revision);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stale = state?.toneOfVoice?.revision !== openingRevision || state?.checks.tone?.finishedAt !== finishedAt;
  const busy = pending || !!state?.job.running;
  const generate = async () => {
    setPending(true);
    setError(null);
    try {
      setSuggestion(
        await api<Suggestion>("/api/tone-of-voice/advice", {
          finishedAt,
          dialogueId: example.dialogueId,
          ruleId: example.ruleId,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
      await refresh();
    }
  };
  return (
    <Sheet open onClose={onClose} title="Как ответить правильно">
      <div className="space-y-6 px-5 py-6 sm:px-7">
        <div>
          <p className="text-small font-medium text-fg-3">Слова агента</p>
          <blockquote className="mt-2 whitespace-pre-wrap rounded-block bg-inset p-4 text-read text-fg">
            {example.agentQuote || "Цитата не сохранена. Откройте разговор целиком."}
          </blockquote>
        </div>
        <p className="text-read text-fg-2">
          Модель предложит, как переписать ответ по этому критерию. Прежде чем использовать вариант, проверьте, что
          смысл, условия и обязательные формулировки сохранились.
        </p>
        {suggestion ? (
          <div className="space-y-3 border-t border-line pt-6">
            <p className="text-read font-semibold text-fg">Предложенный вариант</p>
            <blockquote className="whitespace-pre-wrap rounded-block bg-inset p-4 text-lead text-fg">
              {suggestion.text}
            </blockquote>
            <p className="text-read text-fg-2">{suggestion.explanation}</p>
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
          </div>
        ) : (
          <Button
            size="lg"
            variant="primary"
            icon={WandSparkles}
            loading={pending}
            disabled={busy || stale}
            onClick={generate}
          >
            Предложить формулировку
          </Button>
        )}
        {stale && (
          <p role="alert" className="text-read text-warn">
            Проверка или критерии изменились. Закройте окно и откройте его заново.
          </p>
        )}
        {error && (
          <p role="alert" className="text-read text-bad">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
