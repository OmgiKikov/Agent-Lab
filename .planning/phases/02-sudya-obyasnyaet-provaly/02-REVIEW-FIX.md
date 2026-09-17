---
phase: 02-sudya-obyasnyaet-provaly
fixed_at: 2026-09-17T00:00:00Z
review_path: .planning/phases/02-sudya-obyasnyaet-provaly/02-REVIEW.md
iteration: 1
findings_in_scope: 10
fixed: 10
skipped: 0
follow_ups: 1
status: all_fixed
---

# Phase 2: Code Review Fix Report

**Fixed at:** 2026-09-17
**Source review:** `.planning/phases/02-sudya-obyasnyaet-provaly/02-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 10 (CR-01…CR-03, WR-01…WR-07)
- Fixed: 10
- Skipped: 0
- Info findings (IN-01…IN-03): out of scope for `fix_scope: critical_warning`, untouched.

## Verification

- Every fix was verified with `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh <files>` before its commit. `npm test` and `npm run build` were never run in the worktree.
- Final gate: `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh --full` (a `git archive HEAD` snapshot, so it validates the committed state) — **452 tests, 452 pass, 0 fail**, plus `npm run typecheck` (build + `tsc --noEmit --strict` over `extensions/*.ts`) clean.
- **Where verification ran:** in the main conductor worktree `/Users/kikov/conductor/workspaces/conductor-playground/lyon`, not in a nested git worktree. A nested worktree was deliberately not created: the repository's first worktree (`/Users/kikov/Desktop/tlepsh/conductor-playground`) is checked out on `master`, not on `full-project-review-feature-plan`, so the standard `merge --ff-only` cleanup would have merged the fixes into the wrong branch; and a nested worktree has no `node_modules`, which `snap-test.sh` symlinks from the repository root. This conductor workspace is itself the isolated checkout, so this is the documented `use_worktrees: false` path.
- `JUDGE_PROTOCOL` and `VERSION` were not touched. Old records stay readable: the only schema change adds a value to an enum, and both new manifest fields are `undefined`-dropping (pinned by tests).

## Fixed Issues

### CR-01: The run dialog says «this is not a manual check», and the record then claims it was

**Files modified:** `src/contracts.ts`, `src/experiment.ts`, `src/report.ts`, `extensions/agent-lab.ts`, `extensions/cards.ts`, `test/experiment.test.ts`, `test/cards.test.ts`, `test/extension.test.ts`
**Commit:** `39e0bc5`
**Applied fix:** Introduced the narrower truth the orchestrator asked for. `reviewMode` gained a third value, `'expectations'`, and both Pi run paths now stamp it instead of `'human'`. The false disclaimer is gone from the confirmed path — `runPlan` now ends with «Подтверждая, вы подтверждаете ожидания ситуаций выше. Оценки судьи вы не проверяли.» — and the limitation no longer silently disappears: an `expectations` run pushes «Владелец подтвердил ожидания ситуаций перед запуском. Определения карточек и оценки судьи человеком не проверялись.» The report and the board now say «ожидания подтверждены владельцем», never «проверено человеком»; `'human'` keeps its stronger wording for a real card review. The compare downgrade at `src/experiment.ts` reads `reviewMode !== 'human'`, so `'expectations'` still marks the comparison provisional — a confirmed draft cannot lift an `improved` verdict. Tests now pin the honest story rather than the contradiction (`reviewer: 'expectations'`, the new plan text, the new limitation, the two display surfaces, and the non-upgrade of the comparison), and `experimentSchema` is asserted to still accept `'human'` and `'automated'` from old records.

### CR-02: The run-plan confirmation for a multi-situation suite no longer shows the opening request or the exact checks

**Files modified:** `extensions/agent-lab.ts`, `test/extension.test.ts`
**Commit:** `f2aa2fc`
**Applied fix:** Took the orchestrator's second option ("add the missing checks and opening to the compact sheet"), because `02-UI-SPEC.md:453` pins the compact sheet as the body of this dialog and D-04 pins compact-inside-dialogs. The sheet still leads, and for any set that is **not** built entirely from production logs the dialog now appends «Что вы подтверждаете дословно:» with `Запрос: <opening>` and every `Проверка: <check>` per card — exactly what `acceptDraft` seals via `fingerprint(scenario)`. A production-provenance validation set keeps the compact sheet alone, since its opening and checks come from the logged dialogue, which the log line above the sheet already states. The board-run test now asserts the opening of every card and an exact count of `Проверка:` rows against the draft.

### CR-03: The report quotes the «не подтверждено» sentinel as if the agent had said it

**Files modified:** `src/explain.ts`, `src/quality.ts`, `src/report.ts`, `test/quality.test.ts`, `test/cards.test.ts`
**Commit:** `5fc7d82`
**Applied fix:** The verification state now travels with the cause instead of being smuggled inside `quote`: `QualityCause.example` gained `verified: boolean`, and `causeExample` returns either the checked reply quote or the new `UNVERIFIED_REPLY` status line «реплика агента не подтверждена цитатой» with `verified: false`. All three renderers — the HTML report, the Markdown report and the terminal `qualityLines` causes — wrap the value in «…» only when `verified` is true; otherwise they print it plainly as a status line. New tests assert the sentinel appears unquoted in both exported cause lists and that the judge rationale never becomes the cause quote.

### WR-01: `violatedRule` can name the wrong owner rule from a 12-character coincidence

**Files modified:** `src/explain.ts`, `test/explain.test.ts`
**Commit:** `4a0c9ff`
**Applied fix:** A span may now name a rule only on an exact or near-exact match: a span contained in the rule must cover at least `MIN_SPAN_RATIO` (0.6) of it, and a rule contained in a longer judge span must itself be at least `MIN_CONTAINED_QUOTE` (24) characters. Weak matches fall through to the existing «не подтверждено» row. **Verified failing without the fix:** with the old condition the new assertions fail (test 9 red), and pass with it.

### WR-02: A rule's line number points at the first occurrence of the text, not at the requirement's own

**Files modified:** `src/contracts.ts`, `src/explain.ts`, `test/contracts.test.ts`
**Commit:** `9c09d97`
**Applied fix:** Added `verbatimSpanAt(content, quote) -> { span, offset }`, which returns the offset the match was actually made at; `verbatimSpan` is now a thin wrapper over it, so every other caller is unchanged. `ruleRegister` threads that offset straight into the line number and the sort key instead of re-running `indexOf(span)` on the source, which also removes the dead `offset < 0` branch that could silently drop a requirement from the register.

### WR-03: The control warning steals the `lead` role

**Files modified:** `src/result-view.ts`, `extensions/cards.ts`, `test/result-view.test.ts`
**Commit:** `e55ea1b`
**Applied fix:** Added the `alarm` role. `resultViewRows` now pushes the control warning as `alarm` and the headline as `lead` explicitly, and `add` no longer rewrites whichever row happens to be first. `extensions/cards.ts` maps `alarm` to `{ color: 'error', bold: true }`, so the warning keeps warning colouring and the number is never muted under it. Tests pin the first two roles with a warning present, and that there is exactly one `lead` row with or without one.

### WR-04: «Ожидание изменено после подтверждения» is shown for any draft change

**Files modified:** `extensions/cards.ts`, `test/cards.test.ts`
**Commit:** `54056a5`
**Applied fix:** Kept `acceptedDraftHash` as the run gate and narrowed only the wording, comparing the sealed card definitions (`acceptedTests[].definitionHash` vs `fingerprint(scenario)`) — which is exactly UI-SPEC's own condition for C-33, "some accepted entries dropped". A real expectation change keeps «Ожидание изменено после подтверждения»; a judge-model edit or a re-preflight that only moves `targetFingerprint` now says «Черновик изменился после подтверждения», which is true. New test covers both branches.

### WR-05: The cause example quote is now unbounded

**Files modified:** `src/quality.ts`, `test/quality.test.ts`
**Commit:** `fc2dbfc`
**Applied fix:** Restored the 220-character `shorten` cap on the flattened `example.quote` that the HTML and Markdown exporters inline into the cause list, while `example.explanation.said.quote` keeps the whole reply for the terminal, which wraps it. Test uses a >1000-character reply and asserts the clamp on the report copy and the full text on the explanation.

### WR-06: The control warning and the control line disagree for a control with no recorded reason

**Files modified:** `src/result-view.ts`, `test/result-view.test.ts`
**Commit:** `e3a616d`
**Applied fix:** Extracted one exported predicate `unmeasuredControl(card)` (a type predicate, so the `NOT_MEASURED_TEXT[only.reason]` lookup still narrows) and used it for both the alarm in `buildResultView` and the branch in `controlLine`. A control that is `unknown` with no recorded reason, or still running, is «ещё не проверен» on both rows.

### WR-07: `measurementHash` ignores `positiveControlScenarioIds` and `ownerExpectationScenarioIds`

**Files modified:** `src/experiment.ts`, `test/experiment.test.ts`
**Commit:** `346507c` (originally `f4dd94f`, amended to add the attribution trailer), then narrowed by `d4d9aa0` — see "Follow-up" below, which is the final state.
**Applied fix (superseded in part by `d4d9aa0`):** Both fields were initially added to the manifest. Because `JSON.stringify` drops `undefined`, a record written before either field existed keeps its exact hash — asserted in the new test and in the two existing tests. **Two existing assertions pinned the old behaviour and were updated deliberately:** `measurementHash(edited) === measurementHash(legacy)` ("the marker never changes what is measured") and the equivalent for the control set. Both now assert `notEqual`, with the reason in the test: the expectation sheet already tells the owner «с прошлыми прогонами не сравнивается», and a control card leaves the headline denominator, so two runs with different control sets did not measure the same thing. Each test also gained an explicit old-record stability assertion.

## Deviations from the review's literal fix text

Two places where I followed the intent but not the letter, both worth a glance:

1. **WR-01 fallback wording.** The orchestrator's note said to "fall back to «правило не определено однозначно»". I kept the existing fallback string «Должен был: соблюдать правила из ваших материалов — объяснение не подтверждено цитатой», because `02-UI-SPEC.md` pins it twice (line 238 and copy-deck entry C-01b) for exactly this condition ("the rule cannot be identified uniquely"). The **behaviour** the note asks for is implemented: an uncertain match no longer names a rule. If the new wording is wanted, it is a one-line change plus a UI-SPEC copy-deck update.
2. **WR-02 has no fail-without-fix test.** The refactor is correct by construction, but I could not build a case where the old `indexOf(span)` re-search returns a different offset than the match: an identical raw span occurring earlier would also fold-match earlier, so both resolved to the same place under today's `foldTypography` rules. The new test therefore pins the contract (`content.slice(offset, offset + span.length) === span`, for direct and typography-folded matches and for a repeated sentence) rather than a behaviour change. Every other finding has a test that exercises the new behaviour, and WR-01's was explicitly confirmed red before the fix.

## Notes

- `.planning/phases/0[3-6]-*` was never staged; every commit used explicit paths.
- No new runtime dependencies. All new user-facing strings are Russian; identifiers and comments are English.
- `02-REVIEW.md` and `02-VERIFICATION.md` remain untracked, as does this report — the orchestrator commits it.

## Follow-up: WR-07 narrowed to the control set (orchestrator decision)

**Files modified:** `src/experiment.ts`, `test/experiment.test.ts`
**Commit:** `d4d9aa0` — `fix(02): WR-07 keep only the control set in the manifest hash`

`measurementHash` now carries `positiveControlScenarioIds` only. `ownerExpectationScenarioIds` was
removed, restoring the 02-07 truth: an owner edit already rewrites `successCriteria` and the goal
rubric, so the card fingerprint — and with it `scenarios` — moves, and the measurement identity
changes through that. The marker itself is only a label on a change the manifest has already seen.
The rationale is now in the doc comment on `measurementHash`.

Tests updated to match, each carrying its one-line reason:
- `an exact-check situation keeps the old refusal…` is back to `assert.equal(measurementHash(edited), measurementHash(legacy), 'the marker never changes what is measured')`.
- `a positive control rides on the record…` keeps `assert.notEqual(…, 'the manifest sees the control set')`.
- The added test, renamed to `the manifest covers the control set but not the owner-expectation label, and old records keep their hash`, now asserts the control set changes the hash, the owner-expectation marker does not, and a record with neither field present hashes exactly as before.

Old-record hash stability is still asserted in all three places.

**Re-run after this change:** `snap-test.sh --full` → **452 tests, 452 pass, 0 fail, 0 cancelled, 0 skipped**, typecheck clean. Nothing failed, so there is no failing test to name; the earlier 451/452 was not reproduced here.

---

_Fixed: 2026-09-17_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
