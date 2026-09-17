---
phase: 01-odno-chestnoe-chislo
reviewed: 2026-09-17T00:02:54Z
depth: standard
iteration: 3
files_reviewed: 15
files_reviewed_list:
  - src/artifacts.ts
  - src/cli.ts
  - src/comparison.ts
  - src/connection.ts
  - src/contracts.ts
  - src/evaluation.ts
  - src/experiment.ts
  - src/normalize.ts
  - src/report.ts
  - src/result-view.ts
  - test/artifacts.test.ts
  - test/comparison.test.ts
  - test/evaluation.test.ts
  - test/experiment.test.ts
  - test/result-view.test.ts
findings:
  critical: 0
  warning: 0
  info: 3
  total: 3
status: issues_found
---

# Phase 1: Code Review Report (re-review, iteration 3)

**Reviewed:** 2026-09-17T00:02:54Z
**Depth:** standard (diff `9fc0ac2..HEAD`, fix commits `2108635`, `949a7e9`, `f9827af`, `46129fd`, `a40fe88`, `ad47769`)
**Files Reviewed:** 15
**Status:** issues_found (info only, no blockers or warnings)

## Summary

All findings from iteration 2 are resolved except IN-01, which was left unchanged on purpose and is carried over below. The fixes introduced no blocker or warning regressions. The three items left are informational.

| Iteration-2 finding | Status |
|---|---|
| CR-01 card edit reported as instability against a rebuilt source | **Resolved.** `stabilityBetweenRuns` and `compareRuns` now take the source card identity from `sourceCardIdentity`, which uses the embedded identity for a rebuilt source. The selected-tests branch passes the identity explicitly, because its `{...before}` copy is not in the `WeakSet`. The end-to-end test in `test/artifacts.test.ts:112` still expects `fixed.length === 1` after save-suite → load-suite → updateDraft → run. That means fingerprints computed before the save still match the cards after `loadSuite`/`validatePreparation`, so the core portable flow is not made incomparable. The new unit test gives the same stability answer with the stored source and with the rebuilt one. |
| WR-01 receipt hash taken over untrimmed audit | **Resolved.** `assessTrial` normalizes with `judgeAuditSchema.parse` once, then uses that copy both for sealing and for the store. If the parse fails, the raw audit is passed on, so the store still reports the original persistence error. The trimmed prompt and input are unchanged, because `JUDGE_PROMPT` and the JSON input have no whitespace at either end. The legacy full-audit check (`audit.prompt !== JUDGE_PROMPT`) still passes. |
| WR-02 CLI never checked receipts | **Resolved for the view and stability.** `resolveVerified` is now the single path used by `evidenceBundle`, `summary` and `run`. The CLI test shows the same view lines and warnings as the Pi bundle. See IN-02 for a small leftover. |
| IN-02 unused `identity.manifestHash` | Resolved. It is restored in `embeddedBefore`, falling back to the trials when it is null. |
| IN-03 omitted-audit count | Resolved. The count covers each run's trials and embedded source trials, which is exactly what `runWithoutAudits` removes. |
| IN-04 unwritten discovery sidecar named | Resolved. `judgeTrialId` is recorded only after `onJudgment` returned successfully at least once. |
| IN-01 missing sidecar still trusted | Left unchanged on purpose (see below). |

The four areas checked again:
- **Old records:** new fields are still optional. A rebuilt source with no identity still skips stability, and `compareRuns` falls back to the old behaviour (`null ?? undefined`).
- **Stability:** see CR-01 above.
- **Receipts and sidecars:** see WR-01 and WR-02 above.
- **Export sizes:** they only get smaller.

## Narrative Findings (AI reviewer)

## Info

### IN-01: A missing sidecar still leaves the receipt trusted (carried over, accepted)

**File:** `src/artifacts.ts:85-88`
**Issue:** If `{runId}.judge/{trialId}.json` is missing, the receipt is checked only against the record itself and stays `complete`; the user sees only a warning. This was kept on purpose, so that a run can be copied as its `.json` file alone.
**Fix:** None required now. Revisit if the sidecar becomes mandatory for new live records.

### IN-02: CLI `run` still builds `verdict` from the unverified record

**File:** `src/cli.ts:386-392`
**Issue:** The `view` uses `verified.record`. However, `quality`, `evidenceSummary(result).verdict` and `evaluationExitCode(result)` still read `result` directly. `verdictSummary` counts `judge_unaudited` through `hasCompleteJudgment`, so the `verdict.reasons` in the JSON can differ from the Pi bundle's `evidence` when a sidecar does not match. The exit code does not depend on that reason. The mismatch is also unlikely right after the run, because this same process has just written the sidecars. `summary` has the same pattern with `qualitySummary(record)` (line 94), but `QualitySummary` does not expose that reason.
**Fix:** Compute `quality`, `verdict` and `exitCode` from `verified.record`.

### IN-03: A card added after load-suite is reported as "content changed" rather than "card set changed"

**File:** `src/comparison.ts:755-760`
**Issue:** A rebuilt source holds the current cards, so a card added to the draft after load-suite is not listed in `cards.onlyAfter`. Its missing `identity.scenarios` entry makes `sourceCardIdentity` return `undefined`, and the run is marked incomparable with «Содержимое карточек изменилось: …». The result is conservative and correct; only the wording is inaccurate.
**Fix:** When an identity is present, treat cards missing from `identity.scenarios` as `onlyAfter`, which gives «Набор карточек изменился».

---

_Reviewed: 2026-09-17T00:02:54Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
