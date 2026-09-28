# Go Chat

`net/http` + `raindrop-ai/go` + the OpenAI HTTP API.

## Requires

- Go ≥ 1.22
- `OPENAI_API_KEY`

## Run

```bash
cd examples/go-chat
go run .
```

Open <http://localhost:3019>. Each turn produces one Workshop run with
the `openai.chat` span; the "Open in Workshop" link in the reply jumps
you straight to it.

`bun run dev:examples` from the workshop root picks this up automatically
once `go` is on `$PATH`. Workshop auto-detected on `localhost:5899`;
override with `RAINDROP_LOCAL_DEBUGGER=http://host:port/v1/`.
