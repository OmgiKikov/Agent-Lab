import { Tag } from "../../ui/Tag";

const STATUS: Record<string, string> = {
  pending: "В очереди",
  queued: "В очереди",
  running: "Выполняется",
  done: "Завершён",
  failed: "Сбой выполнения",
  stopped: "Остановлен",
};

export function LaunchStatus({ status }: { status: string }) {
  return (
    <Tag tone={status === "failed" ? "bad" : status === "running" ? "run" : "neutral"}>{STATUS[status] ?? status}</Tag>
  );
}
