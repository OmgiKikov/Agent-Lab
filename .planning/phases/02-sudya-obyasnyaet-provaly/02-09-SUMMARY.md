---
phase: 02-sudya-obyasnyaet-provaly
plan: 09
subsystem: live-verification
tags: [live-verification, free, expectation-sheet, dist-swap, evidence]
status: complete

requires:
  - phase: 02-sudya-obyasnyaet-provaly
    provides: "02-07: expectationSheet, acceptDraft over the whole draft, setExpectation, ownerExpectationScenarioIds"
  - phase: 02-sudya-obyasnyaet-provaly
    provides: "02-08: board section 2 sheet rows, keys y / e, BoardAction accept / expect"
  - phase: 02-sudya-obyasnyaet-provaly
    provides: "02-06: board-width-check.mts and the dist swap procedure proved on this phase"
  - phase: 01-odno-chestnoe-chislo
    provides: "01-10: snap-test.sh, verify-stored-runs.mjs, pi-surface-check.mts, the NEW live repeat 61521e0d"
provides:
  - "expectation-check.mts: sheet, board-width and key checks on a real draft, with an optional --apply writer mode"
  - "dist/ built from HEAD 376562e and live in the worktree (the whole TRUST-10/11 code reaches the next Pi start)"
  - "Phase-2 TRUST evidence table on a real acquiring draft (37f78e1a, 13 situations)"
affects: [phase 3 (consent keys), phase 4 (the live light/dark screenshot is the open backstop), phase 7 (the demo runs from this dist)]

plan_head_before: 376562e5d2d08fc5660ed866b76af74e31799420
commits: 1
dist_built_from: 376562e5d2d08fc5660ed866b76af74e31799420
dist_kept_at: .gsd/dist-before-02-09-20260917-133450
frozen_protocol: v10-unchanged
paid_calls: 0

actuals:
  tokens: 1745    # chars/4 over the realized diff (6 979 chars, one new script)
  tasks: 2
  commits: 1      # MEASURED git rev-list --count 376562e..HEAD before this docs commit

tech-stack:
  added: []
  patterns:
    - "A check script with one writer step: the reader path never opens ExperimentLab, and --apply opens it, writes through setExpectation and closes it before re-reading through the lock-free store"
    - "The owner text is never printed — only marker / verbatim / different / true — so a check of the owner's own words leaks nothing into the log"

key-files:
  created:
    - .planning/phases/02-sudya-obyasnyaet-provaly/expectation-check.mts
  modified: []

key-decisions:
  - "The judge-input check builds judgeInput over a minimal scripted trial of that one situation (no events, no observation). judgeInput touches only scenario, sources and those trial fields, so this is the real judge payload for the situation without running the agent or calling a model."
  - "goalRows counts the Должен rows that carry a recorded expectation (role expected) and unverifiedRows counts the named gaps, so a draft that lost an expectation shows up as goalRows < situations rather than hiding inside one Должен count."
  - "SOURCE is the phase-1 live repeat 61521e0d (it carries the control ae812a24), as the plan's first choice; the repeat produced a 13-situation draft, so the sheet was proved at the size the demo will show."
  - "The v11 steps named nowhere in this plan needed no skipping, but the run context is recorded for the reader: judgedCut, judgedBeforeSeq, cutBefore and goal-v2 do not exist — 02-03 was NO-GO and the judge protocol stays v10."

requirements-completed: [TRUST-10, TRUST-11]

duration: 12min
completed: 2026-09-17
---

# Phase 2 Plan 09: The expectations sheet on a real draft, and the final dist Summary

**On a fresh draft of the real acquiring set — 13 situations, 55 owner rule rows, zero unverified rows — the owner's own sentence became the stored expectation verbatim, reached the judge's goal rubric and the judge input, marked the situation as incomparable with earlier runs, and one `accept --yes` confirmed all 13; the board renders that sheet at 40 to 160 columns with nothing wider than the screen and `y` / `e` map to accept and expect. The final `dist/` is built from HEAD `376562e` after 443/443 tests, and every earlier result is unchanged. No agent run and no model call were made.**

## Performance

- **Duration:** about 12 min (2026-09-17, 13:26–13:38 local)
- **Tasks:** 2/2
- **Files:** 1 created (a check script); `dist/` and `~/agent-lab-evidence/phase-02/` are not tracked
- **Paid steps:** 0 — this plan makes no model calls and starts no agent run

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (tracer) | A real acquiring draft shows the sheet, takes the owner's words verbatim and is confirmed in one action | `c44f927` | .planning/phases/02-sudya-obyasnyaet-provaly/expectation-check.mts |
| 2 | The final dist keeps every earlier result, and the TRUST evidence is recorded | (no tracked file changes) | dist/, ~/agent-lab-evidence/phase-02/ |

**Tracer feedback gate.** Task 1 carries no `gate` attribute, auto mode is off (`auto_advance: false`, `_auto_chain_active: false`) and `human_verify_mode` is `end-of-phase` with an automated-only `<verify>`. The verify was therefore re-run end to end — exit 0 on all five clauses — and the plan expanded without a checkpoint.

## The TRUST evidence (real acquiring draft)

| What | Value |
|---|---|
| Draft | `37f78e1a` — a `repeat` of the phase-1 live run, phase `review`, never started |
| Source | `61521e0d` (the 01-10 live repeat of `fae4ee59`, control `ae812a24` inherited) |
| Situations on the sheet | 13 (`Ситуация:` rows 13, head line 1, version line 1, C-47 hint 1) |
| Owner rule rows | 55 |
| Unverified rows | 0 (`объяснение не подтверждено цитатой` never appears) |
| `Должен` rows with a recorded expectation | 13 of 13 |
| Owner correction | `marker=true criteria=verbatim passCriteria=verbatim judgeInput=true` |
| Sheet version | `versionOk=true` — the printed `Версия ожиданий:` equals `draftHash(record)` |
| Confirmation | `Ожидания подтверждены: 13 ситуаций.` → `confirmed=true`, `markers=1` |
| Board widths | 40, 60, 80, 110, 160 → `over=0 head=true selected=true` at every one |
| Keys | `y=accept e=expect scenario=true` |
| Diff against the source | note `Содержимое карточек изменилось: …` present; `comparable=false`, 12 situations incomparable |

Reading the table in order: the owner opened the sheet of a real set and saw every situation with the same `Правило N` numbers the failure explanations use; nothing on it was a guess (0 unverified rows). They replaced one expectation with the sentence in `owner-text.txt`; it became `successCriteria` **and** the `goal_attainment` pass criterion character for character, it is inside the JSON the judge would receive for that situation, and the situation is now marked as changed by the owner. One command confirmed all 13 at the current version. The diff against the run the draft came from says in words what the marker says on the sheet: that situation's content changed, so it is not compared with the earlier run.

## The final `dist/`

`snap-test.sh --full --keep` on the committed HEAD `376562e`: **443 pass, 0 fail**, typecheck clean, exit 0. Before and after the suite, `pgrep -fl 'dist/bundle/cli.js|pi-coding-agent|extensions/agent-lab.ts'` printed nothing and `.agent-lab/.lock` did not exist; no Pi process was touched. The swap was a rename: the previous build is kept at `.gsd/dist-before-02-09-20260917-133450` (recorded in `$EVID/rollback-dist-02-09.txt`), the snapshot's `dist` became `dist`, and the snapshot was removed. `dist/experiment.js` exports `setExpectation` and `acceptDraft`.

**The next Pi start uses this dist** (commit `376562e`), which is the first one carrying the whole expectations sheet: `expectationSheet`, `setExpectation`, `acceptDraft` over the whole draft, `start({ requireAccepted })` and the board keys.

## Free checks with the final dist

| Check | Result |
|---|---|
| `verify-stored-runs.mjs` on the two acquiring runs | exit 0 — `fae4ee59 passed=0 decided=9 notMeasured=4 audit=13/13`, `a92fd6ae passed=1 decided=8 notMeasured=7 audit=14/14` |
| `pi-surface-check.mts` | `OK surfaces=3 lines=9 sections=23 id=fae4ee59`, `OK surfaces=3 lines=12 sections=19 id=a92fd6ae` |
| `board-width-check.mts` | 30 lines, no `FINDING`, no `over=` above 0, no invented `…`, `words=equal` everywhere |
| Task 1 verify (five clauses over the evidence files) | exit 0 |

`RE11` does not exist, so `pi-surface-check` ran on the two stored runs only (see «Run context» below).

## Run context: v11 is rolled back

`judgedCut`, `judgedBeforeSeq`, `cutBefore` and goal-v2 do not exist in this code: 02-03 was NO-GO and the judge protocol stays **v10, unchanged**. This plan names none of them, so nothing in its steps had to be skipped; the only consequence is that the optional `--id <RE11>` of the final surface check had no argument to take.

## Backstop: the live Pi step

Человек не открывал `/agent-lab` в этом автономном прогоне; отрисовка листа и клавиши `y`/`e` проверены скриптом на настоящем черновике; снимок в светлой и тёмной темах и живое нажатие `r` — в фазе 4.

The script drives the real `LabBoard` from `extensions/cards.ts` against the real record on disk, so what it proves is the component's own behaviour at five widths and the real `BoardAction` a key press produces. What it cannot prove is the two things only eyes can judge: the colours of a light and a dark theme, and the feel of the `r` dialog. UI-SPEC live step 10 stays open and is carried into phase 4.

## The draft stays local

`37f78e1a` lives only in `.agent-lab/`: confirmed, **not run**, and never exported. `git status --short` shows nothing under `.agent-lab` or the evidence directory. The evidence directory is `0700` with `0600` files (`chmod -R go-rwx`). The `.planning` tree received ids, counts, hashes and booleans only — no card title, dialogue turn, rule quote or judge rationale, and not the owner sentence itself.

## Threat register outcome

| Threat ID | Disposition | How it is held |
|---|---|---|
| T-02-33 (tampering with the aigw-local checkout during `repeat`) | mitigated | The idle check ran first and is recorded in `$EVID/aigw-idle.txt`: `lock=absent`, `runProcesses=(none)`, `activeRecords=0` of 22 records. The only git touching that checkout was Agent Lab's own read-only fingerprint inside `repeat`; the executor ran no git command there |
| T-02-30 (writer mode of the check script) | mitigated | The single write went through `ExperimentLab.setExpectation` (hash check, 3000-character limit, writer lock) on the draft created in this plan, with text read from a fixed file |
| T-02-31 (disclosure through the output) | mitigated | Every printed field is an id prefix, a count, a hash, a width or a boolean; raw CLI output stays in `$EVID` at 0700/0600 |
| T-02-32 (denial of service through the dist swap) | mitigated | Full snapshot suite first, `pgrep` + lock re-checked immediately before the rename, previous build kept |
| T-02-SC (package installs) | accepted | No packages were installed |

## Deviations from Plan

### Auto-fixed Issues

None — no bug, missing critical function or blocker was found.

### Plan steps adjusted

- **`diff --before <SOURCE> --after DRAFT` exits 2, and that is the correct behaviour.** The plan's step records «whether a note starts with `Содержимое карточек изменилось`» and its verify command does not check the exit status. The draft was deliberately never started, so the comparison is incomplete by construction: the JSON carries `headline: Прогоны несравнимы: 12 пар…`, `comparable: false`, and the three notes `Содержимое карточек изменилось: …`, `После: Прогон не завершён.` and `Контрольные ситуации не сравниваются: …`. The acceptance criterion (the first note) is met; running the draft to make the diff comparable would have violated this plan's prohibition against starting a run.
- **The diff JSON is one pretty-printed object, not JSONL.** The note extraction parses the whole file; nothing about the CLI changed.
- **The final surface check ran on two ids, not three.** `[--id <RE11>]` is optional in the plan and `RE11` does not exist (v11 rolled back).
- **The commit landed on the session branch `full-project-review-feature-plan`**, as every plan of phases 1 and 2 did. This working tree is a linked worktree (`.git` is a file), so the generic executor guard would ask for an `agent-*` branch; the dispatch designates this tree and branch as the sequential working tree, and the branch is not a protected or default branch. HEAD was asserted attached and non-protected before the commit.
- **Run-context instruction honoured:** only this phase directory was staged, by explicit path; `.planning/phases/03-*` … `06-*` were never touched.

## Self-Check: PASSED

- `.planning/phases/02-sudya-obyasnyaet-provaly/expectation-check.mts` — FOUND, tracked (`git ls-files --error-unmatch` exits 0)
- `.planning/phases/02-sudya-obyasnyaet-provaly/02-09-SUMMARY.md` — FOUND
- Commit `c44f927` — FOUND in `git log`
- `commits: 1` — MEASURED with `git rev-list --count 376562e..HEAD` before this docs commit
