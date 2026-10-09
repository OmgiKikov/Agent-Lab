import { Input, Textarea } from "../../ui/Field";
import { useEffect, useRef, useState } from "react";
import { agentKey } from "../../app/agent";
import { Plus, Trash2, Upload } from "lucide-react";
import { api, upload } from "../../lab/api";
import { useJudges, type JudgeVersion } from "../../lab/judges";
import { useLabState } from "../../lab/LabProvider";
import type { Check, ToneCriterion } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";

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
  replacesResult,
  onClose,
}: {
  check: Check;
  version: JudgeVersion | null;
  baseId?: string;
  /** The check has a result now: saving makes these rules current and sends that result to the history. */
  replacesResult?: boolean;
  onClose: () => void;
}) {
  const library = useJudges(check);
  const draftKey = agentKey(`rule-draft-${check}-${version?.id ?? "new"}`);
  const [savedDraft] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem(draftKey) ?? "null");
      return value && typeof value.name === "string" && typeof value.policy === "string" && Array.isArray(value.rules)
        ? (value as { name: string; policy: string; rules: ToneCriterion[]; baseId?: string })
        : null;
    } catch {
      return null;
    }
  });
  // The version these edits are made on. When someone saved another version of the set meanwhile, the person may put
  // the edits over the newest one (conflict), instead of losing them or being refused again and again.
  const [expectedBase, setExpectedBase] = useState(savedDraft?.baseId ?? baseId ?? version?.id);
  const [conflict, setConflict] = useState<JudgeVersion | null>(null);
  const { state } = useLabState();
  const [name, setName] = useState(savedDraft?.name ?? version?.name ?? "");
  const [policy, setPolicy] = useState(savedDraft?.policy ?? version?.policy ?? "");
  const [rules, setRules] = useState<ToneCriterion[]>(savedDraft?.rules ?? version?.criteria ?? [fresh()]);
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify({ name, policy, rules, baseId: expectedBase }));
    } catch {
      /* Editing still works when storage is unavailable. */
    }
  }, [draftKey, name, policy, rules, expectedBase]);
  // The edits kept in this browser, put away: the version as it is saved, and no draft left to come back.
  const edited =
    !!version &&
    JSON.stringify([name, policy, rules]) !== JSON.stringify([version.name, version.policy, version.criteria]);
  const discard = () => {
    if (!version) return;
    setName(version.name);
    setPolicy(version.policy);
    setRules(version.criteria);
    setExpectedBase(baseId ?? version.id);
    setConflict(null);
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* Nothing kept to put away. */
    }
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Why a save did not go through is said above the form and brought into view: «Сохранить» sits in the header, and
  // the person may be far down among the criteria.
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (conflict || error) notice.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [conflict, error]);
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
      setRules((all) => [...all, { ...fresh(), name: "Правила документа", text: value.text, quote: value.text }]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const save = async (base = expectedBase) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setConflict(null);
    try {
      await api(`/api/judges/${check}`, {
        name,
        policy,
        criteria: rules,
        setId: version?.setId ?? null,
        baseId: version ? base : null,
      });
      await library.reload();
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* Optional local draft. */
      }
      onClose();
    } catch (cause) {
      const newer = version
        ? (await library.refetch()).data?.versions.filter((v) => v.setId === version.setId).slice(-1)[0]
        : undefined;
      if (newer && newer.id !== base) setConflict(newer);
      else setError(cause instanceof Error ? cause.message : String(cause));
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
      sub={
        replacesResult
          ? "После сохранения эти правила станут текущими, а итог по прежним уйдёт в историю. Черновик хранится в этом браузере."
          : "После сохранения эти правила станут текущими. Прошлые версии и проверки сохранятся. Черновик хранится в этом браузере."
      }
      actions={
        <>
          {edited && (
            <Button variant="ghost" disabled={busy} onClick={discard}>
              Сбросить правки
            </Button>
          )}
          <Button variant="primary" loading={busy} disabled={!valid || state?.job.running} onClick={() => save()}>
            Сохранить
          </Button>
        </>
      }
      width="lg"
    >
      <fieldset disabled={busy || state?.job.running} className="space-y-6 p-5 sm:p-7">
        {(conflict || error) && (
          <div ref={notice} className="scroll-mt-4 space-y-3">
            {conflict && (
              <div role="alert" className="rounded-block bg-inset p-4 text-body text-fg-2">
                <p>Пока вы редактировали, у набора появилась версия {conflict.version}. Ваши правки целы.</p>
                <Button
                  className="mt-3"
                  disabled={busy || !valid || state?.job.running}
                  onClick={() => {
                    setExpectedBase(conflict.id);
                    void save(conflict.id);
                  }}
                >
                  Сохранить поверх версии {conflict.version}
                </Button>
              </div>
            )}
            {error && (
              <p role="alert" className="text-read text-bad">
                {error}
              </p>
            )}
          </div>
        )}
        <label className="block text-body font-medium text-fg">
          Название набора
          <Input autoFocus maxLength={160} value={name} onChange={(e) => setName(e.target.value)} className="mt-1" />
        </label>
        <div>
          <label className="block text-body font-medium text-fg">
            Правила
            <Textarea
              rows={5}
              value={policy}
              maxLength={50000}
              onChange={(e) => setPolicy(e.target.value)}
              className="mt-1"
            />
          </label>
          {/* Tone of voice collects its criteria from a document on «Критерии» («Заменить правила»); here a file of
              rules only adds one criterion with all of its text, beside the others, to be split by hand. */}
          {check === "tone" ? (
            <p className="mt-2 text-small text-fg-3">
              Новый документ правил дайте через «Заменить правила» на странице «Критерии»: модель соберёт из него
              критерии.
            </p>
          ) : (
            <>
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
                Из файла добавляется один критерий со всем текстом, рядом с остальными. Разделите его на отдельные
                требования.
              </p>
            </>
          )}
        </div>
        <section>
          <h2 className="text-read font-semibold text-fg">Критерии · {rules.length}</h2>
          <div className="mt-3 space-y-4">
            {rules.map((rule, i) => (
              <div key={rule.id} className="rounded-block border border-line bg-canvas p-4">
                <div className="flex items-center gap-3">
                  <span className="text-small text-fg-3">{i + 1}</span>
                  <Input
                    aria-label={`Название критерия ${i + 1}`}
                    value={rule.name}
                    maxLength={200}
                    onChange={(e) => patch(i, { name: e.target.value })}
                    placeholder="Название критерия"
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
                  <Textarea
                    rows={3}
                    value={rule.text}
                    maxLength={50000}
                    onChange={(e) => patch(i, { text: e.target.value, quote: "" })}
                    className="mt-1"
                  />
                </label>
                <details className="mt-3">
                  <summary className="cursor-pointer text-small text-fg-3">Условия и допустимые ответы</summary>
                  <label className="mt-2 block text-small text-fg-3">
                    Когда применять
                    <Input
                      value={rule.condition}
                      onChange={(e) => patch(i, { condition: e.target.value })}
                      maxLength={5000}
                      className="mt-1"
                    />
                  </label>
                  <label className="mt-2 block text-small text-fg-3">
                    Что считать допустимым
                    <Textarea
                      value={rule.acceptable}
                      maxLength={5000}
                      onChange={(e) => patch(i, { acceptable: e.target.value })}
                      className="mt-1"
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
      </fieldset>
    </Sheet>
  );
}
