---
phase: 01-odno-chestnoe-chislo
reviewed: 2026-09-16T23:32:23Z
depth: standard
files_reviewed: 30
files_reviewed_list:
  - src/artifacts.ts
  - src/cli.ts
  - src/comparison.ts
  - src/connection.ts
  - src/contracts.ts
  - src/evaluation.ts
  - src/experiment.ts
  - src/judge.ts
  - src/normalize.ts
  - src/quality.ts
  - src/report.ts
  - src/result-view.ts
  - src/store.ts
  - extensions/agent-lab.ts
  - extensions/cards.ts
  - test/artifacts.test.ts
  - test/cards.test.ts
  - test/comparison.test.ts
  - test/evaluation.test.ts
  - test/experiment.test.ts
  - test/extension.test.ts
  - test/judge.test.ts
  - test/normalize.test.ts
  - test/quality.test.ts
  - test/result-view.test.ts
  - test/store.test.ts
  - test/workflow.test.ts
  - .planning/phases/01-odno-chestnoe-chislo/live-check.mjs
  - .planning/phases/01-odno-chestnoe-chislo/verify-stored-runs.mjs
  - .planning/phases/01-odno-chestnoe-chislo/snap-test.sh
findings:
  critical: 1
  warning: 6
  info: 2
  total: 9
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-09-16T23:32:23Z
**Depth:** standard (diff `428d803..HEAD`)
**Files Reviewed:** 30
**Status:** issues_found

## Summary

I reviewed the phase 1 changes: ResultView (`src/result-view.ts`), `cardVerdict` and reason codes, stability (`stabilityBetweenRuns` / `stabilityAfterReassess`), the judge-audit sidecar and sealed receipt, `goalObservation` normalization, `scoreSettings`, and positive controls. Most of the changes hang together. The headline counting is pure and the same on every surface. `JUDGE_PROTOCOL` is unchanged. The judge-input hash still excludes receipts and assessments.

The main defect is in stability. When the source run is rebuilt from embedded evidence (`embeddedBefore`), the "agent changed" check and the "judge or criteria changed" check both always pass. As a result, real regressions and fixes can be reported as "нестабильно". The other findings cover evidence portability after the move to the sidecar, and a coverage note whose numbers no longer add up.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: A source rebuilt from embedded evidence defeats the stability checks, so changes are reported as instability

**File:** `src/artifacts.ts:26-44`, `src/comparison.ts:602-616`, `src/comparison.ts:623-642`, `src/cli.ts:392-398`, `src/cli.ts:453-458`
**Issue:** `embeddedBefore` builds the "before" run as `structuredClone(record)` and swaps in only the trials and human reviews. Every field the stability checks rely on therefore comes from the *current* record: `targetFingerprint`, `targetVersion`, `evaluatorVersion`, `settings` and `scenarios`. As a result:
- In `stabilityBetweenRuns`, the check `before.targetFingerprint !== after.targetFingerprint || before.targetVersion !== after.targetVersion` can never fire. `compareRuns` does not look at the agent's identity at all. The standard regression flow is save-suite, then load-suite against a new agent version: `loadSuite` sets `parentRunId = previous.parentRunId`, and the original run is usually not in the new directory. In that flow every real fix or regression of the goal verdict appears as "Нестабильных: N". That wrongly calls the agent change noise, and it contradicts the file's own promise ("a change of the agent … is never called instability").
- In `stabilityAfterReassess`, if the source run is missing, both the `evaluatorVersion` check and the per-card `fingerprint(normalizeScenarioIdentity(...))` check compare the record with itself. A reassessment with a new `--judge` or changed `criteria` then reports every changed verdict as instability.

The CLI `summary`/`run` paths (`catch { before = embeddedBefore(...) }`) and `evidenceBundle` reach this path. The latter feeds the board, the Pi tools and the HTML report.

**Fix:** Do not claim stability against a reconstructed source. Either mark it as skipped:
```ts
// artifacts.ts evidenceBundle and cli.ts summary/run
const embedded = bundle.comparisonSource?.kind === 'embedded';
bundle.view = buildResultView(snapshot, embedded ? {} : { before: bundle.before });
```
or add a `reconstructed` flag to the rebuilt record and return `{ ...result, skipped: 'исходный прогон недоступен' }` from both stability functions. Alternatively, store the source run's `targetFingerprint`, `targetVersion`, `evaluatorVersion` and scenario fingerprints in `sourceEvidence`, and compare against those. Add a test: load a suite with a changed `targetVersion` and the parent missing; stability must be skipped, not show flips.

## Warnings

### WR-01: Judge receipts are never checked against the sidecar, and exported artifacts lost the raw judge answers

**File:** `src/judge.ts:119-128`, `src/store.ts:159-168`, `src/report.ts:219-222`, `src/report.ts:1346-1352 (judgeHTML)`
**Issue:** `hasCompleteReceipt` trusts `receipt.votes` as written in the record. `auditHash` is sealed but never compared with `{runId}.judge/{trialId}.json`: `readJudgeAudit` is used only in tests. The old path re-parsed each raw response (`parseJudgment(attempt.raw, …)`). The receipt path checks only that the record agrees with itself. An edited or corrupted record, with matching votes and assessments, passes as "complete". Separately, `jsonReport` now replaces the trace journal content with `{ file, bytes }`, and the HTML/Markdown reports point to a sidecar path "рядом с записью прогона". Neither file is in `exports/`. A forwarded report or snapshot, which is the product's hand-off format, therefore no longer carries any raw judge responses, even though the HTML footer still says "полные данные … доступны в JSON-снимке".
**Fix:** In a verifier that has store access (e.g. `evidenceBundle`), load the sidecar and require `fingerprint(audit) === receipt.auditHash`; downgrade to incomplete and add a warning on mismatch or a missing file. Either include the final sidecar audits in the exported snapshot, or reword the report text and footer to say that raw judge answers stay in the local `.agent-lab` directory only.

### WR-02: A failed judgment leaves no receipt, so reports and comparisons lose the pointer to its audit

**File:** `src/evaluation.ts:294-311`
**Issue:** `trial.judgeReceipt` is set only after `runtime.assess` resolves. If the judge rejects a response or a save fails, `assess` throws, `latest` is dropped, and the trial keeps only `assessmentError`. Before this change the record kept `judgeAudit` for exactly these attempts. `judgeSummary`/`judgeHTML` now print nothing, so the judgments that most need inspection have no link to their sidecar file in the report. `judgeModel` also cannot name the judge from these trials.
**Fix:** Seal the receipt in a `finally` block:
```ts
let mapped;
try { mapped = ...await runtime.assess(...)...; return mapped; }
finally { if (latest) trial.judgeReceipt = sealJudgeReceipt(latest, !!mapped && hasCompleteJudgment({...})); }
```
`hasCompleteReceipt` already rejects trials with `assessmentError`, so a receipt with `complete: false` is safe.

### WR-03: The coverage note's breakdown no longer adds up once pairs are excluded for incomplete judgment

**File:** `src/comparison.ts:741-746`
**Issue:** Pairs excluded as `JUDGE_INCOMPLETE` are subtracted from `validPairs`, so they count toward `excludedPairs`. They are not counted in `invalidBefore`, `invalidAfter`, `missingBefore` or `missingAfter`. The note "Исключено N: до — a невалидных и b пропущенных; после — …" can then show an N larger than the sum of its parts, with nothing explaining the difference. Before this change a single unaudited trial made the whole run incomparable, so the case never came up.
**Fix:** Count the exclusions, e.g. `result.coverage.judgeIncomplete`, and add "; без завершённой оценки судьи — K" to the note.

### WR-04: After any Agent Lab upgrade, reassessment stability always blames "the judge"

**File:** `src/comparison.ts:626`, `src/pi.ts:77`
**Issue:** `evaluatorVersion` includes `VERSION` and the simulator protocol, and `reassess` recomputes it from the current code. Reassessing any run recorded by an earlier build therefore always returns `skipped: 'судья или его настройки изменились'`, even when the judge model and protocol are identical. The check itself is conservative, but the wording is false and will mislead the customer.
**Fix:** Compare the judge identity instead: `settings.judge`/`roles.judge` plus the receipt/audit `protocolHash`. Otherwise, reword the skip reason to "версия оценщика изменилась".

### WR-05: Discovery writes sidecar and journal judgments for trials that are not in the record, keyed by dialogue id

**File:** `src/experiment.ts:1004` (discovery `assessTrial`), `src/experiment.ts:967-971`
**Issue:** Discovery calls `assessTrial` with the launch context, so `onJudgment` writes `{recordId}.judge/{dialogueId}.json` and journal entries for temporary trials that are never added to `record.trials`. If the same dialogue is judged again (another batch or a resume), it silently overwrites the earlier sidecar. Nothing in the record points to these files, and they hold bank dialogue content outside any trial the user can see.
**Fix:** Pass a context with `onJudgment` removed (or pointing at a separate discovery journal) for discovery judgments, or key the files by a trial id that is unique per focus.

### WR-06: The CLI treats any read error of the source run as "missing"

**File:** `src/cli.ts:395-396`, `src/cli.ts:455-456`
**Issue:** `catch { before = embeddedBefore(...) }` swallows every error: schema violation, a record over 50 MB, EACCES, an ID mismatch. It then silently uses the reconstructed source (see CR-01). Unlike `evidenceBundle`, which explains the fallback, `summary` prints no warning. A corrupted parent leads to a stability line with no hint of why.
**Fix:** Fall back only on `ENOENT`, and print the same warning text that `evidenceBundle` uses. Better still, reuse `evidenceBundle` (or a shared `resolveSource` helper) so the CLI and Pi resolve the source run the same way.

## Info

### IN-01: The control line is shown on every result, including runs that have no controls

**File:** `src/result-view.ts:1583-1598 (controlLine)`, `src/result-view.ts:1613`
**Issue:** `resultViewLines` always adds "Контроль: не задан." to the first block, which adds noise to the 10-second answer for most runs. When there are several controls and some are still running, the line reads "Контроль: пройдено 0 из 2." without saying they are still being checked.
**Fix:** Leave the line out when `control.cards` is empty. For several controls, add "ещё проверяется: K" when any control has the reason `in_progress`.

### IN-02: `normalizeScenarioIdentity` only renames `withDefaultGoalObservation`

**File:** `src/normalize.ts:22-24`
**Issue:** It is a pure alias. It documents intent but adds a second name for the same behaviour.
**Fix:** Keep it only if more identity rules are planned. Otherwise call `withDefaultGoalObservation` directly.

---

_Reviewed: 2026-09-16T23:32:23Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
