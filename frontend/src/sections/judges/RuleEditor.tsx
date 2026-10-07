import { useState } from "react";
import { Plus, Trash2, Upload } from "lucide-react";
import { api, upload } from "../../lab/api";
import { useJudges, type JudgeVersion } from "../../lab/judges";
import { useLabState } from "../../lab/LabProvider";
import type { Check, ToneCriterion } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";

const FIELD = "mt-1 w-full rounded-control border border-line-strong bg-canvas px-3 py-2 text-body text-fg";
const fresh = (): ToneCriterion => ({
  id: crypto.randomUUID(),
  name: "",
  text: "",
  quote: "",
  condition: "",
  acceptable: "",
});
export function RuleEditor({
  check,
  version,
  baseId,
  onClose,
}: {
  check: Check;
  version: JudgeVersion | null;
  baseId?: string;
  onClose: () => void;
}) {
  const library = useJudges(check);
  const [expectedBase] = useState(baseId ?? version?.id);
  const { state } = useLabState();
  const [name, setName] = useState(version ? `${version.name}${version.builtin ? " · моя версия" : ""}` : "");
  const [policy, setPolicy] = useState(version?.policy ?? "");
  const [rules, setRules] = useState<ToneCriterion[]>(version?.criteria ?? [fresh()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const patch = (i: number, change: Partial<ToneCriterion>) =>
    setRules((all) => all.map((r, index) => (index === i ? { ...r, ...change } : r)));
  const read = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const value = await upload<{ name: string; text: string }>("/api/tone-of-voice/read-file", file);
      setPolicy(value.text);
      if (!name) setName(file.name.replace(/\.[^.]+$/, ""));
      setRules([{ ...fresh(), name: "Правила документа", text: value.text, quote: value.text }]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/judges/${check}`, {
        name,
        policy,
        criteria: rules,
        setId: version && !version.builtin ? version.setId : null,
        baseId: version && !version.builtin ? expectedBase : null,
      });
      await library.reload();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const valid =
    name.trim() && policy.trim().length >= 20 && rules.length > 0 && rules.every((r) => r.name.trim() && r.text.trim());
  return (
    <Sheet
      open
      onClose={() => !busy && onClose()}
      title={version ? "Новая версия правил" : "Новый набор правил"}
      sub="Предыдущие версии и результаты проверок сохранятся."
      actions={
        <Button variant="primary" loading={busy} disabled={!valid || state?.job.running} onClick={save}>
          Сохранить и выбрать
        </Button>
      }
      width="lg"
    >
      <fieldset disabled={busy || state?.job.running} className="space-y-6 p-5 sm:p-7">
        <label className="block text-body font-medium text-fg">
          Название набора
          <input autoFocus maxLength={160} value={name} onChange={(e) => setName(e.target.value)} className={FIELD} />
        </label>
        <div>
          <label className="block text-body font-medium text-fg">
            Правила
            <textarea
              rows={5}
              value={policy}
              maxLength={50000}
              onChange={(e) => setPolicy(e.target.value)}
              className={FIELD}
            />
          </label>
          <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-body font-medium text-fg">
            <Upload className="size-4" />
            Загрузить MD, TXT или Word
            <input
              type="file"
              accept=".md,.txt,.docx"
              className="sr-only"
              onChange={(e) => {
                void read(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <p className="mt-2 text-small text-fg-3">
            Из файла сначала добавляется один критерий со всем текстом. Разделите его на отдельные требования или
            сформируйте критерии автоматически после сохранения.
          </p>
        </div>
        <section>
          <h2 className="text-read font-semibold text-fg">Критерии · {rules.length}</h2>
          <div className="mt-3 space-y-4">
            {rules.map((rule, i) => (
              <div key={rule.id} className="rounded-block border border-line bg-canvas p-4">
                <div className="flex items-center gap-3">
                  <span className="text-small text-fg-3">{i + 1}</span>
                  <input
                    aria-label={`Название критерия ${i + 1}`}
                    value={rule.name}
                    maxLength={200}
                    onChange={(e) => patch(i, { name: e.target.value })}
                    placeholder="Название критерия"
                    className={`${FIELD} !mt-0`}
                  />
                  <Button
                    variant="ghost"
                    icon={Trash2}
                    aria-label={`Удалить критерий ${i + 1}`}
                    onClick={() => setRules((all) => all.filter((_, index) => index !== i))}
                  />
                </div>
                <label className="mt-3 block text-small text-fg-3">
                  Что должен делать агент
                  <textarea
                    rows={3}
                    value={rule.text}
                    maxLength={50000}
                    onChange={(e) => patch(i, { text: e.target.value, quote: "" })}
                    className={FIELD}
                  />
                </label>
                <details className="mt-3">
                  <summary className="cursor-pointer text-small text-fg-3">Условия и допустимые ответы</summary>
                  <label className="mt-2 block text-small text-fg-3">
                    Когда применять
                    <input
                      value={rule.condition}
                      onChange={(e) => patch(i, { condition: e.target.value })}
                      maxLength={5000}
                      className={FIELD}
                    />
                  </label>
                  <label className="mt-2 block text-small text-fg-3">
                    Что считать допустимым
                    <textarea
                      value={rule.acceptable}
                      maxLength={5000}
                      onChange={(e) => patch(i, { acceptable: e.target.value })}
                      className={FIELD}
                    />
                  </label>
                </details>
              </div>
            ))}
          </div>
          <Button
            className="mt-4"
            icon={Plus}
            disabled={rules.length >= 100}
            onClick={() => setRules((all) => [...all, fresh()])}
          >
            Добавить критерий
          </Button>
        </section>
        {error && (
          <p role="alert" className="text-read text-bad">
            {error}
          </p>
        )}
        <p className="text-small text-fg-3">
          Сохранение выберет новую версию для следующих запусков. Сценарии по прежним критериям потребуется собрать
          заново.
        </p>
      </fieldset>
    </Sheet>
  );
}
