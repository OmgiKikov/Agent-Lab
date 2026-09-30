/** Where each part of the product lives; every screen links through these, so a section moves in one place. */
export const LINKS = {
  problems: "/problems",
  dialogs: "/dialogs",
  rules: "/rules",
  review: "/review",
  simulations: "/simulations",
  scenarios: "/simulations?mode=scenarios",
  agent: "/agent",
  logs: "/dialogs",
  settings: "/settings",
  trace: (traceId: string) => `/runs/${encodeURIComponent(traceId)}`,
};
