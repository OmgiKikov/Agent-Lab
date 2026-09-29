const DEFAULT_API = "http://127.0.0.1:5901";

export const API = (() => {
  try { return localStorage.getItem("lab.api") || DEFAULT_API; } catch { return DEFAULT_API; }
})();

async function read<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { detail?: string }).detail || `HTTP ${response.status}`);
  return data as T;
}

/** GET without a body, POST with one. */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const init = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  return read<T>(await fetch(API + path, init));
}

export async function upload<T>(path: string, file: File): Promise<T> {
  return read<T>(await fetch(`${API}${path}?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file }));
}
