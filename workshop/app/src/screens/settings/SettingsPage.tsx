import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Plus, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { LocalAgentSetupCTA } from "../../components/LocalAgentSetupCTA";
import { SecretInput } from "../../components/SecretInput";
import { useWorkshopEvent } from "../../hooks/use-workshop-ws";
import { api, API } from "../../lab/api";
import type { Check, LabState } from "../../lab/types";
import { useLabState } from "../../shell/LabProvider";
import { SectionHeader } from "../../shell/SectionHeader";
import { Button } from "../../ui/Button";
import { Facts } from "../../ui/Facts";
import {
  deleteSecret,
  getSecretStatuses,
  purgeLegacyBrowserSecrets,
  saveSecret,
  type SecretKey,
  type SecretStatus,
  type SecretStatuses,
} from "../../api/secrets";

type Part = "models" | "keys" | "assistant" | "replay" | "about";

/** Настройки: the models that judge and play the customer, the keys, the assistant, trace replay and where things run. */
export function SettingsPage() {
  const { state } = useLabState();
  return (
    <div className="flex h-full flex-col">
      <SectionHeader crumbs={[{ label: "Настройки" }]} />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[760px] space-y-12 px-6 pb-20 pt-6 lg:px-8">
          {state && <ModelsSection state={state} />}
          <KeysSection />
          <AssistantSection />
          <AgentEndpointsSection />
          <AboutSection />
        </div>
      </div>
    </div>
  );
}

function SectionBlock({ id, title, description, action, children }: { id: Part; title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section id={`settings-${id}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-body font-medium text-lab-ink">{title}</h2>
          {description && <p className="mt-1 text-small text-lab-dim">{description}</p>}
        </div>
        {action}
      </div>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

/** Модели: which model judges and plays the customer, which one judges again; «Проверить модели» asks each once. */
function ModelsSection({ state }: { state: LabState }) {
  const [checks, setChecks] = useState<{ main: Check; second: Check } | "pending" | null>(null);
  const check = () => {
    setChecks("pending");
    api<{ main: Check; second: Check }>("/api/models/check", {})
      .then(setChecks)
      .catch(e => setChecks({ main: { ok: false, error: String(e.message ?? e) }, second: { ok: false, error: String(e.message ?? e) } }));
  };
  const result = (role: "main" | "second") => {
    if (!checks || checks === "pending") return null;
    const c = checks[role];
    return c.ok ? <span className="text-lab-ok">✓ отвечает</span> : <span className="text-lab-bad">✗ {c.error ?? "не отвечает"}</span>;
  };
  const rows: { role: "main" | "second"; label: string; model: string | null }[] = [
    { role: "main", label: "Судья и клиент", model: state.models.main },
    { role: "second", label: "Второй судья", model: state.models.second },
  ];
  return (
    <SectionBlock
      id="models" title="Модели" description={`Запросы идут через ${state.models.via}.${state.models.via === "OpenRouter" ? " Сертификаты шлюза банка кладутся в папку certs/." : ""}`}
      action={<Button icon={ShieldCheck} loading={checks === "pending"} onClick={check}>Проверить модели</Button>}
    >
      <div className="border-t border-white/[0.08]">
        {rows.map(r => (
          <div key={r.role} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-white/[0.08] py-3">
            <span className="w-40 flex-shrink-0 text-small text-lab-mute">{r.label}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-small text-lab-text">{r.model ?? "не задана"}</span>
            <span className="text-meta">{result(r.role)}</span>
          </div>
        ))}
      </div>
    </SectionBlock>
  );
}

/** О продукте: where the service and the Workshop answer, and the one command that starts them. */
function AboutSection() {
  return (
    <SectionBlock id="about" title="О продукте">
      <Facts facts={[
        { label: "Сервис проверок", value: <span className="font-mono text-small">{API}</span> },
        { label: "Workshop", value: <span className="font-mono text-small">{window.location.origin}</span> },
        { label: "Запуск", value: <span className="font-mono text-small">sh bin/start.sh</span> },
      ]} />
    </SectionBlock>
  );
}

function AgentEndpointsSection() {
  const [agents, setAgents] = useState<Record<string, { url: string; contextFromTrace?: Record<string, string> }>>({});
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [health, setHealth] = useState<Record<string, "online" | "offline" | "checking">>({});

  const reload = useCallback(() => {
    fetch("/api/agents").then(r => r.json()).then(setAgents).catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // Live updates: server broadcasts `agents_updated` after any external
  // write — `/add-replay` finishing in another window,
  // a manual curl-refresh, or the PUT below. Lets the Settings list match
  // disk in real time without a 15s wait or a page reload.
  useWorkshopEvent("agents_updated", (data: { agents?: typeof agents }) => {
    if (data?.agents) setAgents(data.agents);
  });

  useEffect(() => {
    if (Object.keys(agents).length === 0) return;
    const check = () => {
      for (const name of Object.keys(agents)) setHealth(h => ({ ...h, [name]: "checking" }));
      fetch("/api/agents/health")
        .then(r => r.json())
        .then((results: Record<string, "online" | "offline">) => setHealth(results))
        .catch(() => {
          const offline: Record<string, "offline"> = {};
          for (const name of Object.keys(agents)) offline[name] = "offline";
          setHealth(offline);
        });
    };
    check();
    const interval = setInterval(check, 15000);
    return () => clearInterval(interval);
  }, [agents]);

  const save = useCallback((config: typeof agents) => {
    fetch("/api/agents", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) })
      .then(() => setAgents(config))
      .catch(() => {});
  }, []);

  const addAgent = () => {
    if (!newName.trim() || !newUrl.trim()) return;
    save({ ...agents, [newName.trim()]: { url: newUrl.trim() } });
    setNewName("");
    setNewUrl("");
  };

  const removeAgent = (name: string) => {
    const updated = { ...agents };
    delete updated[name];
    save(updated);
  };

  const INPUT = "h-8 min-w-0 rounded-md border border-white/[0.08] bg-transparent px-2.5 font-mono text-small text-lab-text outline-none placeholder:text-lab-faint focus:border-white/25";
  return (
    <SectionBlock
      id="replay"
      title="Повтор трейсов"
      description="Локальные адреса агентов, чтобы повторять трейсы с настоящими инструментами. В повторе появится режим «Локальный агент»."
    >
      <LocalAgentSetupCTA
        title="Добавить адрес агента"
        description={
          <>
            Подключите агента к режиму повтора «Локальный агент». Выберите
            способ под свой инструмент для кода — для Claude Code установится
            плагин Raindrop, если его ещё нет.
          </>
        }
      />

      {Object.keys(agents).length > 0 && (
        <div className="border-t border-white/[0.08]">
          {Object.entries(agents).map(([name, config]) => {
            const status = health[name] ?? "checking";
            return (
              <div key={name} className="group flex items-center gap-3 border-b border-white/[0.08] py-2.5">
                <span className="min-w-[80px] text-small font-medium text-lab-text">{name}</span>
                <span title={config.url} className="min-w-0 flex-1 truncate font-mono text-meta text-lab-dim">{config.url}</span>
                <span className={cn("flex-shrink-0 text-meta", status === "online" ? "text-lab-ok" : status === "checking" ? "text-lab-dim" : "text-lab-bad")}>
                  {status === "online" ? "✓ на связи" : status === "checking" ? "проверяю…" : "✗ нет связи"}
                </span>
                <button type="button" aria-label="Удалить" className="rounded p-1 text-lab-dim opacity-0 transition-opacity hover:bg-white/[0.08] group-hover:opacity-100" onClick={() => removeAgent(name)}>
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-1.5">
        <input className={cn(INPUT, "flex-1")} name="agent-name" aria-label="Имя агента" autoComplete="off" spellCheck={false} placeholder="имя" value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === "Enter" && addAgent()} />
        <input className={cn(INPUT, "flex-[2]")} name="agent-url" type="url" aria-label="Адрес агента" autoComplete="off" spellCheck={false} placeholder="http://localhost:5860/replay…" value={newUrl} onChange={e => setNewUrl(e.target.value)} onKeyDown={e => e.key === "Enter" && addAgent()} />
        <Button icon={Plus} onClick={addAgent} aria-label="Добавить адрес" />
      </div>
    </SectionBlock>
  );
}

function KeysSection() {
  const [drafts, setDrafts] = useState<Record<SecretKey, string>>({
    anthropic: "",
    openai: "",
    raindrop: "",
    query: "",
  });
  const [statuses, setStatuses] = useState<SecretStatuses | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<SecretKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    purgeLegacyBrowserSecrets();
    getSecretStatuses()
      .then((next) => { if (!cancelled) setStatuses(next); })
      .catch(() => {
        if (!cancelled) setStatuses(null);
      });
    return () => { cancelled = true; };
  }, []);

  const setDraft = useCallback((key: SecretKey, value: string) => {
    setDrafts((current) => ({ ...current, [key]: value }));
  }, []);

  const persist = useCallback(async (key: SecretKey, rawValue: string) => {
    const value = rawValue.trim();
    if (!value) return;

    setSaveError(null);
    setSavingKey(key);
    try {
      const nextStatus = await saveSecret(key, value);
      setStatuses((current) => current ? { ...current, [key]: nextStatus } : current);
      setDrafts((current) => ({ ...current, [key]: "" }));
      purgeLegacyBrowserSecrets();
      window.dispatchEvent(new CustomEvent("workshop:api-key-change", { detail: { secret: key } }));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(null);
    }
  }, []);

  const clearSecret = useCallback(async (key: SecretKey) => {
    setSaveError(null);
    setSavingKey(key);
    try {
      const nextStatus = await deleteSecret(key);
      setStatuses((current) => current ? { ...current, [key]: nextStatus } : current);
      setDrafts((current) => ({ ...current, [key]: "" }));
      purgeLegacyBrowserSecrets();
      window.dispatchEvent(new CustomEvent("workshop:api-key-change", { detail: { secret: key } }));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(null);
    }
  }, []);

  const secretSaved = useCallback((key: SecretKey) => {
    return statuses?.[key]?.configured === true;
  }, [statuses]);

  const sourceText = useCallback((key: SecretKey, fallback: string) => {
    const status = statuses?.[key];
    if (!status?.configured) return fallback;
    return status.source === "env" ? "Задан через переменную окружения." : undefined;
  }, [statuses]);

  const canClearSecret = useCallback((key: SecretKey) => {
    return statuses?.[key]?.source === "store";
  }, [statuses]);

  useWorkshopEvent("secrets_updated", (data: { key?: SecretKey; status?: SecretStatus }) => {
    if (!data?.key || !data.status) return;
    setStatuses((current) => current ? { ...current, [data.key as SecretKey]: data.status as SecretStatus } : current);
  });

  return (
    <SectionBlock id="keys" title="Ключи" description="Ключи Workshop один раз передаются локальному демону и не возвращаются в браузер. Чтобы заменить сохранённый ключ, вставьте новый.">
      <SecretInput label="Anthropic" placeholder="sk-ant-..." description={sourceText("anthropic", "Для повтора и чата с ассистентом.")} value={drafts.anthropic} saved={secretSaved("anthropic")} saving={savingKey === "anthropic"} onChange={v => setDraft("anthropic", v)} onSave={v => persist("anthropic", v)} onClear={canClearSecret("anthropic") ? () => clearSecret("anthropic") : undefined} getKeyUrl="https://console.anthropic.com/settings/keys" />
      <SecretInput label="OpenAI" placeholder="sk-..." description={sourceText("openai", "Для повтора с моделями GPT.")} value={drafts.openai} saved={secretSaved("openai")} saving={savingKey === "openai"} onChange={v => setDraft("openai", v)} onSave={v => persist("openai", v)} onClear={canClearSecret("openai") ? () => clearSecret("openai") : undefined} getKeyUrl="https://platform.openai.com/api-keys" />
      <SecretInput label="Raindrop" placeholder="rk_..." description={sourceText("raindrop", "Ключ записи для отправки трейсов.")} value={drafts.raindrop} saved={secretSaved("raindrop")} saving={savingKey === "raindrop"} onChange={v => setDraft("raindrop", v)} onSave={v => persist("raindrop", v)} onClear={canClearSecret("raindrop") ? () => clearSecret("raindrop") : undefined} getKeyUrl="https://app.raindrop.ai" />
      <SecretInput label="Query API" placeholder="ключ Query API" description={sourceText("query", "Для поиска событий на вкладке «Поиск».")} value={drafts.query} saved={secretSaved("query")} saving={savingKey === "query"} onChange={v => setDraft("query", v)} onSave={v => persist("query", v)} onClear={canClearSecret("query") ? () => clearSecret("query") : undefined} getKeyUrl="https://auth.raindrop.ai/org/api_keys" />
      {saveError && <div className="text-meta text-lab-bad">{saveError}</div>}
      <DaemonQueryKeyStatus status={statuses?.query ?? null} />
    </SectionBlock>
  );
}

function DaemonQueryKeyStatus({ status }: { status: SecretStatus | null }) {
  const configured = status?.configured === true;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-white/[0.08] pt-3">
      <span className="text-small text-lab-text">Raindrop Cloud MCP</span>
      <span className={cn("font-mono text-meta", configured ? "text-lab-ok" : "text-lab-dim")}>
        {status === null ? "проверяю…" : configured ? "✓ включён" : "не подключён"}
      </span>
    </div>
  );
}

/** Ассистент: «Спросить» works through Claude Code or Codex on this computer; the choice can be shown again. */
function AssistantSection() {
  const [reset, setReset] = useState(false);

  const resetChatOnboarding = useCallback(() => {
    try {
      localStorage.removeItem("workshop:messagePane:providerIntroSeen");
    } catch {}
    window.dispatchEvent(new CustomEvent("workshop:messagePane:resetOnboarding"));
    setReset(true);
    window.setTimeout(() => setReset(false), 1400);
  }, []);

  return (
    <SectionBlock id="assistant" title="Ассистент" description="«Спросить» (⌘J) работает через Claude Code или Codex на этом компьютере.">
      <div className="flex items-center justify-between gap-4 border-t border-white/[0.08] pt-3">
        <div className="min-w-0">
          <div className="text-small text-lab-text">Выбор ассистента</div>
          <div className="mt-0.5 text-meta text-lab-dim">Снова показать экран, где выбирается Claude Code или Codex.</div>
        </div>
        <Button size="sm" icon={RotateCcw} onClick={resetChatOnboarding}>{reset ? "Готово" : "Показать снова"}</Button>
      </div>
    </SectionBlock>
  );
}
