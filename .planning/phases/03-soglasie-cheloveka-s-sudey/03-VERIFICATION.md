---
phase: 03-soglasie-cheloveka-s-sudey
verified: 2026-09-17T15:20:00Z
status: human_needed
score: 11/12 must-haves verified (all 3 ROADMAP success criteria met; 1 item awaits a person at a live Pi terminal)
covered_files:
  - ".planning/REQUIREMENTS.md"
  - ".planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/03-01-PLAN.md"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/03-01-SUMMARY.md"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/03-02-PLAN.md"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/03-02-SUMMARY.md"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/03-03-PLAN.md"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/03-03-SUMMARY.md"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/03-04-PLAN.md"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/03-04-SUMMARY.md"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/03-05-PLAN.md"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/03-05-SUMMARY.md"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/03-06-PLAN.md"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/03-06-SUMMARY.md"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/03-07-PLAN.md"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/03-07-SUMMARY.md"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/03-VALIDATION.md"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/agreement-check.mts"
  - ".planning/phases/03-soglasie-cheloveka-s-sudey/deferred-items.md"
  - "extensions/agent-lab.ts"
  - "extensions/cards.ts"
  - "src/agreement.ts"
  - "src/cli.ts"
  - "src/comparison.ts"
  - "src/contracts.ts"
  - "src/experiment.ts"
  - "src/explain.ts"
  - "src/outcomes.ts"
  - "src/result-view.ts"
  - "test/agreement.test.ts"
  - "test/cards.test.ts"
  - "test/comparison.test.ts"
  - "test/contracts.test.ts"
  - "test/experiment.test.ts"
  - "test/explain.test.ts"
  - "test/extension.test.ts"
  - "test/helpers/copy-check.ts"
  - "test/outcomes.test.ts"
  - "test/result-view.test.ts"
  - "test/store.test.ts"
covered_digest: "v1:sha256:b55731dd3b8c0bc4a8162fd317dda470f4ba8bc1c0fcb962f4f627a78c45f102"
behavior_unverified: 0
overrides_applied: 0
deferred:
  - truth: "Every row of the section-3 board fits a narrow board without being cut: the second footer line (55 columns) is cut with «…» at inner widths 36–54"
    addressed_in: "Phase 4"
    evidence: "Phase 4 success criterion 5: «Блок, доска и прогресс выглядят единообразно: … перенос по словам без обрезки … на ширине от 40 до 160 колонок.» Recorded in deferred-items.md (from 03-05). The phase-3 UI-SPEC required leaving that line unchanged."
  - truth: "The manager sees the agreement share in a text summary or HTML file they can be sent without opening Pi"
    addressed_in: "Phase 5"
    evidence: "Phase 5 success criterion 1 / SHARE-01: the summary lists «… «не измерено», согласие …». Today the manager-facing surfaces are the CLI `summary` and the Pi chat answer, and both show the agreement row and the disagreement list (verified below). `src/report.ts` has no agreement row yet."
human_verification:
  - test: "After the judge protocol freeze, open `/agent-lab` in a live Pi session, choose the frozen demo record, press `3` and put real marks with `y`, `n` (type a reason) and `s` on a few failures and on the `ПРОВЕРЬТЕ И УСПЕХ` situation."
    expected: "Each mark is saved with the judge verdict and judge version; the first block reads `Согласие с судьёй: N из M проверенных · мало проверок (провалы: … · успехи: …).`; `Несогласия с судьёй (K):` lists each disagreement with its full reason; the marks remain after reopening."
    why_human: "Only the owner can agree or disagree with the judge. The scripted check (agreement-check.mts) proves the path on temporary copies with synthetic answers, but 0 real records hold a mark (03-VALIDATION Manual-Only, CTX-19)."
  - test: "Open section 3 of the demo record in one light and one dark Pi theme; send a screenshot or a short written note."
    expected: "The ПРОВЕРКА СУДЬИ block, the key row (accent), the mark rows (success / warning / muted), the section-1 agreement row (text) with its tail rows (muted) and the НЕСОГЛАСИЯ С СУДЬЁЙ heading are all readable in both themes."
    why_human: "03-07 backstop truth; theme colors need eyes on a real terminal. Phase 4 success criterion 5 also covers the theme look."
  - test: "In section 3, read the help (`?`) and the key row, press `n` once, then cancel the editor."
    expected: "`n` reads naturally as «не согласен» (it used to mean «не пройдено»); the editor is titled `Судья решил: … Почему вы не согласны? Коротко, своими словами.`; cancelling saves nothing and shows no notice."
    why_human: "Only the owner can judge whether the remapped key feels right (03-VALIDATION Manual-Only)."
---

# Phase 3: Согласие человека с судьёй — Verification Report

**Phase goal:** Владелец, читая провал, одной клавишей отмечает согласие с судьёй, а он и менеджер видят честную долю согласия «N из M проверенных» отдельно по провалам и успехам.
**Verified:** 2026-09-17T15:20:00Z
**Status:** human_needed. No gaps remain. Three checks need a person at a live Pi terminal.
**Re-verification:** No, this is the first verification.
**Mode:** mvp. The goal is written as a phase goal, not a User Story, so the three ROADMAP success criteria below replace the User Flow table, as in phase 2.

**What was checked and where.** HEAD is `5659092`. That commit only adds `03-REVIEW.md`; `src/` and `extensions/` match `5ccc792`, which is the commit `dist/` was built from (`dist-built-from-03.txt`). I ran every check below myself:
- `snap-test.sh --full` on a `git archive HEAD` snapshot.
- `agreement-check.mts`, `pi-surface-check.mts` and `verify-stored-runs.mjs` against the worktree `dist/`, which is the build a live Pi loads.

I did not run `npm test` or `npm run build` in the worktree, wrote nothing to `.agent-lab`, started no Pi and made no model call. `03-REVIEW.md` was not used as input.

## Goal Achievement

### ROADMAP success criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| SC1 | На провале владелец одной клавишей ставит «согласен / не согласен / не могу сказать»; при несогласии пишет причину; отметка хранит вердикт и версию судьи и остаётся после переоткрытия | ✓ VERIFIED | **Keys:** `extensions/cards.ts:692-695` maps `y`/`n`/`s` to `{type:'agree'}`. It acts only when `agreementTarget` is `ready`: an evaluate run in `results_review`/`complete`, not a control, and the primary metric was recorded as pass/fail. **Save:** `extensions/agent-lab.ts:921-962` asks for the reason through `ctx.ui.editor` on `n`, refuses an empty or >3000-char reason, and saves `source:'quick'` through `addHumanReview`. **Judge snapshot:** `src/experiment.ts:964-976` fills `judgeVerdict` from `trial.assessments` and `judge` from `trial.judgeReceipt ?? trial.judgeAudit`, overwriting any caller value, and rejects a wrong metric, an undecided judge, or a judge verdict that changed. **Tests:** `test/experiment.test.ts:2027` (a forged snapshot is replaced; `measurementHash` same, `resultHash` changed), `test/store.test.ts:165` (the mark survives a reload), `test/extension.test.ts:1063` and `:1202` (real command: y/n/s, cancel, empty reason, repeats). **Live:** my run of `agreement-check.mts` on 0700 copies of fae4ee59 and a92fd6ae gave `snapshot=3/3` and `4/4`, `measurementHash=same resultHash=changed`, and on reopen `reopenShowsMark=true`. |
| SC2 | Итог показывает «согласие N из M проверенных» со списком несогласий; считается по исходным оценкам судьи; при малом M это сказано словами | ✓ VERIFIED | **Count:** `src/agreement.ts:56-58` `recordedResult` reads only `trial.assessments[].result`, never `agentMetricResult`, so a disagreement counts as 0 of 1 (`test/agreement.test.ts:69`). **Row:** `src/result-view.ts:243-262` prints no percent below 10 (`PERCENT_FROM`), «мало проверок» below 20, and «N из M проверенных» for every M ≥ 1 (`test/result-view.test.ts:875`, cases M = 0/1/2/9/10/19/20). The list heading `Несогласия с судьёй (K):` comes from `agreementSectionLines`. **Wiring:** CLI `src/cli.ts:109`, Pi payload `extensions/agent-lab.ts:127`, board section 1 `extensions/cards.ts:437-465`. **Live:** the copies gave `agreement=1/2` and `2/3`, `cliAgreementRow=1`, `cliDisagreementHeading=1`, `surfaces=ok` (disagreements=1). |
| SC3 | В проверку подмешаны 2–3 случайные «справился», согласие отдельно по провалам и успехам | ✓ VERIFIED | **Sample:** `agreementSample` (`src/agreement.ts:80-88`, `PASS_SAMPLE = 3`) takes every pass when there are ≤3, otherwise 3 chosen by a hash of the run and trial ids. The draw is the same after a reopen and after a human flip, and a new run id gives a new draw (`test/agreement.test.ts:163`). **Queue:** sampled passes follow the failures (`unmarked`, `reviewOrder`) and are labelled `● ПРОВЕРЬТЕ И УСПЕХ`. **Split:** `failures`/`passes` groups feed `провалы: a из b · успехи: c из d`. **Live:** a92fd6ae copy gave `failures=1/2 passes=1/1 sample=1`; fae4ee59 copy gave `passes=0/0 sample=0` (no passes in that run). **Note:** the stored acquiring runs hold only 0 and 1 passes, so on real data the sample is 0–1, not 2–3. That is a data limit, not a code gap: the code takes all passes up to 3. |

### Observable truths (ROADMAP criteria plus plan must-haves)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1: one key, reason on disagreement, judge verdict and version stored, mark remains after reopen | ✓ VERIFIED | See SC1 above. |
| 2 | SC2: «N из M проверенных» plus disagreement list, counted on the recorded judgment, small M said in words | ✓ VERIFIED | See SC2 above. |
| 3 | SC3: sampled passes, agreement split by failures and passes | ✓ VERIFIED | See SC3 above. |
| 4 | 03-01: old reviews parse unchanged; new fields optional; a quick mark with no `metricId` or with `invalid` is rejected; `primaryMetricId` prefers goal, then the first failed agent metric, then the first passed one, never a RAG rubric | ✓ VERIFIED | **Schema:** `src/contracts.ts:646-658`, `.refine` on quick. **Metric choice:** `src/outcomes.ts:43-48`, filtered to `subject === 'agent'`. **Tests:** `test/contracts.test.ts:106`. **Real records:** `verify-stored-runs` exit 0 on both runs. |
| 5 | 03-01: counting rules. «не могу сказать» counts as unsure. A mark is stale when its verdict, protocol or input changed, or when it exists only in `sourceEvidence`. A later full review removes the quick pair. Controls never count. A running run reports nothing. | ✓ VERIFIED | **Code:** `src/agreement.ts:98-143`. **Tests:** `test/agreement.test.ts:76, 87, 110, 126, 137, 144, 154`. |
| 6 | 03-02: a quick disagreement moves the headline; a quick «не могу сказать» leaves the judge verdict in it; a decided quick mark closes the situation in `awaitingVerdict`; agreeing is not reported as a human remark | ✓ VERIFIED | **Code:** `src/outcomes.ts:59` and `:84` skip quick-unsure; `src/comparison.ts:188` skips quick agreement. **Tests:** `test/result-view.test.ts:239` (headline becomes `1 из 9 … 11%`, agreement `0 из 1`), `:250` (headline unchanged, tail row `Человек не смог решить: 1.`), `test/outcomes.test.ts:95`, `test/comparison.test.ts:783, 814`. |
| 7 | 03-03: CLI and Pi print `Несогласия с судьёй (K):` with the full, whitespace-collapsed, escaped reason, then the board pointer while the queue has unmarked situations. No tool writes a mark. | ✓ VERIFIED | **Code:** `src/result-view.ts:352-392`; CLI `safeLine` on each row (`src/cli.ts:109-110`); collapsed Pi render order at `extensions/agent-lab.ts:34-43`. The only other review tool, `agent_lab_review`, accepts only `id` and `trialId`, and the verdict comes from the person in native UI. **Tests:** `test/extension.test.ts:1317`, `:1365` (no tool schema takes a verdict or quick mark), `test/result-view.test.ts:943, 972, 985, 1032`. **Surface check (my run):** `OK … disagreements=0 next=1` on both real runs; `disagreements=1` on the marked copies. |
| 8 | 03-04: `y`/`n`/`s` act only in section 3 of a reviewable run on a decided non-control situation, and are inert elsewhere (typed into search, ignored while help is open). `n` on the run list still starts a new check. The editor edge cases, notices and repeat guards work. The queue leads with unmarked failures, then sampled passes. List labels and the `u` filter work. | ✓ VERIFIED | **Code:** `extensions/cards.ts:36-45, 60-68, 113-133, 676-708`. **Tests:** `test/cards.test.ts:443` (key scope, search, help, `n` on list → `new`), `:313`, `test/extension.test.ts:1063, 1202, 1235` (cancel/empty/long/same-reason notices, «Оценка судьи изменилась…» refusal, finalize text). |
| 9 | 03-05: section-3 header and footer tiers fit 36–156 columns without «…»; the help and detail rows name `y`/`n`/`s`; no visible text still names the retired quick-verdict keys | ✓ VERIFIED | `reviewHeader` / `resultsFooter` in `extensions/cards.ts:141+`. **Tests:** `test/cards.test.ts:596`, `:741`, `:807`, `:818`, `:1540-1553` (every tier scanned at the boundary widths). |
| 10 | 03-06: the agreement block shows evidence before `Судья:`; the evidence comes from the recorded judgment and does not change after a disagreement; each variant (sampled pass / other pass / stale / control / undecided) has its own row; section 1 shows `НЕСОГЛАСИЯ С СУДЬЁЙ`; widths 36–156 are not cut and ESC is escaped; the plain-language scan runs over F10/F11/F12, help and footers | ✓ VERIFIED | **Code:** `extensions/cards.ts:75-104`; `situationEvidence` in `src/explain.ts` builds from the record with `humanReviews: []`. **Tests:** `test/explain.test.ts:366, 407`, `test/cards.test.ts:1275, 1326, 1351, 1380, 1427, 1463, 1482, 1532-1553`. **Live:** `evidenceBeforeVerdict=true` on both copies. Both backstop-tagged truths have wired, passing tests, so they do not fall under `insufficient_spec`. |
| 11 | 03-07: a scripted run of the real `/agent-lab` on temporary copies gives the planned counts; the originals are unchanged; 0 real marks; `dist/` was rebuilt from phase-3 HEAD and swapped with no Pi process and no lock; the stored runs keep their phase-2 counts | ✓ VERIFIED | **My run** (exit 0): `fae4ee59 marks=3 agree=1 disagree=1 unsure=1 … agreement=1/2 failures=1/2 passes=0/0 sample=0 … originalsUnchanged=true` and `a92fd6ae marks=4 agree=2 disagree=1 unsure=1 … agreement=2/3 failures=1/2 passes=1/1 sample=1 … originalsUnchanged=true`, both matching the plan exactly. **My sha256** of the four original files before and after all my checks: identical. **Real records:** `grep -l '"source": *"quick"' .agent-lab/*.json` → 0. `.agent-lab/.lock` is absent. **Stored runs:** `verify-stored-runs` exit 0 with `0:9:4`, `1:8:7`, `audit 13/13`, `14/14`. **Swap record:** `preflight.txt` and `rollback-dist-03.txt` in `~/agent-lab-evidence/phase-03/`. |
| 12 | 03-07 backstop: light and dark theme look; real owner marks after the freeze; how the remapped `n` feels | ? HUMAN | Declared manual-only by 03-07 and 03-VALIDATION. See Human Verification. |

**Score:** 11/12 verified. 0 are present but behavior-unverified: every behavior-dependent truth (count on the recorded judgment, headline flip, unsure has no effect, stale rules, sample determinism, key scope, editor cancel) has a named passing test and, where the plan asked for it, a live run on a copy.

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|--------------|----------|
| 1 | Second footer line cut with «…» at inner 36–54 | Phase 4 | SC5 «перенос по словам без обрезки … от 40 до 160 колонок»; `deferred-items.md` |
| 2 | Agreement in the forwardable summary / HTML report for the manager | Phase 5 | SHARE-01 names «согласие»; the CLI summary and the Pi chat already show it |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/agreement.ts` | `judgeAgreement`, `agreementSample`, `PASS_SAMPLE` | ✓ VERIFIED | 144 lines, pure. Imported by result-view, cards and agent-lab. Built to `dist/agreement.js`. |
| `src/outcomes.ts` | `primaryMetricId`; quick-unsure skip | ✓ VERIFIED | Used by agreement, experiment, comparison and cards. |
| `src/contracts.ts` | optional `source` / `judgeVerdict` / `judge` | ✓ VERIFIED | `source: z.literal('quick').optional()` at :651 |
| `src/experiment.ts` | lab-filled snapshot and refusals | ✓ VERIFIED | :964-976 |
| `src/result-view.ts` | F6 rows, F7/F8 lines, roles | ✓ VERIFIED | `view.agreement = judgeAgreement(input)` at :197 |
| `src/cli.ts` | disagreement section in `summary` | ✓ VERIFIED | :109-113 |
| `src/explain.ts` | `situationEvidence` | ✓ VERIFIED | used by `agreementBlockLines` |
| `extensions/cards.ts` | keys, block, header/footer, queue order, labels | ✓ VERIFIED | see truths 8–10 |
| `extensions/agent-lab.ts` | agree loop, payload `disagreementLines` | ✓ VERIFIED | :127, :921-962 |
| `test/agreement.test.ts`, `test/helpers/copy-check.ts` | counting rules; plain-language scan | ✓ VERIFIED | both used by the suite |
| `agreement-check.mts` | scripted e2e on a copy | ✓ VERIFIED | contains `originalsUnchanged=`; I re-ran it and it exited 0 |

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| `buildResultView` | `judgeAgreement` | `agreement: judgeAgreement(input)` | ✓ WIRED |
| `src/agreement.ts` | `src/outcomes.ts` | `primaryMetricId(`, `latestHumanReviews`, `observedRecord`, `runningPhases` | ✓ WIRED |
| `addHumanReview` | `trial.judgeReceipt ?? trial.judgeAudit` | stored `judge` | ✓ WIRED |
| `src/comparison.ts` | `src/outcomes.ts` | `primaryMetricId` import; `source === 'quick'` | ✓ WIRED |
| `src/cli.ts summary` / `extensions/agent-lab.ts summary()` | `agreementSectionLines` | printed lines / `disagreementLines` payload | ✓ WIRED |
| `cards.ts handleInput` | `/agent-lab` loop | `action.type === 'agree'` → `addHumanReview({source:'quick'})` | ✓ WIRED |
| `reviewOrder` / `reviewHeader` / `agreementBlockLines` | `dist/agreement.js`, `dist/explain.js situationEvidence` | imports at `cards.ts:7-11` | ✓ WIRED |
| `agreement-check.mts` | `/agent-lab` command, `pi-surface-check.mts` | fake `registerCommand`; spawned surface check | ✓ WIRED |

### Data-Flow Trace (Level 4)

| Artifact | Data | Source | Real data | Status |
|----------|------|--------|-----------|--------|
| F6 agreement row | `view.agreement` | `judgeAgreement(record)` ← `record.humanReviews` + `trial.assessments` | yes: the copies show 1/2 and 2/3 after scripted marks, and «ещё не проверено» before | ✓ FLOWING |
| F7 disagreement list | `agreement.disagreements` | same | yes: `Несогласия с судьёй (1):` on both copies | ✓ FLOWING |
| Section-3 block | `situationEvidence`, `marks` | record assessments, reviews | yes: `reopenShowsMark=true`, `evidenceBeforeVerdict=true` | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full suite + typecheck on HEAD | `snap-test.sh --full --keep` | `# tests 512 / # pass 512 / # fail 0`, exit 0 | ✓ PASS |
| Scripted y/n/s on copies of both acquiring runs | `node --import tsx agreement-check.mts --source .agent-lab --id fae4ee59… --id a92fd6ae…` | two `check` lines matching the plan, exit 0 | ✓ PASS |
| CLI, Pi payload and board agree on the real runs | `pi-surface-check.mts --cwd . --id …` (each run) | `OK surfaces=3 lines=10 … next=1 id=fae4ee59`, `OK surfaces=3 lines=13 … next=1 id=a92fd6ae` | ✓ PASS |
| Stored runs keep phase-2 counts | `verify-stored-runs.mjs --expect …:0:9:4 --expect …:1:8:7 --audit …:13/13 --audit …:14/14` | exit 0, no `MISMATCH` | ✓ PASS |
| Originals untouched | sha256 of 4 files before and after the checks above | identical | ✓ PASS |
| No real mark | `grep -lE '"source": *"quick"' .agent-lab/*.json \| wc -l` | 0 | ✓ PASS |

The first attempt at `agreement-check` failed before doing anything: `npx tsx` hit an IPC-pipe name clash (`EADDRINUSE`) with the suite running at the same time. I re-ran it as `node --import tsx` in its own temp folder, and the result above is from that run. The originals were hashed around both attempts and did not change.

### Probe Execution

| Probe | Command | Result | Status |
|-------|---------|--------|--------|
| `.planning/phases/03-soglasie-cheloveka-s-sudey/agreement-check.mts` | see above | exit 0 | PASS |
| `.planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts` | see above | OK ×2 | PASS |
| `.planning/phases/01-odno-chestnoe-chislo/verify-stored-runs.mjs` | see above | exit 0 | PASS |

No `scripts/*/tests/probe-*.sh` exist in this project.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|--------------|-------------|--------|----------|
| JUDGE-04 | 03-01, 02, 04, 05, 06, 07 | One key: согласен / не согласен / не могу сказать; reason on disagreement; stores the judge verdict and version | ✓ SATISFIED | Truths 1, 4, 6, 8, 11 |
| JUDGE-05 | 03-01, 02, 03, 06, 07 | «N из M проверенных» with the disagreement list, counted on the original judgment, small M said in words | ✓ SATISFIED | Truths 2, 5, 6, 7, 10 |
| JUDGE-06 | 03-01, 04, 05, 06, 07 | 2–3 sampled passes; agreement split by failures and passes | ✓ SATISFIED | Truth 3; sampled passes are queued and labelled; the header counts failures and passes separately |

REQUIREMENTS.md maps only JUDGE-04/05/06 to phase 3, and every plan claims only those, so no requirement is left unclaimed.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (all 23 phase files) | — | TBD / FIXME / XXX / TODO / HACK / PLACEHOLDER | none found | — |
| `src/agreement.ts` | 13-16 | Documented limitation: one trial is one situation. With `repeats > 1` a card would add several marks. | ℹ️ Info | Stored runs use `repeats = 1`; the limitation is stated in the code. |
| `src/outcomes.ts` | 43-48 | `primaryMetricId` always picks `goal_attainment` when the card has it | ℹ️ Info | Correct for phase 3. Phase 03.1 SC4 will move the mark to the metric that actually failed. |
| `dist/` | — | Rollback hazard: once a real mark is saved, the old `dist/` cannot read the record (strict schema) | ℹ️ Info | Recorded in 03-07-SUMMARY. The only fix after that point is a forward fix. |

### Human Verification Required

#### 1. Real owner marks on the frozen demo record

**Test:** After the protocol freeze, open `/agent-lab`, choose the demo record, press `3`, then mark failures and the sampled pass with `y` / `n` (with a reason) / `s`.
**Expected:** The first block shows `Согласие с судьёй: N из M проверенных …` with the failures and passes parts. `Несогласия с судьёй (K):` lists each reason in full. Everything stays after reopening.
**Why human:** Only the owner can agree or disagree. So far the path has run only with synthetic answers on copies.

#### 2. Light and dark Pi theme look of section 3 and the section-1 agreement rows

**Test:** Open section 3 on the demo record in one light and one dark theme; send a screenshot or a note.
**Expected:** Every agreement row and heading is readable in its color role in both themes.
**Why human:** Theme colors need eyes on a real terminal (03-07 backstop).

#### 3. The remapped `n`

**Test:** Read `?` and the key row, press `n`, cancel the editor.
**Expected:** «n — не согласен» reads naturally. Cancelling saves nothing and shows no notice.
**Why human:** Only the owner can say how the key feels.

### Gaps Summary

There are no gaps. The code delivers the goal:
- **Marking:** one key (`y`/`n`/`s`) in board section 3 saves a quick mark. The lab, not the caller, attaches the judge's recorded verdict and version, and the mark stays after a reload.
- **Counting:** agreement is counted only against the judge's recorded result, so a disagreement never agrees with itself (0 of 1).
- **Display:** the CLI summary, the Pi chat and the board all show «Согласие с судьёй: N из M проверенных» with failures and passes shown separately. Below 10 checks there is no percent, and below 20 the row says «мало проверок». The owner's disagreements are listed with their full reasons.
- **Sampling:** up to three passes are drawn reproducibly and queued after the failures.

My own runs confirm this end to end on copies of the two real acquiring runs:
- the suite passed 512/512;
- the scripted board run gave exactly the planned counts;
- the surface and stored-run checks were clean;
- the originals are byte-identical and 0 real records hold a mark.

Two items are deferred: the forwardable manager summary and HTML report (Phase 5), and the known narrow-board cut of the second footer line (Phase 4). The three human items come from the plan's own manual-only list.

---

_Verified: 2026-09-17T15:20:00Z_
_Verifier: Claude (gsd-verifier)_
