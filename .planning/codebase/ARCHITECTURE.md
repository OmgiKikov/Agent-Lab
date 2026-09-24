---
last_mapped_commit: fd07c33b
last_mapped_at: 2026-09-24
---
<!-- refreshed: 2026-09-24 (chunk G1: engine split, typed phase table, operation followers, CLI command table) -->

# Architecture

**Analysis Date:** 2026-09-24

## System Overview

Agent Lab runs a real AI agent on situations drawn from its real logged conversations and answers one question in
plain words: how good the agent is — one accuracy number with its interval, what is not measured and why, the causes of
failure and how far the synthetic customers agree with production. Three surfaces share one engine; the engine shares
one derivation of the result.

```text
  Pi chat: 9 tools, active by step        /agent-lab workspace (board)        agent-lab CLI: command table
  extensions/agent-lab.ts, *-tool.ts      extensions/workspace*.ts            src/cli.ts
                 └──────────────────────────────────┼──────────────────────────────────┘
                                                     ▼
                         ExperimentLab — src/experiment.ts (the engine's one entry)
       lab/library.ts          lab/run.ts                 lab/review.ts             lab/record.ts   phases.ts
       situations: prepare,    a run: draft, owner's      results: re-assessment,   hashes, new &   the phase table
       check, commands, accept confirmation, dialogues    a person's verdicts       fresh records   (a leaf module)
                         lab/operation.ts — one operation at a time: budget, time, checkpoints, followers
                                                     │
   card/ (situations v2)   miner/ (topics, sample, coverage)   evaluation.ts + targets.ts   judge.ts, card/log-judge.ts
   llm/ + pi.ts (every model call as a typed task)   runtime.ts (what the engine asks of models and the agent)
                                                     │
                  run.ts ──► result-view.ts ──► result-text.ts · report.ts/blocks.ts · explain.ts
                  (one derivation)  (one model)      (the same words in chat, board, CLI, HTML/Markdown, CI exit code)
                                                     │
                     store.ts + scenario-store.ts — storage only ──► .agent-lab/ (0600 files, 0700 folders)
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| **ExperimentLab** | The engine's one entry over one data folder: opens it as the writer, marks records a dead process left running interrupted, reads live or stored records, delegates every operation to `lab/` | `src/experiment.ts` |
| **Phase table** | Every phase, whether a process owns it, and the moves of the normal course; `moveTo` refuses any other move, `stoppedPhase` says where work cut short ends | `src/phases.ts` |
| **Record** | The three hashes a record is sealed by (`draftHash`, `resultHash`, `measurementHash`), a new draft from the owner's input, a fresh draft copied from an earlier record | `src/lab/record.ts` |
| **OperationRunner** | One long operation at a time (preparation, check, run, re-assessment) and the short changes between them: call budget and time limit, checkpoints, cancel, and the followers told of every change instead of polling | `src/lab/operation.ts` |
| **Library operations** | Prepare situations from logs or rules under the consented ceiling, check them, apply the owner's commands, accept them, continue a preparation, convert a first-format draft, declare the logs' agent version | `src/lab/library.ts` |
| **Run operations** | Draft settings and connection, confirmation of first-format drafts, repeat, saved suites, the run itself (release hook, pool of dialogues, failure causes, calibration) | `src/lab/run.ts` |
| **Review operations** | Re-assessment of recorded dialogues (a separate result), a person's verdicts, the completed review | `src/lab/review.ts` |
| **Stored record** | Zod schemas of the stored record: Experiment, Scenario, Trial, settings, checks, human reviews; old records parse without migration | `src/contracts.ts` |
| **Assessment contract** | Rubrics, per-metric assessments with quoted evidence, judge audits and receipts, their validation | `src/assessment.ts` |
| **Runtime ports** | What the engine asks of models and of the agent: `Runtime`, `CallContext`, `TargetSession` | `src/runtime.ts` |
| **Situations (card v2)** | The card brief, proposal and binding, deterministic checks, the reviewer's claims, status and the owner's one question, commands, compilation at acceptance, calibration against production logs | `src/card/*` |
| **Scenario Miner** | The logs' topic map, the representative sample, coverage and traffic weights | `src/miner/*` |
| **Spreadsheet import** | `.xlsx`/`.csv` logs read through a mapping the owner confirms, a row filter, no dependency | `src/spreadsheet/*`, `src/zip.ts` |
| **Dialogues** | One trial = fresh world + target session + controlled customer; checks graded in code | `src/evaluation.ts`, `src/targets.ts`, `src/user-controller.ts` |
| **Judge** | Two votes per expectation, receipts over sidecar audits; the same judge on the logged conversation | `src/judge.ts`, `src/card/log-judge.ts` |
| **Model harness** | One request per call via Pi's `ModelRuntime`, typed structured tasks with bounded repairs, role→model table | `src/llm/*`, `src/pi.ts`, `src/prompts.ts` |
| **Result** | `deriveRun` → `ResultView` → the same rows and words everywhere; report as a block tree | `src/run.ts`, `src/result-view.ts`, `src/result-text.ts`, `src/report.ts`, `src/blocks.ts` |
| **Workspace & inbox** | The agent's workspace, open decisions, recurring problems, derived from records | `src/workspace.ts`, `src/inbox.ts`, `src/problems.ts` |
| **ExperimentStore** | Storage only: atomic record files, the writer's lock, journals and sidecars, content-addressed file areas, publication recovery, a change feed for readers | `src/store.ts`, `src/scenario-store.ts` |
| **CLI** | One table of commands over the same ExperimentLab operations; `--yes` is the owner's word | `src/cli.ts`, `src/cli/import-flags.ts` |
| **Pi extension** | Nine tools switched on by step, the `/agent-lab` workspace, long work handed to the session and followed through the engine's events | `extensions/*` |

## Pattern Overview

**Overall:** one engine behind three surfaces; an explicit phase table; one operation at a time whose progress is
pushed to followers; content-addressed evidence; one derivation of the result.

**Key Characteristics:**

- **Single writer:** one ExperimentLab holds the folder's `.lock`; readers never take it and may run beside a live run.
- **One operation at a time:** `OperationRunner.launch` reserves the lab before its first await, saves the record as
  started and returns; the work goes on in the background. Short changes run through `change()` and exclude operations.
- **Followers, not polling:** a checkpoint, a saved step of a preparation, a progress line (`say`) and the final save
  are announced to `lab.follow(...)` followers with the live record; the chat's rows, the session's progress row and
  the workspace redraw from it. Another process's saves reach a reader through `ExperimentStore.watch` (fs events).
  Only spinners turn on a clock — Pi's `Loader` and the workspace's own, at the same 80 ms — and a spinner only draws.
- **Typed phase table:** every checkpoint and every start moves a record with `moveTo`; a move the table does not hold
  is a defect, never a saved state.
- **Sealed evidence:** accepted situations are compiled once and sealed by definition hashes; a run is verified by
  stored hashes alone (`verifyAcceptedRun`); receipts seal sidecar audits; hashes use locale-free key orders.
- **Host-owned consent:** the owner agrees to what a preparation may spend (its computed ceiling) and to a run in one
  native dialog; the model never passes settings, grants or consent.
- **Honest unknown:** what was not observed stays `unknown`; an unmeasured situation never counts; costs that are not
  reported stay `null`.
- **One result:** `deriveRun` decides every outcome once; chat, board, CLI, HTML/Markdown and the CI exit code read it.

## Layers

**Surfaces:**

- Purpose: the owner's ways in — chat, workspace board, command line
- Location: `extensions/` (Pi), `src/cli.ts`
- Contains: tool definitions, native dialogs, rendering, the CLI command table
- Depends on: ExperimentLab, result and view projections
- Used by: Pi (`agent-lab chat`, `npm run pi`), shells and CI (`agent-lab evaluate`)

**Engine:**

- Purpose: every operation on records, their order and their budgets
- Location: `src/experiment.ts`, `src/lab/`, the phase table `src/phases.ts`
- Contains: phase table, record hashes, the operation runner, library/run/review operations
- Depends on: domain modules, runtime ports, the store
- Used by: surfaces only

**Domain:**

- Purpose: situations, logs, dialogues, judgment and calibration
- Location: `src/card/`, `src/miner/`, `src/spreadsheet/`, `src/evaluation.ts`, `src/judge.ts`, `src/targets.ts`, `src/simulator.ts`, `src/user-controller.ts`
- Contains: pure functions and typed schemas; paid steps take a `CallContext`
- Depends on: `src/contracts.ts`, `src/assessment.ts`, `src/runtime.ts`
- Used by: the engine; views read the stored shapes

**Model runtime:**

- Purpose: every model call as a typed task with a role, a schema and bounded repairs
- Location: `src/llm/`, `src/pi.ts`, `src/prompts.ts`, `src/demo.ts` (deterministic teaching runtime)
- Depends on: Pi SDK `ModelRuntime`; prompts inside stored hashes never change silently
- Used by: the engine through the `Runtime` port

**Result:**

- Purpose: the one accuracy metric and everything read from it
- Location: `src/run.ts`, `src/result-view.ts`, `src/result-text.ts`, `src/report.ts`, `src/blocks.ts`, `src/explain.ts`, `src/coverage.ts`, `src/agreement.ts`, `src/interval.ts`
- Used by: every surface and the CI exit code

**Storage:**

- Purpose: durable, private, atomic evidence
- Location: `src/store.ts`, `src/scenario-store.ts`, `src/fs-atomic.ts`, `src/miner/files.ts`, `src/spreadsheet/files.ts`
- Contains: record files, the lock, journals, sidecars, imports, libraries, publications — no phase, budget or command rule
- Used by: the engine; readers (CLI `summary`/`export`/`diff`, the board) read without the lock

## Data Flow

### Logs → situations → run → result

1. **Import:** a JSON/JSONL export or a spreadsheet read through the owner's confirmed mapping becomes an immutable,
   content-addressed import batch (`src/imports.ts`, `src/spreadsheet/`).
2. **Consent:** `preparationConsent` (`src/miner/plan.ts`) states the conversations read, those left out with reasons,
   the situations promised and the call ceiling (`src/card/budget.ts`: topic map + policy + per situation its reading,
   proposal allowance and review). The owner agrees in one native dialog.
3. **Preparation** (`lab/library.ts create` → `card/prepare.ts`): topic map, representative sample, rules grounded
   with verbatim quotes, one card per conversation, harness checks, the reviewer's claims; every step is published
   with the draft, so a resume never pays twice. The preparation stops at the consented ceiling.
4. **Review:** the owner answers questions and edits through commands (`card/commands.ts`), one host grant each.
5. **Run** (`lab/run.ts start`): one dialog accepts the ready situations and starts the run; every card is compiled
   and sealed; a pool of dialogues runs against the agent; every dialogue is a checkpoint; failure causes are named.
6. **Calibration** (`card/calibrate.ts`): the same expectations judged on the logged conversations — «синтетика
   совпадает с продом в N из M».
7. **Result:** `deriveRun` → `ResultView` → «Точность агента: N% — X из Y ситуаций» with interval, what is not
   measured, causes, calibration — the same in chat, board, CLI and report.

### Re-assessment

A finished run's recorded dialogues are judged again under new criteria or another judge (`lab/review.ts`): a
separate record with `assessmentOf`, the agent and the simulator are not called, the original never changes.

### Long work and its followers

`launch` → first save announced → `checkpoint` / `publishLibrary` / `say` announced → last save announced. The chat
row (`extensions/prepare-tool.ts`, `run-tool.ts`), the session's progress row (`extensions/operations.ts`,
`background.ts`) and the workspace (`extensions/workspace.ts`) redraw on each; completion is `waitForIdle`.

## Key Abstractions

- **Experiment (record):** one run or draft; one JSON file; `phase` moves only along `PHASE_TABLE` (`src/contracts.ts`, `src/phases.ts`).
- **Card / LibraryV2:** a situation's brief (what the customer wants, writes, knows, when they leave) and 1–3 duties with the owner's rules; revisions sealed by `libraryHash` (`src/card/schema.ts`).
- **Scenario:** a card compiled at acceptance; its `fingerprint` is the definition hash the acceptance seals (`src/card/compile.ts`).
- **Trial:** one dialogue with its events, checks, assessments and receipts; never recalculated in place (`src/contracts.ts`).
- **Operation / Follower:** the running work and whoever follows it (`src/lab/operation.ts`).
- **ResultView:** the one result model (`src/result-view.ts`).

## Entry Points

- **CLI (`dist/cli.js`, `src/cli.ts`):** `detect`, `import`, `build`, `cards`, `accept`, `run`, `repeat`, `demo`,
  `summary`, `logs`, `reassess`, `export`, `diff`, `save-suite`, `evaluate`, `suites`, `doctor`, `status`; `chat` (or
  no command in a terminal) opens Pi with the extension.
- **Pi tools (`extensions/steps.ts`):** `agent_lab_status`, `agent_lab_prepare` → + `agent_lab_cards`,
  `agent_lab_edit`, `agent_lab_decide`, `agent_lab_run` once situations exist → + `agent_lab_results`,
  `agent_lab_explain`, `agent_lab_agree` once a run has conversations.
- **Pi command:** `/agent-lab` — the agent's workspace; `/agent-lab demo` — the teaching example.
- **Instructions:** `skills/agent-builder/SKILL.md` joins the system prompt of an Agent Lab session.

## Architectural Constraints

- **Threading:** one event loop; dialogues of a run run in a pool of at most 16 (`MAX_PARALLEL`).
- **Global state:** only the running operation (`OperationRunner`) and the writer's lock; records are the truth.
- **Immutability:** accepted snapshots, imports and finished runs never change; changes go to fresh drafts.
- **Hashes:** stored hashes and receipts must keep verifying; `canonical()` pins the `en-US` collation, `fingerprint()` sorts by code point.
- **Compatibility:** old records (first library format, legacy runs) open, re-assess and repeat without migration.
- **Size:** no source file over 1000 lines; the engine is split along its operations.

## Error Handling

- **Work cut short:** `stoppedPhase` — a preparation that saved a draft returns to `review` with what it made; a
  stop is `cancelled`; anything else is `error`, with the reason in the record.
- **Budgets:** a preparation stops at its consented ceiling; a run, a check or a resume at the draft's limit
  (`settings.maxCalls`); a paid call that died in flight is never repeated silently.
- **Restart:** records left in a running phase become `interrupted` when the folder is opened again.
- **Measurement:** a dialogue that could not be measured is `invalid` with a typed cause and never counts.
- **Typed errors:** `LibraryConflict`, `StaleRevisionError`, `LockedError`, `Stopped`, `NeedsOwner` instead of message matching.

## Cross-Cutting Concerns

**Evidence:** trace events → `{id}.trace.jsonl`; judge audits → `{id}.judge/`; calibration audits → `{id}.calibration/`;
builder calls → `{id}.generator.jsonl`.

**Validation:** Zod at every stored boundary; quotes verbatim (`src/verbatim.ts`); per-call enums for model answers.

**Privacy:** production dialogues and credentials stay local in `.agent-lab` (0600/0700) and never enter the repository.

---

*Architecture analysis: 2026-09-24*
