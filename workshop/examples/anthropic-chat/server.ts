import express from "express";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { Raindrop } from "raindrop-ai";
import { loadWorkspaceEnv } from "../loadEnv.ts";
import { resolveWorkshopRunUrl } from "../shared/workshop.ts";

loadWorkspaceEnv(import.meta.url);

// Opt the SDK's `localWorkshopUrl` auto-detect into mirroring to `:5899`
// when the user hasn't pointed RAINDROP_LOCAL_DEBUGGER somewhere else.
process.env.NODE_ENV ??= "development";

const DEFAULT_PORT = Number(process.env.PORT ?? 3013);
const CONVO_ID = "anthropic-demo";
const EVENT_NAME = "anthropic_chat";
const USER_ID = "example-user";

const SYSTEM_PROMPT = [
  "You are a deployment-rollout planner for an enterprise SaaS team.",
  "Use every tool you have access to (each at most once) to gather context, then write the final execution plan.",
  "Always answer in plain text.",
].join(" ");

const HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Raindrop Anthropic Chat</title>
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
        <h1>Anthropic SDK Chat</h1>
        <p>Direct Anthropic SDK + raindrop-ai manual <code>withTool</code>/<code>withSpan</code>; native thinking deltas as <code>reasoning_delta</code> live events. Thinking is dropped when tools are on (Anthropic requires unchanged thinking blocks on tool-result turns).</p>

        <details open>
          <summary>System prompt</summary>
          <textarea id="system" rows="5">${SYSTEM_PROMPT}</textarea>
        </details>

        <div class="row">
          <div><label>Model</label><input id="model" placeholder="claude-sonnet-4-6" /></div>
          <div><label>Temperature</label><input id="temperature" type="number" min="0" max="2" step="0.1" value="0.4" /></div>
          <div><label>Max output tokens</label><input id="maxOutputTokens" type="number" min="1" value="2048" /></div>
          <div><label>Max steps</label><input id="maxSteps" type="number" min="1" value="10" /></div>
          <div><label>Thinking budget</label><input id="thinkingBudget" type="number" min="0" value="1024" /></div>
          <div>
            <label>Tools</label>
            <select id="useTools">
              <option value="1" selected>on</option>
              <option value="0">off (single LLM call)</option>
            </select>
          </div>
        </div>

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
      const FOOTER_RE = /\\n\\n\u2192 Open in Workshop: (\\S+)\\s*$/;
      const statusEl = $("status");
      const historyEl = $("history");
      const scrollableEl = $("scrollable");
      const messages = [];

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
              messages: messages.slice(0, asstIdx),
              system: $("system").value,
              model: str("model"),
              temperature: num("temperature"),
              maxOutputTokens: num("maxOutputTokens"),
              maxSteps: num("maxSteps"),
              thinkingBudget: num("thinkingBudget"),
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

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "load_customer_profile",
    description: "Load account metadata for the current customer.",
    input_schema: {
      type: "object" as const,
      properties: { userId: { type: "string" } },
      required: ["userId"],
    },
  },
  {
    name: "search_docs",
    description: "Search docs for relevant rollout guidance.",
    input_schema: {
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "slow_policy_scan",
    description: "Perform a longer compliance scan before rollout.",
    input_schema: {
      type: "object" as const,
      properties: { topic: { type: "string" } },
      required: ["topic"],
    },
  },
  {
    name: "delegate_research_agent",
    description:
      "Run a delegated research sub-agent that investigates the topic and returns a ranked summary.",
    input_schema: {
      type: "object" as const,
      properties: { topic: { type: "string" } },
      required: ["topic"],
    },
  },
];

type ToolHandler = (args: Record<string, unknown>, interaction: any) => Promise<unknown>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  load_customer_profile: async (args) => ({
    userId: args.userId,
    tier: "enterprise",
    activeDeployments: 3,
    stakeholders: ["ops", "security", "support"],
  }),
  search_docs: async (args) => [
    `Runbook note for ${args.query}: stage traffic shifts.`,
    `Checklist note for ${args.query}: capture operator summary.`,
    `Audit note for ${args.query}: persist tool evidence.`,
  ],
  slow_policy_scan: async (args) => {
    await new Promise((r) => setTimeout(r, 350));
    return {
      topic: args.topic,
      requiredChecks: ["security-review", "audit-export", "support-brief"],
    };
  },
  delegate_research_agent: async (args, interaction) =>
    interaction.withSpan({ name: "delegate_research_agent.plan" }, async () => {
      const snippets = (await interaction.withTool(
        { name: "fetch_source_snippets", inputParameters: { topic: args.topic } },
        async () => [
          `Snippet A about ${args.topic}: operators need a short handoff.`,
          `Snippet B about ${args.topic}: audits fail when context is fragmented.`,
          `Snippet C about ${args.topic}: long-running checks should happen before rollout.`,
        ],
      )) as string[];
      const ranking = await interaction.withTool(
        { name: "score_findings", inputParameters: { findings: snippets } },
        async () => snippets.map((finding, index) => ({ finding, priority: index + 1 })),
      );
      return { snippets, ranking };
    }),
};

function getModelCandidates(override?: string | null): string[] {
  return Array.from(
    new Set(
      [
        override,
        process.env.ANTHROPIC_MODEL,
        "claude-sonnet-4-6",
        "claude-3-7-sonnet-20250219",
        "claude-3-5-sonnet-latest",
      ].filter((v): v is string => typeof v === "string" && v.trim().length > 0),
    ),
  );
}

function isModelNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { status?: unknown }).status !== 404) return false;
  const message =
    (error as { error?: { error?: { message?: unknown } } }).error?.error?.message ??
    (error as { message?: unknown }).message;
  return typeof message === "string" && message.includes("model:");
}

function createRaindropClient() {
  // raindrop-ai's `instrumentModules: { anthropic }` auto-wrap breaks streaming
  // on @anthropic-ai/sdk@0.95.x ("undefined is not a constructor" on APIPromise);
  // we instrument manually via withSpan/withTool/emitLiveEvent instead.
  //
  // No `writeKey` → SDK runs in local-only mode: cloud POST is a no-op and the
  // Workshop mirror auto-resolves via the `localWorkshopUrl` chain. Set
  // `RAINDROP_WRITE_KEY` to also ship to cloud.
  return new Raindrop({
    writeKey: process.env.RAINDROP_WRITE_KEY,
    disableBatching: true,
    bypassOtelForTools: true,
  });
}

export function createApp(): Express {
  const app = express();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const client = apiKey ? new Anthropic({ apiKey }) : null;
  const raindrop = createRaindropClient();

  app.use(express.json());

  app.get("/", (_req, res) => res.type("html").send(HTML));

  app.post("/api/chat", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const incoming = Array.isArray(body.messages) ? body.messages : [];
    if (incoming.length === 0) {
      res.status(400).type("text/plain").send("messages array is required");
      return;
    }
    if (!client) {
      res.status(500).type("text/plain").send("ANTHROPIC_API_KEY is required");
      return;
    }

    const requestedModel =
      typeof body.model === "string" && body.model ? body.model : null;
    const systemPrompt =
      typeof body.system === "string" && body.system ? body.system : SYSTEM_PROMPT;
    const useTools = typeof body.useTools === "boolean" ? body.useTools : true;
    const maxSteps =
      typeof body.maxSteps === "number" && Number.isFinite(body.maxSteps) ? body.maxSteps : 10;
    const temperature =
      typeof body.temperature === "number" && Number.isFinite(body.temperature)
        ? body.temperature
        : null;
    const maxTokens =
      typeof body.maxOutputTokens === "number" && Number.isFinite(body.maxOutputTokens)
        ? body.maxOutputTokens
        : 2048;
    const thinkingBudget =
      typeof body.thinkingBudget === "number" && Number.isFinite(body.thinkingBudget)
        ? body.thinkingBudget
        : null;
    const lastUser = (incoming as Array<any>).filter((m) => m.role === "user").pop();

    const interaction = raindrop.begin({
      eventId: randomUUID(),
      event: EVENT_NAME,
      userId: USER_ID,
      convoId: CONVO_ID,
      input: lastUser?.content ?? "",
    });

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    const requestStartedAt = Date.now();
    let usedModel = "unknown";

    try {
      const finalText = await interaction.withSpan({ name: "anthropic.chat" }, async () => {
        const messages: Anthropic.Messages.MessageParam[] = (incoming as any[]).map((m) => ({
          role: m.role,
          content: m.content,
        }));

        // Anthropic requires thinking blocks to be passed back unchanged on
        // tool-result turns; we don't preserve their full content (only deltas
        // for live events), so skip thinking when tool loops are in play.
        const thinkingConfig =
          !useTools && thinkingBudget != null && thinkingBudget > 0
            ? ({ type: "enabled", budget_tokens: Math.min(thinkingBudget, Math.max(128, maxTokens - 256)) } as any)
            : undefined;

        let final = "";
        for (let step = 0; step < maxSteps; step++) {
          const candidates = getModelCandidates(requestedModel);
          let stream: AsyncIterable<any> | null = null;
          let modelUsed = "";
          let lastErr: unknown;
          for (const model of candidates) {
            try {
              stream = (await client.messages.create({
                model,
                max_tokens: maxTokens,
                system: systemPrompt,
                stream: true,
                ...(useTools ? { tools: TOOLS } : {}),
                ...(temperature != null ? { temperature } : {}),
                ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
                messages,
              } as any)) as AsyncIterable<any>;
              modelUsed = model;
              break;
            } catch (err) {
              if (!isModelNotFound(err)) throw err;
              lastErr = err;
            }
          }
          if (!stream) throw lastErr ?? new Error("No supported Anthropic model candidate");
          usedModel = modelUsed;

          const blocks: Anthropic.Messages.ContentBlock[] = [];
          let stopReason: string | null = null;
          let textOut = "";

          for await (const event of stream) {
            if (event?.type === "content_block_start") {
              const block = { ...event.content_block };
              if (block.type === "tool_use") (block as any)._inputJson = "";
              blocks.push(block);
            }
            if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
              const text = event.delta.text ?? "";
              if (text) {
                textOut += text;
                interaction.emitLiveEvent({ type: "text_delta", content: text });
                res.write(text);
              }
            }
            if (event?.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
              const text = event.delta.thinking ?? "";
              if (text) interaction.emitLiveEvent({ type: "reasoning_delta", content: text });
            }
            if (event?.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
              const last = blocks[blocks.length - 1] as any;
              if (last?.type === "tool_use") last._inputJson += event.delta.partial_json ?? "";
            }
            if (event?.type === "content_block_stop") {
              const last = blocks[blocks.length - 1] as any;
              if (last?.type === "tool_use" && last._inputJson) {
                try { last.input = JSON.parse(last._inputJson); } catch { last.input = {}; }
                delete last._inputJson;
              }
            }
            if (event?.type === "message_delta") {
              stopReason = event.delta?.stop_reason ?? null;
            }
          }

          if (stopReason !== "tool_use") {
            final = textOut;
            break;
          }

          const cleanedBlocks = blocks.filter(
            (b) => b.type !== "text" || (b as Anthropic.Messages.TextBlock).text !== "",
          );
          messages.push({ role: "assistant", content: cleanedBlocks });

          const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
          for (const block of blocks) {
            if (block.type !== "tool_use") continue;
            const toolBlock = block as Anthropic.Messages.ToolUseBlock;
            let parsedInput: Record<string, unknown> = {};
            if (toolBlock.input && typeof toolBlock.input === "object") {
              parsedInput = toolBlock.input as Record<string, unknown>;
            }
            const handler = TOOL_HANDLERS[toolBlock.name];
            const result = handler
              ? await interaction.withTool(
                  { name: toolBlock.name, inputParameters: parsedInput },
                  () => handler(parsedInput, interaction),
                )
              : { error: `Unknown tool: ${toolBlock.name}` };
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolBlock.id,
              content: typeof result === "string" ? result : JSON.stringify(result),
            });
          }

          messages.push({ role: "user", content: toolResults });
        }
        return final;
      });

      interaction.finish({ output: finalText, model: usedModel });
      const url = await resolveWorkshopRunUrl({
        endpoint: `/api/convo/${CONVO_ID}`,
        match: (r) => (r.started_at ?? 0) >= requestStartedAt,
      });
      if (url) res.write(`\n\n→ Open in Workshop: ${url}\n`);
    } catch (err) {
      interaction.finish({
        output: `Error: ${err instanceof Error ? err.message : String(err)}`,
        model: usedModel,
      });
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
    console.log(`Anthropic example listening on http://localhost:${port}`);
  });
}
