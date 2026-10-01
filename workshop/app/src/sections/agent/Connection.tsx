import { useEffect, useState, type ReactNode } from "react";
import { Check as CheckIcon, Code2, Globe, Monitor, PlugZap, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../../lab/api";
import type { Check, LabState, Target } from "../../lab/types";
import { useLabState } from "../../shell/LabProvider";
import { Button } from "../../ui/Button";
import { Caps } from "../../ui/Caps";
import { useToast } from "../../ui/toast";

type Answer = Check & { question?: string };
type Last = { target: string; text: string; at: string };

const LAST = "lab.agent.lastCheck", WAY = "lab.agent.way", CHANGED = "lab-agent-connection";
const words = (text: string) => text.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);

/** How the three ways are called. */
export const WAY_NAME: Record<string, string> = { prod: "Тестовый стенд банка", "local-http": "На этом компьютере", "local-code": "Запуск из кода" };
const WAY_LOOK: Record<string, { icon: typeof Globe; how: string }> = {
  prod: { icon: Globe, how: "снаружи, по адресу" },
  "local-http": { icon: Monitor, how: "снаружи, уже запущен здесь" },
  "local-code": { icon: Code2, how: "изнутри, на время прогона" },
};

const read = <T,>(key: string): T | null => { try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; } };
const write = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window: the page still works */ } window.dispatchEvent(new Event(CHANGED)); };

/** What the page remembers of the connection: the last successful check and the way chosen last. */
export function useConnectionMemory() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick(n => n + 1); window.addEventListener(CHANGED, f); return () => window.removeEventListener(CHANGED, f); }, []);
  return { last: read<Last>(LAST), way: read<string>(WAY) };
}

/** Where the agent runs: the way chosen, else the one that has an address. */
export function wayOf(state: LabState, chosen: string | null) {
  if (chosen && state.targets.some(t => t.id === chosen)) return chosen;
  return state.settings.prodUrl ? "prod" : state.settings.repo ? "local-code" : null;
}

const INPUT = "h-9 w-full rounded-control border border-line-strong bg-transparent px-3 font-mono text-small text-fg outline-none transition-colors placeholder:text-fg-4 focus:border-fg-3";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-small font-medium text-fg-2">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-meta text-fg-3">{hint}</span>}
    </label>
  );
}

function Way({ target, on, onPick }: { target: Target; on: boolean; onPick: () => void }) {
  const look = WAY_LOOK[target.id] ?? { icon: Globe, how: target.note };
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onPick}
      className={cn("grid w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-1 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60", on ? "text-fg" : "text-fg-2 hover:text-fg")}>
      <span aria-hidden className={cn("flex size-4 items-center justify-center rounded-full border", on ? "border-fg bg-fg" : "border-fg-4")}>{on && <span className="size-1.5 rounded-full bg-canvas" />}</span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-body font-medium"><look.icon aria-hidden className="size-4 text-fg-3" />{WAY_NAME[target.id] ?? target.name}</span>
        <span className="mt-0.5 block text-small text-fg-3">{look.how}{target.where ? ` · ${target.where}` : ""}</span>
      </span>
      <span className={cn("inline-flex items-center gap-1 text-meta", target.ready ? "text-ok" : "text-fg-3")}>{target.ready ? <><CheckIcon aria-hidden className="size-3.5" />готово</> : "не настроено"}</span>
    </button>
  );
}

/** Подключение: the way to reach the agent, whose clients the simulator writes for, where the code is; save and check. */
export function ConnectionForm({ state }: { state: LabState }) {
  const { refresh } = useLabState();
  const toast = useToast();
  const saved = state.settings;
  const memory = useConnectionMemory();
  const [way, setWay] = useState(wayOf(state, memory.way) ?? "prod");
  const [prodUrl, setProdUrl] = useState(saved.prodUrl);
  const [epk, setEpk] = useState(saved.epk.join(" "));
  const [repo, setRepo] = useState(saved.repo);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<Answer | "pending" | null>(null);
  const dirty = prodUrl.trim() !== saved.prodUrl || repo.trim() !== saved.repo || words(epk).join(" ") !== saved.epk.join(" ");
  const target = state.targets.find(t => t.id === way);
  const pick = (id: string) => { setWay(id); setCheck(null); write(WAY, id); };
  const save = () => {
    setSaving(true);
    api("/api/settings", { prodUrl: prodUrl.trim(), epk: words(epk), repo: repo.trim() })
      .then(() => refresh()).then(() => toast.notify("Сохранено")).catch(toast.error).finally(() => setSaving(false));
  };
  const run = () => {
    if (!target) return;
    setCheck("pending");
    api<Answer>(`/api/agents/${encodeURIComponent(target.id)}/check`, {}).then(a => {
      setCheck(a);
      if (a.ok && a.text) write(LAST, { target: target.id, text: a.text, at: new Date().toISOString() } satisfies Last);
    }).catch(e => { setCheck(null); toast.error(e); });
  };
  return (
    <section aria-label="Подключение">
      <Caps>Как подключить агента</Caps>
      <div role="radiogroup" aria-label="Способ подключения" className="mt-2 border-t border-line">
        {state.targets.map(t => <Way key={t.id} target={t} on={t.id === way} onPick={() => pick(t.id)} />)}
      </div>
      <div className="mt-5 space-y-4">
        {way === "prod" && <Field label="Адрес агента на тестовом стенде" hint="Открывается с рабочего компьютера."><input name="prod-url" type="url" autoComplete="off" value={prodUrl} onChange={e => setProdUrl(e.target.value)} placeholder="https://…" className={INPUT} spellCheck={false} /></Field>}
        {way === "local-code" && <Field label="Папка с кодом агента" hint="Из неё читаются промпты и запускается агент."><input name="repo" autoComplete="off" value={repo} onChange={e => setRepo(e.target.value)} placeholder="~/Desktop/aigw-local" className={INPUT} spellCheck={false} /></Field>}
        {way === "local-http" && <p className="text-small text-fg-3">Адрес не нужен: агент уже запущен на этом компьютере{target?.where ? ` (${target.where})` : ""}.</p>}
        <Field label="Клиенты, от чьего имени пишет симулятор" hint="ЕПК через пробел. Пусто — тестовый клиент.">
          <input name="epk" autoComplete="off" inputMode="numeric" value={epk} onChange={e => setEpk(e.target.value)} placeholder="Например: 1234567890 2345678901" className={INPUT} spellCheck={false} />
        </Field>
      </div>
      {dirty && <p className="mt-4 text-meta text-warn">Есть несохранённые изменения</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button icon={Save} loading={saving} disabled={!dirty} onClick={save}>Сохранить</Button>
        {target && target.kind !== "code" && <Button icon={PlugZap} loading={check === "pending"} disabled={!target.ready || dirty} onClick={run} title={dirty ? "Сначала сохраните изменения" : undefined}>Проверить связь</Button>}
      </div>
      {target?.kind === "code" && <p className="mt-3 text-meta text-fg-3">Запускается только на время прогона: проверить связь заранее нельзя.</p>}
      {check && check !== "pending" && (check.ok
        ? <div className="mt-4 space-y-1.5 text-small"><p className="text-ok">Отвечает{check.seconds ? ` · ${check.seconds.toFixed(1).replace(".", ",")} с` : ""}{check.version ? ` · версия ${check.version}` : ""}</p>{check.question && <p className="text-fg-3">Вопрос: «{check.question}»</p>}{check.text && <p className="border-l-2 border-fg-4/60 pl-3 text-fg-2">{check.text}</p>}</div>
        : <p className="mt-4 text-small text-bad">{check.error ? `Не отвечает: ${check.error}` : `Ответил не обычным ответом (статус ${check.status ?? "?"}): так бывает, когда разговор передан оператору.`}</p>)}
      {memory.last && !check && <p className="mt-4 text-meta text-fg-3">Последняя проверка: отвечал {new Date(memory.last.at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</p>}
    </section>
  );
}
