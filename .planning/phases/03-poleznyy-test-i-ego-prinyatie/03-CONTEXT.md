# Phase 3: Полезный тест и его принятие - Context

**Gathered:** 2026-09-15
**Status:** Ready for planning
**Mode:** Autonomous — decisions taken from the user's approved core scenario

<domain>
## Phase Boundary

Turn the owner's confirmed hypothesis into one compact business-scenario test, show its situation, input, success criterion and available observation before execution, and let the owner accept or edit that exact test. This phase stops before running the accepted test on the target.

</domain>

<decisions>
## Implementation Decisions

### Test acceptance
- Acceptance applies to the test definition, not to an automatic or human verdict about a run result.
- Bind acceptance to the exact draft hash/version so any later edit invalidates it.
- The existing pre-run native confirmation may serve as explicit acceptance when it shows the exact plan being accepted; do not add a second ceremony.
- `saveSuite()` and every regression-storage path reject a draft that has not been explicitly accepted.
- Declining acceptance leaves an editable draft and performs no target run or regression save.

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
- `agent_lab_run` already renders the exact plan and asks for native confirmation.
- `saveSuite()` / `loadSuite()` already provide portable regression storage.
- `quality.metricRows()` already merges only identical metric definitions.

### Established Patterns
- Lifecycle mutations go through `ExperimentLab` and persisted records remain backward-compatible through optional fields.
- The harness, not the generator, owns service rubrics.
- Validation rejects invalid generated output and uses bounded repair instead of silent coercion.

### Integration Points
- Store acceptance against the current draft hash in the existing experiment aggregate.
- Invalidate acceptance in `updateDraft()` and any path that changes scenario semantics.
- Make the existing run confirmation accept the shown draft before the later Phase 4 execution path.
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
