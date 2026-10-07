import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { api } from "../../lab/api";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/EmptyState";
import { useToast } from "../../ui/toast";

/** A profile to start from when the agent has none: the fields the pipeline reads (backend/lab/domain/profile.py). */
const BLANK = {
  name: "",
  domain: "",
  includes: [],
  excludes: [],
  taskExamples: [],
  objectExamples: [],
  categoryExamples: {},
  identifiers: [{ key: "account", label: "номер договора", value: "" }],
  export: { agentCode: null, sharedAgents: [], statusMarker: null, stressStatuses: [] },
};

const text = (value: unknown) => JSON.stringify(value, null, 2);

/**
 * «Профиль агента»: what its customers come with and which numbers they name — the episode reader, the catalog and the
 * cards are told it, so the same pipeline serves any support agent. Written as JSON and checked by the service; an
 * agent the Lab ships no profile for needs one before its catalog and cards are built.
 */
export function AgentProfile() {
  const found = useQuery({
    queryKey: ["agent-profile"],
    queryFn: () => api<Record<string, unknown>>("/api/profile"),
    retry: false,
    staleTime: Infinity,
  });
  const saved = found.data ? text(found.data) : found.error ? text(BLANK) : "";
  return (
    <section aria-label="Профиль агента" className="mt-10">
      <h2 className="text-title font-semibold text-fg">Профиль агента</h2>
      <p className="mb-3 mt-1 text-small text-fg-3">
        С чем приходят клиенты агента и какие номера они называют. По профилю читаются разговоры, строятся каталог
        бизнес-сценариев и карточки. В идентификаторах <span className="font-mono">value</span> — регулярное выражение
        того, как номер выглядит в реплике клиента.
      </p>
      {found.isLoading ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          {found.error && !found.data && (
            <p className="mb-2 text-small text-warn">
              {found.error instanceof Error ? found.error.message : String(found.error)}
            </p>
          )}
          <ProfileForm key={saved} saved={saved} />
        </>
      )}
    </section>
  );
}

/** The profile as JSON, saved when it changed; the service checks it and says what is wrong. */
function ProfileForm({ saved }: { saved: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const save = () => {
    let value: unknown;
    try {
      value = JSON.parse(draft);
    } catch {
      toast.error(new Error("Профиль записан не как JSON."));
      return;
    }
    setSaving(true);
    api("/api/profile", value)
      .then(() => client.invalidateQueries({ queryKey: ["agent-profile"] }))
      .then(() => toast.notify("Профиль сохранён. Разговоры прочитаются по нему заново при следующей сборке."))
      .catch(toast.error)
      .finally(() => setSaving(false));
  };
  return (
    <>
      <textarea
        aria-label="Профиль агента в JSON"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        rows={16}
        className="w-full rounded-control border border-line-strong bg-transparent px-3 py-2 font-mono text-meta text-fg outline-none transition-colors focus:border-fg-3"
      />
      <div className="mt-3">
        <Button icon={Save} loading={saving} disabled={draft === saved} onClick={save}>
          Сохранить профиль
        </Button>
      </div>
    </>
  );
}
