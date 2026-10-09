import { Tag } from "../../ui/Tag";

/** A check's status, and the status of each way it checks by, in the words of a check: «проверка» is feminine. */
const STATUS: Record<string, string> = {
  pending: "В очереди",
  queued: "В очереди",
  running: "Выполняется",
  done: "Завершена",
  failed: "Не удалась",
  stopped: "Остановлена",
};

export function LaunchStatus({ status }: { status: string }) {
  return (
    <Tag tone={status === "failed" ? "bad" : status === "running" ? "run" : "neutral"}>{STATUS[status] ?? status}</Tag>
  );
}
