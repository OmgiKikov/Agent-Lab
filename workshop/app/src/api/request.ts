export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = typeof body?.error === "string"
      ? body.error
      : typeof body?.error?.message === "string"
        ? body.error.message
        : `API error ${res.status}`;
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function apiJsonOrNull<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(path, init);
  if (!res.ok) return null;
  return res.json() as Promise<T>;
}

export async function apiText(path: string, init?: RequestInit): Promise<string> {
  const res = await fetch(path, init);
  const text = await res.text();
  if (!res.ok) throw new Error(text || `API error ${res.status}`);
  return text;
}

export function jsonInit(method: string, body?: unknown, init?: RequestInit): RequestInit {
  return {
    ...init,
    method,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}
