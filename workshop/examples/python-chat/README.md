# Python Chat

`aiohttp` + the OpenAI Python SDK + `raindrop-ai` (Python).

## Requires

- Python ≥ 3.10
- `OPENAI_API_KEY`

## One-time setup

```bash
cd examples/python-chat
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Run

```bash
.venv/bin/python server.py
```

Open <http://localhost:3017>. Each turn produces one Workshop run with
the `openai.chat` span; the "Open in Workshop" link in the reply jumps
you straight to it.

`bun run dev:examples` from the workshop root picks this up automatically
once the venv exists. Workshop auto-detected on `localhost:5899`;
override with `RAINDROP_LOCAL_DEBUGGER=http://host:port/v1/`.
