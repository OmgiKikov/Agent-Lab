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

/** A browser storage key of this agent: drafts and choices never pass from one agent to another. */
export const agentKey = (name: string) => `${name}@${AGENT ?? ""}`;

/** The full address of a place inside this agent, for a link someone else opens: origin and «/a/<id>». */
export const shareBase = () => window.location.origin + BASE;

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

/** A deleted agent is not the one «/» returns to. */
export function forgetAgent(id: string) {
  try {
    if (localStorage.getItem(KEY) === id) localStorage.removeItem(KEY);
  } catch {
    /* private mode or blocked storage: nothing was remembered */
  }
}

export function lastAgent(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
