# OpenAI Chat

Direct OpenAI SDK + `raindrop-ai` manual `withTool` / `withSpan` /
`emitLiveEvent` instrumentation.

## Requires

- `OPENAI_API_KEY`

## Run

```bash
cd examples/openai-chat
bun install
bun run dev
```

Open <http://localhost:3012>. Each turn produces one Workshop run with the
`openai.chat` span + a tool span per tool call; the "Open in Workshop"
link in the reply jumps you straight to it.

Workshop auto-detected on `localhost:5899`. Override with
`RAINDROP_LOCAL_DEBUGGER=http://host:port/v1/`.
