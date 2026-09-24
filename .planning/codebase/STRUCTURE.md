---
last_mapped_commit: fd07c33b
last_mapped_at: 2026-09-24
---
# Codebase Structure

**Analysis Date:** 2026-09-24 (chunk G1: engine split into `src/lab/`, contracts split, CLI command table)

## Directory Layout

```
lyon/
├── src/                          # The library (TypeScript, strict, ESM)
│   ├── experiment.ts             # ExperimentLab — the engine's one entry (delegates to lab/)
│   ├── phases.ts                 # Typed phase table: PHASES, PHASE_TABLE, isRunning, moveTo, stoppedPhase (leaf)
│   ├── lab/                      # The engine, split by operation
│   │   ├── record.ts             # draftHash, resultHash, measurementHash; newRecord, freshDraft
│   │   ├── operation.ts          # OperationRunner: one operation at a time, budget, checkpoints, followers
│   │   ├── context.ts            # Lab: what the operations share (store, runner, runtime, live reads)
│   │   ├── library.ts            # create, check, commands, accept, resume, convert, log-version declarations
│   │   ├── run.ts                # updateDraft, acceptDraft, repeat, suites, start (the dialogue pool)
│   │   └── review.ts             # reassess, addHumanReview, reviewResults
│   ├── contracts.ts              # The stored record: Experiment, Scenario, Trial, settings, checks (Zod)
│   ├── assessment.ts             # Rubrics, assessments, judge audits and receipts, their validation
│   ├── runtime.ts                # Runtime, CallContext, TargetSession: what the engine asks of the world
│   ├── verbatim.ts               # Verbatim quote matching, value tokens
│   ├── store.ts                  # ExperimentStore: storage only (records, lock, journals, sidecars, publication)
│   ├── scenario-store.ts         # File areas of the store: imports, libraries, log-version journals, publications
│   ├── card/                     # Situations (card v2): schema, proposal, checks, review, status, commands,
│   │                             #   compile, library, prepare, budget, view, legacy-v1, convert, calibration*
│   ├── miner/                    # Scenario Miner: topic map, sample, coverage, plan (consent), files
│   ├── spreadsheet/              # .xlsx/.csv logs: xlsx, xml, csv, proposal, mapping, markers, selection, import
│   ├── llm/                      # model-call, structured tasks, role→model table
│   ├── cli.ts                    # agent-lab: the command table (dist/cli.js)
│   ├── cli/import-flags.ts       # `agent-lab import` flags → the owner's table choices
│   ├── evaluation.ts             # One trial: world, target session, controlled customer, checks
│   ├── targets.ts                # HTTP / module / command adapters, release hook, prompt file
│   ├── judge.ts                  # The judge: votes, receipts, audits
│   ├── pi.ts, prompts.ts         # The Pi runtime: every role as a typed task; role prompts
│   ├── demo.ts                   # The deterministic teaching example
│   ├── run.ts                    # deriveRun: the one derivation of a run's result
│   ├── result-view.ts            # ResultView: the one result model
│   ├── result-text.ts            # The words of a result, for every surface
│   ├── report.ts, blocks.ts, report-style.ts   # The customer report (HTML/Markdown/JSON)
│   ├── inbox.ts, problems.ts, workspace.ts     # Decisions, recurring problems, the agent's workspace
│   └── …                         # comparison, quality, outcomes, explain, coverage, agreement, detect, imports,
│                                 #   materials, connection, suite, scenario-library, ids, text, errors, limits
├── extensions/                   # Pi: nine tools by step, the /agent-lab workspace, long work in the session
│   ├── agent-lab.ts              # Registration, steps, system prompt from SKILL.md
│   ├── prepare-tool.ts, situation-tools.ts, decide-tool.ts, run-tool.ts, result-tools.ts
│   ├── operations.ts             # The session's writer lease and long work; followRecord
│   ├── background.ts             # Long work handed to the session; progress row; result messages
│   ├── workspace.ts, workspace-screens.ts, board-command.ts   # /agent-lab
│   └── render/                   # feed, verdict block, situation rows, theme
├── skills/agent-builder/SKILL.md # The one instruction source of an Agent Lab session
├── test/                         # node:test via tsx; fixtures/ (library-v1 goldens, recorded runs), helpers/, live/
├── examples/                     # Teaching agent, sample agents, connection and CI examples
├── docs/                         # Audits, reviews, verification guide
└── .agent-lab/                   # Runtime data (git-ignored, private)
```

## Directory Purposes

**`src/lab/`:** the engine. Every operation on records lives here, one module per kind of operation; `experiment.ts`
is the facade the surfaces call. A new operation goes into the module of its kind and gets a one-line method on
`ExperimentLab`.

**`src/card/`:** everything about a situation of the card format, from the model's proposal to its compiled,
sealed definition and its calibration against production logs. First-format libraries are read through
`legacy-v1.ts` and continued through `convert.ts`.

**`src/miner/`:** the logs' topics, the representative sample and coverage; `plan.ts` holds the preparation's consent.

**`src/spreadsheet/`:** spreadsheet exports read without dependencies, through a mapping the owner confirms.

**`src/llm/`:** one request per model call and the structured-task harness; `pi.ts` builds the runtime from it.

**`extensions/`:** the Pi surface only: tools, dialogs and rendering over `ExperimentLab`.

**`.agent-lab/`:** one data folder per project:

```
.agent-lab/
├── {runId}.json                  # The record (atomic replace)
├── {runId}.trace.jsonl           # Trial events and final judge audits (append-only)
├── {runId}.generator.jsonl       # Every builder call, hashed (append-only)
├── {runId}.judge/{trialId}.json  # Full judge audit of a trial (sidecar)
├── {runId}.calibration/{key}.json# Judge audit on a logged conversation (sidecar)
├── imports/{importId}.json       # Verbatim import batch (content-addressed, immutable)
├── imports/{importId}.mapping.json          # How a spreadsheet was read, as the owner confirmed it
├── imports/{importId}.topics-{key}.json     # Topic map and its build progress
├── imports/{importId}.declarations.json     # The owner's word on which agent version wrote the logs (append-only)
├── libraries/{libraryId}/{hash}.json        # Library revisions; current.json points at the head
├── publications/{runId}.json     # Intent of a library + record write, finished on the next open
├── connection.local.json         # The remembered connection
├── .lock / .recovery             # The writer's lock and its recovery gate
```

## Key File Locations

**Entry points:** `src/cli.ts` (→ `dist/cli.js`), `extensions/agent-lab.ts`, `skills/agent-builder/SKILL.md`.

**Engine:** `src/experiment.ts`, `src/lab/*.ts`, the phase table `src/phases.ts`.

**Stored shapes:** `src/contracts.ts` (record), `src/assessment.ts` (judgment), `src/card/schema.ts` (cards),
`src/scenario-contracts.ts` (imports, first library format), `src/card/calibration.ts`, `src/miner/schema.ts`.

**Result:** `src/run.ts` → `src/result-view.ts` → `src/result-text.ts`, `src/report.ts`.

**Storage:** `src/store.ts`, `src/scenario-store.ts`, `src/fs-atomic.ts`.

**Compatibility goldens:** `test/fixtures/library-v1/`, `test/fixtures/recorded-run.json`, `test/fixtures/legacy-demo-run.json`.

## Naming Conventions

- Files: lowercase with hyphens; a folder groups one concern (`lab/`, `card/`, `miner/`, `spreadsheet/`, `llm/`).
- Tests: `test/<module>.test.ts`; helpers in `test/helpers/`; live checks with a real model in `test/live/` (not in CI).
- Identifiers: PascalCase types, camelCase functions, `…Schema` for Zod schemas, UPPER_CASE constants.
- Imports: relative with `.js` extensions; type-only imports as `import type`.

## Where to Add New Code

- **A new operation on records:** the `src/lab/` module of its kind; save through `operations.checkpoint` or
  `operations.publishLibrary` so followers hear of it; move phases only with `moveTo`; one method on `ExperimentLab`.
- **A new phase or transition:** `src/phases.ts` (`PHASES`, `PHASE_TABLE`) — the stored enum reads it; a leaf
  module, so the record, the result modules and the engine all read the same table.
- **A new owner command on situations:** `src/card/commands.ts` (prepare/apply with a host grant), then the chat tool,
  the board and the CLI `cards` command call it through `ExperimentLab.prepareCardCommand`/`applyCardCommand`.
- **A new CLI command:** a function and one entry in `COMMANDS` in `src/cli.ts` (its help lines come from the entry).
- **A new Pi tool:** a `register*` module in `extensions/`, its name in `extensions/steps.ts` for the step it belongs to.
- **A new result line:** `src/run.ts`/`src/result-view.ts` for the fact, `src/result-text.ts` for the words.
- **A new stored field:** optional in its schema, so old records keep parsing; never inside an existing hash.

## Special Directories

- `dist/`: build output of `src/` (`npm run build`), used only by the `agent-lab` binary; Pi loads `src/` directly.
- `.agent-lab/`: private runtime data, never committed; production dialogues stay here.
- `.planning/`, `.context/`: planning artifacts and private working notes.

---

*Structure analysis: 2026-09-24*
