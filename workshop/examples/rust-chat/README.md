# Rust Chat

`axum` + `reqwest` + `raindrop-ai` (Rust crate) + the OpenAI HTTP API.

## Requires

- Rust toolchain (`cargo`) ≥ 1.75
- `OPENAI_API_KEY`

## Run

```bash
cd examples/rust-chat
cargo run --quiet
```

First build pulls deps and takes ~1 min. Open <http://localhost:3018>.
Each turn produces one Workshop run with the `openai.chat` span; the
"Open in Workshop" link in the reply jumps you straight to it.

`bun run dev:examples` from the workshop root picks this up automatically
once `cargo` is on `$PATH`. Workshop auto-detected on `localhost:5899`;
override with `RAINDROP_LOCAL_DEBUGGER=http://host:port/v1/`.
