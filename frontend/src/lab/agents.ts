import { useQuery } from "@tanstack/react-query";
import { AGENT } from "../app/agent";
import { api } from "./api";

/** An agent the Lab checks, with its last result read from its own database (backend/lab/api.py, /api/agents). */
export type Agent = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  result: { failed: number; measured: number; unmeasured: number; finishedAt: string; metric: string } | null;
};

export const useAgents = () =>
  useQuery({ queryKey: ["agents"], queryFn: () => api<Agent[]>("/api/agents"), staleTime: 10_000 });

/** The agent this page works in, once the list is loaded. */
export function useAgent(): Agent | undefined {
  const { data } = useAgents();
  return data?.find((a) => a.id === AGENT);
}

export const createAgent = (name: string, description: string) => api<Agent>("/api/agents", { name, description });
