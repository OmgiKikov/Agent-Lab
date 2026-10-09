import { ChevronsUpDown } from "lucide-react";
import { useAgents } from "../lab/agents";
import { Menu } from "../ui/Menu";
import { AGENT, agentHref } from "./agent";
import { Mark } from "./Mark";

/**
 * The agent this product works in, at the top of the navigation, and the way to another one: the agents (this one
 * ticked), all agents, a new agent. Switching is a move to the other agent's address, so nothing of this one stays.
 */
export function AgentSwitch() {
  const { data } = useAgents();
  const current = data?.find((a) => a.id === AGENT);
  const items = [
    ...(data ?? []).map((a) => ({
      key: a.id,
      label: a.name,
      sub: a.description || undefined,
      on: a.id === AGENT,
      run: () => window.location.assign(agentHref(a.id)),
    })),
    { key: "all", label: "Все агенты", run: () => window.location.assign("/agents") },
    { key: "new", label: "Новый агент", run: () => window.location.assign("/agents?new=1") },
  ];
  return (
    <Menu
      className="w-full"
      items={items}
      trigger={
        <span
          title={current ? [current.name, current.description].filter(Boolean).join(" · ") : undefined}
          className="flex w-full items-center gap-3 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-hover"
        >
          <Mark />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-read font-semibold leading-5 text-fg">
              {current?.name ?? "Agent Lab"}
            </span>
            {/* An agent without a description is its name alone: the product's name is not what it is. */}
            {current?.description && <span className="block truncate text-small text-fg-3">{current.description}</span>}
          </span>
          <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-fg-3" />
        </span>
      }
    />
  );
}
