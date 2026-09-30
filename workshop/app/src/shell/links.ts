/** Where each block of the product lives; every screen links through these, so a block moves in one place. */
export const LINKS = {
  agent: "/agent",
  criteria: "/agent/criteria",
  logs: "/logs",
  scenarios: "/scenarios",
  simulations: "/simulations",
  results: "/results",
  settings: "/settings",
  trace: (traceId: string) => `/runs/${encodeURIComponent(traceId)}`,
};

/** A view inside a block: the logs' block for logs, the results' block (of a run) for the simulation. */
export function viewLink(source: "log" | "sim", runId: string | null | undefined, tab: "problems" | "dialogs" | "review", extra: Record<string, string> = {}) {
  const p = new URLSearchParams();
  if (source === "sim" && runId) p.set("run", runId);
  if (tab !== "problems") p.set("tab", tab);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const q = p.toString();
  return `${source === "log" ? LINKS.logs : LINKS.results}${q ? `?${q}` : ""}`;
}
