import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Header } from "../../app/Header";
import { Mark } from "../../app/Mark";
import { exportLink } from "../../app/links";
import { CHECKS } from "../../lab/checks";
import { useExports, type ExportWithChecks } from "../../lab/exports";
import { count, longDay, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { CheckLine } from "./CheckLine";
import { UploadExport } from "./UploadExport";

/** «M не загружены: …» — the conversations of the file a check cannot read, and why. */
export const skippedText = (skipped: number) =>
  `ещё ${count(skipped, "разговор не загружен", "разговора не загружены", "разговоров не загружены")}: ${plural(skipped, "в нём", "в них", "в них")} первым пишет агент или он не отвечает`;

/** One export in the list: its name, the file and its size, and what each check found in it, leading to its page. */
function ExportRow({ item }: { item: ExportWithChecks }) {
  return (
    <Link
      to={exportLink(item.id)}
      className="flex items-start gap-4 rounded-control px-1 py-5 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
    >
      <div className="min-w-0 flex-1">
        <p className="break-words text-read font-semibold text-fg">{item.name}</p>
        <p className="mt-1 break-words text-body text-fg-3">
          {item.file ? `${item.file} · ` : ""}
          {count(item.total, "разговор", "разговора", "разговоров")} · загружена {longDay(item.uploadedAt)}
          {item.skipped ? ` · ${skippedText(item.skipped)}` : ""}
        </p>
        <div className="mt-3 space-y-1">
          {CHECKS.map((check) => (
            <CheckLine key={check} check={check} line={item.checks[check]} />
          ))}
        </div>
      </div>
      <ArrowRight aria-hidden className="mt-1 size-4 flex-shrink-0 text-fg-3" />
    </Link>
  );
}

/**
 * «Выгрузки»: every export of the agent's chat, the newest first, each with what the checks found in it. Each upload
 * is an export of its own: a check is started on the one chosen for it, and a new upload changes nothing checked.
 */
export function ExportsPage() {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const { data, error, refetch, isLoading } = useExports(state);
  // ⌘K «Загрузить выгрузку» opens the window at once, and only once: the address forgets it (Back and a reload do
  // not open it again), and the window is the page's, whichever of its two places the button is in.
  const [uploading, setUploading] = useState(params.get("upload") === "1");
  useEffect(() => {
    if (params.get("upload"))
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("upload");
          return next;
        },
        { replace: true },
      );
  }, [params, setParams]);
  const upload = <UploadExport open={uploading} onOpen={setUploading} />;
  const empty = !!state && !state.exports.length;
  return (
    <div className="flex h-full flex-col">
      <Header title="Выгрузки" actions={!empty && upload} />
      <div className="min-h-0 flex-1 overflow-auto">
        {offline && !state ? (
          <ServiceDown />
        ) : empty ? (
          <div className="mx-auto w-full max-w-2xl px-5 py-14">
            <Mark quiet className="size-12 rounded-2xl" />
            <h2 className="mt-6 text-title font-semibold text-fg">Здесь будут выгрузки чата</h2>
            <p className="mt-2 max-w-[60ch] text-read text-fg-2">
              Загрузите Excel-выгрузку чата (лист «Данные») или .jsonl. Из неё проверки берут настоящие разговоры
              клиентов с агентом. Выгрузок может быть несколько: например, за разные месяцы.
            </p>
            <div className="mt-8">{upload}</div>
          </div>
        ) : (
          <div className="max-w-[880px] px-4 pb-24 pt-8 lg:px-10 lg:pt-10">
            <p className="max-w-[64ch] text-read text-fg-2">
              Каждая загрузка — отдельная выгрузка. Проверку запускают на выбранной, а новая выгрузка ничего не меняет в
              проверенном.
            </p>
            <div className="mt-6">
              {error ? (
                <LoadFailed title="Не удалось загрузить выгрузки" error={error} onRetry={() => void refetch()} />
              ) : isLoading || !data ? (
                <Skeleton className="h-40" />
              ) : (
                <div className="divide-y divide-line border-y border-line">
                  {data.map((item) => (
                    <ExportRow key={item.id} item={item} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
