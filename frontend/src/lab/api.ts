import { queryClient } from "../query-client";

// Production is served by FastAPI; Vite proxies /api during development.
const API = import.meta.env.VITE_LAB_API_BASE_URL ?? "";

async function read<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = (data as { detail?: unknown }).detail;
    throw new Error(typeof detail === "string" ? detail : `HTTP ${response.status}`);
  }
  return data as T;
}

export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return read<T>(await fetch(API + path, { signal }));
}

function refresh() {
  void queryClient.invalidateQueries({ queryKey: ["lab"] });
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const result = await read<T>(await fetch(API + path, {
    method: "POST",
    ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  }));
  refresh();
  return result;
}

export async function upload<T>(path: string, file: File): Promise<T> {
  const result = await read<T>(await fetch(`${API}${path}?name=${encodeURIComponent(file.name)}`, {
    method: "POST", body: file,
  }));
  refresh();
  return result;
}
