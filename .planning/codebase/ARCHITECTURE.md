---
last_mapped_commit: 015fee98766cc2082001fdfce3a329a31329d4cf
last_mapped_at: 2026-09-16
---
<!-- refreshed: 2026-09-16 -->

# Architecture

**Analysis Date:** 2026-09-16

## System Overview

Agent Lab measures how well a real AI agent performs on a validation set of business scenarios. It combines deterministic checks (state assertions, tool calls) with LLM-based rubrics to score accuracy, pinpoints failure modes, and enables regression testing.

```text
┌────────────────────────────────────────────────────────────────┐
│                  Pi Extension / CLI Entry                       │
│  `extensions/agent-lab.ts` (tools) / `src/cli.ts` (commands)   │
└────────────────┬─────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────────────────┐
│                   Lab Orchestration Layer                       │
│         `src/experiment.ts` — ExperimentLab class              │
│      Phase machine: preparing → review → evaluating            │
│      → results_review → complete                                │
└────────────────┬─────────────────────────────────────────────┘
                 │
       ┌─────────┼─────────┬──────────────┐
       │         │         │              │
       ▼         ▼         ▼              ▼
    Build    Store    Scenario      Targets
    Phase    Phase    Generation   Connection
     (Pi)  (Disk I/O) & Materials   (HTTP,
           + Lock      (Contracts)  module,
                                    command)
       │         │         │              │
       └─────────┼─────────┴──────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────────────────┐
│                  Evaluation Layer                               │
│        `src/evaluation.ts` — evaluateTrial()                    │
│  Runs agent, collects tool calls/events, grades checks          │
└────────────────┬─────────────────────────────────────────────┘
                 │
       ┌─────────┼──────────────┐
       │         │              │
       ▼         ▼              ▼
    Sandbox   External      Simulation
    Target    Target        (User/Reactive)
    (Pi)     (HTTP/module/  `src/simulator.ts`
             command)
       │         │              │
       └─────────┴──────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────────────────┐
│                 Judge Layer                                     │
│  `src/judge.ts` — LLM assessment of rubrics                     │
│  Rubrics: goal_attainment, prompt_compliance, user_fidelity    │
└────────────────┬─────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────────────────┐
│              Analysis & Reporting Layer                         │
│   comparison.ts (stats/deltas)                                  │
│   quality.ts (accuracy/causes)                                  │
│   report.ts + artifacts.ts (export)                             │
└────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| **ExperimentLab** | Manages phases, orchestrates build/run/score flows, lock-based concurrency | `src/experiment.ts` |
| **ExperimentStore** | Atomic read/write of experiment records and trace journals | `src/store.ts` |
| **Contracts** | TypeScript schemas (Zod) for all data types: Experiment, Scenario, Trial, etc. | `src/contracts.ts` |
| **Build Phase Runtime** | Pi session that extracts requirements, generates scenarios from dialogues + materials | `src/pi.ts`, `src/prompts.ts` |
| **Trial Evaluation** | Executes a single scenario against target (sandbox/HTTP/module/command), grades checks | `src/evaluation.ts` |
| **Simulator Runtime** | Pi session answering as simulated reactive user, grounds responses in dialogue facts | `src/simulator.ts`, `src/pi.ts` (SIMULATOR_ROLE) |
| **Judge Runtime** | Pi session assessing trials with rubrics; issues verdicts on goal attainment, prompt compliance, simulator fidelity | `src/judge.ts`, `src/pi.ts` (ASSESS_ROLE) |
| **Target Adapters** | Connect to external agents (HTTP endpoint, CommonJS/ESM module, spawned process, Pi sandbox) | `src/targets.ts` |
| **Quality Analysis** | Compute accuracy, cluster failure causes, extract observables from trials | `src/quality.ts`, `src/outcomes.ts` |
| **Comparison** | Compare two runs (baseline vs candidate), compute delta and confidence interval | `src/comparison.ts` |
| **CLI** | Command-line interface for non-interactive use (CI/CD, batch operations) | `src/cli.ts` |
| **Pi Extension** | Tools registered with Pi coding agent: build, run, inspect, edit, accept, suite save/load | `extensions/agent-lab.ts` |

## Pattern Overview

**Overall:** Phase-machine orchestration with deterministic evaluation + LLM judgment

**Key Characteristics:**

- **Immutable trials**: Once a trial runs, its outcome is never recalculated; new rubrics trigger `reassess` (separate immutable result)
- **Validation-before-run**: All scenarios reviewed and approved by human before agent execution
- **Reactive simulator**: Simulated user responds to agent's actual questions, grounded in real dialogue facts (not scripted playback)
- **Lock-based single-writer**: Only one ExperimentLab instance can write to a data directory; readers don't acquire lock
- **Atomicity per-record**: Each experiment saved as one `{id}.json` file; trace events appended to `{id}.trace.jsonl` (survives interruption)
- **Production logs as ground truth**: Discovery mode mines regression tests from real production dialogues, excluding masked/unavailable data
- **Workflow duality**: `evaluate` (single run, show accuracy) vs `compare` (two runs, show delta)

## Layers

**Pi Extension Layer:**

- **Purpose:** Conversational interface for Agent Lab; tools integrated into Pi coding agent
- **Location:** `extensions/agent-lab.ts`
- **Contains:** Eight tools (build, run, inspect, edit, accept, repeat, suite, connection, reassess); each maps to a CLI command
- **Depends on:** ExperimentLab, contracts, ExperimentStore, quality, artifacts
- **Used by:** Pi coding agent (`npm start` or `npm run pi`)

**CLI Layer:**

- **Purpose:** Non-interactive command execution; automation-friendly
- **Location:** `src/cli.ts` (compiled to `dist/cli.js`)
- **Contains:** Command parsers, output formatters, file I/O
- **Depends on:** ExperimentLab, ExperimentStore, imports, reporting
- **Used by:** Shell scripts, CI/CD pipelines (`agent-lab evaluate --input suite.json --yes`)

**Lab Orchestration Layer:**

- **Purpose:** Drives phase transitions, manages concurrent trial execution, persists state
- **Location:** `src/experiment.ts` — ExperimentLab class
- **Contains:** Phase machine, build/run/score/reassess workflows, parallel trial loop (max 16 concurrent)
- **Depends on:** Contracts, Store, targets, evaluation, judge, comparison, quality, prompts
- **Used by:** Extension tools and CLI commands

**Data Model & Validation Layer:**

- **Purpose:** Define all types and validation rules; single source of truth for schema
- **Location:** `src/contracts.ts`
- **Contains:** Zod schemas for Experiment, Scenario, Trial, Requirement, Check, Metric, Trial, Revision, etc.
- **Depends on:** Zod library only
- **Used by:** All other modules (build, evaluation, storage, reporting)

**Storage Layer:**

- **Purpose:** Atomic read/write of experiment records, trace journal append, lock management
- **Location:** `src/store.ts` — ExperimentStore class
- **Contains:** Experiment serialization/deserialization, JSONL trace logging, .lock file coordination
- **Depends on:** Contracts, Node.js fs/promises
- **Used by:** ExperimentLab (via `.store` property)

**Build Phase Runtime:**

- **Purpose:** Generate requirements from owner materials, create scenarios (cards) from real dialogues
- **Location:** `src/pi.ts` (createPiRuntime), `src/prompts.ts` (REQUIREMENTS_ROLE, GOALS_ROLE, etc.)
- **Contains:** Pi session factories (ModelRuntime, SessionManager wrappers), role prompts
- **Depends on:** Contracts, Pi coding agent SDK
- **Used by:** ExperimentLab.create() during preparing phase

**Evaluation Layer:**

- **Purpose:** Execute one scenario against the target agent, collect events, grade deterministic checks
- **Location:** `src/evaluation.ts` — evaluateTrial() function
- **Contains:** Trial lifecycle (open session → agent reply loop → grade checks), event recording
- **Depends on:** Contracts, targets, sandbox, simulator, evaluation
- **Used by:** ExperimentLab trial loop (runSuite)

**Target Adapter Layer:**

- **Purpose:** Connect to external agents; abstract over HTTP, module import, spawned process, or sandbox
- **Location:** `src/targets.ts`
- **Contains:** Target session lifecycle, JSON request/reply marshaling, health checks
- **Depends on:** Contracts, connection
- **Used by:** evaluateTrial, preflightTarget (setup)

**Simulator Layer:**

- **Purpose:** Simulated user that answers agent's questions, grounded in real dialogue facts
- **Location:** `src/simulator.ts` — simulatorChecks() function; `src/pi.ts` (SIMULATOR_ROLE prompt)
- **Contains:** Deterministic checks on simulator behavior; Pi role that generates user replies
- **Depends on:** Contracts, Pi SDK, prompts
- **Used by:** Trial event loop (evaluateTrial) to decide user replies

**Judge Layer:**

- **Purpose:** LLM assessment of trial outcomes against rubrics
- **Location:** `src/judge.ts`
- **Contains:** Rubric assessment logic, judge session orchestration, audit trail
- **Depends on:** Contracts, Pi SDK, prompts
- **Used by:** ExperimentLab during results_review phase (via reassess)

**Analysis Layer:**

- **Purpose:** Compute accuracy, compare runs, extract failure causes, validate preparation
- **Location:** `src/comparison.ts`, `src/quality.ts`, `src/outcomes.ts`
- **Contains:** Statistics (confidence intervals via bootstrap), failure clustering, verdicts
- **Depends on:** Contracts
- **Used by:** ExperimentLab, extension tools, CLI, reporting

**Reporting Layer:**

- **Purpose:** Export evidence, generate human-readable and machine reports
- **Location:** `src/report.ts`, `src/artifacts.ts`
- **Contains:** HTML/Markdown/JSON exporters, summary rendering
- **Depends on:** Contracts, analysis, store
- **Used by:** Extension tools, CLI export command

## Data Flow

### Primary Request Path: Build → Run → Score → Verdict

1. **User Input** (`extensions/agent-lab.ts` or CLI)
   - Materials (prompt, knowledge docs), requirements (optional), dialogues (JSON/JSONL)
   - Agent target (sandbox/HTTP/module/command), settings (model, budget, timeout)

2. **Build Phase** (`experiment.ts` → `pi.ts`)
   - Extract requirements from materials (via REQUIREMENTS_ROLE prompt)
   - Mine or generate scenarios from real dialogues (GOALS_ROLE prompt)
   - Validate grounding (quotes verbatim from materials)
   - Store draft in `.agent-lab/{id}.json`, phase = "review"

3. **Review Phase** (Human confirmation)
   - Show draft hash, scenarios, estimated cost/time
   - `agent_lab_inspect` reveals full plan
   - `agent_lab_accept` / `agent_lab_edit` / `agent_lab_run`

4. **Evaluating Phase** (`experiment.ts` → `evaluation.ts`)
   - Open trial loop: up to `MAX_PARALLEL` (16) concurrent agent sessions
   - Per trial:
     - Initialize world state (records, writable fields)
     - Run target session (opening message, agent responds)
     - Loop: simulator answers user reply → agent responds (up to maxTurns)
     - Collect all events (tool calls, results, assistant messages)
     - Grade deterministic checks (`state_equals`, `answer_contains`, `tool_called`, etc.)
   - Record trial in memory; append events to `{id}.trace.jsonl`

5. **Results Review Phase** (`experiment.ts` → `judge.ts`)
   - If live mode + judge configured: assess rubrics (goal_attainment, prompt_compliance, user_fidelity)
   - Each rubric → separate model call (up to 2 per rubric, batched)
   - Record judge audit trail in trace journal

6. **Quality Analysis** (`quality.ts`, `comparison.ts`)
   - Compute accuracy: `passed / (passed + failed)` excluding unknown/invalid
   - Cluster failures by cause (deterministic and LLM observations)
   - Extract failure modes (what went wrong, how often, which scenarios)
   - Build verdict: one-line headline + detailed evidence

7. **Complete Phase**
   - Save evidence bundle to `.agent-lab/`
   - Export to JSON/HTML/Markdown if requested
   - Return summary to user: accuracy + causes + next steps

### Discovery Flow: Mine One Regression Test

1. **Discovery Input** (`experiment.ts` → `pi.ts`)
   - Real dialogues (JSON/JSONL)
   - Requirements (optional)
   - Budget: nominal calls + max calls + time limit

2. **Coarse Batch** (DISCOVERY_COARSE_ROLE)
   - Classify dialogues: candidate (shows agent failure), irrelevant, unknown
   - Aim for ~5 candidates

3. **Deep Dive** (DISCOVERY_HYPOTHESIS_ROLE)
   - For each candidate: propose one hypothesis (scenario) that explains it
   - Grade with deterministic checks

4. **Focus Selection** (selectDiscoveryFocus)
   - Find recurring requirement + dialogue set (3 representative, 2 control)
   - Propose one grouped test

5. **User Decision** (`agent_lab_build` mode=discover)
   - Show hypothesis (exact saved text, never paraphrased)
   - "Проверим?" — user approves or corrects
   - If approved: `agent_lab_build` mode=discover + fromRunId + hypothesis → build test definition

### Validate Flow: Accuracy from Production Logs

1. **Input:** De-identified real dialogues (1-16 turns, user opening required)
2. **Filter:** Exclude masked-only turns, customer-data cases without rules
3. **Sample:** Pool of outcome-blind candidates → sample ~15 scenarios
4. **Run:** With reactive simulator (no scripted mode, single user mode)
5. **Verdict:** One accuracy number on validation set (not production guarantee)

### Reassess Flow: New Rubrics on Recorded Evidence

1. **Input:** Saved run ID, new rubrics or new judge model
2. **Process:** Read immutable trials from trace journal; skip agent/simulator calls
3. **Output:** New separate immutable result (assessmentOf references original run)
4. **Use case:** Change judge, add metrics, re-evaluate without re-running agent

## Key Abstractions

**Experiment:**

- Purpose: Full run record — immutable once phase moves past "review"
- Examples: `src/contracts.ts` (experimentSchema)
- Pattern: Persisted as one JSON file per run; phases transition atomically

**Scenario (Card):**

- Purpose: One test case — goal, initial state, user opening, success criteria
- Examples: `src/contracts.ts` (scenarioSchema), `src/prompts.ts` (GOALS_ROLE)
- Pattern: Generated once per run; never edited mid-trial; immutable after accepting

**Trial:**

- Purpose: One execution of a scenario — agent response, events, check results
- Examples: `src/contracts.ts` (trialSchema), `src/evaluation.ts` (evaluateTrial)
- Pattern: Created during evaluating phase, graded once, never recalculated

**Requirement:**

- Purpose: One rule extracted from owner materials, grounded with exact quote
- Examples: `src/contracts.ts` (requirementSchema), `src/pi.ts` (REQUIREMENTS_ROLE)
- Pattern: Parsed from materials during preparing phase; used to score scenarios

**Revision:**

- Purpose: Immutable snapshot of agent spec (instructions + tools), labeled with hypothesis
- Examples: `src/contracts.ts` (revisionSchema), `src/experiment.ts` (revision function)
- Pattern: ID derived from content hash; multiple revisions never used in one run

**Check:**

- Purpose: Deterministic assertion on trial outcome (state field value, tool call count, answer substring, etc.)
- Examples: `src/contracts.ts` (checkSchema), `src/evaluation.ts` (grade function)
- Pattern: Defined in scenario; graded once per trial; pass/fail is deterministic

**Metric / Rubric:**

- Purpose: LLM-based assessment criterion (goal_attainment, prompt_compliance, etc.)
- Examples: `src/contracts.ts` (metricSchema), `src/judge.ts` (assessRepeated)
- Pattern: Applied to trials during results_review phase; used to override/enrich check verdicts

**Comparison:**

- Purpose: Statistical delta between two runs (baseline vs candidate)
- Examples: `src/contracts.ts` (comparisonSchema), `src/comparison.ts` (compareTrials)
- Pattern: Computed after both runs complete; includes bootstrap CI and sign test p-value

## Entry Points

**CLI (`dist/cli.js`):**

- `agent-lab chat` — Interactive Pi session with Agent Lab extension
- `agent-lab build --input task.json` — Generate scenarios offline
- `agent-lab evaluate --input suite.json --yes` — Run saved suite without interaction
- `agent-lab summary --id RUN` — Show accuracy + causes (read-only)
- `agent-lab export --id RUN --format html` — Generate report
- `agent-lab diff --before RUN1 --after RUN2` — Compare two runs

**Pi Extension (`extensions/agent-lab.ts`):**

- `agent_lab_build` — Main entry (build, discover, validate, score modes)
- `agent_lab_run` — Execute approved draft
- `agent_lab_inspect` — Read plan/results (no approval, export optional)
- `agent_lab_accept` — Approve one test definition
- `agent_lab_edit` — Modify draft before approval
- `agent_lab_repeat` — Copy approved suite into fresh draft
- `agent_lab_suite` — Save / load / list reusable test suites
- `agent_lab_connection` — Check/remember agent connection
- `agent_lab_reassess` — Evaluate saved trials with new rubrics

**Skill (`skills/agent-builder/SKILL.md`):**

- Conversational framework; guides user through build → run → review flow

## Architectural Constraints

- **Threading:** Single-threaded event loop (Node.js); trials run sequentially or up to MAX_PARALLEL (16) concurrent, managed via Promise.all
- **Global state:** ExperimentLab holds mutable phase/record state; ExperimentStore manages `.lock` file to prevent concurrent writes
- **Circular imports:** None enforced; modularity achieved via dependency on contracts (schemas are acyclic)
- **Immutability:** Trials once recorded are immutable; re-evaluation requires new run (workflow: reassess)
- **Determinism:** Check grading (state equality, tool counts) is deterministic; simulator and judge calls are non-deterministic but recorded (audit trail in trace journal)
- **Concurrency model:** One writer (ExperimentLab with lock), many readers (ExperimentStore.get without lock, read-only snapshots)
- **Transaction scope:** One experiment record = one atomic transaction; trace journal appends are sync + flush to survive interruption

## Error Handling

**Strategy:** Fail-fast with detailed context; checkpoint after every phase transition

**Patterns:**

- **Phase errors:** Transition to `error` phase, save error message in record; never overwrite error state
- **Target errors:** Trial marked `invalid` (measurement failed); does not count toward accuracy
- **Validation errors:** Schema parsing via Zod; human-readable messages with field paths
- **External state errors:** Trial `invalid` if adapter doesn't confirm resetConfirmed, state observability, or tool scope
- **Budget overrun:** Stop mid-phase, save usage, ask human before continuing (resumable discovery)
- **Lock contention:** Throw immediately with recovery instructions

## Cross-Cutting Concerns

**Logging:** 

- Trial events → trace journal (`{id}.trace.jsonl`) line-by-line
- Judge audits → same trace journal (trialId + judgeAudit struct)
- Phase transitions → logged in experiment record

**Validation:** 

- Input validation via Zod schemas (contracts.ts)
- Grounding validation (requirement quotes verbatim; scenario checks sensible)
- Trial validation (checks graded only if measurement complete; scenario matched to trial)

**Authentication:** 

- Target: via environment variables (API keys in headersEnv, credentials from external system)
- LLM models: via Pi's configured credentials (provider auth handled by Pi SDK)
- No per-run auth; connection validated once per `.agent-lab/` directory via doctor probe

## Anti-Patterns

### Not Storing Trial Results Separately from Scenarios

**What happens:** Trial outcome is re-derived every time from trial events
**Why it's wrong:** Non-deterministic judges and external targets mean same trial can score differently on re-read
**Do this instead:** Store trial as immutable record (`src/contracts.ts` trialSchema); re-judging creates separate assessmentOf result

### Modifying Scenarios Mid-Run

**What happens:** Accepting a draft locks scenario definitions; editing after that is blocked
**Why it's wrong:** Scenarios define what was tested; changing them invalidates previous trials
**Do this instead:** Use freshDraft() → new run, or agent_lab_edit before acceptance

### Trusting Adapter Assertions Without Grading

**What happens:** Just reading trial.observation.state = "sandbox" without validating
**Why it's wrong:** External adapters may lie or report incomplete data
**Do this instead:** Grade checks only when observation confirms (resetConfirmed, toolsComplete, stateKnown); else mark trial invalid

### Pooling Model Calls Across Rubrics

**What happens:** One judge call assesses goal_attainment + prompt_compliance + user_fidelity
**Why it's wrong:** Rubrics are independent; one failing should not shadow another's measurement
**Do this instead:** Two separate model calls per rubric (default) or one per rubric (assessRepeated logic)

### Silently Truncating RAG Context

**What happens:** Adapter returns 100 retrieval fragments; Lab truncates to 20 but marks retrievalsComplete: true
**Why it's wrong:** Verdict on RAG relevance is based on incomplete data; human never knows
**Do this instead:** Reject incomplete context; force adapter to return only complete full context, or mark retrievalsComplete: false

---

*Architecture analysis: 2026-09-16*
