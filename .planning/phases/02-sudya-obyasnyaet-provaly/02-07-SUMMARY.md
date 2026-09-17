---
phase: 02-sudya-obyasnyaet-provaly
plan: 07
subsystem: expectation-sheet
tags: [expectation-sheet, acceptance, owner-expectation, cli, trust]
status: complete

requires:
  - phase: 02-sudya-obyasnyaet-provaly
    provides: "02-04: explain.ts ruleRegister/ruleText/UNVERIFIED (the shared owner rule numbering); 02-05/02-06: the same row shape proved on the real acquiring runs"
  - phase: 01-odno-chestnoe-chislo
    provides: "01-09: positiveControlScenarioIds — the record-level marker pattern; snap-test.sh"
provides:
  - "expectationSheet(record): the whole draft as one sheet — Ситуация / Должен / Правило N, board parts, compact form"
  - "acceptDraft confirms every situation of an evaluate draft at once and keeps unchanged entries"
  - "ExperimentLab.setExpectation(id, hash, scenarioId, text): the owner's words become the scored criterion verbatim"
  - "start(id, { requireAccepted }): the Pi path refuses a draft whose expectations are stale or unconfirmed"
  - "Experiment.ownerExpectationScenarioIds: the record-level «changed by the owner» marker"
  - "agent-lab accept prints the sheet for a set and confirms it with --yes"
affects: [02-08 (the Pi surfaces for the sheet and the edit), 02-09, phase 3 (consent), phase 4 (board section 2)]

plan_head_before: b334a00f3dd22d9f4c21ae3c5dc1d6d24f44e796
frozen_protocol: v10-unchanged
paid_calls: 0

actuals:
  tokens: 14498   # chars/4 over the realized src + test diff (57 992 chars)
  tasks: 2
  commits: 2      # MEASURED git rev-list --count b334a00..HEAD before this docs commit

tech-stack:
  added: []
  patterns:
    - "A record-level marker (ownerExpectationScenarioIds) rather than a card field: old records keep their exact draftHash because an undefined key drops out of the fingerprint"
    - "One private finishDraftEdit tail shared by updateDraft and setExpectation, with a callback for the steps only updateDraft needs (agent, settings, target preflight)"
    - "The sheet reuses explain.ts ruleRegister/ruleText, so the owner reads the same `Правило N` before the run and in the failure explanation after it"

key-files:
  created: []
  modified:
    - src/quality.ts
    - src/experiment.ts
    - src/contracts.ts
    - src/cli.ts
    - test/experiment.test.ts
    - test/quality.test.ts
    - test/workflow.test.ts

key-decisions:
  - "Acceptance was promoted, not duplicated: acceptDraft now covers every situation of the draft and the one-test proposal stays as its one-situation variant. The CLI branches on scenarios.length > 1, so today's single-test flow and its JSON envelope are byte-identical."
  - "setExpectation strips `split` before validatePreparation, exactly as updateDraft does; the preparation reassigns it. Without this the strict preparation schema rejects the card."
  - "The updateDraft refusal «ожидание изменилось, а исполняемые проверки остались прежними» is skipped only when the previous card has an agent rubric with id goal_attainment — the judge scores those words themselves, so changing them is a real change of the test. Demo cards (demo_task_state) keep the refusal."
  - "The shared draft-edit tail takes the checkpoint message as a callback, because updateDraft counts added/changed cards only after validatePreparation has normalised them."
  - "The v11 judge work is out of scope here and was already rolled back (02-03 NO-GO): this plan names no judgedCut / judgedBeforeSeq / cutBefore / goal-v2 step, so nothing had to be skipped."

requirements-completed: [TRUST-10, TRUST-11]

duration: 34min
completed: 2026-09-17
---

# Phase 2 Plan 07: The expectations sheet and `setExpectation` Summary

**Before a run the owner now sees one sheet — every situation as «Ситуация / Должен / Правило N: «цитата»», with the same owner rule numbers the failure explanations use afterwards — confirms all of them with one command, or replaces one expectation with their own words, which reach the judge verbatim, mark the situation as incomparable with earlier runs and make the next Pi start ask for a fresh confirmation. 436 tests pass, typecheck clean, no model call was made.**

## Performance

- **Duration:** about 34 min (2026-09-17)
- **Tasks:** 2/2
- **Files:** 7 modified (4 source, 3 test)
- **Paid steps:** 0 — this plan makes no model calls

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (tracer) | `agent-lab accept` shows what the agent must do in every situation and confirms them all in one step | `e1ecc96` | src/quality.ts, src/experiment.ts, src/cli.ts, test/experiment.test.ts, test/workflow.test.ts |
| 2 | The owner rewrites one expectation in own words; it becomes the criterion, is marked, and the Pi path requires a fresh confirmation | `c2b8412` | src/contracts.ts, src/experiment.ts, src/quality.ts, test/experiment.test.ts, test/quality.test.ts |

**Tracer feedback gate.** Task 1 carries no `gate` attribute, auto mode is off (`auto_advance: false`, `_auto_chain_active: false`) and `human_verify_mode` is `end-of-phase` with an automated-only `<verify>`. The verify was therefore re-run end to end — `snap-test.sh test/experiment.test.ts test/workflow.test.ts test/quality.test.ts test/product-flow.test.ts` → **105 pass, 0 fail**, exit 0 — and the plan expanded without a checkpoint.

## What exists now

| Symbol / path | Kind | Where |
|---|---|---|
| `expectationSheet(record)` | exported function | src/quality.ts |
| `ExpectationSheet` / `ExpectationCard` / `ExpectationRole` | exported types | src/quality.ts |
| `ExperimentLab.acceptDraft` (all situations) | changed behaviour | src/experiment.ts |
| `ExperimentLab.setExpectation(id, hash, scenarioId, text)` | new method | src/experiment.ts |
| `ExperimentLab.finishDraftEdit` | private shared tail | src/experiment.ts |
| `judgeGoalRubric(scenario)` | private helper | src/experiment.ts |
| `start(id, { requireAccepted })` | new option | src/experiment.ts |
| `Experiment.ownerExpectationScenarioIds` | optional schema field | src/contracts.ts |
| `agent-lab accept` sheet output (C-47, C-48) | CLI output | src/cli.ts |

## The sheet (F5, C-22…C-30)

- Head: `Что агент должен сделать: <n> ситуаций. Номер правила — порядок в ваших материалах.`; board head: `ЧТО АГЕНТ ДОЛЖЕН СДЕЛАТЬ` + `<n> ситуаций · номер правила — порядок в ваших материалах`.
- Per situation: the label `N.` right-aligned to `labelWidth`, `Ситуация: <user.goal>`, then detail rows indented by `labelWidth + 1`: `Должен: <successCriteria>`, every shown rule as `Правило N · <источник>[, строка L]: «<цитата>»` (knowledge rules first, then prompt rules, ascending N), and the marker row for a situation the owner changed.
- Named gaps, never guesses: `Должен: ожидание не записано.`, `Правило: объяснение не подтверждено цитатой` (one row per unknown or ungrounded rule), `Правило: у ситуации нет правила из ваших материалов.` Internal machine-format prompt rules are left out entirely.
- Footer: `Версия ожиданий: <первые 12 знаков draftHash>`.
- Sizes: 0 situations → `Ситуаций пока нет.` + `Они появятся после подготовки. a — рассказать Pi, что проверить.`; 1–9 → `labelWidth` 2 (details at column 3); 10–20 → `labelWidth` 3 (details at column 4); a situation with 11 rules lists all 11.
- `compactLines(runId)` keeps at most two rule rows per situation, adds `и ещё <K> правило|правила|правил`, then `Все правила — /agent-lab <id8>, раздел 2.` and the version line.

## The owner's words

`setExpectation(id, expectedHash, scenarioId, text)` trims surrounding whitespace and nothing else. The text becomes both `scenario.successCriteria` and the `goal_attainment` pass criterion, so `judgeInput` carries it verbatim in two places; `failCriteria`, `description`, the checks and the other rubrics are untouched. The id joins `ownerExpectationScenarioIds`, the shared tail drops the accepted entry of that situation, recomputes `evaluatorVersion` and clears `reviewedAt` / `reviewMode` / `manifestHash`, while `acceptedDraftHash` keeps the old value — that is what makes the stale confirmation visible.

Refusals, none of which write anything (the stored record is deep-equal before and after):

| Case | Message |
|---|---|
| Another draft version | `Черновик изменился, пока вы смотрели. Проверьте ожидания ещё раз.` |
| Empty or whitespace text | `Ожидание пустое. Напишите, что агент должен сделать.` |
| Over 3000 characters | `Ожидание длиннее 3000 знаков. Сократите и попробуйте снова.` |
| Unknown situation | `Нет такой ситуации в черновике: <id>.` |
| No judge goal rubric | `Эту ситуацию проверяют точные проверки, а не судья. Поправьте её словами: a.` |
| Unchanged text | returns the stored record, `updatedAt` unchanged |

`compareRuns` of an earlier run of the same set against a run of the edited draft reports `Содержимое карточек изменилось: …`, matching what the sheet says in words.

## Threat register outcome

| Threat ID | Disposition | How it is held |
|---|---|---|
| T-02-22 (spoofed confirmation) | mitigated | `start({ requireAccepted })` compares `acceptedDraftHash` with a recomputed `draftHash`; test covers stale → refusal → confirm → start |
| T-02-23 (tampered expectation text) | mitigated | Trim only, 1–3000 characters, situation id checked against the record, marker ids schema-checked for membership (`Изменённое ожидание должно относиться к ситуации этого набора.`) and uniqueness |
| T-02-24 (comparability after an edit) | mitigated | The card fingerprint changes → `compareRuns` note; the sheet prints the marker row |
| T-02-25 (existing records' hashes) | mitigated | The new key is undefined-safe in `draftHash` (a stored-style record without it hashes identically) and absent from `measurementHash` |
| T-02-SC (package installs) | accepted | No packages were installed |

## Verification

| Check | Result |
|---|---|
| Task 1 verify — `snap-test.sh test/experiment.test.ts test/workflow.test.ts test/quality.test.ts test/product-flow.test.ts` | exit 0 — **105 pass, 0 fail** |
| Task 2 verify — `snap-test.sh` (full working tree, all tests + extension typecheck) | exit 0 — **436 pass, 0 fail**, typecheck clean |
| `grep -c "export function expectationSheet" src/quality.ts` | 1 |
| `grep -c "ruleRegister(" src/quality.ts` | 1 |
| `grep -c "Принять можно ровно один тест." src/experiment.ts` | 0 |
| `grep -c "Подтвердить все ожидания: agent-lab accept --id" src/cli.ts` | 1 |
| `grep -c "acceptDraft(id, sheet.draftHash)" src/cli.ts` | 1 |
| `grep -c "ownerExpectationScenarioIds" src/contracts.ts` | 4 (≥ 3) |
| `awk '/export function draftHash/,/^}/' … \| grep -c ownerExpectationScenarioIds` | 1 |
| `awk '/export function measurementHash/,/^}/' … \| grep -c ownerExpectationScenarioIds` | 0 |
| `grep -c "async setExpectation(" src/experiment.ts` | 1 |
| `grep -c "requireAccepted" src/experiment.ts` | 2 (≥ 1) |
| `grep -c "Ожидание изменено владельцем — с прошлыми прогонами не сравнивается." src/quality.ts` | 1 |
| `grep -c "^export const VERSION = '6';" src/contracts.ts` | 1 |

The CLI sheet is proved end to end by a spawn test in `test/workflow.test.ts`: a two-situation draft prints the head line, two `Ситуация:` rows, two `Должен:` rows, the `Правило 1 · policy: «…»` row, the version line and `Подтвердить все ожидания: …`, and records nothing; `--yes --json` returns `type: 'accepted'` and the stored record holds two `acceptedTests`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] `setExpectation` must strip `split` before `validatePreparation`**
- **Found during:** Task 2
- **Issue:** The plan's shared tail passes the situations straight to `validatePreparation`, whose strict preparation schema rejects the `split` key that stored cards carry. Every `setExpectation` call threw.
- **Fix:** `record.scenarios.map(({ split: _split, ...item }) => …)`, exactly what `updateDraft` already does; the preparation reassigns `split`.
- **Files modified:** src/experiment.ts
- **Commit:** `c2b8412`

**2. [Rule 3 — Blocking] The shared tail needs the checkpoint message as a callback**
- **Found during:** Task 2
- **Issue:** `updateDraft` counts added and changed cards from `record.scenarios` *after* `validatePreparation` normalises them, so the message cannot be computed before calling the helper.
- **Fix:** `finishDraftEdit(record, scenarios, agent, message, between?)` takes `message: (record) => string` and an optional `between` callback for the steps only `updateDraft` performs (agent revision, settings, target, preflight, `selectedRevisionId`). `setExpectation` passes neither a target step nor a preflight — the target did not change.
- **Files modified:** src/experiment.ts
- **Commit:** `c2b8412`

### Plan steps adjusted

- **Task 1's `ownerEdited` was wired in Task 2, not Task 1.** Task 1's `<files>` list does not include `src/contracts.ts`, where `ownerExpectationScenarioIds` is added, so the tracer shipped with an empty edited set and Task 2 replaced that one line. The marker rows, roles and compact handling were built in Task 1 as planned.
- **The plan's `<interfaces>` note about `test/experiment.test.ts` near line 264 was not used.** A dedicated two-situation judge-goal runtime (`judgeGoalRuntime`) was written instead; `confirmedHypothesis` had to be dropped from its create input because `createInputSchema` refuses «a confirmed hypothesis builds exactly one generated evaluate test».
- **Run-context instruction honoured:** nothing outside `src/`, `test/` and this phase directory was staged; `.planning/phases/03-*` … `06-*` were never touched.

### Judge v11

The run context asked to skip any step mentioning `judgedCut`, `judgedBeforeSeq`, `cutBefore` or goal-v2. This plan names none of them — its `<interfaces>` and tasks read only `successCriteria`, the `goal_attainment` rubric and the v10 explanation rows — so no step was skipped. The protocol stays frozen at v10.

## Known Stubs

None. No hardcoded empty value, placeholder string, `TODO` or `FIXME` was introduced: `git diff b334a00..HEAD -- src` has no match for `TODO|FIXME|placeholder|coming soon|не реализован`.

## Open for the next plans

- The Pi surfaces for the sheet (board section 2, the `y` / `e` keys, the header-line states of UI-SPEC F5) and the Pi-only expectation edit are 02-08; the CLI deliberately has no edit path (UI-SPEC S1).
- `requireAccepted` exists but no caller passes it yet — 02-08 wires it into the Pi run path. CLI `run` and `evaluate` are unchanged by design (CTX-22).
- The owner rule numbers on the sheet can differ from an earlier build of the same materials (RESEARCH Pattern 2 stability note); the sheet shows them before the run, so the owner sees the numbering they will get.

## Self-Check: PASSED

All modified files exist on disk and both task commits (`e1ecc96`, `c2b8412`) are present in git history.
