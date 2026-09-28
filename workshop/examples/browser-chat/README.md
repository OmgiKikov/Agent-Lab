# Browser SDK Chat

`@raindrop-ai/browser-sdk` mirroring `trackAiPartial(begin → finish)` to
Workshop from a browser context. The OpenAI call lives on the server so
the API key never reaches the browser.

## Requires

- `OPENAI_API_KEY`

## Run

```bash
cd examples/browser-chat
bun install
bun run dev
```

Open <http://localhost:3016>. Each turn produces one Workshop event with
the streamed assistant reply; the "Open in Workshop" link in the reply
jumps you straight to it.

Workshop auto-detected on `localhost:5899`. Override with
`RAINDROP_LOCAL_DEBUGGER=http://host:port/v1/`.
