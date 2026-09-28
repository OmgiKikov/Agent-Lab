# AI SDK Chat

Vercel AI SDK + `@raindrop-ai/ai-sdk` automatic instrumentation: text
streaming, tool calls, and reasoning land in Workshop with zero per-call
config.

## Requires

- `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY` if you switch the model)

## Run

```bash
cd examples/ai-sdk-chat
bun install
bun run dev
```

Open <http://localhost:3011>. Each turn produces one Workshop run with
the `ai.streamText` span + tool spans; the "Open in Workshop" link in
the reply jumps you straight to it.

Workshop auto-detected on `localhost:5899`. Override with
`RAINDROP_LOCAL_DEBUGGER=http://host:port/v1/`.
