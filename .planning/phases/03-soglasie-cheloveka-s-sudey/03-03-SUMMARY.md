---
phase: 03-soglasie-cheloveka-s-sudey
plan: 03
subsystem: cli
tags: [agreement, disagreements, cli, pi-chat, surface-parity, copywriting]

requires:
  - phase: 03-soglasie-cheloveka-s-sudey
    plan: 01
    provides: "`ResultView.agreement` with `disagreements[]` and `unmarked[]`, `judgeAgreement`, the F6 rows"
  - phase: 03-soglasie-cheloveka-s-sudey
    plan: 02
    provides: "what a quick mark means for the headline and for the review queue (a decided mark closes a situation, a doubt does not)"
  - phase: 02-sudya-obyasnyaet-provaly
    plan: 05
    provides: "`failureLines` in the Pi payload, the collapsed-result order and the phase-1 surface check"
provides:
  - "`disagreementRows`, `disagreementTitle`, `DISAGREEMENT_BOARD_TITLE`, `agreementNextStep`, `agreementSectionLines` — F7 and F8 worded in one place"
  - "F7/F8 in `agent-lab summary` between the cause section and the full failure list"
  - "Pi payload `disagreementLines`; the collapsed result prints block → causes → disagreements → the board pointer last"
  - "`pi-surface-check.mts` compares the agreement section across CLI, payload and render and reports `disagreements=<K> next=<0|1>`"
  - "`test/helpers/copy-check.ts` — `assertPlainCopy`, the phase-3 copywriting scan shared by later plans"
affects: [03-04, 03-05, 03-06, 03-07]

actuals:
  tokens: 8400
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "A section that must stay outside the parity-checked first block is built by its own `*SectionLines` function and spliced by each surface"
    - "A pointer that must read last survives a new section by being detached from its own block and re-appended after it"
    - "Untrusted record text is collapsed to one line in the pure module and escaped only at the surface boundary"

key-files:
  created:
    - test/helpers/copy-check.ts
  modified:
    - src/result-view.ts
    - src/cli.ts
    - extensions/agent-lab.ts
    - .planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts
    - test/extension.test.ts
    - test/result-view.test.ts

key-decisions:
  - "The `Все провалы — /agent-lab …` pointer is detached from `failureLines` in the collapsed Pi result and re-appended after `disagreementLines`, so the phase-2 payload is unchanged while the Pi order matches UI-SPEC F7"
  - "The no-chat-path-writes-a-mark guard scans the tool schemas for `verdict`, `judgeVerdict` and `quick`, not for a bare `source`: `agent_lab_build` carries a pre-existing nested `source` fixed to `owner` that describes the owner's materials"
  - "The owner's reason is never shortened on any surface — whitespace runs collapse to one space and that is all; a mutation that slices it to 80 characters fails the suite"

patterns-established:
  - "Pattern: `assertPlainCopy(text, label)` — remove the allowlist (`/agent-lab <id8>`, `Pi`, the single key letters) in that order, then fail on the first remaining Latin or machine word"
  - "Pattern: a fixture whose trials are recorded in the opposite order from its cards, so a list that claims record order has to prove it"

requirements-completed: [JUDGE-05]

coverage:
  - id: D1
    description: "`agent-lab summary` prints `Несогласия с судьёй (<K>):` with `! <title>`, `Судья: … → владелец: …` and `Причина: «<note>»` per item, between the cause section and `Все провалы (<n>):`, followed by the next-step row"
    requirement: JUDGE-05
    verification:
      - kind: e2e
        ref: "test/result-view.test.ts#CLI summary puts the disagreement and the next step between the causes and the full list, escaped"
        status: pass
    human_judgment: false
  - id: D2
    description: "The Pi tool payload carries the same section as `disagreementLines`, its collapsed result shows those rows, and the CLI prints the identical lines for the same record"
    requirement: JUDGE-05
    verification:
      - kind: e2e
        ref: "test/extension.test.ts#the owner’s disagreement with the judge reads the same in the Pi payload, its collapsed result and the CLI summary"
        status: pass
      - kind: command
        ref: "npx tsx .planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts --id fae4ee59… --id a92fd6ae… → two OK lines with disagreements=0 next=1"
        status: pass
    human_judgment: false
  - id: D3
    description: "The next-step row appears only while a queued situation has no current mark; «не могу сказать» counts as an answer, and an empty queue prints nothing"
    requirement: JUDGE-05
    verification:
      - kind: unit
        ref: "test/result-view.test.ts#the next step points at the board while something in the queue is unmarked, and only then"
        status: pass
    human_judgment: false
  - id: D4
    description: "The reason is shown in full with whitespace runs collapsed to one space, never shortened, never containing «…»; an escape sequence in a reason never reaches the terminal"
    requirement: JUDGE-05
    verification:
      - kind: unit
        ref: "test/result-view.test.ts#the owner’s reason is shown whole: whitespace runs become one space and 600 characters survive"
        status: pass
      - kind: e2e
        ref: "test/result-view.test.ts#CLI summary puts the disagreement and the next step between the causes and the full list, escaped"
        status: pass
    human_judgment: false
  - id: D5
    description: "No tool gains a parameter that writes a mark: no schema offers a verdict, a judge verdict or a one-key mark, and `agent_lab_review` still asks only which dialogue to show"
    requirement: JUDGE-05
    verification:
      - kind: unit
        ref: "test/extension.test.ts#the owner’s disagreement with the judge reads the same in the Pi payload, its collapsed result and the CLI summary"
        status: pass
    human_judgment: false
  - id: D6
    description: "F6, F7 and F8 read as plain Russian on every band, past the allowed key letters, the product name and the `/agent-lab <id8>` command"
    requirement: JUDGE-05
    verification:
      - kind: unit
        ref: "test/result-view.test.ts#the agreement row, the disagreements and the next step are plain Russian on every band"
        status: pass
    human_judgment: false
  - id: D7
    description: "A manager reading the Pi answer or the CLI summary for a real acquiring run understands which judge verdicts the owner overturned and why"
    verification: []
    human_judgment: true
    rationale: "Whether the list reads as an honest correction rather than as excuses is a judgment on a live run with real marks; the marking keys and the board land in 03-04…03-06, so the live read belongs to the phase-level check."

duration: 13 min
completed: 2026-09-17
status: complete
plan_head_before: 48b89ff2ddbe00ae03456446964d0e44abbf9cb0
---

# Phase 3 Plan 03: Несогласия с судьёй в выжимке CLI и в ответе Pi Summary

**Выжимка и ответ Pi теперь называют поимённо ситуации, где владелец поправил судью, приводят его причину целиком и говорят, где отметить остальные; три поверхности сверяются на настоящих прогонах эквайринга.**

## Performance

- **Duration:** 13 min (12:22:46Z → 12:35:22Z)
- **Completed:** 2026-09-17
- **Tasks:** 2
- **Files modified:** 7 (1 created)

## Accomplishments

- **The manager can now see what the owner overturned.** `agent-lab summary` prints, after the top causes and before `Все провалы (<n>):`, a `Несогласия с судьёй (<K>):` section: one `! <title>` per situation, `Судья: не справился → владелец: справился` under it, and `Причина: «…»` in the owner's own words. The items follow the card order of the record, not the order the marks were written in — proved by a fixture whose dialogues are recorded the other way round from its cards.
- **The same words in Pi.** The tool payload carries the section as `disagreementLines`; the collapsed tool result prints the block, the cause section, the disagreements, and only then `Все провалы — /agent-lab <id8>, раздел 1, Enter.`. The phase-2 `failureLines` payload is untouched: the pointer is detached at render time and re-appended, so the Pi order matches UI-SPEC F7 without moving anything the earlier surfaces depend on.
- **Everyone is told where to press.** When a queued situation still has no mark, both surfaces end the section with `Отметить согласие с судьёй можно в Pi: /agent-lab <id8>, раздел 3.` — and stop printing it the moment every queued situation is answered, a «не могу сказать» included. On the two stored acquiring runs the check reports exactly that state: `disagreements=0 next=1`.
- **The surface check now covers the new section.** `pi-surface-check.mts` slices the agreement section out of the CLI output, compares it with the payload line for line, requires every line to be a whole line of the collapsed render, and extends its OK line to `disagreements=<K> next=<0|1>`. Both stored acquiring runs pass: `OK surfaces=3 lines=10 sections=22 disagreements=0 next=1 id=fae4ee59` and `… lines=13 sections=21 disagreements=0 next=1 id=a92fd6ae`.
- **The owner's words are never edited and never dangerous.** Whitespace runs (a line break, a tab, double spaces) become one space and nothing else happens to the text: a 600-character Cyrillic reason arrives whole, and no row ever contains `…`. A reason carrying an ESC sequence is printed with the sequence gone and the visible words intact — the CLI stdout contains no ESC byte.
- **The chat still cannot mark anything.** No tool gained a parameter; a test asserts no registered schema offers `verdict`, `judgeVerdict` or `quick`, and that `agent_lab_review` still takes exactly `id` and `trialId`. The model can only point at the board.
- **The phase-3 copywriting contract became executable.** `test/helpers/copy-check.ts` exports `assertPlainCopy`, which removes the allowlist (`/agent-lab <id8>`, `Pi`, the single key letters `a f n o r s v x y`) and then fails on the first remaining Latin or machine word. It passes on every F6 band (M = 0, 1, 10, 20 and one with all three tail rows), on F7 with two items and on F8, and fails on `метрика`, `goal_attainment` and `stale`.

## Task Commits

1. **Task 1 (tracer): the CLI and Pi chat list the owner's disagreements with the judge** — `94bfe47` (feat)
2. **Task 2: pin the disagreement rows, the next step and their plain Russian** — `afed519` (test)

**Plan base:** `48b89ff2` (`plan_head_before`) · **Commits measured:** 2 (`git rev-list --count 48b89ff2..HEAD`, taken at the moment this summary was written).

Re-measuring later returns more. Between `afed519` and this summary's own `docs(03-03)` commit, the concurrent session sharing this worktree landed `ad1dd84` (`docs(06): synthetic description is a main-path input`) and `f63f9ff` (`docs(05): the summary and the HTML report show the synthetic share`) on the same branch. Neither touches a source or test file of this plan. The frontmatter keeps the measured number rather than the inflated one, exactly as 03-02 did.

## TDD Gate Compliance

| Gate | Commit | Evidence |
|---|---|---|
| RED | — | **Unexpected GREEN, investigated and accepted (see below)** |
| GREEN | — | Not needed: no production code had to change for Task 2 |
| REFACTOR | — | Not needed |
| Tests | `afed519` `test(03-03): …` | `snap-test.sh test/result-view.test.ts test/extension.test.ts test/agreement.test.ts` → `# tests 104 / # pass 104 / # fail 0` |

Task 2 is marked `tdd="true"`, and its five behaviour tests passed on first run against the code the Task 1 tracer had already committed. Per the TDD reference this is an "unexpected GREEN in the RED phase" and was investigated rather than waved through:

- **The feature genuinely existed.** The plan's own Task 2 `<action>` says «`src/result-view.ts` / `src/cli.ts`: fix whatever the behavior tests reveal; keep all text in the functions from Task 1» — the wording anticipates that the tracer may already satisfy the contract. It did: every string, the whitespace collapse, the ordering and the escaping were written in `94bfe47`.
- **The tests are not vacuous.** A mutation check was run to prove they have teeth: changing `oneLine` to `…trim().slice(0, 80)` in `src/result-view.ts` made `# fail 1` — exactly the test that claims the reason survives whole (`the owner’s reason is shown whole…`). The mutation was reverted and `git diff src/result-view.ts` confirmed the file identical to the commit before the tests were committed.
- **Result:** Task 2 produced one `test(03-03)` commit and no `feat` commit, because there was nothing to fix. The RED and GREEN gate commits for `03-03` are therefore absent from the git log by fact, not by oversight.

## Files Created/Modified

- `src/result-view.ts` — `DISAGREEMENT_BOARD_TITLE`, `disagreementTitle`, `disagreementRows` (roles `dis-title` / `dis-verdicts` / `dis-reason` / `blank`), `agreementNextStep`, `agreementSectionLines`, and the module-local `oneLine` whitespace collapse. Raw text only; no escaping, no shortening (`grep -Ec "shorten\(|preview\(" src/result-view.ts` = 0).
- `src/cli.ts` — `summary` prints the section between the cause section and the full failure list, each row through `safeLine`, blank rows kept blank.
- `extensions/agent-lab.ts` — payload `disagreementLines`; `renderResult` splits the pointer off `failureLines`, prints causes, then disagreements, then the pointer.
- `.planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts` — the cause slice now ends at the agreement section too; the new agreement slice is compared with the payload and against the render; the OK line carries `disagreements=` and `next=`.
- `test/extension.test.ts` — the 02-05 collapsed-result assertion updated on purpose to the new order; a new end-to-end test writes one quick disagreement through the lab and reads it back out of the payload, the render and the spawned `dist/cli.js`, plus the tool-schema guard.
- `test/result-view.test.ts` — five tests: card order with both verdict directions, the reason whole (600 characters, whitespace, no `…`), the next step's three states, the CLI order with an ESC sequence, and the plain-Russian scan across F6/F7/F8.
- `test/helpers/copy-check.ts` (new) — `assertPlainCopy`.

## Verification

| Check | Result |
|---|---|
| Task 1 `<verify>`: snapshot tests + `pi-surface-check` on `fae4ee59` and `a92fd6ae` | `# tests 119 / # pass 119 / # fail 0`; two OK lines with `disagreements=0 next=1`; exit 0 |
| Task 2 `<verify>`: `snap-test.sh test/result-view.test.ts test/extension.test.ts test/agreement.test.ts` | `# tests 104 / # pass 104 / # fail 0`, exit 0, no tsc error |
| `grep -c "export function disagreementRows\|agreementSectionLines\|agreementNextStep" src/result-view.ts` | 1 each |
| `grep -c "agreementSectionLines(" src/cli.ts` | 1 (≥ 1 required) |
| `grep -c "disagreementLines: agreementSectionLines(" extensions/agent-lab.ts` | 1 |
| `grep -c "disagreements=" pi-surface-check.mts` | 1 (≥ 1 required) |
| `test/extension.test.ts` contains `Судья: не справился → владелец: справился` | present |
| `grep -c "export function assertPlainCopy" test/helpers/copy-check.ts` | 1 |
| `test/result-view.test.ts` imports `assertPlainCopy`, contains `Судья: справился → владелец: не справился` and `[31m` | present (1 / 1 / 2) |
| `grep -Ec "shorten\(\|preview\(" src/result-view.ts` | 0 |

Every acceptance criterion of both tasks passes, with the one documented amendment below.

## Decisions Made

- **The board pointer is re-appended, not moved in the payload.** UI-SPEC F7 puts `Все провалы — …` last, after F7 and F8. Rewriting `failureLines` to drop the pointer would have changed a phase-2 payload that `pi-surface-check` and 02-05's test both read. Instead `renderResult` splits the pointer off at display time and re-appends it after `disagreementLines`, so only what a person sees changed.
- **The mark-writing guard names the mark, not the word `source`.** The plan's acceptance criterion asked for no `source` property in any tool schema; `agent_lab_build` has carried a nested `source` (a constant `owner`, describing where the owner's materials came from) since long before this phase, and removing it is out of scope and unrelated to marks. The test asserts the property that actually matters — no `verdict`, no `judgeVerdict`, no `quick` in any schema, and `agent_lab_review` limited to `id` and `trialId` — and the comment records why the single `source` is harmless.
- **The reason is collapsed, never shortened.** `oneLine` does one thing: whitespace runs to one space, then trim. The 600-character test asserts the exact length of the resulting row, so any future truncation, ellipsis or preview helper fails immediately.

## Deviations from Plan

### Amended acceptance criterion

**1. [Rule 1 — criterion contradicts pre-existing unrelated code] The tool-schema scan checks `verdict` / `judgeVerdict` / `quick` instead of a bare `source`**
- **Found during:** Task 1, when the new test first ran.
- **Issue:** The plan's criterion «the registered tool parameter schemas contain no `source` and no `judgeVerdict` property» cannot hold: `agent_lab_build`'s input schema has a nested `source` with `const: "owner"`, which names the provenance of the owner's materials and predates phase 3. Satisfying the criterion literally would mean deleting an unrelated parameter of another tool.
- **Fix:** The assertion scans every registered schema for `"verdict"`, `"judgeVerdict"` and `"quick"` (all absent) and pins `agent_lab_review` to exactly `id` and `trialId`. The threat it guards (T-03-09, a model writing a mark) is covered at least as strictly as before.
- **Files modified:** `test/extension.test.ts`
- **Verification:** the test passes; `agent_lab_build`'s `source` was confirmed to be `const: "owner"` and unreachable as a mark.
- **Commit:** `94bfe47`

**Total deviations:** 1 amended acceptance criterion. **Impact:** none on behaviour; the prohibition «MUST NOT offer a chat or CLI path that writes an agreement mark» is tested, and no production code changed because of it.

Everything else executed exactly as written.

## Authentication Gates

None — no credentials, no external service, no paid model call. The acquiring agent was never started; `pi-surface-check` only reads stored records.

## Issues Encountered

- **Do not restart Pi in this worktree until 03-07.** From this plan on, `extensions/agent-lab.ts` imports `agreementSectionLines` from `../dist/result-view.js`, and the worktree `dist/` has not been rebuilt (rebuilding is 03-07's job and must be coordinated with the other sessions sharing this worktree). A Pi session started here before that swap would fail to load the extension. Tests are unaffected: they run against a `git archive`-style snapshot that builds its own `dist/`.
- **Another session is editing `.planning/phases/06-legkiy-start/` and `.planning/phases/03.1-…/`** in this same worktree. Neither was staged or touched by this plan.

## Known Stubs

None. Every row this plan promises is built from stored data and covered by a passing test; nothing returns a placeholder.

## Threat Flags

None. T-03-08 (terminal escapes in the reason) is mitigated and tested on the CLI; T-03-09 (a model writing a mark) is mitigated by the schema scan; T-03-10 (surface-check output) still prints only ids, counts and line indexes; T-03-11 (surfaces disagreeing) is mitigated by `pi-surface-check`'s new agreement comparison. No new network endpoint, auth path, file access pattern or trust-boundary schema change.

## User Setup Required

None.

## Next Phase Readiness

- `DISAGREEMENT_BOARD_TITLE` is exported and unused on purpose: 03-06 renders the same items on the board under that heading, with the rows coming from `disagreementRows` so the three surfaces cannot drift.
- `assertPlainCopy` is ready for 03-04…03-06 to scan F9…F14 and the C-65…C-102 strings.
- The next-step row assumes «раздел 3» exists on the board; 03-05 and 03-06 must keep that number, or F8 has to move with it.
- Open for the phase-level check: coverage D7 — a manager reading the real list on a live acquiring run.

---
*Phase: 03-soglasie-cheloveka-s-sudey*
*Completed: 2026-09-17*

## Self-Check: PASSED

- `src/result-view.ts`, `src/cli.ts`, `extensions/agent-lab.ts`, `.planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts`, `test/extension.test.ts`, `test/result-view.test.ts`, `test/helpers/copy-check.ts` and this SUMMARY exist on disk.
- Commits `94bfe47` and `afed519` exist in `git log`; `git rev-list --count 48b89ff2..HEAD` = 2, matching `commits: 2`.
- The plan `<verification>` was re-run on the final tree: snapshot tests `# tests 119 / # pass 119 / # fail 0` and two `OK … disagreements=0 next=1` lines, exit 0.
