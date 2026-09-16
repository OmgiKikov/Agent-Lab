---
name: agent-builder
description: Inspect a local agent, build a repeatable validation set from owner requirements and real logs, run the real agent, and report accuracy with grounded failure causes.
---

# Agent builder

Keep the whole Agent Lab flow in the current Pi conversation:

`repository + owner requirements + real logs → 15 replayable cards → review run plan → real TargetSession → estimated accuracy + separate metrics + grounded failure causes → optional human review → save/repeat/version diff`.

Discovery is a supplemental loop for adding one new regression: `logs → one hypothesis → Проверим? → one editable test → explicit acceptance → run/save`.

Use the current project unless the owner named another one. Preserve the selected model and budget. With real logs, default to 15 validation cards and one user mode; default to one test only in supplemental discovery. Do not turn the conversation into a tour of internal tools or reports.

## Product experience

- Read before asking: inspect the repository, its run configuration, entry point, prompts, tools and relevant tests. Ask only for information that cannot be found locally.
- Treat owner materials as the source of expected behavior. Existing code, old agent answers and imported outcome labels may be wrong. Every requirement needs its source quote; unresolved policy stays unresolved.
- Lead with one validation-set accuracy number, then repeated failure causes, cited dialogues and separate metrics. Separate an agent defect, a broken test and missing evidence.
- Treat cards as an internal reproducibility contract. For a multi-test validation run, summarize count and topic coverage; do not make the owner inspect or accept every card.
- In one-test discovery, show the complete proposed test before acceptance: goal, user knowledge and behavior, opening, initial state, checks, rubrics with pass/fail criteria, source quote, observation channel and draft hash.
- One-test acceptance approves only that definition. Multi-test validation uses its run-plan confirmation; execution and any human result verdict remain separate decisions.
- After a change to the agent, repeat the exact accepted test. A changed test cannot prove an agent improvement.

## Real dialogues at the start

Ask once, in the user's language: «Есть реальные диалоги с агентом? Можно указать файл JSON/JSONL или начать без них». Honor a path or decision already present in the conversation. Do not search unrelated files. `agent_lab_build` must return `needs_input` until it receives dialogues or the owner explicitly chooses `withoutDialogues=true`. Пустой ответ не означает согласие продолжить без них; оставь вопрос открытым до явного пути или решения начать без них. Invalid input needs correction, not a silent synthetic fallback.

Logs are offline, de-identified exports; no external logging service is connected. With logs, call `agent_lab_build` with `mode:"validate"`. It accepts up to 300 dialogues, chooses a stable outcome-blind sample of 15 by default and builds one card per sampled conversation. Stored outcome labels and old assistant replies never define the expected result. Real user turns become a deterministic `scripted` replay; the LLM user simulator does not participate. The owner requirements define `successCriteria`, and prompt/RAG tests use `goalObservation:"reply"` unless the owner explicitly chose another observable channel.

Summarize the 15-dialogue set and run plan; keep full card definitions in the optional detail view. Building the internal scenarios does not run the target. Use `agent_lab_run` for one native confirmation that names the real target, planned dialogues and budget. After the run, report in this order:

1. estimated accuracy on this validation set: passed / (passed + failed);
2. unknown, invalid and not-reached cards outside that denominator;
3. separate `goal_attainment`, `prompt_compliance` and `reply_quality` rows;
4. repeated failure causes with card, dialogue event and exact requirement/prompt evidence;
5. judge and human-review limits;
6. the saved suite path and repeat command when the set is useful.

Never call this production accuracy or a calibrated guarantee. The sample excludes conversations too long for lossless replay and that limitation stays visible.

Use `mode:"discover"` only when the owner asks to find or add one particularly useful regression test. It accepts up to 300 dialogues. Its call plan is displayed through native confirmation before the first provider call and bounds calls and total duration for discovery only.

Discovery must:

1. derive requirements from owner materials;
2. scan bounded batches and save exact dialogue/event observations;
3. find recurring candidate behavior;
4. open full representative examples plus controls;
5. verify the candidate against the owner requirement;
6. return one saved hypothesis or honestly report insufficient evidence.

Counts are selection evidence, not production accuracy. Do not describe the batch as an accuracy measurement.

Show the saved discovery brief exactly. A ready brief includes `НАБЛЮДЕНИЕ: ответ агента (reply)`, exact citations and literal `Проверим?`. Require an explicit owner answer. On «да», immediately call `agent_lab_build` again with `mode:"discover"`, the exact returned `fromRunId`, and the exact returned `hypothesis`. The core re-reads the saved run and builds exactly that one test; do not ask for source IDs, quotes, or another technical confirmation round. On refusal or correction, build nothing and continue from the owner's feedback. Never invent a hypothesis from an insufficient, partial, exhausted or failed discovery.

The built test is still a draft. Show it in full, then use `agent_lab_accept` for the owner's separate decision. Acceptance does not run the agent.

## Start from the local project

- Reuse the agent's real callable entry point. Prefer a local `command` or compatible `module`; use `http` only when that is the actual available target. If a wrapper is required, write the smallest adapter around the real agent.
- Preserve session state between turns and reset it between test dialogues. For a command target, keep protocol JSON on stdout and diagnostics on stderr.
- Do not replace the owner's agent with a scripted echo. A deterministic built-in example may demonstrate mechanics only and must remain labelled as such.
- Collect relevant policies and knowledge as materials with original names and exact contents. Pass the agent prompt as `kind:"prompt"` only so observable user-facing rules can become requirements. Never promote implementation behavior to business truth.
- Profiles must be supplied explicitly by the owner; log evidence never creates persona fields.
- Keep secrets out of materials. HTTP headers name environment variables; never persist their values.
- Static preflight may check paths, executability and required environment variable names. Do not send a probe request before explicit execution consent.

## One editable test from discovery

Build exactly one test from the accepted discovery handoff. The test must be executable and internally consistent:

- the opening, known facts, forbidden knowledge and clarification answers agree;
- `maxFollowUps` is sufficient for promised replies and no larger than needed;
- exact checks assert only literal or observable conditions;
- semantic rubrics each describe one failure mechanism and state clear pass and fail conditions;
- action success uses trusted state or complete tool events; a textual claim is not proof;
- missing observation yields `unknown`, never a forced pass or fail;
- every business expectation points to a requirement quote.

Let the owner correct the draft in ordinary language. After a correction, show the complete new definition and hash again. Never accept on the owner's behalf or treat «run it» as retroactive acceptance of an unseen test.

## Real run and proof

For the one-test discovery flow, use `agent_lab_run` only after the owner explicitly accepted the displayed test and asked to execute it. Existing multi-test validation/regression suites use their separate run-plan confirmation; one-test acceptance metadata is not their execution gate. Show the exact target, version identity when available, one user mode, planned dialogue count and limits in native confirmation.

Open a real `TargetSession` for the test. Afterwards show, in this order:

1. the full user/agent dialogue;
2. observable tool events and final state;
3. each deterministic check and its evidence;
4. each judge rubric with `pass`, `fail` or `unknown` and exact event citations;
5. every `simulatorChecks` suspicion beside the dialogue event it cites;
6. one bounded conclusion and its limitations.

Never hide an invalid, cancelled, missing or unknown attempt inside an aggregate. An adapter's reported records are labelled reported state, not independently trusted observation. Without `resetConfirmed` or complete in-scope events, corresponding action claims remain unmeasured.

## Judge and optional human review

Objective predicates belong in code. A semantic judge sees one rubric at a time and must cite the unchanged trace. Two fresh calls must agree and be non-contradictory for a decisive result; otherwise return `unknown`.

Judge repeatability and reliability are not measured in the MVP. Two agreeing calls are a conservative decision rule, not validation. Do not claim judge quality from agreement, sample count or saved reviews.

Human review is optional. Ask for it only for a disputed result, `unknown`, a simulator suspicion, or explicit spot-checking. A human note attaches to the concrete trial and criterion; it never rewrites the original trace or automatic assessment. Never invent a human verdict.

## Save, repeat and compare

Use `agent_lab_suite` to save a useful test or an existing multi-test validation/regression set as a versionable suite. Saving preserves tests, exact acceptance metadata where present, requirements, provenance, target definition and settings, but clears results and execution approval. Never overwrite an existing suite file.

Load or repeat the same test after an agent change, run it through the real target, then compare the two runs. Report per-test changes:

- `fixed`: decisive fail became decisive pass;
- `regressed`: decisive pass became decisive fail;
- unchanged: the decisive result stayed the same;
- `incomparable`: tests, requirements, mode, settings, judge protocol or usable evidence differ.

Missing, invalid and unknown pairs stay visible and never count as fixes. A model-judged improvement remains provisional. Do not change the test to make a candidate look better.

## Completion rule

Do not stop at generated cards. The primary useful outcome is a reviewed validation set, a real run, estimated card accuracy with unknowns kept separate, grounded causes, and a saved suite that can be repeated. For supplemental discovery, finish the traceable chain from requirement and log evidence to one accepted regression test and its real dialogue.
