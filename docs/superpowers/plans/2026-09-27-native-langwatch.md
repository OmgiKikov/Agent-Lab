# Native LangWatch workflow Implementation Plan

> Use superpowers:executing-plans inline. User delegated implementation and routine design choices.

**Goal:** One request inside LangWatch proceeds from logs through grounded scenarios to a native simulation suite with an honest result.
**Architecture:** Existing native React panel and secured routes call the existing service. Extract pure evidence handling and a native-suite coordinator with injectable persistence/API dependencies. LangWatch owns simulation execution, scenario/run history and model configuration.
**Tech Stack:** TypeScript, React/Chakra, Hono, native LangWatch REST and Prisma. Node 24 built-in test runner; no new runtime dependencies.
**Spec:** ../specs/2026-09-27-native-langwatch.md

## Constraints
- Keep work in the existing isolated codex/langwatch-migration checkout and deploy to localhost only.
- No external-page implementation, no modifications to tested agent, no private data in Git.
- Persist uncertainty and skip reasons; do not silently retry a potentially accepted paid run.

## Tasks
- [x] Evidence: tests for role parsing and required-source selection; extract evidence.ts; integrate in planner/judge and preserve full references in criteria.
- [x] Execution: tests for one suite, all repeats, partial enqueue, re-entry/recovery, concurrent serialization; implement workflow.ts with injected native API and save; connect runAll and auto-run after preparation.
- [x] Native surface: agent + repeat selection before starting, background stage/result with evidence links, resume interrupted preparation, report planned vs measured.
- [x] Verify and deliver: focused tests, native client/server build, real local route checks; attempted browser verification (limitation recorded below); update README/migration assessment; commit reviewed changes.

## Review focus
Changed scenario versions must not silently change a retry. Missing queue entries stay unmeasured. A timed-out start may already have spent money. Runtime controls must survive refresh. Source lookup failure must not become an agent failure.

## Ledger
- Read-only exploration found custom native routes and panel already installed; separate-page URL is now only a redirect, README is stale.
- Root causes: per-card batch dispatch saves whole analysis under different locks; sources of accepted rules are not pinned in judge input; role parser splits any CLIENT/AGENT word; UI requires a second manual launch.

- Review: fixed nested acceptance lock, inline colon parsing, client polling through dispatch, and single-card bypass of unknown batch state.
- Ruling: a rejected Redis enqueue promise is ambiguous, not proof of non-enqueue. Native dispatch now errors conservatively; the persisted batch is dispatch_unknown and retries stay blocked until reconciled.
- Live smoke: logs → rules → 3 cards → 1 native suite dispatched automatically. Concurrent external install restarted the worker; recorded ERROR (not agent failure). Recheck after final installation.
- Parallel work: another task added frozen native execution snapshots. Preserve its source files and installer hook; not authored in this task.

- Live result confirmed: 6 messages, native FAILED with judge rationale, summary measured=1/planned=1, pending=0/errors=0. Earlier restart stayed ERROR. Existing-card acceptance returns, duplicate run request returns the same batch.
- Verification: 12 focused tests pass; native scheduling test passes against installed method. Native custom files have no diagnostics in full tsc output; upstream production package still has unrelated missing test dependencies/types.
- Browser limitation: in-app browser failed to reach configured localhost; alternate 127.0.0.1 correctly refused authentication because of origin mismatch. Auth was not weakened. Verified secured API path using existing local login; visual proof not claimed.

- Final native client/server build installed successfully; persisted result remains readable after restart. Full visual verification not claimed.
