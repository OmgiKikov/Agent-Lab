# Phase 2: Понимание агента и гипотеза - Context

**Gathered:** 2026-09-15
**Status:** Ready for planning
**Mode:** Autonomous — decisions taken from the user's approved core scenario

<domain>
## Phase Boundary

Agent Lab reads the repository, owner-provided requirements and available JSON/JSONL dialogues, separates expected behavior from observed behavior and unknowns, then proposes one grounded, testable failure hypothesis for the owner to confirm. This phase stops before constructing or running the new test.

</domain>

<decisions>
## Implementation Decisions

### Sources of truth
- Owner requirements, specs and explicitly supplied materials define expected behavior.
- Existing code, previous agent answers and logged outcomes are observations only; they may be wrong and must never silently become the expected answer.
- Every summary must visibly separate `Требования`, `Наблюдаемое` and `Неизвестно`.
- Claims about completed actions count only when an observable effect exists; otherwise the action remains `unknown`/`unclear` even if the agent says it succeeded.

### Imported evidence
- Reuse the existing JSON/JSONL reader, dialogue, scenario, trial and trace-event contracts instead of introducing a second ingestion model.
- Preserve each recorded dialogue one-to-one and keep source event order.
- Score mode never runs the target agent or simulator; `--code-only` must also avoid model calls.
- Response quality is evaluated separately from goal attainment and observable action effects.

### Hypothesis proposal
- Propose exactly one useful hypothesis at a time, before building a test.
- The proposal names the requirement and the concrete repository/log observation that motivated it, then asks the owner: `Проверим?`
- Logs are evidence for choosing a hypothesis, not automatically accepted ground truth or a mandatory manual-labeling queue.
- No new persisted hypothesis workflow is needed in this phase; use the existing conversation/skill surface and existing experiment contracts until the owner confirms the hypothesis.

### Product surface
- Keep CLI, Pi extension and skill behavior aligned around the same offline score and evidence path.
- The first useful output is compact and conversational, not a report dashboard: expected/current/unknown followed by the proposed check.
- Detailed cards, failure clusters and exported artifacts remain available as supporting evidence, not the primary interaction.

### the agent's Discretion
- Exact Russian copy, compact formatting and placement inside existing CLI/Pi surfaces.
- The smallest internal helper boundaries needed to keep conversion and scoring testable.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/imports.ts::readData()` already reads validated JSON/JSONL with limits.
- `src/contracts.ts` already owns `Dialogue`, `Scenario`, `Trial`, `TraceEvent` and prompt-compliance contracts.
- `src/experiment.ts::reassess()` already re-evaluates without target or simulator calls; `nameFailureModes()` can classify the resulting evidence.
- `src/judge.ts::judgeInput()` already hides unobserved final state.
- `src/quality.ts`, `src/artifacts.ts` and `src/report.ts` already render grounded summaries and evidence.

### Established Patterns
- `ExperimentLab` is the single application-service boundary for lifecycle changes.
- Zod schemas validate all external input; persisted JSON/JSONL evidence is append-only and ordered.
- CLI and Pi extension delegate to the same domain/orchestration functions.

### Integration Points
- Add reserved `goalAttainment` and `replyQuality` metrics plus dialogue-to-scenario/trial conversion beside existing domain contracts.
- Add offline `ExperimentLab.score()` by composing import, reassessment, failure-mode naming and existing artifact generation.
- Expose the same operation through CLI `score` and `agent_lab_build` with `mode: "score"`.
- Update the project skill/prompt so repository and log study produces the three-part summary and grounded `Проверим?` proposal before any test construction.

</code_context>

<specifics>
## Specific Ideas

The core interaction is: `прочитай моего агента → предложи полезный тест → покажи доказательства → сохрани проверку`. For this phase, the visible endpoint is the grounded proposal: for example, `Требование говорит не выдумывать при неполных данных; в диалоге X ответ содержит неподтверждённый факт. Похоже, агент додумывает ответ. Проверим?`

</specifics>

<deferred>
## Deferred Ideas

- Building and owner-editing the test belongs to Phase 3.
- Running the accepted test on the real target and displaying proof belongs to Phase 4.
- Saving and rerunning the accepted test as a regression belongs to Phase 5.

</deferred>
