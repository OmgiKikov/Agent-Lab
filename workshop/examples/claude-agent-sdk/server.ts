/**
 * Claude Agent SDK example with sub-agents and Raindrop local debugger.
 *
 * The main agent delegates to two inline sub-agents ("researcher" and
 * "writer") via the SDK's native Task tool, producing a trace with
 * agent.subagent spans visible in Workshop.
 */
import express from "express";
import type { Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createRaindropClaudeAgentSDK, eventMetadata } from "@raindrop-ai/claude-agent-sdk";
import { loadWorkspaceEnv } from "../loadEnv.ts";
import { resolveWorkshopRunUrl } from "../shared/workshop.ts";

loadWorkspaceEnv(import.meta.url);

// Opt the SDK's `localWorkshopUrl` auto-detect into mirroring to `:5899`
// when the user hasn't pointed RAINDROP_LOCAL_DEBUGGER somewhere else.
process.env.NODE_ENV ??= "development";

// The Claude Agent SDK ships platform-specific Claude Code native binaries
// as optional dependency packages. Its built-in resolver tries the musl
// variant FIRST on Linux before falling back to glibc:
//
//   [`@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`,
//    `@anthropic-ai/claude-agent-sdk-linux-${arch}`]
//
// npm respects the `"libc": ["musl"]` package field and only installs the
// matching variant, so on a glibc host npm would NEVER materialize the musl
// package on disk and the resolver lands on the glibc binary.
//
// bun installs ALL optional dependencies regardless of the libc field, so
// the musl binary IS present in node_modules on a glibc system, the SDK's
// resolver picks it up first, and spawning it fails with ENOENT because
// the kernel can't find /lib/ld-musl-x86_64.so.1. The SDK then surfaces
// the failure as "Claude Code native binary not found".
//
// Detect the host libc via process.report and explicitly point the SDK at
// the matching native binary so the bun-on-glibc CI runner picks the
// glibc variant instead of the musl one.
//
// Note on the detection default: when `process.report.getReport()` is
// unavailable or the `header.glibcVersionRuntime` field is missing we
// fall back to **glibc**, not musl. The musl distribution (Alpine etc.)
// is the exception on Linux servers, glibc (Debian, Ubuntu, RHEL, SUSE,
// Amazon Linux 2023, …) is the de facto default. Defaulting to musl on
// inconclusive detection would explicitly force the musl binary on a
// glibc host and defeat this entire workaround. On Bun 1.x the report
// IS populated (`glibcVersionRuntime: "2.35"` on ubuntu-latest), so the
// fallback only matters on exotic runtimes that surface `process.report`
// shape changes.
function resolveClaudeCodeBinary(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const reportHeader = (
    process as unknown as { report?: { getReport?: () => { header?: { glibcVersionRuntime?: string } } } }
  ).report?.getReport?.()?.header;
  // `glibcVersionRuntime` is set to the libc version on glibc, omitted or
  // empty on musl. Treat an explicit empty string as "definitely musl" and
  // a missing field as "unknown — assume glibc".
  const reported = reportHeader?.glibcVersionRuntime;
  const libc: "glibc" | "musl" =
    reported === undefined
      ? "glibc" // unknown — pick the common case rather than the exotic one
      : reported
      ? "glibc"
      : "musl";
  const arch = process.arch;
  const requireFromHere = createRequire(import.meta.url);
  const candidate =
    libc === "glibc"
      ? `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`
      : `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude`;
  try {
    return requireFromHere.resolve(candidate);
  } catch {
    return undefined;
  }
}

const pathToClaudeCodeExecutable = resolveClaudeCodeBinary();

const DEFAULT_PORT = Number(process.env.PORT ?? 3015);
const CONVO_ID = "agent-demo";
const EVENT_NAME = "claude_agent";
const USER_ID = "demo-user";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

function getWrapped() {
  // No `writeKey` → SDK runs in local-only mode (cloud POST is a no-op and the
  // Workshop mirror auto-resolves via the `localWorkshopUrl` chain). Set
  // `RAINDROP_WRITE_KEY` to also ship to cloud.
  const raindrop = createRaindropClaudeAgentSDK({
    writeKey: process.env.RAINDROP_WRITE_KEY,
  });
  return raindrop.wrap({ query }, {
    context: { userId: USER_ID, eventName: EVENT_NAME, convoId: CONVO_ID },
  });
}

let _wrapped: ReturnType<typeof getWrapped> | undefined;
function wrapped() {
  if (!_wrapped) _wrapped = getWrapped();
  return _wrapped;
}

const HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Raindrop Claude Agent SDK</title>
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
      .bubble-content { white-space: pre-wrap; min-height: 1em; font-size: 13px; }
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
        <h1>Claude Agent SDK</h1>
        <p>Main agent with two inline sub-agents (researcher + writer) using <code>Bash</code> and <code>Read</code> tools. Each Send is a fresh <code>query()</code> (no session resume in this demo); prior turns are concatenated into the prompt as conversation context.</p>

        <div class="row">
          <div><label>Model</label><input id="model" placeholder="${DEFAULT_MODEL}" /></div>
          <div><label>Max turns</label><input id="maxTurns" type="number" min="1" value="3" /></div>
        </div>

        <div id="history" class="history"></div>
      </div>

      <div class="input-bar">
        <textarea id="prompt" placeholder="Type a message. Cmd/Ctrl+Enter to send.">Research the current directory structure, then have the writer summarize what this project is about.</textarea>
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
              model: str("model"),
              maxTurns: num("maxTurns"),
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

function buildPrompt(messages: Array<{ role: string; content: string }>): string {
  if (messages.length === 1) return messages[0].content;
  const lines = ["Conversation so far:"];
  for (const m of messages.slice(0, -1)) {
    lines.push(`${m.role}: ${m.content}`);
  }
  const last = messages[messages.length - 1];
  lines.push(`\nNew ${last.role} message:\n${last.content}`);
  return lines.join("\n");
}

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
      typeof body.model === "string" && body.model ? body.model : DEFAULT_MODEL;
    const maxTurns =
      typeof body.maxTurns === "number" && Number.isFinite(body.maxTurns) ? body.maxTurns : 3;

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    const requestStartedAt = Date.now();

    try {
      const meta = eventMetadata({
        userId: USER_ID,
        eventName: EVENT_NAME,
        convoId: CONVO_ID,
      });
      const stream = wrapped().query(
        {
          prompt: buildPrompt(incoming as Array<{ role: string; content: string }>),
          options: {
            model: requestedModel,
            maxTurns,
            ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
            agents: {
              researcher: {
                description:
                  "A research agent that investigates the codebase using Bash and Read tools. Delegate to this agent when you need to look up files, run commands, or gather information.",
                prompt:
                  "You are a research assistant. Use the Bash tool to investigate what is asked. Be concise and factual. Return raw findings, not polished prose.",
                model: requestedModel,
                tools: ["Bash", "Read"],
              },
              writer: {
                description:
                  "A writing agent that takes findings and produces clear, concise summaries.",
                prompt:
                  "You are a technical writer. Take the provided findings and write a clear, concise summary. No tools needed — just write.",
                model: requestedModel,
                disallowedTools: ["Bash", "Read", "Write", "Edit"],
              },
            },
          },
        },
        meta,
      );

      for await (const message of stream) {
        if (message.type === "assistant") {
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") {
                res.write(block.text);
              } else if (block.type === "tool_use") {
                res.write(
                  `\n[${block.name}${block.name === "Task" ? `: ${(block.input as any)?.subagent_type ?? (block.input as any)?.agent_name ?? ""}` : ""}]\n`,
                );
              }
            }
          }
        } else if (message.type === "result") {
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") res.write(block.text);
            }
          }
        }
      }
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
  return { app, server, port: (server.address() as AddressInfo).port };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer().then(({ port }) =>
    console.log(`Claude Agent SDK example: http://localhost:${port}`),
  );
}
