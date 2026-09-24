---
last_mapped_commit: fd07c336134b6bfe7bf48c8be0119c1b14dec56b
last_mapped_at: 2026-09-24
---
# External Integrations

**Analysis Date:** 2026-09-24

## APIs & External Services

**LLM Providers (through Pi):**

- Every model call goes through Pi's `ModelRuntime.completeSimple` (`src/llm/model-call.ts`): one request, no agent session; the budget is charged before sending and usage is recorded once
- Roles and models (`src/llm/models.ts`), resolved and access-checked before the first paid call:
  - builder = `roles.builder` ?? the chat's model — topic map, requirement grounding, situation proposals
  - simulator = `roles.simulator` ?? the chat's model — picks the customer's next allowed move
  - judge = `roles.judge` ?? `settings.judge` ?? the chat's model — expectation votes, the card reviewer, votes on logged conversations
- Default judge: `openrouter` / `openai/gpt-5.6-sol`, sent through the OpenRouter Chat Completions adapter pinned to the `openai` upstream (no fallbacks), JSON mode on
- Auth: Pi's own credentials (`/login` or a provider key); Agent Lab stores no model keys
- Failures are typed (`ProviderFailure`) with the labels stored records already carry; a judge that did not answer is «судья не ответил», never «ответил не по формату»

**Agent Target Protocols (`src/targets.ts`, `src/target-schema.ts`):**

- Command - a local process per dialogue speaking JSON lines over stdin/stdout
  - Request: `{"type":"respond","sessionId","scenarioId","initialState","messages":[...],"message"}`, then `{"type":"close"}`
  - Every stdout line answers the pending request: stdout is protocol only, diagnostics go to stderr
  - Timeout per request (default 60 s); reply capped at 200 000 bytes
- Module - a JavaScript module exporting `createSession(input)` (or `exportName`), run in its own Node process per dialogue (`src/module-worker.mjs`, console redirected to stderr)
- HTTP - `POST` JSON `{sessionId, scenarioId, initialState, messages, message}` (+ `prompt`, `promptHash` with a `promptFile`)
  - Headers from environment variables named in `headersEnv`; values never stored
  - Timeout per request (default 60 s); reply capped at 200 000 bytes
- `unconnected` - a draft prepared before the agent is connected; the connection is asked for in the run dialog
- `sandbox` - retired: stored records open and reassess, nothing runs it

**Agent reply (`externalReplySchema`):**

- A JSON string, or `{reply, events?, records?, retrievals?, retrievalsComplete?, retrievalStage?, resetConfirmed?, eventsComplete?, eventScope?, version?, promptHash?, measurementError?, usage?}`
- `events` `{tool, args, result}` become tool-call/tool-result trace events; `eventsComplete: true` marks the tool log complete
- `records` are reported state; `resetConfirmed` confirms `initialState.external` was applied — without it such a dialogue is not measured
- `retrievals` (≤20 chunks, ≤12 000 chars each, ≤60 000 total) with `retrievalsComplete` and `retrievalStage` (`retrieved` | `model_context`) feed separate RAG diagnostics that do not move the accuracy
- `measurementError` marks a stand failure: the dialogue is not measured
- `version` is the tested agent version the calibration compares with the logs' declared version
- Target `serviceReplies`: substrings that mean the stand, not the agent, answered

## Data Storage

**File Storage (`.agent-lab/` in the project folder, or `--data-dir`):**

- Records: `{id}.json`, one per run or draft, validated against `experimentSchema`, written atomically (`src/fs-atomic.ts`, private temp file, fsync, rename)
- Trace journals: `{id}.trace.jsonl`, append-only
- Judge audits: `{id}.judge/{trialId}.json` sidecars, written synchronously and atomically; the trial keeps a verifiable receipt
- Imports: `imports/<id>.json` (verbatim evidence), `imports/<id>.mapping.json` (owner-confirmed spreadsheet reading with the file hash), `imports/<id>.topics-<key>.json` (topic map and its progress), `imports/<id>.declarations.json` (append-only log-version declarations)
- Libraries: `libraries/<id>/…` with a journaled publication and CAS on the expected hash
- Calibration: `{id}.calibration/{key}.json` sidecars (votes on logged conversations, their own receipts)
- Remembered connection: `connection.local.json`
- Exports: `exports/<run>.<rand>.report.html` / `.report.md` / `.snapshot.json`
- Every data file is written with mode `0600`, folders `0700`
- Locking: one writer per data folder (`.lock` with owner token and dead-writer recovery); readers never take the lock

**Caching:**

- No external cache; content hashes (SHA-256 over canonical JSON) identify imports, libraries, definitions, judge inputs and receipts
- A topic map is reused for the same import, builder model and prompt version; calibration receipts are reused by key on repeats and reassessments

## Authentication & Identity

**Auth Provider:**

- Model providers: Pi
- Agent under test: environment variables named in the target (`headersEnv`, UPPERCASE_SNAKE_CASE ≤100 chars; header names ≤100 chars)

**Example HTTP target:**

```json
{
  "kind": "http",
  "url": "https://api.example.com/agent",
  "headersEnv": {
    "authorization": "AGENT_API_KEY"
  }
}
```

## Monitoring & Observability

**Error Tracking:**

- Typed not-measured reasons per situation (`NOT_MEASURED_CODES` in `src/run.ts`)
- Judge audits keep the exact request, raw responses and errors of every attempt; a malformed vote is asked once more as a fresh request

**Logs:**

- Trace events (seq, type, text, tool, args, result, state) in the JSONL journal
- Release hook output (last 4000 characters of stdout and stderr)
- Progress of long work is read from the record (one progress row), never estimated

**Diagnostics:**

- `agent-lab doctor --connection c.json --yes`: three probe requests (write, read, reset) against `probe` checks
- `agent-lab detect`: read-only proposal of the agent, logs, materials and prompt in a folder
- `agent-lab status`: the models available in Pi

## CI/CD & Deployment

**Hosting:**

- File system only; the agent under test is reached through its adapter

**CI Pipeline:**

- `.github/workflows/check.yml`: `npm ci`, `npm test`, `npm run typecheck`, `npm pack --dry-run`, then `evaluate` of `examples/regression-suite.json` with `examples/connection.json` (SQLite adapter, no model keys)
- Example for users: `examples/regression-ci.yml`
- `agent-lab evaluate --input suite.json --yes [--parallel N]` exit codes: 0 all passed, 1 an agent failure, 2 not measured / control alarm / unfinished
- Suites (`agent-lab-suite-1`) of card runs carry the import batches their situations cite, verified on load

**Release Hooks:**

- Optional `release` on a target: command, args, cwd, `timeoutMs` (default 120 s), run before the dialogues with `AGENT_LAB_RUN_ID`, `AGENT_LAB_TARGET_VERSION`, `AGENT_LAB_PROMPT_FILE`, `AGENT_LAB_PROMPT_HASH`
- A non-zero exit stops the run; the adapter's `version` stays the identity of what was tested

## Environment Configuration

**Required env vars (conditional):**

- Variables named in a target's `headersEnv`
- `PATH` must resolve command-target executables

**Optional env vars:**

- `AGENT_LAB_SESSION=1` - set by `agent-lab chat`
- `AGENT_LAB_PROVIDER`, `AGENT_LAB_MODEL` - live teaching example and smoke scripts

**Secrets location:**

- Environment variables and Pi's credential store only; never in records, materials or exports
- Project detection reads `.env` variable names, never values; a local address loses its credentials and query

## Webhooks & Callbacks

**Incoming:**

- None

**Outgoing:**

- None besides model providers (through Pi) and the agent under test (through its adapter)

## Spreadsheet and Document Formats

- `.xlsx`: own ZIP reader (`src/zip.ts`, CRC-checked, size-capped) and a pull tokenizer over sheet XML: shared, inline and rich strings, merged cells
- `.csv`: RFC 4180; delimiter and encoding proposed by detection, used as confirmed
- `.docx` materials through the same ZIP reader; `.md`, `.txt`, `.html` read whole
- JSON/JSONL logs: `[{id, messages:[{role, content}]}]` or `{dialogues:[...]}`, or rich `events` (message, tool, retrieval, state); ≤4 MB and ≤300 dialogues per import

## Integration Examples

**Python command adapter:** `examples/echo-agent.py` (JSON lines, retrievals documented), `examples/stateful-agent.py` (SQLite state, used by the CI suite)

**Node module adapter:** `examples/echo-agent.mjs` (`createSession`), `examples/scenario-lab-target.mjs` (teaching agent with a deliberate bug and its fixed version)

**Connection file:** `examples/connection.json` (`agent-lab-connection-1`, command target, `probe`)

---

*Integration audit: 2026-09-24*
