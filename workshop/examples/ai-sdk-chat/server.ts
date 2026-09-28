import express from "express";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import * as ai from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createRaindropAISDK, eventMetadata } from "@raindrop-ai/ai-sdk";
import { loadWorkspaceEnv } from "../loadEnv.ts";
import { resolveWorkshopRunUrl } from "../shared/workshop.ts";

loadWorkspaceEnv(import.meta.url);

// Opt the SDK's `localWorkshopUrl` auto-detect into mirroring to `:5899`
// when the user hasn't pointed RAINDROP_LOCAL_DEBUGGER somewhere else.
process.env.NODE_ENV ??= "development";

const DEFAULT_PORT = Number(process.env.PORT ?? 3011);
const CONVO_ID = "ai-sdk-demo";
const EVENT_NAME = "ai_sdk_chat";
const USER_ID = "example-user";

const SYSTEM_PROMPT = [
  "You are a deployment-rollout planner for an enterprise SaaS team.",
  "Use every tool you have access to (each at most once) to gather context, then write the final execution plan.",
  "Always answer in plain text.",
].join(" ");

const RESEARCH_SYSTEM_PROMPT = [
  "You are a delegated research agent.",
  "Call fetch_source_snippets exactly once, then score_findings exactly once.",
  "Do not write a final answer in this step.",
].join(" ");

const SUMMARY_SYSTEM_PROMPT =
  "Summarize delegated research findings into three bullets and one sequencing note.";

const HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Raindrop AI SDK Chat</title>
    <link rel="icon" href="data:," />
    <style>
      body { margin: 0; font: 16px/1.4 sans-serif; }
      .container { display: flex; flex-direction: column; height: 100vh; max-width: 720px; margin: 0 auto; padding: 1.5rem; box-sizing: border-box; }
      .scrollable { flex: 1; overflow-y: auto; padding-right: .5rem; }
      .input-bar { flex-shrink: 0; padding-top: 1rem; margin-top: 1rem; border-top: 1px solid #e5e7eb; }
      h1 { margin: 0 0 .25rem; font-size: 18px; }
      textarea, input, select { width: 100%; box-sizing: border-box; font: inherit; }
      textarea { min-height: 60px; }
      button { padding: .4rem .9rem; border-radius: 6px; border: 1px solid #2563eb; background: #2563eb; color: white; font: inherit; cursor: pointer; }
      button:disabled { opacity: .6; cursor: wait; }
      button.secondary { background: none; color: #555; border-color: #d1d5db; margin-left: .5rem; }
      label { display: block; font-size: 12px; color: #666; margin: .5rem 0 .15rem; }
      .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: .5rem .75rem; }
      details summary { cursor: pointer; font-size: 12px; color: #666; }
      .tabs { display: flex; gap: 0; margin: 1rem 0 .5rem; border-bottom: 1px solid #d1d5db; }
      .tab { padding: .5rem 1rem; cursor: pointer; border: 1px solid transparent; border-bottom: none; margin-bottom: -1px; font-size: 14px; color: #666; background: none; }
      .tab[aria-selected="true"] { color: inherit; border-color: #d1d5db; border-bottom-color: transparent; background: #f9fafb; border-radius: 6px 6px 0 0; }
      .history { margin-top: 1.25rem; display: flex; flex-direction: column; gap: .75rem; }
      .bubble { padding: .5rem .75rem; border-radius: 8px; }
      .bubble-user { background: #eff6ff; border: 1px solid #dbeafe; }
      .bubble-assistant { background: #f4f4f4; border: 1px solid #e5e7eb; }
      .bubble-role { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: .04em; margin-bottom: .25rem; }
      .bubble-content { white-space: pre-wrap; min-height: 1em; }
      .bubble-link { display: block; margin-top: .35rem; font-size: 11px; color: #2563eb; text-decoration: none; }
      .bubble-link:hover { text-decoration: underline; }
      .actions { display: flex; align-items: center; margin-top: .5rem; }
      .status { margin-left: .75rem; font-size: 13px; color: #666; }
      .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #2563eb; margin-right: .35rem; vertical-align: middle; animation: pulse 1s infinite; }
      @keyframes pulse { 50% { opacity: .25; } }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="scrollable" id="scrollable">
        <h1>AI SDK Chat</h1>
        <p>Open the local debugger while this runs.</p>

        <div class="tabs" role="tablist">
          <button class="tab" role="tab" aria-selected="true" data-provider="openai">OpenAI</button>
          <button class="tab" role="tab" aria-selected="false" data-provider="anthropic">Anthropic</button>
        </div>

        <details open>
          <summary>System prompt</summary>
          <textarea id="system" rows="5">${SYSTEM_PROMPT}</textarea>
        </details>

        <div class="row">
          <div><label>Model</label><input id="model" placeholder="gpt-5.4-mini" /></div>
          <div><label>Temperature</label><input id="temperature" type="number" min="0" max="2" step="0.1" value="0.4" /></div>
          <div><label>Top P</label><input id="topP" type="number" min="0" max="1" step="0.05" /></div>
          <div><label>Max output tokens</label><input id="maxOutputTokens" type="number" min="1" /></div>
          <div><label>Seed</label><input id="seed" type="number" /></div>
          <div><label>Max steps</label><input id="maxSteps" type="number" min="1" value="10" /></div>
          <div data-provider-only="openai">
            <label>Reasoning effort</label>
            <select id="reasoningEffort">
              <option value="">none</option>
              <option value="low" selected>low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </div>
          <div data-provider-only="anthropic" style="display:none"><label>Thinking budget</label><input id="thinkingBudget" type="number" min="0" value="1024" /></div>
          <div>
            <label>Tools</label>
            <select id="useTools">
              <option value="1" selected>on</option>
              <option value="0">off (single LLM call)</option>
            </select>
          </div>
        </div>
        <p id="reasoning-hint" style="font-size: 11px; color: #888; margin: .5rem 0 0;">Note: OpenAI reasoning models (gpt-5.x, o-series) ignore <code>temperature</code>, <code>topP</code>, and <code>seed</code>.</p>

        <div id="history" class="history"></div>
      </div>

      <div class="input-bar">
        <textarea id="prompt" placeholder="Type a message. Cmd/Ctrl+Enter to send. Knobs apply to the next turn.">Plan the next deployment rollout for enterprise customer userId cust-acme-001 (topic: "checkout v2 cutover").</textarea>
        <div class="actions">
          <button id="send">Send</button>
          <button id="reset" class="secondary">Reset</button>
          <span id="status" class="status" hidden></span>
        </div>
      </div>
    </div>

    <script>
      const $ = (id) => document.getElementById(id);
      const num = (id) => $(id).value === "" ? null : Number($(id).value);
      const str = (id) => $(id).value || null;
      const MODEL_DEFAULTS = { openai: "gpt-5.4-mini", anthropic: "claude-sonnet-4-6" };
      const FOOTER_RE = /\\n\\n\u2192 Open in Workshop: (\\S+)\\s*$/;
      const statusEl = $("status");
      const historyEl = $("history");
      const scrollableEl = $("scrollable");
      let provider = "openai";
      const messages = [];

      function setProvider(p) {
        provider = p;
        for (const tab of document.querySelectorAll(".tab")) {
          tab.setAttribute("aria-selected", tab.dataset.provider === p ? "true" : "false");
        }
        for (const el of document.querySelectorAll("[data-provider-only]")) {
          el.style.display = el.dataset.providerOnly === p ? "" : "none";
        }
        $("model").placeholder = MODEL_DEFAULTS[p];
        $("reasoning-hint").style.display = p === "openai" ? "" : "none";
      }
      for (const tab of document.querySelectorAll(".tab")) {
        tab.onclick = () => setProvider(tab.dataset.provider);
      }

      function setStatus(text) {
        if (!text) { statusEl.hidden = true; statusEl.innerHTML = ""; return; }
        statusEl.hidden = false;
        statusEl.innerHTML = '<span class="dot"></span>' + text;
      }

      function renderHistory() {
        const wasAtBottom =
          scrollableEl.scrollHeight - scrollableEl.scrollTop - scrollableEl.clientHeight < 60;
        historyEl.innerHTML = "";
        for (const m of messages) {
          const div = document.createElement("div");
          div.className = "bubble bubble-" + m.role;
          const role = document.createElement("div");
          role.className = "bubble-role";
          role.textContent = m.role;
          const content = document.createElement("div");
          content.className = "bubble-content";
          content.textContent = m.content;
          div.appendChild(role);
          div.appendChild(content);
          if (m.workshopUrl) {
            const a = document.createElement("a");
            a.className = "bubble-link";
            a.href = m.workshopUrl;
            a.target = "_blank";
            a.rel = "noreferrer";
            a.textContent = "Open run in Workshop \u2197";
            div.appendChild(a);
          }
          historyEl.appendChild(div);
        }
        if (wasAtBottom) scrollableEl.scrollTop = scrollableEl.scrollHeight;
      }

      $("reset").onclick = () => {
        if ($("send").disabled) return;
        messages.length = 0;
        renderHistory();
      };

      $("prompt").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !$("send").disabled) {
          e.preventDefault();
          $("send").click();
        }
      });

      $("send").onclick = async () => {
        const userText = $("prompt").value.trim();
        if (!userText) return;
        messages.push({ role: "user", content: userText });
        $("prompt").value = "";
        const asstIdx = messages.length;
        messages.push({ role: "assistant", content: "" });
        renderHistory();

        $("send").disabled = true;
        setStatus("Waiting for first chunk\u2026");
        try {
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider,
              messages: messages.slice(0, asstIdx),
              system: $("system").value,
              model: str("model"),
              temperature: num("temperature"),
              topP: num("topP"),
              maxOutputTokens: num("maxOutputTokens"),
              seed: num("seed"),
              maxSteps: num("maxSteps"),
              reasoningEffort: provider === "openai" ? str("reasoningEffort") : null,
              thinkingBudget: provider === "anthropic" ? num("thinkingBudget") : null,
              useTools: $("useTools").value === "1",
            }),
          });
          if (!res.ok) {
            messages[asstIdx].content = "[error] " + res.status + " " + res.statusText + ": " + (await res.text());
            renderHistory();
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let firstChunk = true;
          let raw = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (firstChunk) { setStatus("Streaming\u2026"); firstChunk = false; }
            raw += decoder.decode(value, { stream: true });
            const m = raw.match(FOOTER_RE);
            if (m) {
              messages[asstIdx].content = raw.slice(0, m.index);
              messages[asstIdx].workshopUrl = m[1];
            } else {
              messages[asstIdx].content = raw;
            }
            renderHistory();
          }
        } finally {
          $("send").disabled = false;
          setStatus("");
        }
      };
    </script>
  </body>
</html>`;

function createRaindropClient() {
  if (!createRaindropAISDK) {
    throw new Error("createRaindropAISDK export could not be resolved from @raindrop-ai/ai-sdk");
  }
  // No `writeKey` → SDK runs in local-only mode: cloud POST is a no-op and the
  // Workshop mirror auto-resolves via the `localWorkshopUrl` chain. Set
  // `RAINDROP_WRITE_KEY` to also ship to cloud.
  return createRaindropAISDK({
    writeKey: process.env.RAINDROP_WRITE_KEY,
    traces: { debug: false },
    events: { debug: false },
  });
}

function selectedModel(provider: "openai" | "anthropic", override?: string | null) {
  if (override) {
    return provider === "anthropic" ? anthropic(override) : openai(override);
  }
  return provider === "anthropic"
    ? anthropic(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6")
    : openai(process.env.OPENAI_MODEL ?? "gpt-5.4-mini");
}

function createNestedResearchTools() {
  return {
    fetch_source_snippets: ai.tool({
      description: "Fetch 3 short source snippets for the delegated research agent.",
      inputSchema: ai.jsonSchema({
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"],
      }),
      execute: async ({ topic }: any) => [
        `Snippet A about ${topic}: operators need a short handoff.`,
        `Snippet B about ${topic}: audits fail when context is fragmented.`,
        `Snippet C about ${topic}: long-running checks should happen before rollout.`,
      ],
    }),
    score_findings: ai.tool({
      description: "Rank the delegated findings into an execution order.",
      inputSchema: ai.jsonSchema({
        type: "object",
        properties: { findings: { type: "array", items: { type: "string" } } },
        required: ["findings"],
      }),
      execute: async ({ findings }: any) =>
        findings.map((finding: string, index: number) => ({ finding, priority: index + 1 })),
    }),
  };
}

function createOuterTools(wrappedAI: any, requestEventId: string, provider: "openai" | "anthropic") {
  return {
    load_customer_profile: ai.tool({
      description: "Load account metadata for the current customer.",
      inputSchema: ai.jsonSchema({
        type: "object",
        properties: { userId: { type: "string" } },
        required: ["userId"],
      }),
      execute: async ({ userId }: any) => ({
        userId,
        tier: "enterprise",
        activeDeployments: 3,
        stakeholders: ["ops", "security", "support"],
      }),
    }),
    search_docs: ai.tool({
      description: "Search docs for relevant rollout guidance.",
      inputSchema: ai.jsonSchema({
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      }),
      execute: async ({ query }: any) => [
        `Runbook note for ${query}: stage traffic shifts.`,
        `Checklist note for ${query}: capture operator summary.`,
        `Audit note for ${query}: persist tool evidence.`,
      ],
    }),
    slow_policy_scan: ai.tool({
      description: "Perform a longer compliance scan before rollout.",
      inputSchema: ai.jsonSchema({
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"],
      }),
      execute: async ({ topic }: any) => {
        await new Promise((resolve) => setTimeout(resolve, 350));
        return {
          topic,
          requiredChecks: ["security-review", "audit-export", "support-brief"],
        };
      },
    }),
    delegate_research_agent: ai.tool({
      description:
        "Run a delegated research sub-agent that investigates the topic and returns a ranked summary.",
      inputSchema: ai.jsonSchema({
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"],
      }),
      execute: async ({ topic }: any) => {
        if (!eventMetadata) throw new Error("eventMetadata export missing");
        const nestedMetadata = eventMetadata({
          eventId: requestEventId,
          userId: USER_ID,
          eventName: EVENT_NAME,
          convoId: CONVO_ID,
        });
        const research = await wrappedAI.generateText({
          model: selectedModel(provider),
          system: RESEARCH_SYSTEM_PROMPT,
          prompt: `Topic: ${topic}`,
          tools: createNestedResearchTools(),
          toolChoice: "required",
          stopWhen: ai.stepCountIs(2),
          metadata: nestedMetadata,
        } as any);
        const nested = await wrappedAI.generateText({
          model: selectedModel(provider),
          system: SUMMARY_SYSTEM_PROMPT,
          prompt: JSON.stringify(research.steps ?? []),
          metadata: nestedMetadata,
        } as any);
        return { summary: nested.text, steps: research.steps?.length ?? undefined };
      },
    }),
  };
}

export function createApp(): Express {
  const app = express();
  const raindrop = createRaindropClient();
  const wrappedAI = raindrop.wrap(ai, {
    context: { userId: USER_ID, eventName: EVENT_NAME, convoId: CONVO_ID },
  });

  app.use(express.json());

  app.get("/", (_req, res) => res.type("html").send(HTML));

  app.post("/api/chat", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) {
      res.status(400).type("text/plain").send("messages array is required");
      return;
    }
    if (!eventMetadata) {
      throw new Error("eventMetadata export could not be resolved from @raindrop-ai/ai-sdk");
    }

    const provider: "openai" | "anthropic" = body.provider === "anthropic" ? "anthropic" : "openai";
    const requestedModel = typeof body.model === "string" && body.model ? body.model : null;
    const reasoningEffort = typeof body.reasoningEffort === "string" && body.reasoningEffort
      ? body.reasoningEffort
      : null;
    const thinkingBudget =
      typeof body.thinkingBudget === "number" && Number.isFinite(body.thinkingBudget)
        ? body.thinkingBudget
        : null;
    const useTools = typeof body.useTools === "boolean" ? body.useTools : true;
    const systemPrompt =
      typeof body.system === "string" && body.system ? body.system : SYSTEM_PROMPT;
    const maxSteps =
      typeof body.maxSteps === "number" && Number.isFinite(body.maxSteps)
        ? body.maxSteps
        : 10;
    const requestEventId = crypto.randomUUID();

    const providerOptions: Record<string, unknown> = {};
    if (provider === "openai") {
      const openaiOptions: Record<string, unknown> = { reasoningSummary: "auto" };
      if (reasoningEffort) openaiOptions.reasoningEffort = reasoningEffort;
      providerOptions.openai = openaiOptions;
    } else if (thinkingBudget != null && thinkingBudget > 0) {
      providerOptions.anthropic = {
        thinking: { type: "enabled", budgetTokens: thinkingBudget },
      };
    }

    const callOptions: Record<string, unknown> = {
      model: selectedModel(provider, requestedModel),
      system: systemPrompt,
      messages,
      stopWhen: ai.stepCountIs(maxSteps),
      providerOptions,
      metadata: eventMetadata({
        eventId: requestEventId,
        userId: USER_ID,
        eventName: EVENT_NAME,
        convoId: CONVO_ID,
      }),
    };
    for (const k of ["temperature", "topP", "maxOutputTokens", "seed"] as const) {
      const v = body[k];
      if (typeof v === "number" && Number.isFinite(v)) callOptions[k] = v;
    }
    if (useTools) {
      callOptions.tools = createOuterTools(wrappedAI as any, requestEventId, provider);
      callOptions.toolChoice = "auto";
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    const requestStartedAt = Date.now();

    try {
      const result = await wrappedAI.streamText(callOptions as any);
      for await (const chunk of result.textStream) res.write(chunk);
      const url = await resolveWorkshopRunUrl({
        endpoint: `/api/convo/${CONVO_ID}`,
        match: (r) => (r.started_at ?? 0) >= requestStartedAt,
      });
      if (url) res.write(`\n\n→ Open in Workshop: ${url}\n`);
    } catch (err) {
      res.write(`\n\n[error] ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      res.end();
    }
  });

  return app;
}

export async function startServer(port = DEFAULT_PORT): Promise<{
  app: Express;
  server: Server;
  port: number;
}> {
  const app = createApp();
  const server = await new Promise<Server>((resolve) => {
    const created = app.listen(port, () => resolve(created));
  });
  const address = server.address() as AddressInfo;
  return { app, server, port: address.port };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer().then(({ port }) => {
    console.log(`AI SDK example listening on http://localhost:${port}`);
  });
}
