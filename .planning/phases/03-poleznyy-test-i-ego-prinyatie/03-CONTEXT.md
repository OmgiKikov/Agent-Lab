# Phase 3: Полезный тест и его принятие - Context

**Gathered:** 2026-09-15
**Status:** Ready for planning
**Mode:** Autonomous — decisions taken from the user's approved core scenario

<domain>
## Phase Boundary

Find one useful, evidence-grounded test from a large recorded-dialogue batch, turn the owner's confirmed hypothesis into one compact business-scenario test, show its situation, input, success criterion and explicit observation channel, and let the owner accept or edit that exact test. This phase stops before running the accepted test on the target.

</domain>

<decisions>
## Implementation Decisions

### Test acceptance
- Acceptance applies to the test definition, not to an automatic or human verdict about a run result.
- Bind acceptance to the exact draft hash/version so any later edit invalidates it.
- Acceptance and execution are different actions. Add one explicit `agent_lab_accept` / CLI `accept --id --yes` surface; keep `agent_lab_run` / CLI `run` for the later execution of an already accepted hash.
- `saveSuite()` and every regression-storage path reject a draft that has not been explicitly accepted.
- Declining acceptance leaves an editable draft and performs no target run or regression save.

### Large-log discovery
- Keep detailed `score` as the honest evaluator of a preselected validation set; never report discovery's suspicious subset as production accuracy.
- Accept at most 300 JSON/JSONL dialogues under the existing 4 MB file and 2,000,000-character corpus limits. Agent Lab does not fetch external logs in this MVP.
- Coarse-triage complete dialogues in batches of at most 25 and 60,000 serialized characters. Keep short validated observations plus dialogue/event citations; never pass stored outcomes as labels.
- Choose one recurring signal backed by at least two dialogues, then deterministically select at most three representatives and two controls outside the signal. Persist the seed and exact IDs.
- Deep goal extraction and two-vote judging run only on those five or fewer full dialogues. Controls probe false negatives but do not make the sample representative.
- The first screen states `отбор, не accuracy`, total coverage, selected examples/controls, one grounded hypothesis and `Проверим?`; budget exhaustion and partial results remain explicit errors/states.

### Observation semantics
- Add one typed owner-confirmed `goalObservation: reply | tool | state` to the test definition and therefore its draft hash. Do not infer it from keywords or let the model choose it.
- `reply` permits semantic `goal_attainment` from cited assistant replies for informational/RAG goals. `tool` requires a cited successful tool result; `state` requires the observed state predicate. Missing/legacy channel remains conservative `unknown`.
- After the owner confirms the discovery hypothesis, reuse the existing `confirmedHypothesis` generation path to build exactly one test; do not add a hypothesis database or another generator.

### Minimal test contract
- Show one situation, the user's opening/input, non-empty `successCriteria`, and the evidence/observation channel available to verify it.
- Generated tests contain exactly one agent-authored reserved rubric `goal_attainment`, derived from `successCriteria`.
- The harness adds `prompt_compliance` only when a prompt exists and `user_fidelity` only for simulator runs; owners add any extra rubric explicitly through `agent_lab_edit`.
- Keep `initialState` compatible in storage but omit it from the user-facing test when it is empty or unnecessary.

### Grounding and repair
- Confirmed values from `answers[].reply` may be added to `knows` only by deterministic case-insensitive full-token matching against owner materials/dialogue evidence.
- Unsupported values or a result exceeding the existing limit of 20 return the test to repair; never truncate silently.
- Code, assistant answers and logged outcomes remain observations, not the expected answer.

### Product language and editing
- In the main conversation call the object a `тест`; in the stored contract use `карточка бизнес-сценария` / `business-scenario card`.
- Reuse `ExperimentLab.updateDraft()`, optimistic draft hashes and `agent_lab_edit`; do not restore the removed TUI editor, preview or clarify flows.
- Present the test compactly in the current Pi/CLI flow; no new dashboard, modal, queue or persisted hypothesis subsystem.

### the agent's Discretion
- The smallest backward-compatible fields needed to record acceptance of a specific draft.
- Exact compact Russian copy for accept/edit/invalidated-after-edit states.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `Scenario`, `checks`, `metrics` and `successCriteria` already represent the test definition in `src/contracts.ts`.
- `ExperimentLab.updateDraft()` already enforces optimistic draft hashes for edits.
- `agent_lab_edit` is the surviving conversational edit surface.
- `agent_lab_run` already renders and executes a plan after native confirmation; preserve that execution meaning and add a separate accept-only action.
- `saveSuite()` / `loadSuite()` already provide portable regression storage.
- `quality.metricRows()` already merges only identical metric definitions.

### Established Patterns
- Lifecycle mutations go through `ExperimentLab` and persisted records remain backward-compatible through optional fields.
- The harness, not the generator, owns service rubrics.
- Validation rejects invalid generated output and uses bounded repair instead of silent coercion.

### Integration Points
- Store acceptance against the current draft hash in the existing experiment aggregate.
- Invalidate acceptance in `updateDraft()` and any path that changes scenario semantics.
- Add a separate accept-only surface; `ExperimentLab.start()` later rejects every `evaluate` record whose accepted hash is absent or stale, before preflight or spending.
- Gate `saveSuite()` on the same acceptance check.
- Tighten generation/post-processing around reserved rubrics and deterministic `answers[].reply` enrichment.
- Update current user-facing strings and docs from `user card` terminology to `business-scenario card` where the live contract is meant.

</code_context>

<specifics>
## Specific Ideas

The user decision is the last step before execution: `Да, этот тест действительно проверяет нужное поведение` or a concrete edit such as `Здесь уточнение допустимо, исправь критерий`. Only the resulting accepted version can later run and enter regression storage.

</specifics>

<deferred>
## Deferred Ideas

- Real TargetSession execution and evidence presentation belong to Phase 4.
- Rerun comparison and P1–P3 measurement belong to Phase 5.
- Manual verdicts about disputed run results remain the Phase 1 support path, not test acceptance.

</deferred>
