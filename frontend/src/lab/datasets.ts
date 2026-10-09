import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT } from "../app/agent";
import { api } from "./api";
import { count, longDay } from "./format";
import { useLabState } from "./LabProvider";

export type Dataset = {
  id: string;
  name: string;
  file: string;
  total: number;
  bytes: number;
  createdAt: string;
  archivedAt: string | null;
  /** The conversations its upload left out (the agent wrote first, or never answered); null when not known. */
  skipped?: number | null;
  /** The version of the agent whose answers the dataset holds, as a person named it; empty when nobody did. */
  agentVersion?: string;
};
export type DatasetLibrary = { activeId: string | null; datasets: Dataset[] };
/**
 * What a person changes in a dataset (api/logs.py, dataset_action): which one the checks go by, the archive, its name,
 * the version of the agent whose answers it holds (`agentVersion`, '' when not known).
 */
type Change = "select" | "archive" | "rename" | "version";
type ChangeExtra = { name?: string; undo?: boolean; agentVersion?: string };
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
    mutationFn: async ({ action, id, extra }: { action: Change; id: string; extra: ChangeExtra }) => {
      await api(`/api/datasets/${action}`, { id, ...extra });
      await refresh();
      await cache.invalidateQueries({ queryKey: ["datasets", AGENT] });
    },
  });
  const change = (action: Change, id: string, extra: ChangeExtra = {}) => mutation.mutateAsync({ action, id, extra });
  return { ...query, change, changing };
}

/** A dataset in words: how many conversations, when it came, and its file when it is named otherwise. */
export const datasetFacts = (d: Dataset) =>
  [
    count(d.total, "разговор", "разговора", "разговоров"),
    `загружен ${longDay(d.createdAt)}`,
    d.file && d.file !== d.name ? `файл ${d.file}` : null,
  ].filter(Boolean) as string[];
