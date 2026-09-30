/**
 * Where each part of the product lives. Sections not rebuilt yet still open their earlier screens:
 * plan 4 moves «Симуляции» and «Агент».
 */
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
