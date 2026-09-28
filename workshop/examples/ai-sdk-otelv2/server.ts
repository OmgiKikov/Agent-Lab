import express from "express";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { streamText, tool, jsonSchema, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { Raindrop } from "raindrop-ai";
import { config } from "dotenv";
import { resolveWorkshopRunUrl } from "../shared/workshop.ts";

config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), ".env") });

// Opt the SDK's `localWorkshopUrl` auto-detect into mirroring to `:5899`
// when the user hasn't pointed RAINDROP_LOCAL_DEBUGGER somewhere else.
process.env.NODE_ENV ??= "development";

const DEFAULT_PORT = Number(process.env.PORT ?? 3014);
const CONVO_ID = "ai-sdk-otelv2-demo";
const EVENT_NAME = "ai_sdk_otelv2_chat";
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
    <title>Raindrop AI SDK (OTel v2) Chat</title>
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
        <h1>AI SDK Chat (OTel v2)</h1>
        <p>Vercel AI SDK with raindrop-ai's OTel v2 telemetry path (<code>experimental_telemetry.metadata = interaction.vercelAiSdkMetadata()</code>).</p>

        <details open>
          <summary>System prompt</summary>
          <textarea id="system" rows="5">${SYSTEM_PROMPT}</textarea>
        </details>

        <div class="row">
          <div><label>Model</label><input id="model" placeholder="gpt-4.1-mini" /></div>
          <div><label>Temperature</label><input id="temperature" type="number" min="0" max="2" step="0.1" value="0.4" /></div>
          <div><label>Top P</label><input id="topP" type="number" min="0" max="1" step="0.05" /></div>
          <div><label>Max output tokens</label><input id="maxOutputTokens" type="number" min="1" /></div>
          <div><label>Seed</label><input id="seed" type="number" /></div>
          <div><label>Max steps</label><input id="maxSteps" type="number" min="1" value="10" /></div>
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
              topP: num("topP"),
              maxOutputTokens: num("maxOutputTokens"),
              seed: num("seed"),
              maxSteps: num("maxSteps"),
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

const tools = {
  load_customer_profile: tool({
    description: "Load account metadata for the current customer.",
    inputSchema: jsonSchema({
      type: "object" as const,
      properties: { userId: { type: "string" } },
      required: ["userId"],
      additionalProperties: false,
    }),
    execute: async ({ userId }: { userId: string }) => ({
      userId,
      tier: "enterprise",
      activeDeployments: 3,
      stakeholders: ["ops", "security", "support"],
    }),
  }),
  search_docs: tool({
    description: "Search docs for relevant rollout guidance.",
    inputSchema: jsonSchema({
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    }),
    execute: async ({ query }: { query: string }) => [
      `Runbook note for ${query}: stage traffic shifts.`,
      `Checklist note for ${query}: capture operator summary.`,
      `Audit note for ${query}: persist tool evidence.`,
    ],
  }),
  slow_policy_scan: tool({
    description: "Perform a longer compliance scan before rollout.",
    inputSchema: jsonSchema({
      type: "object" as const,
      properties: { topic: { type: "string" } },
      required: ["topic"],
      additionalProperties: false,
    }),
    execute: async ({ topic }: { topic: string }) => {
      await new Promise((r) => setTimeout(r, 350));
      return {
        topic,
        requiredChecks: ["security-review", "audit-export", "support-brief"],
      };
    },
  }),
  delegate_research_agent: tool({
    description:
      "Run a delegated research sub-agent that investigates the topic and returns a ranked summary.",
    inputSchema: jsonSchema({
      type: "object" as const,
      properties: { topic: { type: "string" } },
      required: ["topic"],
      additionalProperties: false,
    }),
    execute: async ({ topic }: { topic: string }) => {
      const snippets = [
        `Snippet A about ${topic}: operators need a short handoff.`,
        `Snippet B about ${topic}: audits fail when context is fragmented.`,
        `Snippet C about ${topic}: long-running checks should happen before rollout.`,
      ];
      const ranking = snippets.map((finding, index) => ({ finding, priority: index + 1 }));
      return { snippets, ranking };
    },
  }),
};

const raindrop = new Raindrop({
  writeKey: process.env.RAINDROP_WRITE_KEY,
  disableBatching: true,
});

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get("/", (_req, res) => res.type("html").send(HTML));

  app.post("/api/chat", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const incoming = Array.isArray(body.messages) ? body.messages : [];
    if (incoming.length === 0) {
      res.status(400).type("text/plain").send("messages array is required");
      return;
    }

    const requestedModel =
      (typeof body.model === "string" && body.model) || process.env.OPENAI_MODEL || "gpt-4.1-mini";
    const systemPrompt =
      typeof body.system === "string" && body.system ? body.system : SYSTEM_PROMPT;
    const useTools = typeof body.useTools === "boolean" ? body.useTools : true;
    const maxSteps =
      typeof body.maxSteps === "number" && Number.isFinite(body.maxSteps) ? body.maxSteps : 10;
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

    try {
      const callOptions: Record<string, unknown> = {
        model: openai(requestedModel),
        system: systemPrompt,
        messages: incoming,
        stopWhen: stepCountIs(maxSteps),
        experimental_telemetry: {
          isEnabled: true,
          metadata: interaction.vercelAiSdkMetadata(),
        },
      };
      for (const k of ["temperature", "topP", "maxOutputTokens", "seed"] as const) {
        const v = body[k];
        if (typeof v === "number" && Number.isFinite(v)) callOptions[k] = v;
      }
      if (useTools) callOptions.tools = tools;

      const result = await streamText(callOptions as any);

      let collected = "";
      for await (const chunk of result.textStream) {
        collected += chunk;
        res.write(chunk);
      }

      await interaction.finish({ output: collected, model: requestedModel });
      const url = await resolveWorkshopRunUrl({
        endpoint: `/api/convo/${CONVO_ID}`,
        match: (r) => (r.started_at ?? 0) >= requestStartedAt,
      });
      if (url) res.write(`\n\n→ Open in Workshop: ${url}\n`);
    } catch (err) {
      void interaction
        .finish({
          output: `Error: ${err instanceof Error ? err.message : String(err)}`,
          model: requestedModel,
        })
        .catch(() => {});
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
    console.log(`AI SDK OTELv2 example listening on http://localhost:${port}`);
  });
}
