---
phase: 02-sudya-obyasnyaet-provaly
plan: 04
subsystem: result-view
tags: [explanations, owner-rules, not-measured, result-view, cli]
status: complete

requires:
  - phase: 02-sudya-obyasnyaet-provaly
    provides: "02-03 NO-GO: judge protocol stays v10, no cut symbols in the code"
  - phase: 01-odno-chestnoe-chislo
    provides: "ResultView, NOT_MEASURED_TEXT, cardVerdict, snap-test.sh"
provides:
  - "src/explain.ts: ruleRegister, ruleText, failureExplanation, exampleRows, rowsToLines, UNVERIFIED"
  - "src/plural.ts: pluralForm (leaf module, re-exported from result-view.ts)"
  - "ResultView.failures and ResultView.topCauses"
  - "resultViewRows (F3 «? <title> — <reason>» rows), causeSection, failureListRows, SECTION_TEXT, allFailuresTitle, allFailuresPointer"
  - "agent-lab summary layout F4/S1: block → top causes → «Все провалы (n):» → «Подробности:»; «Почему:» removed"
affects: [02-05 (Pi tool text and board print these rows; pi-surface-check.mts needs trimmed comparison), 02-07 (sheet reuses ruleRegister numbers), phase 5 (manager report)]

plan_head_before: 0c305a6234bd1cb45a94f34d2878a0ae13cde725

actuals:
  tokens: 15100    # chars/4 over the src+test diff (60 355 chars)
  tasks: 3
  commits: 5       # MEASURED rev-list 0c305a6..HEAD; 2653a65, eb33544, 397a52c are this plan's; 5b412c4 and 60f0d37 are concurrent docs(05) planning commits

tech-stack:
  added: []
  patterns:
    - "Explanation rows {role, indent, text}; surfaces call rowsToLines and escape each row on its own"
    - "Owner rule register: source order → verbatim quote offset → array index"

key-files:
  created:
    - src/explain.ts
    - src/plural.ts
    - test/explain.test.ts
  modified:
    - src/result-view.ts
    - src/cli.ts
    - test/result-view.test.ts
    - test/cards.test.ts

key-decisions:
  - "Cut row (C-13) not built: protocol v11 was not kept (02-03 NO-GO); judgedBeforeSeq and the 'cut' role are left out of FailureExplanation"
  - "A cause example is the first cluster attempt whose explanation is a goal failure; otherwise the situation's own explanation"
  - "Rule numbering counts each requirement id once (register.size + 1), so a duplicated id cannot leave a gap"
  - "Machine-format filter is decided by the requirement's source kind and quote, so a tampered prompt rule in machine format is still hidden, not shown as unverified"

requirements-completed: [JUDGE-01, JUDGE-02]

duration: 8min
completed: 2026-09-17
---

# Phase 2 Plan 04: Explanations of failures and named unmeasured situations Summary

**`agent-lab summary` now explains every failed situation from the stored record as «должен был → сказал (реплика #N) → Правило N · источник: «цитата»», names each unmeasured situation with its phase-1 reason, and shows the three largest failure causes with a full example. No model call is made.**

## Performance

- **Duration:** about 8 min of execution (after reading the context)
- **Started:** 2026-09-17T00:53Z
- **Completed:** 2026-09-17T01:01Z
- **Tasks:** 3/3
- **Files:** 7 (3 created, 4 modified)

## Accomplishments

- `failureExplanation` builds every F1 variant from stored data. The reply is checked against its event, and each rule quote is checked against its source with `verbatimSpan`. A part that fails its check is replaced by a named «не подтверждено» row.
- Owner rule numbers follow the materials' order and stay the same on a `structuredClone` copy. The judge's numbering and the requirement ids are never printed.
- A failure where only the prompt-rule check failed names the one violated rule, or says it cannot. When the goal failed, a separate «Нарушено правило N» row appears if that rule is not already shown.
- `resultViewLines` now prints a `  ? <title> — <reason>` row under `Не измерено:` for each unmeasured situation. The CLI, the Pi payload (`viewLines`) and the board get these rows automatically, because they all print `resultViewLines`.
- The CLI summary follows the F4/S1 layout, and the old clipped `Почему:` part is gone.

## Evidence on the real acquiring runs (read-only, counts only)

Snapshot `dist/cli.js summary` was run on the stored runs in `.agent-lab`. No text was printed or saved; only the counts below were read.

| Run | Все провалы | top causes | `?` rows | reply verified | reply by fallback | unverified rows | rule rows | «и ещё» | «Нарушено» | `…` | jargon |
|-----|-------------|------------|----------|----------------|-------------------|-----------------|-----------|---------|------------|-----|--------|
| fae4ee59 | 9 | 3 (+3 examples) | 4 | 12 | 0 | 0 | 22 | 9 | 8 | 0 | 0 |
| a92fd6ae | 7 | 3 (+3 examples) | 7 | 10 | 0 | 0 | 17 | 3 | 1 | 0 | 0 |

The «reply verified» count covers the 9 (or 7) failure blocks plus the 3 cause examples. Both runs exit with code 0 and print nothing to stderr, and `Почему:` is absent. Together the two runs explain the 16 failed situations measured in RESEARCH (CTX-07), with no model call.

## Task Commits

1. **Task 1 (tracer): the CLI summary lists every failed situation with its explanation.** `2653a65` (feat). The tracer gate re-ran `<verify>` with result 77/0 before the plan expanded.
2. **Task 2: every unverifiable part is named, and a rule-only failure names the violated rule.** `eb33544` (feat). RED: the test run failed on the missing `exampleRows` export. GREEN: 61/0.
3. **Task 3: top causes and unmeasured situations are named in words.** `397a52c` (feat). Full working-tree snapshot suite: 421 pass, 0 fail, typecheck clean.

## Deviations from Plan

### Run-context changes (v11 rollback)

**1. Cut row and cut variants not built.**
- `grep -c "export function judgedCut" src/outcomes.ts` returns 0, so the step does not apply. C-13 does not apply because protocol v11 was not kept.
- `judgedBeforeSeq` and the `cut` row role are left out of `FailureExplanation`. The «last reply before the cut» fallback is the plain «last reply» fallback.
- The must-have truth «When protocol v11 was kept…» is not applicable.
- Preconditions that grep for `judgedCut`, `trial.judgedBeforeSeq`, `receipt.cutBefore` or `COUNTING_RULES = 'goal-v2'` are not applicable. `COUNTING_RULES` stays `'goal-v1'`.

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test fixture put requirement ids into the requirement text.**
- **Found during:** Task 2, before the RED run.
- **Issue:** The «Должен был (из правила)» row would print the fixture id and trip the jargon backstop.
- **Fix:** The fixture requirement text is now Russian words only.
- **Files modified:** `test/explain.test.ts`
- **Commit:** `eb33544`

### Finding (no code change)

**UI-SPEC assumption is wrong: «knowledge sources are one line, so they never show `, строка`».**
- In fae4ee59, every knowledge source (`source-1…8`) has 5 lines, 3 of them non-blank. By the plan's own rule («`, строка <L>` only for sources with more than one line»), their rules show a line number. So all 39 rule rows on the two runs carry `, строка L`.
- The implementation follows the rule as written, and a line number helps the owner find the quote.
- If the product wants no line for short knowledge files, 02-05 or the UI-SPEC must change the rule, for example by counting non-blank lines above a threshold.

## Known Stubs

None.

## Threat Flags

None new.
- T-02-13: the CLI escapes each row, and a test feeds `ESC[31m` in a title and asserts that no ESC reaches stdout.
- T-02-14 and T-02-15: covered by the tamper table and the reply check.
- The Pi payload now also carries `view.failures` and `view.topCauses` (raw text), and `viewLines` contains titles in the `?` rows. Pi and board escaping of these rows is 02-05's scope, as planned.

## Notes for 02-05

- `extensions/cards.ts` and `extensions/agent-lab.ts` already print the new `?` rows through `resultViewLines`. `test/cards.test.ts` now compares trimmed board cells, which is the only change to that file.
- `.planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts` was not touched. It needs the trimmed comparison planned in 02-05.
- `quality.ts` `causes()` still uses its clipped quote; the CLI no longer prints it. The Pi tool text still shows `quality.causes`, and 02-05 decides whether to replace it with `causeSection`.

## Self-Check: PASSED

- FOUND: src/explain.ts, src/plural.ts, test/explain.test.ts
- FOUND commits: 2653a65, eb33544, 397a52c
