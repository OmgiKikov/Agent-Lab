import type { SpanAdapter, AdapterMatch } from "./types";
import { looksLikeJson } from "./helpers";

/**
 * `@raindrop-ai/claude-agent-sdk` LLM spans.
 *
 * The Raindrop wrapper around Anthropic's Claude Agent SDK emits one big
 * `ai.streamText`-style span per query. Unlike the Vercel AI SDK it doesn't
 * (currently) expose a way to populate the structured `ai.prompt.messages`
 * attribute, so the SDK puts the entire user task into `ai.prompt` as a
 * **raw string** — not JSON.
 *
 * The dispatcher tries `aiSdkLlmAdapter` first; that adapter only matches when
 * `ai.prompt` parses as JSON, so non-JSON prompts fall through to here. We
 * treat the raw string as a single user message — that's what it actually is
 * from the agent's perspective.
 *
 * If a future SDK version starts emitting structured prompts, this adapter
 * naturally stops matching (because `ai.prompt` will start parsing as JSON
 * and the AI SDK adapter will claim those spans first).
 *
 * The system prompt rides on a sibling `ai.prompt.system` string attribute
 * (the SDK can't fold it into the raw-string `ai.prompt`), so we read it
 * separately rather than parsing it out of the prompt.
 */
export const claudeAgentSdkLlmAdapter: SpanAdapter = {
  name: "claude-agent-sdk-llm",
  apply(input): AdapterMatch | null {
    if (input.spanType !== "LLM_GENERATION") return null;
    const prompt = input.attrs["ai.prompt"] as string | undefined;
    if (typeof prompt !== "string" || !prompt) return null;
    // If the AI SDK adapter could have parsed this, defer to it. We're the
    // fallback for the raw-string case only.
    if (looksLikeJson(prompt)) {
      try { JSON.parse(prompt); return null; } catch { /* not JSON — claim it */ }
    }

    const model = (input.attrs["ai.response.model"] as string | undefined)
      ?? (input.attrs["ai.model.id"] as string | undefined);

    const systemPromptRaw = input.attrs["ai.prompt.system"];
    const systemPrompt = typeof systemPromptRaw === "string" ? systemPromptRaw : "";

    const outputPayload = (input.attrs["ai.response.text"] as string | undefined)
      ?? (input.attrs["ai.response.object"] as string | undefined);

    return {
      inputPayload: prompt,
      outputPayload,
      normalized: {
        kind: "llm",
        messages: [{ role: "user", content: prompt }],
        userMessage: prompt,
        systemPrompt,
        model,
      },
    };
  },
};
