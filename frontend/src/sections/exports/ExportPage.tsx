import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ChevronRight, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { assessLink, historyLink, SECTIONS, stageRoot, toneCheckLink, type Check } from "../../app/links";
import { CHECK_NAME, CHECKS } from "../../lab/checks";
import { useExportConversation, useExportRows, useExports, type ExportWithChecks } from "../../lab/exports";
import { count, longDay } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import type { Turn } from "../../lab/types";
import { Conversation } from "../../product/Conversation";
import { Button, buttonClass } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Sheet } from "../../ui/Sheet";
import { CheckLine } from "./CheckLine";
import { DeleteExport, RenameExport } from "./ExportDialogs";
import { skippedText } from "./ExportsPage";

const PAGE = 50;

/** Where a check of this export starts: tone of voice where its work stands, Точность's window of its start. */
const startLink = (check: Check, id: string) => (check === "tone" ? toneCheckLink(undefined, id) : assessLink(id));

/** A check made of the export: its line, leading to the result or the saved check, and the start of it on this export. */
function CheckOfExport({ check, item }: { check: Check; item: ExportWithChecks }) {
  const line = item.checks[check];
  const to = line ? (line.current ? stageRoot(check) : historyLink(check, line.id)) : null;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4">
      {to ? (
        <Link
          to={to}
          className="min-w-0 flex-1 rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
        >
          <CheckLine check={check} line={line} />
        </Link>
      ) : (
        <CheckLine check={check} line={line} className="min-w-0 flex-1" />
      )}
      <Link to={startLink(check, item.id)} className={buttonClass({ size: "sm" })}>
        {line ? "Проверить снова" : "Проверить"}
      </Link>
    </li>
  );
}

/** One conversation of the export as it was uploaded, in a sheet over the list. */
function ConversationSheet({
  id,
  name,
  dialogueId,
  onClose,
}: {
  id: string;
  name: string;
  dialogueId: string | null;
  onClose: () => void;
}) {
  const found = useExportConversation(id, dialogueId);
  const turns = found.data?.messages.map((m): Turn => ({
    role: m.role === "user" ? "customer" : "agent",
    text: m.content,
  }));
  return (
    <Sheet open={!!dialogueId} onClose={onClose} title="Разговор" sub={`Выгрузка «${name}»`} width="lg">
      <div className="px-5 py-5">
        {found.error ? (
          <LoadFailed title="Не удалось загрузить разговор" error={found.error} onRetry={() => void found.refetch()} />
        ) : turns ? (
          <Conversation turns={turns} />
        ) : (
          <Skeleton className="h-64" />
        )}
      </div>
    </Sheet>
  );
}

/**
 * An export: what it is, what each check found in it and the way to check it, and its conversations as they were
 * uploaded (no verdicts: those belong to a check's result). It is renamed or removed here.
 */
export function ExportPage() {
  const { exportId = "" } = useParams();
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const [limit, setLimit] = useState(PAGE);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { data: all } = useExports(state);
  const rows = useExportRows(exportId, limit);
  const line = state?.exports.find((e) => e.id === exportId) ?? null;
  const item = all?.find((e) => e.id === exportId) ?? null;
  const open = (dialogueId: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (dialogueId) next.set("d", dialogueId);
        else next.delete("d");
        return next;
      },
      { replace: !dialogueId },
    );
  const crumbs = [{ label: "Выгрузки", to: SECTIONS.exports }];
  if (offline && !state)
    return (
      <div className="flex h-full flex-col">
        <Header title="Выгрузка" crumbs={crumbs} />
        <ServiceDown />
      </div>
    );
  if (state && !line)
    return (
      <div className="flex h-full flex-col">
        <Header title="Выгрузка" crumbs={crumbs} />
        <EmptyState
          drop
          title="Такой выгрузки нет"
          action={
            <Link to={SECTIONS.exports} className={buttonClass()}>
              Все выгрузки
            </Link>
          }
        >
          Её удалили, или ссылка неверна.
        </EmptyState>
      </div>
    );
  const running = !!state?.job.running;
  return (
    <div className="flex h-full flex-col">
      <Header
        title={line?.name ?? "Выгрузка"}
        crumbs={crumbs}
        actions={
          line && (
            <>
              <Button variant="ghost" icon={Pencil} onClick={() => setRenaming(true)}>
                Переименовать
              </Button>
              <Button
                variant="ghost"
                icon={Trash2}
                disabled={!item || running}
                title={running ? "Сейчас идёт другая задача" : undefined}
                onClick={() => setDeleting(true)}
              >
                Удалить
              </Button>
            </>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[880px] px-4 pb-24 pt-8 lg:px-10 lg:pt-10">
          {!line ? (
            <Skeleton className="h-40" />
          ) : (
            <>
              <p className="break-words text-read text-fg-2">
                {line.file ? `${line.file} · ` : ""}
                {count(line.total, "разговор", "разговора", "разговоров")} · загружена {longDay(line.uploadedAt)}
              </p>
              {!!line.skipped && <p className="mt-1 text-body text-fg-3">{skippedText(line.skipped)}.</p>}

              <section aria-labelledby="export-checks" className="mt-10">
                <h2 id="export-checks" className="text-lead font-semibold text-fg">
                  Проверки на этой выгрузке
                </h2>
                {item ? (
                  <ul className="mt-2 divide-y divide-line border-y border-line">
                    {CHECKS.map((check) => (
                      <CheckOfExport key={check} check={check} item={item} />
                    ))}
                  </ul>
                ) : (
                  <Skeleton className="mt-3 h-24" />
                )}
                <p className="mt-3 max-w-[64ch] text-small text-fg-3">
                  {CHECK_NAME.tone} и {CHECK_NAME.code.toLowerCase()} считаются отдельно: их числа не складываются.
                </p>
              </section>

              <section aria-labelledby="export-conversations" className="mt-10">
                <h2 id="export-conversations" className="text-lead font-semibold text-fg">
                  Разговоры
                </h2>
                <p className="mt-1 text-body text-fg-3">
                  Как они пришли в файле. Оценки разговоров — в итоге проверки.
                </p>
                {rows.error ? (
                  <LoadFailed
                    title="Не удалось загрузить разговоры"
                    error={rows.error}
                    onRetry={() => void rows.refetch()}
                  />
                ) : !rows.data ? (
                  <Skeleton className="mt-4 h-64" />
                ) : (
                  <>
                    <ul className="mt-4 divide-y divide-line border-y border-line">
                      {rows.data.items.map((row) => (
                        <li key={row.id}>
                          <button
                            type="button"
                            onClick={() => open(row.id)}
                            className={cn(
                              "flex w-full items-start gap-3 px-1 py-3 text-left transition-colors hover:bg-hover",
                              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
                            )}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="line-clamp-2 text-read text-fg">{row.first || "Без слов клиента"}</span>
                              <span className="mt-0.5 block text-small text-fg-3">
                                {count(row.turns, "сообщение", "сообщения", "сообщений")}
                              </span>
                            </span>
                            <ChevronRight aria-hidden className="mt-1 size-4 flex-shrink-0 text-fg-3" />
                          </button>
                        </li>
                      ))}
                    </ul>
                    {rows.data.total > rows.data.items.length && (
                      <div className="mt-4 flex items-center gap-3">
                        <Button loading={rows.isFetching} onClick={() => setLimit((n) => n + PAGE)}>
                          Показать ещё
                        </Button>
                        <span className="text-small text-fg-3">
                          {rows.data.items.length} из {rows.data.total}
                        </span>
                      </div>
                    )}
                  </>
                )}
              </section>
            </>
          )}
        </div>
      </div>
      <ConversationSheet
        id={exportId}
        name={line?.name ?? ""}
        dialogueId={params.get("d")}
        onClose={() => open(null)}
      />
      {line && renaming && <RenameExport line={line} open={renaming} onClose={() => setRenaming(false)} />}
      {item && <DeleteExport item={item} open={deleting} onClose={() => setDeleting(false)} />}
    </div>
  );
}
