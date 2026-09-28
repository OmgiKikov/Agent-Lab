// Translates AI SDK `providerOptions` ({ anthropic: {...}, openai: {...}, google: {...} })
// into raw API request body fields + headers per provider.

type ProviderResult = {
  body: Record<string, any>;
  headers: Record<string, string>;
};

const providers: Record<string, (opts: Record<string, any>) => ProviderResult> = {

  anthropic(opts) {
    const body: Record<string, any> = {};
    const headers: Record<string, string> = {};
    const betas: string[] = [];

    if (opts.thinking) {
      body.thinking = opts.thinking;
      betas.push("interleaved-thinking-2025-05-14");
    }
    if (opts.cacheControl) {
      // cache_control is handled via message-level annotations, not a top-level field
      // but we track the beta header
    }
    if (opts.contextManagement || opts.context_management) {
      betas.push("context-management-2025-06-27");
    }
    if (opts.compact) {
      betas.push("compact-2026-01-12");
    }

    // Pass through any raw fields
    for (const [k, v] of Object.entries(opts)) {
      if (["thinking", "cacheControl", "contextManagement", "context_management", "compact"].includes(k)) continue;
      // Unknown fields — pass through to body directly (best effort)
      body[k] = v;
    }

    if (betas.length > 0) headers["anthropic-beta"] = betas.join(",");
    return { body, headers };
  },

  openai(opts) {
    const body: Record<string, any> = {};
    const headers: Record<string, string> = {};

    // OpenAI-specific options
    if (opts.reasoning_effort) body.reasoning_effort = opts.reasoning_effort;
    if (opts.store !== undefined) body.store = opts.store;
    if (opts.metadata) body.metadata = opts.metadata;
    if (opts.service_tier) body.service_tier = opts.service_tier;

    // Pass through unknowns
    for (const [k, v] of Object.entries(opts)) {
      if (["reasoning_effort", "store", "metadata", "service_tier"].includes(k)) continue;
      body[k] = v;
    }

    return { body, headers };
  },

  google(opts) {
    const body: Record<string, any> = {};
    const headers: Record<string, string> = {};

    if (opts.safetySettings) body.safety_settings = opts.safetySettings;
    if (opts.generationConfig) Object.assign(body, opts.generationConfig);

    return { body, headers };
  },
};

// Mutates `requestBody` and `requestHeaders` in place.
export function applyProviderOptions(
  providerOptions: Record<string, any> | undefined,
  requestBody: Record<string, any>,
  requestHeaders: Record<string, string>,
): void {
  if (!providerOptions) return;

  for (const [providerName, opts] of Object.entries(providerOptions)) {
    if (!opts || typeof opts !== "object") continue;

    const converter = providers[providerName];
    if (converter) {
      const { body, headers } = converter(opts);
      Object.assign(requestBody, body);

      // Merge headers — append beta headers if both exist
      for (const [hk, hv] of Object.entries(headers)) {
        if (hk === "anthropic-beta" && requestHeaders[hk]) {
          // Merge beta lists, dedup
          const existing = new Set(requestHeaders[hk].split(",").map(s => s.trim()));
          for (const b of hv.split(",")) existing.add(b.trim());
          requestHeaders[hk] = [...existing].join(",");
        } else {
          requestHeaders[hk] = hv;
        }
      }
    } else {
      // Unknown provider — dump options into body as-is
      for (const [k, v] of Object.entries(opts)) {
        requestBody[k] = v;
      }
    }
  }
}

export function detectProvider(model?: string | null, providerAttr?: string | null): string {
  const m = (model ?? providerAttr ?? "").toLowerCase();
  if (m.includes("anthropic") || m.includes("claude")) return "anthropic";
  if (m.includes("openai") || m.includes("gpt") || m.includes("o1") || m.includes("o3") || m.includes("o4")) return "openai";
  if (m.includes("google") || m.includes("gemini")) return "google";
  return "anthropic"; // default
}

export function getProviderBaseURL(provider: string, traceBaseURL?: string | null): string {
  if (traceBaseURL) return traceBaseURL;
  switch (provider) {
    case "anthropic": return "https://api.anthropic.com/v1/messages";
    case "openai": return "https://api.openai.com/v1/chat/completions";
    case "google": return "https://generativelanguage.googleapis.com/v1beta/models";
    default: return "https://api.anthropic.com/v1/messages";
  }
}

export function getProviderHeaders(provider: string, apiKey: string): Record<string, string> {
  switch (provider) {
    case "anthropic":
      return {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
    case "openai":
      return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      };
    default:
      return {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
  }
}
