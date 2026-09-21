---
phase: 02-sudya-obyasnyaet-provaly
verified: 2026-09-17T12:05:00Z
status: human_needed
score: 19/21 must-haves verified (all 4 ROADMAP success criteria met; every blocker closed; 1 item deferred to Phase 4, 1 awaiting a person at a Pi terminal)
covered_files:
  - ".planning/REQUIREMENTS.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-01-PLAN.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-01-SUMMARY.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-02-PLAN.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-02-SUMMARY.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-03-PLAN.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-03-SUMMARY.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-04-PLAN.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-04-SUMMARY.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-05-PLAN.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-05-SUMMARY.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-06-PLAN.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-06-SUMMARY.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-07-PLAN.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-07-SUMMARY.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-08-PLAN.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-08-SUMMARY.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-09-PLAN.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-09-SUMMARY.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-REVIEW-FIX.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/02-REVIEW.md"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/board-width-check.mts"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/expectation-check.mts"
  - ".planning/phases/02-sudya-obyasnyaet-provaly/measure-undecided.mjs"
  - "extensions/agent-lab.ts"
  - "extensions/cards.ts"
  - "src/cli.ts"
  - "src/contracts.ts"
  - "src/experiment.ts"
  - "src/explain.ts"
  - "src/plural.ts"
  - "src/quality.ts"
  - "src/report.ts"
  - "src/result-view.ts"
  - "test/cards.test.ts"
  - "test/contracts.test.ts"
  - "test/experiment.test.ts"
  - "test/explain.test.ts"
  - "test/extension.test.ts"
  - "test/quality.test.ts"
  - "test/result-view.test.ts"
  - "test/workflow.test.ts"
covered_digest: "v1:sha256:529c57e8754918cf825fbe5ff09899df622d0242e277ddd1dc4254d490592e30"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  iteration: 2
  previous_status: gaps_found
  previous_score: 18/21
  gaps_closed:
    - "CR-01 — the record no longer claims a human check the dialog disclaims (new reviewMode 'expectations', honest limitation, honest report/board wording, compare gate still requires 'human')"
    - "CR-03 — an unverified reply is carried as `verified: false` and printed unquoted by the HTML report, the Markdown report and the terminal cause list"
    - "WR-07 over-reach — commit d4d9aa0 removed `ownerExpectationScenarioIds` from `measurementHash` and restored the 02-07 assertion «the marker never changes what is measured»; re-measured: a record carrying the owner marker (37f78e1a) now hashes the same with or without it"
  gaps_remaining: []
  caveats:
    - "`positiveControlScenarioIds` stays in `measurementHash` by design (the WR-07 fix the review asked for). Measured: the stored run 61521e0d still computes 62de5a39e086 under the shipped dist and c5713f51dab0 under the fixed code. No declared phase-2 must-have governs that field, every `draftHash` is unchanged, stored `manifestHash` strings are untouched, `compareRuns` pairs by scenario content, and no general run-resume path exists — so nothing observable changes. Recorded, not hidden."
    - "Flaky suite: 1 of 7 full `snap-test.sh --full` runs across the fix rounds failed a single test (451/452); the other 6 were 452/452 with a clean typecheck. The failing test could not be identified — run 1's output was truncated. Worth chasing before the demo."
deferred:
  - truth: "Light and dark Pi themes look right on the explanation rows (02-06 backstop; the plan itself defers the real screenshot)"
    addressed_in: "Phase 4"
    evidence: "Phase 4 success criterion 5: «Блок, доска и прогресс выглядят единообразно: цвета темы, полосы, выравнивание, перенос по словам без обрезки. Кириллица корректна в светлой и тёмной темах на ширине от 40 до 160 колонок.»"
human_verification:
  - test: "Open `/agent-lab 37f78e1a` in a live Pi session, press `2`, then `e` (edit one expectation, cancel and save), `y` (confirm all), `r` (start dialog) and cancel the run. Repeat in a light and a dark Pi theme."
    expected: "Section 2 shows the expectation sheet with the header, one situation per row, owner-numbered rule rows and `Версия ожиданий:`; `e` opens the native editor titled «Что агент должен сделать в этой ситуации? Своими словами.»; `y` returns the board with «Ожидания подтверждены: 13 ситуаций. r — запуск.»; `r` on an unconfirmed draft asks «Подтвердить ожидания и запустить?»; cancelling starts nothing."
    why_human: "02-09 declared this backstop unverifiable in an unattended run. The script-driven checks (`expectation-check.mts`: board render at 5 widths, `y`→accept, `e`→expect) stand in for it, but only a person at a real Pi terminal can confirm the native editor dialog, the theme colors and that no run is started."
---

# Phase 2: Судья объясняет провалы — Verification Report

**Phase Goal:** Владелец видит каждый провал агента эквайринга как «должен был X → сказал Y → правило N (цитата)» с проверенными цитатами и понимает, почему осталось «без решения». Протокол судьи заморожен к концу 2026-09-18. До запуска владелец подтверждает ожидания на одном экране.
**Verified:** 2026-09-17T12:05:00Z (second re-verification, after `d4d9aa0` closed the last gap)
**Status:** human_needed — no gaps remain; one item awaits a person at a Pi terminal
**Re-verification:** Yes, iteration 2 — after `346507c…39e0bc5` closed the review findings and `d4d9aa0` closed the manifest-hash gap this verification raised. Every check below was re-run against a `git archive HEAD` snapshot build, not the stale worktree `dist/`.
**Mode:** mvp (goal is a phase goal, not a User Story; the MVP User Flow table is replaced by the four ROADMAP success criteria below)

## Goal Achievement

### Observable Truths

Truths T1–T4 are the ROADMAP success criteria (the contract). T5–T21 are the merged plan
`must_haves` groups. Evidence is ids, counts and codes only — no dialogue text, card titles or
rule quotes are reproduced here.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | **SC1.** Every failure is shown as «должен был X → сказал Y → правило N (цитата)», N being the owner's rule number and verbatim quote; an unverifiable part is marked «не подтверждено цитатой» | ✓ VERIFIED | `node dist/cli.js summary` on `fae4ee59` and `a92fd6ae`: 9 and 7 `✗` blocks, each with a `Должен был:` row, a `Сказал (реплика #N): «…»` row and numbered `Правило N · <source>: «…»` rows (22 such rows on fae4ee59). `measure-undecided.mjs --explain` (re-run by the verifier): `explain run=fae4ee59 failed=9 judgeCited=9 unverifiedRows=0 violated=5`, `run=a92fd6ae failed=7 judgeCited=7 unverifiedRows=0 violated=1`. Numbering comes from `ruleRegister` (source order → quote offset → array index, `src/explain.ts:64-84`); requirement ids and judge numbering never printed (jargon backstop test, `test/explain.test.ts:311`). Unverifiable fallbacks are implemented (`UNVERIFIED`, `src/explain.ts:16,115,182,198`) and covered by passing tests at `test/explain.test.ts:169,195,204,250` |
| 2 | **SC2.** Every «без решения» situation is named with a plain-words cause | ✓ VERIFIED (vocabulary is a superset — see Info) | `fae4ee59`: 4 not-measured → 4 `  ? … — <reason>` rows (`симулятор отклонился от диалога` ×2, `судья не уверен, что симулятор держался диалога`, `судья не уверен: голоса разошлись`). `a92fd6ae`: 7 → 7 rows. The per-situation `?` row is new in this phase (`git diff fa79f2e HEAD -- src/result-view.ts` adds `add('situation', '? …')` at the not-measured block); the 18-label table `NOT_MEASURED_TEXT` is unchanged phase-1 code and contains both literally named causes (`no_evidence` → «нет доказательства в ответе», `judge_split` → «судья не уверен: голоса разошлись») |
| 3 | **SC3.** The «без решения» share measured before and after, both recorded; protocol changed at most once and frozen; old runs reassessed after the change | ✓ VERIFIED | **Before** (`~/agent-lab-evidence/phase-02/before.txt`, re-measured by the verifier with the final dist — identical): `fae4ee59` notMeasured 4/13 (31%), `a92fd6ae` 7/15 (47%). **After**: the paid v11 pilot re-judged 3 deviating `fae4ee59` situations — record `17d77d54` exists, `assessmentOf=fae4ee59…`, 3 judged trials with `judgedBeforeSeq = 4,12,12` equal to `judgeReceipt.cutBefore = 4,12,12`, `costUsd=0.43039`. All 3 stayed undecided (`judge_unclear`), so `gate.txt` = `NO-GO decided=0/3 cost=$0.4304 reason=no-reduction`. The v11 code was reverted (commit `c8b9e27`): `git diff fa79f2e HEAD -- src extensions` shows `src/judge.ts`, `src/outcomes.ts`, `src/comparison.ts`, `src/evaluation.ts` untouched; `JUDGE_PROTOCOL` is `version: 10`, `COUNTING_RULES = 'goal-v1'`. `freeze.txt` = `protocol=v10-unchanged frozen=2026-09-17T03:48:37+0300 reason=no-reduction`. Net protocol changes = 0 (≤ 1) and frozen a day before the 2026-09-18 deadline; because nothing changed, no reassessment of old runs was owed, and the stored runs still read 0/9+4 and 1/8+7 with audits 13/13 and 14/14 |
| 4 | **SC4.** Before the run the owner sees on one screen what the agent must do in each situation and by which rule, confirms everything with one action or corrects a situation's expectation in their own words, without editing checks | ✓ VERIFIED | `expectationSheet` (`src/quality.ts:139`) built from the same `ruleRegister` as the failure explanations. Verifier re-ran `expectation-check.mts` read-only on the real acquiring draft `37f78e1a`: `situations=13 goalRows=13 ruleRows=55 unverifiedRows=0 markers=1 versionOk=true confirmed=true`, board at 40/60/80/110/160 `over=0 head=true selected=true`, `keys y=accept e=expect scenario=true`. Record inspection of `37f78e1a`: `ownerExpectationScenarioIds` = 1 entry; for it `successCriteria === ownerText` and `goal_attainment.passCriteria === ownerText` (85-char synthetic owner sentence, byte-identical), `checks: 0` untouched, `acceptedTests: 13` for `scenarios: 13` with `acceptedDraftHash` present — one action confirmed all 13 |
| 5 | 02-01/02-02 (judge protocol v11, prefix judging, goal-v2 counting) — **superseded by the 02-03 NO-GO rollback**: on NO-GO the code returns to 02-01's `plan_head_before`, the suite is green and the SUMMARY states «протокол судьи не изменён» | ✓ VERIFIED | Rollback is exact: `git diff fa79f2e HEAD` touches no judge/outcomes/comparison/evaluation/store file; `src/contracts.ts` has no `judgedBeforeSeq`; `src/judge.ts` has no `simulatorCut`/`prefixTrial`/`auditCut`/`JUDGE_PROTOCOL_V10`; `COUNTING_RULES = 'goal-v1'`. `02-03-SUMMARY.md` headline: «Протокол судьи не изменён: пилот не уменьшил „без решения"». Suite green (see Behavioral Spot-Checks) |
| 6 | 02-03: every paid step behind a budget gate ≤ $6; the pilot re-judges exactly three stored trials; live v11 receipts verify; dist swapped/restored by rename with no Pi process and no writer lock | ✓ VERIFIED | `budget-pilot.txt` = `spent=$0.0000 upper=$0.8367 cap=$6 decision=GO`; `ledger.txt` holds one record id; total spend $0.4304 ≤ $6. `pilot-audit.txt` = `audit=3/3` (every pilot receipt verified), `pilot-cards.txt` names the 3 cards with `cut=4,12,12`. `preflight.txt` records `pgrep pi = (none)` and `no lock` before each swap; `dist-restore.txt` records the restore path and that the v11 build was kept. No `after.txt` exists — correct, it is required only on GO |
| 7 | 02-04: the explanation is built from the stored record with no model call; F1 variants (cited reply / evidence reply / last reply / no reply / tampered quote / unknown rule / no rule / ≤2 rules + «и ещё K» / violated prompt rule / machine-format filter) behave as specified | ✓ VERIFIED | `src/explain.ts` imports only `contracts`, `outcomes`, `judge`, `plural` — no model, no I/O. All 14 `test/explain.test.ts` cases pass in a snapshot run, including the CLI-spawn case. Observed live: `и ещё` ×9 on fae4ee59, `Нарушено правило` ×8, `…` count 0 |
| 8 | 02-04: `ResultView.failures` has exactly `decided − passed` entries in record order; the summary prints `Главные причины провалов:` then `Все провалы (n):`; the old `Почему:` section is gone | ✓ VERIFIED | fae4ee59 decided 9 − passed 0 = 9 `✗` blocks and `Все провалы (9):`; a92fd6ae 8 − 1 = 7 and `Все провалы (7):`. `measure-undecided --explain` reports `viewFailures=9` / `7`. `grep "'Почему:'"` in `src/cli.ts`, `src/quality.ts` → empty |
| 9 | 02-04 backstop: a unit test scans F1/F2/F3 output for the forbidden-jargon list and fails on any hit | ✓ VERIFIED | `test/explain.test.ts:311` «jargon backstop: no explanation row carries machine words or requirement ids» passes. Live check on both real summaries: `grep -cE 'goal_attainment|prompt_compliance|user_fidelity|рубрик|протокол|кластер|метрик|judge|seq'` → 0 |
| 10 | 02-05: the Pi tool payload carries `failureLines`; the collapsed result and the board show the same first block, cause section and pointer as the CLI; the old «ЧТО ТРЕБУЕТ ВНИМАНИЯ» block is gone | ✓ VERIFIED | Verifier re-ran `pi-surface-check.mts`: `OK surfaces=3 lines=9 sections=23 id=fae4ee59`, `OK surfaces=3 lines=12 sections=19 id=a92fd6ae`. `extensions/agent-lab.ts:33,96,108` build `failureLines` from `causeSection` + `allFailuresPointer`; `extensions/cards.ts` uses `resultViewRows`/`causeSection`/`failureListRows`. `grep "ЧТО ТРЕБУЕТ ВНИМАНИЯ"` → empty |
| 11 | 02-05 backstop: long Cyrillic rows wrapped at inner widths 36/56/76/106/156 — no row over the width, no `…`, words equal the source | ✓ VERIFIED | Verifier re-ran `board-width-check.mts`: `wrap … inner=36/56/76/106/156 over=0 ellipsis=0 words=equal` for both runs. Backing test `test/cards.test.ts:531` passes |
| 12 | 02-05: saved cause examples carry the verified explanation; the rationale-clipping helper is gone | ✓ VERIFIED | `src/quality.ts:534` `failureExplanation(record, scenario, trial)`; `grep clipRationale|shortRationale` → empty; `test/quality.test.ts` passes |
| 13 | 02-06: on the real acquiring runs every reply part is a judge-cited verified quote and every shown rule is numbered and verified | ✓ VERIFIED | `measure-undecided --explain` (verifier run): 16 failed situations across both runs, `judgeCited` on 16/16, `unverifiedRules=0` and `unverifiedRows=0` on every card, `cut=-` everywhere (correct: v11 was not kept) |
| 14 | 02-06: the board renders the real runs at 40/60/80/110/160 columns, collapsed and expanded, with no row wider than the screen and only Pi theme tokens | ✓ VERIFIED | `board-width-check.mts` (verifier run) exit 0: `over=0` at every width, collapsed and expanded, tokens `accent,borderMuted,dim,error,muted,text,warning` only |
| 15 | 02-06 backstop: light and dark Pi themes look right on the explanation rows | ⏭ DEFERRED to Phase 4 | The plan itself defers the real screenshot to phase 4; Phase 4 SC5 covers «Кириллица корректна в светлой и тёмной темах на ширине от 40 до 160 колонок». Token list evidence recorded (T14) |
| 16 | 02-07: `expectationSheet` content, head line, right-aligned labels, version line, the three «не записано / не подтверждено / нет правила» fallbacks, machine-format filter, and the 0 / 1–9 / 10–20 label widths | ✓ VERIFIED | `src/quality.ts:139-175`; `Версия ожиданий: <hash12>` at `src/quality.ts:143`; owner marker «Ожидание изменено владельцем — с прошлыми прогонами не сравнивается.» at `src/quality.ts:170`. Tests `test/quality.test.ts:115,153,171` pass. Live sheet on a 13-situation draft: `goalRows=13 ruleRows=55 unverifiedRows=0 versionOk=true` |
| 17 | 02-07: `acceptDraft` confirms all at once / is idempotent / rejects an empty draft, a compare record and a started run; `setExpectation` writes the trimmed owner text verbatim into `successCriteria` and the goal pass criterion, keeps checks, clears review stamps and names every rejection; `start({requireAccepted})` refuses a stale confirmation; `draftHash`/`measurementHash` invariants hold | ✓ VERIFIED | `src/experiment.ts:759-806` reviewed line by line; behavioural tests pass (`test/experiment.test.ts:611,652,727`, `test/workflow.test.ts`). The manifest clause was broken by the first fix round and restored by `d4d9aa0`: measured with both builds side by side, `37f78e1a` (which carries the owner marker) hashes identically with and without `ownerExpectationScenarioIds`, and the assertion «the marker never changes what is measured» is back in `test/experiment.test.ts`. Every `draftHash` in `.agent-lab` is byte-identical under both builds |
| 18 | 02-08: board section 2 shows the sheet; `y`/`e` act only inside that scope; header states, notice kinds, tab label, help row, `r` confirm-and-start, the chat `agent_lab_accept` loop and `sheetLines` in tool results | ✓ VERIFIED | `extensions/cards.ts:47,361,397,491-492,527,613` (BoardAction `expect`/`accept`, sheet load, three header states, scoped `y`/`e`, tab label, help row); `extensions/agent-lab.ts:43,102,547-580,628-629,870-894` (sheetLines, chat accept loop, `lab.start(..., requireAccepted: true)`, refusal notice with `y — подтвердить.`). Owner text enters only through `ctx.ui.editor` (`extensions/agent-lab.ts:563,881`). Behavioral tests pass: `test/cards.test.ts:591,663,686` and `test/extension.test.ts:1036,1087,1137,1190` |
| 19 | 02-08 backstop: the board sheet at widths 40/60/80/110/160 has no row wider than the screen, no `…`, and every word | ✓ VERIFIED | `expectation-check.mts` (verifier run) on the real draft: `board 37f78e1a width=40/60/80/110/160 over=0 head=true selected=true`; `board-width-check.mts` `ellipsis=0 words=equal` |
| 20 | 02-09: on a real acquiring draft the sheet prints through `agent-lab accept`, the owner text becomes the verbatim criterion and reaches the judge input, `--yes` confirms all, `diff` refuses to compare the edited situation, and the final dist keeps the stored counts, surfaces and widths | ✓ VERIFIED | Draft `37f78e1a` (repeat of `61521e0d`) exists with `acceptedTests: 13`, `acceptedDraftHash` set, 1 owner-edited situation stored verbatim (T4). `trust-check-1.txt` records `applied … criteria=verbatim passCriteria=verbatim judgeInput=true`. Verifier re-ran `diff --before 61521e0d --after 37f78e1a`: «Прогоны несравнимы: 12 пар. Исправления и регрессии не подсчитываются.» with the changed-card reason named. Final dist built from `376562e`, and `git diff 376562e HEAD -- src extensions` is empty, so dist matches HEAD source. Stored counts re-measured: 0/9+4 and 1/8+7, audits 13/13 and 14/14 |
| 21 | 02-09 backstop: a person opens `/agent-lab <DRAFT>` in Pi, presses `2`, `e`, `y`, `r` and cancels, in a light and a dark theme | ? INSUFFICIENT_SPEC → human | Declared not possible in an unattended run by the plan itself. The script stand-ins pass (`keys y=accept e=expect scenario=true`, board render at 5 widths), but the native editor dialog, the themes and «cancel starts nothing» need a person. See Human Verification |

**Score:** 19/21 truths verified (0 present-but-behavior-unverified, 1 deferred to Phase 4, 1 needs a human)

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | Light and dark Pi themes look right on the explanation rows (02-06 backstop) | Phase 4 | Phase 4 SC5: «Кириллица корректна в светлой и тёмной темах на ширине от 40 до 160 колонок» |

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `src/explain.ts` | ruleRegister, ruleText, failureExplanation, exampleRows, rowsToLines, UNVERIFIED | ✓ VERIFIED | 216 lines, all 6 exports present, imported by `result-view.ts` and `quality.ts`, data flows from the stored record (Level 4) |
| `src/plural.ts` | pluralForm, no imports | ✓ VERIFIED | Leaf module; re-exported by `result-view.ts:7`, used by `explain.ts:4` and `quality.ts` |
| `src/result-view.ts` | ResultView.failures, topCauses, resultViewRows, causeSection, failureListRows, SECTION_TEXT, allFailuresPointer | ✓ VERIFIED | All exports present (`:228,285,297,264,270`); `failures`/`topCauses` populated from `failureExplanation` |
| `src/quality.ts` | expectationSheet; cause examples from failureExplanation | ✓ VERIFIED | `:139` and `:534`; imported by `cli.ts:17`, `extensions/cards.ts:6`, `extensions/agent-lab.ts` |
| `src/experiment.ts` | acceptDraft (all situations), setExpectation, start({requireAccepted}), draftHash with ownerExpectationScenarioIds | ✓ VERIFIED | `:759,784,972,984` plus repeat handling at `:88-97` |
| `src/contracts.ts` | Experiment.ownerExpectationScenarioIds (optional, schema-checked) | ✓ VERIFIED | `:771,874,893` — zod field with a refinement tying ids to the set's situations |
| `src/cli.ts` | accept prints the sheet for multi-situation drafts | ✓ VERIFIED | `:281,288,291,294` |
| `extensions/cards.ts` | sheet rendering, y/e keys, accept/expect actions, header states, tab label, help, wrapRows | ✓ VERIFIED | `:47,76,361,397,491,527,613` |
| `extensions/agent-lab.ts` | failureLines, sheetLines, board accept/expect/run branches, chat accept loop | ✓ VERIFIED | `:33,43,96,102,547,568,628,870,875,888` |
| `src/judge.ts`, `src/outcomes.ts`, `src/comparison.ts`, `src/evaluation.ts` | v11 artifacts (02-01/02-02) | ⏮ ROLLED BACK (by plan) | Byte-identical to `fa79f2e` — the intended NO-GO outcome, not a gap |
| `.planning/.../measure-undecided.mjs` | read-only before/after counter | ✓ VERIFIED | 8.6 KB, runs, prints ids/codes/counts only |
| `.planning/.../board-width-check.mts` | board render check at 5 widths | ✓ VERIFIED | Re-run by the verifier, exit 0 |
| `.planning/.../expectation-check.mts` | sheet, board-width and key checks on a real draft | ✓ VERIFIED | Re-run by the verifier read-only, exit 0 |
| `~/agent-lab-evidence/phase-02/` | preflight, dist provenance, ledger, pilot, gate, freeze, before | ✓ VERIFIED | 0700/0600 outside the repository; `after.txt` correctly absent (NO-GO) |
| `test/explain.test.ts` | register order, F1 variants, tamper table, jargon backstop, CLI spawn | ✓ VERIFIED | 14 tests, all pass |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `src/result-view.ts` | `src/explain.ts` | `buildResultView` → `failureExplanation` per failed card | ✓ WIRED | `causesOf` and the failures loop; live output shows 9/7 blocks |
| `src/explain.ts` | `src/contracts.ts` | `verbatimSpan` for every rule quote, `MACHINE_FORMAT` filter | ✓ WIRED | `:68,125`; unverified rules counted, never numbered |
| `src/cli.ts summary` | `src/result-view.ts` | `resultViewLines` + `causeSection` + `failureListRows` | ✓ WIRED | Live CLI run shows all three sections in order |
| `src/quality.ts causes()` | `src/explain.ts` | `example.explanation = failureExplanation(...)` | ✓ WIRED | `:534` |
| `src/quality.ts expectationSheet` | `src/explain.ts ruleRegister` | one owner rule numbering for sheet and failures | ✓ WIRED | `:6,152` |
| `src/cli.ts accept` | `src/experiment.ts acceptDraft` | `lab.acceptDraft(id, sheet.draftHash)` | ✓ WIRED | `:291` |
| `src/experiment.ts setExpectation` | `src/judge.ts judgeInput` | owner text reaches the judge input through `successCriteria` + goal `passCriteria` | ✓ WIRED | Verified on the stored draft: both fields byte-equal to the owner text; `judgeInput=true` in the 02-09 apply check |
| `extensions/cards.ts handleInput` | `extensions/agent-lab.ts` loop | BoardAction `accept` / `expect` | ✓ WIRED | `cards.ts:491-492` → `agent-lab.ts:875,888` |
| `extensions/agent-lab.ts` | `dist/experiment.js` | `acceptDraft`, `setExpectation`, `start({requireAccepted: true})` | ✓ WIRED | `:547,568,628-629,870-871,886,894` |
| `extensions/*` | `dist/quality.js expectationSheet` | board rows, compact confirm body and `sheetLines` from one function | ✓ WIRED | `cards.ts:6,361`; `agent-lab.ts:43,549` |
| `extensions/agent-lab.ts summary()` | `dist/result-view.js` | `failureLines` from `causeSection` + `allFailuresPointer` | ✓ WIRED | `:95-108`; pi-surface-check confirms parity across 3 surfaces |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `src/explain.ts` | `said.quote` | `trial.events` assistant reply, substring-checked against the judge citation | Yes — 16/16 judge-cited, 0 unverified on the real runs | ✓ FLOWING |
| `src/explain.ts` | `rules[].quote` | `record.sources[].content` via `verbatimSpan` | Yes — 22 numbered rule rows on fae4ee59, 0 unverified | ✓ FLOWING |
| `src/result-view.ts` | `failures`, `topCauses` | `record.trials` / `record.failureModes` | Yes — 9 and 7 entries, 3 causes | ✓ FLOWING |
| `src/result-view.ts` | `notMeasured.reasons[].scenarioIds` | `cardVerdict` codes → titles | Yes — 4 and 7 `?` rows | ✓ FLOWING |
| `src/quality.ts` | `expectationSheet.lines` | `record.scenarios` + `ruleRegister` | Yes — 13 situations, 55 rule rows on the real draft | ✓ FLOWING |
| `src/experiment.ts` | `scenario.successCriteria` | owner text from `ctx.ui.editor` / `--text-file` | Yes — stored byte-identical (85 chars) | ✓ FLOWING |

### Behavioral Spot-Checks

Every check below was re-run after the fixes, against `dist/` built inside a `git archive HEAD`
snapshot (the worktree `dist/` is still the pre-fix build and was deliberately not touched).

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Full suite, committed state | `snap-test.sh --full` ×7 across both fix rounds (×3 on `d4d9aa0`) | six runs `# pass 452 # fail 0` + clean typecheck; one earlier run `# pass 451 # fail 1` (name lost to truncated output) | ⚠️ PASS with a flake |
| Failure explanations, run 1 | `node $SNAP/dist/cli.js summary --id fae4ee59…` (re-run on `d4d9aa0`) | 9 `✗`, 4 `?`, 22 numbered rules, 0 unverified, 0 `…`, 0 jargon; output byte-identical to the previous fixed build | ✓ PASS |
| Undecided shares unchanged | `measure-undecided.mjs --dist $SNAP/dist` | `fae4ee59 notMeasured=4 share=31%`, `a92fd6ae notMeasured=7 share=47%` — identical to `before.txt` | ✓ PASS |
| Explanations still fully verified | `measure-undecided.mjs --explain --dist $SNAP/dist` | `failed=9 judgeCited=9 unverifiedRows=0` and `failed=7 judgeCited=7 unverifiedRows=0` | ✓ PASS |
| WR-01 effect on rule attribution | same command, `violated=` field | fae4ee59 5 → 3, a92fd6ae 1 → 4. Both directions are correct: the ratio test drops weak unique matches, and dropping weak matches lets a previously ambiguous card resolve to exactly one rule. Rule register size is unchanged (44 = 44 on both runs), so no rule numbers moved | ✓ PASS |
| CR-03 closed | read of `src/quality.ts:534-546`, `src/report.ts:159,250`, `src/quality.ts:656` | `causeExample` returns `verified: boolean` with the new `UNVERIFIED_REPLY` status line; all three renderers wrap in «…» only when `verified` | ✓ PASS |
| CR-01 closed | read of `src/contracts.ts:760,868`, `src/experiment.ts:1006-1011,1283`, `extensions/agent-lab.ts:93,637,879`, `src/report.ts:256`, `extensions/cards.ts:612` | `reviewMode: 'expectations'` is a third enum value; the run paths stamp it; the honest limitation is pushed; the disclaimer is replaced by «Подтверждая, вы подтверждаете ожидания ситуаций выше. Оценки судьи вы не проверяли.»; both surfaces say «ожидания подтверждены владельцем»; the compare downgrade still tests `reviewMode !== 'human'` | ✓ PASS |
| CR-02 closed | read of `extensions/agent-lab.ts:75` | non-production sets append «Что вы подтверждаете дословно:» with the opening and every exact check | ✓ PASS |
| Owner marker does not move the manifest (02-07 must-have) | `measurementHash` of `37f78e1a` (carries the marker) with and without `ownerExpectationScenarioIds`, both builds | identical — restored by `d4d9aa0`; the pinning assertion «the marker never changes what is measured» is back | ✓ PASS |
| `draftHash` of every stored record unchanged | `draftHash` under both builds, 4 records | byte-identical in all four (`0adb5866c445`, `013cb65f513d`, `30cee15da8c0`, `bca58a5b3d12`) | ✓ PASS |
| Residual: control set in the manifest | `measurementHash(61521e0d)` under both builds | `62de5a39e086` → `c5713f51dab0` — by design, no declared must-have governs it, nothing observable changes | ℹ️ INFO |
| Stored runs still open and compare | `cli.js summary` ×2, `cli.js diff --before 61521e0d --after 37f78e1a` | all exit 0; `compareRuns` pairs by scenario content, not by `manifestHash`, so the «до/после» path is not broken by the hash change | ✓ PASS |
| Live Pi keypresses in two themes | — | requires a person at a terminal | ? SKIP → human |

### Probe Execution

| Probe | Command | Result | Status |
| ----- | ------- | ------ | ------ |
| `.planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts` | `npx tsx … --id fae4ee59 --id a92fd6ae` (re-run from the snapshot) | `OK surfaces=3 lines=9 sections=22` / `OK surfaces=3 lines=12 sections=21` (section counts follow the WR-01 attribution change) | PASS |
| `.planning/phases/02-…/board-width-check.mts` | `npx tsx … --id fae4ee59 --id a92fd6ae` (re-run from the snapshot) | 30 of 30 result lines `over=0`, none over the width | PASS |
| `.planning/phases/02-…/expectation-check.mts` | `npx tsx … --draft 37f78e1a` (read-only, re-run from the snapshot) | `situations=13 ruleRows=55 unverifiedRows=0 versionOk=true confirmed=true`, 5 widths `over=0`, `keys y=accept e=expect` — unchanged by the fixes | PASS |
| `.planning/phases/02-…/measure-undecided.mjs` | `node … --id fae4ee59 --id a92fd6ae [--explain]` | counts as recorded in `before.txt` | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| JUDGE-01 | 02-04, 02-05, 02-06 | Failure as «должен был X → сказал Y → правило N (цитата)», owner numbering, unverified marking | ✓ SATISFIED | T1, T7, T13 |
| JUDGE-02 | 02-02, 02-04, 02-05, 02-06 | «Без решения» with a named plain-words cause | ✓ SATISFIED | T2 (vocabulary superset noted) |
| JUDGE-03 | 02-01, 02-02, 02-03, 02-06 | Verdict wherever there is evidence; share measured before and after; ≤1 protocol change before the freeze; reassessment after a change | ✓ SATISFIED | T3, T5, T6 — the measured NO-GO is a recorded decision not to change the protocol |
| TRUST-10 | 02-07, 02-08, 02-09 | One screen with what the agent must do and by which rule; one action confirms | ✓ SATISFIED | T4, T16, T17, T18, T20 |
| TRUST-11 | 02-07, 02-08, 02-09 | The owner corrects a situation's expectation in their own words, without editing checks | ✓ SATISFIED | T4 (verbatim storage, `checks: 0`), T17, T18 |

No orphaned requirements: REQUIREMENTS.md maps exactly JUDGE-01/02/03 and TRUST-10/11 to Phase 2, and every one is claimed by at least one plan.

### Anti-Patterns Found

Scanned all 16 files changed between `fa79f2e` (phase-2 base) and HEAD.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| — | — | `TBD` / `FIXME` / `XXX` | — | None found |
| — | — | `TODO` / `HACK` / `PLACEHOLDER` | — | None found |
| `extensions/agent-lab.ts` | 637, 879, 93 | Record claims a human check the dialog disclaims (CR-01) | ✅ FIXED (was 🛑 Blocker) | `reviewMode: 'human'` suppresses the automated-validation limitation, prints «проверено человеком» in the exported report and on the board, and removes the comparison downgrade — while the confirmation still says «Запуск не означает, что вы вручную проверили все ожидания или оценки.» Confirmed by reading the code and `git show ba18ada` (was `reviewer: 'automated'`) |
| `src/quality.ts` 534-546, `src/report.ts` 159, 250 | — | The «не подтверждено» sentinel exported inside guillemets (CR-03) | ✅ FIXED (was 🛑 Blocker) | The forwarded HTML/Markdown report states that the agent said «объяснение не подтверждено цитатой». Latent today (0/16 unverified) but reachable |
| `extensions/agent-lab.ts` | 75 | Run confirmation lost `Запрос:` and `Проверка:` rows for every multi-situation evaluate draft (CR-02) | ✅ FIXED (was ⚠️ Warning) | Declared by an 02-08 must-have («the run-plan body shows the compact sheet instead of the old per-situation validation block»), but the old compact branch fired only for all-production sets; saved regression, golden and mixed suites now also lose the exact checks that `acceptDraft` seals |
| `src/explain.ts` | 133-148 | `violatedRule` accepts a 12-character substring coincidence (WR-01) | ✅ FIXED (was ⚠️ Warning) | A single wrong match is named as «Нарушено правило N» with full confidence; the «не подтверждено» fallback fires only on 0 or ≥2 matches. 5 and 1 violated rows on the pilot runs rest on this rule |
| `src/explain.ts` | 69-79 | The line number is re-found with `indexOf`, not the matched offset (WR-02) | ✅ FIXED (was ⚠️ Warning) | A quote repeated in a source names the wrong `строка L` and gives two requirements an arbitrary order; the row is presented as verified evidence |
| `src/experiment.ts` | 53-62 | `measurementHash` hashes the control set (WR-07) | ℹ️ Info (was 🛑 Blocker) | The owner-expectation half was removed by `d4d9aa0`, restoring the declared must-have. The control set stays by design: `measurementHash(61521e0d)` is `62de5a39e086` under the shipped dist and `c5713f51dab0` under the fixed code. No declared must-have governs that field and nothing observable changes (draftHashes identical, stored hashes untouched, `compareRuns` pairs by content, no resume path) |
| `test/*` (full suite) | — | One full run in seven failed a single test (451/452) | ⚠️ Warning | The other six runs — including three on the corrected commit — were 452/452 with a clean typecheck. The failing test's name was lost with the truncated output of that run. A flake in the suite that certifies the number is worth ten minutes before the demo |

Full list is in `02-REVIEW.md` (3 critical, 7 warning, 3 info) and `02-REVIEW-FIX.md`
(10 of 10 in-scope findings fixed; IN-01…IN-03 deliberately out of scope). This re-verification
read every fix at the source and re-ran the decisive checks against a snapshot build.

Informational observations (no action required):

- **SC2 vocabulary is a superset.** The ROADMAP names two causes; the shipped table `NOT_MEASURED_TEXT` has 18 plain-language labels including both. On the pilot runs the dominant label is «симулятор отклонился от диалога», not one of the two literally named. This is more specific, not less, carries no jargon, and the two named labels exist and are used where they apply (`judge_split` appears once per run). Judged as satisfying the intent; flagged so the owner can rule otherwise.
- **The pilot record `17d77d54` lives in `~/agent-lab-evidence/phase-02/pilot-17d77d54/`, not in `.agent-lab/`.** It therefore does not appear in `agent-lab list`. This matches the 02-03 decision «пилот, не результат», but 02-03 also noted «phase 4 … pilot record shows a list warning» — phase 4 should not expect to find it in the data directory.
- **`diff` against an edited draft** names the changed-card list on each incomparable pair. The wording comes from `src/comparison.ts`, which this phase did not modify.

### Human Verification Required

#### 1. Expectation sheet keys on a live Pi screen, light and dark themes

**Test:** Open `/agent-lab 37f78e1a` in a live Pi session. Press `2` to reach «Ситуации», move with `↑/↓`, press `e` on one situation (cancel once, then save a short text), press `y`, then press `r` and cancel the confirmation. Repeat in a light and a dark Pi theme.
**Expected:** Section 2 shows the sheet header, one situation per row with its rule rows and `Версия ожиданий:`; `e` opens the native editor titled «Что агент должен сделать в этой ситуации? Своими словами.»; cancel reopens silently; `y` returns the board with «Ожидания подтверждены: 13 ситуаций. r — запуск.»; `r` asks «Подтвердить ожидания и запустить?» and cancelling starts nothing; rows stay readable in both themes.
**Why human:** 02-09 declared this backstop impossible in an unattended run. `expectation-click`-style scripts confirm the key routing (`y=accept`, `e=expect`) and the render at five widths, but only a person can confirm the native Pi dialog, the theme colors, and that cancelling truly starts no run.

### Gaps Summary

**No gaps remain.** All three blockers this verification raised are closed, and I checked each one
in the code and with a measurement rather than in the fix reports.

1. **CR-01 closed.** `reviewMode: 'expectations'` is a third enum value; both Pi run paths stamp it;
   the confirmation now says «Подтверждая, вы подтверждаете ожидания ситуаций выше. Оценки судьи вы
   не проверяли.»; the limitation «Владелец подтвердил ожидания ситуаций перед запуском. Определения
   карточек и оценки судьи человеком не проверялись.» is pushed instead of silently dropped; both
   display surfaces say «ожидания подтверждены владельцем»; and the comparison downgrade still
   requires a real `'human'` review, so a confirmed draft cannot lift an `improved` verdict.
2. **CR-03 closed.** The cause carries `verified: boolean`; the HTML report, the Markdown report and
   the terminal cause list quote only when it is true, and print the status line plainly otherwise.
3. **WR-07 over-reach closed** (`d4d9aa0`). `ownerExpectationScenarioIds` is out of the manifest and
   the assertion «the marker never changes what is measured» is back, with a sound reason recorded
   in the code: an owner edit already rewrites `successCriteria` and the goal rubric, so the card
   fingerprint moves on its own and the marker is only a label on that change. Measured: `37f78e1a`,
   which carries the marker, hashes identically with and without it, and every stored record's
   `draftHash` is byte-identical under both builds.

Two things are recorded rather than hidden, neither blocking:

- **The control set stays in the manifest**, which is the WR-07 fix the review asked for. The stored
  run `61521e0d` therefore computes `62de5a39e086` under the shipped dist and `c5713f51dab0` under
  the fixed code. No declared phase-2 must-have governs that field; stored `manifestHash` strings are
  untouched; `compareRuns` pairs by scenario content, not by hash; there is no general run-resume
  path; and a record written before the field existed keeps its hash.
- **The suite is flaky.** One of seven full runs across the fix rounds failed a single test
  (451/452); the other six, including three on the corrected commit, were 452/452 with a clean
  typecheck. The failing test could not be named. Worth ten minutes before the demo.

**Why this is `human_needed` and not `passed`:** one verification item still needs a person — the
live Pi walkthrough of the expectation sheet (`2`, `e`, `y`, `r`, cancel) in a light and a dark
theme, which 02-09 itself declared impossible in an unattended run. `passed` is only valid when that
section is empty. Everything automatable is green; do the walkthrough, record it in the phase's
UAT, and the status becomes `passed` with no code change.

Every ROADMAP success criterion is achieved and demonstrated on the real acquiring records, not
only in unit tests:

- **SC1/SC2** are proven on 16 failed and 11 unmeasured situations across `fae4ee59` and
  `a92fd6ae`, with every reply quote judge-cited and verified and every shown rule numbered from
  the owner's materials.
- **SC3** is the honest case. The phase built the v11 prefix-judging protocol, paid $0.43 to test
  it on the three situations it was designed to rescue, decided 0 of 3, wrote `NO-GO`, reverted
  the code to a byte-identical `fa79f2e` state and froze the protocol at v10 a day before the
  deadline. The «до» numbers (4/13 and 7/15) are recorded and were re-measured identically at every
  stage of this verification; the «после» number is the same by construction, because nothing
  changed, and the pilot's own after-number (`decided=0/3`) is recorded in `gate.txt` and
  reproducible from the archived pilot record. Protocol changes: 0 of the allowed 1. Because the
  protocol did not change, no reassessment of old runs was owed.
- **SC4** is proven on a real 13-situation acquiring draft: the sheet renders at every width, one
  key confirms all 13, and one owner sentence is stored byte-identically as both the situation's
  criterion and the judge's goal pass criterion with the checks untouched.

The light/dark theme look of the explanation rows stays deferred to Phase 4, which owns that
criterion.


---

_Verified: 2026-09-17T12:05:00Z_
_Verifier: Claude (gsd-verifier)_
