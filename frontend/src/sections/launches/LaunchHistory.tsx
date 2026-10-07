import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { Header } from "../../app/Header";
import { MODE_NAME, useLaunches, type Mode } from "../../lab/launches";
import { when } from "../../lab/format";
import { CHECK_NAME } from "../../lab/checks";
import type { Check } from "../../lab/types";
import { LoadFailed } from "../../ui/LoadFailed";

export const STATUS: Record<string, string> = {
  pending: "В очереди",
  running: "Выполняется",
  done: "Завершён",
  failed: "Есть ошибки выполнения",
  stopped: "Остановлен",
};
export function LaunchHistory({ check }: { check?: Check }) {
  const q = useLaunches(check);
  return (
    <section className="mt-8">
      <h2 className="text-read font-semibold text-fg">История запусков</h2>
      {q.isError ? (
        <LoadFailed title="История не загрузилась" error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="mt-3 divide-y divide-line rounded-block border border-line">
          {q.data?.launches.map((r) => (
            <Link key={r.id} to={`/launches/${r.id}`} className="flex items-center gap-3 px-5 py-4 hover:bg-hover">
              <div className="min-w-0 flex-1">
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
              <span className={`text-small ${r.status === "failed" ? "text-bad" : "text-fg-3"}`}>
                {STATUS[r.status] ?? r.status}
              </span>
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
