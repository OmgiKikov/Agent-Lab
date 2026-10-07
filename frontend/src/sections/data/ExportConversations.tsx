import { useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, MessageSquare } from "lucide-react";
import { AGENT } from "../../app/agent";
import { api } from "../../lab/api";
import { count } from "../../lab/format";
import { Conversation } from "../../product/Conversation";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Sheet } from "../../ui/Sheet";

type Preview = { id: string; opening: string; turns: number };
type ExportPage = { items: Preview[]; total: number; offset: number; updatedAt: string | null };
type Transcript = { id: string; messages: { role: "user" | "assistant"; content: string }[] };
const SIZE = 10;

function ExportDialog({
  id,
  stamp,
  onClose,
  trigger,
}: {
  id: string;
  stamp?: string | null;
  onClose: () => void;
  trigger: RefObject<HTMLButtonElement>;
}) {
  const query = useQuery({
    queryKey: ["export-dialog", AGENT, stamp, id],
    queryFn: () => api<Transcript>(`/api/logs/${encodeURIComponent(id)}`),
  });
  return (
    <Sheet
      open
      onClose={onClose}
      onCloseAutoFocus={(event) => {
        if (trigger.current?.isConnected) {
          event.preventDefault();
          trigger.current.focus();
        }
      }}
      title="Разговор из выгрузки"
      sub={
        query.data
          ? `${count(query.data.messages.length, "реплика", "реплики", "реплик")} · как он записан в файле, до проверки`
          : "Как он записан в файле, до проверки"
      }
    >
      <div className="p-5 sm:p-7">
        {query.isPending ? (
          <Skeleton className="h-64" />
        ) : query.isError ? (
          <LoadFailed title="Не удалось открыть диалог" error={query.error} onRetry={() => query.refetch()} />
        ) : (
          <Conversation
            turns={query.data.messages.map((m) => ({
              role: m.role === "user" ? "customer" : "agent",
              text: m.content,
            }))}
          />
        )}
      </div>
    </Sheet>
  );
}

/** Read the imported conversations before paying for a model check; every row opens its actual transcript. */
export function ExportConversations({ stamp }: { stamp?: string | null }) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["export-page", AGENT, stamp, page],
    queryFn: () => api<ExportPage>(`/api/logs?offset=${page * SIZE}&limit=${SIZE}`),
  });
  const data = query.data;
  return (
    <section aria-labelledby="export-conversations" className="mt-10">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="export-conversations" className="text-read font-semibold text-fg">
            Диалоги в выгрузке
          </h2>
          <p className="mt-1 text-small text-fg-3">Откройте разговор, чтобы проверить, как прочитался файл.</p>
        </div>
        {data && (
          <span className="text-small text-fg-3">
            {data.offset + (data.items.length ? 1 : 0)}–{data.offset + data.items.length} из {data.total}
          </span>
        )}
      </div>
      {query.isError ? (
        <LoadFailed title="Не удалось загрузить диалоги" error={query.error} onRetry={() => query.refetch()} />
      ) : query.isPending ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="overflow-hidden rounded-block border border-line">
          <ul className="divide-y divide-line">
            {data?.items.map((dialog) => (
              <li key={dialog.id}>
                <button
                  type="button"
                  onClick={(event) => {
                    trigger.current = event.currentTarget;
                    setSelected(dialog.id);
                  }}
                  className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-hover sm:px-5"
                >
                  <MessageSquare aria-hidden className="hidden size-4 shrink-0 text-fg-3 sm:block" />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-1 text-body font-medium text-fg">{dialog.opening}</span>
                    <span className="mt-1 block truncate text-small text-fg-3">
                      {count(dialog.turns, "реплика", "реплики", "реплик")}
                    </span>
                  </span>
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-4" />
                </button>
              </li>
            ))}
          </ul>
          {!data?.items.length && <p className="p-5 text-body text-fg-3">На этой странице диалогов нет.</p>}
          {data && data.total > SIZE && (
            <div className="flex items-center justify-between border-t border-line px-4 py-3">
              <Button size="sm" icon={ChevronLeft} disabled={!page} onClick={() => setPage((p) => p - 1)}>
                Назад
              </Button>
              <span className="text-small text-fg-3">
                Страница {page + 1} из {Math.ceil(data.total / SIZE)}
              </span>
              <Button size="sm" disabled={(page + 1) * SIZE >= data.total} onClick={() => setPage((p) => p + 1)}>
                Далее
                <ChevronRight aria-hidden className="size-3.5" />
              </Button>
            </div>
          )}
        </div>
      )}
      {selected !== null && (
        <ExportDialog trigger={trigger} key={selected} id={selected} stamp={stamp} onClose={() => setSelected(null)} />
      )}
    </section>
  );
}
