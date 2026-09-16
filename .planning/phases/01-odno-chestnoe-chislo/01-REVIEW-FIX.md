---
phase: 01-odno-chestnoe-chislo
fixed_at: 2026-09-16T23:49:08Z
review_path: .planning/phases/01-odno-chestnoe-chislo/01-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 7
skipped: 0
status: all_fixed
---

# Phase 1: Code Review Fix Report

**Fixed at:** 2026-09-16T23:49:08Z
**Source review:** .planning/phases/01-odno-chestnoe-chislo/01-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 7 (CR-01, WR-01…WR-06)
- Fixed: 7
- Skipped: 0
- Also fixed: the verifier's wording mismatch in the control warning (separate commit)

`JUDGE_PROTOCOL` and `VERSION` are unchanged. No new runtime dependencies were added. Every new record field is optional, so old records open without migration.

## Fixed Issues

### CR-01: A source rebuilt from embedded evidence defeated the stability checks

**Files modified:** `src/contracts.ts`, `src/normalize.ts`, `src/connection.ts`, `src/artifacts.ts`, `src/comparison.ts`, `test/result-view.test.ts`, `test/comparison.test.ts`, `test/artifacts.test.ts`
**Commit:** 209e317
**Applied fix:**
- `sourceEvidence` has a new optional `identity` field. It holds the source run's `targetFingerprint`, `targetVersion`, `evaluatorVersion` and `manifestHash`, plus fingerprints of the agent definition, the judge settings and each card. `suiteEvidence` writes it for both save-suite and reassess.
- `embeddedBefore` copies these fields from `identity` and registers the rebuilt run with `markReconstructedSource`.
- Both stability functions use the embedded identity for a rebuilt source. If the identity is missing (an older record), they return «Стабильность не проверена: исходный прогон недоступен».
- The repeat check now also compares the agent definition (`revisions[0].spec`). Without that, a changed sandbox agent was still reported as instability.
- **Behaviour change:** a rebuilt source now carries its original `evaluatorVersion`. As a result, `compareRuns` calls a suite saved by an older Agent Lab build incomparable, the same way it already does when the parent run is on disk.
- **Needs human check:** this is a logic fix.

### WR-06: The CLI treated any read error of the source run as "missing"

**Files modified:** `src/artifacts.ts`, `src/cli.ts`, `test/artifacts.test.ts`, `test/result-view.test.ts`
**Commit:** c858f78
**Applied fix:**
- New shared helper `resolveSource`, used by `evidenceBundle`, CLI `summary` and CLI `run`.
- Only `ENOENT` falls back to the embedded copy, and a warning says so.
- Other read errors are named in the warning, and the embedded copy is not used. This covers corrupt JSON, a schema violation, the 50 MB limit, EACCES and an ID mismatch.
- CLI `summary` prints the warning as «Внимание: …» (and in `--json` as `warnings`); `run` adds `warnings` to its JSON output.
- New test: a real CLI run on a corrupt parent file.

### WR-04: After any Agent Lab upgrade, reassessment stability always blamed the judge

**Files modified:** `src/comparison.ts`, `test/comparison.test.ts`, `test/result-view.test.ts`
**Commit:** 1383aa1
**Applied fix:**
- `stabilityAfterReassess` no longer compares `evaluatorVersion`, which includes `VERSION`. It now compares two things:
  - the configured judge: provider, model and upstream, via `judgeSettingsIdentity`, with the role taking precedence as it does at runtime;
  - the protocol hashes on the recorded votes, which include the judge configuration hash.
- The existing tests now change the judge itself rather than `evaluatorVersion`.
- New test: an upgrade with the same judge still finds the flip.
- **Needs human check:** this is a logic fix.

### WR-03: The exclusion breakdown did not add up once pairs were excluded for incomplete judgment

**Files modified:** `src/comparison.ts`, `test/comparison.test.ts`
**Commit:** b519948
**Applied fix:**
- New field `coverage.excludedBy`. It counts each excluded pair once, by its first reason: invalid or missing «до», invalid or missing «после», judge did not finish, or other (duplicated or unplanned attempts, which cover the remainder).
- The note now uses these counts and adds «без завершённой оценки судьи — K» and, when needed, «повторённые или лишние попытки — R».
- The existing per-trial coverage fields are unchanged.

### WR-02: A failed judgment left no receipt

**Files modified:** `src/evaluation.ts`, `test/evaluation.test.ts`
**Commit:** ee28079
**Applied fix:**
- `assessTrial` now seals the receipt in a `finally` block.
- A rejected or failed judgment keeps a receipt with `complete: false`, so reports still name the judge and point to the sidecar.
- The test confirms that `hasCompleteJudgment` returns false for such a receipt even when `assessmentError` is cleared.

### WR-05: Discovery wrote sidecars and journal entries keyed by the dialogue id

**Files modified:** `src/experiment.ts`, `src/contracts.ts`, `test/experiment.test.ts`
**Commit:** 37bf4c2
**Applied fix:**
- Each deep check now gets its own key, `deep-<uuid>`, for every attempt. A retry or resume can no longer overwrite an earlier audit.
- The key is stored as the optional `judgeTrialId` in the discovery deep result, so the record points to its sidecar and journal entries. The files live under the discovery record's own `{id}.judge/` directory.
- The key is removed before the hypothesis model sees the results.
- The test checks three things: every key is unique, a sidecar exists for each key, and no sidecar is named after a dialogue id.

### WR-01: Receipts were never checked against the sidecar, and exports claimed to hold raw judge answers

**Files modified:** `src/artifacts.ts`, `src/report.ts`, `test/artifacts.test.ts`
**Commit:** 00627aa
**Applied fix:**
- **Receipt check:** `evidenceBundle` compares each receipt's `auditHash` with its sidecar when it can read the file. It checks the current run and a real (not rebuilt) source run.
  - If the hashes differ, or the file cannot be read, the receipt is marked incomplete in the bundle's copy only, so comparisons leave it out, and a warning lists the affected attempts.
  - If the file is missing, the record-only check stays as before, and a warning says so.
- **JSON export:** full `judgeAudit` objects are removed from `experiment`, `before` and `sourceEvidence`. A new `judgeAudits` block gives the count of removed audits and says where the full answers are kept.
- **Report text:** the HTML footer and the legacy judge lines (HTML and Markdown) now say that full judge answers stay in the local Agent Lab directory, not in the export.
- **Needs human check:** this is a logic fix.

### Verifier note: the control warning wording did not match the control line

**Files modified:** `src/result-view.ts`, `test/result-view.test.ts`
**Commit:** 56fed0b
**Applied fix:** The top warning now uses the same word as the control line: «Контроль не пройден — …», «Контроль не измерен — …», or «Контроль не пройден или не измерен — …» when both apply. There is a test for each case.

## Verification

- **Where:** all edits and commits were made in an isolated git worktree on the temporary branch `gsd-reviewfix/01-84670`, which was then fast-forwarded into `full-project-review-feature-plan`.
  - Tests ran from snapshot copies, never in the live `dist/`. I used a copy of `snap-test.sh` whose `REPO` points at the worktree and whose `node_modules` link points at the main checkout.
  - Nothing was built or tested in the main checkout.
- **Per fix:** `tsc` plus the affected test files, from a snapshot.
- **Full suite:** `snap-test.sh --full` logic (`git archive HEAD`, then `npm test && npm run typecheck`), run on the final commit 56fed0b: 397 tests, 397 passed, 0 failed; typecheck exit 0.

---

_Fixed: 2026-09-16T23:49:08Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
