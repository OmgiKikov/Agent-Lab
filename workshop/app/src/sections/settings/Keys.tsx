import { useEffect, useState } from "react";
import { ArrowUpRight, Check, Eye, EyeOff, Trash2 } from "lucide-react";
import { deleteSecret, getSecretStatuses, purgeLegacyBrowserSecrets, saveSecret, type SecretKey, type SecretStatus, type SecretStatuses } from "../../api/secrets";
import { useWorkshopEvent } from "../../hooks/use-workshop-ws";
import { Button } from "../../ui/Button";
import { INPUT, Row } from "./parts";

const KEYS: { key: SecretKey; name: string; use: string; placeholder: string; url: string }[] = [
  { key: "anthropic", name: "Anthropic", use: "Повтор трейсов и чат с ассистентом.", placeholder: "sk-ant-…", url: "https://console.anthropic.com/settings/keys" },
  { key: "openai", name: "OpenAI", use: "Повтор трейсов с моделями GPT.", placeholder: "sk-…", url: "https://platform.openai.com/api-keys" },
  { key: "raindrop", name: "Raindrop", use: "Ключ записи: отправка трейсов.", placeholder: "rk_…", url: "https://app.raindrop.ai" },
  { key: "query", name: "Query API", use: "Поиск событий и Raindrop Cloud MCP.", placeholder: "ключ Query API", url: "https://auth.raindrop.ai/org/api_keys" },
];

type Known = SecretStatus | null | "down";

/** The Workshop's keys: each row says where its key comes from; a new key is pasted in place, goes to the local daemon once and never comes back. */
export function Keys() {
  const [statuses, setStatuses] = useState<SecretStatuses | null | "down">(null);
  useEffect(() => {
    let live = true;
    purgeLegacyBrowserSecrets();
    getSecretStatuses().then(s => { if (live) setStatuses(s); }).catch(() => { if (live) setStatuses("down"); });
    return () => { live = false; };
  }, []);
  const set = (key: SecretKey, status: SecretStatus) => setStatuses(s => s && s !== "down" ? { ...s, [key]: status } : s);
  useWorkshopEvent("secrets_updated", (data: { key?: SecretKey; status?: SecretStatus }) => { if (data?.key && data.status) set(data.key, data.status); });
  return (
    <>
      {statuses === "down" && <p className="mb-3 text-small text-fg-2">Workshop не отвечает, поэтому ключи сейчас не видны. Он запускается вместе с продуктом: <span className="font-mono">sh bin/start.sh</span>.</p>}
      <div className="border-t border-line">
        {KEYS.map(k => <KeyRow key={k.key} spec={k} status={statuses === "down" ? "down" : statuses?.[k.key] ?? null} onStatus={s => set(k.key, s)} />)}
      </div>
    </>
  );
}

function KeyRow({ spec, status, onStatus }: { spec: (typeof KEYS)[number]; status: Known; onStatus: (s: SecretStatus) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = status && status !== "down" ? status : null;
  const close = () => { setOpen(false); setValue(""); setShown(false); setError(null); };
  const run = (work: () => Promise<SecretStatus>) => {
    setBusy(true);
    setError(null);
    work()
      .then(next => {
        onStatus(next);
        purgeLegacyBrowserSecrets();
        window.dispatchEvent(new CustomEvent("workshop:api-key-change", { detail: { secret: spec.key } }));
        close();
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  // A key from the environment wins over a saved one (secret-store.ts), so it is changed where it was set, not here.
  const fromEnv = known?.source === "env";
  const form = open && (
    <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); if (value.trim()) run(() => saveSecret(spec.key, value.trim())); }} onKeyDown={e => { if (e.key === "Escape") close(); }}>
      <div className="relative min-w-0 flex-1 basis-64">
        <input
          autoFocus type={shown ? "text" : "password"} name={`key-${spec.key}`} autoComplete="off" spellCheck={false}
          aria-label={`Новый ключ ${spec.name}`} placeholder={spec.placeholder} value={value} onChange={e => setValue(e.target.value)} className={`${INPUT} pr-9`}
        />
        {value && (
          <button type="button" aria-label={shown ? "Скрыть ключ" : "Показать ключ"} onClick={() => setShown(s => !s)}
            className="absolute inset-y-0 right-0 grid w-9 place-items-center rounded-r-control text-fg-3 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">
            {shown ? <EyeOff aria-hidden className="size-3.5" /> : <Eye aria-hidden className="size-3.5" />}
          </button>
        )}
      </div>
      <Button type="submit" loading={busy} disabled={!value.trim()}>Сохранить</Button>
      <Button variant="ghost" onClick={close}>Отмена</Button>
      {known?.source === "store" && <Button variant="ghost" icon={Trash2} disabled={busy} onClick={() => run(() => deleteSecret(spec.key))}>Удалить</Button>}
      <a href={spec.url} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 rounded text-small text-fg-3 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">
        Где взять ключ<ArrowUpRight aria-hidden className="size-3" />
      </a>
      {error && <p role="alert" className="basis-full text-small text-bad">Не сохранилось: {error}</p>}
    </form>
  );
  return (
    <Row name={spec.name} use={<>{spec.use}{fromEnv && <> Задан переменной <span className="font-mono">{known.env_var}</span>, меняется там.</>}</>} below={form}>
      <KeyWord status={status} />
      {!open && !fromEnv && <Button size="sm" disabled={!known} onClick={() => setOpen(true)}>{known?.configured ? "Заменить" : "Задать"}</Button>}
    </Row>
  );
}

function KeyWord({ status }: { status: Known }) {
  if (status === "down") return <span className="text-small text-fg-4">не видно</span>;
  if (!status) return <span className="text-small text-fg-4">проверяю…</span>;
  if (!status.configured) return <span className="text-small text-fg-3">не задан</span>;
  if (status.source === "env") return <span className="text-small text-fg-2">из окружения</span>;
  return <span className="inline-flex items-center gap-1 text-small text-ok"><Check aria-hidden className="size-3.5" />сохранён</span>;
}
