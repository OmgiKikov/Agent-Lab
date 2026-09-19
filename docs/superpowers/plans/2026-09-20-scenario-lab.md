# Scenario Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать полный путь сценарного Agent Lab, части A–F согласованной спецификации, в существующем Pi-продукте.

**Architecture:** Версионированная библиотека компилируется в существующие Scenario и запускается существующим ExperimentLab. Контроллер пользователя, постоянные проблемы, диагностика и оценка генератора имеют отдельные модули, общие для UI и CLI. Старые прогоны читаются без изменения исторических тестов.

**Tech Stack:** TypeScript ESM, Node.js >=22.19, zod 4, Pi SDK/pi-tui 0.85.1, node:test; новые runtime-зависимости не нужны.

**Spec:** `docs/superpowers/specs/2026-09-19-scenario-lab-design.md` (включая отзыв 2026-09-20).

## Global Constraints

- Процесс работы — только Superpowers. Не запускать GSD и не редактировать его артефакты.
- Владелец дал апрув на автономную реализацию всего проекта; промежуточные согласования делегированы исполнителю.
- Пользовательские тексты на русском; идентификаторы и код на английском.
- Старые записи читаются без перезаписи, прошлые тесты не изменяются при редактировании библиотеки.
- Логи показывают наблюдавшееся поведение; требования владельца задают ожидаемое.
- Pi сохраняется; UI и CLI вызывают один и тот же интерфейс.
- Секреты и настоящие диалоги не попадают в git; локальные чувствительные файлы 0600, каталоги 0700.
- Использовать текущий writer-lock; нельзя создать второго независимого писателя.
- `npm test` и сборка запускаются ТОЛЬКО в снимке рабочего дерева: живой `dist/` удалять нельзя.
- Рабочее дерево уже содержит чужие незакоммиченные правки UI. Сохранить их; не откатывать и не перезаписывать.
- Исполнители не создают субагентов. Контроллер назначает ревью после каждой задачи.
- Одна задача реализации одновременно; контроллер выполняет независимую проверку/подготовку, не правит файлы исполнителя.

## Review Focus

1. Поздний пользовательский пересказ ответа старого агента не становится исходным знанием; Task 1/2 включают такой диалог.
2. Поддельная цитата, assistant-origin в opening/behavior, устаревший draftHash не проходят; Task 1/2 проверяют каждый отказ.
3. Сбой записи и чужой writer-lock не теряют прошлые ревизии и не мешают чтению; Task 2 включает файловые тесты.
4. Неизмеримый повтор и диагностическое вмешательство не повышают headline и не закрывают проблему; Task 5/6 включают смешанные результаты.
5. Независимые варианты одной цели, синтетические потомки и holdout не создают утечку между наборами; Task 1/7 проверяют происхождение и разбиение.

## Execution and verification

Каждая задача: минимальный наблюдаемый RED → реализация → GREEN → полный suite/typecheck в снимке → self-review → commit своих файлов → независимый task review. Команды выполняются через helper `snapshot.mjs` в workspace этого плана; он копирует текущие tracked/untracked non-ignored файлы и подключает существующий node_modules. Доказательства хранятся в отчёте задачи. Снимок не содержит `.agent-lab`.

Общий тестовый контракт: импортировать реальные экспортированные функции, собирать небольшие независимые fixtures, сравнивать с буквальными ожидаемыми значениями. Model/target transport допускает детерминированные двойники; библиотека, хранилище, контроллер и оркестрация работают настоящие.

### Task 1: Библиотека, факты и компилятор

**Files:** Create `src/scenario-contracts.ts`, `src/scenario-library.ts`, `test/scenario-library.test.ts`, `test/helpers/scenario-library.ts`.

**Ownership:** Только эти файлы. Не менять текущие `contracts.ts`, `experiment.ts`, Pi UI.

**Interfaces:**
- Standalone zod schemas/exported inferred types `ImportBatch`, `BusinessScenario`, `UserFact`, `ScenarioVariant`, `ScenarioLibrary`, `BehaviorPolicy`, `Checkpoint`, `LibraryPatch`, `LibraryQualityIssue`.
- `importBatch(raw: unknown): ImportBatch` accepts legacy arrays or `{dialogues:[...]}` plus versioned rich events; preserves original user/assistant/tool/retrieval/state information, checks sizes/ids, stores rejected-record reasons, computes deterministic content id.
- `createLibrary(input: {id?: string; batch: ImportBatch; sources: Source[]; requirements: Requirement[]; proposals: unknown[]; createdAt?: string}): ScenarioLibrary` validates model-produced structured proposals, groups by explicit business key and applicable requirements, stores all source dialogue references; uncertain grouping stays marked for owner review. `Source`/`Requirement` are structural existing types; runtime schema module must not import contracts.ts, avoiding a cycle when existing contracts later imports it.
- `libraryHash(library: ScenarioLibrary): string`, `libraryQuality(library: ScenarioLibrary): LibraryQualityIssue[]`.
- `editLibrary(library: ScenarioLibrary, expectedHash: string, patch: LibraryPatch): ScenarioLibrary` supports upsert/remove variants, merge/split business groups and owner fact edits, increments revision and clears acceptance; stale hash rejects.
- `acceptLibrary(library: ScenarioLibrary, expectedHash: string, variantIds: string[]): ScenarioLibrary` rejects non-ready selections, preserves excluded drafts, freezes accepted snapshot identity.
- `compileLibrary(library: ScenarioLibrary): Scenario[]` returns runnable accepted snapshot variants with user/evaluation/environment separation. Additive metadata for later integration is returned via a helper `librarySnapshot(library)` rather than altering existing schemas in this task.
- User facts have `id`, `statement`, optional `value`, `availability` initial/learned_in_source/uncertain, and discriminated `origin` (dialogue event/owner edit/synthetic operation). Citation text must match indexed source event. opening and allowed user payloads cannot introduce excluded values.
- Variants reference business group, source dialogue(s), parent and mutation reason. Checkpoints cite requirements and specify observation/required-or-diagnostic. Policies define allowed actions, finite transitions, repetition/stop limits.

- [ ] Write fixtures with requirement «Уточните номер терминала» and two conversations: user says terminal 1234; old agent says three days and user repeats that. Assertions:

```ts
assert.equal(compiled.length, 2);
assert.equal(library.businessScenarios.length, 1);
assert.deepEqual(compiled[0]!.user.knows, ['Номер терминала: 1234']);
assert.ok(!JSON.stringify(compiled[1]!.user).includes('три дня'));
assert.throws(() => editLibrary(library, 'stale', patch), /измен|хеш/i);
```

- [ ] Run focused test in snapshot; record RED for missing extraction/validation, not an unrelated syntax error.
- [ ] Implement bounded zod schemas (respect existing <=200 runnable variants, <=300 imported dialogues, <=20 facts, <=15 follow-ups), deterministic validation and pure operations. Non-initial facts remain visible but excluded from compilation; fake citations block quality. No bank-specific default.
- [ ] Add tests for semantic ambiguity retained, masked/empty entries, rich event retention, duplicates, split/merge identity, synthetic/owner provenance, changed opening leakage, chosen acceptance, revision immutability, no silent deletion and failure to compile unaccepted library. Compare against existing scenarioSchema.
- [ ] Run focused and full suite/typecheck in snapshot, self-review, commit with `feat: add versioned scenario library and grounded user facts`.

### Task 2: Полная хронология, сохранение и интеграция подготовки

**Files:** Create `src/scenario-store.ts`, `src/scenario-preparation.ts`, `test/scenario-store.test.ts`, `test/scenario-preparation.test.ts`. Modify `src/contracts.ts`, `src/pi.ts`, `src/prompts.ts`, `src/experiment.ts`, `src/store.ts`, `src/imports.ts` and relevant tests.

**Interfaces:** Consumes Task 1. Add optional `Runtime.scenarioProposals(input, ctx)` which receives indexed chronological dialogue plus requirements; returns proposals validated by Task 1. Add Experiment optional full `librarySnapshot` and original import reference. Store operations execute under ExperimentStore writer ownership; read operations need no lock. Public ExperimentLab prepare/edit/accept operations return libraries and compiled draft consistently.

- [ ] Write integration RED with transport capturing model payload and a real temporary store. Assert assistant events appear in extraction input, excluded learned facts never reach userTurn, two conversations share business id, original imported conversations remain accessible after selecting one variant.

```ts
assert.deepEqual(payload.dialogues[0].messages.map(m => m.role), ['user', 'assistant', 'user']);
assert.equal((await store.readLibrary(id)).revision, 1);
assert.rejects(() => store.writeLibrary(updated, 'stale'), /измен|хеш/i);
```

- [ ] Implement snapshot publication order (immutable library first, experiment with full copy second), atomic files/permissions, one shared lock, idempotent import; no new JSON top-level files that old store.list mistakes for experiments.
- [ ] Make validation preparation use full-history proposals and compiler. Preserve legacy Runtime callers via explicit old mode/fallback marked unverified, not fabricated source metadata. Cache keys include new extraction protocol. Preserve budgets/cancellation and report excluded/not-yet-processed cases.
- [ ] Test stale updates, reader during lock, interrupted publish, legacy parse/repeat/export, changed requirements invalidating acceptance, owner corrections with citations and partial inputs.
- [ ] Run full snapshot tests/typecheck; commit and report exact interfaces for UI.

### Task 3: Pi-путь и целевые варианты

**Files:** Create `src/scenario-variants.ts`, `extensions/scenarios.ts`, `test/scenario-variants.test.ts`, `test/scenarios-view.test.ts`. Modify `extensions/agent-lab.ts`, `extensions/cards.ts`, `extensions/flow.ts`, `src/cli.ts`, `skills/agent-builder/SKILL.md`, `README.md`, relevant tests.

**Interfaces:** `proposeVariant(library, {parentId, operation, reason, input}, expectedHash)` returns revised draft and field diff. Operations `reveal_on_request`, `missing_fact`, `ambiguous_opening`, `changed_intent`, `tool_failure` obey library quality. Tool `agent_lab_scenarios` supports inspect/edit/merge/split/variant/accept; CLI `scenarios` exposes same operations with JSON and expected hash. Existing build/run/inspect expose library identity and next action.

- [ ] Write RED for withheld fact (known but absent opening), missing fact (absent from both knowledge and clarification), changed intent with finite policy, unsupported fixture error. Assert source variant and accepted run remain unchanged.
- [ ] Implement target operations, reason/lineage, exact duplicate rejection and semantic duplicate review flag. Synthetic data is labeled; applicable requirements are rechecked.
- [ ] Render four understandable stages using current flows; group cards by business scenario, show readiness, source facts/quotes, pending decisions, selected run count and next action. Native controls support user edits and bulk acceptance; preserve existing history/cancel/back behavior. No extra mandatory per-card approval.
- [ ] Test interactive render/keys with actual UI handlers on temporary libraries. Assertions include source quote visible on disclosure, stale edit explanation, ambiguous group decision, no lost selection after back and no accidental run on accept.
- [ ] Run complete snapshot suite/typecheck. Write repeatable first-path walkthrough using a small local fixture for later independent UI acceptance; commit.

### Task 4: Контроллер пользователя и контрольные точки

**Files:** Create `src/user-controller.ts`, `src/checkpoints.ts`, `test/user-controller.test.ts`, `test/checkpoints.test.ts`. Modify `src/contracts.ts`, `src/evaluation.ts`, `src/simulator.ts`, `src/pi.ts`, `src/prompts.ts` and existing tests.

**Interfaces:** `createUserState(policy, facts)`, `allowedUserActions(state, observation)`, `advanceUser(state, decision)` validate bounded action/fact ids and transitions. Runtime chooses structured action then verbalizes only authorized data; evaluation owns controller state and trace events. Compiler emits `UserView` separately from `EvaluatorView`/fixture. Checkpoint evaluator emits pass/fail/unknown/not_applicable with requirement/event references.

- [ ] Write RED for unknown fact reference, hidden state leaking through behavior, unsupported transition, repeated clarification cap and intent shift only at declared step. Assert rejected simulator output is not sent to target.

```ts
assert.throws(() => advanceUser(state, {kind:'answer', factIds:['hidden']}), /факт|разреш/i);
assert.equal(result.trial.simulatorValid, false);
assert.equal(targetMessages.includes('secret-value'), false);
```

- [ ] Implement deterministic policy enforcement with structured candidate actions and bounded repair; account every call in shared ctx. Legacy cards retain current simulator. Use exact clarification reply when available.
- [ ] Add required/diagnostic checkpoint compilation, alternative valid paths, requirement-backed applicability and evidence channel validation. Unknown tools/state never pass by textual assertion.
- [ ] Test complete fake transport→real evaluation flow for correct refusal, wrong refusal, changed intent, insufficient turn budget, controller cancellation and evaluator isolation; full snapshot suite/typecheck, commit.

### Task 5: Постоянные проблемы и парная диагностика

**Files:** Create `src/issues.ts`, `src/diagnostics.ts`, `test/issues.test.ts`, `test/diagnostics.test.ts`. Modify store/experiment/contracts/targets, CLI and Pi results integration as needed.

**Interfaces:** `syncIssues(record, existing)` returns idempotent issues plus review suggestions; `prepareDiagnostic(issue, source, intervention, repeats)` creates immutable paired plan; `runDiagnostic(plan, runner)` uses existing target lifecycle and budgets. Diagnostic capability is explicitly declared by adapter/fixture; no assumption from log events.

- [ ] Write RED importing the same failed trial twice and assert one issue/one evidence link; new same-mechanism run adds occurrence; changed criterion does not silently merge. A diagnostics run must be excluded by observedRecord/quality headline.
- [ ] Implement persistent issue journal with exact immutable assessment references, defect/opportunity distinction, recoverable index and no rollback of completed runs when analysis fails.
- [ ] Support paired intervention for controlled fixture tool response and verified RAG fragment when adapter declares capability. One factor changes; snapshot/versions/repeats match. UI shows unsupported capability before spend. Result supports/refutes/inconclusive hypothesis with full traces.
- [ ] Test partial/cancelled pairs, missing reset, unsupported HTTP adapter, duplicated reruns, diagnostic not closing issue and read during write. Add result navigation/actions and CLI; full suite/typecheck, commit.

### Task 6: Неизменные наборы, закрытие проблем и исправления

**Files:** Create `src/resolution.ts`, `test/resolution.test.ts`. Modify `src/comparison.ts`, `src/quality.ts`, `src/prompt-edit.ts`, `src/artifacts.ts`, `src/normalize.ts`, CLI/Pi results and tests.

**Interfaces:** `ResolutionPolicy` freezes baseline/candidate, reproducer/regression identities, repeats, stability rule and rule hash before execution. `evaluateResolution(policy, before, after, regressions)` returns separate defectReproduced/candidateAcceptable results and evidence. `createFixBundle(issue, record)` exports dev-only evidence and same-suite execution instructions, then existing prompt proposal/isolated candidate pipeline handles first executable fix.

- [ ] Write literal table tests from spec §5: PPP pass; PPF fail; PPU unknown; PFU fail; PP-invalid unmeasured; PF-invalid unmeasured; missing attempt unmeasured. Include mixed provenance and group 2/2 + 10/20 =>12/22.
- [ ] Implement variant-level report slices with planned/measured counts; preserve existing meaning and positive-control exclusions; diagnostic and generator experiments remain outside main accuracy. Show provenance composition/revision change explicitly.
- [ ] Implement predeclared resolution policy, reject post-result policy changes, separate reproducer success from regression acceptance, require complete comparable evidence for closed status, reopen on usable recurrence.

```ts
assert.equal(evaluateResolution(policy, baseline, repaired, brokenRegression).candidateAcceptable, false);
assert.equal(result.issue.status, 'verifying');
assert.equal(fixBundle.controlTrials.length, 0);
```

- [ ] Connect issue→fix bundle→existing prompt proposal→same snapshot rerun→resolution UI/CLI. External code builder consumes bundle; Lab accepts candidate identity and compares without editing test/judge.
- [ ] Test version/snapshot/protocol mismatch, one successful attempt insufficiency, new synthetic cases require new baseline, original prompt unchanged and independent statistical claim restrictions. Full snapshot suite/typecheck, commit.

### Task 7: Корпус, контрольные дефекты и генератор

**Files:** Create `src/generator-evaluation.ts`, `src/generator-corpus.ts`, `test/generator-evaluation.test.ts`, `test/fixtures/generator-corpus.json`, `examples/scenario-lab-controls.mjs`. Modify Runtime/CLI/Pi tools for bounded optimization commands.

**Interfaces:** `evaluateGenerator(corpus, generator, controls, ctx)` reports dimensions and per-case errors; `selectNextVariants(candidates, history)` quality-gates before ranking; `optimizeGenerator(input, ctx)` bounds text candidates on dev then evaluates one final on holdout without feedback to proposer. Configuration/protocol hashes saved with raw feedback and usage.

- [ ] Write RED for three defective vs correct fixture modes, missed-defect and false-positive reporting, learned-fact leak, duplicate ranking exclusion, held-out feedback not reaching proposal transport.
- [ ] Build 24 explicit synthetic/anonymous examples (16 dev, 8 holdout by lineage), exact expected provenance/applicability/dedupe labels, initial developer-labeled status; include user corrections and invalid-world feedback.
- [ ] Execute controls through actual runner/checkpoint/judge seam. Keep deterministic labeled trace tests separate from model scoring; report uncertainty rather than manufacturing pass from expected labels.
- [ ] Implement multi-dimensional generator reports, baseline/candidate comparison and conservative admission; adapter takes proposal text/config candidates via current Pi runtime, persists immutable eval records and disallows automatic control-suite mutation.
- [ ] Expose commands/tool actions for evaluate/select/optimize with budgets and read-only results. Test optimizer cannot improve by failing target or revising holdout; full suite/typecheck, commit.

### Task 8: Сквозная проверка, документация и готовый результат

**Files:** `test/scenario-lab-workflow.test.ts`, `test/live/scenario-lab.ts`, README, product skill, `docs/superpowers/scenario-lab-verification.md`; targeted integration fixes in owned modules.

- [ ] Write/run real integrated end-to-end fixture with multiple conversations→group→source review→owner edit→accepted snapshot→runner→persistent issue→repeat→paired diagnosis→candidate/regression comparison→generator report. Assert actual persisted links and source immutability.
- [ ] Run complete test suite/typecheck/package dry-run from final snapshot, resolve failures and record counts/commands. Validate live Pi navigation using isolated data root, native UI/CLI path and existing configured model for bounded live run where available. No secrets in reports.
- [ ] Independent reviewer performs Task A walkthrough and broad branch review, including all integration surfaces and pre-existing UI changes preserved. Resolve Critical/Important findings with focused tests.
- [ ] Update Russian README/skill to actual commands and four-step path; add concise demo fixture/start command, quality and operational limits, snapshot version behavior, comparison aggregation examples and exact full-process evidence.
- [ ] Commit changes; final report links verification record, explains how to open product, distinguishes automatic/live/model/UI evidence and any owner-only subjective acceptance. Mark goal complete only when all implementation tasks and required technical verification are complete.
