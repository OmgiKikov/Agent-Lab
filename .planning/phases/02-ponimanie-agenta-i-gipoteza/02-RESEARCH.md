# Phase 2: Понимание агента и гипотеза — Research

**Researched:** 2026-09-15
**Domain:** Offline recorded-dialogue ingestion, evidence-grounded assessment, and conversational hypothesis proposal
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

### Sources of truth
- Owner requirements, specs and explicitly supplied materials define expected behavior.
- Existing code, previous agent answers and logged outcomes are observations only; they may be wrong and must never silently become the expected answer.
- Every summary must visibly separate `Требования`, `Наблюдаемое` and `Неизвестно`.
- Claims about completed actions count only when an observable effect exists; otherwise the action remains `unknown`/`unclear` even if the agent says it succeeded.

### Imported evidence
- Reuse the existing JSON/JSONL reader, dialogue, scenario, trial and trace-event contracts instead of introducing a second ingestion model.
- Preserve each recorded dialogue one-to-one and keep source event order.
- Score mode never runs the target agent or simulator; `--code-only` must also avoid model calls.
- Response quality is evaluated separately from goal attainment and observable action effects.

### Hypothesis proposal
- Propose exactly one useful hypothesis at a time, before building a test.
- The proposal names the requirement and the concrete repository/log observation that motivated it, then asks the owner: `Проверим?`
- Logs are evidence for choosing a hypothesis, not automatically accepted ground truth or a mandatory manual-labeling queue.
- No new persisted hypothesis workflow is needed in this phase; use the existing conversation/skill surface and existing experiment contracts until the owner confirms the hypothesis.

### Product surface
- Keep CLI, Pi extension and skill behavior aligned around the same offline score and evidence path.
- The first useful output is compact and conversational, not a report dashboard: expected/current/unknown followed by the proposed check.
- Detailed cards, failure clusters and exported artifacts remain available as supporting evidence, not the primary interaction.

### the agent's Discretion
- Exact Russian copy, compact formatting and placement inside existing CLI/Pi surfaces.
- The smallest internal helper boundaries needed to keep conversion and scoring testable.

### Deferred Ideas (OUT OF SCOPE)
- Building and owner-editing the test belongs to Phase 3.
- Running the accepted test on the real target and displaying proof belongs to Phase 4.
- Saving and rerunning the accepted test as a regression belongs to Phase 5.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LOOP-01 | Agent Lab изучает репозиторий, явные требования и доступные логи и кратко разделяет ожидаемое поведение, текущее наблюдение и неизвестное. | Keep this as a conversation/skill presentation contract; do not add persistence. |
| LOOP-02 | Ожидание для теста выводится из требований и материалов владельца; существующий код, ответ агента и сохранённый outcome используются только как наблюдение, а не как эталон. | Ground requirements through existing source quotes; expose only user turns plus supplied materials to goal/criterion extraction. |
| LOOP-03 | До построения теста Agent Lab предлагает конкретную гипотезу о сбое, называет её основание и спрашивает, стоит ли её проверить. | Surface one requirement/observation pair ending with `Проверим?`; leave test construction to Phase 3. |
| SCORE-01 | Пользователь может передать обезличенные записанные диалоги в JSON или JSONL вместе с задачей и материалами. | Reuse `readData(file, 'dialogues')` and `createInputSchema`. |
| SCORE-02 | Каждый записанный диалог становится одной production-карточкой и одной scripted-попыткой со всеми событиями в исходном порядке и всеми последующими репликами пользователя. | Add pure dialogue-to-scenario and dialogue-to-trial converters beside the contracts. |
| SCORE-03 | При импорте записанных диалогов агент и симулятор не вызываются, наблюдение состояния отмечается как missing, инструменты как partial, а `user_fidelity` и `simulatorChecks` не применяются. | Build stored trials directly; do not enter `runSuite` or call `openTarget`/`userTurn`. |
| SCORE-04 | Production-карточка записанного диалога получает `goal_attainment` и независимую `reply_quality`, а при переданном промпте — также `prompt_compliance`. | Add two reserved rubric constants and reuse existing `promptCompliance`. |
| SCORE-05 | Цель и критерий записанного диалога заземляются в переданных материалах и репликах пользователя; ответ агента и сохранённый outcome не используются как эталон правильности. | Pass sources into the existing goals role and test that assistant turns/outcome cannot influence criteria. |
| SCORE-06 | Если результат действия не наблюдался, заявление агента о выполнении не считается доказательством: `goal_attainment` остаётся `unknown`/`unclear` по протоколу судьи 8, а качество ответа оценивается отдельно. | Preserve hidden final state, add the explicit unobserved-action scope, and version the judge protocol. |
| SCORE-07 | `reassess` оценивает импортированные трассы и заново строит кластеры провалов; `--code-only` не вызывает модель и не строит кластеры. | Compose the existing reassessment loop and `nameFailureModes`; keep the runtime absent in code-only mode. |
| SCORE-08 | `agent-lab score --input ... --task ... --yes` и `agent_lab_build` с `mode: "score"` выдают первый экран и пути артефактов оценённой записи; Pi-путь запрашивает подтверждение перед расходом на судью. | Add thin CLI/Pi adapters over `ExperimentLab.score` → `reassess` → existing quality/artifact helpers. |
</phase_requirements>

## Summary

The phase needs one new domain conversion seam and one new orchestration method, not a new evaluation subsystem. `readData()` already parses JSON/JSONL and validates each dialogue; `Dialogue`, `Scenario`, `Trial`, trace events, rubric assessments, persistence, reports, and first-screen quality are already owned by existing modules. [VERIFIED: src/imports.ts:1-13; src/contracts.ts:165-193,232-264,391-412; src/artifacts.ts:10-81; src/quality.ts:27-43]

Implement scoring as an immutable two-record flow: an imported evidence seed containing one production scenario and one scripted trial per dialogue, followed by the existing `reassess()` path that computes assessments over copied traces. This preserves the current “new interpretation, same facts” contract: reassessment creates a fresh record, copies ordered events, hides missing state from the judge, and never opens a target session. [VERIFIED: src/experiment.ts:281-347; src/judge.ts:38-49; test/workflow.test.ts:203-237]

The conversational understanding/hypothesis is deliberately not a stored entity. Update the existing Pi system prompt and `skills/agent-builder/SKILL.md` so the first reply visibly presents `Требования`, `Наблюдаемое`, `Неизвестно`, then one requirement-backed observation and `Проверим?`. Detailed scoring and failure clusters remain supporting evidence. [VERIFIED: .planning/phases/02-ponimanie-agenta-i-gipoteza/02-CONTEXT.md:17-42,61-65]

**Primary recommendation:** Add pure converters in `contracts.ts`, an offline `ExperimentLab.score()` that seeds existing records, then expose the same `score → reassess → evidenceBundle/exportArtifacts` composition through CLI and Pi; keep hypothesis selection in the existing conversation/skill contract.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| JSON/JSONL import and validation | CLI/Pi adapter | Domain contracts | Adapters resolve the owner-selected file; `readData` and Zod validate it. [VERIFIED: src/cli.ts:35-43,182-189; extensions/agent-lab.ts:142-180; src/imports.ts:1-13] |
| One-to-one dialogue conversion | Domain contracts | — | It is a pure mapping between existing `Dialogue`, `Scenario`, `Trial`, and `TraceEvent` shapes. [VERIFIED: src/contracts.ts:232-264,391-412] |
| Offline score lifecycle | Application orchestration (`ExperimentLab`) | Persistence | `ExperimentLab` owns record construction, phase transitions, trace journaling, and mutations. [VERIFIED: src/experiment.ts:17-25,66-109,449-484] |
| Requirements/criterion grounding | Model runtime role | Domain validation | `Runtime.goals` already accepts sources/dialogues/profiles; `validateObservedGoals` checks evidence IDs and verbatim openings. [VERIFIED: src/contracts.ts:319-347,639-648; src/experiment.ts:146-160] |
| Recorded-trace grading | Evaluation/judge | Application orchestration | `assessTrial` and `judgeInput` operate on stored scenarios and trials; reassessment coordinates them. [VERIFIED: src/evaluation.ts:290-303; src/judge.ts:38-49; src/experiment.ts:310-345] |
| Failure naming | Existing private `nameFailureModes` | Model runtime | The helper selects agent failures, passes trace evidence, validates cluster IDs/quotes, and degrades to a limitation. [VERIFIED: src/experiment.ts:585-617] |
| Compact result and artifacts | Existing quality/artifact layer | CLI/Pi adapter | Both surfaces already consume `qualitySummary`, `evidenceBundle`, and `exportArtifacts`. [VERIFIED: src/cli.ts:155-164; extensions/agent-lab.ts:56-82,391-396; src/artifacts.ts:24-81] |
| Expected/current/unknown + one hypothesis | Pi conversation/skill | Score evidence | CONTEXT explicitly rejects a new persisted hypothesis workflow. [VERIFIED: .planning/phases/02-ponimanie-agenta-i-gipoteza/02-CONTEXT.md:29-38] |

## Standard Stack

### Core

| Library/runtime | Version | Purpose | Why Standard Here |
|-----------------|---------|---------|-------------------|
| Node.js | `>=22.19.0` | ESM runtime, filesystem I/O, `parseArgs`, `node:test` | Already the package runtime contract; local environment is `v22.22.3`. [VERIFIED: package.json:5-11; `node --version` output 2026-09-15] |
| TypeScript | `^5.9.3` | Strict domain/orchestration implementation | Existing compiler configuration has `strict: true` and `noUncheckedIndexedAccess: true`. [VERIFIED: package.json:45-49; tsconfig.json:2-14] |
| Zod | `4.5.4` | Trust-boundary schemas for imports and persisted records | Already pinned and used by `readData`, dialogue, scenario, trial, and experiment schemas. [VERIFIED: package.json:39-44; src/imports.ts:1-13; src/contracts.ts:165-193,232-264,519-531,583-611] |
| Pi coding agent / TypeBox | `0.85.1` / `1.3.7` | Existing model runtime and Pi tool schema | Already pinned by the project and used by the extension; no new UI/tool framework is needed. [VERIFIED: package.json:39-43; extensions/agent-lab.ts:138-180] |

### Supporting

| Facility | Version | Purpose | When to Use |
|----------|---------|---------|-------------|
| `node:test` + `tsx` | built-in / `^4.20.0` | Contract, orchestration, CLI, and Pi integration tests | Add focused cases to existing test files; do not create a second test runner. [VERIFIED: package.json:30-37,45-48; test/contracts.test.ts:1-6] |
| Existing quality/report/artifact helpers | in-repo | Same first screen and evidence paths across CLI/Pi | Reuse after reassessment; do not build a score-only presenter. [VERIFIED: src/artifacts.ts:24-81; extensions/agent-lab.ts:56-82] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Existing contracts and reassessment | Third-party agent-evaluation framework | Explicitly out of scope and would duplicate validation, persistence, judging, and reporting. [VERIFIED: .planning/REQUIREMENTS.md:28-37; Out of Scope table entry “Third-party agent-evaluation frameworks”] |
| Existing `node:util.parseArgs` dispatch | New CLI parser | Adds a dependency for one option and one command branch; official Node docs already support typed options and positionals. [CITED: https://nodejs.org/api/util.html#utilparseargsconfig] |
| Existing `z.strictObject` schemas | Ad-hoc shape checks | Loses the repository’s uniform rejection of unknown input fields. [CITED: https://zod.dev/api#strict-objects] |

**Installation:** none. This phase should add no package and therefore requires no package-legitimacy gate.

## Architecture Patterns

### System Architecture Diagram

```text
Owner-selected task/materials + JSON/JSONL dialogues
                         │
             CLI `score` / Pi `mode: score`
                         │
                         ▼
            readData + createInputSchema
                         │
                         ▼
                ExperimentLab.score
                 ├─ prepare grounded requirements from materials
                 ├─ extract one goal/criterion per dialogue
                 ├─ dialogue → production Scenario (pure)
                 └─ dialogue → scripted Trial (pure, ordered events)
                         │
                         ▼
          immutable imported evidence seed record
                         │
              ┌──────────┴──────────┐
              │                     │
          reassess()           reassess(codeOnly)
              │                     │
        existing judge         exact checks only
              │                     └─ no runtime / no clusters
        nameFailureModes()
              │
              ▼
 qualitySummary + evidenceBundle + exportArtifacts
              │
              ▼
 `Требования` / `Наблюдаемое` / `Неизвестно`
 + one grounded hypothesis + `Проверим?`
```

The target-agent and simulator branches are absent from the score path; only model-backed requirement/goal extraction and optional judge/failure naming remain. “Offline” here means no target or simulator execution, not necessarily zero model calls. [VERIFIED: .planning/REQUIREMENTS.md:30-37; src/experiment.ts:281-347]

### Recommended Project Structure

Do not add directories. Touch the existing owners only:

```text
src/contracts.ts              # reserved rubrics + pure dialogue converters
src/experiment.ts             # score seed + reassessment composition
src/judge.ts                  # explicit missing-observation rule + protocol bump
src/pi.ts / src/prompts.ts    # materials-grounded goal extraction
src/cli.ts                    # thin score command
extensions/agent-lab.ts       # thin Pi score mode + native judge confirmation
skills/agent-builder/SKILL.md # three-part summary + one hypothesis protocol
test/*.test.ts                # focused additions to existing suites
```

This mapping follows current module ownership; no score-specific service, repository layer, DTO family, or dashboard is justified. [VERIFIED: .planning/codebase/ARCHITECTURE.md “Component Responsibilities”; src/experiment.ts:17-25]

### Pattern 1: Pure one-to-one conversion

Add `dialogueToScenario` and `dialogueToTrial` beside the types they transform. The scenario must take goal and success criteria as explicit arguments so the converter cannot derive expected behavior from assistant replies or stored outcomes. The trial must map `dialogue.messages` directly with its array index as event sequence; filtering is allowed only when separately building the scenario’s user `opening` and follow-up `script`. [VERIFIED: .planning/REQUIREMENTS.md:31-35; src/contracts.ts:232-264,391-412]

### Pattern 2: Seed then reassess

`ExperimentLab.score()` should construct and persist the evidence seed without calling `preflightTarget`, `openTarget`, `userTurn`, or `runSuite`. Then CLI/Pi call the existing `reassess(seed.id, options)`, which already copies traces into a fresh record and invokes `assessTrial`. [VERIFIED: src/experiment.ts:109-165,281-347,496-539]

Extract the common initial `Experiment` literal from `create()` only if both `create()` and `score()` use it unchanged. This is the smallest justified helper: duplicating the record initialization risks drift in schema-required fields and limitations. [VERIFIED: src/experiment.ts:109-133; src/contracts.ts:492-516,583-603]

### Pattern 3: One score path, two adapters

CLI and Pi should both compose `lab.score` → `lab.reassess` → existing summary/artifact helpers. CLI accepts explicit `--yes`; Pi asks native confirmation immediately before judge-backed reassessment and returns the imported seed unchanged when confirmation is declined. [VERIFIED: .planning/REQUIREMENTS.md:36-37; src/cli.ts:155-164; extensions/agent-lab.ts:374-397]

### Pattern 4: Conversation-only hypothesis

The skill/system prompt should require a compact template in the user’s language:

```text
Требования: <owner/source-backed expectation>
Наблюдаемое: <repository/log fact, with file or event reference>
Неизвестно: <missing observable effect or unresolved policy>
Гипотеза: <one failure mechanism from the requirement + observation>. Проверим?
```

Do not store this as a new hypothesis aggregate or overload `Revision.hypothesis`; Phase 2 stops before the test and the locked decision requires the existing conversation surface. [VERIFIED: .planning/phases/02-ponimanie-agenta-i-gipoteza/02-CONTEXT.md:29-38,61-72; src/contracts.ts:387,492-516]

### Anti-Patterns to Avoid

- **Calling `create()` and then treating generated production cards as the import:** `create()` may group repeated goals and generate additional scenarios; score requires one scenario/trial per recorded dialogue. [VERIFIED: src/prompts.ts:77-78; src/experiment.ts:146-160; .planning/REQUIREMENTS.md:31]
- **Using `dialogue.outcome` or assistant replies as success criteria:** both are observations, not the expected answer. Test the actual Pi goal-extraction payload, not only an injected runtime. [VERIFIED: .planning/REQUIREMENTS.md:10-12,34-35; src/pi.ts:519-528]
- **Running `runSuite` for imported traces:** it opens target sessions and can call the simulator, violating score semantics. [VERIFIED: src/experiment.ts:496-539; .planning/REQUIREMENTS.md:32]
- **Adding `user_fidelity` or `simulatorChecks` to recorded trials:** scripted imported dialogue does not exercise the reactive simulator. [VERIFIED: src/contracts.ts:170-175,194-198; .planning/REQUIREMENTS.md:32-33]
- **Treating assistant prose as proof of an action:** preserve missing observation and null final state in judge input. [VERIFIED: src/judge.ts:38-49; src/prompts.ts:56-64]
- **Persisting a hypothesis queue/workflow:** this phase asks one question in conversation and stops. [VERIFIED: .planning/phases/02-ponimanie-agenta-i-gipoteza/02-CONTEXT.md:29-38]
- **Creating a score-only report/dashboard:** current quality and artifact layers already provide the detailed evidence; the primary surface is conversational. [VERIFIED: src/artifacts.ts:24-81; .planning/phases/02-ponimanie-agenta-i-gipoteza/02-CONTEXT.md:35-38]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON/JSONL parsing | Another import module | `readData(file, 'dialogues')` | Already enforces file size, JSONL line diagnostics, item count, and dialogue schema. [VERIFIED: src/imports.ts:5-13] |
| External-input validation | Manual property checks | Existing Zod schemas | `dialogueSchema`, `scenarioSchema`, `trialSchema`, and `experimentSchema` already own boundaries. [VERIFIED: src/contracts.ts:232-264,519-531,583-611] |
| Evaluation loop | Score-specific judge client | `reassess()` + `assessTrial()` | Already preserves raw evidence, usage, judge audit, and errors. [VERIFIED: src/experiment.ts:281-347; src/evaluation.ts:290-303] |
| Failure clustering | Separate score clusterer | `nameFailureModes()` | Already selects agent failures and preserves completed runs when clustering fails. [VERIFIED: src/experiment.ts:585-617] |
| Result formatting/export | Score renderer | `qualityLines`, `evidenceBundle`, `exportArtifacts` | CLI and Pi already use these shared projections. [VERIFIED: src/cli.ts:155-164; extensions/agent-lab.ts:56-82,391-396] |
| Hypothesis persistence | Status table or hypothesis schema | Existing Pi conversation + skill | Locked decision says no new persisted workflow before owner confirmation. [VERIFIED: .planning/phases/02-ponimanie-agenta-i-gipoteza/02-CONTEXT.md:29-33] |
| CLI framework | New parser dependency | `node:util.parseArgs` | One string option and one explicit command branch fit the current CLI. [VERIFIED: src/cli.ts:1-50,129-165] [CITED: https://nodejs.org/api/util.html#utilparseargsconfig] |

**Key insight:** The phase is composition work. The only genuinely new domain logic is deterministic dialogue conversion plus the explicit reserved rubrics; everything else should route through existing orchestration, judging, persistence, and presentation.

## Common Pitfalls

### Pitfall 1: Valid imports fail above 40 dialogues

**What goes wrong:** `readData` and `createInputSchema` accept up to 200 dialogues, but `preparationSchema.scenarios` and `sourceEvidence.trials` currently cap arrays at 40. A one-to-one score path therefore fails on otherwise valid inputs above 40, either during preparation or final persistence after reassessment. [VERIFIED: src/imports.ts:12; src/contracts.ts:350-369,378-383,583-603; src/connection.ts:123-130]

**How to avoid:** Align the existing scenario/source-evidence limits with the accepted recorded-dialogue count, or explicitly lower the public dialogue limit everywhere. The locked one-to-one rule makes silent truncation invalid. Add boundary tests at 40/41 and at the chosen public maximum. [VERIFIED: .planning/phases/02-ponimanie-agenta-i-gipoteza/02-CONTEXT.md:23-27]

### Pitfall 2: Pi budget scaling creates schema-invalid settings

**What goes wrong:** `settings.maxDurationMs` is bounded at `14_400_000`, while a naive `dialogueCount * 120_000` reaches `24_000_000` at the existing 200-dialogue import maximum. [VERIFIED: src/contracts.ts:57-63; src/imports.ts:12]

**How to avoid:** Clamp the computed duration to the schema maximum or process an explicitly bounded batch; parse the final settings before starting model work. Test the largest accepted import. Do not silently truncate dialogues.

### Pitfall 3: Expected behavior leaks from logged observations

**What goes wrong:** The current Pi goals payload includes logged `outcome`; assistant replies are already filtered, but the goals prompt currently asks for “outcome as logged.” This can bias success criteria if the implementation merely adds sources without tightening the role and tests. [VERIFIED: src/pi.ts:519-528; src/prompts.ts:77-78]

**How to avoid:** Treat logged outcome only as an observation stored on the dialogue, never as criterion input. The strongest test runs the same user messages/materials with different assistant replies/outcomes and asserts identical goal/success-criterion requests. Supplied materials and user messages must be the only expectation inputs. [VERIFIED: .planning/REQUIREMENTS.md:34-35]

### Pitfall 4: Goal grouping breaks one-to-one evidence

**What goes wrong:** The existing general goals role may group repeated goals across dialogues. That is useful for synthetic coverage but incompatible with score’s required one production card and one trial per dialogue. [VERIFIED: src/prompts.ts:77-78; .planning/REQUIREMENTS.md:31]

**How to avoid:** Invoke goal extraction per dialogue in `score()` or otherwise require one result per dialogue and validate the cited ID/opening. Do not deduplicate cards by goal.

### Pitfall 5: Reassessment clusters against a changed live prompt

**What goes wrong:** `nameFailureModes()` currently reads `target.promptFile` when available. For an imported/reassessed record, that file may be missing or may contain a newer prompt than the saved evidence. [VERIFIED: src/experiment.ts:593-615]

**How to avoid:** When `record.assessmentOf` is present, cluster only from saved `record.sources` and the copied trace; do not consult the live target prompt. Preserve current behavior for ordinary live runs. Test an unavailable/changed `promptFile`.

### Pitfall 6: “Offline” is misreported as “model-free”

**What goes wrong:** Goal/requirement extraction, judge assessment, and failure naming may call models even though the target agent and simulator never run. `codeOnly` suppresses the reassessment runtime, which also suppresses judge and clusters. [VERIFIED: src/experiment.ts:310-345; src/evaluation.ts:290-303]

**How to avoid:** User copy must distinguish “агент и симулятор не запускаются” from “без модели.” Pi confirmation must precede judge spending; code-only tests must assert zero runtime/model calls and no `failureModes`. [VERIFIED: .planning/REQUIREMENTS.md:32,36-37]

### Pitfall 7: Imported events are reconstructed from the user script

**What goes wrong:** Rebuilding events from `opening`/`script` loses assistant turns and original interleaving. [VERIFIED: src/contracts.ts:211-222,259-264]

**How to avoid:** Build trial events directly from `dialogue.messages.map((message, seq) => ...)`; build the scenario script separately from user turns. Test exact event tuples and exact source order.

### Pitfall 8: Fixed reply-quality copy becomes an invented policy

**What goes wrong:** A rubric that unconditionally penalizes a redirect, tone, or format creates an expectation not present in owner materials. [VERIFIED: .planning/REQUIREMENTS.md:11,34-35]

**How to avoid:** Keep `reply_quality` independent from goal attainment but conditional on the supplied rules: clarity, completeness, executability, and absence of forbidden/internal content where the materials actually establish that rule. Do not treat style preference as goal completion.

## Code Examples

### Source-of-truth literals used by the planned converters

The existing contracts define these values verbatim: `"provenance: z.enum(['synthetic', 'curated', 'production'])"`; `"userModeSchema = z.enum(['reactive', 'scripted', 'static'])"`; `"Outcome = 'pass' | 'fail' | 'ungraded' | 'invalid' | 'cancelled'"`; and `"state: 'sandbox' | 'reported' | 'missing'; tools: 'sandbox' | 'complete' | 'partial'"`. [VERIFIED: src/contracts.ts:45-46,232-243,388-410]

### Reuse reassessment rather than a second judge loop

```ts
const seed = await lab.score(input);
await lab.waitForIdle();

const draft = await lab.reassess(seed.id, { codeOnly });
await lab.waitForIdle();
const scored = await lab.get(draft.id);
```

This mirrors the existing asynchronous lab contract: mutating operations return a snapshot while background work completes through `waitForIdle()`. [VERIFIED: src/experiment.ts:281-347; test/workflow.test.ts:203-237]

### Preserve every source event in order

```ts
const events = dialogue.messages.map((message, seq) => ({
  seq,
  type: message.role,
  text: message.content,
}));
```

The dialogue role values are exactly `"role: z.enum(['user', 'assistant'])"`, and trace event types include exactly `"'user' | 'assistant' | 'simulator' | 'tool_call' | 'tool_result' | 'error'"`. [VERIFIED: src/contracts.ts:259-264,391-394]

### Keep prompt material out of live filesystem lookup during score reassessment

```ts
const savedPrompt = record.sources.find(source => source.kind === 'prompt')?.content;
```

The source-kind contract is exactly `"z.enum(['knowledge', 'prompt'])"`; prompt sources are already saved inside the experiment record. [VERIFIED: src/contracts.ts:33-36,492-496]

## State of the Art

| Current Path | Phase-2 Path | Impact |
|--------------|--------------|--------|
| Imported dialogues help extract grouped observed goals and synthetic coverage during `create()`. [VERIFIED: src/experiment.ts:138-160; src/prompts.ts:77-78] | Score each dialogue one-to-one into a production card and scripted evidence trial. | Meets SCORE-02 without disturbing the existing preparation path. |
| `reassess()` grades copied evidence but does not call `nameFailureModes()`. [VERIFIED: src/experiment.ts:281-347] | Call the existing failure namer after judge-backed reassessment only. | Produces grounded supporting clusters; code-only remains model-free. |
| `judgeInput()` hides unobserved final state; the assessor role already says assistant prose is not proof. [VERIFIED: src/judge.ts:38-49; src/prompts.ts:56-64] | Add explicit missing-observation scope and identify the protocol as judge protocol 8. | Makes SCORE-06 visible and versioned. |
| CLI/Pi offer build and reassess separately. [VERIFIED: src/cli.ts:129-189; extensions/agent-lab.ts:138-208,374-399] | Add thin score adapters composing import, seed, reassess, and existing artifacts. | Same evidence path on both product surfaces. |
| The skill asks for logs and then prepares tests. [VERIFIED: skills/agent-builder/SKILL.md “Real dialogues at the start” and “Working protocol”] | Before test construction, show requirements/observed/unknown and ask about one grounded hypothesis. | Satisfies LOOP-01..03 without a persisted workflow. |

**Deprecated/outdated for this phase:** Treat the source plan’s Tasks 4–7 as implementation guidance, not authority. In particular, its 40-item limit mismatch, unbounded duration formula, and use of current `target.promptFile` during imported-evidence clustering need correction against the live contracts. [VERIFIED: docs/superpowers/plans/2026-09-15-mvp-cut.md:321-748; src/contracts.ts:57-63,378-383,602; src/experiment.ts:593-615]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| — | None. Recommendations are derived from locked decisions, live source contracts, official API docs, and executed baseline tests. | — | — |

## Open Questions

None block planning. The exact Russian copy and helper placement are explicitly delegated to the agent; the recommended minimal defaults are the four-line conversation template and two pure conversion helpers. [VERIFIED: .planning/phases/02-ponimanie-agenta-i-gipoteza/02-CONTEXT.md:40-42]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | build/test/CLI | ✓ | `v22.22.3` | — [VERIFIED: `node --version`, 2026-09-15] |
| npm | scripts/tests | ✓ | `10.9.8` | — [VERIFIED: `npm --version`, 2026-09-15] |
| TypeScript/tsx/project dependencies | build and test runner | ✓ | manifest-pinned | Existing install passed build/typecheck and targeted tests. [VERIFIED: package.json:39-49; executed commands 2026-09-15] |
| Model-backed Pi runtime/judge credentials | live goal extraction and score judgment | Not statically asserted | runtime-selected | `codeOnly` reassessment is the no-model fallback, but it cannot produce semantic rubric judgments or clusters. [VERIFIED: src/experiment.ts:310-345] |

**Missing dependencies with no fallback:** none detected for implementation and local tests.

**Missing dependencies with fallback:** model/provider availability is runtime configuration; code-only reassessment preserves evidence without model calls but leaves semantic criteria unassessed. [VERIFIED: src/experiment.ts:310-345]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Node `node:test`, executed through `tsx` [VERIFIED: test/contracts.test.ts:1-6; package.json:30-37] |
| Config file | none; scripts live in `package.json` [VERIFIED: package.json:30-37] |
| Quick run command | `npm run build && npx tsx --test test/contracts.test.ts test/judge.test.ts test/experiment.test.ts test/pi.test.ts test/workflow.test.ts test/extension.test.ts` |
| Full suite command | `npm test && npm run typecheck` [VERIFIED: package.json:30-37] |

The baseline typecheck and the six targeted suites passed on 2026-09-15: 135 tests, 0 failures. [VERIFIED: executed command output, 2026-09-15]

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| LOOP-01 | Three-part summary keeps requirements/observed/unknown separate | prompt/extension contract | `npx tsx --test test/extension.test.ts` | ✅, add case |
| LOOP-02 | Assistant answer/outcome cannot become expectation | runtime payload integration | `npx tsx --test test/pi.test.ts` | ✅, add case |
| LOOP-03 | Exactly one grounded hypothesis ends in `Проверим?` before build | skill/system-prompt contract | `npx tsx --test test/extension.test.ts` | ✅, add case |
| SCORE-01 | JSON and JSONL import with task/materials | unit/integration | `npx tsx --test test/workflow.test.ts` | ✅, extend case |
| SCORE-02 | One production scenario/trial per dialogue; exact order | unit | `npx tsx --test test/contracts.test.ts` | ✅, add case |
| SCORE-03 | No target/simulator calls; missing/partial; no fidelity | integration | `npx tsx --test test/experiment.test.ts` | ✅, add case |
| SCORE-04 | Reserved metrics and conditional prompt compliance | unit/integration | `npx tsx --test test/contracts.test.ts test/experiment.test.ts` | ✅, add cases |
| SCORE-05 | Criteria grounded in sources + user messages only | Pi runtime integration | `npx tsx --test test/pi.test.ts` | ✅, add case |
| SCORE-06 | Claimed action remains unclear without observation; protocol 8 | unit | `npx tsx --test test/judge.test.ts` | ✅, add case |
| SCORE-07 | Reassess regrades and reclusters; code-only has zero model calls | integration | `npx tsx --test test/experiment.test.ts test/workflow.test.ts` | ✅, add cases |
| SCORE-08 | CLI and Pi score paths, confirmation, first screen, artifacts | CLI/Pi integration | `npx tsx --test test/workflow.test.ts test/extension.test.ts` | ✅, add cases |

### Sampling Rate

- **Per task commit:** run the focused file(s) listed above.
- **Per wave merge:** run the six-suite quick command.
- **Phase gate:** `npm test && npm run typecheck` must pass before `$gsd-verify-work`.

### Wave 0 Gaps

- [ ] Add converter/reserved-rubric cases to `test/contracts.test.ts`, including 0 user turns and exact order.
- [ ] Add score orchestration and 40/41/public-maximum boundary cases to `test/experiment.test.ts`.
- [ ] Add source/user-only goal payload coverage to `test/pi.test.ts`, varying assistant reply and logged outcome.
- [ ] Add missing-observation/protocol-8 case to `test/judge.test.ts`.
- [ ] Add CLI score subprocess coverage to `test/workflow.test.ts`.
- [ ] Add Pi `mode: "score"`, missing-dialogue gate, confirmation/cancel, and prompt/skill protocol cases to `test/extension.test.ts`.

No framework or fixture bootstrap is needed; all target files and shared harnesses already exist. [VERIFIED: `rg --files test`; package.json:30-37]

## Security Domain

### Applicable ASVS Categories

The table below retains the planning template’s ASVS 4-style labels. Current ASVS 5.0 reorganizes these areas: encoding/sanitization is V1, validation/business logic is V2, authentication/session management are V6/V7, and cryptography is V11. [CITED: https://github.com/OWASP/ASVS/tree/master/5.0/en]

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No authentication mechanism is added by the locked offline-score scope. [VERIFIED: .planning/REQUIREMENTS.md:30-37] |
| V3 Session Management | no | Score must not open a target or simulator session. [VERIFIED: .planning/REQUIREMENTS.md:32] |
| V4 Access Control | yes, local boundary | Reuse `ExperimentLab` writer lock/mutation gate and user-selected file paths; do not bypass the application service. [VERIFIED: src/experiment.ts:66-108; src/store.ts:18-65] |
| V5 Input Validation | yes | Keep `readData` size limits plus strict Zod dialogue/create/experiment validation. [VERIFIED: src/imports.ts:5-13; src/contracts.ts:259-264,350-375,583-611] [CITED: https://zod.dev/api#strict-objects] |
| V6 Cryptography | no new use | Reuse existing fingerprints for evidence identity; do not invent cryptography. [VERIFIED: src/experiment.ts:27-40,300-307] |

For ASVS 5.0, apply V1/V2 controls to consistent JSON parsing, output encoding, schema validation, size/count bounds, and business invariants; no new V6/V7 authentication/session or V11 cryptographic control is introduced. [CITED: https://github.com/OWASP/ASVS/blob/master/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.flat.json]

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Prompt injection embedded in materials/dialogues | Elevation of privilege / Tampering | Existing `DATA_BOUNDARY` and assessment role treat all supplied text as evidence, never instructions; keep assistant turns out of criterion extraction. [VERIFIED: src/prompts.ts:3-21,56-64] |
| Malformed or oversized local input | Denial of service / Tampering | File-size, item-count, message-count, and content-length limits plus strict object schemas. [VERIFIED: src/imports.ts:5-13; src/contracts.ts:259-264,350-375] |
| Evidence laundering through reordered/reconstructed traces | Tampering | Direct one-to-one mapping from `Dialogue.messages` with sequence index; append to the existing journal. [VERIFIED: src/store.ts:121-137; .planning/REQUIREMENTS.md:31] |
| Live target execution during offline score | Elevation of privilege / Spoofing | Do not call preflight/runSuite/openTarget/userTurn from `score`; test injected methods throw if invoked. [VERIFIED: src/experiment.ts:496-539; .planning/REQUIREMENTS.md:32] |
| Current prompt file contaminates historical score | Tampering | Use saved source material for reassessed imported evidence; never read a changed live prompt in that branch. [VERIFIED: src/experiment.ts:593-615] |
| Invented action success from assistant prose | Spoofing | Null unobserved final state and instruct protocol 8 to return unclear for action-dependent goals. [VERIFIED: src/judge.ts:38-49; src/prompts.ts:56-64] |

## Sources

### Primary (HIGH confidence)

- `02-CONTEXT.md` — locked source-of-truth, import, hypothesis, surface, and scope decisions.
- `REQUIREMENTS.md` — LOOP-01..03 and SCORE-01..08 acceptance behavior.
- `src/imports.ts` — live JSON/JSONL reader and limits.
- `src/contracts.ts` — live dialogue/scenario/trial/rubric/experiment schemas and limits.
- `src/experiment.ts` — live lifecycle, reassessment, and failure-mode flow.
- `src/judge.ts`, `src/prompts.ts`, `src/evaluation.ts`, `src/pi.ts` — live judge payload, untrusted-data rules, assessment, and goal extraction.
- `src/quality.ts`, `src/artifacts.ts`, `src/report.ts` — existing first-screen and artifact projections.
- `src/cli.ts`, `extensions/agent-lab.ts`, `skills/agent-builder/SKILL.md` — existing CLI/Pi/conversation surfaces.
- Executed baseline: `npm run typecheck` and six targeted suites; 135/135 tests passed on 2026-09-15.

### Secondary (MEDIUM confidence)

- https://zod.dev/api#strict-objects — official strict-object behavior.
- https://nodejs.org/api/util.html#utilparseargsconfig — official typed `parseArgs` options/positionals behavior.
- https://github.com/OWASP/ASVS/tree/master/5.0/en — current ASVS 5.0 category structure and controls.

### Tertiary (LOW confidence)

- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — read from the live manifest/compiler configuration and exercised locally.
- Architecture: HIGH — traced concrete call sites and schemas; no external architecture recommendation is needed.
- Pitfalls: HIGH — limit mismatches and live-prompt contamination are visible in opened source-of-truth definitions.
- External API details: MEDIUM — official documentation fetched through web search because Context7/ctx7 was unavailable.

**Research date:** 2026-09-15
**Valid until:** 2026-09-22 (the codebase is actively changing during the MVP cut)
