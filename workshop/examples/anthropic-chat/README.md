# Anthropic Chat

Official Anthropic SDK + `raindrop-ai` manual `withTool` / `withSpan`
instrumentation. Includes native thinking deltas as `reasoning_delta`
live events.

## Requires

- `ANTHROPIC_API_KEY`

## Run

```bash
cd examples/anthropic-chat
bun install
bun run dev
```

Open <http://localhost:3013>. Each turn produces one Workshop run with
the `anthropic.messages` span + tool spans; the "Open in Workshop" link
in the reply jumps you straight to it.

Workshop auto-detected on `localhost:5899`. Override with
`RAINDROP_LOCAL_DEBUGGER=http://host:port/v1/`.
