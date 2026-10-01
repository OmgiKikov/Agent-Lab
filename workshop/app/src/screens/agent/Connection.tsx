import { useEffect, useState, type ReactNode } from "react";
import { Code2, Globe, Monitor, PlugZap, Save } from "lucide-react";
import { api } from "../../lab/api";
import type { Check, LabState, Target } from "../../lab/types";
import { useLabState } from "../../shell/LabProvider";
import { Button } from "../../ui/Button";
import { Drawer } from "../../ui/Drawer";
import { Label } from "../../ui/Label";
import { useToast } from "../../ui/toast";

type Answer = Check & { question?: string };
type Last = { target: string; text: string; at: string };

const LAST = "lab.agent.lastCheck", WAY = "lab.agent.way", CHANGED = "lab-agent-connection";
const words = (text: string) => text.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);

/** How the three ways are called on the page. */
export const WAY_NAME: Record<string, string> = { prod: "Тестовый стенд банка", "local-http": "На этом компьютере", "local-code": "Запуск из кода" };

const read = <T,>(key: string): T | null => { try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; } };
const write = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window: the page still works */ } window.dispatchEvent(new Event(CHANGED)); };

/** What the page remembers of the connection: the last successful check and the way chosen last. */
export function useConnectionMemory() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick(n => n + 1); window.addEventListener(CHANGED, f); return () => window.removeEventListener(CHANGED, f); }, []);
  return { last: read<Last>(LAST), way: read<string>(WAY) };
}

/** Where the agent runs, as the page says it: the way chosen, else the one that has an address. */
export function wayOf(state: LabState, chosen: string | null) {
  if (chosen && state.targets.some(t => t.id === chosen)) return chosen;
  return state.settings.prodUrl ? "prod" : state.settings.repo ? "local-code" : null;
}

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

function Reply({ check }: { check: Answer }) {
  if (!check.ok) {
    return <p className="mt-2 text-small text-lab-bad">{check.error ? `Не отвечает: ${check.error}` : `Ответил не обычным ответом (статус ${check.status ?? "?"}): так бывает, когда разговор передан оператору.`}</p>;
  }
  return (
    <div className="mt-2 space-y-1.5 text-small">
      <div className="text-lab-ok">Отвечает</div>
      {check.question && <div className="text-lab-mute">Вопрос: «{check.question}»</div>}
      {check.text && <div className="border-l-2 border-white/25 pl-3 text-lab-text">{check.text}</div>}
    </div>
  );
}

const WAY_LOOK: Record<string, { icon: typeof Globe; how: string }> = {
  prod: { icon: Globe, how: "снаружи, по адресу" },
  "local-http": { icon: Monitor, how: "снаружи, уже запущен здесь" },
  "local-code": { icon: Code2, how: "изнутри, на время прогона" },
};

/** One of the three ways as a big choice card: an icon, the name, how the Lab reaches it, and whether it is set up. */
function Way({ target, on, onPick }: { target: Target; on: boolean; onPick: () => void }) {
  const look = WAY_LOOK[target.id] ?? { icon: Globe, how: target.note };
  return (
    <button type="button" onClick={onPick} aria-pressed={on}
      className={`flex min-h-[112px] flex-col rounded-[12px] border p-3.5 text-left transition-colors ${on ? "border-[rgba(75,180,200,0.55)] bg-[rgba(75,180,200,0.09)] shadow-[0_0_0_3px_rgba(75,180,200,0.10)]" : "border-white/[0.09] bg-white/[0.02] hover:border-white/[0.2]"}`}>
      <look.icon className={`size-4 ${on ? "text-[rgb(120,205,222)]" : "text-lab-dim"}`} />
      <span className="mt-3 text-[13.5px] font-medium leading-[18px] text-lab-ink">{WAY_NAME[target.id] ?? target.name}</span>
      <span className="mt-0.5 text-[11.5px] text-lab-dim">{look.how}</span>
      <span className={`mt-auto pt-2 text-[11px] ${target.ready ? "text-lab-ok" : "text-lab-faint"}`}>{target.ready ? "готово" : "не настроено"}</span>
    </button>
  );
}

/** Подключение: the way to reach the agent, whose clients the simulator writes for, where the code is; save and check. */
export function ConnectionDrawer({ open, onClose, state }: { open: boolean; onClose: () => void; state: LabState }) {
  const s = state.settings;
  return (
    <Drawer open={open} onClose={onClose} title="Подключение" sub="Где работает агент и как до него достучаться">
      <ConnectionForm key={`${s.prodUrl}|${s.repo}|${s.epk.join(" ")}`} state={state} />
    </Drawer>
  );
}

function ConnectionForm({ state }: { state: LabState }) {
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
    <div className="px-5 py-5">
      <div className="text-[14px] text-lab-ink">Как подключить агента</div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {state.targets.map(t => <Way key={t.id} target={t} on={t.id === way} onPick={() => pick(t.id)} />)}
      </div>
      <div className="mt-3 space-y-3 rounded-[12px] border border-white/[0.08] bg-[rgb(35,35,35)] p-4">
        {state.targets.filter(t => t.id === way).map(t => (
          <div key={t.id}>
            {t.id === "prod" && (
              <Field label="Адрес агента на тестовом стенде" hint="Открывается с рабочего компьютера.">
                <input name="prod-url" type="url" autoComplete="off" value={prodUrl} onChange={e => setProdUrl(e.target.value)} placeholder="https://…" className={INPUT} spellCheck={false} />
              </Field>
            )}
            {t.id === "local-code" && (
              <Field label="Папка с кодом агента" hint="Из неё читаются промпты и запускается агент.">
                <input name="repo" autoComplete="off" value={repo} onChange={e => setRepo(e.target.value)} placeholder="~/Desktop/aigw-local" className={INPUT} spellCheck={false} />
              </Field>
            )}
            {t.id === "local-http" && <div className="text-small text-lab-mute">Адрес не нужен: агент уже запущен на этом компьютере ({t.where}).</div>}
          </div>
        ))}
      </div>
      <div className="mt-5">
        <Field label="Клиенты, от чьего имени пишет симулятор" hint="Через пробел. Пусто — тестовый клиент.">
          <input name="epk" autoComplete="off" inputMode="numeric" value={epk} onChange={e => setEpk(e.target.value)} placeholder="Например: 1234567890 2345678901" className={INPUT} spellCheck={false} />
        </Field>
      </div>
      {!dirty ? null : <p className="mt-4 text-meta text-lab-warn">Есть несохранённые изменения</p>}
      <div className="mt-4 flex items-center gap-2">
        <Button variant="primary" icon={Save} loading={saving} disabled={!dirty} onClick={save}>Сохранить</Button>
        {target && target.kind !== "code" && <Button icon={PlugZap} loading={check === "pending"} disabled={!target.ready || dirty} onClick={run} title={dirty ? "Сначала сохраните изменения" : undefined}>Проверить связь</Button>}
      </div>
      {target?.kind === "code" && <p className="mt-3 text-meta text-lab-dim">Запускается только на время прогона: проверить связь заранее нельзя.</p>}
      {check && check !== "pending" && <Reply check={check} />}
    </div>
  );
}
