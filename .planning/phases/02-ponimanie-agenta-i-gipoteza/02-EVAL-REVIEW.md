# EVAL-REVIEW — Phase 2: Понимание агента и гипотеза

**Audit Date:** 2026-09-15  
**Audited Implementation:** `87a1056af6d467fb7000669ed5410eef13e77aee`  
**AI-SPEC Present:** Yes  
**Overall Score:** 53.14/100  
**Verdict:** SIGNIFICANT GAPS

The Phase 2 implementation contains substantial deterministic safety and evidence-integrity checks and now includes the planned versioned 12-case corpus plus a working end-to-end code-only runner. It still did **not** deliver the complete evaluation strategy promised by `02-AI-SPEC.md`: all four semantic anchors remain `pending_owner`, no retained model-backed corpus run exists, and the real Pi/repository/log smoke remains pending. Passing deterministic tests are not substitutes for those product eval artifacts.

## Dimension Coverage

| Dimension | Status | Measurement | Finding |
|-----------|--------|-------------|---------|
| Requirement provenance / context faithfulness | PARTIAL — WARNING | Code + Human | `Runtime.goals` receives owner sources/requirements and user turns only; unknown requirement IDs and non-verbatim openings are rejected (`src/pi.ts:522-568`, `src/experiment.ts:184-217`). Referential integrity is exercised in `test/pi.test.ts:604-645`, `test/quality.test.ts:83-253`, and the new corpus runner. The corpus now supplies 2 grounded controls, 2 requirement-leakage traps, prompt injection, and conflicting owner evidence with verbatim citations. However, `manifest.json.ownerSemanticLabels` is empty, all four anchors are `pending_owner`, and actual outer-agent repository/log behavior remains unverified. Reach COVERED by completing the four owner reviews and retaining the real smoke artifact. |
| Recorded-evidence integrity / field accuracy | COVERED | Code | Direct converters preserve one dialogue to one scenario/trial and map every message to an ordered event (`src/contracts.ts:364-395`); score appends each event and reassessment copies immutable evidence with an `evidenceHash` (`src/experiment.ts:171-235`, `352-420`). `test/reference-dataset.test.ts` now runs all 12 versioned examples through the real CLI code-only path and verifies one-to-one cardinality, exact ordered events, long-dialogue handling, zero model calls, and non-empty evidence/journal/snapshot artifacts. The orchestrator reports 304/304 plus strict typecheck; the focused corpus test passed 2/2 during this audit. |
| Observable completion / hallucination control | PARTIAL — WARNING | Code + LLM Judge + Human | The request path deterministically downgrades unsupported decided `goal_attainment` verdicts to `unknown`; every declared state predicate must pass or a scenario-linked positive tool result must be cited, while `reply_quality` remains separate (`src/judge.ts:39-86`). The corpus adds the two planned self-attested-action cases and verifies missing/partial observations without model calls. Existing adversarial tests cover failed/unrelated/zero-count tools, conflicting state predicates, two-vote disagreement, and stale receipts (`test/judge.test.ts:67-214`). No model-backed corpus run or owner review of the semantic anchors was found, so actual judge verdict quality remains unevaluated. |
| Structured extraction and metric separation | COVERED | Code | Strict Zod contracts define separate `goal_attainment` and `reply_quality`; `prompt_compliance` is conditional, while imported trials have no `user_fidelity` or simulator checks (`src/contracts.ts:184-224`, `364-395`; `src/experiment.ts:194-229`). Exact metric order/set and invalid-link behavior are asserted in `test/contracts.test.ts`, `test/experiment.test.ts`, and `test/quality.test.ts`. |
| Evaluator safety, tool use, and budget adherence | PARTIAL — WARNING | Code + Human | `score` never enters `runSuite`, code-only does not resolve a runtime, Pi evaluator sessions disable tools/ambient resources/compaction, and shared call/deadline/cancellation accounting fails closed (`src/experiment.ts:171-235`, `505-553`; `src/pi.ts:54-123`; `extensions/agent-lab.ts:197-258`). The new end-to-end corpus runner proves 12/12 imports produce zero model/agent execution and retain artifacts; existing hostile-input tests and the 15/15 security audit remain green. The AI-SPEC's human adversarial-output review and the verifier's real Pi smoke have not run, so actual model obedience and native cancel/consent behavior remain unevaluated. |
| One grounded test worth running / task completion | PARTIAL — WARNING | Code + Human | `scoreBrief` emits the fixed four-block shape and one mechanically linked hypothesis or a strict insufficient-data result (`src/quality.ts:62-127`); CLI/Pi and skill contract tests assert the literal `Проверим?`. But the planned owner acceptance/edit step has not been exercised, and the verifier explicitly marks real outer-agent repository/log study and pre-test stopping behavior as human-needed. Reach COVERED with the one real smoke session, including rejection or correction and proof that no test entity is created before acceptance. |
| Proportionate human review | PARTIAL — WARNING | Code + Human | Override scoping, latest-verdict precedence, whole-dialogue counting, disagreements, unknown queues, and non-propagation are implemented and tested (`src/experiment.ts:423-440`, `src/quality.ts:143-245`; `test/experiment.test.ts:331-345`; `test/quality.test.ts:321-382`). The new manifest avoids fabricated labels, but that is not human evaluation: `ownerSemanticLabels` is `[]` and all four candidates are explicitly `pending_owner`. No actual Phase 2 owner-reviewed semantic anchor or sampled process record exists. |

**Coverage Score:** 2/7 (28.57%)

## Infrastructure Audit

| Component | Status | Finding |
|-----------|--------|---------|
| Eval tooling (Agent Lab harness + Node `node:test`) | Installed and called | The harness, artifact store, runtime spies, and `node:test` suite are used. The orchestrator reports 304/304 and strict typecheck on `87a1056`; the focused `npx tsx --test test/reference-dataset.test.ts` run passed 2/2 during this audit. No additional eval platform was planned or needed. |
| Reference dataset | Partial | `reference.jsonl`, `task.json`, and `manifest.json` are versioned and contain exactly the planned 12 examples with composition 2/2/2/2/1/1/1/1. The focused test validates schema, citations, cardinality/order, metric sets, missing observations, zero calls, and artifacts through the CLI code-only path. Labeling is incomplete: `ownerSemanticLabels` is empty and all four semantic anchors remain `pending_owner`; no model-backed results are attached. |
| CI/CD integration | Present | `.github/workflows/check.yml` runs `npm ci`, `npm test`, strict typecheck, package validation, and uploads evidence. Because `npm test` runs `test/*.test.ts`, the new corpus/code-only runner is in the deterministic CI gate. The credentialed model-backed release smoke remains intentionally outside CI and has not been run. |
| Online guardrails | Implemented | Trusted-source/data-boundary validation, deterministic observable-completion downgrade, single linked-hypothesis/insufficient publication, offline isolation, and call/deadline/cancellation limits are in the local score path and have adversarial tests. The remaining real-model smoke is evaluation evidence, not a missing Phase 4 service guardrail. |
| Tracing (ExperimentStore) | Configured | Actual score/reassess work persists run JSON, append-only trace events, incremental `judgeAudit` attempts, usage, limitations/errors, hashes, and exported artifacts (`src/store.ts:121-137`, `src/experiment.ts:352-420`, `505-553`, `src/judge.ts:121-168`). The ignored `.agent-lab` artifact found during audit is a deterministic demo/compare run with zero imported dialogues, zero judged trials, and zero human reviews; it is not the required Phase 2 release eval. |

**Infrastructure Score:** 90/100

## Guardrail Audit

| Planned guardrail | Status | Evidence |
|-------------------|--------|----------|
| Trusted-source and data-boundary gate | Implemented | Owner-source/user-only goal payload, strict schema and referential validation, bounded repair, no ambient evaluator resources, and injection regressions. |
| Observable-completion gate | Implemented | Unsupported decided goal verdicts become `unknown`; reply quality remains independent; positive completion evidence is narrowly defined and adversarially tested. |
| Single-hypothesis gate | Implemented | Pure `scoreBrief` publishes zero or one linked candidate and otherwise returns insufficient data; Phase 2 has no hypothesis/test persistence entity. |
| Offline-isolation and budget gate | Implemented | Score/reassess do not open the target/simulator, code-only resolves no model runtime, and shared call/deadline/cancellation limits persist errors/partial evidence. |

## Production Monitoring Audit

The AI-SPEC explicitly selects the local `ExperimentStore`, not a hosted monitoring platform. That decision is implemented and appropriate for this CLI/Pi phase; Phoenix/Langfuse is **not** a remediation requirement.

The offline flywheel now has its planned 12-case deterministic sampling unit and a reproducible code-only baseline. The code captures the planned run, citation, judge-audit, usage, cost-null, deadline, and hypothesis-integrity signals. The semantic baseline is still absent: without owner labels and a retained model-backed run, there is no evidence for judge behavior, disagreement/repair exhaustion on the corpus, or human/model divergence.

## Closed Since Previous Audit

### CLOSED EVAL-01 — Versioned reference corpus and code-only runner now exist

Commit `87a1056` adds the three versioned corpus files and an end-to-end test. Exact size/composition and the deterministic code-only evaluation path are now proven. The infrastructure component remains **Partial**, not Covered, because the four required owner semantic labels are still pending and the corpus has not been run model-backed.

## Critical Gaps

### BLOCKER EVAL-02 — Planned semantic and real-session evaluation evidence is missing

`manifest.json` explicitly shows `ownerSemanticLabels: []` and four `pending_owner` anchors, so the required human labels cannot be credited. No retained run was found for the AI-SPEC command `node dist/cli.js score --input test/fixtures/score/reference.jsonl --task test/fixtures/score/task.json --yes`. `02-UAT.md` also records the combined real Agent Lab/Pi repository/log and terminal smoke as `pending`. Therefore actual judge behavior, owner acceptance/edit flow, outer-agent instruction following, and native consent/cancel presentation have not been demonstrated.

These blockers concern Phase 2's planned evaluation only. Acquiring, cash collection, IdP/RAG, IFT, Sigma, and real target execution remain valid Phase 4 boundaries and are not gaps in this audit.

## Remediation Plan

### Must fix before production:

1. Have the agent owner review and label the four manifest anchors: one clean control and one for each critical failure mode. Replace `pending_owner` only with actual decisions and keep label provenance separate from judge output.
2. Run the model-backed score command over the versioned corpus with fixed model/configuration, retain the run JSON, trace JSONL, `judgeAudit`, usage, limitations, and review notes, and confirm all release thresholds.
3. Complete the pending real Pi/repository/log smoke from `02-UAT.md` at roughly 40 and 80 columns, including proposal rejection/correction, consent, cancel, code-only, artifact access, and proof that no test is built/saved before acceptance.

### Should fix soon:

1. Record the release-smoke command, model identity/configuration hash, result artifact path, and reviewer decision in a lightweight checked-in eval receipt; do not claim judge reliability or statistical significance.
2. Promote every reproduced Phase 2 failure into the versioned corpus and review only disputes, decisive unknowns, new edge cases, and the bounded optional sample described by the AI-SPEC.

### Nice to have:

None for this phase. A hosted monitoring/tracing service, production log connector, automatic repair, judge-calibration platform, and Phase 4 agent integrations are explicitly outside the Phase 2 contract.

## Files Found

- Eval/spec artifacts: `02-AI-SPEC.md`, `02-VALIDATION.md`, `02-REVIEW.md`, `02-SECURITY.md`, `02-VERIFICATION.md`, `02-UAT.md`
- Core evaluation implementation: `src/contracts.ts`, `src/experiment.ts`, `src/judge.ts`, `src/pi.ts`, `src/prompts.ts`, `src/quality.ts`, `src/store.ts`
- User entry paths: `src/cli.ts`, `extensions/agent-lab.ts`, `skills/agent-builder/SKILL.md`
- Relevant automated tests: `test/reference-dataset.test.ts`, `test/contracts.test.ts`, `test/experiment.test.ts`, `test/judge.test.ts`, `test/pi.test.ts`, `test/quality.test.ts`, `test/workflow.test.ts`, `test/extension.test.ts`, `test/skill.test.ts`
- CI: `.github/workflows/check.yml`, `package.json`
- Phase 2 reference corpus: `test/fixtures/score/reference.jsonl`, `test/fixtures/score/task.json`, `test/fixtures/score/manifest.json`
- Generic fixture: `test/fixtures/stdio-agent.mjs`
- Ignored local artifact inspected but not credited: `.agent-lab/ed632832-5ab9-4a4c-b2fb-2c00ff7c05d4.json` and its trace journal (demo/compare, not Phase 2 recorded-dialogue scoring)

## Score Calculation

The required deterministic scorer was called with:

```text
covered=2
total=7
infra=ok,partial,ok,ok,ok
```

It returned, verbatim:

```json
{"coverage_score":28.57,"infra_score":90,"overall_score":53.14,"verdict":"SIGNIFICANT GAPS"}
```
