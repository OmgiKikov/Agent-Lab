---
last_mapped_commit: fd07c336134b6bfe7bf48c8be0119c1b14dec56b
last_mapped_at: 2026-09-24
---
# Codebase Concerns

**Analysis Date:** 2026-09-24

Every item below was checked against the source at `fd07c33`; line numbers refer to that commit. Items that chunk G1 of the cleanup is changing are marked **(G1)**.

## Tech Debt

**The engine is still one class near the size limit (G1):**

- Issue: `src/experiment.ts` (885 lines) holds the phase machine, preparation, acceptance, runs, repeats, reassessment and calibration hooks; `src/contracts.ts` (931 lines) mixes schemas with validation and conversion helpers. Progress of long work is polled every 750 ms (`extensions/operations.ts:71`, `extensions/prepare-tool.ts:247`, `extensions/run-tool.ts:186`).
- Impact: both files are close to the 1000-line rule; a change in one workflow is easy to make in the wrong place.
- Fix approach: split `ExperimentLab` into record, operation runner with events, library, run and review modules with a typed phase table; keep `ExperimentStore` to storage only.

**Hashes of mixed-script keys depend on the process locale (G1):**

- Issue: `canonical()` sorts object keys with `a.localeCompare(b)` in the process locale (`src/scenario-library.ts:17`). A spreadsheet import keeps its column headers (Cyrillic and Latin) as keys in `original.columns`, so the same file can get different content hashes and import ids on machines with different locales.
- Impact: an import or suite made on one machine may not verify on another.
- Fix approach: pin the collation (`'en-US'`); ASCII keys — every hash stored so far — keep their order.

**The preparation consent promises the run's call budget (G1):**

- Issue: the consent's ceiling is `settings.maxCalls` (`src/miner/plan.ts:80`), which the chat sets to `max(140, 2 × tried + 19 × count + 20)` (`extensions/prepare-tool.ts:196`) — «не больше 385 вызовов» even for 5 situations.
- Impact: the number the owner agrees to is not the number the preparation can actually spend.
- Fix approach: a computed preparation ceiling (topic-map calls + situations × per-dialogue allowance + review calls) used as that preparation's budget.

**Regular expressions that still read human or model text — each kept for a reason (P):**

- Kept, frozen protocols of stored records: the «…» quote a stored prompt-rule judgment gives of the violated rule (`src/explain.ts` QUOTED_SPAN — the rubric asks for it and carries no rule id), the legacy machine-format detector for requirements stored without `observable` (`src/contracts.ts`), and the free simulator's leak, fabrication and loop checks with their value tokens (`src/simulator.ts`, `src/verbatim.ts`), which are part of `SIMULATOR_PROTOCOL` and run again when a stored run is re-assessed.
- Kept, an external format: de-identification marks of exports, one documented table in `src/masking.ts` (it decides which rows a stored import holds and what a stored topic map left out).
- Kept, the teaching runtime (`src/demo.ts`): it plays a model on its own invented dialogues and measures nothing.
- Replaced in P: the stop-list match of article titles to the customer's words (`src/scenario-sources.ts` — the first answer's goal article is kept structurally) and `#N` event references parsed from review notes (the whole-dialogue mark is no longer taken; stored ones stay verbatim).
- Impact: a new rule that reads text must be a typed field, a per-call enum or an exact comparison; the kept sites change only with a new protocol version.

## Known Bugs

**A release hook that starts a background server waits until its timeout, then kills the server:**

- Symptoms: `runRelease` waits for `timeoutMs` and returns "Release hook exceeded … ms"; the service it started is gone.
- Files: `src/targets.ts:85-111` — the hook runs `detached` with piped stdout/stderr, resolves only on `'close'` (every holder of the pipes must exit), and on timeout kills the whole process group.
- Trigger: a hook such as `./deploy.sh` that runs `uvicorn … &` without redirecting its output.
- Workaround: redirect the background process's stdio (`> log 2>&1 &`) and detach it (`setsid`/`nohup`).

## Security Considerations

**Owner consent outside `agent-lab chat`:**

- Risk: Pi's built-in tools (read, bash, edit, write) stay active next to Lab's (`extensions/steps.ts`). Inside `agent-lab chat` the CLI refuses every `--yes` (`src/cli.ts`: `agent-lab chat` gives Pi `AGENT_LAB_SESSION=1`, and Pi's shell passes its environment to every command), so a model cannot consent through bash. A Pi started otherwise with the extension loaded (`npm run pi`, a package install) does not set the variable.
- Current mitigation: the skill says the CLI is never the way to spend or decide inside the chat; whether a shell command needs the user's approval depends on Pi's settings.
- Recommendations: start the product through `agent-lab chat`.

**CLI `run` of a draft without a library starts without acceptance:**

- Risk: `start` verifies acceptance for every draft with a library (`verifyAcceptedRun`, `src/scenario-library.ts:135`) and the chat and workspace pass `requireAccepted`; `agent-lab run --yes` on a library-less draft (a repeat of a legacy record) starts with `reviewMode: 'automated'` (`src/experiment.ts:632-649`).
- Current mitigation: the draft hash must match (`expectedHash`); the record says the expectations were not reviewed by a person.

**Local data contains real conversations:**

- Risk: `.agent-lab/` holds imports, topic maps, trace journals, judge sidecars and exports with production dialogues; a suite saved from a card run carries the import batches it cites (`src/suite.ts`).
- Current mitigation: files `0600`, folders `0700`; `.agent-lab/` and `.context/` are gitignored in this repository; the import preview shows counts only; the customer report never quotes a logged conversation.
- Recommendations: never commit a suite made from private logs; add `.agent-lab/` to the agent project's `.gitignore`.

**Model providers receive conversation text:**

- Risk: topic mapping sends customers' words; preparation sends the conversation and chosen materials; the judge sends the run's conversation and, for calibration, the logged one.
- Current mitigation: only the providers configured in Pi are called; nothing else leaves the machine.

## Performance Bottlenecks

**No shared request limiter:**

- Problem: each dialogue's judging runs up to `JUDGE_CONCURRENCY = 8` votes (`src/judge.ts:34`); dialogues run up to `MAX_PARALLEL = 16` from the CLI (`src/experiment.ts:38`) and up to 8 from the chat (`extensions/launch.ts:29-30`). Worst case 128 concurrent judge requests, plus calibration and agent calls.
- Cause: concurrency is limited per dialogue, not per provider; provider failures are typed and not retried beyond one re-ask of a malformed vote.
- Improvement path: one limiter per provider shared by judge, calibration and simulator calls.

## Fragile Areas

**Judging is all-or-nothing per dialogue:**

- Files: `src/judge.ts:262-327`
- Why fragile: raw responses are saved before parsing and never repaired; a malformed vote is asked once more as a fresh request. A transport failure or a second malformed answer on any non-RAG metric rejects the whole judgment of that dialogue, and no new votes start after the first failure.
- Safe modification: change the retry or partial-result policy only together with a `JUDGE_PROTOCOL` version, because the protocol hash is part of every receipt and of run comparability.

**Prompts inside stored hashes:**

- Files: `JUDGE_PROMPT` (`src/judge.ts`), the controller and simulator roles (`src/prompts.ts`), `logJudgeInputV1` (`src/card/log-judge.ts`)
- Why fragile: their text feeds judge input hashes, the evaluator version and calibration keys; an in-place edit makes stored receipts stop verifying.
- Safe modification: a new version or mode next to the old one, pinned by a golden test.

**The command-target protocol treats every stdout line as a reply:**

- Files: `src/targets.ts:257-289`
- Why fragile: a stray `print()` in a Python adapter becomes the reply and fails as invalid JSON; lines with no request pending are dropped. Module adapters are safe: their console goes to stderr (`src/module-worker.mjs`).
- Safe modification: document it in the adapter examples (done in the README), or frame replies.

**A failure proven by absence is not recorded:**

- Files: `src/card/expectations.ts:72-81`, `src/judge.ts:129-150`
- Why fragile: a verdict on a tool or state expectation stands only when the judge cites a tool result of a complete log or an observed state. «The agent never called the tool» cites neither, so it stays not measured (`no_evidence`); first-format goals on the tool/state channels turn any unsupported verdict into `unknown`.
- Safe modification: define what evidence proves a failure per channel (a complete tool log without the call) and apply it to `fail` only.

**Run comparability rests on whole-object fingerprints:**

- Files: `src/normalize.ts`, `src/comparison.ts`
- Why fragile: any change to a card, the settings, the judge or the evaluator version makes pairs incomparable. Defaults are normalised for comparison only (`normalizeScenarioIdentity`); a new default must be added there too.

## Scaling Limits

**One import holds 300 conversations:**

- Current capacity: JSON/JSONL ≤4 MB and ≤300 dialogues (`src/limits.ts`); a larger spreadsheet gives a deterministic sample of 300 usable conversations; the topic map proposes at most 15 topics.
- Limit: traffic shares and coverage describe the sample, not the whole export.
- Scaling path: several imports, or a larger sampled import with the same hash order.

**Record size:**

- Current capacity: `store.get` refuses a record over 50 MB (`src/store.ts:169`). Judge audits live in sidecars, so a record grows with trials and events only.

## Dependencies at Risk

**Pi SDK pinned to 0.85.1:**

- Risk: `ModelRuntime.completeSimple`, `getAvailable`, the extension API (`setActiveTools`, native dialogs, message renderers) and the resource loader.
- Impact: an SDK change can break model calls or the chat while unit tests with fakes stay green.
- Migration plan: run `test/live/product-eval.ts` and `test/live/scenario-lab.ts` after any SDK bump.

## Test Coverage Gaps

**Real-model checks:**

- What's not tested: `test/live/product-eval.ts` has never run on a real model; `test/live/scenario-lab.ts` and `test/live/simulator-stop.ts` have not run since the cleanup.
- Risk: the chat may pick the wrong tool for an owner's phrase although every unit test passes.
- Priority: High

**Noisy command adapter:**

- What's not tested: a command adapter that prints debug lines to stdout.
- Files: `src/targets.ts:257-289`
- Priority: Low

## Resolved since the 2026-09-16 map

- The extension imports `src/` (stage 1); `npm test` no longer breaks a live Pi session.
- The `goalObservation` default lives in one place (`src/normalize.ts`); a repeat of an old record stays comparable (`test/comparison.test.ts`).
- The validate/replay goal path, offline `score` and the validate budget are gone (stages 2a/2b).
- Judge audits moved to private sidecars with receipts on the trial.
- Accepted runs are verified by stored hashes, never recompiled; a card draft cannot start without a verified acceptance.
- Release hooks are killed at their deadline even when a grandchild holds the pipes (`test/targets.test.ts:310`).
- (P) `npm run typecheck` checks `extensions/` and all of `test/` with the strictness of `src/` (`tsconfig.check.json`); the 135 errors are fixed.
- (P) The design specifications live in `docs/design/`; every comment cites a file and a section, and `test/design-references.test.ts` checks each citation.
- (P) New records carry no English boilerplate `limitations`; the remaining notes are Russian. «Ошибок нет…» agrees with its count.
- (P) `agent-lab build` shows the preparation consent and prepares only on `--yes` within its ceiling; `--situations N` sets the count. The chat chooses a spreadsheet's conversations natively (`table.where`), and a column with more than 30 values is listed by its 30 most frequent.

---

*Concerns audit: 2026-09-24 (checked against source at `fd07c33`)*
