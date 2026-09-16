---
last_mapped_commit: 015fee98766cc2082001fdfce3a329a31329d4cf
last_mapped_at: 2026-09-16
---
# Codebase Concerns

**Analysis Date:** 2026-09-16

Every item below was checked against the source at HEAD `015fee9`. Line numbers refer to that commit.

## Tech Debt

**`goalObservation` is optional, and its default lives in several places:**

- Issue: `goalObservation` is optional on `Scenario` (`src/contracts.ts:283`). The `'reply'` default is applied in several independent places: `dialogueToScenario` (`src/contracts.ts:431`), `freshDraft` for non-sandbox targets (`src/experiment.ts:69-70`), the build path (`src/experiment.ts:358`, `src/experiment.ts:369`), the hypothesis → test path (`src/experiment.ts:526`) and discovery (`src/experiment.ts:605`). A sandbox card may keep no value at all (`src/experiment.ts:369`).
- Impact: without the field the judge cannot confirm a goal (`src/judge.ts:98-102`) and turns a pass/fail into `unknown`. `testPlanLines` throws for such a card (`src/quality.ts:109`). Behaviour depends on which path created the card.
- Fix approach: normalise once, either at import/parse time or by making the field required for non-sandbox targets, and delete the scattered defaults.

**The judge cannot confirm a failed goal on the `tool`/`state` channels:**

- Issue: `goal_attainment` stays pass/fail only if the cited evidence "confirms" the owner-selected channel (`src/judge.ts:98-102`). For `tool`, confirmation requires a cited successful tool result whose `tool_called` check passed (`src/judge.ts:85-93`). For `state`, all `state_equals` checks must pass (`src/judge.ts:94-97`). These conditions describe success, so a correct `fail` verdict on those channels is rewritten to `unknown` (`src/judge.ts:101-102`).
- Impact: runs with `tool`/`state` cards cannot count a goal as failed. The verdict shows "no decision" instead of a failure, and the process exit code reflects `unknown` rather than failure.
- Fix approach: define what evidence confirms a *failed* goal per channel (e.g. a tool error result or a failed `state_equals` check) and apply it only to `fail` results.

**Two monolithic modules:**

- Issue: `src/experiment.ts` (1175 lines) mixes build, validate/replay, score, repeat, accept, start and run orchestration. `src/contracts.ts` (1013 lines) mixes schemas with conversion and validation logic (`dialogueToScenario`, `validateObservedGoals`, `goalToScenario`).
- Impact: the defaults above are hard to find, and changes to one workflow easily affect another.
- Fix approach: split `experiment.ts` by workflow (prepare/validate, score/reassess, run) behind the existing `Lab` facade before adding more modes.

## Known Bugs

**Repeating an old external run makes it incomparable with its parent:**

- Symptoms: `compareRuns(before, after)` reports "Прогоны несравнимы" for every pair.
- Files: `src/experiment.ts:69-70` (`freshDraft` adds `goalObservation: 'reply'` to cards that lack it), `src/comparison.ts:551-552` (a changed card fingerprint adds the note "Содержимое карточек изменилось"), `src/comparison.ts:561-566` (any note marks all pairs incomparable).
- Trigger: repeat a non-sandbox run whose cards were saved without `goalObservation` (records created before the default existed, e.g. the GLM pilot records), then compare the repeat with the original.
- Workaround: re-assess both runs under the current protocol, or add the field to the old record before repeating. Not covered by tests: `test/comparison.test.ts` never mentions `goalObservation`.

**In validate/replay, a duplicate goal id throws away the whole build after all model calls:**

- Symptoms: the build fails with "Observed goals have duplicate IDs" after every per-dialogue extraction call has already been paid for.
- Files: `src/pi.ts:619-648` (one model call per dialogue, and the model chooses `goal.id`), `src/experiment.ts:321-344` (batches of `GOAL_BATCH`, then `validateObservedGoals` over the combined list), `src/contracts.ts:386` (throws on a duplicate).
- Trigger: two dialogues that the model names the same way (for example, the same tariff question).
- Workaround: none in code. Fix by assigning ids in the harness (e.g. from the dialogue id) or de-duplicating per dialogue before the final check. No test asserts this path.
- Note: a *shortfall* of testable dialogues no longer discards the build. The build throws only when zero cards remain (`src/experiment.ts:342`); otherwise it records "Измеримы N из запрошенных M" as a limitation (`src/experiment.ts:343`, tested in `test/experiment.test.ts:711`).

**A release hook that starts a background server hangs until timeout, then kills the server:**

- Symptoms: `runRelease` waits for the full `timeoutMs` and returns "Release hook exceeded … ms". The service the hook started is gone.
- Files: `src/targets.ts:83-106`. The hook is spawned `detached` with piped stdout/stderr (`src/targets.ts:89`). The promise resolves only on `'close'` (`src/targets.ts:103`), which waits for every holder of the pipes to exit. On timeout, `kill()` sends `SIGKILL` to the whole process group (`src/targets.ts:94-98`).
- Trigger: a hook such as `./deploy.sh` that runs `uvicorn … &` without redirecting its output.
- Workaround: the hook must redirect the background process's stdio (`> log 2>&1 &`) and detach it with `setsid`/`nohup`. `test/targets.test.ts:282` covers exit code, output and timeout, but not a lingering child.

## Security Considerations

**Accepting a test and starting a run are not tied together in code:**

- Risk: the "accept exactly one test, then run" rule lives in the skill prompt. `acceptDraft` (`src/experiment.ts:703-717`) checks the workflow, phase, card count and hash, but not `goalObservation`. `start` (`src/experiment.ts:873-880`) never reads `acceptedTests`, so a direct CLI/API call can run an unaccepted draft.
- Current mitigation: `start` requires `approved: true` and an `expectedHash` from the caller (`src/cli.ts:337`). The skill shows `testPlanLines` first, which throws without `goalObservation` (`src/quality.ts:109`).
- Recommendations: if acceptance is a product rule, check `acceptedTests`/`acceptedDraftHash` in `start` and validate `goalObservation` in `acceptDraft`.

**Local run data contains real dialogues:**

- Risk: `.agent-lab/`, the grounding cache (`<store>/grounding/<key>.json`, `src/experiment.ts:307-316`) and trace journals hold production dialogues and full judge inputs.
- Current mitigation: files are written with mode `0o600` (`src/store.ts:125`, `src/store.ts:137`, `src/experiment.ts:315`), and `.agent-lab/` and `.context/` are gitignored.
- Recommendations: copy evidence out before archiving a workspace (earlier pilot evidence was lost with a deleted workspace), and never add these paths to the repository.

## Performance Bottlenecks

**CLI `score` does not scale its model-call budget:**

- Problem: `agent-lab score` (`src/cli.ts:279-293`) builds the input from `task.json` without a budget sized to the number of dialogues, so the default ceiling applies whatever the dialogue count.
- Cause: only the Pi tool scales it: `max(20, 8 × dialogues)` capped at 3000 calls, and `max(3 min, 2 min × dialogues)` capped at 4 h (`extensions/agent-lab.ts:292-293`, used at `extensions/agent-lab.ts:360-361`).
- Improvement path: move the scaling into `Lab.score` (or share one helper) so the CLI and Pi agree.

**Concurrency is not coordinated across dialogues:**

- Problem: each dialogue runs its judge votes with up to `JUDGE_CONCURRENCY = 8` workers (`src/judge.ts:23`, `src/judge.ts:190`). There are two votes per applicable metric (`src/judge.ts:161`). Dialogues run with `parallel` from 1 (the default) up to `MAX_PARALLEL = 16` (`src/experiment.ts:17`, `src/experiment.ts:874-875`). The upper bound is 16 × 8 = 128 concurrent judge requests, plus target calls.
- Cause: no shared limiter across dialogues, and no rate-limit backoff beyond one retry on connection failures during goal extraction (`src/experiment.ts:321-327`).
- Improvement path: a single request limiter per provider; keep `parallel` an execution-only knob, as documented at `src/experiment.ts:872`.

## Fragile Areas

**Judge output is all-or-nothing per dialogue:**

- Files: `src/judge.ts:150-196`
- Why fragile: raw responses are saved before parsing and never repaired (the protocol has `repair: false`, `src/judge.ts:20`). One unparseable or failed vote on any non-RAG metric rejects the whole judgment for that dialogue (`src/judge.ts:193-195`). After the first failure no new votes start.
- Safe modification: keep the no-repair rule, since it is part of the measurement protocol. Change retry/partial-result policy only together with a `JUDGE_PROTOCOL` version bump, because the protocol hash feeds run comparability (`src/comparison.ts`, judge identities).
- Test coverage: `test/judge.test.ts`.

**The command-target protocol treats every stdout line as a reply:**

- Files: `src/targets.ts:257-281`
- Why fragile: every stdout line resolves the pending request (`src/targets.ts:258`). A stray `print()` in a Python adapter becomes the reply and fails with "Ответ внешнего агента не является корректным JSON" (`src/targets.ts:280-281`). Lines that arrive with no request pending are silently dropped (`takePending()` returns `undefined`). The HTTP target likewise rejects non-JSON bodies (`src/targets.ts:211`).
- Safe modification: document "stdout is protocol-only, log to stderr" in the adapter examples (`examples/`), or add a line prefix or envelope check.
- Test coverage: `test/targets.test.ts` uses a well-behaved fixture only.

**Run comparability depends on whole-object fingerprints:**

- Files: `src/experiment.ts:44-47` (`measurementHash` over scenarios, settings, target, sources, …), `src/comparison.ts:542-566`
- Why fragile: any change to a card, the settings, the evaluator version or the judge protocol makes every pair incomparable. That is intended for real changes, but harmless normalisation (such as the `goalObservation` default) trips it too.
- Safe modification: normalise records before fingerprinting; add a test for every new default.

## Scaling Limits

**Judge audits inflate the main run record:**

- Current capacity: the audit (full prompt, full input JSON and every attempt, `src/judge.ts:150-157`) is appended to the trace journal (`src/store.ts:137`) and also copied into each trial (`src/evaluation.ts:297`). The record is rewritten on every save.
- Limit: `store.get` refuses records over 50 MB (`src/store.ts:100`), so a large run becomes unreadable, and `store.list` then reports it only as a diagnostic.
- Scaling path: keep audits only in the journal and store a hash/reference on the trial.

**Validate budget grows with the requested card count:**

- Current capacity: the Pi validate ceiling is `max(140, 2 × dialogues + 19 × validationCount + 20)` calls, and the time limit is `max(3 min, 3 min × dialogues)` (`extensions/agent-lab.ts:300`, `extensions/agent-lab.ts:360-361`).
- Limit: the 15-card acquiring replay took about 17 minutes and $1.50 on a real agent. Larger sets scale linearly.
- Scaling path: rerun only failed cards when repeating.

## Dependencies at Risk

**Pi SDK pinned to one minor version:**

- Risk: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` 0.85.1 (see `STACK.md`). The extension (`extensions/agent-lab.ts`) and the model layer (`src/pi.ts`) depend on the SDK's tool, usage and budget APIs.
- Impact: an SDK upgrade can break budget accounting (`src/pi.ts:146`, `src/pi.ts:174`) without failing unit tests that use fakes.
- Migration plan: run one live smoke test after any SDK bump.

**The Pi extension imports `dist/`:**

- Risk: `npm test` rebuilds and deletes `dist/`, which the running Pi extension imports.
- Impact: tests or builds in a shared worktree break a live Pi session.
- Migration plan: run reviews and tests from a `git archive HEAD` snapshot, not in the live worktree.

## Test Coverage Gaps

**Repeat → compare with defaulted cards:**

- What's not tested: that `repeat` of a record lacking `goalObservation` stays comparable, or is reported as such.
- Files: `src/experiment.ts:69-70`, `src/comparison.ts:551-566`
- Risk: the demo's "before/after" screen shows "incomparable".
- Priority: High

**Duplicate goal ids in replay:**

- What's not tested: two per-dialogue extractions returning the same id.
- Files: `src/pi.ts:619-648`, `src/experiment.ts:344`
- Risk: an entire paid build is lost at the last step.
- Priority: High

**`fail` on the `tool`/`state` channels:**

- What's not tested: a judge `fail` with tool/state evidence staying `fail`.
- Files: `src/judge.ts:85-102`
- Risk: tool-based agents can never show a failed goal.
- Priority: Medium

**Release hook with a lingering child, and noisy adapter stdout:**

- What's not tested: a hook that backgrounds a server with inherited pipes, and a command adapter that prints debug lines.
- Files: `src/targets.ts:83-106`, `src/targets.ts:257-281`
- Priority: Medium

**Record size growth:**

- What's not tested: a run approaching the 50 MB record limit with judge audits.
- Files: `src/evaluation.ts:297`, `src/store.ts:100`
- Priority: Low

---

*Concerns audit: 2026-09-16 (checked against source at `015fee9`)*
