// Production is served by the Python backend itself; Vite proxies /api during development.
import { AGENT } from "../app/agent";

const API = import.meta.env.VITE_LAB_API_BASE_URL ?? "";
/** Every call works inside the agent of the page (backend/lab/api.py, X-Agent). */
const AGENT_HEADER: Record<string, string> = AGENT ? { "X-Agent": AGENT } : {};

async function read<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = (data as { detail?: unknown }).detail;
    throw new Error(typeof detail === "string" ? detail : `HTTP ${response.status}`);
  }
  return data as T;
}

/** GET without a body, POST with one. */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const init =
    body === undefined
      ? { headers: AGENT_HEADER }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json", ...AGENT_HEADER },
          body: JSON.stringify(body),
        };
  return read<T>(await fetch(API + path, init));
}

export async function upload<T>(path: string, file: File): Promise<T> {
  return read<T>(
    await fetch(`${API}${path}?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body: file,
      headers: AGENT_HEADER,
    }),
  );
}
