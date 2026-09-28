# Claude Agent SDK

[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
wrapped by
[`@raindrop-ai/claude-agent-sdk`](https://www.npmjs.com/package/@raindrop-ai/claude-agent-sdk)
for automatic observability — agent runs, LLM generations, tool calls,
and token usage land in Workshop with zero per-call config.

## Requires

- `ANTHROPIC_API_KEY`

`bun install` ships the platform-specific Claude Code binary as an
optional dependency of `@anthropic-ai/claude-agent-sdk`; the example
resolves it from `node_modules` so a separate Claude Code install is
not required.

## Run

```bash
cd examples/claude-agent-sdk
bun install
bun run dev
```

Open <http://localhost:3015>. Each turn produces one Workshop run with
one or more `anthropic.messages` spans + tool spans (depending on what
the agent invokes); the "Open in Workshop" link in the reply jumps you
straight to it.

Workshop auto-detected on `localhost:5899`. Override with
`RAINDROP_LOCAL_DEBUGGER=http://host:port/v1/`.
