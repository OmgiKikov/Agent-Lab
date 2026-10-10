import { useState } from "react";
import { Check, WandSparkles } from "lucide-react";
import { api } from "../../lab/api";
import { criterionName } from "../../lab/criteria";
import { count } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import type { RuleEntry } from "../../lab/problems";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import type { Suggestion } from "./Advice";

/** The corrected cases the service reads at most (backend flows/advice.py, CASES). */
const CASES = 10;

/** «Вы поправили модель в 4 случаях: в 3 она нашла ошибку, которой нет, в 1 пропустила ошибку.» */
function correctedText(found: number, missed: number): string {
  const kinds =
    found && missed
      ? `в\u00a0${found} она нашла ошибку, которой нет, в\u00a0${missed} пропустила ошибку`
      : found
        ? "она нашла ошибку, которой нет"
        : "она пропустила ошибку";
  return `Вы поправили модель в\u00a0${count(found + missed, "случае", "случаях", "случаях")}: ${kinds}.`;
}

const fieldCls =
  "w-full rounded-control border border-line-strong bg-canvas p-3 text-read text-fg focus:outline-none focus:ring-2 focus:ring-run/60";

/**
 * «Уточнить критерий»: the model reads every case of the current result where people corrected it by this criterion —
 * an error it found that is none, an error it missed — and proposes one clarification, with the person's own words on
 * what it gets wrong when they give them. The person edits it and saves it beside the criterion; the next check reads
 * it, and the answers on the criterion start over there, as they were given on the words it had.
 */
export function Clarify({ r, finishedAt, onClose }: { r: RuleEntry; finishedAt: string; onClose: () => void }) {
  const { state, refresh } = useLabState();
  const [openingRevision] = useState(state?.toneOfVoice?.revision);
  const [note, setNote] = useState("");
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ruleId = r.log.ruleIds[0];
  const corrected = r.log.examples.filter(
    (e) => e.ruleId === ruleId && e.review === "disagree" && e.reviewScope === "rule",
  );
  const found = corrected.filter((e) => e.status === "FAIL").length;
  const stale = state?.toneOfVoice?.revision !== openingRevision || state?.checks.tone?.finishedAt !== finishedAt;
  const busy = pending || !!state?.job.running;
  const act = async (work: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
      await refresh();
    }
  };
  const propose = () =>
    act(async () => {
      const value = await api<Suggestion>("/api/tone-of-voice/clarification/proposal", {
        finishedAt,
        ruleId,
        note: note.trim(),
      });
      setSuggestion(value);
      setText(value.text);
    });
  const save = () =>
    act(async () => {
      await api("/api/tone-of-voice/clarification", { revision: openingRevision, ruleId, text: text.trim() });
      setSaved(true);
    });
  return (
    <Sheet open onClose={onClose} title="Уточнить критерий">
      <div className="space-y-6 px-5 py-6 sm:px-7">
        <div>
          <p className="text-lead font-semibold text-fg">{criterionName(r)}</p>
          {corrected.length > 0 && (
            <p className="mt-2 text-read text-fg-2">
              {correctedText(found, corrected.length - found)} Модель прочитает{" "}
              {corrected.length > CASES ? `${CASES} из них` : "их"} и предложит одну формулировку: когда критерий
              применяется и что допустимо.
            </p>
          )}
        </div>
        {saved ? (
          <div role="status" className="space-y-3">
            <p className="flex items-center gap-2 text-lead font-semibold text-fg">
              <Check className="size-5 text-ok" />
              Уточнение сохранено
            </p>
            <p className="text-read text-fg-2">
              Оно применится в следующей проверке. Там ответы по этому критерию начнутся заново: прежние относились к
              старой формулировке.
            </p>
            <Button size="lg" onClick={onClose}>
              Готово
            </Button>
          </div>
        ) : (
          <>
            {!suggestion && (
              <>
                <div>
                  <label htmlFor="clarify-note" className="text-read font-medium text-fg">
                    Что модель понимает не так?
                  </label>
                  <p className="mt-1 text-body text-fg-3">Необязательно. Ваши слова сделают уточнение точнее.</p>
                  <textarea
                    id="clarify-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={2000}
                    rows={3}
                    disabled={pending}
                    className={`mt-3 ${fieldCls}`}
                  />
                </div>
                <Button
                  size="lg"
                  variant="primary"
                  icon={WandSparkles}
                  loading={pending}
                  disabled={busy || stale || !corrected.length}
                  onClick={propose}
                >
                  Предложить уточнение
                </Button>
              </>
            )}
            {suggestion && (
              <div className="space-y-3 border-t border-line pt-6">
                <label htmlFor="clarify-text" className="text-read font-semibold text-fg">
                  Уточнение для следующей проверки
                </label>
                <textarea
                  id="clarify-text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  maxLength={2000}
                  rows={6}
                  className={fieldCls}
                />
                <p className="text-read text-fg-2">{suggestion.explanation}</p>
                <p className="text-body text-fg-3">
                  Документ с правилами не изменится. Уточнение добавится к критерию отдельно.
                </p>
                <Button
                  size="lg"
                  variant="primary"
                  loading={pending}
                  disabled={busy || stale || text.trim().length < 10}
                  onClick={save}
                >
                  Сохранить уточнение
                </Button>
              </div>
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
          </>
        )}
      </div>
    </Sheet>
  );
}
