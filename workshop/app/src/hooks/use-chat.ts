import { useQuery } from "@tanstack/react-query";
import { getAgentLoadout, listAgentSessions } from "../api/chat";

export function useAgentSessions() {
  return useQuery({
    queryKey: ["agent-sessions"],
    queryFn: listAgentSessions,
  });
}

export function useAgentLoadout(provider: string) {
  return useQuery({
    queryKey: ["agent-loadout", provider],
    queryFn: getAgentLoadout,
  });
}
