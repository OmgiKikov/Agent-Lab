import { useEffect, useState, type ReactNode } from "react";
import { Code, Globe, PlugZap, Save } from "lucide-react";
import { api } from "../../lab/api";
import type { Check, LabState, Target } from "../../lab/types";
import { useLabState } from "../../shell/LabProvider";
import { Button } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { useToast } from "../../ui/toast";

type Answer = Check & { question?: string };

const words = (text: string) => text.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <Label className="mb-1.5">{label}</Label>
      {children}
      {hint && <span className="mt-1 block text-meta text-lab-dim">{hint}</span>}
    </label>
  );
}

const INPUT = "h-8 w-full rounded-md border border-white/[0.08] bg-transparent px-2.5 font-mono text-small text-lab-text outline-none placeholder:text-lab-faint focus:border-white/25";

/** What «Проверить связь» found: the question, the agent's answer, how long it took and its version; or why it failed. */
function Reply({ check }: { check: Answer }) {
  if (!check.ok) {
    return (
      <p className="mt-3 text-small text-lab-bad">
        ✗ {check.error ? `Не отвечает: ${check.error}` : `Ответил не обычным ответом (статус ${check.status ?? "?"}): так бывает, когда разговор передан оператору.`}
      </p>
    );
  }
  const version = check.version && check.version !== "не сообщается" ? check.version : null;
  return (
    <div className="mt-3 space-y-2 text-small">
      <div className="text-lab-ok">✓ Отвечает{check.seconds !== undefined ? ` за ${check.seconds} с` : ""}{version ? ` · версия ${version}` : ""}</div>
      {check.question && <div className="text-lab-mute">Вопрос: «{check.question}»</div>}
      {check.text && <div className="border-l-2 border-white/25 pl-3 text-lab-text">{check.text}</div>}
    </div>
  );
}

function Way({ target }: { target: Target }) {
  const toast = useToast();
  const [check, setCheck] = useState<Answer | "pending" | null>(null);
  const run = () => {
    setCheck("pending");
    api<Answer>(`/api/agents/${encodeURIComponent(target.id)}/check`, {}).then(setCheck).catch(e => { setCheck(null); toast.error(e); });
  };
  const Icon = target.kind === "code" ? Code : Globe;
  return (
    <div className="border-b border-white/[0.06] py-4">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-4 flex-shrink-0 text-lab-dim" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-body font-medium text-lab-ink">{target.name}</span>
            {target.ready ? <span className="text-meta text-lab-dim">настроен</span> : <span className="text-meta text-lab-warn">не настроен</span>}
          </div>
          <div className="mt-0.5 truncate font-mono text-meta text-lab-dim">{target.where || "адрес не задан"}</div>
          <div className="mt-1 text-small text-lab-mute">{target.note}</div>
          {target.kind === "code" && <div className="mt-1 text-meta text-lab-dim">Запускается только на время прогона: проверить связь заранее нельзя.</div>}
          {check && check !== "pending" && <Reply check={check} />}
        </div>
        {target.kind !== "code" && (
          <Button size="sm" icon={PlugZap} loading={check === "pending"} disabled={!target.ready} onClick={run}>Проверить связь</Button>
        )}
      </div>
    </div>
  );
}

/** Подключение: where the agent is, whose accounts it answers for, where its code is, and the three ways to reach it. */
export function Connection({ state }: { state: LabState }) {
  const { refresh } = useLabState();
  const toast = useToast();
  const saved = state.settings;
  const savedKey = `${saved.prodUrl}|${saved.repo}|${saved.epk.join(" ")}`;
  const [prodUrl, setProdUrl] = useState(saved.prodUrl);
  const [epk, setEpk] = useState(saved.epk.join(" "));
  const [repo, setRepo] = useState(saved.repo);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setProdUrl(saved.prodUrl); setEpk(saved.epk.join(" ")); setRepo(saved.repo); }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = prodUrl.trim() !== saved.prodUrl || repo.trim() !== saved.repo || words(epk).join(" ") !== saved.epk.join(" ");
  const save = () => {
    setSaving(true);
    api("/api/settings", { prodUrl: prodUrl.trim(), epk: words(epk), repo: repo.trim() })
      .then(() => refresh()).then(() => toast.notify("Сохранено")).catch(toast.error).finally(() => setSaving(false));
  };
  return (
    <div className="mx-auto max-w-[760px] px-6 pb-20 pt-6 lg:px-8">
      <section>
        <h2 className="text-title font-medium text-lab-ink">Где агент</h2>
        <div className="mt-4 space-y-4">
          <Field label="Адрес агента на ИФТ" hint="Ручка в контуре банка; открывается с рабочего компьютера.">
            <input value={prodUrl} onChange={e => setProdUrl(e.target.value)} placeholder="https://…" className={INPUT} spellCheck={false} />
          </Field>
          <Field label="ЕПК клиентов" hint="Через пробел. На ИФТ синтетический клиент входит как один из этих клиентов; пусто — тестовый клиент.">
            <input value={epk} onChange={e => setEpk(e.target.value)} placeholder="Например: 1234567890 2345678901" className={INPUT} spellCheck={false} />
          </Field>
          <Field label="Код агента" hint="Папка с исходниками: из неё читаются правила и запускается агент из исходников.">
            <input value={repo} onChange={e => setRepo(e.target.value)} placeholder="~/Desktop/aigw-local" className={INPUT} spellCheck={false} />
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" icon={Save} loading={saving} disabled={!dirty} onClick={save}>Сохранить</Button>
          {dirty && <span className="text-meta text-lab-warn">Есть несохранённые изменения</span>}
        </div>
      </section>
      <section className="mt-10">
        <h2 className="text-title font-medium text-lab-ink">Как до него достучаться</h2>
        <p className="mt-1 text-small text-lab-dim">Три способа сыграть с агентом прогон; выбираются при запуске.</p>
        <div className="mt-2">{state.targets.map(t => <Way key={t.id} target={t} />)}</div>
      </section>
    </div>
  );
}
