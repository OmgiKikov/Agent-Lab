/**
 * Where each part of the product lives. Sections not rebuilt yet still open their earlier screens:
 * plan 2 moves «Правила», plan 3 «Диалоги» and the logs, plan 4 «Симуляции» and «Агент».
 */
export const LINKS = {
  problems: "/problems",
  dialogs: "/runs",
  rules: "/lab/criteria",
  simulations: "/lab/checks",
  scenarios: "/lab/checks",
  agent: "/lab/agent",
  logs: "/lab/logs",
  settings: "/settings",
  trace: (traceId: string) => `/runs/${encodeURIComponent(traceId)}`,
};
