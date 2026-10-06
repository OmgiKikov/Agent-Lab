// Production is served by the Python backend itself; Vite proxies /api during development.
import { AGENT } from "../app/agent";

const API = import.meta.env.VITE_LAB_API_BASE_URL ?? "";
/** Every call works inside the agent of the page (backend/lab/app.py, X-Agent), or inside the one it names. */
const agentHeader = (agent: string | null): Record<string, string> => (agent ? { "X-Agent": agent } : {});
const AGENT_HEADER = agentHeader(AGENT);

/** What went wrong in words: the service's own message, or the first of FastAPI's validation messages. */
function problem(detail: unknown, status: number): string {
  if (typeof detail === "string") return detail;
  const first = Array.isArray(detail) ? (detail[0] as { msg?: unknown } | undefined) : undefined;
  if (first && typeof first.msg === "string") return `Сервис не принял запрос (${first.msg}).`;
  return `Сервис ответил ошибкой (HTTP ${status}).`;
}

async function read<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(problem((data as { detail?: unknown }).detail, response.status));
  return data as T;
}

/** GET without a body, POST with one; inside the agent of the page unless another is named (a new agent's first call). */
export async function api<T>(path: string, body?: unknown, agent: string | null = AGENT): Promise<T> {
  const headers = agentHeader(agent);
  const init =
    body === undefined
      ? { headers }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        };
  return read<T>(await fetch(API + path, init));
}

/** A file sent as the body, its name in the address with what else the address carries (`extra`, empty ones left out). */
export async function upload<T>(path: string, file: File, extra: Record<string, string> = {}): Promise<T> {
  const query = new URLSearchParams({ name: file.name });
  for (const [key, value] of Object.entries(extra)) if (value) query.set(key, value);
  return read<T>(await fetch(`${API}${path}?${query}`, { method: "POST", body: file, headers: AGENT_HEADER }));
}
