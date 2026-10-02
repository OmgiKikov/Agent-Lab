import { useEffect } from "react";
import { createBrowserRouter, useLocation } from "react-router-dom";
import { agentHref, lastAgent } from "./app/agent";
import { ScreenError } from "./app/ScreenError";
import { useAgents } from "./lab/agents";
import { AgentsPage } from "./sections/agents/AgentsPage";

/**
 * An address without an agent. «/» and older addresses (/overview, /logs/…) open the agent used last on this computer,
 * or the only one; otherwise the list of agents.
 */
function EnterAgent() {
  const { pathname, search } = useLocation();
  const { data } = useAgents();
  useEffect(() => {
    if (!data) return;
    const last = lastAgent();
    const target = data.find((a) => a.id === last)?.id ?? (data.length === 1 ? data[0].id : null);
    window.location.replace(target ? agentHref(target, pathname === "/" ? "" : pathname) + search : "/agents");
  }, [data, pathname, search]);
  return null;
}

export const homeRouter = createBrowserRouter([
  { path: "/agents", element: <AgentsPage />, errorElement: <ScreenError /> },
  { path: "*", element: <EnterAgent />, errorElement: <ScreenError /> },
]);
