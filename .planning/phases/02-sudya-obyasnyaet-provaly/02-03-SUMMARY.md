---
phase: 02-sudya-obyasnyaet-provaly
plan: 03
subsystem: judge
tags: [live-verification, pilot, reassess, protocol-freeze, budget, no-go]
status: complete

requires:
  - phase: 02-sudya-obyasnyaet-provaly
    provides: "judge protocol v11 (02-01), goal-v2 counting and «before» numbers (02-02)"
provides:
  - "Live pilot of v11 on 3 simulator-deviated fae4ee59 situations: decided 0/3 → NO-GO"
  - "Judge protocol stays v10; 02-01/02-02 code restored to fa79f2e (commit c8b9e27)"
  - "freeze.txt: protocol=v10-unchanged, reason=no-reduction"
affects: [02-04 (skips the cut row), phase 4 (C-50 wording reverted; pilot record shows a list warning)]

plan_head_before: c753aef88ad1817e54c3198c421cef149c556729
pilot_record: 17d77d54   # пилот, не результат
gate: "NO-GO decided=0/3 cost=$0.4304 reason=no-reduction"
frozen_protocol: v10-unchanged

actuals:
  tokens: 18700    # chars/4 over the revert diff (74 875 chars)
  tasks: 2
  commits: 2       # MEASURED rev-list c753aef..HEAD; c8b9e27 is this plan's, a87fb25 is a concurrent docs(04) planning commit

tech-stack:
  added: []
  patterns:
    - "Paid step behind live-check budget GO; the cap watcher attached to the reassess pid"

key-files:
  created: []
  modified:
    - src/judge.ts
    - src/contracts.ts
    - src/evaluation.ts
    - src/experiment.ts
    - src/outcomes.ts
    - src/comparison.ts
    - src/result-view.ts
    - test/judge.test.ts
    - test/evaluation.test.ts
    - test/store.test.ts
    - test/experiment.test.ts
    - test/comparison.test.ts
    - test/result-view.test.ts
    - test/outcomes.test.ts

key-decisions:
  - "Pilot NO-GO: the v11 judge gave goal_attainment=unknown on all three faithful prefixes (the cuts fall before the goal can show). The judge protocol stays v10; pilot record 17d77d54 is «пилот, не результат»."
  - "Full reassessments of fae4ee59, a92fd6ae and 61521e0d were not started (the gate forbids them after NO-GO); $5.57 of the $6 cap is unspent."

duration: 7min
completed: 2026-09-17
---

# Phase 2 Plan 03: Live v11 pilot → NO-GO, judge protocol stays v10 Summary

**Протокол судьи не изменён: пилот не уменьшил «без решения».** The paid pilot re-judged three stored fae4ee59 situations where the simulator had deviated. It judged the agent only on the part of the dialogue before the deviation. None of the three became decided (0/3; GO needed 2/3). The pilot cost $0.4304 of the $6 cap. The 02-01/02-02 code is restored to `fa79f2e`, the suite is green, and dist/ is the phase-1 build again.

## Performance

- Duration: about 7 min (03:43 to 03:50 MSK, 2026-09-17)
- Tasks: 2 of 2 (Task 1 ended at the gate; Task 2 took the NO-GO branch)
- Paid steps: 1 (the pilot); total spent $0.4304, $5.5696 left of the $6 cap

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Tracer: v11 goes live in dist/, pilot on 3 deviated situations, GO/NO-GO | — (no tracked changes; dist/ and evidence only) | dist/, ~/agent-lab-evidence/phase-02/ |
| 2 | NO-GO: restore v10 code and dist/, record the freeze | c8b9e27 | the 14 files of files_modified |

## Pilot (17d77d54 — пилот, не результат)

The gate was `NO-GO decided=0/3 cost=$0.4304 reason=no-reduction`.

- Budget gate before the pilot: `spent=$0.0000 upper=$0.8367 cap=$6 decision=GO` (judgeRate $0.0181, reference fae4ee59).
- Reassess exit 0 with an empty stderr. `record`: 3 trials judged, 0 assessment errors, 3 receipts, 3 sidecars (modes ok), 24 calls, $0.4304.
- Watcher: evaluating → results_review within about 2 minutes, no cap stop.
- Receipt audit under the v11 dist: `audit=3/3` (exit 0), so the live v11 receipts verified.

Per-card lines (ids and codes only). The other 10 cards of the pilot record are `not_reached` and are not before/after numbers.

| Card | Before (fae4ee59) | Pilot cut (seq) | Pilot outcome | Rubric results in the pilot |
|------|-------------------|-----------------|---------------|-----------------------------|
| c3de4f31 | unknown / simulator_deviated | 12 | unknown / judge_unclear | goal_attainment=unknown, prompt_compliance=fail, reply_quality=fail, user_fidelity=fail |
| f20c537d | unknown / simulator_deviated | 12 | unknown / judge_unclear | goal_attainment=unknown, prompt_compliance=fail, reply_quality=fail, user_fidelity=fail |
| 62d8b990 | unknown / simulator_unclear | 4 | unknown / judge_unclear | goal_attainment=unknown, prompt_compliance=fail, reply_quality=unknown, user_fidelity=fail |

Why it failed: the cut was computed and verified on all three (cuts=3). On the dialogue before the deviation, the judge could not tell whether the goal was reached. The cut comes before the point where the goal shows. The prefix idea therefore only moves the reason from «симулятор отклонился» to «судья не уверен», and does not remove the «без решения».

## Before / unchanged

The protocol did not change, so the headline numbers stay the 02-02 «before» numbers. After the restore, the stored runs read exactly the same.

| Run | Cards | Not measured before → now | Share before → now | Reason codes | Cuts |
|-----|-------|---------------------------|--------------------|--------------|------|
| fae4ee59 | 13 | 4 → 4 | 31% → 31% | simulator_deviated:2, simulator_unclear:1, judge_split:1 | 0 |
| a92fd6ae | 15 | 7 → 7 | 47% → 47% | simulator_deviated:4, agent_error:1, simulator_unclear:1, judge_split:1 | 0 |
| 61521e0d (phase-1 repeat) | 13 | 2 → 2 (not reassessed) | 15% | simulator_deviated:1, simulator_unclear:1 | 0 |
| 9d587362 (phase-1 reassessment) | 13 | 5 → 5 (not reassessed) | 38% | simulator_deviated:3, simulator_unclear:1, judge_split:1 | 0 |

`verify-stored-runs` exited 0 after both the swap and the restore: fae4ee59 0/9 + 4 with audit 13/13, and a92fd6ae 1/8 + 7 with audit 14/14. No MISMATCH was printed.

## Costs

| Step | Upper bound | Actual |
|------|-------------|--------|
| Pilot reassess (3 trials) | $0.8367 | $0.4304 |
| Full reassessments | — | not started (NO-GO) |
| **Phase-02 ledger total** | cap $6 | **$0.4304** (remaining $5.5696) |

## Freeze record

`freeze.txt`: `protocol=v10-unchanged frozen=2026-09-17T03:48:37+0300 reason=no-reduction`. The pinned v10 hash is `32c413cf…5736`, read from the restored dist. No further protocol change is made in this phase.

## What the restore also reverts

- **UI-D-11 wording.** After a judge change, the stability skip text is again «судья или его настройки изменились» instead of C-50 «не с чем сравнить: судья с тех пор изменился». Phase 4 may re-apply C-50 as a wording-only change.
- **goal-v2 counting** (`judgedCut`, `beforeSeq`) and the v11 receipt fields `cutBefore` / `judgedBeforeSeq` are gone.
- **What stays.** `measure-undecided.mjs` remains; on the v10 dist it prints `v11=-` and `cutEligible=-`. JUDGE-01 and JUDGE-02 continue in 02-04 unchanged, and 02-04 skips the cut row.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Preflight commit list was empty under zsh.**
- **Found during:** Task 1, step 1.
- **Issue:** The Bash tool runs zsh, which does not word-split `$FILES`. `git log BASE..HEAD -- $FILES` therefore printed nothing.
- **Fix:** Re-ran the command under `bash -c`, which listed 6fa77f0, c82f93e, 9c43c01 and e6390ee. Both outputs are kept in preflight.txt. Every later command ran under `bash -c`.
- **Commit:** none (evidence only).

**2. [Finding] The pilot record does not load under the restored v10 code.**
- The plan expected that the record «cannot be verified» under v10. In fact `ExperimentStore.get('17d77d54…')` throws a ZodError (`unrecognized_keys`, `cutBefore`), because the v10 schema is strict.
- `store.list()` still works (22 records): the record is skipped and reported in `diagnostics`.
- Consequence: Pi's run list shows one warning line for 17d77d54. `summary` / `inspect` of that id fail.
- This is expected after the rollback and is not a defect in the restored code. The record was left in `.agent-lab`, as the plan says.
- Owner option: move `17d77d54-….json`, its `.trace.jsonl` and its `.judge/` sidecar into `~/agent-lab-evidence/phase-02/` to silence the warning.

### Not done by design

- The GO branch (RE11, A11 and NEW11 reassessments, the diff, the pi-surface check and the v11 freeze) was not run.
- The note on the agent's 69-character stock reply (hash prefix `d4738c00`, RESEARCH open question 3) stays open for the owner. It is unrelated to the gate.

## Known Stubs

None.

## Threat Flags

None. No new surface. Raw outputs are only in `~/agent-lab-evidence/phase-02/` (0700/0600). This file holds ids, codes, counts, hashes and costs only. No git command ran in aigw-local, and no agent run was started.

## Evidence files (~/agent-lab-evidence/phase-02/)

preflight.txt, snap-full.log (422/422), dist-built-from.txt (c753aef), rollback-dist.txt, stored-after-swap.txt, pilot-trials.txt, budget-pilot.txt, ledger.txt, pilot.json, pilot.err (empty), pilot-exit.txt, pilot-watch.txt, pilot-record.json, pilot-cards.txt, pilot-audit.txt, gate.txt, dist-restore.txt, snap-revert.log (403/403), stored-after-restore.txt, pilot-audit-v10.txt, freeze.txt, after-restore-mu.txt.

The v11 build is kept at `.gsd/dist-v11-20260917-034734` (git-ignored).

## Self-Check: PASSED

- FOUND: commit c8b9e27 `revert(02-03): …`
- FOUND: gate.txt, freeze.txt, ledger.txt (spent $0.4304 ≤ $6)
- FOUND: `git diff --quiet fa79f2e -- src/judge.ts src/outcomes.ts src/comparison.ts` (exit 0)
- FOUND: dist/ exports no `simulatorCut` (phase-1 build restored)
- FOUND: nothing from `.agent-lab` or the evidence directory in `git status`
