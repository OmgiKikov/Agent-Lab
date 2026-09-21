---
phase: 01-odno-chestnoe-chislo
fixed_at: 2026-09-17T00:00:54Z
review_path: .planning/phases/01-odno-chestnoe-chislo/01-REVIEW.md
iteration: 2
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 1: Code Review Fix Report

**Fixed at:** 2026-09-17T00:00:54Z
**Source review:** .planning/phases/01-odno-chestnoe-chislo/01-REVIEW.md (re-review, 2026-09-16T23:54:43Z)
**Iteration:** 2

**Summary:**
- Findings in scope: 3 (CR-01, WR-01, WR-02)
- Fixed: 3
- Skipped: 0
- Also fixed, because they were cheap: IN-02, IN-03, IN-04. IN-01 was not changed; it records a deliberate choice.

`JUDGE_PROTOCOL` and `VERSION` are unchanged. No runtime dependencies were added, and no new record fields were introduced in this iteration.

Iteration 1 fixed CR-01 and WR-01…WR-06 in commits 209e317…56fed0b; that report is in git history (61a123a).

## Fixed Issues

### CR-01: Stability against a rebuilt source still ignored card edits

**Files modified:** `src/comparison.ts`, `test/result-view.test.ts`
**Commit:** 2108635
**Applied fix:**
- **Shared helper:** a new `sourceCardIdentity` returns the card the source attempts were judged against. For a rebuilt source it reads `identity.scenarios`; otherwise it uses the stored source card.
- **`compareRuns`:** it now calls an internal `compareRunsAgainst` and passes the embedded identity along. The identity survives the selected-subset recursion, which copies `before` and would otherwise lose the rebuilt-source marker. Its changed-cards check uses the helper, so an edited card adds «Содержимое карточек изменилось» and the pair is not comparable.
- **`stabilityBetweenRuns`:** it now skips any card whose identity changed, the same way the reassess check already did.
- **Test (the reviewer's repro):**
  - Setup: a load-suite repeat whose goal `passCriteria` was edited, compared with its rebuilt source.
  - The edited card is not marked unstable, and it is not counted as fixed or regressed.
  - The stability result is identical to the one against the stored source.
- **Needs human check:** this is a logic fix.

### WR-01: The receipt hash was taken over the untrimmed audit

**Files modified:** `src/evaluation.ts`, `test/evaluation.test.ts`
**Commit:** 949a7e9
**Applied fix:**
- **One normalized copy:** `assessTrial`'s `onJudgment` wrapper normalizes the audit once with `judgeAuditSchema.parse`, the same step the store applies. That copy is both passed to the store and sealed into the receipt.
- **Schema rejection:** an audit the schema rejects is passed on unchanged, so the store still raises the persistence error as before.
- **Test:**
  - Setup: a judge error `'429 Too Many Requests\n'`, written through a real `ExperimentStore`.
  - The sidecar fingerprint now equals `auditHash`.
  - With the old `src/evaluation.ts` the test fails; I checked this.
- **Needs human check:** this is a logic fix.

### WR-02: CLI `summary` and `run` did not check receipts against sidecars

**Files modified:** `src/artifacts.ts`, `src/cli.ts`, `test/result-view.test.ts`
**Commit:** f9827af
**Applied fix:**
- **One shared path:** a new `resolveVerified(record, store, sourceId?)` does three things:
  - checks the receipts of a copy of the record against their sidecars;
  - resolves the source run through `resolveSource`;
  - checks the receipts of a stored (not rebuilt) source.
- **Callers:** `evidenceBundle`, CLI `summary` and CLI `run` all use it and show the same warnings. `summary` prints them as «Внимание: …»; `run` adds them to its JSON output as `warnings`.
- **Test:**
  - Setup: CLI `summary` on a live record whose sidecars were edited.
  - The mismatch warning is printed.
  - The first output block equals the Pi bundle view, and the warning matches the bundle's warning.

### IN-03: `omittedLegacyAudits` missed audits inside `before.sourceEvidence`

**Files modified:** `src/report.ts`, `test/artifacts.test.ts`
**Commit:** 46129fd
**Applied fix:** The count now covers each exported run's trials and its embedded source trials, which is exactly what `runWithoutAudits` removes.

### IN-02: `SourceIdentity.manifestHash` was written but never read

**Files modified:** `src/artifacts.ts`, `test/comparison.test.ts`
**Commit:** a40fe88
**Applied fix:** `embeddedBefore` takes `manifestHash` from the identity. If the identity has none, it still falls back to the first trial's hash.

### IN-04: A failed discovery deep check could name a sidecar that was never written

**Files modified:** `src/experiment.ts`, `test/experiment.test.ts`
**Commit:** ad47769
**Applied fix:** `judgeTrialId` is recorded only after a judgment has been reported and written. A flag is set in the `onJudgment` wrapper after the store write succeeds. The test covers a judge that fails before reporting: that deep result has no key.

## Skipped Issues

None of the findings in scope were skipped.

IN-01 (a missing sidecar still leaves the receipt trusted) is left as is. The reviewer describes it as a deliberate choice that lets someone copy only the `.json` file, and the missing sidecar is already stated in a warning.

## Verification

- **Where:** all edits and commits were made in an isolated git worktree on the temporary branch `gsd-reviewfix/01-4092`, created from `9fc0ac2` and then fast-forwarded into `full-project-review-feature-plan`.
  - Tests ran from snapshot copies, using a copy of `snap-test.sh` whose `REPO` points at the worktree and whose `node_modules` link points at the main checkout.
  - The worktree itself had no `node_modules` link, and no stray link was left in the main checkout; I checked this.
  - Nothing was built or tested in the main checkout.
- **Per fix:** `tsc` plus the affected test files, from a snapshot.
- **Full suite:** `snap-test.sh --full` logic (`git archive HEAD`, then `npm test && npm run typecheck`), run on the final commit ad47769: 400 tests, 400 passed, 0 failed; typecheck exit 0.

---

_Fixed: 2026-09-17T00:00:54Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 2_
