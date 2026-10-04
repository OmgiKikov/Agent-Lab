import { useQuery } from "@tanstack/react-query";
import { AGENT } from "../app/agent";
import { api } from "./api";
import { count } from "./format";
import type { Check } from "./types";

/** The result of one check in a line: errors of measured, not checked, when. */
export type CheckLine = { failed: number; measured: number; unmeasured: number; finishedAt: string };

/**
 * An agent's rules of communication in a line: their name, how many criteria were collected from them (0 before that),
 * and their hash, which says whether two agents have the same rules.
 */
export type Rules = { name: string; criteria: number; sha256: string | null };

/**
 * An agent the Lab checks, with the result of each check and its rules of communication, read from its own database
 * (backend/lab/api.py, /api/agents).
 */
export type Agent = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  results: Record<Check, CheckLine | null>;
  rules: Rules | null;
};

export const useAgents = () =>
  useQuery({ queryKey: ["agents"], queryFn: () => api<Agent[]>("/api/agents"), staleTime: 10_000 });

/** The agent this page works in, once the list is loaded. */
export function useAgent(): Agent | undefined {
  const { data } = useAgents();
  return data?.find((a) => a.id === AGENT);
}

export const createAgent = (name: string, description: string) => api<Agent>("/api/agents", { name, description });

/** An agent whose rules of communication another agent can take. */
export type RulesSource = Agent & { rules: Rules };

/** The agents with rules of communication, but `except` (this page's agent): where the rules can be taken from. */
export function useRulesSources(except: string | null = AGENT): RulesSource[] {
  const { data } = useAgents();
  return (data ?? []).filter((a): a is RulesSource => a.id !== except && !!a.rules);
}

/** «Правила общения.md · 14 критериев»: what taking an agent's rules brings. */
export const rulesLine = (rules: Rules) =>
  `${rules.name} · ${rules.criteria ? count(rules.criteria, "критерий", "критерия", "критериев") : "критерии ещё не собраны"}`;

/**
 * The rules of communication of another agent and their criteria, with the clarifications people confirmed, become the
 * own of this page's agent, or of `into` (a new agent), as a copy: later changes in either never reach the other.
 * `unchanged`: it had the same rules and criteria already.
 */
export const takeRules = (from: string, into: string | null = AGENT) =>
  api<{ ok: boolean; unchanged: boolean }>("/api/tone-of-voice/copy", { agent: from }, into);
