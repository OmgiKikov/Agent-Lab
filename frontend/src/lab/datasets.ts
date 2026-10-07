import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT } from "../app/agent";
import { api } from "./api";
import { useLabState } from "./LabProvider";

export type Dataset = {
  id: string;
  name: string;
  file: string;
  total: number;
  bytes: number;
  createdAt: string;
  archivedAt: string | null;
};
export type DatasetLibrary = { activeId: string | null; datasets: Dataset[] };
export function useDatasets(archived = false) {
  const { state, refresh } = useLabState();
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ["datasets", AGENT, state?.logs.updatedAt, state?.logs.datasetId, archived],
    queryFn: () => api<DatasetLibrary>(`/api/datasets?archived=${archived}`),
  });
  const changing = useIsMutating({ mutationKey: ["dataset-change", AGENT] }) > 0;
  const mutation = useMutation({
    mutationKey: ["dataset-change", AGENT],
    mutationFn: async ({
      action,
      id,
      extra,
    }: {
      action: "select" | "archive" | "rename";
      id: string;
      extra: { name?: string; undo?: boolean };
    }) => {
      await api(`/api/datasets/${action}`, { id, ...extra });
      await refresh();
      await cache.invalidateQueries({ queryKey: ["datasets", AGENT] });
    },
  });
  const change = (action: "select" | "archive" | "rename", id: string, extra: { name?: string; undo?: boolean } = {}) =>
    mutation.mutateAsync({ action, id, extra });
  return { ...query, change, changing };
}
