import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Sparkles, Upload } from "lucide-react";
import { SECTIONS } from "../../app/links";
import { useRulesSources } from "../../lab/agents";
import { api, upload } from "../../lab/api";
import { useLabState } from "../../lab/LabProvider";
import { useSource } from "../../lab/problems";
import { rememberName, rememberText, savedName, savedText, TONE_ID, toneResult } from "../../lab/tone";
import { Button } from "../../ui/Button";
import { Input, Textarea } from "../../ui/Field";
import { Sheet } from "../../ui/Sheet";
import { TakeRules } from "./TakeRules";

/**
 * «Собрать из документа»: the rules of communication as the bank wrote them (a .docx, .txt or .md, or pasted), and the
 * model collects the criteria from them; they become a set of rules with a version (backend: tone.save_draft keeps
 * them in the library). Other rules replace the current ones — the result by the old ones goes to the history, the
 * scenarios built from it are dropped — so that is said before. The same rules are only collected anew. The rules of
 * another agent can be taken instead.
 */
export function DocumentRules({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, refresh } = useLabState();
  const others = useRulesSources();
  const hasSource = !!state?.sources.some((s) => s.id === TONE_ID);
  const source = useSource(open && hasSource ? TONE_ID : null);
  const [text, setText] = useState(savedText);
  const [name, setName] = useState(savedName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the person typed wins over the saved document; until they type, the form shows the document.
  const edited = useRef(!!text);
  useEffect(() => {
    if (source.data && !edited.current) {
      setText(source.data.content);
      setName(source.data.origin);
    }
  }, [source.data]);
  const change = (value: string) => {
    edited.current = true;
    setText(value);
    rememberText(value);
  };
  const rename = (value: string) => {
    setName(value);
    rememberName(value);
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
  const read = (file?: File) =>
    file &&
    run(async () => {
      if (file.size > 2_000_000) throw new Error("Файл больше 2 МБ. Вставьте правила текстом.");
      const parsed = await upload<{ text: string; name: string }>("/api/tone-of-voice/read-file", file);
      change(parsed.text);
      rename(parsed.name);
    });
  const same = !!source.data && source.data.content.trim() === text.trim();
  const criteria = !!state?.toneOfVoice;
  const deck = state?.cards?.check === "tone" && !!state.cards.cards.length;
  const result = !!toneResult(state);
  const dialogues = !!state?.logs.total;
  const collect = () =>
    run(async () => {
      if (!same) await api("/api/tone-of-voice/policy", { text: text.trim(), name: name.trim() || "Правила общения" });
      await api("/api/tone-of-voice/criteria", {});
      rememberText("");
      edited.current = false;
      await refresh();
      onClose();
    });
  const warning = same
    ? criteria &&
      `Это те же правила: критерии соберутся заново.${result ? " Итог останется, но будет по прежней версии критериев." : ""}${deck ? " Сценарии из tone of voice сбросятся." : ""} Уточнения останутся там, где цитата из правил не изменилась.`
    : (result || deck || criteria) &&
      `Новые правила заменят текущие.${result ? " Итог tone of voice по прежним правилам уйдёт в историю." : ""}${deck ? " Сценарии из него сбросятся." : ""} Уточнения останутся там, где цитата из правил не изменилась.`;
  return (
    <Sheet
      open={open}
      onClose={() => !busy && onClose()}
      title="Правила из документа"
      sub="Модель соберёт из правил общения критерии. Получится набор правил, его можно будет поправить вручную."
      actions={
        <Button
          variant="primary"
          icon={Sparkles}
          loading={busy}
          disabled={!dialogues || text.trim().length < 20 || !!state?.job.running}
          onClick={collect}
        >
          {same && criteria ? "Собрать заново" : "Собрать критерии"}
        </Button>
      }
    >
      <fieldset disabled={busy || !!state?.job.running} className="space-y-6 p-5 sm:p-7">
        {!dialogues && (
          <p role="alert" className="rounded-block bg-inset p-4 text-body text-fg-2">
            Сначала добавьте датасет: критерии собираются, когда у агента есть разговоры.{" "}
            <Link to={SECTIONS.data} className="text-run hover:underline">
              Датасеты
            </Link>
          </p>
        )}
        <label className="block text-body font-medium text-fg">
          Название
          <Input value={name} maxLength={160} onChange={(e) => rename(e.target.value)} className="mt-1" />
        </label>
        <div>
          <label className="block text-body font-medium text-fg">
            Текст правил
            <Textarea
              rows={12}
              value={text}
              maxLength={50000}
              onChange={(e) => change(e.target.value)}
              placeholder="Вставьте правила общения или загрузите документ"
              className="mt-1"
            />
          </label>
          <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-body font-medium text-fg">
            <Upload aria-hidden className="size-4" />
            Загрузить .docx, .txt или .md
            <input
              type="file"
              accept=".docx,.txt,.md"
              className="sr-only"
              onChange={(e) => {
                void read(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {warning && <p className="rounded-block bg-inset p-4 text-body text-fg-2">{warning}</p>}
        {error && (
          <p role="alert" className="text-read text-bad">
            {error}
          </p>
        )}
        {state && others.length > 0 && (
          <div className="border-t border-line pt-5">
            <p className="text-body text-fg-3">
              Правила общения в банке обычно одни на всех агентов. Можно взять их копию у другого агента.
            </p>
            <div className="mt-3">
              <TakeRules state={state} disabled={busy || !!state.job.running} onTaken={() => onClose()} />
            </div>
          </div>
        )}
      </fieldset>
    </Sheet>
  );
}
