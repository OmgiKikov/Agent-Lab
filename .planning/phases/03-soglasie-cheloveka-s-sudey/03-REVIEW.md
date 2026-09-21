---
phase: 03-soglasie-cheloveka-s-sudey
reviewed: 2026-09-17T14:47:16Z
depth: standard
files_reviewed: 21
files_reviewed_list:
  - extensions/agent-lab.ts
  - extensions/cards.ts
  - src/agreement.ts
  - src/cli.ts
  - src/comparison.ts
  - src/contracts.ts
  - src/experiment.ts
  - src/explain.ts
  - src/outcomes.ts
  - src/result-view.ts
  - test/agreement.test.ts
  - test/cards.test.ts
  - test/comparison.test.ts
  - test/contracts.test.ts
  - test/experiment.test.ts
  - test/explain.test.ts
  - test/extension.test.ts
  - test/helpers/copy-check.ts
  - test/outcomes.test.ts
  - test/result-view.test.ts
  - test/store.test.ts
findings:
  critical: 2
  warning: 6
  info: 3
  total: 11
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-09-17T14:47:16Z
**Depth:** standard
**Files Reviewed:** 21
**Status:** issues_found

## Summary

I reviewed the diff `2a97189..HEAD`: the quick agreement mark (schema, lab guard, board keys, Pi handler), `judgeAgreement` and the pass sample, the agreement row, the disagreement section, the F8 next-step row, and the changes to `awaitingVerdict`, `humanFindings`, `agentMetricResult` and `trialAssessmentComplete`.

Parts that hold up:
- **Old records still parse.** Every new field is optional, the new refine only applies when `source === 'quick'`, and a legacy review round-trips unchanged.
- **The lab, not the caller, fills in the judge verdict and version.** The lab overwrites both from the trial.
- **Agreement is counted on `trial.assessments`**, not on the human-overridden result.
- **Keys stay in their sections.** `y`/`n`/`s` fire only when `agreementTarget` is `ready` in section 3. `y`/`e` stay limited to the expectations sheet.
- **One count on every surface.** The CLI, the Pi block and the board all read `view.agreement`.

The serious problems are in how the agreement queue and a quick mark relate to the headline number and to the review gate. I confirmed the key cases with a scratch script against `src/`, without touching `dist/`:
1. **The queue counts situations the headline doesn't.** The agreement queue and its count include situations the headline reports as «не измерено». A mark on them never moves the number, but the notice says it did.
2. **One mark closes the whole situation.** A quick mark on the primary rubric takes the situation out of the review gate, even when other recorded failures on it were never reviewed. When a card has no goal rubric, a «не согласен» is listed as overturning the judge while the card stays failed.

## Critical Issues

### CR-01: Agreement queue and count include situations the headline cannot measure

**File:** `src/agreement.ts:63-72` (also `extensions/cards.ts:60-68`, `extensions/agent-lab.ts:963`)
**Issue:** `situations()` keeps every non-control trial that has a primary rubric. It never checks `measurementUsable`: simulator deviation, `assessmentError`, a whole-dialogue `invalid` verdict, or unconfirmed reset. `agreementTarget` has the same gap. As a result:
- **Counts drift from the headline.** A judge failure on a trial whose simulator deviated is in `queueFailures`, so the board and CLI show «провалы: 0 из 1» for a situation the headline shows as «? … симулятор отклонился».
  - Reproduced: `cardVerdict` → `{ outcome: 'unknown', reason: 'simulator_deviated' }`, while `judgeAgreement(...).queueFailures` still contains that trial.
- **The notice is false.** The owner presses `n`, gets «Итог пересчитан с учётом вашей отметки», and `goalCardOutcome` still returns `unknown`. The mark moved nothing, but it is counted as checked.
- **F8 never goes quiet.** A dialogue the owner already marked `invalid` through `v` stays in `unmarked` forever. The «Отметить согласие…» row never disappears (reproduced), and the header stays in the warning state.

**Fix:** Build the queue only from situations the headline can decide, and refuse the keys on the others:
```ts
// agreement.ts — situations()
const reviews = record.humanReviews;
if (!scenario || controls.has(scenario.id) || !measurementUsable(scenario, trial, reviews)) return [];
```
Do the same in `agreementTarget`: return `{ kind: 'undecided' }` (or a new `unmeasured` kind with its own muted row) when `!measurementUsable(...)`. Also add a guard in `ExperimentLab.addHumanReview` for `source === 'quick'`.

### CR-02: One quick mark on the primary rubric closes a situation with other unreviewed failures; with no goal rubric a «не согласен» does not move the card

**File:** `src/comparison.ts:226-231` (with `extensions/agent-lab.ts:963`)
**Issue:** `awaitingVerdict` returns `false` as soon as the latest review of the primary metric is a quick `pass`/`fail`. It skips the later check that every failed objective check and every failed agent rubric has a decisive verdict. Two confirmed consequences:
1. **Failed checks leave the queue unreviewed.** Take a sampled pass (goal = pass) whose objective check failed (`trial.outcome = 'fail'`). Pressing `y` («согласен, справился») removes it from the queue, and `f` can finalize the audit. Nobody looked at the failed check. Reproduced: `awaitingVerdict` size goes from 1 to 0.
2. **Without a goal rubric, the overturn is only on paper.** Take a card whose agent rubrics are `prompt_compliance` = fail and `tone` = fail. `primaryMetricId` picks `prompt_compliance`, and `n` flips only that rubric. Then:
   - `cardOutcome` still returns `fail` (reproduced: `{ outcome: 'fail' }` before and after).
   - The disagreement list shows «Судья: не справился → владелец: справился».
   - The notice says «Итог пересчитан».
   - The situation leaves the review queue.

   The owner believes they overturned the judge, and the number did not move.

**Fix:** Let a quick mark close only what it answered, and let the remaining failures keep the dialogue pending:
```ts
const metricId = primaryMetricId(scenario, trial);
const mark = metricId ? latest.get(`${trial.id}|metric:${metricId}`) : undefined;
const quickDecided = mark?.source === 'quick' && (mark.verdict === 'pass' || mark.verdict === 'fail');
// ...
const failed = [...].filter(key => !(quickDecided && key === `metric:${metricId}`));
return !failed.length ? !quickDecided : failed.some(key => !decided(`${trial.id}|${key}`));
```
In the Pi handler, derive the notice from the data. Compare `cardVerdict` before and after the mark, and print «Итог пересчитан» only when the card's outcome actually changed. Otherwise name what still keeps the card failed, e.g. «остальные провалы — через v».

## Warnings

### WR-01: A quick «не согласен» is counted again as a human finding: the «Разметить человеку» queue grows, and the board shows it twice

**File:** `src/comparison.ts:185-188`, `src/quality.ts:612`, `extensions/cards.ts` (`verdictLines`)
**Issue:** `humanFindings` drops quick agreements but keeps quick disagreements as `disagreement: true` findings. This has several effects:
- **The review queue grows.** `qualitySummary` puts those trials into `humanQueue.disagreements`, so the owner's answer creates new work. Reproduced: `humanQueue.total` goes 0 → 1 after one `n`, while `awaitingVerdict` goes 1 → 0.
- **A confidence note is added.** `verdictSummary` adds the `human_disagreement` note «Расхождений автоматической и ручной оценки… это ещё не оценка точности судьи».
- **The board shows the disagreement twice.** The collapsed board prints `humanFindingText(v.review.findings[0])` above the causes, and the same disagreement appears again in «НЕСОГЛАСИЯ С СУДЬЁЙ».

**Fix:** Keep quick disagreements out of the queue and out of the collapsed-board finding line. The F7 section is their single presentation:
```ts
// quality.ts
const disagreementIds = new Set(humanFindings(record)
  .filter(f => f.disagreement && f.subject !== 'simulator' && record.humanReviews.find(r => r.id === f.reviewId)?.source !== 'quick')
  .map(f => f.trialId));
```
Or add a `source` field to `HumanFinding` and filter on it in `quality.ts`, `comparison.ts` (`review.disagreements`) and `cards.ts` (`finding`).

### WR-02: The lab's stale-judgment guard is opt-in

**File:** `src/experiment.ts:971`
**Issue:** The «оценка судьи изменилась» refusal runs only when the caller passes `judgeVerdict`. A caller that omits it can store a quick `fail` mark and have it read as «согласен» with whatever the trial holds now, without having seen that judgment. The lab test `the lab, not the caller, records…` itself stores a quick mark without `judgeVerdict`. For a quick mark, the verdict the person saw is part of what the answer means.
**Fix:** Make `judgeVerdict` required for `source: 'quick'`, in the schema refine or in `addHumanReview`:
```ts
if (input.judgeVerdict === undefined || input.judgeVerdict !== recorded) throw new Error('Оценка судьи изменилась, пока вы смотрели. Проверьте ситуацию ещё раз.');
```
Also check that `input.verdict` matches the answer it claims: agree = `recorded`, disagree = the opposite verdict, unsure = `unknown`.

### WR-03: The lab accepts quick marks on positive-control situations that the agreement count ignores

**File:** `src/experiment.ts:966-973`
**Issue:** Only the board refuses marks on controls (`agreementTarget` → `control`). `addHumanReview` accepts a quick mark on a positive-control trial. `judgeAgreement` skips controls, so a quick disagreement there overrides the rubric through `agentMetricResult` but never appears in the agreement count or the disagreement list.
**Fix:** In `addHumanReview`, refuse `source === 'quick'` when `record.positiveControlScenarioIds?.includes(trial.scenarioId)`.

### WR-04: F8 tells the owner to run `/agent-lab <8 characters>`, which does not open the run

**File:** `src/result-view.ts:383` (also `test/helpers/copy-check.ts:14`)
**Issue:** `agreementNextStep` prints `/agent-lab ${runId.slice(0, 8)}`. The command handler (`extensions/agent-lab.ts:810`) passes the argument straight to `lab.get(id)`. `ExperimentStore.get` opens `${id}.json` and checks `record.id !== id`, with no prefix lookup, so the suggested command fails with ENOENT. The copy-check helper allows exactly this 8-character form, so the tests lock in the broken hint. `allFailuresPointer` and `quality.ts:195` already have the same flaw, and this phase adds another instance on the owner's main call to action.
**Fix:** Either resolve a unique prefix in the `/agent-lab` handler, e.g. `(await lab.list()).filter(r => r.id.startsWith(arg))` with exactly one match, or print the full id.

### WR-05: The Pi result reorders sections by matching the pointer's text

**File:** `extensions/agent-lab.ts:37`
**Issue:** The renderer finds the «all failures» pointer with `startsWith('Все провалы — ')`, a copy of the wording in `allFailuresPointer`. If that wording changes, the pointer silently ends up above the disagreement block, and no type or test ties the two together.
**Fix:** Send the pointer as its own field from `summary()`, e.g. `failurePointer: allFailuresPointer(record.id)`, and render `[causeBlock, agreementBlock, pointer]` without parsing text.

### WR-06: The stale count includes superseded source marks, and blames «смена судьи» when the judge did not change

**File:** `src/agreement.ts:105`, `src/result-view.ts:261`
**Issue:** `carried` keeps every quick mark from `sourceEvidence.humanReviews`, even one the source run had already replaced with a full review. That mark is not «current» anywhere, but the reassessed run counts it as stale. A criteria-only or `codeOnly` reassessment also makes every carried mark stale, yet the row says «Отметки устарели после смены судьи», which is not true when the judge settings are unchanged.
**Fix:**
- Build `carried` from `latestHumanReviews` of the source evidence: `latestHumanReviews({ trials: sourceEvidence.trials, humanReviews: sourceEvidence.humanReviews })`, keeping only entries with `source === 'quick'`.
- Reword the tail as «Отметки устарели после переоценки: K», or choose the wording from whether `settings.judge` changed.

## Info

### IN-01: Import placed between constants

**File:** `src/experiment.ts:18`
**Issue:** `import { primaryMetricId } from './outcomes.js';` sits between `MAX_PARALLEL` and the other imports.
**Fix:** Move it into the import block at the top.

### IN-02: The owner's reason is escaped twice

**File:** `extensions/cards.ts:89`
**Issue:** `line()` already applies `safeText`, and the text passed in is also wrapped in `safeText(mark.note)`. The result is the same, but it hides where the escaping boundary is.
**Fix:** Pass `oneLine(mark.note)` and let `line()` escape it.

### IN-03: Rounded percent can show the target as reached when it is not

**File:** `src/result-view.ts` (`agreementRows`)
**Issue:** `Math.round` turns 179/200 (89.5%) into «90%», printed right above «Цель — согласие в 9 случаях из 10».
**Fix:** Use `Math.floor` for this share, or keep one decimal near the 90% boundary.

---

_Reviewed: 2026-09-17T14:47:16Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
