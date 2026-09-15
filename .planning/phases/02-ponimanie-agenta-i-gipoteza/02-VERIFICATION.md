---
phase: 02-ponimanie-agenta-i-gipoteza
verified: 2026-09-15T18:35:27Z
status: human_needed
score: 20/22 must-haves verified
covered_files:
  - .planning/REQUIREMENTS.md
  - .planning/ROADMAP.md
  - .planning/phases/02-ponimanie-agenta-i-gipoteza/02-01-PLAN.md
  - .planning/phases/02-ponimanie-agenta-i-gipoteza/02-01-SUMMARY.md
  - .planning/phases/02-ponimanie-agenta-i-gipoteza/02-02-PLAN.md
  - .planning/phases/02-ponimanie-agenta-i-gipoteza/02-02-SUMMARY.md
  - .planning/phases/02-ponimanie-agenta-i-gipoteza/02-03-PLAN.md
  - .planning/phases/02-ponimanie-agenta-i-gipoteza/02-03-SUMMARY.md
  - .planning/phases/02-ponimanie-agenta-i-gipoteza/02-AI-SPEC.md
  - .planning/phases/02-ponimanie-agenta-i-gipoteza/02-CONTEXT.md
  - .planning/phases/02-ponimanie-agenta-i-gipoteza/02-PATTERNS.md
  - .planning/phases/02-ponimanie-agenta-i-gipoteza/02-RESEARCH.md
  - .planning/phases/02-ponimanie-agenta-i-gipoteza/02-REVIEW.md
  - .planning/phases/02-ponimanie-agenta-i-gipoteza/02-SECURITY.md
  - .planning/phases/02-ponimanie-agenta-i-gipoteza/02-UI-REVIEW.md
  - .planning/phases/02-ponimanie-agenta-i-gipoteza/02-UI-SPEC.md
  - .planning/phases/02-ponimanie-agenta-i-gipoteza/02-VALIDATION.md
  - extensions/agent-lab.ts
  - skills/agent-builder/SKILL.md
  - src/cli.ts
  - src/contracts.ts
  - src/experiment.ts
  - src/judge.ts
  - src/pi.ts
  - src/prompts.ts
  - src/quality.ts
  - test/comparison.test.ts
  - test/contracts.test.ts
  - test/experiment.test.ts
  - test/extension.test.ts
  - test/judge.test.ts
  - test/pi.test.ts
  - test/quality.test.ts
  - test/skill.test.ts
  - test/workflow.test.ts
covered_digest: "v1:sha256:447fb66f25b7a89f796e089d0fbe9046486b6314dab0a3cb1addd0bae3ab1f51"
behavior_unverified: 2
overrides_applied: 0
unverified_prohibitions: 3
re_verification:
  previous_status: gaps_found
  previous_score: 18/22
  gaps_closed:
    - "RAG/reply-quality and owner-prompt compliance failures can now outrank a generic goal unknown and become the single grounded hypothesis."
    - "CLI score failures now use the required recovery copy and sanitize final stderr, including ANSI/bidi input."
  gaps_remaining: []
  regressions: []
  review_warnings_closed:
    - "A zero-count tool prohibition can no longer be treated as positive action evidence."
    - "Task-schema failures now receive the same score recovery contract as malformed dialogue input."
    - "CLI stderr is flattened to one sanitized line, preventing newline-based status spoofing."
behavior_unverified_items:
  - truth: "Outer Agent Lab actually studies the repository and obeys the pre-test conversational stop, rather than merely containing that instruction in its prompt."
    test: "Run Agent Lab in a real project with one requirement and one contradictory repository/log observation."
    expected: "It cites the owner source plus repository path/line or dialogue/event, proposes one hypothesis, and performs no test-building call before an explicit answer."
    why_human: "The current checks assert prompt/skill text, not the behavior of a real model/tool session."
  - truth: "The four-block Pi result, progress replacement and native confirmation remain readable and correctly ordered at narrow terminal widths."
    test: "Run one native Pi score flow at roughly 40 and 80 columns, including cancel and a long Unicode observation."
    expected: "One replaceable progress row, readable confirmation, vertical blocks without horizontal scrolling, visible artifact access, and zero model use after cancel."
    why_human: "Headless component tests cannot prove terminal focus, perceived layout, or model narration around the tool result."
human_verification:
  - test: "One real Agent Lab/Pi smoke session covering repository/log understanding, native score UX and the three judgment-tier prohibitions"
    expected: "The model cites owner and repository/log evidence, proposes one hypothesis and stops at `Проверим?`; 40/80-column score UI remains readable with ordered progress, consent, cancel and artifacts; code-only invokes no target/simulator/provider; code/assistant/outcome/live prompt never becomes the oracle; rejection or correction creates no test entity."
    why_human: "Real model obedience, terminal focus/wrapping and judgment-tier prohibitions cannot be silently closed by static or headless checks."
---

# Phase 2: Понимание агента и гипотеза — Verification Report

**Phase Goal:** Agent Lab отделяет требования от текущего поведения, использует репозиторий и доступные логи как доказательства и предлагает владельцу одну конкретную гипотезу о сбое для проверки.

**Verified:** 2026-09-15T18:35:27Z  
**Status:** human_needed  
**Re-verification:** Yes — prior code gaps and the final three review warnings are closed on immutable HEAD `70dcb63`.

## Goal Achievement

### Observable Truths

Roadmap criteria and PLAN truths are merged below; equivalent wording is deduplicated without dropping roadmap scope.

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | Requirements, observed behavior and unknowns are separate; code/replies/outcome never become the oracle. | ✓ VERIFIED | `src/pi.ts:509-565`, `src/quality.ts:90-124`; `test/pi.test.ts:604-645` excludes assistant/outcome from expectation input. |
| 2 | The outer agent studies repository/log evidence before proposing a test. | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Contract exists in `skills/agent-builder/SKILL.md:20-53` and `extensions/agent-lab.ts:146`; current tests inspect instruction text rather than a real model/tool session. |
| 3 | JSON/JSONL imports offline, preserving one dialogue → one scenario/trial and exact event order/content. | ✓ VERIFIED | `src/imports.ts:5-13`, `src/contracts.ts:363-395`, `src/experiment.ts:171-235`; exact-value coverage in contract/workflow tests. |
| 4 | Invalid, empty, oversized or user-less input fails atomically before persistence/success. | ✓ VERIFIED | Schema/import prechecks plus negative CLI tests proving no partial record; task-schema failure now uses the same recovery contract as malformed dialogue input. |
| 5 | Imported trials truthfully say state missing/tools partial, have zero execution usage, no simulator grading, and separate goal/reply rubrics. | ✓ VERIFIED | `src/contracts.ts:184-195,386-395`; direct value assertions in `test/contracts.test.ts`. |
| 6 | Limits 40/41/200 work without truncation; 201 and duration above 14,400,000 ms reject. | ✓ VERIFIED | Boundary behavior at `test/experiment.test.ts:587-635`. |
| 7 | Repeated derivation is immutable and overlapping writes reject rather than interleave. | ✓ VERIFIED | Reassessment/writer tests at `test/experiment.test.ts:622-634,770-790`. |
| 8 | Model criterion input contains owner sources/current-dialogue user turns only. | ✓ VERIFIED | `src/experiment.ts:184-211`, `src/pi.ts:509-565`; assistant/outcome variance does not change payload. |
| 9 | Every model goal is one-to-one, cites a known owner requirement and preserves a verbatim opening. | ✓ VERIFIED | `src/contracts.ts:325-343`, `src/experiment.ts:194-209`; invalid-link tests reject publication. |
| 10 | Goal, reply and conditional prompt metrics remain distinct and ordered. | ✓ VERIFIED | Reserved contracts plus conditional `promptCompliance`; assessment ordering is asserted. |
| 11 | Unsupported action completion becomes unknown while reply quality remains independently assessable. | ✓ VERIFIED | Deterministic postcondition in `src/judge.ts:63-86`; adversarial coverage includes failed/unrelated tools, incomplete state, self-attestation and `tool_count min: 0`, which cannot serve as positive evidence. |
| 12 | A grounded RAG or owner-prompt failure outranks a generic goal unknown and can drive the one useful hypothesis. | ✓ VERIFIED | `src/quality.ts:62-87` accepts fail-first goal/reply plus prompt compliance only when the sole owner source is `kind: prompt`; positive/negative regressions at `test/quality.test.ts:147-176`. |
| 13 | Reassessment copies immutable traces, uses saved sources, regrades, reclusters, and retains assessments if clustering fails. | ✓ VERIFIED | `src/experiment.ts:352-420`; value/behavior coverage at `test/experiment.test.ts:637-724`. |
| 14 | Code-only makes zero model calls and no clusters; model-backed work shares one bounded call budget. | ✓ VERIFIED | Runtime exclusion and carried usage are asserted at `test/experiment.test.ts:694-723`. |
| 15 | CLI model score requires `--yes`, returns first-screen data/artifacts, and uses exit 2 for score failures without target/simulator execution. | ✓ VERIFIED | `src/cli.ts:167-205`; subprocess coverage in `test/workflow.test.ts:280-335`. |
| 16 | Populated output has fixed four-block order, bounded evidence, one hypothesis and literal `Проверим?`. | ✓ VERIFIED | Shared projection/renderers plus referential-integrity tests in `test/quality.test.ts`. |
| 17 | Missing grounding yields the exact insufficient state and no invented hypothesis. | ✓ VERIFIED | `src/quality.ts:49-53,90-94`; broken-link/open-question cases fail closed. |
| 18 | Loading/judging progress uses factual K/D wording and never labels judging before reassessment. | ✓ VERIFIED | `extensions/agent-lab.ts:217-251`; ordering assertion in `test/extension.test.ts:489-530`. Native row replacement remains UAT. |
| 19 | CLI malformed/unreadable input shows full recovery copy and sanitizes final stderr. | ✓ VERIFIED | `src/cli.ts:25-27,173-181,267`; malformed dialogue, invalid task schema and hostile ANSI/bidi/newline pathname regressions share the recovery copy and one-line safe stderr. |
| 20 | Partial action evidence is shown as НЕЯСНО while answer/prompt quality remains independently assessable. | ✓ VERIFIED | `src/quality.ts:101-116`, `src/judge.ts:80-86`; fail-first candidate tests preserve the separate unknown. |
| 21 | Narrow-width wrapping, 240-character preview and complete artifact access are correct in real Pi. | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Pure preview and structured artifact paths exist; real terminal focus/wrapping/compact presentation remains manual. |
| 22 | No test/hypothesis entity is built, run or persisted before explicit owner confirmation. | ✓ VERIFIED | Skill/injected system contract contains the stop; no Phase-2 hypothesis persistence schema exists. Real-model obedience is in human verification. |

**Score:** 20/22 truths verified (2 present/behavior-unverified, 0 failed).

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src/contracts.ts` | Offline rubrics, dialogue conversion and judge receipt schema | ✓ VERIFIED | Substantive, imported and exercised; receipt now retains optional configuration hash. |
| `src/experiment.ts` | Score/reassess lifecycle | ✓ VERIFIED | Imports, immutable reassessment, budget carry and saved-source clustering are wired. |
| `src/pi.ts` | Source-and-user-only goal extraction | ✓ VERIFIED | Validates one dialogue and known owner requirement links. |
| `src/judge.ts` | Protocol 8, action evidence and receipt freshness | ✓ VERIFIED | All required state predicates must pass; zero-count tool checks cannot prove success; prompt/protocol/configuration receipt consistency is enforced. |
| `src/quality.ts` | One grounded score brief | ✓ VERIFIED | Fail-first RAG and owner-prompt candidates are grounded; unrelated source kinds cannot masquerade as prompt evidence. |
| `src/cli.ts` | CLI score, artifacts and safe error boundary | ✓ VERIFIED | Dialogue parsing, task-schema validation and connection resolution share `scoreInputError`; all process-level stderr crosses newline-flattening `safeLine`. |
| `extensions/agent-lab.ts` | Pi score, native consent, progress and artifacts | ✓ VERIFIED | Structured results contain artifacts and confirmation precedes model work. Native presentation needs UAT. |
| `skills/agent-builder/SKILL.md` | Pre-test conversational contract | ✓ VERIFIED | Substantive and loaded by chat entrypoint. Behavior needs UAT. |

### Key Link Verification

The GSD key-link query cannot parse PLAN `from:` values containing `:symbol`; links were traced manually.

| From | To | Via | Status | Details |
|---|---|---|---|---|
| CLI | import → `ExperimentLab.score` | `readData(..., 'dialogues')`, then `lab.score` | ✓ WIRED | `src/cli.ts:167-186`. |
| score | converters → store | per-dialogue scenario/trial plus appendTrace/checkpoint | ✓ WIRED | `src/experiment.ts:194-235`. |
| score | runtime goals → validation | one cloned dialogue plus owner sources/requirements | ✓ WIRED | `src/experiment.ts:184-209`, `src/pi.ts:509-565`. |
| reassess | judge → saved-source clustering | copied traces, assessment, `nameFailureModes` | ✓ WIRED | `src/experiment.ts:352-420`. |
| `scoreBrief` | requirement/source → assessment → event | strict direct referential chain | ✓ WIRED | `src/quality.ts:62-87`; failure modes are intentionally not trusted because they lack metric/evidence/requirement provenance. |
| CLI + Pi | `scoreBrief` → artifacts | shared projection and existing exporters | ✓ WIRED | `src/cli.ts:191-203`, `extensions/agent-lab.ts:240-258`. |
| skill | injected Pi contract | same headings/CTA/stop rule | ✓ WIRED | `skills/agent-builder/SKILL.md:24-49`, `extensions/agent-lab.ts:146`. |

### Data-Flow Trace (Level 4)

| Artifact | Data | Source | Produces Real Data | Status |
|---|---|---|---|---|
| CLI/Pi score | dialogues | owner JSON/JSONL through readData/Zod | Yes; exact ordered message arrays | ✓ FLOWING |
| Persisted evidence | scenarios, trials, journal | converters → atomic store/append-only trace | Yes; local 0600 files | ✓ FLOWING |
| Model assessment | requirements/goals/judgments | owner sources + user turns → validated runtime output | Yes, with citations/receipts; provisional, not ground truth | ✓ FLOWING |
| Compact brief | requirement + assessment + event | persisted record only | Yes; fail-first and broken links fail closed | ✓ FLOWING |
| Artifact paths | report/snapshot/evidence/journal | evidenceBundle → exportArtifacts | Yes; structured CLI/Pi result points to local files | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Evidence | Result | Status |
|---|---|---|---|
| Full workspace gate | Orchestrator reported `npm test` 302/302 and strict typecheck green on HEAD `70dcb63`; verifier was explicitly asked not to rerun. | green | ✓ PASS (orchestrator evidence) |
| RAG/prompt hypothesis priority | Active value tests cover reply fail, owner-prompt fail and non-prompt rejection. | expected exact candidates | ✓ COVERED |
| Action completion/receipt freshness | Active tests cover self-attestation, failed/unrelated tools, zero-count prohibitions, all-state predicates and stale prompt/protocol receipts. | fail closed | ✓ COVERED |
| CLI recovery/sanitization | Subprocess tests cover invalid dialogue JSON, invalid task schema and hostile ANSI/bidi/newline pathname. | exit 2, single-line safe recovery text | ✓ COVERED |

### Probe Execution

No Phase-02 probe is declared and no `scripts/**/tests/probe-*.sh` exists. **N/A.**

### Requirements Coverage

| Requirement | Status | Evidence |
|---|---|---|
| LOOP-01 | ? NEEDS HUMAN | Four-block separation is implemented; actual repository inspection/model behavior needs native-session UAT. |
| LOOP-02 | ✓ SATISFIED | Owner-source/user-only payload and strict requirement/source/quote links. |
| LOOP-03 | ✓ SATISFIED | One grounded fail-first RAG/prompt hypothesis and literal confirmation question. |
| SCORE-01 | ✓ SATISFIED | JSON/JSONL + task/material import on CLI/Pi. |
| SCORE-02 | ✓ SATISFIED | One-to-one scenario/trial and full ordered event evidence, including long dialogues. |
| SCORE-03 | ✓ SATISFIED | Offline target/simulator isolation and code-only zero calls; missing/partial observation. |
| SCORE-04 | ✓ SATISFIED | Separate goal/reply metrics and conditional prompt compliance. |
| SCORE-05 | ✓ SATISFIED | Criteria come from owner sources/user turns; assistant/outcome excluded. |
| SCORE-06 | ✓ SATISFIED | Unsupported action completion is deterministically unknown; reply assessment remains separate. |
| SCORE-07 | ✓ SATISFIED | Reassess copies facts/rebuilds clusters; code-only makes no model clusters. |
| SCORE-08 | ? NEEDS HUMAN | Automated CLI/Pi pathways, consent, first-screen data and artifacts pass; native Pi presentation remains UAT. |

No Phase-02 requirement is orphaned from the three plans.

### Test Quality Audit

| Test Area | Linked Req | Active | Skipped | Circular | Assertion Level | Verdict |
|---|---|---:|---:|---|---|---|
| contracts/import | SCORE-01/02/03/04 | yes | 0 | no | value + boundary | PASS |
| experiment/reassess | SCORE-03/05/07 | yes | 0 | no | behavioral + immutable-state | PASS |
| judge/receipt | SCORE-04/06 | yes | 0 | no | behavioral + adversarial | PASS |
| quality/brief | LOOP-01/02/03 | yes | 0 | no | value + referential integrity | PASS |
| CLI/Pi adapters | SCORE-01/08 | yes | 0 | no | subprocess + integration | PASS automated; real terminal pending |

Fixture writers create independent inputs/targets and do not derive expected outputs from the system under test. No disabled requirement test or circular oracle was found.

### Anti-Patterns Found

No unreferenced `TBD`/`FIXME`/`XXX`, disabled requirement tests, placeholder implementation, circular oracle or remaining blocker regression was found. Re-verification advisory: **None.**

### Decision Coverage

No trackable decisions were found in `02-CONTEXT.md`; the non-blocking gate was skipped.

### Human Verification Required

#### 1. One real Agent Lab/Pi smoke session

**Test:** In one real local project, give Agent Lab an owner requirement plus contradictory repository/log evidence, reject or correct its first proposal, then score one long Unicode dialogue at approximately 40 and 80 columns, including consent, cancel and code-only paths.  
**Expected:** The model cites both sources, proposes exactly one hypothesis, ends with `Проверим?`, and creates/runs/saves nothing before acceptance; progress replaces one row, the four blocks wrap readably, artifacts remain reachable, and cancel spends zero model calls. Code-only opens no target/simulator/provider, while code/assistant/outcome/live prompt never becomes the expected truth.  
**Why human:** Real-model obedience, terminal focus/wrapping and the three PLAN judgment-tier prohibitions cannot be silently closed by static or headless checks. Automated spies and payload assertions already support the prohibitions; this is the single remaining UAT gate.

### Deferred / Explicitly Not Claimed

This report does **not** claim live integration with the acquiring or cash-collection agents, IdP RAG, IFT or Sigma. Phase 2 establishes repository/log understanding and offline scoring. The roadmap assigns execution through the real agent connection to Phase 4 (“Настоящий запуск и доказательства”).

### Gaps Summary

Both prior code gaps and all three final review warnings are closed; no automated blocker remains. Phase 2 is `human_needed`, not `passed`, only because one real native Agent Lab/Pi smoke session must cover the two user-facing behaviors and three judgment-tier prohibitions.

---

_Verified: 2026-09-15T18:35:27Z_  
_Verifier: Codex (gsd-verifier)_
