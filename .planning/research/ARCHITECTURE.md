# Architecture Research

**Domain:** Adding trust fixes and result UX to an existing LLM-agent evaluation harness (Pi extension + CLI + TypeScript library)
**Researched:** 2026-09-16
**Confidence:** HIGH for integration points (every file and line below was read at HEAD `628ff25`, which has the same `src/` and `extensions/` as `015fee9`). MEDIUM for the proposed new component shapes (these are design recommendations, not verified behaviour).

## Verdict first

1. **Build one pure `ResultView` view-model first. All four renderers read from it.** The numbers already come from one place (`qualitySummary` → `verdictSummary` → `outcomes.ts`). What is missing is one *presentation* object: one denominator, named "не измерено", failures in the form "should have said X → said Y → rule N", agreement %, stability and progress. Today the chat block (`extensions/agent-lab.ts:20-38`), the board (`extensions/cards.ts:186-255`), the CLI (`src/cli.ts:88-96`) and the reports (`src/report.ts`) each assemble their own text from `QualitySummary`/`VerdictSummary`. That is why the first screen reads badly.
2. **Move judge audits out of the run record before the production scoring feature.** A full audit (prompt, full source text in the input, one input per vote, raw replies) is copied onto every trial (`src/evaluation.ts:297`). Scoring 200 production dialogues with a real knowledge base will pass the 50 MB read limit (`src/store.ts:100`), and the run becomes unreadable. Audit slimming (A4 below) therefore blocks feature 6.
3. **Deliver "X → Y → rule N" without changing the judge protocol.** The explanation can be assembled after the fact from data the record already has: `successCriteria` gives X, a quoted assistant citation gives Y, and `requirementIds` plus the verbatim `quote` gives N. Any change to `JUDGE_PROMPT` or `JUDGE_RESPONSE_FORMAT`, or to retry/aggregation for "fewer no-decision" results, changes `JUDGE_PROTOCOL` (`src/judge.ts:20`) and so `evaluatorVersion` (`src/pi.ts:77`). Every earlier run then becomes incomparable until it is re-assessed. Make any such change **once**, in its own phase, before the final demo runs.
4. **The `goalObservation` fix belongs at comparison time, not at schema parse.** If the default is applied when a record is parsed, `hasCompleteJudgment` breaks on legacy runs: the recomputed `judgeInput` contains `goalObservation: 'reply'` where the original contained nothing, so the `inputHash` check at `src/judge.ts:121` fails.
5. **Production-vs-test is a side-by-side comparison, not a paired one.** `compareRuns` requires the same card set, settings, sources and requirements (`src/comparison.ts:540-560`), and a `score` record never satisfies that. Add a separate pure function. Also make `score` reuse the test run's requirements and judge settings. Without that, "same judge, same criteria" is not true: `score` grounds requirements on its own (`src/experiment.ts:394-398`), and CLI `score` uses a different default judge from Pi `score`.

## Standard Architecture

### System Overview (target)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         SURFACES (render only, no counting)                  │
│  extensions/agent-lab.ts        extensions/cards.ts        src/cli.ts        │
│  ┌──────────────┐ ┌──────────┐  ┌──────────────────────┐   ┌──────────────┐  │
│  │ verdict block│ │ progress │  │ board: Итог/Провалы/ │   │ summary text │  │
│  │ (msg render) │ │ + checklist│ │ Диалоги/Сравнение    │   │ export html  │  │
│  └──────┬───────┘ └────┬─────┘  └──────────┬───────────┘   └──────┬───────┘  │
│         │ NEW render/verdict-block.ts  NEW render/board-*.ts  NEW render/text.ts, render/html.ts
├─────────┴────────────┴───────────────────┴──────────────────────┴───────────┤
│                  VIEW-MODEL (pure, sync, one object per screen)              │
│   NEW src/result-view.ts  buildResultView(bundle) → ResultView               │
│   NEW src/explain.ts      failureExplanation(record, trial) → X → Y → rule N │
│   NEW src/progress.ts     progressView(record, now) · preparationChecklist() │
├──────────────────────────────────────────────────────────────────────────────┤
│              ANALYSIS (pure; the only place numbers are made)                │
│  src/outcomes.ts   src/comparison.ts   src/quality.ts                        │
│  + NEW judgeAgreement()  + NEW compareWithProduction()  + stability rows     │
├──────────────────────────────────────────────────────────────────────────────┤
│        ASSEMBLY (async, owns store access)  src/artifacts.ts                 │
│  evidenceBundle(record, store, {beforeId, productionId}) → EvidenceBundle    │
│        + before, comparison, production, view                                │
├──────────────────────────────────────────────────────────────────────────────┤
│   ORCHESTRATION  src/experiment.ts (ExperimentLab)                           │
│   + NEW src/normalize.ts (goalObservation default, goal ids, score budget)   │
│   judge: src/judge.ts · evaluation: src/evaluation.ts                        │
├──────────────────────────────────────────────────────────────────────────────┤
│   STORAGE  src/store.ts   {id}.json (slim) · {id}.trace.jsonl · NEW audits   │
└──────────────────────────────────────────────────────────────────────────────┘
```

Data flows **down → up** only. Surfaces never call `qualitySummary` or `verdictSummary` directly. They call `buildResultView` or receive a `ResultView` in tool `details`.

### Component Responsibilities

| Component | Owns | Status | File(s) |
|-----------|------|--------|---------|
| Scenario normalization | The one place that sets the `goalObservation` default, harness-assigned goal ids and the shared score budget/settings | NEW | `src/normalize.ts` |
| Judge receipt / audit sidecar | Keeps the full audit outside `{id}.json`; the trial keeps a small verified receipt | NEW + change | `src/store.ts`, `src/evaluation.ts:297`, `src/judge.ts:110-140`, `src/contracts.ts:238-250,759` |
| Failure explanation | "должен был X → сказал Y → правило N" with verbatim citations, derived from the record | NEW | `src/explain.ts` |
| Judge agreement | Agreement % between human one-key verdicts and the judge's *original* results | NEW function | `src/outcomes.ts` (next to `latestHumanReviews`) |
| Stability | Cards whose result changed between repeats of the same agent | NEW rows | `src/comparison.ts` (reuse `repeatResults` at 191-206 and `compareRuns`) |
| Production comparison | Test vs production: accuracy, per-rule accuracy, shared failed rules, a comparability guard | NEW function | `src/comparison.ts` or `src/production.ts` |
| Expectation sheet | One-screen projection of every card: what the agent must do, which rule, which quote, which channel | NEW function | `src/quality.ts` (next to `testPlanLines`, 101-178) |
| ResultView | The single presentation object for all surfaces | NEW | `src/result-view.ts` |
| Progress / checklist | Done / time left / money; preparation checklist state | NEW | `src/progress.ts` |
| Renderers | Chat block, board tabs, copyable text, light HTML | NEW / rewrite | `extensions/render/*.ts`, `src/render/text.ts`, `src/render/html.ts` |
| Evidence bundle | Resolves `before`, `production` and `view` once, asynchronously | EXTEND | `src/artifacts.ts:42-66` |

## Where each target feature goes

### 1. Trust fixes

| Fix | Where the defect is | Change | Touches fingerprints? |
|-----|--------------------|--------|-----------------------|
| **A1. Repeat stays comparable** | `freshDraft` adds `goalObservation: 'reply'` (`src/experiment.ts:69-70`). `compareRuns` then flags the card as changed (`src/comparison.ts:551-552`), and any note marks all pairs incomparable (561-566). | Add `normalizeScenario(s, targetKind)` in `src/normalize.ts`. Use it (a) in `compareRuns` card identity, `fingerprint(normalize(s))` on both sides, and (b) to replace the five scattered defaults (`experiment.ts:69-70, 358, 369, 526, 605`; `contracts.ts:431`). **Do not** apply it in `experimentSchema` parse, because that breaks legacy `hasCompleteJudgment` (`judge.ts:120-121` recomputes `judgeInput`, which includes `goalObservation`). | No hash changes. Comparison semantics change: missing and `'reply'` count as equal for non-sandbox targets. Needs a test in `test/comparison.test.ts`. |
| **A2. Duplicate goal id does not throw away a paid build** | The model picks `goal.id` per dialogue (`src/pi.ts:619-648`). Batches are merged, then `validateObservedGoals` throws on a duplicate (`experiment.ts:329-344` → `contracts.ts:386`). | In the replay branch, set `goal.id = dialogue.id` right after `extract` (inside the batch loop, `experiment.ts:331`), before exclusion and validation. Replay cards already use `dialogue.id` as the scenario id (`contracts.ts:423`), so no card identity changes. | None. |
| **A3. CLI `score` scales its budget like Pi** | Only Pi scales it (`agent-lab.ts:292-293`, applied at 360-364: calls, duration, `timeoutMs: 600_000`, `judge: DEFAULT_JUDGE`). CLI parses `task.json` with schema defaults (`cli.ts:288`): 300 calls, no judge override. | Add `scoreSettings(dialogueCount, supplied)` in `src/normalize.ts` and call it from both `cli.ts:288` and `agent-lab.ts:359-367`. Note that `reassess(..., {carryUsage: true})` shares one call budget across import, grounding, goals and judging (`experiment.ts:774`, `cli.ts:299`). | Changes `settings` for **new** CLI score records. The judge model becomes the Pi default, so `evaluatorVersion` changes (`pi.ts:77-78` includes `judgeModel`). Old CLI score records stay readable, but a new run is not comparable to them. This is intended: it aligns CLI with Pi. |
| **A4. Judge audits no longer bloat the record** | `assessTrial` copies the full audit onto the trial (`evaluation.ts:297`). The record is rewritten on every checkpoint (`experiment.ts:974-979`). `store.get` rejects files over 50 MB (`store.ts:100`). The HTML report also embeds the whole audit (`report.ts:89`) and the full trace (`report.ts:92`). The journal gets a full audit copy on *every* `save()` inside `assessRepeated` (`judge.ts:157-187` → `store.ts:132-138`). | Store the audit in a sidecar (`{id}.judge/{trialId}.json`, atomic, latest wins). Put a receipt `{protocolHash, inputHash, provider, model, configurationHash?, transport?, auditHash, votes:[{metricId,result}], complete}` on the trial. `complete` is computed by the existing `hasCompleteJudgment` at write time. Change `hasCompleteJudgment` to: full audit present → current check (legacy path); receipt only → `receipt.complete` && expected protocol hash && `inputHash === fingerprint(judgeInput(...))` (cheap, needs no raw replies). Update readers of `judgeAudit`: `comparison.ts:554-556`, `quality.ts:535`, `report.ts:89, 244`. Journal: append the audit once per finished vote, not on every `save()`. | `JUDGE_PROTOCOL` unchanged (storage, not protocol). `resultHash` changes for new records only. The trial schema gains an optional field (`contracts.ts:759`). **Forward-compat risk:** `trialSchema` is `strictObject`, so a Pi session still running the old `dist/` cannot read new records. |
| **A5. Repeat stability, unstable cards flagged** | `settings.repeats` exists (1-5). `repeatResults` already labels `mixed` (`comparison.ts:191-206`). `goalCardOutcome` turns any failed repeat into a failed card (`quality.ts:408-421`). | Show stability in two ways. (a) **Across runs** (recommended for the demo): repeat the same suite with the agent unchanged (equal `targetFingerprint`/`targetVersion`) and run `compareRuns`. Every `fixed`/`regressed` pair then marks an *unstable card*. Needs A1. (b) **Within a run**: `repeats > 1`, with `mixed` rows put into the view. | (a) none. (b) `settings` is fingerprinted: a `repeats: 3` run is **incomparable** with a `repeats: 1` run (`comparison.ts:546`). Choose one policy for the demo. |
| **A6. Owner confirms expectations on one screen** | `testPlanLines` handles exactly one card (`quality.ts:101-104`) and `acceptDraft` accepts exactly one (`experiment.ts:706-708`). For validate sets, the only expectation display is the confirm text in `runPlan` (`agent-lab.ts:48-53`). `start` never checks acceptance (`experiment.ts:873-903`). `updateDraft` refuses a change to `successCriteria` alone (`experiment.ts:666-668`), yet for validate cards (`checks: []`, fixed rubrics) `successCriteria` *is* what the judge applies (`judge.ts:48`). | Add `expectationSheet(record)` in `quality.ts`: per card, the goal, `successCriteria`, rule id, verbatim quote with source name, and `goalObservation`. Extend `acceptDraft` to N cards (the `acceptedTests` array already supports it). Add an opt-in `requireAccepted` check to `start`, so the Pi path enforces owner confirmation. Relax the `updateDraft` guard for cards whose only executable criterion is a rubric judged against `successCriteria`. | Acceptance fields are not in `draftHash` or `measurementHash` (`experiment.ts:34-48`). **Editing `successCriteria` changes the card fingerprint and the judge input**, so those cards become incomparable with earlier runs. This is correct, and the sheet should say so. |

### 2. Stronger judge output

| Part | Placement | Protocol impact |
|------|-----------|-----------------|
| **X → Y → rule N** (recommended path) | `src/explain.ts`: `failureExplanation(record, trial, metricId)`. X = `scenario.successCriteria` (validate cards derive it from owner requirements). Y = the first cited `assistant` event, with its stored `citations[].quote` (validated verbatim at `contracts.ts:590-596`). N = `scenario.requirementIds` → `requirement.text` + `quote` + source name (same path as `groundedScore`, `quality.ts:301-327`). If `promptQuotes` exists on the cluster (`experiment.ts:1116-1118`), add it. Replaces `firstReason` (`quality.ts:447-457`), which strips the "Совпало 2/2" prefix with a regex. | **None.** Old runs get the new explanation on read. |
| X → Y → N with a judge-named rule (optional) | Add `ruleId` and `expected` to `responseSchema` (`judge.ts:6-8`) and require them in `JUDGE_PROMPT` (`judge.ts:15-19`) and `ASSESS_ROLE` (`prompts.ts:56-64`). Validate `ruleId ∈ scenario.requirementIds` in `parseJudgment` (61-107). | **Bumps `JUDGE_PROTOCOL`** → `evaluatorVersion`. Consequences: `hasCompleteJudgment` fails for every earlier trial (`judge.ts:115`); `compareRuns` adds a protocol note (`comparison.ts:559-560`); drafts prepared earlier are refused by `start` until refreshed (`experiment.ts:890`; `updateDraft` recomputes at 690). |
| **Fewer "no decision"** | Four sources, verified. (1) the two votes disagree → unknown (`judge.ts:202-204`); (2) pass and fail conditions both met, or unclear (`judge.ts:69-70`); (3) one rejected vote on any non-RAG metric → `assessmentError` for the whole trial (`judge.ts:195`) → `measurementUsable` false (`outcomes.ts:75`); (4) **any** unresolved simulator flag or non-pass `user_fidelity` makes the card unusable (`outcomes.ts:62-71, 78`), so `goalCardOutcome` → unknown (`quality.ts:418`). Every validate card has `user_fidelity` (`contracts.ts:461`). | (1)-(3) are judge protocol: bump the version together with `hasCompleteJudgment` (attempt count `judge.ts:124`, the ≤24-attempt limit in `judgeAuditSchema`). (4) is interpretation in `outcomes.ts`: no hash changes, but **historical numbers change on read**. Put a "counting rules" version in `ResultView` so a changed number can be explained. First measure which source dominates on the pilot run (`fae4ee59`: 4 without a decision). |

### 3. One-key agree/disagree + agreement %

- **Key binding:** `extensions/cards.ts:372` already turns `p`/`n` into a whole-dialogue verdict. The note is a placeholder (`agent-lab.ts:792-798`).
- **Important:** a whole-dialogue verdict does **not** change the accuracy number. `goalCardOutcome` and `automaticTrialResult` read human verdicts only per metric (`outcomes.ts:35-38`, `quality.ts:419`). For disagreement to move accuracy, one-key must record a **metric-level** verdict on the failing primary metric (`goal_attainment`, else the first failed agent rubric): agree = the judge's result, disagree = the opposite. This also satisfies `awaitingVerdict`'s per-metric `decided` check (`comparison.ts:222-229`).
- **Agreement %:** add `judgeAgreement(record)` in `outcomes.ts`. Iterate over the latest metric-level human verdicts and compare each with `trial.assessments[].result`, the **original** judge result. Do not use `agentMetricResult`, because that already applies the human override. Also do not build the denominator from `isAgentFailure`: once a human disagrees, the trial is no longer a failure and would drop out of the denominator. Denominator: failures the human has reviewed. Target: ≥90% (PROJECT.md).
- **Schema:** reuse `humanReviewInputSchema` (`contracts.ts:626-632`). An optional `source: 'quick'` is enough to tell one-key verdicts from annotated ones. Human verdicts feed `resultHash` only, never `measurementHash`.
- **Surface:** the new Failures tab (board) and the verdict block (read-only agreement line).

### 4. One ResultView, four renderers

```
store ──► artifacts.evidenceBundle(record, store, {beforeId, productionId})
             │  resolves: before (store.get / embeddedBefore), production record,
             │            comparison = compareRuns(before, record),
             │            production = compareWithProduction(record, prod)
             ▼
          buildResultView(bundle, {now}) : ResultView        (pure, sync)
             │  reads qualitySummary + verdictSummary + judgeAgreement
             │  + failureExplanation + stability + progressView
             ▼
   ┌─────────────┬─────────────────┬──────────────────┬───────────────────┐
   │ chat block  │ board tabs      │ text summary     │ HTML (single file)│
   │ Pi msg      │ Итог · Провалы ·│ copy to          │ CSP as today,     │
   │ renderer    │ Диалоги ·       │ messenger/email; │ no audits, no raw │
   │             │ Сравнение       │ CLI `summary`    │ trace JSON        │
   └─────────────┴─────────────────┴──────────────────┴───────────────────┘
```

**Suggested `ResultView` shape** (all strings already in Russian, all external text still unescaped; each renderer escapes at its own boundary, as `report.ts:9-11` and `cards.ts:10-13` do today):

```typescript
export interface ResultView {
  runId: string; status: 'draft' | 'running' | 'done' | 'failed' | 'stopped';
  headline: { text: string; passed: number; decided: number; accuracy: number | null };   // one denominator
  notMeasured: { label: string; count: number; reason: string }[];                        // named, not "прочее"
  topCauses: { title: string; dialogues: number; explanation: FailureExplanation }[];    // ≤3
  failures: (FailureExplanation & { trialId: string; card: string; judge: 'fail';
             human?: 'agree' | 'disagree'; highlightSeqs: number[] })[];
  dialogues: { trialId: string; card: string; result: 'pass' | 'fail' | 'unknown' | 'invalid';
               turns: { seq: number; role: 'user' | 'agent' | 'error'; text: string }[] }[];
  agreement: { reviewed: number; agreed: number; rate: number | null; target: 0.9 };
  stability?: { compared: number; same: number; unstable: { card: string; runs: string[] }[] };
  comparison?: { headline: string; comparable: boolean; rows: {...}[]; reasons: string[] };
  production?: { test: Rate; prod: Rate; byRule: {...}[]; comparable: boolean; reasons: string[] };
  progress?: ProgressView;
  nextStep: string;
  scope: { cards: number; dialogues: number; synthetic: number; judge: string; costUsd: number | null; minutes: number };
  countingRules: string;   // version of the interpretation rules, see feature 2 (4)
}
export interface FailureExplanation {
  expected: string;                                  // X
  said: { quote: string; seq: number } | null;       // Y
  rule: { id: string; text: string; quote: string; source: string } | null;  // N
  judgeRationale: string;
}
```

Placement:

| Renderer | File | Integration point |
|----------|------|-------------------|
| Chat verdict block | NEW `extensions/render/verdict-block.ts` | Pi 0.85.1 exposes `registerMessageRenderer(customType, renderer)` (`pi-coding-agent/dist/core/extensions/types.d.ts:965`) and `sendMessage({customType, details, display})` (`:971`). After `agent_lab_run` / `score` / `review`, send `{customType: 'agent-lab-verdict', details: view, display: true}`. Replace the JSON-parsing `toolDisplay.renderResult` (`agent-lab.ts:20-38`) with a short line. |
| Board tabs | `extensions/cards.ts` | `Section` (`:37`) becomes `'summary' \| 'failures' \| 'dialogues' \| 'comparison'`, plus `'cards'` in review phase (expectations). Keys `1`-`4` (`:361`). The tab strip is at `:416-417`. `verdictLines` (`:186-255`) is replaced by `summaryLines(view)`. "From a failure, jump to the dialogue with the highlighted reply" = `failures[i].trialId` + `highlightSeqs` → the Dialogues tab. Split into `extensions/render/board-*.ts`: the file is already 529 lines. |
| Copyable text | NEW `src/render/text.ts` | Reused by CLI `summary` (`cli.ts:88-96`) and offered on the board (a `y` key copies it to the clipboard or saves it to a file). |
| Light HTML | NEW `src/render/html.ts` | Keep the CSP and escaping pattern of `report.ts:9-16, 166`. Do **not** embed `judgeAudit` or the full trace (`report.ts:89, 92`). `exportArtifacts` (`artifacts.ts:69-92`) writes it next to (or instead of) the full evidence report. |

`EvidenceBundle` (`artifacts.ts:10-20`) gains `production?` and `view`. `quality` stays for back-compat with the JSON snapshot.

### 5. Onboarding

| Part | Placement | Notes |
|------|-----------|-------|
| One-sentence start | Already present: `session_start` widget (`agent-lab.ts:153-159`), `before_agent_start` prompt (`:160-164`), `skills/agent-builder/SKILL.md`. | Mostly skill/prompt work. Auto-detecting the prompt and entry point is an LLM task in the conversation, not library code. |
| Visible checklist (agent → requirements → logs → connection → budget → run) | NEW `preparationChecklist(state)` in `src/progress.ts`. State is **derived**, not persisted: remembered connection (`connection.ts` `rememberedConnection`), latest draft (`store.list()`: `requirements.length`, `dialogues.length`, `validationExclusions`, `settings`, `phase`), doctor result. | Render with `ctx.ui.setWidget('agent-lab-start', lines)` (`types.d.ts:97`). Refresh on `pi.on('tool_execution_end')` (`types.d.ts:936`). `store.list()` parses every record, so A4 must land first, or the list gets slow and large. |
| One-minute demo | Today `/agent-lab demo` runs the **old sandbox tool-repair demo** (`demo.ts:22-29`, `agent-lab.ts:733-742`). It does not show the validate accuracy flow. | Recommended: ship a fixed pair of synthetic records (validation run + production score), built once with the demo runtime or by hand. Load them into a separate data dir and open the board on them, so the demo shows exactly the four renderers. Label them synthetic everywhere (memory rule: the synthetic share is always visible). |
| Live progress (done / time left / money) | NEW `progressView(record, now)` in `src/progress.ts`: `trials.length` / `plannedTrials(record)`; ETA = mean `trial.elapsedMs` × remaining ÷ `parallel`, starting from `record.reviewedAt`, which `start` sets (`experiment.ts:894`); money = `record.usage.costUsd` (updated live in `addUsage`, `experiment.ts:944-947`; `lab.get` returns the active in-memory clone, `:235`); cap = `settings.maxCalls` / `maxDurationMs`. | Consumers: `agent_lab_run` `onUpdate` (`agent-lab.ts:552-555`), build/score `onUpdate` (`:375-381`), board progress bar (`cards.ts:439-443`). The external agent's own cost is not in `usage` (`cards.ts:135` already says so), so label the money line "стоимость судьи и симулятора". |

### 6. Production dialogues scored by the same judge, shown next to the test

- **Reuse the existing path:** Pi `score` = `lab.score(codeOnly)` → `lab.score` → `lab.reassess(carryUsage)` (`agent-lab.ts:386-414`); the CLI does the same (`cli.ts:293-302`).
- **Gap: "same criteria".** `Lab.score` runs its own grounding (`experiment.ts:394-398`), so requirement ids and quotes can differ from the test run's. Add `score(input, { referenceRunId })`. It copies `requirements`, `sources` and judge settings (`settings.judge` / `roles.judge`) from the reference run, skips `runtime.prepare`, and passes `requirements` plus `requireApplicable: true` to `goals`. That applies the same testability exclusion as validate (`experiment.ts:332-337`). Persist `referenceRunId` on the score record. It is a new optional `experimentSchema` field, and not part of `measurementHash`.
- **Gap: denominators.** Apply `validationDialogueIssue` (`imports.ts`) and the `knowledge`-only testability filter to production too, and record exclusions in `validationExclusions`, so both sides count the same kind of dialogue.
- **Comparison:** NEW `compareWithProduction(test, prod)`. It is **unpaired**: goal accuracy on each side, accuracy per `requirementId`, failed rules present on both sides (keyed by requirement id, because `failureModes` names are LLM-generated per run and do not match across runs), and a guard. The comparison is valid only if the judge identities are equal (reuse the `judgeIdentities` logic, `comparison.ts:554-559`) and requirements and sources have the same fingerprint. It must also state the known asymmetries. Production cards have no simulator and no `user_fidelity`, so they are "decided" more often. The production replies come from whatever agent version was live. The test uses the replayed opening plus a simulator.
- **Throughput risk:** both the model-backed `score` loop (`experiment.ts:402-424`) and `reassess` (`:800-831`) handle dialogues **one after another**. Only the votes inside one dialogue run in parallel (`judge.ts:23`). At 200 dialogues, expect well over an hour. Add a bounded worker pool, as `runSuite` has (`experiment.ts:1020-1062`), or cap production at a sample (for example 50) for the demo.
- **Blocked by A4:** see the verdict above.

## Recommended Project Structure (additions only)

```
src/
├── normalize.ts        # NEW: normalizeScenario, harness goal ids, scoreSettings
├── explain.ts          # NEW: failureExplanation (X → Y → rule N), no model calls
├── result-view.ts      # NEW: buildResultView(bundle) → ResultView
├── progress.ts         # NEW: progressView, preparationChecklist
├── render/
│   ├── text.ts         # NEW: copyable summary (CLI summary uses it)
│   └── html.ts         # NEW: light single-file report
├── outcomes.ts         # + judgeAgreement
├── comparison.ts       # + compareWithProduction, stability rows; card identity via normalize
├── quality.ts          # + expectationSheet; firstReason → explain.ts
├── judge.ts            # hasCompleteJudgment: receipt path
├── store.ts            # audit sidecar read/write
└── artifacts.ts        # bundle gains production + view
extensions/
├── agent-lab.ts        # tools send ResultView; message renderer registration
├── cards.ts            # board shell + tabs (shrinks)
└── render/
    ├── verdict-block.ts
    ├── board-summary.ts · board-failures.ts · board-dialogues.ts · board-comparison.ts
    └── theme.ts        # shared colours, bars, alignment, wrap (the single "visual language")
```

### Structure Rationale

- **`result-view.ts` stays out of `quality.ts`.** `quality.ts` imports `draftHash` from `experiment.ts` (`quality.ts:5`), which pulls in the whole orchestrator. The view-model must import only analysis modules, so that the extension, the CLI and tests can load it cheaply and without import cycles.
- **`extensions/render/theme.ts`** gives the chat block, the board and the progress line one visual language (PROJECT.md requirement). Today bars exist twice (`quality.ts:556`, `report.ts:127`) and colours are chosen ad hoc in `cards.ts:65`.
- **`normalize.ts`** fixes the "default lives in five places" debt (CONCERNS.md) before new code adds a sixth.

## Architectural Patterns

### Pattern 1: Resolve asynchronously once, render synchronously many times
**What:** `evidenceBundle` (async, owns store access) → `buildResultView` (pure) → renderers (pure).
**When:** every surface. The board refresh (`cards.ts:291-311`, every 750 ms) already follows this through `options.load`.
**Trade-offs:** the bundle must carry every related record (before, production). Loading them costs one `store.get` each, which is acceptable after A4 slims the records.

### Pattern 2: Receipt on the record, evidence in a sidecar
**What:** the canonical record keeps small, hash-linked receipts. The bulky immutable evidence (judge audits) lives in append-only or atomic side files.
**When:** any per-trial artifact whose size grows with sources × votes.
**Trade-offs:** portable suites (`sourceEvidence`, `connection.ts suiteEvidence`) and embedded baselines (`artifacts.ts:23-39`) carry only receipts. Re-verifying raw replies then needs the original data dir.

```typescript
// judge.ts — keep the legacy path intact
export function hasCompleteJudgment(input: Input): boolean {
  const { judgeAudit: audit, judgeReceipt: receipt } = input.trial;
  if (audit) return legacyCompleteJudgment(input);          // current body, unchanged
  if (!receipt?.complete || input.trial.assessmentError) return false;
  if (receipt.protocolHash !== expectedProtocol(receipt.configurationHash)) return false;
  const applicable = assessmentRubrics(input.scenario, input.trial).filter(m => metricApplies(m, input.trial));
  return receipt.inputHash === fingerprint(judgeInput({ ...input, scenario: { ...input.scenario, metrics: applicable } }))
    && applicable.every(m => input.trial.assessments?.find(a => a.metricId === m.id)?.result
      === aggregateVotes(receipt.votes.filter(v => v.metricId === m.id)));
}
```

### Pattern 3: Normalize for identity, never rewrite stored evidence
**What:** defaults that exist only for interpretation are applied where identity is computed (`compareRuns`) and where new cards are made. Parsed legacy records are never rewritten.
**When:** `goalObservation`, and any future default.
**Trade-offs:** there are two views of a card (stored and normalized). Only `normalize.ts` may compute the normalized one.

### Pattern 4: Explanation derived from provenance, not requested from the model
**What:** "X → Y → rule N" is assembled from `successCriteria`, validated citations and verbatim requirement quotes.
**When:** by default. Ask the judge for a named rule only when the card has several `requirementIds` and the rule is ambiguous.
**Trade-offs:** when a card cites several rules, N may name more than one. Show them all, not a guess.

## Data Flow

### Run → verdict block (the main demo flow)

```
agent_lab_run (agent-lab.ts:528)
  → lab.start (experiment.ts:873) → runSuite (:996) → evaluateTrial → assessTrial
       → judge audit → sidecar + receipt (A4)          ← store.save per trial
  ↻ onUpdate every 750 ms: progressView(lab.get(id)) → "7/15 · ~4 мин · $0.84"
  → evidenceBundle(record, store)  → buildResultView → sendMessage('agent-lab-verdict', view)
  → registerMessageRenderer renders: headline · 3 causes (X→Y→N) · не измерено · next step
```

### Human agreement

```
board Failures tab → key a/d → BoardAction{type:'agree'|'disagree', trialId, metricId}
  → lab.addHumanReview({trialId, metricId, verdict: judge|opposite, source:'quick', note})
  → record.humanReviews (resultHash only)
  → judgeAgreement(record) → view.agreement → tab header "Согласие 12/13 (92%)"
  → disagree flips agentMetricResult → accuracy headline updates on next load
```

### Production next to test

```
score(prodDialogues, {referenceRunId: testRun})   (same requirements, judge, exclusions)
  → reassess (judge only) → prod record {referenceRunId}
evidenceBundle(testRun, store, {productionId}) → compareWithProduction(test, prod)
  → view.production → board tab 4 "Сравнение" + text summary + HTML section
```

## Build Order (dependencies)

```
Wave 0 (parallel, small, no shared files except where noted)
  A1 normalize + comparison identity      [normalize.ts, comparison.ts:551, experiment.ts defaults]
  A2 harness goal ids                     [experiment.ts:329-344]
  A3 shared scoreSettings                 [normalize.ts ⚠ shared with A1 → one owner or sequential; cli.ts, agent-lab.ts]
  A4 audit sidecar + receipt              [store.ts, evaluation.ts, judge.ts, contracts.ts, comparison.ts:554, quality.ts:535, report.ts:89]
      └── gate: live re-read of the pilot records + one live run under the size limit
Wave 1 (needs nothing from Wave 0 except A1 for stability)
  B1 explain.ts (X→Y→N)                   pure, protocol-neutral
  B2 judgeAgreement                       pure
  B3 progressView / preparationChecklist  pure
  B4 expectationSheet + acceptDraft(N) + start(requireAccepted) + updateDraft guard (A6)
Wave 2 (needs B1–B3)
  C1 ResultView + evidenceBundle extension
  C2 theme.ts + text renderer
Wave 3 (needs C1/C2; parallel across files)
  D1 chat verdict block (agent-lab.ts, render/verdict-block.ts)
  D2 board tabs + one-key agree (cards.ts, render/board-*.ts)
  D3 light HTML (render/html.ts, artifacts.ts)
  D4 live progress + checklist widgets (agent-lab.ts ⚠ shared with D1)
Wave 4 (needs A3, A4, C1)
  E1 score({referenceRunId}) + exclusions + worker pool
  E2 compareWithProduction + Comparison tab content + stability rows (needs A1)
Wave 5 (optional, isolated, do before final demo runs)
  F1 judge protocol v11 (named rule, retry/aggregation for fewer unknowns)
     → reassess the baseline test run and the prod run under v11 (no agent run)
Wave 6
  G1 one-minute demo fixture (needs D1–D3 and E2 so it shows everything)
```

**Parallelism notes:**
- `extensions/agent-lab.ts` (844 lines) is touched by A3, D1, D4 and E1. Serialize those edits, or split the file first (tool registrations → `extensions/tools/*.ts`).
- `src/experiment.ts` (1175 lines) is touched by A1, A2, A6 and E1. CONCERNS.md already recommends splitting it by workflow. Do at least `score`/`reassess` → `src/workflows/score.ts` before E1.
- The Pi extension imports `dist/` (`agent-lab.ts:8-17`). Any schema change (A4, the E1 `referenceRunId`) must be built and the live Pi session restarted before new records are written. Otherwise an old reader fails on the strict schema.

**Ordering vs customer importance:** PROJECT.md orders phases by what the customer sees. The dependency graph makes A4 and C1 hard prerequisites for the visible features (verdict block, board, production). Put them in the first phase, even though they are invisible.

## Fingerprint / protocol impact summary

| Change | `draftHash` | `measurementHash` | `evaluatorVersion` / `JUDGE_PROTOCOL` | `resultHash` | Effect on comparing with earlier runs |
|--------|-------------|-------------------|---------------------------------------|--------------|----------------------------------------|
| A1 comparison-time normalization | – | – | – | – | Restores comparability (intended) |
| A1 replacing scattered defaults | only if a default *changes* | same | – | – | None, provided the value stays `'reply'` |
| A2 goal ids | – | – | – | – | None (scenario id = dialogue id already) |
| A3 score settings | new records | new records | judge model → **yes** for CLI score | – | New CLI score ≠ old CLI score |
| A4 audit sidecar | – | – | – | new records | None, if the receipt check stays equivalent |
| A5 within-run repeats | settings | settings | – | – | `repeats` differs → incomparable |
| A6 edit `successCriteria` | yes | yes | – | – | Edited cards incomparable (intended) |
| A6 acceptance / requireAccepted | – | – | – | – | None |
| B1 derived explanation | – | – | – | – | None |
| One-key verdicts | – | – | – | yes | Numbers move only on disagree (by design) |
| Outcome-interpretation change (fewer unknowns via `outcomes.ts`) | – | – | – | – | Historical numbers change on read; add `countingRules` |
| F1 judge prompt/schema/retry | – | via evaluatorVersion | **yes** | – | All prior runs incomparable until re-assessed; old drafts refused by `start` |
| E1 `referenceRunId`, reused requirements | new score records | new score records | – | – | Score records before E1 cannot claim "same criteria" |

## Scaling Considerations

| Scale | What breaks first | Adjustment |
|-------|-------------------|------------|
| 15 cards, 1 run (demo) | Nothing in storage. The first screen is unclear | C1/D1 |
| 50-200 production dialogues | Record size (A4), sequential score and reassess loops, CLI budget (A3) | A4, worker pool in E1, `scoreSettings` |
| Many runs in one data dir | `store.list()` parses every record fully (board list, checklist) | A4 first; later an index file of `{id, phase, task, createdAt}` |
| 16 parallel dialogues × 8 judge votes | 128 concurrent judge requests, no shared limiter (CONCERNS.md) | Shared per-provider limiter. Keep `parallel` out of hashes (it already is, `experiment.ts:872`) |

## Anti-Patterns

### Anti-Pattern 1: Renderer computes its own numbers
**What people do:** a surface builds a headline from `qualitySummary` fields plus its own filters. See `cards.ts:419-425` (review counts), `report.ts:156` (attention list), `agent-lab.ts:34`.
**Why it's wrong:** the chat block, board and HTML disagree, and the "several denominators" problem in PROJECT.md comes back.
**Do this instead:** every count on screen comes from `ResultView`. Add a test that the text, board and HTML renderers show the same headline for one fixture.

### Anti-Pattern 2: Normalizing legacy records at parse time
**What people do:** add `.default('reply')` or a transform to `scenarioSchema.goalObservation`.
**Why it's wrong:** `hasCompleteJudgment` recomputes the judge input from the parsed card (`judge.ts:120-121`). The input hash stops matching and every legacy trial becomes "judge unaudited". `acceptedTests.definitionHash` (`experiment.ts:53-59`) also stops matching.
**Do this instead:** Pattern 3.

### Anti-Pattern 3: Changing judge wording "just a little"
**What people do:** tweak `JUDGE_PROMPT`, `ASSESS_ROLE` or the response schema to get better explanations.
**Why it's wrong:** `JUDGE_PROTOCOL` fingerprints the whole prompt and format (`judge.ts:20`), and `evaluatorVersion` includes `ASSESS_ROLE` indirectly (through `JUDGE_PROMPT`) and `SIMULATOR_ROLE` directly (`pi.ts:77`). One word makes all earlier runs incomparable and blocks `start` on existing drafts.
**Do this instead:** derive explanations (B1). Batch any protocol change into F1, followed by planned re-assessments.

### Anti-Pattern 4: Using `compareRuns` for production vs test
**What people do:** call `compareRuns(testRun, scoreRun)`.
**Why it's wrong:** the card sets, settings, sources and workflow shape differ, so the result is always "Прогоны несравнимы" (`comparison.ts:561-566`).
**Do this instead:** use the unpaired `compareWithProduction`, with its own explicit comparability guard.

### Anti-Pattern 5: Counting agreement after the override
**What people do:** agreement = `agentMetricResult(...) === human verdict`.
**Why it's wrong:** `agentMetricResult` already returns the human verdict (`outcomes.ts:35-38`), so agreement is always 100%.
**Do this instead:** compare with `trial.assessments[].result` (the original judge) or with `judgeReceipt.votes`.

## Integration Points

### External / platform

| Service | Integration | Notes |
|---------|-------------|-------|
| Pi SDK 0.85.1 | `registerMessageRenderer`, `sendMessage`, `ui.setWidget`, `ui.custom`, `on('tool_execution_end')` | All present in `dist/core/extensions/types.d.ts` (lines 97, 936, 965, 971). Visual behaviour of message renderers inside the chat needs one live check. |
| Judge (OpenRouter `openai/gpt-5.6-sol`) | Unchanged, through `pi.ts:703` → `assessRepeated` | Default reasoning model: temperature stays at the provider default (`judge.ts:20`), so repeat stability depends on the model. |
| Browser (HTML report) | `open`/`xdg-open` (`agent-lab.ts:828-832`) | Keep the CSP with a single hashed script. |

### Internal boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| extension ↔ library | Imports from `../dist/*` | A build is required. Never run the build in the live worktree (it deletes `dist/`). |
| surfaces ↔ view-model | `ResultView` in tool `details` / message `details` | Renderers must not import `quality.ts` or `comparison.ts` directly |
| view-model ↔ analysis | Pure function calls | No I/O and no `experiment.ts` import |
| artifacts ↔ store | `get`, `traceJournal`, NEW `getAudit` | The only async assembly point |
| experiment ↔ store | `save` per checkpoint; `appendTrace` / `appendJudgment` | A4 changes the `save` payload and the journal cadence |

## Sources

- Source code at HEAD `628ff25` (same `src/`, `extensions/` as `015fee9`): `src/experiment.ts`, `src/quality.ts`, `src/outcomes.ts`, `src/comparison.ts`, `src/judge.ts`, `src/evaluation.ts`, `src/report.ts`, `src/artifacts.ts`, `src/store.ts`, `src/contracts.ts`, `src/pi.ts`, `src/prompts.ts`, `src/demo.ts`, `src/cli.ts`, `extensions/agent-lab.ts`, `extensions/cards.ts`. HIGH.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` (Pi 0.85.1 extension API). HIGH for existence; MEDIUM for rendering behaviour (not exercised).
- `.planning/PROJECT.md`, `.planning/codebase/ARCHITECTURE.md`, `STRUCTURE.md`, `CONCERNS.md` (2026-09-16). Every CONCERNS.md claim used above was re-checked in the source.

---
*Architecture research for: Agent Lab trust + result UX milestone (demo 2026-09-21)*
*Researched: 2026-09-16*
