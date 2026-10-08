import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check as CheckIcon, Code2, Globe, Monitor, PlugZap, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../../lab/api";
import type { Client, LabState, Probe, Target } from "../../lab/types";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Field";
import { Label } from "../../ui/Label";
import { useToast } from "../../ui/toast";
import { agentKey } from "../../app/agent";
import { KnowledgeField, ToolsField, type AgentContext } from "./ContextFields";
import { ACCURACY, SIMULATIONS } from "../../app/product";

type Answer = Probe & { question?: string };
/** The last answer of the agent: on which way and where (`where`, since this change), what it said and when. */
type Last = { target: string; where?: string; text: string; at: string };

/** A way to the agent and where it leads: a check's answer belongs to this, never to the way chosen meanwhile. */
const targetKey = (target: Target) => `${target.id}|${target.where}`;

/** The last answer of the agent on this very connection, or none: one on another way says nothing about this one. */
const lastOn = (last: Last | null, target: Target | undefined) =>
  last && target && last.target === target.id && (last.where === undefined || last.where === target.where)
    ? last
    : null;

const LAST = agentKey("lab.agent.lastCheck"),
  WAY = agentKey("lab.agent.way"),
  CHANGED = "lab-agent-connection";
const words = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** An EPK's organization as typed: the terminal numbers in one line. */
type Draft = { name: string; inn: string; terminals: string };
const draftOf = (c?: Client): Draft => ({
  name: c?.name ?? "",
  inn: c?.inn ?? "",
  terminals: (c?.terminals ?? []).join(" "),
});

/** The organizations of the EPK ids talked as, as the service keeps them: one described by nothing is left out. */
function described(ids: string[], drafts: Record<string, Draft>): Record<string, Client> {
  return Object.fromEntries(
    ids.flatMap((id) => {
      const d = drafts[id];
      const c = d && { name: d.name.trim(), inn: d.inn.trim(), terminals: words(d.terminals) };
      return c && (c.name || c.inn || c.terminals.length) ? [[id, c] as const] : [];
    }),
  );
}

const sameClients = (a: Record<string, Client>, b: Record<string, Client>) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(
    ([id, c]) =>
      b[id] && c.name === b[id].name && c.inn === b[id].inn && c.terminals.join(" ") === b[id].terminals.join(" "),
  );

/** How each way reaches the agent; the ways are named by the service (backend/lab/agents, NAMES), as in «Сыграть». */
const WAY_LOOK: Record<string, { icon: typeof Globe; how: string }> = {
  prod: { icon: Globe, how: "по адресу на стенде" },
  "local-http": { icon: Monitor, how: "уже запущен здесь" },
  "local-code": { icon: Code2, how: "запускаем на время прогона" },
};

const read = <T,>(key: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window: the page still works */
  }
  window.dispatchEvent(new Event(CHANGED));
};

/** What the page remembers of the connection: the last successful check and the way chosen last. */
export function useConnectionMemory() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    window.addEventListener(CHANGED, f);
    return () => window.removeEventListener(CHANGED, f);
  }, []);
  return { last: read<Last>(LAST), way: read<string>(WAY) };
}

/** Where the agent runs: the way chosen, else the one that has an address. */
export function wayOf(state: LabState, chosen: string | null) {
  if (chosen && state.targets.some((t) => t.id === chosen)) return chosen;
  return state.settings.prodUrl ? "prod" : state.settings.repo ? "local-code" : null;
}

const INPUT = "h-9 font-mono text-small";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-small font-medium text-fg-2">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-small text-fg-3">{hint}</span>}
    </label>
  );
}

/**
 * How far a way is set up, in words that do not promise more than is known: an address only says where the agent is
 * («адрес задан»), whether it answers is told by «Проверить связь»; the agent from its code is «готово» only when the
 * service found how to start it (backend/lab/agents, public).
 */
function readiness(target: Target): { word: string; ok: boolean } {
  if (!target.ready) return { word: "не настроено", ok: false };
  return target.kind === "code" ? { word: "готово", ok: true } : { word: "адрес задан", ok: false };
}

function Way({ target, on, onPick }: { target: Target; on: boolean; onPick: () => void }) {
  const look = WAY_LOOK[target.id] ?? { icon: Globe, how: target.note };
  const ready = readiness(target);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onPick}
      className={cn(
        "grid w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-1 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60",
        on ? "text-fg" : "text-fg-2 hover:text-fg",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-4 items-center justify-center rounded-full border",
          on ? "border-fg bg-fg" : "border-fg-4",
        )}
      >
        {on && <span className="size-1.5 rounded-full bg-canvas" />}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-body font-medium">
          <look.icon aria-hidden className="size-4 text-fg-3" />
          {target.name}
        </span>
        <span className="mt-0.5 block text-small text-fg-3">
          {look.how}
          {target.where ? ` · ${target.where}` : ""}
        </span>
      </span>
      <span
        className={cn(
          "inline-flex items-center gap-1 whitespace-nowrap text-small",
          ready.ok ? "text-ok" : target.ready ? "text-fg-2" : "text-fg-3",
        )}
      >
        {ready.ok && <CheckIcon aria-hidden className="size-3.5" />}
        {ready.word}
      </span>
    </button>
  );
}

/** A link to a repository, not a folder: «https://…», «ssh://…». The scp form «git@host:path» is said to be rewritten. */
const isLink = (text: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
const scpForm = (text: string) => /^[^\s/@]+@[^\s/:]+:/.test(text);

/**
 * The agent's card: how to reach it, whose clients the simulator writes for, where its code is (a folder here or a
 * link to its repository), the tools and the knowledge base the judge is told about; one save for all of it. Each
 * check's answer is kept by the connection it asked (targetKey): switching the way while «Проверить связь» is on its
 * way never shows the old connection's answer under the new one.
 */
export function ConnectionForm({
  state,
  agent,
  context,
  onSaved,
}: {
  state: LabState;
  /** Who the agent is: its name and one line about it, as the list of agents shows them. */
  agent: { id: string; name: string; description: string };
  context: AgentContext;
  onSaved: () => Promise<unknown>;
}) {
  const { refresh } = useLabState();
  const toast = useToast();
  const cache = useQueryClient();
  const saved = state.settings;
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const identityDirty = name.trim() !== agent.name || description.trim() !== agent.description;
  const memory = useConnectionMemory();
  const [way, setWay] = useState(wayOf(state, memory.way) ?? "prod");
  const [prodUrl, setProdUrl] = useState(saved.prodUrl);
  const [epk, setEpk] = useState(saved.epk.join(" "));
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(Object.entries(saved.clients).map(([id, c]) => [id, draftOf(c)])),
  );
  // Where the code is: the repository's link when one is saved, else the folder.
  const [code, setCode] = useState(context.repositoryUrl || saved.repo);
  const [known, setKnown] = useState(context);
  const [saving, setSaving] = useState(false);
  const [checks, setChecks] = useState<Record<string, Answer | "pending">>({});
  const link = isLink(code.trim());
  const nextContext = { ...known, repositoryUrl: link ? code.trim() : "" };
  const nextRepo = link ? saved.repo : code.trim();
  const contextDirty = JSON.stringify(nextContext) !== JSON.stringify(context);
  const ids = words(epk);
  const clients = described(ids, drafts);
  const dirty =
    identityDirty ||
    prodUrl.trim() !== saved.prodUrl ||
    nextRepo !== saved.repo ||
    ids.join(" ") !== saved.epk.join(" ") ||
    !sameClients(clients, saved.clients) ||
    contextDirty;
  const draft = (id: string, field: keyof Draft, value: string) =>
    setDrafts((all) => ({ ...all, [id]: { ...draftOf(), ...all[id], [field]: value } }));
  const target = state.targets.find((t) => t.id === way);
  const check = target ? (checks[targetKey(target)] ?? null) : null;
  const last = lastOn(memory.last, target);
  const pick = (id: string) => {
    setWay(id);
    write(WAY, id);
  };
  // What the service may refuse goes first (the links of the repository and of IDP are checked there), the name last:
  // a refusal leaves everything as it was saved before, and the form keeps every edit to fix and save again.
  const save = () => {
    setSaving(true);
    (contextDirty ? api("/api/agent/context", nextContext) : Promise.resolve())
      .then(() => api("/api/settings", { prodUrl: prodUrl.trim(), epk: ids, clients, repo: nextRepo }))
      .then(() =>
        identityDirty
          ? api("/api/agents/update", { id: agent.id, name: name.trim(), description: description.trim() })
          : null,
      )
      .then(() => Promise.all([refresh(), onSaved(), cache.invalidateQueries({ queryKey: ["agents"] })]))
      .then(() => toast.notify("Сохранено"))
      .catch(toast.error)
      .finally(() => setSaving(false));
  };
  const run = () => {
    if (!target) return;
    const key = targetKey(target);
    const answer = (value: Answer | null) =>
      setChecks((all) => {
        const next = { ...all };
        if (value) next[key] = value;
        else delete next[key];
        return next;
      });
    setChecks((all) => ({ ...all, [key]: "pending" }));
    api<Answer>(`/api/agents/${encodeURIComponent(target.id)}/check`, {})
      .then((a) => {
        answer(a);
        if (a.ok && a.text)
          write(LAST, {
            target: target.id,
            where: target.where,
            text: a.text,
            at: new Date().toISOString(),
          } satisfies Last);
      })
      .catch((e) => {
        answer(null);
        toast.error(e);
      });
  };
  return (
    <section aria-label="Карточка агента">
      <div className="space-y-4">
        <Field label="Имя">
          <Input
            name="agent-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={!name.trim() || undefined}
          />
        </Field>
        <Field label="Описание" hint="Одна строка о том, что это за агент: её видно в списке агентов.">
          <Input
            name="agent-description"
            value={description}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Например: СберБизнес · чат поддержки"
          />
        </Field>
      </div>
      <h3 className="mb-3 mt-8 text-read font-semibold text-fg">Подключение</h3>
      <Label>Как подключить агента</Label>
      <div role="radiogroup" aria-label="Способ подключения" className="mt-2 border-t border-line">
        {state.targets.map((t) => (
          <Way key={t.id} target={t} on={t.id === way} onPick={() => pick(t.id)} />
        ))}
      </div>
      <div className="mt-5 space-y-4">
        {way === "prod" && (
          <Field
            label="Адрес агента на тестовом стенде"
            hint={`Нужен, чтобы задавать агенту вопросы на стенде${SIMULATIONS ? " и запускать симуляции" : ""}. Открывается с рабочего компьютера.`}
          >
            <Input
              name="prod-url"
              type="url"
              autoComplete="off"
              value={prodUrl}
              onChange={(e) => setProdUrl(e.target.value)}
              placeholder="https://…"
              className={INPUT}
              spellCheck={false}
            />
          </Field>
        )}
        {way === "local-http" && (
          <p className="text-small text-fg-3">
            Адрес не нужен: агент уже запущен на этом компьютере{target?.where ? ` (${target.where})` : ""}.
          </p>
        )}
        {/* The simulations and Точность are hidden in the first release (app/product): their fields with them. */}
        {SIMULATIONS && (
          <Field label="Клиенты для симуляций" hint="ЕПК через пробел. Если пусто, пишет тестовый клиент.">
            <Input
              name="epk"
              autoComplete="off"
              inputMode="numeric"
              value={epk}
              onChange={(e) => setEpk(e.target.value)}
              placeholder="Например: 1234567890 2345678901"
              className={INPUT}
              spellCheck={false}
            />
          </Field>
        )}
        {SIMULATIONS && way === "prod" && ids.length > 0 && (
          <fieldset>
            <legend className="mb-1.5 block text-small font-medium text-fg-2">Реквизиты этих клиентов</legend>
            <div className="space-y-3">
              {ids.map((id) => (
                <div key={id}>
                  <p className="mb-1 font-mono text-meta text-fg-3">ЕПК {id}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      aria-label={`Организация клиента ${id}`}
                      autoComplete="off"
                      value={drafts[id]?.name ?? ""}
                      onChange={(e) => draft(id, "name", e.target.value)}
                      placeholder="Организация"
                      className={INPUT}
                      spellCheck={false}
                    />
                    <Input
                      aria-label={`ИНН клиента ${id}`}
                      autoComplete="off"
                      inputMode="numeric"
                      value={drafts[id]?.inn ?? ""}
                      onChange={(e) => draft(id, "inn", e.target.value)}
                      placeholder="ИНН"
                      className={INPUT}
                      spellCheck={false}
                    />
                    <Input
                      aria-label={`Номера терминалов клиента ${id}`}
                      autoComplete="off"
                      inputMode="numeric"
                      value={drafts[id]?.terminals ?? ""}
                      onChange={(e) => draft(id, "terminals", e.target.value)}
                      placeholder="Номера терминалов через пробел"
                      className={cn(INPUT, "col-span-2")}
                      spellCheck={false}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-small text-fg-3">
              Это клиент сможет назвать агенту: на стенде агент видит настоящие данные этих организаций. Без реквизитов
              клиент скажет, что назвать их не может.
            </p>
          </fieldset>
        )}
      </div>
      {ACCURACY && (
        <>
          <h3 className="mt-8 text-read font-semibold text-fg">Код и знания</h3>
          <div className="mt-4 space-y-5">
            <Field
              label="Код агента"
              hint={
                scpForm(code.trim())
                  ? "Для SSH укажите адрес так: ssh://git@host/team/agent.git"
                  : link
                    ? "Репозиторий скачается кнопкой «Прочитать код», с доступом к Git, настроенным на этом компьютере."
                    : "Папка на этом компьютере или ссылка на Git-репозиторий. Из кода берутся критерии точности."
              }
            >
              <Input
                name="repo"
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="~/Desktop/agent или https://git…/agent.git"
                className={INPUT}
                spellCheck={false}
                aria-invalid={scpForm(code.trim()) || undefined}
              />
            </Field>
            <ToolsField tools={known.tools} onChange={(tools) => setKnown((v) => ({ ...v, tools }))} />
            <KnowledgeField
              value={known}
              saved={!contextDirty}
              onChange={(key, text) => setKnown((v) => ({ ...v, [key]: text }))}
            />
          </div>
        </>
      )}
      {dirty && <p className="mt-5 text-small text-warn">Есть несохранённые изменения</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          icon={Save}
          loading={saving}
          disabled={!dirty || state.job.running || scpForm(code.trim()) || !name.trim()}
          onClick={save}
        >
          Сохранить
        </Button>
        {target && target.kind !== "code" && (
          <Button
            icon={PlugZap}
            loading={check === "pending"}
            disabled={!target.ready || dirty || saving || state.job.running}
            onClick={run}
            title={dirty ? "Сначала сохраните изменения" : undefined}
          >
            Проверить связь
          </Button>
        )}
      </div>
      {target?.kind === "code" && (
        <p className="mt-3 text-small text-fg-3">
          Агент запускается только на время прогона, поэтому связь заранее не проверить.
        </p>
      )}
      {check &&
        check !== "pending" &&
        (check.ok ? (
          <div className="mt-4 space-y-1.5 text-small">
            <p className="text-ok">
              Отвечает{check.seconds ? ` · ${check.seconds.toFixed(1).replace(".", ",")} с` : ""}
              {check.version ? ` · версия ${check.version}` : ""}
            </p>
            {check.question && <p className="text-fg-3">Вопрос: «{check.question}»</p>}
            {check.text && <p className="border-l-2 border-fg-4/60 pl-3 text-fg-2">{check.text}</p>}
          </div>
        ) : (
          <p className="mt-4 text-small text-bad">
            {check.error ||
              `Агент ответил не текстом, а статусом ${check.status ?? "?"}. Так бывает, когда разговор передан оператору.`}
          </p>
        ))}
      {last && !check && (
        <p className="mt-4 text-small text-fg-3">
          В последний раз отвечал{" "}
          {new Date(last.at).toLocaleString("ru-RU", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      )}
    </section>
  );
}
