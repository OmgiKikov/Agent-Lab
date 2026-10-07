import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { AGENT } from "../../app/agent";
import { useKeys } from "../../app/keys";
import { useWide } from "../../app/useWide";
import { api } from "../../lab/api";
import { count } from "../../lab/format";
import { Conversation } from "../../product/Conversation";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Search } from "../../ui/Search";

type Preview = { id: string; opening: string; turns: number };
type DialoguePage = { items: Preview[]; total: number; offset: number };
type Transcript = { id: string; messages: { role: "user" | "assistant"; content: string }[] };
/** The most conversations the service gives at once (backend: api/logs.py). */
const SIZE = 50;
const enc = encodeURIComponent;

/** Words compared as a person reads them: any case, «ё» as «е». */
const plain = (text: string) => text.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");

function Opened({
  datasetId,
  id,
  place,
  total,
  onBack,
}: {
  datasetId: string;
  id: string;
  place: number | null;
  total: number;
  onBack?: () => void;
}) {
  // A dataset never changes once uploaded: what was read once stays true.
  const query = useQuery({
    queryKey: ["dataset-dialogue", AGENT, datasetId, id],
    queryFn: () => api<Transcript>(`/api/datasets/${enc(datasetId)}/dialogues/${enc(id)}`),
    staleTime: Infinity,
  });
  return (
    <article className="min-h-0 overflow-auto" aria-label="Разговор из датасета">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="sticky top-0 z-10 flex h-11 w-full items-center gap-1.5 border-b border-line bg-canvas px-3 text-body text-fg-2 lg:hidden"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Все разговоры
        </button>
      )}
      <div className="max-w-3xl px-4 pb-16 pt-6 lg:px-10 lg:pt-8">
        <h2 className="text-read font-semibold text-fg">{place ? `Разговор ${place} из ${total}` : "Разговор"}</h2>
        <p className="mt-1 text-small text-fg-3">
          {query.data
            ? `${count(query.data.messages.length, "реплика", "реплики", "реплик")} · как в файле, до проверки`
            : "Как в файле, до проверки"}
        </p>
        <div className="mt-6">
          {query.isPending ? (
            <Skeleton className="h-64" />
          ) : query.isError ? (
            <LoadFailed title="Не удалось открыть разговор" error={query.error} onRetry={() => query.refetch()} />
          ) : (
            <Conversation
              turns={query.data.messages.map((m) => ({
                role: m.role === "user" ? "customer" : "agent",
                text: m.content,
              }))}
            />
          )}
        </div>
      </div>
    </article>
  );
}

function Row({ item, on, onOpen }: { item: Preview; on: boolean; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (on) ref.current?.scrollIntoView({ block: "nearest" });
  }, [on]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      aria-current={on ? "true" : undefined}
      className={cn(
        "block w-full rounded-control px-3 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60",
        on ? "bg-selected" : "hover:bg-hover",
      )}
    >
      <span className="line-clamp-2 text-body text-fg">{item.opening}</span>
      <span className="mt-1 block text-small text-fg-3">{count(item.turns, "реплика", "реплики", "реплик")}</span>
    </button>
  );
}

/**
 * The conversations of a dataset before any check, in the order of its file: a list with a search by the client's first
 * question, and one conversation in full as the file has it. Any dataset reads so, the one in work or not. The list
 * comes in pages as it is scrolled; a search reads the rest of them, since it looks through the whole dataset.
 */
export function ExportConversations({ datasetId }: { datasetId: string }) {
  const [params, setParams] = useSearchParams();
  const wide = useWide();
  const [query, setQuery] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const pages = useInfiniteQuery({
    queryKey: ["dataset-dialogues", AGENT, datasetId],
    queryFn: ({ pageParam }) =>
      api<DialoguePage>(`/api/datasets/${enc(datasetId)}/dialogues?offset=${pageParam}&limit=${SIZE}`),
    staleTime: Infinity,
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.items.length && last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined,
  });
  const all = useMemo(() => pages.data?.pages.flatMap((p) => p.items) ?? [], [pages.data]);
  const total = pages.data?.pages[0]?.total ?? 0;
  const searching = !!query.trim();
  const rows = useMemo(() => {
    const words = plain(query).split(/\s+/).filter(Boolean);
    return words.length ? all.filter((item) => words.every((w) => plain(item.opening).includes(w))) : all;
  }, [all, query]);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = pages;
  const more = hasNextPage && !isFetchingNextPage && !isFetchNextPageError;
  // A search looks through every conversation: the pages not read yet are read one after another.
  useEffect(() => {
    if (searching && more) void fetchNextPage();
  }, [searching, more, fetchNextPage]);
  // Without a search, the next page comes when the end of the list is near.
  useEffect(() => {
    const el = end.current;
    if (!el || searching || !more) return;
    const seen = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void fetchNextPage();
      },
      { root: scroller.current, rootMargin: "600px 0px" },
    );
    seen.observe(el);
    return () => seen.disconnect();
  }, [searching, more, fetchNextPage, all.length]);

  const asked = params.get("d");
  const key = asked ?? (wide ? (rows[0]?.id ?? null) : null);
  const at = key ? all.findIndex((item) => item.id === key) : -1;
  const open = (id: string | null) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (id) n.set("d", id);
        else n.delete("d");
        return n;
      },
      { replace: wide },
    );
  const step = (d: 1 | -1) => {
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.id === key);
    open(rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? -1 : i) + d))].id);
  };
  useKeys({ KeyJ: () => step(1), KeyK: () => step(-1) });
  const reading = !!asked && !wide;
  return (
    <div className="grid min-h-0 flex-1 lg:grid-cols-[400px_minmax(0,1fr)]">
      <div className={cn("flex min-h-0 min-w-0 flex-col border-line lg:border-r", reading && "hidden")}>
        <div className="px-4 pb-3 pt-4">
          <Search value={query} onChange={setQuery} placeholder="Найти по первому вопросу клиента" />
        </div>
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-2 pb-2">
          {pages.isPending ? (
            <Skeleton className="mx-2 h-64" />
          ) : pages.isError && !all.length ? (
            <div className="px-2">
              <LoadFailed title="Не удалось загрузить разговоры" error={pages.error} onRetry={() => pages.refetch()} />
            </div>
          ) : (
            <>
              {rows.length > 0 && (
                <ul aria-label="Разговоры датасета">
                  {rows.map((item) => (
                    <li key={item.id}>
                      <Row item={item} on={item.id === key} onOpen={() => open(item.id)} />
                    </li>
                  ))}
                </ul>
              )}
              {!rows.length && !hasNextPage && (
                <p className="px-3 py-10 text-center text-small text-fg-3">
                  {searching ? "Не нашлось. Поиск идёт по первому вопросу клиента." : "В датасете нет разговоров."}
                </p>
              )}
              <div ref={end} />
              {isFetchNextPageError ? (
                <div className="flex flex-wrap items-center gap-3 px-3 py-4 text-small text-bad">
                  Не удалось загрузить остальные разговоры.
                  <Button size="sm" onClick={() => void fetchNextPage()}>
                    Повторить
                  </Button>
                </div>
              ) : (
                hasNextPage && !searching && <p className="px-3 py-4 text-small text-fg-3">Загружаем ещё…</p>
              )}
            </>
          )}
        </div>
        {searching && pages.data && (
          <p role="status" className="border-t border-line px-4 py-2 text-small text-fg-3">
            {hasNextPage
              ? `Ищем… просмотрено ${all.length} из ${total}, нашлось ${rows.length}`
              : `Нашлось ${rows.length} из ${total}`}
          </p>
        )}
      </div>
      {key && (wide || reading) ? (
        <Opened
          key={key}
          id={key}
          datasetId={datasetId}
          place={at < 0 ? null : at + 1}
          total={total}
          onBack={wide ? undefined : () => open(null)}
        />
      ) : null}
    </div>
  );
}
