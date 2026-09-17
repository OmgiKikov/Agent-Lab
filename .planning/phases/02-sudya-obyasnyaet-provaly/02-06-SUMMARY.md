---
phase: 02-sudya-obyasnyaet-provaly
plan: 06
subsystem: live-verification
tags: [live-verification, free, explanations, dist-swap, evidence]
status: complete

requires:
  - phase: 02-sudya-obyasnyaet-provaly
    provides: "02-04: explain.ts, resultViewRows, causeSection, failureListRows; 02-05: Pi payload failureLines, board rows, wrapRows; 02-03: freeze v10-unchanged"
  - phase: 01-odno-chestnoe-chislo
    provides: "snap-test.sh, verify-stored-runs.mjs, pi-surface-check.mts, live-check.mjs"
provides:
  - "dist/ built from HEAD 83882d7 and live in the worktree (explanations reach the next Pi start)"
  - "measure-undecided.mjs --explain: per failed situation, row roles and verification counts, no text"
  - "board-width-check.mts: read-only board render + wrap check at five widths"
  - "Phase-2 JUDGE evidence table on the two real acquiring runs"
affects: [02-07 (sheet reuses the same rows), phase 4 (real light/dark screenshot is the open backstop), phase 7 (demo runs from this dist)]

plan_head_before: 83882d7b0c8d1f359fa6e2d076bec8475779854c
dist_built_from: 83882d7b0c8d1f359fa6e2d076bec8475779854c
dist_kept_at: .gsd/dist-before-02-06-20260917-123753
frozen_protocol: v10-unchanged
paid_calls: 0

actuals:
  tokens: 2529    # chars/4 over the two script diffs (10 118 chars)
  tasks: 2
  commits: 2      # MEASURED git rev-list --count 83882d7..HEAD before this docs commit

tech-stack:
  added: []
  patterns:
    - "Check scripts import the extension from the repository root and dist/ by path, so a snapshot checks its own build"
    - "A token-recording theme (fg records the color name) turns a render into a checkable list of theme tokens"

key-files:
  created:
    - .planning/phases/02-sudya-obyasnyaet-provaly/board-width-check.mts
  modified:
    - .planning/phases/02-sudya-obyasnyaet-provaly/measure-undecided.mjs

key-decisions:
  - "The v11 steps of the plan (RE11 / A11 / NEW11, the `Оценено до реплики #` rows, goal-v2) were skipped: 02-03 was NO-GO, the protocol is frozen at v10 and `judgedBeforeSeq` does not exist. The `cut` columns are printed and are `-` / `0` everywhere."
  - "`--explain` rebuilds each explanation with `failureExplanation` over the failed non-control cards instead of reading `view.failures`, so the check exercises the live dist's explain module; the run line also prints `viewFailures=` and the two agree on both runs."
  - "The board `over` column is measured on the rendered rows (Pi's own requirement: no line wider than the terminal); the substantive no-truncation evidence is the `wrap` lines — `ellipsis=0 words=equal` proves nothing was clipped and no word was lost."

requirements-completed: [JUDGE-01, JUDGE-02, JUDGE-03]

duration: 8min
completed: 2026-09-17
---

# Phase 2 Plan 06: Explanations proved on the real acquiring runs Summary

**The live `dist/` now holds the explanation code, and on the two stored acquiring runs every failed situation is explained with a judge-cited reply and verified rule numbers (9 of 9 and 7 of 7, zero unverified rows), every unmeasured situation is named with its reason (4 and 7), the CLI, the Pi payload, the collapsed Pi result and the board print identical rows, and the board fits 40 to 160 columns with nothing truncated. No model call was made.**

## Performance

- **Duration:** about 8 min (09:36Z → 09:44Z, 2026-09-17)
- **Tasks:** 2/2
- **Files:** 2 (1 created, 1 modified)
- **Paid steps:** 0 — this plan is free

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (tracer) | Every failure explained and every unmeasured situation named, from the live dist | `9e608d9` | measure-undecided.mjs |
| 2 | The board fits every screen width; phase evidence table | `7c0ffef` | board-width-check.mts |

Tracer feedback gate: the task carries no `gate` attribute, auto mode is off and `human_verify_mode` is `end-of-phase` with an automated-only `<verify>`, so the verify was re-run end to end (exit 0) and the plan expanded without a checkpoint.

## The dist swap

| Step | Result |
|------|--------|
| Preflight | `pgrep -fl 'dist/bundle/cli.js\|pi-coding-agent\|extensions/agent-lab.ts'` printed nothing; `.agent-lab/.lock` did not exist (`preflight-02-06.txt`) |
| Build | `snap-test.sh --full --keep` exit 0 — **429 pass, 0 fail**, typecheck clean (`snap-full-02-06.log`) |
| Re-check | pgrep and lock re-checked immediately before the rename; both still clear |
| Swap | rename inside the ignored `.gsd/`; previous build kept as `.gsd/dist-before-02-06-20260917-123753` |
| Built from | `83882d7` (`dist-built-from-02-06.txt`), equal to HEAD at swap time |
| Snapshot | removed after the swap |

`npm run build` and `npm test` were never run in the worktree, and no Pi process was touched.

## Phase-2 JUDGE evidence table (real acquiring runs, v10 records)

| | fae4ee59 | a92fd6ae |
|---|---|---|
| Situations (cards) | 13 | 15 |
| Not measured, 02-02 before → 02-03 after | 4 → 4 (31%) | 7 → 7 (47%) |
| Stored verdict re-verified | 0 passed / 9 decided + 4 not measured | 1 passed / 8 decided + 7 not measured |
| Receipt audit | 13/13 | 14/14 |
| Failed situations explained | 9 of 9 | 7 of 7 |
| Judge-cited replies | 9 (100%) | 7 (100%) |
| Unverified rows | 0 | 0 |
| Named violated rule | 5 | 1 |
| Cut rows (`Оценено до реплики #`) | 0 | 0 |
| `✗` blocks under `Все провалы (n):` | 9 | 7 |
| `  ? … — <reason>` rows | 4 | 7 |
| Cause section | `Главные причины провалов:` | `Главные причины провалов:` |
| Unexplained `…` or jargon before `Подробности:` | 0 of 0 hits | 0 of 0 hits |
| pi-surface-check | `OK surfaces=3 lines=9 sections=23` | `OK surfaces=3 lines=12 sections=19` |
| Width check | 10 render + 5 wrap lines, all `over=0`, every wrap `ellipsis=0 words=equal` | same |

Supporting lines (ids and counts only):

- `verify-stored-runs.mjs` exit 0, no `MISMATCH`.
- `explain run=fae4ee59 failed=9 judgeCited=9 unverifiedRows=0 violated=5 cut=0 viewFailures=9`
- `explain run=a92fd6ae failed=7 judgeCited=7 unverifiedRows=0 violated=1 cut=0 viewFailures=7`
- Per-situation `kind=goal` on all 16 failures; row roles are always `title,expected,said,rule…` with an optional `more` and `violated`, and never an `unverified` row.
- Rule counts shown + hidden per situation: fae4ee59 `11+9, 7+5, 1+0, 3+1, 3+1, 2+0, 4+2, 6+4, 3+1`; a92fd6ae `2+0, 2+0, 1+0, 5+3, 2+0, 1+0, 4+2`. `unverifiedRules=0` on every one.

### Copy check

The count script scans everything before `Подробности:` (106 of 116 lines for fae4ee59, 84 of 94 for a92fd6ae) for `…` and for `goal_attainment|prompt_compliance|user_fidelity|unknown|рубрик|протокол|кластер|метрик|judge`, case-insensitively, and classifies each hit against the record's own stored model-written values (titles, criteria, cluster names and descriptions, rule quotes, sources, dialogue turns, rationales). **Both runs: 0 hits, so 0 unexplained.** No finding to carry into phase 4/5 from this check.

### Width and theme

`board-width-check.mts` rendered the board for both runs at 40, 60, 80, 110 and 160 columns, collapsed and after Enter (20 render lines), and wrapped the `?` rows, the cause section and the whole `ВСЕ ПРОВАЛЫ` list at inner widths 36, 56, 76, 106 and 156 (10 wrap lines). Every line reads `over=0`; every wrap line reads `ellipsis=0 words=equal` — no row is wider than the screen and no word is lost or replaced by an ellipsis.

Theme tokens recorded: **`accent, borderMuted, dim, error, muted, text, warning`**. The collapsed overview uses six of them (`error` appears with the `ВСЕ ПРОВАЛЫ` titles after Enter); `success` is allowed and simply unused, because both runs have failures. Nothing outside the allowed list appeared.

**Backstop note (UI-SPEC light/dark).** Светлая и тёмная темы: строки используют только токены темы Pi (`accent`, `borderMuted`, `dim`, `error`, `muted`, `success`, `text`, `warning`) — ни один цвет не задан напрямую, поэтому обе темы получают свой контраст от Pi; настоящий снимок экрана в обеих темах — в фазе 4.

### Gate, freeze and spend

- Pilot gate (02-03): `NO-GO decided=0/3 cost=$0.4304 reason=no-reduction`.
- Frozen protocol: `protocol=v10-unchanged frozen=2026-09-17T03:48:37+0300 reason=no-reduction`.
- Spend: this plan spent **$0** (no model call). `live-check.mjs spent --ledger ledger.txt` prints `spent=? remaining=?` (exit 3) because its only ledger entry, the pilot record `17d77d54`, is no longer in `.agent-lab` and does not parse under the restored v10 schema. The phase-02 total therefore stays the recorded **$0.4304 of the $6 cap**, with $5.5696 left.
- dist commit: `83882d7`.

## Deviations from Plan

### Not done by design (v11 rollback)

02-03 was NO-GO, so `RE11` / `A11` / `NEW11` do not exist and the judge protocol is frozen at v10. Skipped accordingly:

- The third `--id` on every check (the v11 reassessment of fae4ee59) — only the two v10 runs were checked.
- The acceptance clause «When 02-03 was GO: the RE11 counts show fewer `?` lines than 4…».
- The `Оценено до реплики #` rows: `judgedBeforeSeq`, `cutBefore`, `judgedCut` and goal-v2 do not exist in the code, so the column is printed and is `-` on every situation and `0` on every run. This is recorded as a column rather than dropped, so a later v11 attempt can be compared against it.

### Auto-fixed issues

None. Both task verify commands passed on the first run.

### Smaller departures from the written plan

- **The `--explain` run line carries one extra field, `viewFailures=`.** It cross-checks the directly rebuilt explanations against `buildResultView(record).failures`; both are 9 and 7.
- **Per-situation lines also print `unverifiedRows=`**, not only the run total, so a single bad situation can be found without reading any text.
- **The count script is a one-off in the scratchpad, not a committed artifact.** The plan's `files_modified` lists only the two scripts; its output is in `$EVID/summary-counts.txt`.
- **`board-width-check.mts` takes the board's inner widths as `width - 4`** (the frame's own columns), so the render widths and the wrap widths line up with the plan's 36/56/76/106/156.

## Known Stubs

None.

## Threat Flags

None new. T-02-20 holds: both scripts print ids, roles, counts, widths and theme token names only; every raw summary, explain dump and width log stays in `~/agent-lab-evidence/phase-02/` (`chmod -R go-rwx`, directory `drwx------`). T-02-21 holds: pgrep and the lock were checked twice, the swap was a rename, and the previous build is kept. T-02-SC holds: no package was installed. No git command ran in `aigw-local` and no agent run was started.

## Evidence files (~/agent-lab-evidence/phase-02/)

`preflight-02-06.txt`, `snap-full-02-06.log` (429/429), `dist-built-from-02-06.txt`, `fae4ee59.summary.v2.txt`, `a92fd6ae.summary.v2.txt`, `summary-counts.txt`, `explain.txt`, `explain-check.txt`, `stored-after-swap-02-06.txt`, `pi-surface-02-06.txt`, `board-width.txt`.

## Notes for what follows

- The next Pi start imports the new `dist/`, so `/agent-lab` shows these explanations without any further step.
- TRUST-10/11 (02-07…02-09) can still be cut cleanly from here: the JUDGE part of the phase is complete and self-contained.
- The open backstop for phase 4 is the real light/dark screenshot; the token list above is what it has to look right in.

## Self-Check: PASSED

- FOUND: `.planning/phases/02-sudya-obyasnyaet-provaly/board-width-check.mts`
- FOUND: `.planning/phases/02-sudya-obyasnyaet-provaly/measure-undecided.mjs` (tracked, `--explain` present)
- FOUND: `dist/explain.js`, `dist/result-view.js`, `dist/cli.js` in the live worktree dist
- FOUND commits: `9e608d9`, `7c0ffef`
- FOUND: `.gsd/dist-before-02-06-20260917-123753` (previous build kept)
- FOUND: nothing from `.agent-lab` or the evidence directory in `git status`
