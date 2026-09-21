---
phase: 02-sudya-obyasnyaet-provaly
plan: 05
subsystem: pi-surfaces
tags: [pi-surfaces, board, tool-result, causes, wrap]
status: complete

requires:
  - phase: 02-sudya-obyasnyaet-provaly
    provides: "02-04: explain.ts, resultViewRows, causeSection, failureListRows, SECTION_TEXT, allFailuresPointer"
  - phase: 01-odno-chestnoe-chislo
    provides: "ResultView, snap-test.sh, pi-surface-check.mts"
provides:
  - "agent-lab summary payload field failureLines (cause heading, rows, pointer to all failures)"
  - "collapsed Pi tool result prints the failure section right after the block"
  - "board overview and Enter view built from resultViewRows / causeSection / failureListRows, one color per row role"
  - "extensions/cards.ts: exported wrapRows (hanging indent, nothing truncated)"
  - "QualityCause.example.explanation and causeExample (verified quote instead of a clipped rationale)"
  - "pi-surface-check.mts: trim-normalised block check and a cause-section check across four surfaces"
affects: [02-06 (theme note), 02-07 (sheet reuses the same rows), phase 4 (layout polish), phase 5 (report reads example.quote)]

plan_head_before: 33d52914b0bd7e08a7cc0d2889f64dcc1355dddd

actuals:
  tokens: 12800    # chars/4 over the src + extensions + test + phase-01 script diff (51 071 chars)
  tasks: 3
  commits: 6       # MEASURED rev-list 33d5291..HEAD before this docs commit; 999c1a3, a3666c4, aef4c48, 5797b65 are this plan's, f2c6752 is a concurrent docs(06) planning commit

tech-stack:
  added: []
  patterns:
    - "Board rows carry an optional indent; wrapRows wraps them with a hanging indent instead of truncating"
    - "Row role → one theme token; no surface colors a row by its position"
    - "Every surface prints the rows of result-view.ts / explain.ts and only escapes them"

key-files:
  created: []
  modified:
    - src/explain.ts
    - src/quality.ts
    - extensions/agent-lab.ts
    - extensions/cards.ts
    - test/explain.test.ts
    - test/cards.test.ts
    - test/extension.test.ts
    - test/quality.test.ts
    - .planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts

key-decisions:
  - "Rule rows name «, строка L» only for a source with four or more non-blank lines (orchestrator decision on top of UI-SPEC F1): short knowledge files are identified by source name alone, so the noisy line number on 39 rule rows of the two acquiring runs is gone"
  - "pi-surface-check compares the board at width 5000 and height 3000 for both the block and the section: at width 200 a long explanation row wraps and is no longer one cell, which is the render's job, not the content's"
  - "The overview explains decided failures only: a card left unstable or unmeasured is named in the `?` rows, not in the failure section (two older board tests were rewritten to this rule)"
  - "The expanded overview keeps the `3 — открыть диалоги` hint but drops the block that printed raw check evidence and judge rationale"

requirements-completed: [JUDGE-01, JUDGE-02]

duration: 55min
completed: 2026-09-17
---

# Phase 2 Plan 05: The same explanations in Pi chat and on the board Summary

**The Pi tool result and the `/agent-lab` board now print the very rows the CLI prints — the result block, the top causes with a full example, and every failure under `ВСЕ ПРОВАЛЫ` — nothing clipped at any width from 40 to 160 columns, and the cross-surface check confirms it on both stored acquiring runs.**

## Performance

- **Duration:** about 55 min of execution (wall clock 01:03Z → 09:33Z with a long API rate-limit pause in the middle)
- **Tasks:** 3/3 (plus one preparatory fix)
- **Files:** 9 modified

## Accomplishments

- `summary()` adds `failureLines` to every Pi tool payload with trials: the cause heading (`Главные причины провалов:` or `Провалы:`), the rows of `causeSection(view)` and `Все провалы — /agent-lab <id8>, раздел 1, Enter.`
- The collapsed Pi result prints that section right after the block in all three branches; the old list of bare cause names with counts is gone.
- The board overview builds its block from `resultViewRows` and its section from `causeSection`, with the muted hint `Все провалы: Enter.`. `ЧТО ТРЕБУЕТ ВНИМАНИЯ` with its clipped quote no longer exists anywhere in `extensions/cards.ts`.
- Enter on the overview shows `ВСЕ ПРОВАЛЫ` with every failure in record order, then today's detailed rows.
- `wrapRows` keeps every word: a row with an indent continues two columns further in and never exceeds the board's inner width; `truncateToWidth` is not used on content rows.
- Saved causes carry a verified example: a failed exact check keeps its own evidence, a rubric failure keeps the verified agent reply and the whole explanation, and an unconfirmed reply says `объяснение не подтверждено цитатой`.

## Evidence on the real acquiring runs (read-only, counts only)

`pi-surface-check.mts` was run from a snapshot against the stored runs. It prints ids and counts only:

```
OK surfaces=3 lines=9 sections=23 id=fae4ee59
OK surfaces=3 lines=12 sections=19 id=a92fd6ae
```

So for both runs the CLI block, the payload `viewLines`, the collapsed Pi result and the board agree line for line, and the 23 / 19 section rows (heading plus three causes with full examples) are identical on the CLI, in the payload and on the board.

Full working-tree snapshot suite: **429 pass, 0 fail**, extension typecheck clean.

## Task Commits

0. **Preparatory fix: the rule line number only for long sources.** `999c1a3` (fix). Run-context decision; a test pins the one-line, three-line and four-line cases.
1. **Task 1 (tracer): Pi chat and the board show the same causes as the CLI.** `a3666c4` (feat). Tracer gate: `<verify>` re-run end-to-end (39 pass / 0 fail, two `OK surfaces=3 … sections=` lines) before the plan expanded.
2. **Task 2: every failure readable in full at any width.** `aef4c48` (feat). RED: `wrapRows` was not exported, the whole test file failed. GREEN: 42 pass / 0 fail.
3. **Task 3: verified cause examples.** `5797b65` (feat). RED via the two updated expectations, GREEN with the full suite 429 pass / 0 fail.

## Deviations from Plan

### Run-context changes (v11 rollback)

Nothing in this plan referenced `judgedCut`, `judgedBeforeSeq`, `cutBefore`, the `cut` row role or goal-v2. The `cut` role is absent from `ExplanationRole`, so the board role map has no `cut` entry — the plan's mention of it did not apply.

### Auto-fixed Issues

**1. [Rule 1 - Bug] The board block check failed on the real run at width 200.**
- **Found during:** Task 1 verification (`DIFF id=fae4ee59 surface=board line=5`).
- **Issue:** a block row of fae4ee59 is longer than the board's inner width at 200 columns, so it wrapped and was no longer a whole cell. The plan only widened the board for the section check.
- **Fix:** the same board is now rendered at width 5000, height 3000 for both the block and the section comparison; the second board the plan described is not needed.
- **Files modified:** `.planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts`
- **Commit:** `a3666c4`

**2. [Rule 1 - Bug] Two older board tests asserted a failure quote on an undecided card.**
- **Found during:** Task 1 (tests 7 and 10 of `test/cards.test.ts`).
- **Issue:** both fixtures leave their card unstable or unusable, so `view.failures` is empty and the overview correctly shows «Провалов не зарегистрировано»; the tests still expected the old weak-spot name and the judge rationale.
- **Fix:** they now assert that the judge rationale never reaches the overview and that the undecided card is named under «Не измерено».
- **Files modified:** `test/cards.test.ts`
- **Commit:** `a3666c4`

### Smaller departures from the written plan

- **`Line.indent` landed in Task 2, not Task 1.** Task 1 prefixed the indent into the row text so the intermediate commit kept its indentation; Task 2 replaced that with the `indent` field plus `wrapRows`.
- **The «trial without an explanation» case of Task 3 has no test of its own.** Reaching it needs a cluster trial that is an agent failure yet has neither a failed check nor a failed goal or prompt rule; the code path (`quote = trial.reason`) stays, and the null branch of `failureExplanation` is covered in `test/explain.test.ts`.
- **`grep -c "explanation?: FailureExplanation" src/quality.ts` returns 2, not 1** — the field on `QualityCause.example` and the return type of `causeExample`.
- **The expanded overview keeps `3 — открыть диалоги · a — обсудить причины…`** as a muted hint under `ВСЕ ПРОВАЛЫ`; only the raw-evidence example rows were removed.

## Known Stubs

None.

## Threat Flags

None new. T-02-17 holds: every board row still goes through `line()` → `safeText`, and the collapsed Pi result passes the joined text (block, failure section and queue) through `safeText` before rendering. T-02-19 holds: `pi-surface-check.mts` prints only ids, counts and line indexes.

## Notes for 02-06 and later

- The UI-SPEC light/dark screenshot is still open: this plan proves the token per row with a recording theme (`<error>`, `<accent>`, `<warning>`, `<muted>`), not the real palette.
- `src/report.ts` still reads `example.quote` and `example.seq`; both keep their meaning, and `example.explanation` is now available for the phase-5 manager report.
- The line-number rule («, строка L» from four non-blank lines up) is worth stating in the UI-SPEC F1 section.

## Self-Check: PASSED

- FOUND: src/explain.ts, src/quality.ts, extensions/agent-lab.ts, extensions/cards.ts, 02-05-SUMMARY.md
- FOUND commits: 999c1a3, a3666c4, aef4c48, 5797b65
