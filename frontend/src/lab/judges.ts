import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT } from "../app/agent";
import { api } from "./api";
import { useLabState } from "./LabProvider";
import type { Check, ToneCriterion } from "./types";
import { rememberText } from "./tone";

export type JudgeVersion = {
  id: string;
  setId: string;
  kind: Check;
  name: string;
  version: number;
  policy: string;
  criteria: ToneCriterion[];
  builtin: boolean;
  createdAt: string;
};
export function useJudges(kind: Check) {
  const { state, refresh } = useLabState();
  const cache = useQueryClient();
  // Asked once the state is here: its key changes with the criteria and the sources, and asking before would ask twice
  // on every first look. While the key changes the library before stays on screen (placeholderData).
  const query = useQuery({
    queryKey: ["judges", AGENT, kind, state?.toneOfVoice?.revision, state?.sources.map((s) => s.sha256).join(",")],
    queryFn: () => api<{ versions: JudgeVersion[]; selectedId: string | null }>(`/api/judges/${kind}`),
    enabled: !!state,
    placeholderData: (previous) => previous,
  });
  const reload = async () => {
    await refresh();
    await cache.invalidateQueries({ queryKey: ["judges", AGENT, kind] });
  };
  const changing = useIsMutating({ mutationKey: ["judge-change", AGENT, kind] }) > 0;
  const mutation = useMutation({
    mutationKey: ["judge-change", AGENT, kind],
    mutationFn: async (id: string | null) => {
      await api(`/api/judges/${kind}/select`, { id });
      if (kind === "tone") rememberText("");
      await reload();
    },
  });
  const select = (id: string | null) => mutation.mutateAsync(id);
  return {
    ...query,
    select,
    changing,
    reload,
    selected: query.data?.versions.find((v) => v.id === query.data.selectedId) ?? null,
  };
}
