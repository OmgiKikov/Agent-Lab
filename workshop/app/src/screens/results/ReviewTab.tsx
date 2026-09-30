import { EmptyState } from "../../ui/EmptyState";

/** «Проверка» of a run: waits for the scoped ReviewView of the review screen. */
export function ReviewTab({ runId }: { runId: string }) {
  return <EmptyState title="Проверка прогона" data-run={runId} />;
}
