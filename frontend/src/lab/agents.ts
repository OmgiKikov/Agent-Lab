import { useQuery } from "@tanstack/react-query";
import { AGENT } from "../app/agent";
import { api } from "./api";
import type { Check } from "./types";

/** The result of one check in a line: errors of measured, not checked, when. */
export type CheckLine = { failed: number; measured: number; unmeasured: number; finishedAt: string };

/** An agent the Lab checks, with the result of each check read from its own database (backend/lab/api.py, /api/agents). */
export type Agent = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  results: Record<Check, CheckLine | null>;
};

export const useAgents = () =>
  useQuery({ queryKey: ["agents"], queryFn: () => api<Agent[]>("/api/agents"), staleTime: 10_000 });

/** The agent this page works in, once the list is loaded. */
export function useAgent(): Agent | undefined {
  const { data } = useAgents();
  return data?.find((a) => a.id === AGENT);
}

export const createAgent = (name: string, description: string) => api<Agent>("/api/agents", { name, description });
