/**
 * The agent this page works in: the first segment of the address, /a/<id>/…. Inside it every link of the product stays
 * relative to that agent (the router's basename); switching agents is a full move to another address, a clean start.
 */
const MATCH = /^\/a\/([^/]+)/;
const KEY = "agent-lab:last-agent";

export const AGENT: string | null = (() => {
  const id = window.location.pathname.match(MATCH)?.[1];
  return id ? decodeURIComponent(id) : null;
})();

export const BASE = AGENT ? `/a/${encodeURIComponent(AGENT)}` : "";

/** The address of a place inside an agent: «/a/acquiring/overview». */
export const agentHref = (id: string, path = "") => `/a/${encodeURIComponent(id)}${path}`;

/** The agent opened last on this computer, so «/» returns to it. Storage may be unavailable: then nothing. */
export function rememberAgent(id: string) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode or blocked storage: «/» falls back to the list */
  }
}

export function lastAgent(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
