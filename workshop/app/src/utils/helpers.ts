const INACTIVE_MS = 30_000;
// Short post-finish window where the activity pulse is still shown, so a
// run that completes between sidebar glances doesn't appear inert.
const AFTERGLOW_MS = 3_000;

export function fmt(ms: number | null | undefined): string {
  if (!ms || ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function ago(t: number): string {
  const d = Date.now() - t;
  if (d < 5000) return "just now";
  if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  if (d < 2592000000) return `${Math.floor(d / 86400000)}d ago`;
  if (d < 31536000000) return `${Math.floor(d / 2592000000)}mo ago`;
  return `${Math.floor(d / 31536000000)}y ago`;
}

export function isActive(run: { last_updated_at: number; finished?: number | null }): boolean {
  const recencyMs = Date.now() - run.last_updated_at;
  if (recencyMs < AFTERGLOW_MS) return true;
  if (run.finished) return false;
  // Time-based fallback for SDKs that never emit a finish() / root-span close.
  return recencyMs < INACTIVE_MS;
}

export function runDisplayName(
  run: { id: string; display_name?: string | null; event_name: string | null; name: string | null },
  fallbackLength = 12,
): string {
  return run.display_name?.trim()
    || run.event_name?.replace(/^replay:/i, "").trim()
    || run.name?.trim()
    || run.id.slice(0, fallbackLength);
}

export function trunc(s: string | null | undefined, n = 300): string | null {
  if (!s) return null;
  if (s.length <= n) return s;
  return s.slice(0, n) + "\u2026";
}

export function tryJson(s: string | null | undefined): string | null {
  if (!s) return null;
  try { return JSON.stringify(JSON.parse(s), null, 2); }
  catch { return s; }
}

/**
 * Compact one-line summary of an args object for inline pills, e.g.
 * `query: "search…", limit: 10`. Accepts a JSON string or a parsed value.
 * Returns null when there's nothing useful to render.
 */
export function argsPreview(input: unknown): string | null {
  if (input == null) return null;
  let obj: unknown = input;
  if (typeof input === "string") {
    try { obj = JSON.parse(input); }
    catch { return input.length > 40 ? input.slice(0, 40) + "\u2026" : input; }
  }
  if (typeof obj !== "object" || obj === null) return null;
  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length === 0) return null;
  const parts = entries.slice(0, 3).map(([k, v]) => {
    const val = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}: ${val.length > 30 ? val.slice(0, 30) + "\u2026" : val}`;
  });
  if (entries.length > 3) parts.push("\u2026");
  return parts.join(", ");
}

/** Derive a provider label from a model name or provider string */
export function detectProvider(model: string | null | undefined, provider: string | null | undefined): { label: string } | null {
  const s = (model ?? provider ?? "").toLowerCase();
  if (s.includes("claude") || s.includes("anthropic")) return { label: "Anthropic" };
  if (s.includes("gpt") || s.includes("openai") || s.includes("o1") || s.includes("o3") || s.includes("o4")) return { label: "OpenAI" };
  if (s.includes("gemini") || s.includes("google")) return { label: "Google" };
  if (s.includes("cohere") || s.includes("command")) return { label: "Cohere" };
  if (s.includes("mistral")) return { label: "Mistral" };
  if (s.includes("llama") || s.includes("meta")) return { label: "Meta" };
  return null;
}
