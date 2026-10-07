import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { launchLink } from "../../app/links";
import { Skeleton } from "../../ui/EmptyState";
import { LaunchStatus } from "./LaunchStatus";
import { Header } from "../../app/Header";
import { MODE_NAME, useLaunches, type Mode } from "../../lab/launches";
import { when } from "../../lab/format";
import { CHECK_NAME } from "../../lab/checks";
import type { Check } from "../../lab/types";
import { LoadFailed } from "../../ui/LoadFailed";

export function LaunchHistory({ check }: { check?: Check }) {
  const q = useLaunches(check);
  return (
    <section className="mt-8">
      <h2 className="text-read font-semibold text-fg">История запусков</h2>
      {q.isError ? (
        <LoadFailed title="История не загрузилась" error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="mt-3 h-24" />
      ) : (
        <div className="mt-3 divide-y divide-line rounded-block border border-line">
          {q.data?.launches.map((r) => (
            <Link
              key={r.id}
              to={launchLink(r.check, r.id)}
              className="flex flex-wrap items-center gap-3 px-5 py-4 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60"
            >
              <div className="min-w-0 flex-1 basis-52">
                <p className="text-body font-medium text-fg">
                  {r.agentVersion || CHECK_NAME[r.check]} · {r.dataset?.name || r.dataset?.file || "Датасет"}
                </p>
                <p className="mt-1 text-small text-fg-3">
                  {when(r.startedAt)} ·{" "}
                  {Object.keys(r.modes)
                    .map((k) => MODE_NAME[k as Mode])
                    .join(" + ")}
                </p>
              </div>
              <LaunchStatus status={r.status} />
              <ChevronRight className="size-4 shrink-0 text-fg-3" />
            </Link>
          ))}
          {q.data && !q.data.launches.length && (
            <p className="p-5 text-body text-fg-3">Запусков с выбранными режимами пока нет.</p>
          )}
        </div>
      )}
    </section>
  );
}
export function AllLaunches() {
  return (
    <div>
      <Header title="Запуски" />
      <div className="max-w-[1180px] px-4 pb-16 lg:px-10">
        <LaunchHistory />
      </div>
    </div>
  );
}
