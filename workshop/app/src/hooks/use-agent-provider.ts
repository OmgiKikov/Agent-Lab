import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getAgentProvider, setAgentProvider } from "../api/agents";
import { useWorkshopEvent } from "./use-workshop-ws";
import { isAgentProvider, type AgentProviderId } from "../utils/agent-provider";

export function useAgentProvider() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["agent-provider"],
    queryFn: getAgentProvider,
  });

  useWorkshopEvent("agent_provider", (data: { provider?: string }) => {
    if (isAgentProvider(data.provider)) {
      queryClient.setQueryData(["agent-provider"], data.provider);
    }
  });

  const mutation = useMutation({
    mutationFn: setAgentProvider,
    onMutate: async (provider: AgentProviderId) => {
      await queryClient.cancelQueries({ queryKey: ["agent-provider"] });
      const previous = queryClient.getQueryData<AgentProviderId>(["agent-provider"]);
      queryClient.setQueryData(["agent-provider"], provider);
      return { previous };
    },
    onError: (_error, _provider, context) => {
      if (context?.previous) queryClient.setQueryData(["agent-provider"], context.previous);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-provider"] });
    },
  });

  return {
    provider: query.data ?? "claude",
    isLoading: query.isLoading,
    setProvider: mutation.mutateAsync,
  };
}
