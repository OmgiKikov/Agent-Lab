# Phase 3: Полезный тест и его принятие - Research

**Researched:** 2026-09-15
**Domain:** exact-draft test acceptance, business-scenario normalization, terminal interaction
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

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

### Deferred Ideas (OUT OF SCOPE)
- Real TargetSession execution and evidence presentation belong to Phase 4.
- Rerun comparison and P1–P3 measurement belong to Phase 5.
- Manual verdicts about disputed run results remain the Phase 1 support path, not test acceptance.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LOOP-04 | Для принятой гипотезы Agent Lab собирает минимальный тест с ситуацией, входными данными, критерием успеха и доступным способом наблюдения результата. | Compact test projection and observation-channel derivation. |
| LOOP-05 | Пользователь принимает или правит сам тест; только явно принятый тест попадает в сохранённый регрессионный набор. | Exact-draft acceptance marker, mutation guard, invalidation matrix and suite gate. |
| CARD-01 | Генерируемая карточка хранит `goal`, `facts`, `knows`, `opening`, `answers`, непустой `successCriteria` и только при необходимости `initialState` с точными проверками. | Existing `Scenario` schema plus stricter generated-card validation. |
| CARD-02 | Генерируемая внешняя карточка несёт ровно одну агентскую рубрику `goal_attainment`, построенную из её `successCriteria`, без подмены цели рубрикой тона или формата. | Deterministic reserved-rubric normalization for every generated card. |
| CARD-03 | Harness добавляет `prompt_compliance` только при наличии промпта и `user_fidelity` для симуляции; дополнительные рубрики создаёт только владелец через `agent_lab_edit`. | Separate generator-owned rubric from harness decoration and owner edits. |
| CARD-04 | Все значения из `answers[].reply` добавляются в `knows` без модельного раунда только при полном токенном совпадении с источником без учёта регистра; неподтверждённое значение или переполнение лимита 20 возвращает карточку на починку без молчаливого обрезания. | Reuse `valueTokens()` and bounded `jsonResponse()` repair against owner evidence only. |
| CARD-05 | Первый экран объединяет каждую зарезервированную рубрику `goal_attainment`, `prompt_compliance` и `reply_quality` в одну строку на прогон, а владельческие рубрики объединяет только при полном совпадении определения. | Reserved-ID row key with fingerprint fallback. |
| CARD-06 | Во всех текущих пользовательских строках и документации используется термин «карточка бизнес-сценария» / `business-scenario card`, а не «карточка пользователя». | Context-sensitive terminology inventory; main conversation remains `тест`. |
</phase_requirements>

## Summary

Phase 3 does not need a new approval subsystem. The current aggregate already has a complete semantic version function, `draftHash(record)`, whose input is the test-defining task, sources, requirements, scenarios, agent, target and evaluator configuration. The existing edit path checks that full hash before mutation and already clears review metadata. [VERIFIED: src/experiment.ts:27-32] [VERIFIED: src/experiment.ts:189-234] The smallest compatible representation is therefore one optional experiment field containing the accepted full draft hash; it must not itself participate in `draftHash`, and its absence in old JSON means “not accepted.” The existing schema already demonstrates backward-compatible optional fields such as `resultsReviewedAt?: string`, `targetVersion?: string` and `evaluatorVersion?: string`. [VERIFIED: src/contracts.ts:501-515] [VERIFIED: src/contracts.ts:595-602]

Acceptance should be one serialized `ExperimentLab` mutation, using the existing `change()` seam and optimistic expected hash. [VERIFIED: src/experiment.ts:98-108] It validates the one visible test, records the exact current hash, and performs no execution. `updateDraft`, `freshDraft`, load/repeat/reassess and any other path that creates or changes a draft must clear the marker; `saveSuite` must compare it to the current `draftHash` before exporting. Current `saveSuite()` checks only workflow, non-empty scenarios and non-running state, so an unaccepted draft can presently be exported. [VERIFIED: src/experiment.ts:251-260]

The generation work is also normalization, not a new pipeline: reuse `Scenario`, `valueTokens`, the bounded repair callback, the existing harness rubrics, `metricRows`, `agent_lab_edit`, native Pi confirmation and CLI `--yes`. The source plan’s Tasks 8–10 contain useful fragments, but they do not cover acceptance at all; Task 8 scopes normalization too narrowly, Task 9 omits dialogue evidence, and Task 10’s blanket terminology replacement conflicts with the locked rule that the main conversation says `тест`. [VERIFIED: docs/superpowers/plans/2026-09-15-mvp-cut.md:755-872] [VERIFIED: docs/superpowers/plans/2026-09-15-mvp-cut.md:876-949] [VERIFIED: docs/superpowers/plans/2026-09-15-mvp-cut.md:953-983]

**Primary recommendation:** add one optional exact-draft acceptance hash to `Experiment`, mutate it through `ExperimentLab`, project the existing `Scenario` into one shared safe compact test block, and tighten existing normalization/repair rather than introducing any subsystem or dependency.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Generated-card normalization | API / Backend (`src/pi.ts`, `src/contracts.ts`) | — | Model output is validated and repaired before it becomes stored state. [VERIFIED: src/pi.ts:32-42] [VERIFIED: src/pi.ts:305-339] |
| Exact-draft acceptance | API / Backend (`ExperimentLab`) | Pi/CLI adapters | The aggregate owns mutation and persistence; adapters only show and confirm the projected draft. [VERIFIED: src/experiment.ts:98-108] [VERIFIED: extensions/agent-lab.ts:40-53] |
| Compact test presentation | Pi/CLI adapter | Existing terminal safety helper | Both surfaces must render the same semantic projection; Pi already sanitizes external text with `safeText`. [VERIFIED: extensions/agent-lab.ts:40-53] |
| Regression export gate | API / Backend (`saveSuite`) | Filesystem storage | Authorization must be checked immediately before the existing exclusive file write. [VERIFIED: src/experiment.ts:251-260] |
| Quality-row merge | Reporting (`src/quality.ts`) | Stored rubric contract | Current grouping uses the full rubric fingerprint, which is correct only for owner-defined rubrics. [VERIFIED: src/quality.ts:58-83] |

## Standard Stack

### Core

| Library / facility | Version | Purpose | Why Standard Here |
|--------------------|---------|---------|-------------------|
| Existing TypeScript/Node runtime | Node `>=22.19.0`; TypeScript `^5.9.3` | Aggregate mutations, hashing and terminal adapters | Already required by the repository; no replacement is needed. [VERIFIED: package.json:7-9] [VERIFIED: package.json:45-49] |
| Existing `zod` schema layer | `4.5.4` | Backward-compatible experiment/card parsing and generated-output validation | The project’s strict schemas already bound all affected records. [VERIFIED: package.json:39-44] [VERIFIED: src/contracts.ts:232-243] |
| Existing Pi libraries | `@earendil-works/pi-coding-agent` `0.85.1`; `@earendil-works/pi-tui` `0.85.1` | Native confirmation and terminal UI | Locked UI contract explicitly reuses the installed host surface. [VERIFIED: package.json:39-43] [VERIFIED: .planning/phases/03-poleznyy-test-i-ego-prinyatie/03-UI-SPEC.md:19-27] |
| Node `crypto` + existing `fingerprint`/`draftHash` | repository code | Exact semantic draft identity | It already hashes every relevant test-definition input and avoids a second versioning mechanism. [VERIFIED: src/contracts.ts:1-1] [VERIFIED: src/experiment.ts:27-32] |

### Supporting

| Facility | Purpose | When to Use |
|----------|---------|-------------|
| `ExperimentLab.change()` | Serialize state mutations | Accept, edit and any acceptance-sensitive persistence path. [VERIFIED: src/experiment.ts:98-108] |
| `valueTokens()` | Deterministic case-insensitive value-token grounding | For every value-bearing token in every `answers[].reply`. Its implemented rule lowercases full regex tokens, requires a digit and length at least three. [VERIFIED: src/contracts.ts:11-25] |
| `jsonResponse()` repair callback | Reject invalid model output and request a full corrected object | Grounding, rubric and observation-contract errors; it is bounded by the exact constant `REPAIR_ATTEMPTS = 5`. [VERIFIED: src/pi.ts:296-339] |
| `safeText()` | Sanitize externally supplied terminal text | Every value inserted into the shared Pi/CLI acceptance block. [VERIFIED: extensions/agent-lab.ts:40-53] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| One optional accepted hash | Approval table/state machine | Rejected: creates persistence and lifecycle machinery for a one-value invariant. |
| Existing native confirm and CLI `--yes` | New modal, checkbox, interactive CLI or command | Rejected by the locked interaction contract. [VERIFIED: .planning/phases/03-poleznyy-test-i-ego-prinyatie/03-UI-SPEC.md:131-140] |
| Existing repair loop | Silent filtering/truncation | Rejected because it can turn an invalid proposed test into a different accepted test. |

**Installation:** none. This phase adds no external package.

## Package Legitimacy Audit

Not applicable: the prescribed implementation installs no package and reuses only dependencies already declared in `package.json`. [VERIFIED: package.json:39-49]

## Architecture Patterns

### System Architecture Diagram

```text
owner materials + confirmed hypothesis + user dialogue evidence
                          |
                          v
                existing Pi preparation
                          |
               schema + semantic review
               /          |           \
      invalid/unsupported |            valid one Scenario
             |            |                   |
             +--> bounded repair <-------------+
                                             |
                                             v
                              shared compact test projection
                              situation / input / success /
                              concrete observation / draftHash
                                             |
                                     accept or edit?
                                   /                 \
                           edit + expectedHash       accept + expectedHash
                                  |                         |
                           updateDraft()              accepted hash stored
                           clears acceptance          no target execution
                                  |                         |
                                  +------ re-render --------+
                                             |
                                  saveSuite checks exact match
                                             |
                                      regression JSON
```

The execution boundary remains downstream: the UI contract says Phase 3 confirmation neither opens `TargetSession`, runs a simulator nor saves a suite. [VERIFIED: .planning/phases/03-poleznyy-test-i-ego-prinyatie/03-UI-SPEC.md:131-140]

### Recommended Project Structure

```text
src/contracts.ts             # optional compatibility field; Scenario/rubric invariants
src/experiment.ts            # accept mutation, invalidation and save guard
src/pi.ts                    # generated-card semantic normalization and repair
src/quality.ts               # reserved-rubric aggregation rule
src/cli.ts                   # same compact block and --yes acceptance
extensions/agent-lab.ts      # Pi rendering, native confirm, agent_lab_edit reuse
test/contracts.test.ts       # schema and generated-card contract
test/experiment.test.ts      # acceptance lifecycle and suite guard
test/pi.test.ts              # repair, grounding and rubric generation
test/quality.test.ts         # reserved versus owner row grouping
test/extension.test.ts       # Pi copy, sanitization and no-run behavior
test/workflow.test.ts        # CLI acceptance behavior
```

This mapping stays inside existing modules and test suites; the repository’s scripts already build with `tsc` and run `tsx --test test/*.test.ts`. [VERIFIED: package.json:30-37]

### Pattern 1: Exact-Draft Capability Marker

**What:** Record a single optional full hash of the accepted draft. Do not add the marker to `draftHash`; equality is the invariant. Accept only inside `ExperimentLab.change()`, after checking phase, one-card presentability and `expectedHash === draftHash(record)`. The existing phase vocabulary is quoted verbatim as `'preparing' | 'review' | 'evaluating' | 'results_review' | 'baseline' | 'improving' | 'control' | 'complete' | 'cancelled' | 'error' | 'interrupted'`. [VERIFIED: src/contracts.ts:490-491]

**When to use:** before regression export and, in the later execution phase, immediately after the existing confirmation has shown the exact same hash.

**Why separate from review metadata:** `reviewedAt` / `reviewMode` already cover both `'human' | 'automated' | null`, and reassessment/start assign them for other meanings; overloading them cannot prove that this exact test definition was explicitly accepted. [VERIFIED: src/contracts.ts:498-500] [VERIFIED: src/experiment.ts:384-410]

### Pattern 2: Invalidation by Construction

Clear the marker whenever a draft is semantically changed or freshly derived:

| Path | Required action | Evidence |
|------|-----------------|----------|
| `updateDraft` | Clear after successful validation and before checkpoint/save | Its patch can change scenarios, removals, profiles, agent, settings, target and target version; it recomputes evaluator/target fingerprints. [VERIFIED: src/contracts.ts:470-481] [VERIFIED: src/experiment.ts:189-234] |
| `freshDraft` | Clear unconditionally | It creates a new id and already clears trials, reviews, `reviewedAt`, `reviewMode` and `manifestHash`. [VERIFIED: src/experiment.ts:46-63] |
| `repeat`, `loadSuite`, `reassess` | Inherit the `freshDraft` reset; do not restore approval | All three create a new draft through that helper. [VERIFIED: src/experiment.ts:238-249] [VERIFIED: src/experiment.ts:262-288] |
| old stored JSON | Missing optional marker means unaccepted | The experiment schema already accepts optional compatibility fields. [VERIFIED: src/contracts.ts:595-602] |
| stale edit/accept request | Reject without mutation | Existing edit checks current hash before parsing/applying the patch. [VERIFIED: src/experiment.ts:189-194] |

Gate `saveSuite` against the source record before calling `freshDraft`, so the exported definition remains a portable unapproved draft when loaded later while only an accepted source version can enter regression storage.

### Pattern 3: One Semantic Projection, Two Terminal Adapters

Build one pure compact projection from the single selected `Scenario` and `draftHash`; Pi and CLI render that projection with their native formatting. The exact visible labels are quoted verbatim: `ТЕСТ`, `СИТУАЦИЯ`, `ВХОД`, `УСПЕХ`, `НАБЛЮДЕНИЕ`, and `Версия: <первые 12 символов draftHash>`. [VERIFIED: .planning/phases/03-poleznyy-test-i-ego-prinyatie/03-UI-SPEC.md:104-123]

Derive the observation label from existing executable checks rather than inventing a new `Scenario` field:

- assistant transcript for answer checks or semantic rubrics;
- tool call/result trace for `tool_called`, `tool_not_called`, `tool_count` and `fresh_read_before_update`;
- final state snapshot for `state_equals` or necessary non-empty state.

Those exact check branches already grade assistant text, tool events and final state, so the projection can truthfully name the channel before execution. [VERIFIED: src/evaluation.ts:69-115] A generic judge-only statement is not acceptable under the UI contract. [VERIFIED: .planning/phases/03-poleznyy-test-i-ego-prinyatie/03-UI-SPEC.md:125-129]

### Pattern 4: Normalize Generated Cards Before Storage

For every generated card, replace model-authored agent rubrics with exactly one shared `goal_attainment` definition parameterized by the card’s non-empty `successCriteria`. Then add harness-owned rubrics based on actual run capabilities: `prompt_compliance` only when a source is the agent prompt, and `user_fidelity` only for simulator/reactive execution. Keep owner-added rubrics on the edit path; do not run generated-card normalization over stored owner edits. The current external-generation path adds `prompt_compliance` and `user_fidelity` after validation, while `goalToScenario` currently emits the extra `perimeter` rubric, proving the rule is not centralized yet. [VERIFIED: src/pi.ts:477-507] [VERIFIED: src/contracts.ts:331-346]

For `answers[].reply`, compare every token returned by `valueTokens()` against the union of existing user knowledge and owner-authoritative evidence. Dialogue evidence means user-authored messages only; assistant replies, code and outcomes stay observations. The current validator uses `.find`, so it reports only the first unknown token, and its grounding set contains only `opening`, `facts` and `knows`. [VERIFIED: src/pi.ts:494-498] The planner should pass only the required user-turn evidence into this existing preparation boundary, not introduce an evidence service.

### Pattern 5: Reserved Metric Identity

Use metric id as the row key only for the exact reserved ids `'goal_attainment'`, `'prompt_compliance'`, and `'reply_quality'`; retain the existing full-rubric fingerprint for all owner rubrics. The current implementation keys every agent rubric by `fingerprint(metric)`, so differing per-card success criteria split reserved metrics into multiple rows. [VERIFIED: src/quality.ts:58-83] This is reporting identity only; it must not weaken per-card rubric definitions.

### Anti-Patterns to Avoid

- **Hash recursion:** including the accepted hash in `draftHash` makes acceptance invalidate itself.
- **Approval inferred from `reviewedAt`:** automated reassessment/execution uses the same metadata for a different act. [VERIFIED: src/contracts.ts:498-500] [VERIFIED: src/experiment.ts:384-410]
- **Adapter-owned approval state:** a Pi boolean or CLI flag is not durable and cannot guard `saveSuite`.
- **Accepting one displayed card while hidden cards remain:** the acceptance block promises exactly one test; reject or explicitly select before acceptance rather than silently trimming. [VERIFIED: .planning/phases/03-poleznyy-test-i-ego-prinyatie/03-UI-SPEC.md:100-128]
- **External-only rubric normalization:** recorded/generated production cards can otherwise retain conflicting reserved definitions.
- **`String.includes`, prefix match, or `.slice(0, 20)` for knowledge:** they permit substring collisions or silently change the test; reuse token sets and repair.
- **A second confirmation ceremony:** acceptance is the existing native confirmation over the exact shown hash. [VERIFIED: .planning/phases/03-poleznyy-test-i-ego-prinyatie/03-UI-SPEC.md:131-140]
- **Blanket terminology replacement:** the conversation says `тест`, while serialization/technical documentation says `карточка бизнес-сценария`; update by audience, not search-and-replace. [VERIFIED: .planning/phases/03-poleznyy-test-i-ego-prinyatie/03-CONTEXT.md:35-38]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Draft versioning | revision counter or new version table | `draftHash(record)` | Already covers semantic inputs and is used by edits/start. [VERIFIED: src/experiment.ts:27-32] [VERIFIED: src/experiment.ts:189-194] |
| Mutation locking | per-record approval mutex | `ExperimentLab.change()` | Existing aggregate mutation serialization is sufficient. [VERIFIED: src/experiment.ts:98-108] |
| Approval UI | modal/checkbox/status form | `ctx.ui.confirm` and CLI `--yes` | Explicit locked interaction contract. [VERIFIED: .planning/phases/03-poleznyy-test-i-ego-prinyatie/03-UI-SPEC.md:131-140] |
| Card editor | restored TUI/JSON editor | `updateDraft` + `agent_lab_edit` | Existing optimistic edit surface is the locked path. [VERIFIED: .planning/phases/03-poleznyy-test-i-ego-prinyatie/03-CONTEXT.md:35-38] |
| Grounding tokenizer | fuzzy/LLM entity matcher | `valueTokens()` | Same deterministic definition is already shared with fabrication checks. [VERIFIED: src/contracts.ts:11-25] |
| Retry orchestration | new repair queue | `jsonResponse(..., review)` | It already returns semantic rejection into the same bounded session. [VERIFIED: src/pi.ts:305-339] |
| Observation model | new evidence-channel schema | existing checks and `Trial` observation semantics | Current evaluator distinguishes assistant, tool and state evidence. [VERIFIED: src/evaluation.ts:69-115] |

**Key insight:** this phase is an invariant stitched through existing seams—generation, projection, mutation and save—not a feature area requiring infrastructure.

## Common Pitfalls

### Pitfall 1: Acceptance Survives a Semantic Mutation

**What goes wrong:** `acceptedDraftHash` remains present after an edit and callers test truthiness rather than equality.

**How to avoid:** both clear on every draft-producing path and always authorize with `acceptedDraftHash === draftHash(record)` immediately before the protected action.

**Warning signs:** tests pass when only timestamps/settings/target/scenario criteria change, or a loaded suite starts already accepted.

### Pitfall 2: Acceptance Accidentally Starts the Agent

**What goes wrong:** the existing `agent_lab_run` confirm is reused by simply calling `start`, so Phase 3 crosses into real execution.

**How to avoid:** separate the domain mutation “accept exact shown draft” from `start`; the Phase 3 Pi/CLI surface ends after recording acceptance. Phase 4 may connect the same confirmation to execution without adding another ceremony. Current `start` changes phase and launches immediately after approval. [VERIFIED: src/experiment.ts:383-413]

**Warning signs:** trials, target events, usage or suite files appear after the Phase 3 acceptance test.

### Pitfall 3: The UI Shows an Incomplete Test

**What goes wrong:** current `runPlan` shows title/opening/success/checks but not a grounded situation or an explicit observation channel. [VERIFIED: extensions/agent-lab.ts:40-53]

**How to avoid:** project all four required fields, full input and success criterion, concrete channel, and short hash from one scenario; render non-empty `initialState` only when needed.

**Warning signs:** “проверит судья,” ellipsized criteria, empty state blobs, or more than one test in the acceptance question.

### Pitfall 4: Reserved Rubrics Drift by Source Path

**What goes wrong:** external generation, observed goals and owner edits each produce a different set of agent metrics. Current `goalToScenario` visibly includes both `'goal_attainment'` and `'perimeter'`, plus `'user_fidelity'`. [VERIFIED: src/contracts.ts:331-346]

**How to avoid:** one deterministic goal rubric for generated cards; harness decoration after generation; owner extras only via edit.

**Warning signs:** a generated card has `tone`, `format`, `perimeter`, duplicate `goal_attainment`, or `user_fidelity` on a non-simulator run.

### Pitfall 5: Grounding Repairs Only the First Unknown

**What goes wrong:** `.find` accepts a repaired first token while a later unsupported value remains. [VERIFIED: src/pi.ts:494-498]

**How to avoid:** compute the full set difference, add only fully matched owner-evidence tokens, then perform the 20-item check before mutation; otherwise return one precise repair reason.

**Warning signs:** a reply with two values behaves differently based on their order, `E-2047` matches `E-20470`, or the array is truncated.

### Pitfall 6: Save Gate Races or Guards the Derived Draft

**What goes wrong:** code fetches an approved record, another mutation changes it, or approval is checked only after `freshDraft` has intentionally cleared it.

**How to avoid:** perform the equality check and snapshot/export as one aggregate mutation or otherwise ensure the checked source is immutable through the exclusive write; gate before deriving the portable draft. `writeFile` currently uses exact flags `'wx'` and mode `0o600`. [VERIFIED: src/experiment.ts:251-260]

## Code Examples

Verified existing patterns to reuse directly:

### Semantic Draft Identity

```typescript
// Source: src/experiment.ts:27-32
export function draftHash(record: Experiment): string {
  return fingerprint({ task: record.task, workflow: record.workflow, mode: record.mode, sources: record.sources,
    settings: record.settings, target: record.target, requirements: record.requirements, questions: record.questions,
    goldenCases: record.goldenCases, dialogues: record.dialogues, profiles: record.profiles, notes: record.notes,
    scenarios: record.scenarios, agent: record.revisions[0]?.spec,
    targetVersion: record.targetVersion, targetFingerprint: record.targetFingerprint, evaluatorVersion: record.evaluatorVersion });
}
```

[VERIFIED: src/experiment.ts:27-32]

### Optimistic Mutation Guard

```typescript
// Source: src/experiment.ts:189-194
async updateDraft(id: string, expectedHash: string, raw: DraftPatch): Promise<Experiment> {
  return this.change(async () => {
    const record = await this.store.get(id);
    if (record.phase !== 'review') throw new Error('Править можно только незапущенный черновик. Готовые доказательства остаются как есть, для изменений создайте новый эксперимент.');
    if (draftHash(record) !== expectedHash) throw new Error('Черновик изменился. Откройте карточки заново, прежде чем править.');
    const patch = draftPatchSchema.parse(raw);
```

[VERIFIED: src/experiment.ts:189-194]

### Deterministic Value Tokens

```typescript
// Source: src/contracts.ts:17-25
const VALUE_TOKEN = /[A-Za-zА-Яа-яЁё0-9:./-]+/g;
export function valueTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.match(VALUE_TOKEN) ?? []) {
    const token = raw.replace(/[.,:]+$/, '').toLocaleLowerCase();
    if (token.length >= 3 && /\d/.test(token)) tokens.add(token);
  }
  return tokens;
}
```

[VERIFIED: src/contracts.ts:17-25]

## State of the Art / Source-Plan Accuracy

| Source-plan item | Status for Phase 3 | Required correction |
|------------------|--------------------|---------------------|
| Task 8: goal rubric, harness rubrics, reserved rows | Useful fragment, not accurate as a complete phase task | Normalize every generated card, not only external cards; derive exactly one agent goal rubric; add harness metrics only when their runtime conditions apply; preserve owner extras; add the acceptance lifecycle and compact projection omitted by the task. [VERIFIED: docs/superpowers/plans/2026-09-15-mvp-cut.md:755-872] |
| Task 9: enrich `knows` from sources | Algorithmic core remains useful | Include owner materials **and user-authored dialogue evidence**, inspect all unknown tokens, preserve the 20-item hard repair boundary, and exclude assistant/outcome evidence. [VERIFIED: docs/superpowers/plans/2026-09-15-mvp-cut.md:876-949] |
| Task 10: terminology | Inventory remains useful | Apply terminology by audience: main interaction says `тест`; serialized/technical contract says `карточка бизнес-сценария`. Do not blanket-replace or edit the source plan. [VERIFIED: docs/superpowers/plans/2026-09-15-mvp-cut.md:953-983] [VERIFIED: .planning/phases/03-poleznyy-test-i-ego-prinyatie/03-CONTEXT.md:35-38] |

Current live occurrences that need context-sensitive review include the exact phrases `user simulation cards` in `skills/agent-builder/SKILL.md`, `карточках пользователей` / `карточки пользователей` in the Pi header/widget, and `карточки пользователей` in `docs/PILOT.md`. [VERIFIED: skills/agent-builder/SKILL.md:3-3] [VERIFIED: extensions/agent-lab.ts:128-141] [VERIFIED: docs/PILOT.md:5-5]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| — | None. Recommendations are derived from locked decisions and source code opened in this session. | — | — |

## Resolved Assumptions

1. **RESOLVED — Phase 3 binds to the post-Phase-2 live seams at execution time.**
   - The Phase 3 executor must read all Phase 2 summaries and the live exports before writing RED tests, then reuse every landed `goalAttainment`, `replyQuality`, dialogue-evidence, score/import, and hash helper.
   - If a required helper is still absent, it is added only at the nearest existing seam already named by the plans; no duplicate helper, parallel definition, new module, or dependency is allowed. This turns Phase 2's in-flight state into an explicit precondition rather than an open design choice.

2. **RESOLVED — Shared compact projection belongs in `src/quality.ts`.**
   - `src/quality.ts` already owns `qualityLines` and the stable metric-row projection consumed by both Pi and CLI; the compact situation/input/success/observation projection extends that existing pure presentation seam.
   - `extensions/agent-lab.ts` and `src/cli.ts` both consume that export, and terminal output continues through the existing sanitizer. No presentation framework, new directory, editor, or dashboard is introduced.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | build/tests/runtime | ✓ | `v22.22.3` | — |
| npm | scripts/test runner | ✓ | `10.9.8` | — |
| TypeScript build | repository build | ✓ | declared `^5.9.3` | — |
| `tsx` | test execution | ✓ | declared `^4.20.0` | — |

The available Node version satisfies the exact declared engine constraint `">=22.19.0"`. [VERIFIED: package.json:7-9] The baseline command `npm run build && npx tsx --test test/contracts.test.ts test/pi.test.ts test/experiment.test.ts test/quality.test.ts test/workflow.test.ts test/extension.test.ts && npm run typecheck` passed `141` tests with `0` failures on 2026-09-15. [VERIFIED: command output, 2026-09-15]

**Missing dependencies with no fallback:** none.

**Missing dependencies with fallback:** none.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Node test runner through `tsx` |
| Config file | none; package script discovers `test/*.test.ts` |
| Quick run command | `npx tsx --test test/contracts.test.ts test/pi.test.ts test/experiment.test.ts test/quality.test.ts test/workflow.test.ts test/extension.test.ts` |
| Full suite command | `npm test && npm run typecheck` |

The exact repository scripts are `"test": "npm run build && tsx --test test/*.test.ts"` and `"typecheck": "npm run build && tsc --noEmit --strict --noUncheckedIndexedAccess ..."`. [VERIFIED: package.json:30-37]

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| LOOP-04 | one complete compact test and concrete observation channel | integration | `npx tsx --test test/extension.test.ts test/workflow.test.ts` | ✅ extend |
| LOOP-05 | exact accept/edit/invalidate/save lifecycle | unit + integration | `npx tsx --test test/experiment.test.ts test/extension.test.ts test/workflow.test.ts` | ✅ extend |
| CARD-01 | generated card required fields and conditional state display | unit | `npx tsx --test test/contracts.test.ts test/pi.test.ts test/extension.test.ts` | ✅ extend |
| CARD-02 | exactly one generated `goal_attainment` derived from success | unit | `npx tsx --test test/contracts.test.ts test/pi.test.ts` | ✅ extend |
| CARD-03 | conditional harness metrics; owner extras survive edits | unit | `npx tsx --test test/pi.test.ts test/experiment.test.ts` | ✅ extend |
| CARD-04 | all full-token values grounded; overflow repairs | unit | `npx tsx --test test/pi.test.ts test/contracts.test.ts` | ✅ extend |
| CARD-05 | reserved ids merge; owner definitions fingerprint | unit | `npx tsx --test test/quality.test.ts` | ✅ extend |
| CARD-06 | no obsolete live user-facing terminology | contract/search test | `rg -n "user simulation cards|user cards|карточк(а|и|ах) пользовател" src extensions skills README.md docs/*.md CONTEXT.md` | ❌ Wave 0: add focused assertion or explicit audit step |

### Sampling Rate

- **Per task commit:** relevant command from the map above.
- **Per wave merge:** `npm test && npm run typecheck`.
- **Phase gate:** full suite green, plus a negative assertion that acceptance caused no target/simulator calls and no suite file.

### Wave 0 Gaps

- [ ] Add acceptance fixtures/helpers in `test/experiment.test.ts` for accepted, stale, invalidated and legacy-missing states.
- [ ] Add a no-target-call Pi fixture and shared compact-block expectations in `test/extension.test.ts`.
- [ ] Add CLI build `--yes` / no-`--yes` acceptance coverage in `test/workflow.test.ts`.
- [ ] Add CARD-06 scoped terminology assertion or deterministic audit command while excluding archived/superseded design history and the dirty source plan.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No new identity boundary; local explicit user confirmation only. |
| V3 Session Management | no | No new user session or token. |
| V4 Access Control | yes | Treat accepted-draft equality as a capability check immediately at mutation/export boundaries. |
| V5 Input Validation | yes | Existing strict Zod schemas, semantic repair callback, optimistic hash and deterministic token grounding. [VERIFIED: src/contracts.ts:232-243] [VERIFIED: src/pi.ts:305-339] |
| V6 Cryptography | yes | Reuse Node crypto-backed fingerprinting; do not implement hashing. [VERIFIED: src/contracts.ts:1-1] [VERIFIED: src/experiment.ts:27-32] |

OWASP ASVS 5.0 groups defenses for validating data against expected formats/structures and for context-appropriate output encoding; those controls apply to model JSON ingestion and terminal output here. [CITED: https://cornucopia.owasp.org/taxonomy/asvs-5.0/02-validation-and-business-logic/02-input-validation] [CITED: https://cornucopia.owasp.org/taxonomy/asvs-5.0/01-encoding-and-sanitization/02-injection-prevention]

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Terminal escape/control injection from materials or model output | Spoofing / Tampering | Route all interpolated text through existing `safeText`; test ANSI, control and bidi samples. |
| TOCTOU between displayed and accepted draft | Tampering | Native confirmation passes the exact full displayed hash into serialized aggregate mutation; stale mismatch leaves state unchanged. |
| Persisting an unaccepted or since-edited test | Tampering | Recompute exact hash inside `saveSuite` boundary and require equality. |
| Prompt/model smuggles unsupported expected values | Tampering | Deterministic full-token owner-evidence match; bounded repair; never use assistant/outcome as oracle. |
| Hidden additional scenario accepted under a one-test display | Spoofing | Validate exactly one acceptance candidate before showing/accepting; no silent trimming. |
| Overwriting an existing suite file | Tampering | Preserve the existing exclusive `'wx'` and restrictive `0o600` file-write settings. [VERIFIED: src/experiment.ts:251-260] |

## Sources

### Primary (HIGH confidence)

- `03-CONTEXT.md` — locked acceptance, generation, grounding, terminology and scope decisions.
- `03-UI-SPEC.md` — exact compact block, copy, acceptance interaction and no-run boundary.
- `src/contracts.ts` — authoritative schemas, exact value-token rule and rubric/card fields.
- `src/experiment.ts` — authoritative hash, mutation, invalidation, suite and start flows.
- `src/pi.ts` — authoritative generated-card validation, current normalization and bounded repair.
- `src/quality.ts` — authoritative metric row identity.
- `extensions/agent-lab.ts`, `src/cli.ts`, `src/evaluation.ts` — live Pi/CLI rendering and evidence channels.

### Secondary (MEDIUM confidence)

- [OWASP ASVS project](https://owasp.org/projects/asvs/) — current ASVS release family.
- [OWASP ASVS 5.0 input validation](https://cornucopia.owasp.org/taxonomy/asvs-5.0/02-validation-and-business-logic/02-input-validation) — strict validation guidance.
- [OWASP ASVS 5.0 injection prevention](https://cornucopia.owasp.org/taxonomy/asvs-5.0/01-encoding-and-sanitization/02-injection-prevention) — contextual output handling guidance.

### Tertiary (LOW confidence)

- None.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — no new dependency; exact versions and scripts read from `package.json`.
- Architecture: HIGH — based on the live aggregate, hash, Pi/CLI, validation and suite paths.
- Pitfalls: HIGH — each maps to an observed implementation seam or locked interaction rule.
- Security: MEDIUM — repository controls are verified; ASVS category mapping is a phase-specific interpretation of official guidance.

**Research date:** 2026-09-15
**Valid until:** 2026-09-22 (the codebase is actively changing across adjacent phases)
