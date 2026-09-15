# AI-SPEC — Phase 3: Полезный тест и его принятие

> Delta contract over Phase 2's existing Runtime/Zod design. No new AI framework or dependency.

---

## 1. System Classification

**System Type:** Hybrid — grounded structured test generation with human acceptance

**Description:** Agent Lab turns one owner-confirmed hypothesis into one minimal business-scenario test, validates its grounding, and binds explicit owner acceptance to the exact draft before any later run or regression save.

**Critical Failure Modes:**
1. Generating a test whose criterion is not grounded in owner requirements.
2. Smuggling unsupported values into the scenario or silently truncating them.
3. Treating acceptance of one draft as acceptance of a later edited draft.

---

## 1b. Domain Context

**Industry Vertical:** Developer tooling / quality assurance for conversational and action-taking AI agents

**User Population:** Agent owners and senior product or QA practitioners who know the intended business behavior and decide whether one proposed business-scenario test is fit to run and retain.

**Stakes Level:** Medium

**Output Consequence:** Acceptance promotes the exact draft into an executable, saveable regression-test candidate. A bad draft can test the wrong behavior, accept an unobservable outcome, or make later agent changes look broken or safe for the wrong reason. This phase does not run the target or adjudicate run results.

### What Domain Experts Evaluate Against

**Dimension: Faithfulness to the confirmed hypothesis**  
**Good (domain expert would accept):** The one test isolates the behavior named in the owner-confirmed hypothesis; its situation, input, and `successCriteria` trace to owner requirements or cited owner evidence, while code behavior, target replies, and stored outcomes remain observations rather than the expected answer.  
**Bad (domain expert would flag):** The draft tests a nearby behavior, turns current implementation into the oracle, or adds an expectation that the owner did not confirm.  
**Stakes:** Critical  
**Source:** Agent Lab LOOP-02/04/05; ISO/IEC/IEEE 29148 defines requirements traceability and stakeholder validation; Google Research reports that explicit preconditions, postconditions, and undefined behavior improve generated-test quality.

**Dimension: Decision-complete test definition**  
**Good (domain expert would accept):** The draft contains one concrete situation, the user's opening/input, one non-empty success criterion, and the available observation channel; each field is necessary to decide whether the hypothesis holds, and `goal_attainment.passCriteria` repeats `successCriteria` without semantic drift.  
**Bad (domain expert would flag):** The draft is a broad theme, needs unstated setup or data, contains several behaviors, or adds tone/format rubrics that can pass while the business goal fails.  
**Stakes:** High  
**Source:** Agent Lab CARD-01/02/03; ISO/IEC/IEEE 29119-1 distinguishes the test scenario, test oracle, expected result, test data, environment, and complete test specification.

**Dimension: Observable business outcome**  
**Good (domain expert would accept):** The success criterion names an effect the declared channel can actually observe. For an action such as creating or changing a record, acceptance requires a tool result, state snapshot, or exact check capable of proving that effect; assistant prose alone is not an observation channel.  
**Bad (domain expert would flag):** The test can pass because the agent says it succeeded, or the stated criterion requires state that the test cannot inspect.  
**Stakes:** Critical  
**Source:** Agent Lab LOOP-04/07 and SCORE-06; ISO/IEC/IEEE 29119-1 identifies the test-oracle problem as deciding pass/fail from test inputs and state.

**Dimension: Scenario integrity and loophole resistance**  
**Good (domain expert would accept):** User facts and clarification answers contain only values supported by owner material or owner/user dialogue evidence; affordances and restrictions are explicit enough that success means satisfying the intended business behavior, not exploiting the scoring setup.  
**Bad (domain expert would flag):** The draft invents a value, silently drops excess data, reveals or derives the expected answer from generated text, or permits a shortcut that satisfies the check without fulfilling the task.  
**Stakes:** Critical  
**Source:** Agent Lab CARD-04; NIST's production agent-evaluation analysis identifies solution contamination and grader gaming as threats to evaluation validity and recommends closing task-design loopholes and specifying affordances and restrictions.

**Dimension: Exact-draft owner acceptance**  
**Good (domain expert would accept):** The owner sees the complete compact test and accepts that exact content; the recorded identity matches the displayed draft, any semantic edit clears acceptance, and declining leaves an editable draft without a run or regression save.  
**Bad (domain expert would flag):** A timestamp, prior confirmation, or approval of a different version authorizes the current draft, or acceptance also implies approval of later execution results.  
**Stakes:** Critical  
**Source:** Agent Lab LOOP-05 and Phase 3 acceptance decision; NIST AI RMF calls for documented human-oversight processes and test methods tied to the deployment context.

### Known Failure Modes in This Domain

1. **Scenario drift:** a confirmed narrow hypothesis becomes a broad or adjacent test, so a later pass/fail does not answer the owner's question.
2. **Oracle/channel mismatch:** the criterion requires an external business effect, but the card can observe only the agent's words; the test therefore cannot distinguish completion from self-report.
3. **Contaminated or gameable setup:** unsupported values enter `answers`/`knows`, the expected answer leaks from generated content, or a weak exact check can be satisfied without the intended behavior.
4. **Stale approval:** the owner accepts draft A, an edit produces draft B, and the workflow still treats B as accepted or silently saves it for regression.

### Regulatory / Compliance Context

None identified for this local developer-tooling phase. It creates and accepts a test definition but does not itself make a sector decision or execute the target. If the evaluated agent operates in a regulated domain, its owner must supply the applicable rule as authoritative test evidence and an evaluated-domain specialist must validate the criterion; Agent Lab must not infer that rule from code or model output. NIST AI RMF and the cited ISO standards are voluntary governance/testing references here, not claimed certifications.

### Domain Expert Roles for Evaluation

| Role | Responsibility in Eval |
|------|------------------------|
| Agent owner / product owner | Labels the authoritative requirement and intended business outcome, calibrates the acceptance rubric, and accepts or edits the exact displayed draft; this is review of the test, not blanket review of run results. |
| Senior agent QA / test practitioner | Reviews edge cases and rejected or heavily repaired drafts, checks that the scenario is minimal and executable, and samples accepted drafts for oracle and loophole defects. |
| Evaluated-domain specialist (when applicable) | Validates domain-specific criteria, observation channels, and regulated edge cases before owner acceptance. |

### Research Sources

- [ISO/IEC/IEEE 29148:2018, Requirements engineering](https://www.iso.org/obp/ui/#iso:std:iso-iec-ieee:29148:ed-2:v1:en) — precise stakeholder requirements, operational scenarios, traceability, and validation that the requirement defines the intended system.
- [ISO/IEC/IEEE 29119-1:2022, Software testing concepts](https://www.iso.org/obp/ui/#iso:std:iso-iec-ieee:29119:-1:ed-2:v1:en) — test scenarios, expected results, test specifications, test oracles, and the oracle problem.
- [NIST: Cheating on AI Agent Evaluations](https://www.nist.gov/caisi/cheating-ai-agent-evaluations) — production examples of solution contamination and grader gaming, plus task-design mitigations.
- [NIST AI Risk Management Framework Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/) — context-specific TEVV, documented human oversight, and domain-expert involvement.
- [Google Research: Grounding AI Agents in Contracts](https://research.google/pubs/grounding-ai-agents-in-contracts-an-empirical-evaluation-of-spec-driven-test-generation/) — empirical support for generating tests from explicit preconditions, postconditions, and undefined behavior.
- [Agent Lab requirements](../../REQUIREMENTS.md), [Phase 3 context](03-CONTEXT.md), and [approved MVP design](../../../docs/superpowers/specs/2026-09-15-mvp-cut-design.md) — authoritative product boundary, minimal card contract, grounding rules, and exact-draft acceptance.

---

## 2. Framework Decision

**Selected Framework:** Existing Pi `Runtime` + Zod

**Version:** `@earendil-works/pi-coding-agent` 0.85.1; Zod 4.5.4

**Rationale:** Existing structured calls, strict contracts, bounded repair, `Scenario`, `draftHash` and `ExperimentLab.updateDraft()` already cover the phase.

**Alternatives Considered:**

| Framework | Ruled Out Because |
|-----------|------------------|
| LangChain.js | Adds duplicate orchestration/state and no missing Phase 3 capability |

**Vendor Lock-In Accepted:** Partial — provider-neutral `Runtime`, installed Pi adapter.

---

## 3. Framework Quick Reference

Phase 3 keeps the Phase 2 Pi/Zod integration unchanged. The only framework delta is a stricter one-card generation review plus an acceptance-only lifecycle mutation; do not add another SDK, model port, validator, or persistence layer.

### Installation
```bash
# Reproduce the already-pinned Pi 0.85.1 and Zod 4.5.4 installation.
npm ci

# No new AI dependency for Phase 3.
```

### Core Imports
```ts
import { z } from 'zod';
import {
  rubricSchema, scenarioSchema, valueTokens,
  type CreateInput, type Experiment,
} from './contracts.js';
import { ExperimentLab, draftHash } from './experiment.js';
```

### Entry Point Pattern
```ts
// `acceptDraft` is the one Phase 3 lifecycle addition described below.
const lab = new ExperimentLab('.agent-lab');
await lab.init();
try {
  const created = await lab.create({
    ...input satisfies CreateInput,
    workflow: 'evaluate',
    scenarioCount: 1,
  });
  await lab.waitForIdle();
  const draft = await lab.get(created.id);
  if (draft.scenarios.length !== 1) throw new Error('Expected exactly one test');

  const shownHash = draftHash(draft); // render the full test and this hash first
  const accepted = await lab.acceptDraft(draft.id, shownHash);
  console.log({ id: accepted.id, acceptedDraftHash: accepted.acceptedDraftHash });
  // Phase 3 stops here: no start(), openTarget(), userTurn(), or saveSuite().
} finally {
  await lab.close();
}
```

### Key Abstractions

| Concept | What It Is | When You Use It |
|---------|-----------|-----------------|
| `Runtime.prepare()` | Existing provider-neutral structured generation path | Request exactly one scenario from the confirmed hypothesis and cited evidence |
| `Scenario` / `scenarioSchema` | Existing strict business-scenario card contract | Store and revalidate the situation, input, success criterion, observation checks, and rubrics |
| `valueTokens()` | Existing case-insensitive full-token extractor | Deterministically prove value-like tokens in `answers[].reply` against owner evidence |
| `draftHash()` | Existing stable content fingerprint | Identify the exact test displayed, edited, accepted, run, or exported |
| `acceptedDraftHash` | One optional, backward-compatible experiment field | Record acceptance without treating a timestamp or stale draft as approval |

### Common Pitfalls

1. **Letting the candidate card ground itself.** A token appearing in `answers[].reply` is not evidence. Match it with `valueTokens()` against a prefiltered corpus of owner materials and owner/user dialogue turns; never use generated text, target/assistant replies, code behavior, or logged outcomes as the oracle.
2. **Using substring matches or silent truncation.** `103` must not be justified by `A103`, and `.slice(0, 20)` would hide a malformed card. Use the same normalized full-token set on both sides; unsupported values or more than 20 final `knows` entries return the whole card to bounded repair.
3. **Mixing generator, harness, and owner rubrics.** Before harness enrichment, generated output has exactly one agent rubric: `goal_attainment`, whose `passCriteria` equals `successCriteria` verbatim. The harness adds `prompt_compliance`/`user_fidelity` only when applicable; later owner rubrics arrive only through `agent_lab_edit`.
4. **Equating `reviewedAt` with exact acceptance.** A timestamp does not identify content. Store the accepted full hash, exclude that field from `draftHash()`, and require equality at every run/export gate. Older records with no hash are unaccepted.
5. **Keeping acceptance coupled to execution.** The current `agent_lab_run` confirmation immediately starts sessions. Split its confirm path so Phase 3 records acceptance only; Phase 4 may consume that acceptance without a second ceremony.

### Recommended Project Structure
```text
src/contracts.ts        # optional acceptedDraftHash + strict generated-card schema pieces
src/pi.ts               # one-card semantic review and deterministic token enrichment
src/experiment.ts       # acceptDraft(), invalidation, start/save gates
extensions/agent-lab.ts # compact render + native accept/edit interaction
test/                   # one generation-contract check and one acceptance/hash check
```

Do not create a parallel `ai/`, approval service, editor, vector store, or cache layer.

### Sources

- [Phase 2 framework reference and implementation contract](../02-ponimanie-agenta-i-gipoteza/02-AI-SPEC.md#3-framework-quick-reference)
- [Pi SDK documentation, pinned to installed 0.85.1](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sdk.md)
- [Zod parsing, strict schemas, refinements, and inferred types](https://zod.dev/basics)

---

## 4. Implementation Guidance

**Model Configuration:** Inherit Phase 2 unchanged: use the authenticated `settings.provider/settings.model` (or existing `roles.builder` override), `thinkingLevel: 'off'`, Pi provider-default sampling, `maxTokens: min(16_384, model.maxTokens)`, provider retries disabled, five application-owned schema/semantic repair attempts, 120 seconds per call, and the existing operation/call ceilings. Determinism comes from Zod and code review, not from a hard-coded provider model. Acceptance and editing make zero model calls.

**Core Pattern:** Keep generation inside the existing isolated `jsonResponse()`/`Runtime.prepare()` flow. Request one card, validate its requirement IDs and source quotes as today, then run this semantic review before publishing it:

```ts
function enrichAnswerTokens(card: Experiment['scenarios'][number], ownerEvidence: string[]): string | undefined {
  const grounded = valueTokens(ownerEvidence.join('\n'));
  const known = valueTokens([card.user.opening, card.user.facts, ...(card.user.knows ?? [])].join('\n'));
  const additions = new Set<string>();

  for (const answer of card.user.answers ?? []) {
    for (const token of valueTokens(answer.reply)) {
      if (known.has(token)) continue;
      if (!grounded.has(token)) return `Unsupported answer value: ${token}`;
      additions.add(token); // normalized, case-insensitive full-token match
    }
  }
  const next = [...(card.user.knows ?? []), ...additions];
  if (next.length > 20) return `answers enrichment produces ${next.length} known values; maximum is 20`;
  card.user.knows = [...new Map(next.map(value => [value.toLocaleLowerCase(), value])).values()];
  return card.user.knows.length > 20 ? 'Known-value limit exceeded after deduplication' : undefined;
}

// Inside ExperimentLab; `acceptedDraftHash` is deliberately excluded from draftHash().
async acceptDraft(id: string, expectedHash: string): Promise<Experiment> {
  return this.change(async () => {
    const record = await this.store.get(id);
    if (record.phase !== 'review' || record.workflow !== 'evaluate') throw new Error('Нет теста, ожидающего принятия.');
    const currentHash = draftHash(record);
    if (currentHash !== expectedHash) throw new Error('Тест изменился. Откройте актуальную версию.');
    record.acceptedDraftHash = currentHash;
    record.reviewedAt = new Date().toISOString();
    record.reviewMode = 'human';
    await this.checkpoint(record, 'review', 'Тест принят. Запуск ещё не выполнялся.');
    return structuredClone(record);
  });
}
```

Pass only authoritative owner material and owner/user dialogue evidence into `ownerEvidence`. In the `jsonResponse()` review callback, a returned issue triggers the existing repair loop; successful deterministic enrichment costs no extra call. After enrichment, reparse the card and require one scenario, non-empty `successCriteria`, a concrete answer/tool/state observation channel, and exactly one pre-harness `goal_attainment`. For action success, an assistant claim is not a channel: require a tool result or state snapshot. Never truncate or publish a partially repaired card.

**Tool Use:** Scenario generation remains `controlledSession(..., tools: [])`; repository text and dialogues are serialized untrusted input, not model tools. `acceptDraft()` also has no tools and must not call `openTarget()`, `userTurn()`, the judge, the simulator, or `saveSuite()`. The native Pi confirm only selects accept versus leave-editable; edits continue through `agent_lab_edit(expectedHash)`.

**State Management:** Add only `acceptedDraftHash?: string` to `Experiment` and its Zod schema; reuse `reviewedAt` and `reviewMode`. `updateDraft()` and every `freshDraft()`/load/repeat path clear all three acceptance fields after a successful semantic change. Stale edits fail before mutation. `start()` and `saveSuite()` require `acceptedDraftHash === draftHash(record)`; an old record with only `reviewedAt` must be accepted again. Export may clear acceptance in the fresh portable definition after the source gate passes. The acceptance field must not participate in `draftHash()` or it would change the identity it records.

**Context Window Strategy:** Send only the confirmed hypothesis, its cited requirements/exact source spans, relevant owner notes, and complete owner/user turns needed to construct one test. Do not resend the repository, prior agent answers, or unrelated dialogues. Keep Pi compaction disabled. If the evidence required for grounding cannot fit, fail with the omitted-source reason; do not summarize, truncate, or infer an expected value.

---

## 4b. AI Systems Best Practices

> Use native Zod/TypeScript; do not introduce Python/Pydantic.

### 4b.1 Structured Outputs with Zod (Native Pydantic Equivalent)

```ts
const generatedGoalSchema = rubricSchema.extend({
  id: z.literal('goal_attainment'),
  subject: z.literal('agent'),
});

// Apply before harness rubrics are appended; owner-added rubrics exist only after editing.
export const generatedTestSchema = scenarioSchema
  .required({ successCriteria: true, assumptions: true, metrics: true })
  .extend({ metrics: z.tuple([generatedGoalSchema]) })
  .superRefine((card, ctx) => {
    if (card.metrics[0].passCriteria !== card.successCriteria) {
      ctx.addIssue({
        code: 'custom', path: ['metrics', 0, 'passCriteria'],
        message: 'goal_attainment.passCriteria must equal successCriteria verbatim',
      });
    }
  });

export const generatedTestEnvelopeSchema = z.strictObject({
  scenarios: z.tuple([generatedTestSchema]), // exactly one test
});
```

`jsonResponse()` already integrates Zod by placing `z.toJSONSchema(schema)` in the isolated system prompt, parsing the final message, calling `safeParse()`, and invoking a semantic review callback. Keep `REPAIR_ATTEMPTS = 5`. Log attempt number, step label, provider/model, Zod paths, and the deterministic grounding reason; raw output remains opt-in under `AGENT_LAB_DEBUG_DIR` with mode `0600`. Surface the final specific reason after attempt five. Unsupported tokens, rubric mismatch, missing observation, or a >20 enrichment are repair failures, never coercions.

### 4b.2 Async-First Design

Pi and `ExperimentLab` are promise-based. Await the complete structured response before parsing/enrichment, dispose its isolated session in `finally`, and serialize acceptance/edit mutations through existing `change()`. The common mistake is racing `acceptDraft()` with `updateDraft()` or calling `respond()` twice on one Pi session; the mutation lock and current responding guard must continue to reject both. Stream only progress text; await the final response for JSON/Zod validation and await the stored checkpoint before reporting acceptance.

### 4b.3 Prompt Engineering Discipline

Keep role, grounding policy, one-card rule, schema, and `DATA_BOUNDARY` in the system prompt. Put the confirmed hypothesis, cited owner material, and dialogue evidence in the user message as JSON. Instructions found inside those materials remain evidence, never evaluator instructions. Require `goal_attainment.passCriteria` to copy `successCriteria` exactly; do not use few-shot examples unless a reproduced format failure justifies one, and then keep the example inline and synthetic. Retain explicit `maxTokens: 16_384` clamped to the selected model.

### 4b.4 Context Window Management

This is deterministic evidence selection, not RAG: no vector database, embedding model, reranker, or semantic cache is needed. Select one confirmed hypothesis and only its provenance-bearing evidence. Preserve full originals in the experiment record; a prompt excerpt never becomes a new source. Compaction stays off because a summary cannot prove an exact quote or token. If required evidence exceeds the window, return the test to repair or ask for a narrower hypothesis instead of silently dropping evidence.

### 4b.5 Cost and Latency Budget

Phase 3 adds no normal model call beyond the existing one-card generation step; deterministic enrichment, rendering, editing validation, and acceptance cost zero. A malformed card can consume up to five bounded attempts, after which it fails visibly. Estimate each call from Pi's resolved model rates and observed usage—`(input tokens × input rate + output tokens × output rate + cache tokens × their rates) / 1_000_000`—and keep `costUsd: null` when the provider has no price metadata. The per-call and operation deadlines remain 120 seconds and 10 minutes.

An exact generation cache is optional only if later measurements justify it; key it on confirmed hypothesis, exact evidence hashes, protocol/schema hash, and model configuration. Never semantically cache a test or acceptance: a near-match or changed draft is precisely what the hash gate must distinguish. Do not split this single task across extra cheap-model calls. A cheaper existing `roles.builder` model is acceptable only after the grounded-card fixtures show no regression.

---

## 5. Evaluation Strategy

Phase 3 passes only when the deterministic gates reject every malformed, ungrounded, unobservable, or stale-approved draft and the owner can accept or edit the exact test shown. The generated card is never used to judge its own quality. There is no Phase 3 LLM judge: semantic acceptance belongs to the owner, while Zod and lifecycle checks own machine-verifiable invariants.

### Dimensions

| Dimension | Rubric | Measurement Approach | Priority |
|-----------|--------|----------------------|----------|
| Faithfulness to the confirmed hypothesis | **PASS:** the single test isolates the accepted hypothesis and every expected behavior traces to cited owner requirements or owner/user evidence; target code, replies, and prior outcomes remain observations. **FAIL:** it tests an adjacent behavior, invents an expectation, or treats current behavior as the oracle. | Human — owner accepts or edits the displayed test; QA reviews disputes and the sampled accepted set against the cited evidence. | Critical |
| Scenario integrity and deterministic knowledge enrichment | **PASS:** every value added from `answers[].reply` to `knows` has a case-insensitive full-token match in authoritative evidence, deduplication preserves supported values, and the final count is at most 20. **FAIL:** generated text grounds itself, a substring such as `103` matches `A103`, a value is invented, or overflow is silently truncated. | Code — `valueTokens()` fixtures and Zod/semantic validation; Human only when the authoritative source itself is disputed. | Critical |
| Decision-complete one-test contract | **PASS:** the envelope has exactly one concrete card with situation/goal, facts/knows, opening/input, answers, non-empty `successCriteria`, and only necessary `initialState`; the pre-harness metrics contain exactly one agent rubric, `goal_attainment`, whose `passCriteria` equals `successCriteria` verbatim. **FAIL:** the card is broad, incomplete, multi-behavior, contains extra generated rubrics, or lets tone/format substitute for the business goal. | Code — strict Zod schema plus exact count, required-field, reserved-ID, and string-equality assertions. | High |
| Observable business outcome | **PASS:** the declared check can prove the criterion through the available reply, tool result, exact check, or state snapshot; an action outcome requires tool/state evidence. **FAIL:** the test can pass solely because the assistant says an action succeeded or requires state the harness cannot inspect. | Code for channel/check compatibility; Human for disputed domain observability during acceptance. | Critical |
| Exact-draft acceptance safety | **PASS:** the complete compact test is shown, `acceptedDraftHash` records that current `draftHash`, every semantic edit/repeat/load clears acceptance, and `start()`/`saveSuite()` reject missing or stale acceptance. **FAIL:** a timestamp, previous version, stale hash, or approval of a run result authorizes the current test. | Code — lifecycle/state-transition tests, stale-hash races, persistence reloads, and run/save rejection assertions. | Critical |
| Phase task completion and boundary | **PASS:** the workflow ends with one accepted exact draft or an editable declined draft; accept/edit makes zero model, judge, simulator, target, run, or save calls. **FAIL:** it auto-runs, auto-saves, loses the editable draft, accepts more than one generated test, or consumes model/tool budget during acceptance. | Code — Runtime/TargetSession spies, stored-state assertions, and call/usage counters; Human confirms that accept/edit copy describes the intended action. | High |
| Human-control clarity | **PASS:** Russian UI copy says that the `тест`/`карточка бизнес-сценария` definition was accepted and that no execution or result verdict occurred; declining preserves control. **FAIL:** copy implies that the agent passed, the result was approved, or the test was saved/run. | Code for required/forbidden wording in rendered output; Human review for ambiguous copy changes. | Medium |

### Eval Tooling

**Primary Tool:** Existing `node:test` suite through the installed `tsx` runner, strict `node:assert`, Zod validators, scripted Runtime/TargetSession fixtures, and persisted Agent Lab experiment/evidence records. Repository scan found no installed eval or tracing platform; none is added.

**Setup:**
```bash
npm ci
```

**CI/CD Integration:**
```bash
npm run typecheck && npm test
```

The Phase 3 regression slice belongs in the existing `test/contracts.test.ts`, `test/pi.test.ts`, `test/experiment.test.ts`, and `test/extension.test.ts` flows. It must cover generated-card validation and repair, deterministic enrichment, acceptance/edit invalidation, persistence reload, and rejection by both run and save gates. No network or live model is required in CI.

### Reference Dataset

**Size:** Start with 10 labeled fixtures while implementing the first gates; expand to 20 before Phase 3 is considered complete. Keep the set small and add cases only from reproduced failures or owner disputes.

**Composition:** 20 fixtures: 4 grounded minimal happy paths; 4 enrichment/grounding cases (case-insensitive exact match, substring false positive, generated self-grounding, and more than 20 values); 3 one-card/reserved-rubric cases; 3 observation-channel cases (observable reply, valid tool/state evidence, and prose-only action claim); 4 acceptance lifecycle cases (exact accept, stale accept, edit invalidation, and repeat/load invalidation with run/save rejection); and 2 bounded-repair cases (successful repair and visible exhaustion after attempt five). Include Russian and English owner material, an adversarial instruction inside source text, and both text-only and action-taking hypotheses.

**Labeling:** Each fixture stores authoritative evidence, the confirmed hypothesis, candidate/repair responses where relevant, and the expected validated card or exact rejection/state transition. Code labels every structural, token, rubric, hash, call-count, and repair result. The agent owner supplies the accept/edit label for hypothesis faithfulness and disputed observation semantics; senior QA reviews all disputes/exhaustions and a small accepted sample. Manual attention is not used to relabel ordinary run results, and no LLM-generated label is treated as ground truth.

**Release Gate:** All 20 fixtures and the full existing suite pass; all Critical dimensions have zero escaping failures. A human acceptance may edit a semantically weak draft, but the resulting hash must be re-shown and explicitly accepted before the fixture can count as complete.

---

## 6. Guardrails

### Online (Real-Time)

| Guardrail | Trigger | Intervention |
|-----------|---------|--------------|
| One-card and rubric contract | The generated envelope has zero/multiple cards, a missing decision field, a reserved-rubric collision, anything other than one pre-harness `goal_attainment`, or `passCriteria !== successCriteria`. | Reject the whole output into the existing bounded repair loop; after attempt five, stop with the specific final reason. Never coerce or publish a partial card. |
| Grounded answer enrichment | An `answers[].reply` token lacks a case-insensitive full-token match in owner evidence, the candidate uses its own text as evidence, or the deduplicated `knows` set exceeds 20. | Reject to repair. Never use substring matching, silently drop a value, or truncate the set. Ask the owner only when the source evidence is genuinely disputed. |
| Observable-outcome gate | An action criterion has no tool result/state snapshot/exact check capable of proving the effect, or its only evidence is assistant prose. | Block publication and return the observation mismatch to repair; a text-response criterion may use reply evidence when that is the actual business outcome. |
| Exact-draft acceptance gate | The displayed/expected hash differs from the current draft, acceptance is absent, or a semantic edit/repeat/load occurred after acceptance. | Reject acceptance, run, and save; show the current test again. A successful edit clears all acceptance fields atomically. |
| Acceptance-only phase boundary | The accept/edit path attempts a model/judge/simulator/target call, run, or regression save. | Block the operation and preserve the editable review draft; Phase 4 owns execution. |

### Offline (Flywheel)

| Metric | Sampling Strategy | Action on Degradation |
|--------|-------------------|----------------------|
| Grounding/contract rejection reasons and repair-attempt count | Record code validation outcomes for 100% of generation attempts; inspect all exhaustions and a rolling group of 20 completed generations. | Add the smallest reproduced case to the reference fixtures; tighten the existing prompt or shared validator at the common failure point. |
| Owner edit/decline rate by dimension | Record the owner's normal accept/edit decision for every shown draft; classify only semantic edits to hypothesis, criterion, or observation channel. | If more than 30% of the last 20 drafts need semantic edits, review the generation instruction and the affected labeled fixtures; do not automate acceptance. |
| Accepted-card semantic defects | Senior QA samples 10% of accepted cards (minimum 2 per 20) and reviews 100% of owner disputes, repair exhaustions, and cards repaired more than once. | Turn each confirmed defect into a fixture and fix the generator/validator; re-show and re-accept affected drafts rather than mutating stored approval. |
| Stale-acceptance and unaccepted run/save rejections | Count 100% of gate rejections from persisted experiment events; CI exercises every transition. | Expected rejections inform UX copy. Any successful stale/unaccepted run or save is an incident: block release and add its transition as a regression case. |
| Phase-boundary cost and calls | Record usage and call counts for 100% of accept/edit operations. | Any model, judge, simulator, or target call during accept/edit blocks release; keep the existing zero-call implementation. |

---

## 7. Production Monitoring

**Tracing Tool:** Existing persisted `Experiment` checkpoints, source/provenance fields, stable draft hashes, usage counters, and evidence/artifact exports. The optional `AGENT_LAB_DEBUG_DIR` retains rejected raw generation output locally with mode `0600` only during diagnosis. No tracing service, dashboard, or new dependency is introduced.

**Key Metrics to Track:** final card-contract validity; grounding and observation rejection reason; attempts per accepted draft and repair exhaustion; owner accept/edit/decline outcome; current versus accepted hash; invalidated acceptances; blocked run/save attempts; model/tool calls during accept/edit; generation latency, tokens, and provider-reported cost when available.

**Alert Thresholds:**

| Signal | Threshold | Response |
|--------|-----------|----------|
| Critical invariant escaped into an accepted or saved card | Any occurrence | Block release/use, preserve the evidence record, invalidate acceptance, and add the case to CI. |
| Run/save passed without `acceptedDraftHash === draftHash(record)` | Any occurrence | Treat as a lifecycle incident and disable that path until its regression test passes. |
| Calls during accept/edit | Any model, judge, simulator, or target call | Block release; acceptance must remain local and zero-cost. |
| Repair exhaustion | More than 2 of the last 20 generations, or 3 consecutive exhaustions | Inspect recorded rejection reasons and update the smallest shared prompt/validator plus fixtures. |
| Repair pressure | Median attempts greater than 2 over the last 20 generations | Review the dominant deterministic rejection reason before changing models. |
| Semantic owner edits | More than 30% of the last 20 shown drafts | Sample edited drafts for hypothesis/criterion/channel drift and refine the corresponding fixture/prompt rule. |
| Time/attempt budget | More than 5 attempts, 120 seconds for one call, or 10 minutes for the operation | Abort with the specific reason; never publish the last invalid candidate. |

These are operational triage thresholds for a small local dataset, not statistical quality or judge-reliability claims.

**Smart Sampling Strategy:** Run code guardrails and retain compact checkpoint metadata for every interaction. The owner reviews every exact draft only to accept or edit its definition. Additional human QA covers every dispute/exhaustion, every draft repaired more than once, every action scenario with a state/tool oracle, and 10% of otherwise accepted cards (minimum 2 per rolling 20). Sample raw model output only for an explicitly enabled local debug session; do not collect it by default.

---

## Checklist

- [x] System type classified
- [x] Critical failure modes identified (≥ 3)
- [x] Domain context researched
- [x] Regulatory/compliance context identified or explicitly noted as none
- [x] Domain expert role defined
- [x] Framework selected with rationale documented
- [x] Alternative considered and ruled out
- [x] Framework quick reference written
- [x] AI systems best practices written
- [x] Evaluation dimensions grounded in domain rubric ingredients
- [x] Each eval dimension has a concrete rubric
- [x] Eval tooling selected
- [x] Reference dataset specified
- [x] CI/CD eval integration specified
- [x] Online guardrails defined
- [x] Production monitoring configured
