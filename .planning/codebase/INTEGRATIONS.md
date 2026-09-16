---
last_mapped_commit: 015fee98766cc2082001fdfce3a329a31329d4cf
last_mapped_at: 2026-09-16
---
# External Integrations

**Analysis Date:** 2026-09-16

## APIs & External Services

**LLM Providers:**

- OpenRouter - Primary judge model provider (default: openai/gpt-5.6-sol with upstream=openai)
  - SDK/Client: Built into @earendil-works/pi-coding-agent runtime
  - Auth: API key via environment variable (configured in HTTP headers map)
  - Upstream routing: Supports OpenRouter upstream parameter for model routing

**Agent Target Protocols:**

- HTTP - Remote agent via HTTP endpoint
  - SDK/Client: HTTP client in Pi runtime
  - Auth: Custom headers from environment variables (headersEnv map in target configuration)
  - Timeout: Configurable per-target (default 60s)
  
- Command-line - Local process speaking JSON-lines
  - Protocol: One JSON request/reply per line over stdin/stdout
  - Spawn: Node.js child_process module
  - Timeout: Configurable per-target (default 60s)
  
- Module - Direct Node.js ES module import
  - Protocol: Async createSession() function export
  - Timeout: Configurable per-target
  - Prompt injection: Optional promptFile for agent instructions

- Sandbox - Built-in Pi sandbox (no external agent)
  - Protocol: Internal Pi agent with trusted tools
  - No external dependencies

## Data Storage

**File Storage:**

- Experiments: JSON files in `.agent-lab/` (or custom data-dir)
  - Naming: `{experimentId}.json`
  - Format: Validated against experimentSchema (v6+ protocol)
  - Locking: Per-directory .lock file with PID/token for concurrent access control
  - Recovery: .recovery gate for transaction consistency

- Trace Journals: JSONL files (one event per line)
  - Naming: `{experimentId}.trace.jsonl`
  - Format: Append-only log of TraceEvent records
  - Lifecycle: Created per experiment run

- Artifact Export: JSON, Markdown, HTML formats
  - Evidence bundles for review and CI/CD
  - HTML reports with embedded evidence

**Caching:**

- No external cache service (file-based only)
- Fingerprinting: SHA-256 based content hashing for scenario/trial/result reproducibility

## Authentication & Identity

**Auth Provider:**

- Custom (environment variables)
  - Implementation: HTTP headers map environment variable names to actual values
  - Header names: Configurable per target (alphanumeric + hyphen, max 100 chars)
  - Variable names: UPPERCASE_SNAKE_CASE, max 100 chars
  - Required vars checked at preflight validation

**Example Auth Configuration:**

```json
{
  "kind": "http",
  "url": "https://api.example.com/agent",
  "headersEnv": {
    "authorization": "AGENT_API_KEY",
    "x-custom-header": "CUSTOM_TOKEN"
  }
}
```

## Monitoring & Observability

**Error Tracking:**

- Built-in error handling and reporting
- JudgeAudit schema captures model provider/configuration/attempts
- Trial errors and reasons logged in experiments

**Logs:**

- Trace events (seq, type, text, tool, args, result, state) saved to JSONL
- Release hook output captured (stdout/stderr last 4000 chars)
- Judge attempt history including raw responses and errors

**Diagnostics:**

- Doctor command validates target connectivity and readiness
- Probe protocol tests read/write/reset cycles for state observation
- Version tracking for agent under test and test suite

## CI/CD & Deployment

**Hosting:**

- File system only (no hosting platform required)
- Agent under test hosted externally via HTTP/Module/Command target

**CI Pipeline:**

- Example: `examples/regression-ci.yml` (GitHub Actions YAML)
- Commands: `agent-lab evaluate`, `agent-lab score`, `agent-lab reassess`
- Parallel execution: `--parallel N` flag (default respects concurrency limits)

**Release Hooks:**

- Optional pre-run deployment: Executes shell command before test
  - cwd: Working directory for command
  - command: Executable to run (resolved via PATH)
  - args: Argument list
  - timeoutMs: Execution deadline (default 120s)
- Output captured for audit trail

## Environment Configuration

**Required env vars (conditional):**

- LLM provider credentials (via HTTP headers if using OpenRouter judge)
- Custom agent headers (named in target.headersEnv configuration)
- PATH must contain executables for command-line targets

**Optional env vars:**

- AGENT_LAB_SESSION - Set to '1' when running Pi chat mode
- Standard Node.js: NODE_ENV, DEBUG, etc.

**Secrets location:**

- Environment variables only (no .env file shipped)
- Secrets never logged or committed
- Header values from environment validated at preflight

## Webhooks & Callbacks

**Incoming:**

- None (Agent Lab is pull-based only)

**Outgoing:**

- None (No webhooks triggered)

**Target Communication:**

- Request/response over JSON lines (command-line targets)
- HTTP POST with JSON body (HTTP targets)
- Direct async function calls (module targets)
- Internal sandbox (no external calls)

## Communication Protocols

**Judge Protocol (LLM Assessment):**

- Provider: OpenRouter or other LLM via Pi runtime
- Request: scenario, sources, trial events, evaluation scope
- Response: JSON schema matching assessmentSchema
  - One assessment per requested rubric
  - Evidence citations with event sequence numbers
  - Pass/fail conditions evaluated independently
- Error handling: Retries within concurrency limit, attempts logged in JudgeAudit
- Concurrency: 8 dialogues per batch (judge votes run together)

**Target Adapter Protocol:**

- Request: JSON object with user message and context
- Response: JSON object with reply, optional retrievals, optional state
- Trace events: bidirectional (user, assistant, simulator, retrieval, tool_call, tool_result, error)
- State observation: sandbox | reported | missing
- Tool scope: adapter-specific tool list

**RAG Protocol (Retrieval Evidence):**

```json
{
  "reply": "Answer text",
  "retrievals": [
    {"source": "doc#section", "content": "...", "score": 0.9}
  ],
  "retrievalsComplete": true
}
```

- retrievalsComplete: true = full context assertion for diagnostic rubrics
- retrievalsComplete: false or missing = unknown/incomplete
- Up to 20 fragments, 12,000 chars each, 60,000 total

**Comparison Protocol:**

- Pair-wise statistical comparison of baseline vs candidate trials
- Verdict types: improved, regressed, no_change, insufficient, incomparable
- Evidence: per-family pass counts, confidence interval calculation

## Integration Examples

**Python Agent (Command Target):**

- File: `examples/stateful-agent.py`
- Invocation: `python3 stateful-agent.py` (reads JSON, writes JSON lines)
- State: SQLite backend
- Probe: Validates read/write/reset via deterministic checks

**Node.js Module (LLM Agent):**

- File: `examples/llm-stateful-agent.mjs`
- Export: `createSession()` function
- Dependencies: LLM client for OpenAI-compatible API
- Prompt: Loaded from `examples/llm-prompt.md`

**HTTP Endpoint:**

- Connection: `examples/llm-connection.json` (reference architecture)
- Endpoint: POST /api/chat or similar
- Headers: Custom auth via environment variables

---

*Integration audit: 2026-09-16*
