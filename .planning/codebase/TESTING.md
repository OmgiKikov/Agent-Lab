---
last_mapped_commit: fd07c336134b6bfe7bf48c8be0119c1b14dec56b
last_mapped_at: 2026-09-24
---
# Testing Patterns

**Analysis Date:** 2026-09-24

## Test Framework

**Runner:**

- Node.js built-in `node:test`, run through tsx (`tsx --test test/*.test.ts`)
- Node.js 22.19.0+
- 803 tests in 67 files at `fd07c336`, all green

**Assertion Library:**

- `node:assert/strict`: `assert.equal`, `assert.deepEqual`, `assert.match`, `assert.rejects`, `assert.throws`

**Run Commands:**

```bash
npm test                                   # build dist/ + tsx --test test/*.test.ts
npm run typecheck                          # build + strict tsc over extensions/*.ts (noUnusedLocals)
npx tsx --test test/card-review.test.ts    # one file
npx tsx --test --test-name-pattern="grant" test/card-commands.test.ts   # tests by name
```

`npm test` and `npm run build` recreate `dist/`. A live Pi session is not affected: the extension imports `src/` directly (jiti); `dist/` serves only the `agent-lab` binary and `examples/scenario-lab-demo.mjs`.

**Not type-checked:** tsx only transpiles, and `npm run typecheck` covers `src/` and `extensions/`. A strict `tsc` over `test/*.ts test/helpers/*.ts` reports 91 errors today (41 in `test/workflow.test.ts`); tests pass regardless.

**CI:** `.github/workflows/check.yml` runs `npm ci`, `npm test`, `npm run typecheck`, `npm pack --dry-run` and `evaluate` of `examples/regression-suite.json`.

**Test Output:**

- TAP from the Node.js runner; no coverage reporting configured

## Test File Organization

**Location:**

- `test/*.test.ts` — one file per concern, named after it: `card-proposal`, `card-review`, `card-commands`, `miner-sample`, `spreadsheet-import`, `calibration-judge`, `result-text`, `workspace`, `extension`, …
- `test/helpers/` — shared builders and fakes (below)
- `test/fixtures/` — frozen records of older formats and small agents
- `test/live/` — paid checks against a real model, run only on purpose; local pilots on private data are gitignored

**Naming:**

- Test titles are sentences stating the rule: `'no grant, no change: a model\'s flag, a copy of a grant, a grant for another preview or words where a confirmation is needed'`

**Structure:**

```
test/
├── *.test.ts
├── helpers/
│   ├── pi-session.ts     # fake `pi` registering the real extension; scripted owner in native dialogs
│   ├── pi-fixture.ts     # offline provider on a real ModelRuntime (SDK stream protocol, scripted replies)
│   ├── card-prep.ts      # invented refund dialogues + deterministic runtime for grounding, proposals, review, customer, judge
│   ├── card-library.ts   # a reviewed two-card draft without a store
│   ├── cards.ts          # a brief-format card and runs of its compiled definition
│   ├── calibration.ts    # scripted judge of recorded conversations through the real two-vote protocol
│   ├── miner.ts          # synthetic import with a topic answer key and a deterministic runner
│   ├── workspace.ts      # synthetic folders for /agent-lab and `openWorkspace`
│   ├── demo-record.ts    # records of the retired built-in demo, made by the code that could still make them
│   ├── library-v1.ts     # the frozen first-format library run
│   ├── xlsx.ts, zip.ts   # synthetic .xlsx workbooks and ZIP/.docx archives
│   ├── strict-schema.ts  # why a provider's strict structured output would refuse a schema
│   └── copy-check.ts     # owner-facing text is plain Russian
├── fixtures/
│   ├── recorded-run.json, legacy-demo-run.json (+ .trace.jsonl), legacy-demo-draft.json
│   ├── library-v1/                 # accepted first-format library, run, trace, judge audits
│   ├── pre-harness-judgments.json  # receipts written before the src/llm core
│   ├── rag-evidence-controls.json, score/
│   └── appointment-agent.mjs, board-chat-agent.mjs, stdio-agent.mjs
└── live/
    ├── product-eval.ts (+ -cases.ts, -session.ts)   # owner phrases → tool and state, real model
    ├── scenario-lab.ts                              # card path on real model roles, deterministic agent
    ├── rag-evidence.ts                              # judge controls for RAG evidence separation
    └── simulator-stop.ts (+ .synthetic.json)        # simulator stop regression
```

## Test Structure

**Suite Organization:**

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('a blocked claim leaves the card unusable, and no owner answer lifts it', () => {
  // build from helpers, act through the public API, assert on the record or the view
});

test('library writes share writer ownership, atomic readers and same-hash CAS admits one winner', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-lab-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // ...
});
```

**Patterns:**

- Pure derivations are tested directly: `deriveRun`, `buildResultView`, `resultScreen`, `situationViews`, `representativeSample`, `consentText`
- Engine flows go through `ExperimentLab` on a temporary data folder with a deterministic runtime (`createDemoRuntime`, `cardRuntime` from `card-prep.ts`)
- Chat tools are called through the real extension registered on a fake `pi`; native dialogs are answered by a scripted owner; rendered rows are checked for owner words (no ids, hashes, JSON or tool names)
- The workspace component is drawn at several widths (40–160 columns) on synthetic folders
- CLI tests spawn `process.execPath --import tsx src/cli.ts <command> … --data-dir DIR` and assert on stdout, exit code and written files

## Mocking

**Framework:**

- No mocking library; fakes are real objects with scripted answers

**Patterns:**

- Model roles: deterministic runtimes and runners that answer through the same output contract the harness enforces (per-call schema, then the domain check), or an offline provider on a real `ModelRuntime` (`pi-fixture.ts`)
- Agents under test: small module and stdio agents in `test/fixtures/`, `examples/scenario-lab-target.mjs`
- Owner: scripted `ctx.ui.select` / `editor` / `input` answers in `pi-session.ts`
- Concurrency: barriers instead of timing — the parallel-run test holds every dialogue at the simulator until all have started

**What to Mock:**

- Model replies, the owner's dialog answers, the agent's replies

**What NOT to Mock:**

- The file system (real temporary folders), zod validation, the store's lock and atomic writes, child processes for command and module agents

## Fixtures and Factories

**Compatibility fixtures:**

- Records of older formats are frozen JSON written by the code that made them: `recorded-run.json`, `legacy-demo-run.json`, `library-v1/`, `pre-harness-judgments.json`
- Golden tests prove each parses to itself, renders the same result, keeps its hashes and receipts verifying, re-assesses from recorded evidence and repeats on a new agent version
- A fixture is never regenerated with today's code; a new format gets a new fixture

**Synthetic data only:**

- Every test uses invented conversations and rules; the owner's real logs and records never enter the repository

## Coverage

**Requirements:**

- No coverage target or report; coverage is argued per rule — each trust invariant has named tests (`docs/code-review-2026-09-23.md`, section «Инварианты доверия и чем они доказаны»)

## Test Types

**Unit Tests:**

- Pure modules: counting (`run.test.ts`, `card-expectations.test.ts`), result wording (`result-text.test.ts`), situation projection (`card-view.test.ts`), sampling and coverage (`miner-*.test.ts`), spreadsheet reading (`spreadsheet-*.test.ts`), checks and review (`card-proposal.test.ts`, `card-review.test.ts`)

**Integration Tests:**

- `ExperimentLab` with the store: preparation, acceptance, run, repeat, reassessment, calibration, suites (`experiment.test.ts`, `card-prepare.test.ts`, `calibration-judge.test.ts`, `suite-logs.test.ts`)
- Concurrency: real processes competing for the writer lock (`store.test.ts`)
- Chat and workspace end to end on the teaching example (`extension.test.ts`, `workspace-command.test.ts`, `product-flow.test.ts`)

**E2E and Live:**

- `node examples/scenario-lab-demo.mjs --verify` — the whole teaching path on the built `dist/`, no model
- `test/live/*.ts` — real model, invented data, explicit `--run`; `test/product-eval.test.ts` only checks that the eval cases, their projects and the scorer hold together

## Common Patterns

**Async Testing:**

```typescript
test('a paid call that died in flight is never repeated: its dialogue is left out, the others go on', async () => {
  // prepare with a runtime that fails one call, resume, assert the call count and the record
});
```

**Error Testing:**

```typescript
// Typed errors by class, owner-facing messages by their words.
await assert.rejects(store.writeLogVersions(second.next, fingerprint(stored)), StaleRevisionError, 'a declaration prepared on an older journal is refused');
await assert.rejects(lab.applyLogVersion(again, hostGrant(again, 'words')), CommandRefused);
await assert.rejects(lab.convertV1Draft(record.id), /Прогон старого формата не переносится/);
```

**Owner-words check:**

```typescript
assert.doesNotMatch(shown, /[{}"]|[a-f0-9]{16}|agent_lab_/, `${name}: «${shown}»`);
```

## Test Timeout

- `node:test` sets no per-test timeout by default; flows that prepare, run or spawn processes set one explicitly, from `{ timeout: 15000 }` to `{ timeout: 180000 }` (most often 60000)

---

*Testing analysis: 2026-09-24*
