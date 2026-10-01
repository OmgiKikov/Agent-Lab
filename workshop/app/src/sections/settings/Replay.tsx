import { useEffect, useMemo, useState } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { useWorkshopEvent } from "../../hooks/use-workshop-ws";
import { Button } from "../../ui/Button";
import { useToast } from "../../ui/toast";
import { buildSkillPrompt } from "../../utils/skill-content";
import { INPUT, Row } from "./parts";

type Agents = Record<string, { url: string; contextFromTrace?: Record<string, string> }>;
type Health = "online" | "offline" | "checking";

const HEALTH: Record<Health, { text: string; tone: string }> = {
  online: { text: "на связи", tone: "text-ok" },
  offline: { text: "не отвечает", tone: "text-bad" },
  checking: { text: "проверяю…", tone: "text-fg-4" },
};

/** Trace replay: the addresses on this computer the Workshop calls to replay a trace with the agent's real tools; each says whether it answers. */
export function Replay() {
  const toast = useToast();
  const [agents, setAgents] = useState<Agents>({});
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const prompt = useMemo(() => buildSkillPrompt("setup-agent-replay"), []);

  useEffect(() => { fetch("/api/agents").then(r => r.json()).then(setAgents).catch(() => {}); }, []);
  // The Workshop announces every change of the list: /setup-agent-replay finishing in another window, or a save from here.
  useWorkshopEvent("agents_updated", (data: { agents?: Agents }) => { if (data?.agents) setAgents(data.agents); });
  useEffect(() => {
    const names = Object.keys(agents);
    if (!names.length) return;
    const all = (h: Health) => Object.fromEntries(names.map(n => [n, h]));
    const check = () => fetch("/api/agents/health").then(r => r.json()).then(setHealth).catch(() => setHealth(all("offline")));
    setHealth(all("checking"));
    check();
    const timer = setInterval(check, 15000);
    return () => clearInterval(timer);
  }, [agents]);

  const save = (next: Agents) => fetch("/api/agents", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) })
    .then(r => { if (!r.ok) throw new Error(`Workshop не сохранил адреса (${r.status})`); setAgents(next); return true; })
    .catch(e => { toast.error(e); return false; });
  const add = () => {
    const n = name.trim(), u = url.trim();
    if (n && u) save({ ...agents, [n]: { url: u } }).then(ok => { if (ok) { setName(""); setUrl(""); } });
  };
  const remove = (n: string) => { const next = { ...agents }; delete next[n]; save(next); };
  const copy = () => Promise.resolve().then(() => navigator.clipboard.writeText(prompt))
    .then(() => toast.notify("Промпт скопирован: вставьте его в Claude Code или Cursor в папке агента"), toast.error);

  const list = Object.entries(agents);
  return (
    <>
      {list.length > 0 && (
        <div className="border-t border-line">
          {list.map(([n, c]) => {
            const h = HEALTH[health[n] ?? "checking"];
            return (
              <Row key={n} name={n} use={<span className="block truncate font-mono" title={c.url}>{c.url}</span>}>
                <span className={`text-small ${h.tone}`}>{h.text}</span>
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Убрать адрес «${n}»`} title="Убрать адрес" onClick={() => remove(n)} />
              </Row>
            );
          })}
        </div>
      )}
      <form onSubmit={e => { e.preventDefault(); add(); }} className={`grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] ${list.length ? "mt-4" : ""}`}>
        <input name="agent-name" aria-label="Имя агента" autoComplete="off" spellCheck={false} placeholder="имя агента" value={name} onChange={e => setName(e.target.value)} className={INPUT} />
        <input name="agent-url" type="url" aria-label="Адрес для повтора" autoComplete="off" spellCheck={false} placeholder="http://localhost:5860/replay" value={url} onChange={e => setUrl(e.target.value)} className={INPUT} />
        <Button type="submit" icon={Plus} disabled={!name.trim() || !url.trim()}>Добавить</Button>
      </form>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 basis-64 text-small text-fg-3">
          Адрес может настроить сам ИИ-инструмент для кода: вставьте промпт в Claude Code или Cursor в папке агента. В Claude Code хватит команды <span className="whitespace-nowrap font-mono text-fg-2">/setup-agent-replay</span>.
        </p>
        <Button size="sm" icon={Copy} onClick={copy}>Скопировать промпт</Button>
      </div>
    </>
  );
}
