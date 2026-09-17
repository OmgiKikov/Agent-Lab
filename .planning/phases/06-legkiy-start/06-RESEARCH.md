# Phase 6: Лёгкий старт - Research

**Researched:** 2026-09-17
**Domain:** Pi extension UX (skill + system prompt, component widget, free connection check, main-path-only wording) on the pinned Pi 0.85.1 stack
**Confidence:** HIGH for code facts (source and typings read this session; error texts reproduced). MEDIUM for the checklist step rules and the live-check method (design choices). LOW for model behaviour in the live conversation (needs the run).

## Summary

Phase 6 needs no new dependency. It has four parts, and every one of them fits an existing seam:
1. **START-01** is text: a rewritten `skills/agent-builder/SKILL.md` "start" section and a shorter system prompt.
2. **START-02** is a pure `preparationChecklist(state)` plus a Pi component-factory widget, refreshed on `tool_execution_end`.
3. **START-03** is a new free check:
   - static `preflightTarget`, then **one real agent turn** through `openExternalTarget`;
   - errors are classified by message pattern;
   - a gate runs in `agent_lab_build` (validate/live) and `agent_lab_run` **before** their native confirm dialogs.
4. **START-04** is a wording change in the system prompt, the skill, the tool and parameter descriptions, the start widget and the command description, enforced by a text test. All 11 tools stay registered.

The most important discovery: **today nothing checks that the agent is alive before money is spent.**
- `preflightTarget` is static by contract: "never imports, starts, or sends a request to the target" [VERIFIED: src/targets.ts:45].
- `doctor` needs a `probe` block (write/read/reset). The aigw connection files do not have one [VERIFIED: local/evidence/2026-09-14-demo/connection.json and lyon `.agent-lab/connection.local.json`, read this session], so `agent_lab_connection check` throws «Добавьте probe.write/read/reset…» [VERIFIED: extensions/agent-lab.ts:615].
- `lab.create` runs `preflightTarget` and then goes straight to paid model calls [VERIFIED: src/experiment.ts:295-297].

With the aigw mock down, the first sign today is a paid build followed by invalid trials.

The second discovery: **the aigw adapter reports a dead mock or service as `measurementError`**, not as a process failure.
- Reproduced with env overrides pointing at a closed port: `Ошибка измерения внешнего агента: ConnectError: [Errno 61] Connection refused`.
- The adapter reads `AGENT_LAB_TARGET_URL` and `AGENT_LAB_MOCK_URL` from env [VERIFIED: aigw-local-baseline/local/agent_lab_target.py:28-32].
- The command target spawns with `env: process.env` [VERIFIED: src/targets.ts:237].

So "mock down" can be simulated with no contact to the real mock: set both variables to a closed port in the Pi process environment.

**Primary recommendation:** Add `checkConnection(target, signal)` to `src/connection.ts` (preflight + one turn + `classifyConnectionError`). Expose it as `agent_lab_connection action=preflight`, and call it automatically at the top of `agent_lab_build` (validate/live) and `agent_lab_run`. Derive the checklist from the remembered connection, the in-session check result and the draft id from the last tool result. Render it through the Phase-4 `renderRows` in a factory widget. Move every side branch into one "Only on explicit request" section guarded by a text test.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Find prompt, adapter and logs from one sentence | Pi model + skill text (conversation) | `agent_lab_connection preflight` (validates found files, counts dialogues) | Locked: "Поиск — это работа модели в разговоре по понятной инструкции, а не новая библиотека" |
| Checklist state | `src/progress.ts` pure function | extension closure (in-session check result, last draft id) | Locked: computed from data, not stored |
| Checklist display | Pi TUI widget (`ctx.ui.setWidget` factory) | tool result text (same rows as plain text) | 10-line cap on string widgets; non-TUI modes have no widgets |
| Connection check (free) | `src/connection.ts` (`checkConnection`, `classifyConnectionError`) | `src/targets.ts` (existing `preflightTarget`, `openExternalTarget`) | Shared by tool and gate; testable without Pi |
| Spend gate | `extensions/agent-lab.ts` (build validate/live, run) | — | The native confirms live here; the gate must run before them |
| Main-path-only wording | system prompt, SKILL.md, tool/param descriptions, widget, command description | `test/start-path.test.ts` | Only text changes; code of side branches kept |

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

### Одна фраза (START-01)
- Фраза вида «проверь агента в этой папке, логи тут» запускает путь, описанный в навыке (`skills/agent-builder/SKILL.md`) и системной подсказке расширения. Lab сам:
  - находит в папке промпт агента (файлы промпта или инструкций);
  - находит точку входа или адаптер (сохранённое подключение `.agent-lab/connection.local.json`, либо известные файлы адаптера, например `local/agent_lab_target.py`);
  - находит логи (JSON/JSONL диалогов);
  - показывает, что нашёл, и ведёт к следующему шагу чек-листа.
- Поиск — это работа модели в разговоре по понятной инструкции, а не новая библиотека. В код добавляется только то, что нужно чек-листу, и проверка подключения.
- Проверяется только на `aigw-local`: поиск сильно зависит от устройства репозитория.

### Чек-лист подготовки (START-02)
- Шаги: агент → требования → логи → связь → бюджет → запуск.
- Каждый шаг помечен: ✓ пройден, ▸ текущий, ○ впереди. У текущего шага одна строка «что сделать». Глифы и цвета — из контракта экрана фаз 2–4.
- Состояние вычисляется из данных (`preparationChecklist(state)` в `src/progress.ts`) и нигде не хранится отдельно. Источники: сохранённое подключение, последний черновик (требования, диалоги, исключения, настройки, фаза) и результат проверки связи.
- Показ:
  - виджет Pi через фабрику компонента (`ctx.ui.setWidget` со своим компонентом; строковый виджет обрезается до 10 строк);
  - обновляется по `tool_execution_end`;
  - скрывается после запуска прогона;
  - тот же текст выводится в ответе инструмента.
- Ширина 40–160, текст не обрезается.

### Проверка связи до трат (START-03)
- Перед первым платным шагом (сборка набора или запуск) Lab проверяет связь с агентом бесплатно: `preflightTarget` / doctor.
- Если связи нет, пользователь видит объяснение простыми словами и следующий шаг, например: «Агент не отвечает: не запущен мок-сервер. Запустите его и повторите».
- Ни одного платного вызова, пока связь не подтверждена.
- Ошибки классифицируются по виду: процесс не запустился, таймаут, отказ соединения, неверный ответ. Для каждого вида свой текст.
- Проверка не должна останавливать настоящий мок-сервер `aigw-local`. Отсутствие связи имитируется копией подключения с закрытым портом или несуществующей командой.

### Только основной путь (START-04)
- Основной путь: собрать набор из логов → проверить ожидания → запустить → результат → согласие → повтор и сравнение → выгрузка.
- Побочные ветки убираются из системной подсказки, навыка и описаний инструментов, чтобы модель их не предлагала: поиск гипотезы (discover), одиночный тест, правка промпта, эталоны, профили, старая песочница-демо.
- Инструменты и команды остаются рабочими — по явной просьбе пользователя.
- Тест: в тексте системной подсказки и навыка нет упоминаний побочных веток как предложений; инструменты зарегистрированы.

### Проверка фазы без человека
- Юнит-тесты чек-листа и классификации ошибок связи; снимки виджета на ширинах 40–160.
- Один живой разговор в Pi на `aigw-local` с фразой из START-01 — в режиме печати или RPC, модель пользователя, до ~$1. Проверяем, что Lab нашёл промпт, адаптер и логи и остановился перед тратами. Если разговор без человека невозможен, это становится пунктом для человека.
- Имитация недоступного мок-сервера — без остановки настоящего.

### Claude's Discretion
- Формулировки шагов и подсказок, эвристики поиска в навыке, способ живой проверки разговора.

### Deferred Ideas (OUT OF SCOPE)
- Автоопределение и автогенерация адаптера (v2 START-05/06).
- Демо за минуту на встроенном примере (v2 START-05).
- Удаление кода побочных веток (v2 CLEAN-01).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| START-01 | Новичок одной фразой говорит, какого агента проверить и где логи. Lab сам находит промпт, точку входа и логи и ведёт дальше. | §START-01: aigw layout map, repo-agnostic heuristics, presentation format, `agent_lab_connection preflight` validating found files |
| START-02 | Чек-лист на экране: агент → требования → логи → связь → бюджет → запуск; галочки, текущий шаг выделен. | §START-02: `preparationChecklist` inputs/rules, widget factory API (typings read), refresh/hide lifecycle, width tests |
| START-03 | Связь проверяется до трат; ошибка объяснена, подсказан следующий шаг. | §START-03: reproduced error texts, classification table, safe simulation via env, gate placement |
| START-04 | Только основной путь; побочные ветки не предлагаются, код остаётся. | §START-04: full inventory with line numbers, rewrite rules, enforcing test, existing tests that must change |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Only Pi is the interface; the HTML report is a file. No web UI.
- TypeScript ESM, Node ≥22.19, `strict`, `noUncheckedIndexedAccess`; zod 4, typebox, Pi SDK and `pi-tui` 0.85.1. **No new runtime dependency** unless there is an explicit reason (none is needed here).
- User-facing strings and docs are in Russian; code, identifiers and commands are in English.
- Old JSON records open without migration. Do not add required fields to `experimentSchema` or `connectionSchema` (only optional ones).
- Truth comes from records and events. Anything not observed stays `unknown`; the agent's words do not prove an action.
- Bank dialogues stay local (`.agent-lab`, mode `0600`). Never commit them, and never print them in tool output or test logs.
- Workspace: other sessions are active. `npm test` and `npm run build` delete `dist/`, so run tests only via `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh`. Check `git status` and `git log` before edits.
- Agent under test: never run git in `aigw-local`, and never stop the mock (:8090) or the service (:8080). A live run costs about $2 and 6–17 minutes. The default judge is `openai/gpt-5.6-sol`.
- Naming: lowercase-hyphen files, camelCase functions, `…Schema` zod objects, `.js` import suffixes, `throw new Error(<Russian text with next step>)`.
- GSD workflow: edits only inside `/gsd-execute-phase`.

## Standard Stack

### Core (all already installed — nothing to add)
| Library / API | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ctx.ui.setWidget(key, factory, { placement })` | pi-coding-agent 0.85.1 | Checklist above the editor | A string array is cut to `MAX_WIDGET_LINES = 10` + «... (widget truncated)»; a factory `content(this.ui, theme)` is not cut [VERIFIED: pi-coding-agent/dist/modes/interactive/interactive-mode.js:1697-1729, 1773] |
| `pi.on('tool_execution_end', (event, ctx) => …)` | 0.85.1 | Refresh the checklist | `ToolExecutionEndEvent { type; toolCallId; toolName; result: any; isError }` [VERIFIED: dist/core/extensions/types.d.ts:623-629]; handler is `(event, ctx: ExtensionContext)` [VERIFIED: types.d.ts:902]; emitted with the tool `result` object [VERIFIED: dist/core/agent-session.js:547-555] |
| `ExtensionMode` / `ctx.hasUI` | 0.85.1 | Guard widget and dialogs | `"tui" \| "rpc" \| "json" \| "print"`; `hasUI` is true in TUI and RPC [VERIFIED: types.d.ts:208-215] |
| `openExternalTarget`, `preflightTarget` | repo `src/targets.ts` | One-turn ping and static checks | Existing, tested adapters; no new transport |
| `renderRows`, `GLYPH`, `Row`, `PaintTheme` | Phase 4 `extensions/render/theme.ts` (planned, `[BASE+]`) | One painter for checklist rows | 04-UI-SPEC "Theme Module" makes it the only painter; phases 5–6 must keep it [CITED: 04-UI-SPEC.md:218-236] |
| `visibleWidth`, `wrapTextWithAnsi` | pi-tui 0.85.1 | Width tests | Measured this session: `✓ ▸ ○ ● · —` are each 1 column [VERIFIED: node run of `visibleWidth`] |
| `node:test` via `tsx --test` | tsx 4.20 | Unit tests | Project standard; run only through `snap-test.sh` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| One-turn ping via `openExternalTarget` | `doctor` (3-request probe) | Needs a `probe` block that aigw connections lack; 3 turns; its own confirm dialog. Keep `check` for owners who wrote a probe. |
| One-turn ping | TCP/HTTP health GET (`:8080/health`, `:8090/mock/health`) | Adapter-specific; Lab is repo-agnostic. The skill may still tell the model to read LOCAL.md for health URLs when explaining the error. |
| Re-calling `setWidget` with a new factory on each refresh | Keep one component and mutate + `tui.requestRender()` (`TUI.requestRender(force?)` [VERIFIED: pi-tui/dist/tui.d.ts:233,338]) | Re-calling is simpler: Pi disposes the old one (`removeExisting` → `dispose`). Refresh happens only on tool ends, so there is no flicker concern. |
| `store.list()` to find the latest draft | Remember the draft id from `event.result.details.id` | `list()` parses every record (lyon `.agent-lab` holds ~15 MB of JSON) [VERIFIED: src/store.ts:106-120]; `get(id)` reads one file |

**Installation:** none.

## Package Legitimacy Audit

No external packages are installed in this phase.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| — | — | — | — | — | — | — |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Current State (read this session)

### System prompt and start widget — `extensions/agent-lab.ts`
- `session_start` (lines 162-168) runs only when `AGENT_LAB_SESSION === '1'` and in TUI. It sets the title and header, then `setWidget('agent-lab-start', [two strings])`. The second string offers «Воспроизведи эту ошибку» (single test) and «/agent-lab demo — учебный пример без модели» (sandbox demo) [VERIFIED: lines 166-167].
- `before_agent_start` (169-173) **hides** that widget on the first prompt, then appends one long English paragraph [VERIFIED: 172]. About half of it is the discover flow. It also contains "Use agent_lab_accept for the owner's decision about the test definition" and "In the one-test flow use agent_lab_run only after acceptance".
- **Phase 2 plan 02-08 rewrites the accept sentence:** «Use agent_lab_accept to show the owner what the agent must do in each situation; the owner confirms all expectations or corrects one in their own words there. agent_lab_run asks to confirm expectations first when they are not confirmed.» [CITED: 02-08-PLAN.md:240]. After Phase 2, `agent_lab_accept` is **on the main path** («проверить ожидания»). Only its one-test wording is a side branch. Phase 6 must start from the post-02-08 text.
- `/agent-lab` `new` handoff task text (764) says "Ask once for optional real dialogue logs or an explicit choice to start without them… Explain the first test".

### Skill — `skills/agent-builder/SKILL.md` (124 lines)
Main flow first; discovery is described as "a supplemental loop". Side-branch content sits in these places:
- line 11 (Discovery loop);
- line 13 ("default to one test only in supplemental discovery");
- lines 20-21 (one-test discovery display and acceptance);
- the "Real dialogues at the start" section, from «Use `mode:"discover"`…» to the end of the section;
- the section "## One editable test from discovery";
- the first paragraph of "## Real run and proof" (one-test flow);
- «Profiles must be supplied explicitly by the owner» and «A deterministic built-in example may demonstrate mechanics only»;
- "Completion rule", second sentence.

The rule «Static preflight may check paths… Do not send a probe request before explicit execution consent» conflicts with START-03 and must be reworded [VERIFIED: file read in full].

It has **no** discovery heuristics for prompt, adapter or logs beyond «inspect the repository, its run configuration, entry point, prompts…».

### Tests that pin side-branch wording (must be rewritten, not deleted)
- `test/skill.test.ts` (23 lines) slices the skill between `## Real dialogues at the start` and `## Start from the local project` and asserts 12 discover patterns [VERIFIED: lines 6-21].
- `test/extension.test.ts:45-63` asserts discover sentences and one-test sentences in the system prompt.
- `registered()` (lines 20-39) **fails on any `pi.on` name other than `session_shutdown`, `before_agent_start`, `session_start`** (`else assert.equal(name, 'session_start')`, line 33). Adding `tool_execution_end` requires updating this harness.

### aigw-local layout (listing only; no bank text printed; no git run)
| What | aigw-local-baseline (target of the demo connection) | Notes |
|------|------|------|
| Agent prompts | `src/aigw_service/agent/prompt/prompts.py`; chain prompts as `ChatPromptTemplate` in `src/aigw_service/chain/validation_chains/assistant_validation_chain.py` and `src/aigw_service/chain/generation_chains/validation_chains/internal_systems_detection_chain.py` | The validation task uses exactly these two chain files as `kind:"prompt"` materials [VERIFIED: `.agent-lab/imports/voice360-acquiring.validation-task.json` material names] |
| Owner knowledge | `local/mocks/fixtures/idp.json` → `articles[8]` with `id, breadcrumbs_markers, keywords, answer, passages` | The task's 8 `idp/*.md` materials correspond to these 8 articles [ASSUMED: names match by count; content not compared] |
| Adapter | `local/agent_lab_target.py` (executable), documented in `LOCAL.md` «## Подключение к Agent Lab» with a target JSON | The LOCAL.md JSON has **no `cwd`** and points at `aigw-local` paths |
| Python | **no `.venv` in baseline**; the working connection uses `/Users/kikov/Desktop/aigw-local/.venv/bin/python` (3.12.9) | Discovery pitfall: the model must reuse aigw-local's venv (LOCAL.md says Python 3.12+) |
| Start commands and health | `LOCAL.md` «Быстрый старт»: `./local/run-mocks.sh &` (:8090), `./local/run-app.sh &` (:8080), `curl …:8080/health`, `curl …:8090/mock/health` | Source for the "next step" text on a refused connection |
| Remembered connection | none in either aigw folder (`aigw-local/.agent-lab` holds 2 old records, no `connection.local.json`) | lyon `.agent-lab/connection.local.json` → baseline adapter, `verifiedAt` set, no `probe` |
| Dialogue logs | **not in aigw-local.** They are in lyon `.agent-lab/imports/`: `voice360-acquiring-validation-15.jsonl` (15 lines, keys `id, messages[{role, content}], outcome`), `…validation-candidates.jsonl`, `…discovery-300.jsonl` | `local/logs/*.log` are service logs (app/events/mocks), **not** dialogues; a heuristic must reject them |
| Mock "brain" | `gigachat` mode proxies to **real GigaChat** with the corp key in `local/secrets.env` [CITED: LOCAL.md «Мозг заглушки GigaChat»] | A ping turn is free for Lab/OpenRouter but makes one real GigaChat call |

Right now the mock and the service are listening (`127.0.0.1:8090`, `*:8080`). No Pi process is running, and there is no `.agent-lab/.lock` [VERIFIED: lsof/pgrep this session].

## START-01: One sentence

### Discovery heuristics for the skill (repo-agnostic, ordered)
Write these as a short numbered procedure in a new `## Start from one sentence` section, placed first after the product summary:

1. **Folders.** Take the agent folder and the logs path from the sentence; `~` and relative paths resolve against the Pi cwd. If only one folder is given, use it for both. Never search outside the named folders and the Pi cwd.
2. **Connection first.** If `<agent folder>/.agent-lab/connection.local.json` or `<cwd>/.agent-lab/connection.local.json` exists, use it and call `agent_lab_connection action=inspect`. Next, look for an adapter:
   - files named `*agent_lab*`, `*agent-lab*` or `agent_lab_target.*`;
   - README/LOCAL/docs sections that mention "Agent Lab" (they often hold a ready target JSON);
   - `examples/connection.json`-shaped files (`"format": "agent-lab-connection-1"`).

   If none exists, name the real entry point (`main`/`app`/`server` file, `pyproject` scripts, `package.json` bin/start) and say an adapter is needed. Adapter generation is out of scope (v2).
3. **Interpreter.** For a Python adapter, prefer the project's `.venv/bin/python`. If the folder has none, check the docs for another venv path. Report the interpreter and its version (`--version` only).
4. **Prompt.** Look for directories named `prompt`/`prompts`; files matching `*prompt*`, `*instruction*` or `system*.md|txt|j2|yaml`; and code files that define prompt templates (`ChatPromptTemplate`, `SystemMessage`, `system_prompt`, `role: "system"`). Exclude `test*` and `__pycache__`. List the few best files; do not paste their contents into the chat.
5. **Owner rules and knowledge.** Look for `docs/`, `knowledge/`, policy `*.md`, and fixtures with article-like records (`articles[]` with `answer`/`passages`). These become `materials`. Prompt files use `kind:"prompt"`.
6. **Logs.** Accept `*.jsonl`/`*.json` whose first record has `messages[]` with `role`/`content`. Reject `*.log`, traces, coverage, test results and `.agent-lab/*.trace.jsonl`. **Check a file only through `agent_lab_connection action=preflight dialoguesFile=…`, which returns the dialogue count. Never read or quote bank dialogues.**
7. **Found-list.** Show the result in this fixed shape (Russian, plain words, paths relative to the agent folder, one line each), then the checklist:
   ```
   Нашёл:
   Агент — local/agent_lab_target.py (Python из aigw-local/.venv)
   Промпт — src/aigw_service/agent/prompt/prompts.py и ещё 2 файла
   Правила — 8 статей базы знаний (local/mocks/fixtures/idp.json)
   Логи — voice360-acquiring-validation-15.jsonl · 15 диалогов
   Проверяю связь с агентом…
   ```
   Ask a question only when something is missing or ambiguous (two candidate adapters). Do not ask the user to confirm what was found correctly. The next step (the free connection check) starts at once, and the paid build keeps its native confirm.

### Presentation and confirmation
- Confirmation of spend is the existing native `ctx.ui.confirm('Собрать validation set?', …)` [VERIFIED: extensions/agent-lab.ts:309]. The found-list is shown before it, and the check runs before it.
- `agent_lab_connection action=preflight` accepts `{ file?, target?, dialoguesFile?, materialFiles?: string[] }`. It returns:
  - `connection` result;
  - `dialogues: { file, count }` (via `readData(…, 'dialogues', { maxItems: 300 })` [VERIFIED: extensions/agent-lab.ts:272 uses this call]);
  - `materials: [{ file, bytes }]`;
  - `checklist` text.

  It never returns file contents. This gives the model a free, code-checked way to validate what it found. It is the "only what the checklist needs" code the CONTEXT allows.

## START-02: Preparation checklist

### `preparationChecklist(state)` — pure, in `src/progress.ts`
```ts
// Source: design for this phase; types from src/connection.ts and src/contracts.ts
export type ConnectionCheck =
  | { status: 'ok'; checkedAt: string; targetKey: string; ms: number }
  | { status: 'failed'; checkedAt: string; targetKey: string; kind: ConnectionErrorKind; message: string; next: string };
export interface PreparationState {
  connection?: Connection;           // rememberedConnection(dir) or the one just used
  check?: ConnectionCheck;           // in-session result (extension closure), matched by fingerprint(target)
  found?: { dialogues?: number; materials?: number; withoutDialogues?: boolean }; // last preflight tool result
  draft?: Experiment;                // store.get(lastDraftId), only if workflow==='evaluate'
}
export type StepId = 'agent' | 'requirements' | 'logs' | 'connection' | 'budget' | 'run';
export interface ChecklistStep { id: StepId; label: string; status: 'done' | 'current' | 'todo'; value?: string; todo?: string }
export function preparationChecklist(state: PreparationState): { steps: ChecklistStep[]; current: StepId | null; hidden: boolean }
```
The `ConnectionErrorKind` values are defined in START-03.

Step rules (discretion; wording is a proposal). "Done" is evaluated in order, and the first step that is not done is `current`:

| Step | Label | Done when | Value when done | «Что сделать» when current |
|------|-------|-----------|-----------------|------------------|
| agent | Агент | `connection` present **or** `draft.target.kind !== 'sandbox'` | command basename + adapter file name | «Назовите папку агента или файл подключения» |
| requirements | Требования | `draft.requirements.length > 0` **or** `found.materials > 0` | «N правил» / «N файлов» | «Укажите промпт и правила владельца» |
| logs | Логи | `draft.dialogues.length > 0` **or** `found.dialogues > 0` | «N диалогов» (+ «исключено K» from `validationExclusions`) | «Укажите файл JSON/JSONL с диалогами» |
| connection | Связь | `check.status==='ok'` and `check.targetKey === fingerprint(current target)` | «агент ответил за N с» | failed: `check.next`; none: «Проверяю связь — это бесплатно» |
| budget | Бюджет | `draft.phase` past `review` (`reviewedAt !== null`) | «до N вызовов» from `draft.settings.maxCalls` | no draft: «Подтвердите сборку набора и её лимит»; draft in `review`: «Подтвердите план и бюджет в окне запуска» |
| run | Запуск | `draft.phase` in running phases or later | — | «Запустите проверку» |

- `hidden = true` once the draft has started (`reviewedAt !== null` or trials exist). The widget is then removed.
- A failed connection step uses tone `error` for its todo row, and no later step can be `current`.
- `withoutDialogues` must not mark logs as done. Main path only (START-04).

Rows: `checklistRows(checklist): Row[]`.
- Title row «Подготовка к проверке».
- One row per step: `GLYPH.done|current|todo` + label + (` — ` + value).
- The current step gets one extra row, «что сделать: …», at indent 2.
- Tones: done `success`, current `accent` bold, todo `muted`, failure todo `error`.
- Add `○` to `GLYPH` as a new `[P6]` entry with meaning «шаг впереди»:
  - `✓` is already «Passed / confirmed» `success`;
  - `▸` is «Selected row» `accent` [CITED: 02-UI-SPEC.md:178-190];
  - `○` is unused in the registries and measured at 1 column.
- The same rows as plain text (`rows.map(r => ' '.repeat(r.indent ?? 0) + r.text).join('\n')`) go into the tool result `content` as `checklist`.

### Widget lifecycle (Pi 0.85.1 typings)
```ts
// Source: dist/core/extensions/types.d.ts:94-100, 623-629, 902; interactive-mode.js:1697-1729
const WIDGET = 'agent-lab-start';
let lastDraftId: string | undefined; let lastCheck: ConnectionCheck | undefined; let found: PreparationState['found'];
const showChecklist = async (ctx: ExtensionContext) => {
  if (process.env.AGENT_LAB_SESSION !== '1' || !ctx.hasUI || ctx.mode !== 'tui') return;
  const dir = resolve(ctx.cwd, '.agent-lab');
  const draft = lastDraftId ? await new ExperimentStore(dir).get(lastDraftId).catch(() => undefined) : undefined;
  const view = preparationChecklist({ connection: await rememberedConnection(dir).catch(() => undefined), check: lastCheck, found, draft });
  if (view.hidden) { ctx.ui.setWidget(WIDGET, undefined); return; }
  const rows = checklistRows(view);
  ctx.ui.setWidget(WIDGET, (_tui, theme) => ({ render: (width: number) => renderRows(rows, theme, width), invalidate() {} }), { placement: 'aboveEditor' });
};
pi.on('session_start', async (_e, ctx) => { /* title + header as today */ await showChecklist(ctx); });
pi.on('tool_execution_end', async (event, ctx) => {
  if (!event.toolName.startsWith('agent_lab_')) return;
  const id = event.result?.details?.id; if (typeof id === 'string') lastDraftId = id;
  await showChecklist(ctx);
});
```
- **Remove** `ctx.ui?.setWidget?.('agent-lab-start', undefined)` from `before_agent_start`. The checklist must stay visible during the conversation.
- **Hide on run start:** in `agent_lab_run`, right after `lab.start(...)` (line 563), call `ctx.ui.setWidget(WIDGET, undefined)`. Do the same in the board's `run` branch (line 801). `hidden` also covers later refreshes.
- `details.id` exists on build, edit, repeat, run and inspect outputs (`summary()` includes `id` [VERIFIED: agent-lab.ts:84]). Inspect sets `details: { id }` [VERIFIED: 475]. Suite `load` returns `details: {}` [VERIFIED: 600], so either add `id` there or read `JSON.parse(content).id`.
- The component calls `renderRows` inside `render(width)`, so theme changes need no extra work (STACK.md, `docs/tui.md` invalidation).

### Width tests
`test/progress.test.ts`, fake theme per 04-UI-SPEC `PaintTheme`. For widths `[40, 48, 60, 80, 120, 160]` and states `{empty, agent-only, failed-connection, draft-review, started}`:
- every line has `visibleWidth(line) <= width`;
- no `…` anywhere;
- joining the stripped lines and normalizing whitespace contains every word of every step text (no truncation);
- the order of step labels is fixed;
- exactly one `▸` when not hidden.

Also check `preparationChecklist` truth tables (the table above) with plain objects, not records from disk.

## START-03: Free connection check before spend

### What errors look like today (reproduced this session)
Run: `npx tsx scratchpad/probe.mts`, calling `preflightTarget` + `openExternalTarget(...).respond('Здравствуйте')` from `src/targets.ts`, with `AGENT_LAB_TARGET_URL`/`AGENT_LAB_MOCK_URL=http://127.0.0.1:47999` (port confirmed closed; the real mock was never contacted):
```
missing-command => Не найдена команда агента: /nonexistent/python. Укажите полный путь к исполняемому файлу или добавьте его папку в PATH.
missing-adapter-file => Не найден файл агента: /tmp/nope/agent_lab_target.py. Исправьте путь в подключении.
exits-early => External agent process exited with code 1: ImportError: no httpx
timeout => External agent request exceeded 1500 ms
not-json => Ответ внешнего агента не является корректным JSON.
refused-adapter => Ошибка измерения внешнего агента: ConnectError: [Errno 61] Connection refused
```
[VERIFIED: output above; sources `src/targets.ts:41-42, 63, 251, 273, 281, 170`]

Inside `agent_lab_target.py` with the mock down:
- `protocol_reply` calls `_identity` (GET `:8080/local/agent-lab/identity`) first, then GET `MOCK_URL/mock/health` [VERIFIED: agent_lab_target.py:195-199].
- `httpx` raises `ConnectError`, and `run_protocol` turns every exception into `{"reply": "", "measurementError": "<Type>: <msg>"}` [VERIFIED: 235-236].
- The message **does not name the URL**, so "service down" and "mock down" produce the same text.
- If the service is up but the mock's upstream fails, the agent returns 5xx → `HTTPStatusError: Server error '5xx …' for url …` [ASSUMED: httpx message format, not reproduced].
- The Errno is 61 on macOS; Linux uses 111 [ASSUMED].

HTTP targets (not aigw) wrap `fetch` failures as `External agent request failed: fetch failed` (the cause code is lost) and non-2xx as `External agent responded <status>` [VERIFIED: src/targets.ts:193-196].

### Classification (`classifyConnectionError(error): { kind, message, next }`)
Match on the message; keep the raw message (≤ 300 characters, passed through `safeText`) as `detail` for the log. Show only the Russian text.

| kind | Patterns | Текст | Следующий шаг |
|------|----------|-------|---------------|
| `not_started` | `^Не найден`, `^Нет права`, `^Нет доступа`, `Cannot start external agent`, `не является папкой` | «Агент не запускается: <первое предложение исходного сообщения>.» | «Исправьте путь в подключении и повторите проверку.» |
| `exited` | `External agent process exited` | «Процесс агента завершился сразу после запуска.» + stderr tail ≤ 200 | «Проверьте окружение агента (интерпретатор, зависимости) и повторите проверку.» |
| `timeout` | `exceeded \d+ ms`, `Connection probe exceeded` | «Агент не ответил за N с.» | «Проверьте, что сервис агента запущен и не завис, и повторите проверку.» |
| `refused` | `Connection refused`, `ECONNREFUSED`, `ConnectError`, `fetch failed` | «Агент не отвечает: отказ соединения. Обычно это значит, что не запущен сервер агента или его заглушки (мок-сервер).» | «Запустите их — команды обычно есть в README или LOCAL.md проекта — и повторите проверку.» |
| `bad_reply` | `не является корректным JSON`, `does not match the contract`, `responded \d{3}`, `HTTPStatusError`, `длиннее 200 000`, `превышает 200 000`, other `Ошибка измерения внешнего агента` | «Агент ответил, но не так, как ждёт Lab.» | «Проверьте адаптер: одна JSON-строка с полем reply на каждый запрос.» |
| `config` | `Не задана переменная окружения`, zod errors from `readConnection` | «В подключении не хватает настройки: …» | «Задайте её и перезапустите Pi.» |
| `unknown` | anything else | «Связь с агентом не подтверждена.» | «Покажите ошибку разработчику агента; проверка повторяется бесплатно.» |

`refused` must be tested **before** `bad_reply`, because the aigw form wraps it in «Ошибка измерения внешнего агента». Unit tests use the six reproduced strings above verbatim, plus the HTTP strings.

The model adds the project-specific step from LOCAL.md («./local/run-mocks.sh &»). The skill says: "On a refused connection, read the project's README/LOCAL docs for start commands and name them."

### `checkConnection(target, signal)` in `src/connection.ts`
```ts
// Source: src/targets.ts openExternalTarget/preflightTarget (read this session)
export async function checkConnection(target: Target, signal: AbortSignal): Promise<ConnectionCheck> {
  const targetKey = fingerprint(target); const started = performance.now(); const checkedAt = new Date().toISOString();
  if (target.kind === 'sandbox') return { status: 'ok', checkedAt, targetKey, ms: 0 };
  try {
    await preflightTarget(target);
    const timeoutMs = Math.min(target.timeoutMs ?? 60_000, 120_000);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs + 5_000)]);
    const session = await openExternalTarget({ target, sessionId: `connection-${randomUUID()}`, scenarioId: 'connection-check',
      state: { records: {} }, history: () => [], ctx: { signal: combined, timeoutMs, beforeCall() {}, addUsage() {} } });
    try { const reply = await session.respond('Здравствуйте'); if (!reply.trim()) throw new Error('Ответ внешнего агента не является корректным JSON.'); }
    finally { await session.close(); }
    return { status: 'ok', checkedAt, targetKey, ms: Math.round(performance.now() - started) };
  } catch (error) { return { status: 'failed', checkedAt, targetKey, ...classifyConnectionError(error) }; }
}
```
- Check the exact `World`, `CallContext` and `ExternalTargetInput` shapes in `src/contracts.ts` / `src/targets.ts:146-153` at implementation time. The `state`/`ctx` literal above is [ASSUMED] beyond the fields shown in `ExternalTargetInput`.
- The command target uses `target.timeoutMs` for each request (`src/targets.ts:273`), so aigw's configured 180 000 ms is the effective per-turn limit. Either pass a copy with `timeoutMs` capped, or accept up to 180 s.
- An empty `reply` counts as failed. The aigw error path returns `reply: ""` together with `measurementError`, and that is thrown first anyway.
- Never persist or display the reply text (it can contain bank-like data). Store only `ms`.
- A `promptFile` target also requires `promptHash` attestation (`src/targets.ts:319-325`), so the ping also checks that the adapter applies the prompt. That is correct behavior.
- On `ok`, call `rememberConnection(dir, connection)` (sets `verifiedAt`, mode 0600, keeps `probe`) [VERIFIED: src/connection.ts:60-69].

### Gate placement (every paid step, before any native confirm)
| Entry | Spends? | Needs agent? | Gate |
|-------|---------|--------------|------|
| `agent_lab_build` mode `validate` | yes (requirements, cards) | later | **yes**: after dialogues parse (line ~303), before `ctx.ui.confirm('Собрать validation set?')` (309) |
| `agent_lab_build` mode `live` (no demo) | yes | later | **yes**: before `lab.create` (434) |
| `agent_lab_run` | yes | yes | **yes**: after the hash check (558), before `confirm('Запустить проверку?')` (559) |
| board `run` action | yes | yes | **yes**: before its confirm (800) |
| `score`, `discover`, `reassess`, `demo` | score/discover/reassess yes | **no** (recorded evidence) | no gate; they never open the target |
| `repeat`, `suite load/save`, `edit`, `inspect`, `accept` | no | no | no |

On failure, **return** (do not throw) `{ status: 'connection_failed', kind, message, next, checklist, agentRun: false, calls: 0 }`. That gives the model the Russian text to show and lets `tool_execution_end` refresh the checklist with the red step.

Freshness: always re-check at each gated entry. A run's first paid call can happen minutes after the build, and the mock may have died. Skip the ping only when `lastCheck` is `ok` for the same `targetKey` within the last 2 minutes [ASSUMED threshold].

Consent: a single ping to a **new or changed** target (fingerprint differs from the remembered connection) asks a native confirm in TUI:
- «Проверить связь с агентом? · один бесплатный запрос» + the exact command;
- this replaces the skill line that forbids probes before consent.

A remembered target, and non-TUI modes, ping without a dialog [ASSUMED policy — see A3].

### Simulating "mock down" safely
- **Env override (preferred, aigw-specific):** start the test process (or Pi) with `AGENT_LAB_MOCK_URL=http://127.0.0.1:<closed>` **and** `AGENT_LAB_TARGET_URL=http://127.0.0.1:<closed>/x`. The adapter inherits `process.env` and never contacts :8080 or :8090 (reproduced above). Pick the port with `lsof -nP -iTCP:<port> -sTCP:LISTEN` returning nothing (47999 was closed).
- **Connection copy:** write a temp `connection.json` with `command: '/nonexistent/python'` (→ `not_started`) or `args: ['-c', 'import time; time.sleep(30)']` with `timeoutMs: 1500` (→ `timeout`).
- Unit tests must not depend on aigw. Use small inline `python3 -c`/`node -e` targets like the existing `test/targets.test.ts` style, plus the verbatim strings for pure classification tests.

## START-04: Main path only

### Inventory (current HEAD line numbers; re-locate after Phases 2–4 land)
| Where | Side-branch text | Action |
|-------|------------------|--------|
| `extensions/agent-lab.ts:172` system prompt | discover sentences (6), "decision about the test definition", "one-test flow … only after acceptance", "multi-test … not one-test acceptance metadata" | Rewrite as the main path (logs → validate → confirm expectations via `agent_lab_accept` (02-08) → `agent_lab_run` → result → human agreement → repeat/compare → export). Add **one** sentence: «Other tools and modes (discover, score, prompt changes, golden cases, profiles, demo) run only when the user explicitly asks for them by name; never suggest them.» |
| `:166-167` start widget | «Воспроизведи эту ошибку», «/agent-lab demo — учебный пример без модели» | Replaced by the checklist |
| `:177` `agent_lab_build` description | «mode=discover mines…», «mode=score…», «mode=demo is the built-in example» | «Use mode=validate. Other modes only on the user's explicit request.» |
| `:185, 190, 193, 194-196` param descriptions | `goldenFile`, `goldenCases`, `profiles`, `fromRunId`/`resumeRunId`/`hypothesis` ("discovery"), `notes` ("synthetic cards") | Prefix each with «Only when the user explicitly asks: …» (keep params) |
| `:186` `withoutDialogues` | offers starting without logs | «Only when the user explicitly refuses to give logs.» The skill stops offering «можно без них» |
| `:483` `agent_lab_edit` patch description | `profileEdits…` | Same explicit-only prefix |
| `:500` `agent_lab_accept` | «one-test definition» | After 02-08: «Show what the agent must do in each situation and record the owner's confirmation or correction.» |
| `:654` `agent_lab_review` | «use agent_lab_prompt for a requested fix» | Remove the sentence |
| `:687` `agent_lab_prompt` | whole tool | Prefix: «Only when the user explicitly asks to change the agent's prompt.» Keep registered |
| `:717` command description | «/agent-lab demo» | «Проверить агента: /agent-lab или /agent-lab /путь/к/проекту» (the `demo` arg keeps working) |
| `:764` `new` handoff task | «explicit choice to start without them», «Explain the first test» | Main-path wording |
| `extensions/cards.ts:433, 459` board empty state | «d — учебный пример без провайдера», «d  Учебный пример за минуту» | Remove the hint text; keep key `d` (coordinate with Phase 4, which rewrites the board) |
| `SKILL.md` | lines 11, 13, 20-21; discover paragraphs; "## One editable test from discovery"; one-test paragraph of "Real run and proof"; profiles and built-in example sentences; completion rule sentence 2; «Можно указать файл JSON/JSONL или начать без них» | Move all discover and one-test rules, unchanged in substance, into a final section `## Only on explicit request`. It opens with «Never suggest these. Use them only when the user asks by name.» Delete the profile and demo offers. The first question becomes «Где лежат реальные диалоги с агентом (JSON/JSONL)?» |

### Enforcing test — `test/start-path.test.ts`
```ts
const SIDE = /discover|hypothesis|Проверим\?|one-test|one editable test|agent_lab_prompt|golden|profile|demo|sandbox|built-in example|without (them|dialogues|logs)|без них|без логов|воспроизведи/i;
const EXPLICIT = /only (when|on) the user('s)? explicit|explicitly asks|never suggest/i;
// 1. SKILL.md: text before '## Only on explicit request' has no SIDE match; that section exists and matches /never suggest/i.
// 2. System prompt from beforeAgentStart (AGENT_LAB_SESSION=1): every sentence matching SIDE also matches EXPLICIT; exactly one such sentence.
// 3. Every registered tool: split description + JSON.stringify(parameters) descriptions into sentences; each SIDE sentence matches EXPLICIT.
// 4. [...tools.keys()].sort() deepEquals the 11 names: agent_lab_accept, _build, _connection, _edit, _inspect, _prompt, _reassess, _repeat, _review, _run, _suite.
// 5. Command description has no SIDE match; the /agent-lab handler still accepts 'demo' (existing tests cover it).
```
- `mode` enum literals (`'discover'`, `'demo'`) sit in `const` schema values, not in `description`. Check only `description` strings: walk the schema object and collect `description` keys.
- Rewrite `test/skill.test.ts` to slice `## Only on explicit request` (the discover assertions keep their meaning).
- Rewrite `test/extension.test.ts:45-63` to assert the main-path sentences plus the single explicit-only sentence. The discover-flow tests (`:137+`) stay: the code is unchanged.

## Live conversation check (feasible headless)

**Feasibility:**
- Pi 0.85.1 supports `--mode json` (JSON event lines), `-p` and `--mode rpc` [CITED: pi-coding-agent/docs/usage.md:174-176, json.md].
- The launcher pattern is already in `src/cli.ts:54-56`: `node <pi>/dist/bundle/cli.js --no-extensions --no-skills -e extensions/agent-lab.ts --skill skills/agent-builder/SKILL.md`, with `AGENT_LAB_SESSION=1`.
- `pi` is **not** on PATH, so use the bundle path (`node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`, present).
- The user's default model is `openai-codex/gpt-5.6-sol` [VERIFIED: ~/.pi/agent/settings.json keys `defaultProvider`/`defaultModel`].
- In json/print mode `ctx.mode !== 'tui'`, so `agent_lab_build validate` throws «нужен native Pi confirmation» **before `lab.create`** [VERIFIED: extensions/agent-lab.ts:306]. The run cannot spend on Lab models even if the model tries.
- The widget cannot be seen in json mode. Capture it with tmux instead (below).

**Method** (script `.planning/phases/06-legkiy-start/live-start-check.sh`, run after execution):
1. Preflight, as in 02-03:
   - `pgrep -fl 'dist/bundle/cli.js'` prints nothing;
   - `test ! -e lyon/.agent-lab/.lock`;
   - no 01-12/02-03 live run is in progress, because the "up" case sends one real turn to the shared service.
2. `SNAP=$(snap-test.sh --keep test/progress.test.ts | sed -n 's/^SNAP=//p')`. This builds the snapshot's own `dist/`; the worktree `dist/` is never touched.
3. `WORK=$(mktemp -d)`, an empty cwd, so there is no remembered connection and discovery is forced.
4. **Down case (START-03, zero contact with the real agent):**
   ```bash
   cd "$WORK" && AGENT_LAB_SESSION=1 AGENT_LAB_MOCK_URL=http://127.0.0.1:47999 AGENT_LAB_TARGET_URL=http://127.0.0.1:47999/x \
   timeout 900 node "$SNAP/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" --no-extensions --no-skills \
     -e "$SNAP/extensions/agent-lab.ts" --skill "$SNAP/skills/agent-builder/SKILL.md" --no-session --mode json \
     "проверь агента в ~/Desktop/aigw-local-baseline, логи в /Users/kikov/conductor/workspaces/conductor-playground/lyon/.agent-lab/imports/voice360-acquiring-validation-15.jsonl" \
     > "$EVID/down.jsonl"
   ```
5. **Up case:** the same command without the two env overrides → `up.jsonl`, in a fresh `$WORK`.
6. Assertions (a node script over the JSON lines, printing only tool names, arg paths, kinds and costs, never message content except the final assistant text grep):
   - `tool_execution_start` events include reads/greps under `aigw-local-baseline`;
   - the final assistant text (from `agent_end.messages`) contains `agent_lab_target.py`, one of `prompts.py|assistant_validation_chain.py`, and `15` next to «диалог»;
   - `agent_lab_connection` with `action: 'preflight'` ran;
   - down: result `kind === 'refused'`, and the final text contains «отказ соединения» or «не отвечает» plus a start command hint;
   - up: result `status: 'ok'`;
   - no `agent_lab_run` event; any `agent_lab_build` is `isError` with «native Pi confirmation» (up case) or absent (down case, gate returned);
   - `ls "$WORK/.agent-lab"/*.json` finds no experiment record (only `connection.local.json` in the up case);
   - the sum of `usage.cost.total` over assistant `message_end` events is ≤ 1.00.
7. **Widget (START-02) without a human:**
   - `tmux new-session -d -x 80 -y 40` with the same command minus `--mode json`, `AGENT_LAB_SESSION=1` and env overrides;
   - `send-keys` the sentence + Enter, wait until the pane shows «Связь»;
   - `tmux capture-pane -p` → `widget-80.txt` (repeat at `-x 40` and `-x 160`);
   - assert `✓`, `▸` and the step labels appear;
   - `capture-pane -e` keeps colors for the record.

   This is interactive TUI driven by tmux (available: tmux 3.5a). If key timing proves flaky, it becomes a human item: «open `agent-lab chat`, type the sentence, screenshot».

**Expected cost:**
- Pi model tokens: a few repo reads plus two tool calls, about 50–150k input tokens. On the Codex subscription the marginal cost is probably $0; at API prices it stays under $1 [ASSUMED].
- The up case adds one real GigaChat call through the mock (corp key).
- No OpenRouter or Lab spend is possible (mode guard + gate).

## Architecture Patterns

### System Architecture Diagram
```
user sentence ──► Pi model (system prompt + SKILL "Start from one sentence")
                    │ read/find/grep (repo)            │
                    ▼                                  ▼
          found-list text              agent_lab_connection action=preflight
                                        │ readData(dialogues)→count; stat(materials)
                                        │ checkConnection(target):
                                        │   preflightTarget ─► openExternalTarget ─► 1 turn ─► adapter ─► service/mock
                                        │   └─ error ─► classifyConnectionError ─► {kind, message, next}
                                        ▼
                              result {connection, dialogues, materials, checklist}
                                        │
         tool_execution_end ───────────►│ extension closure: lastCheck, found, lastDraftId
                                        ▼
            preparationChecklist(state) ─► checklistRows ─► renderRows ─► setWidget factory (TUI)
                                        │
user/model: agent_lab_build validate ──► GATE(checkConnection) ──fail──► return connection_failed (no spend)
                                        └─ok─► native confirm ─► lab.create (paid) ─► draft (review)
agent_lab_accept (02-08) ─► agent_lab_run ─► GATE ─► confirm ─► lab.start ─► setWidget(undefined)
```

### Recommended Structure
```
src/connection.ts      + checkConnection, classifyConnectionError, ConnectionCheck types
src/progress.ts        + preparationChecklist, checklistRows (Phase 4 creates the file)
extensions/render/theme.ts  + GLYPH.todo '○' (Phase 4 creates the file)
extensions/agent-lab.ts     widget lifecycle, tool_execution_end, preflight action, gates, wording
skills/agent-builder/SKILL.md  start section, explicit-only section
test/connection-check.test.ts, test/progress.test.ts (checklist part), test/start-path.test.ts
.planning/phases/06-legkiy-start/live-start-check.sh
```

### Anti-Patterns to Avoid
- **Probing by sending unknown protocol types.** A `{"type":"ping"}` line goes into aigw's `protocol_reply` and becomes a full agent turn with `message: ""` [VERIFIED: agent_lab_target.py:231-234]. Use a normal `respond` with a fixed greeting.
- **Throwing on a failed check.** Pi shows a red tool error, and the model may retry or improvise. Return a structured result with the Russian text.
- **Listing all records to find the draft** (slow; ~15 MB).
- **Showing the ping reply or log lines** (bank data leaves through chat history).
- **Keeping `before_agent_start` hiding the widget** (the checklist would vanish on the first message).
- **Deleting side-branch code or tests** (CLEAN-01 is deferred).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Talking to the agent | New HTTP/TCP probes | `openExternalTarget` | Same process, env, timeout, prompt attestation as real runs |
| Static readiness | New path checks | `preflightTarget` | Already localized Russian texts |
| Reading logs | Own JSONL parser | `readData(file, 'dialogues', { maxItems: 300 })` + `dialogueSchema` | Size limits and error texts exist |
| Painting / wrapping | Own ANSI or slicing | Phase 4 `renderRows`, `wrapRows`, `GLYPH` | Lint test SCREEN-07 forbids `.slice`/`padEnd` on display text |
| Saving the connection | New file | `rememberConnection` | Atomic, 0600, keeps probe |

## Runtime State Inventory

Not a rename phase, but START-04 changes wording that runtime state may cache:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Old Pi session files (`~/.pi/agent/sessions`) hold the old system prompt only in history; records in `.agent-lab` are unaffected | None — new sessions get the new prompt |
| Live service config | None — verified: the extension is loaded from files on each `agent-lab chat` start | None |
| OS-registered state | None — no launchd/cron for Agent Lab found in this research | None |
| Secrets/env vars | New optional env use only in tests/live check (`AGENT_LAB_MOCK_URL`, `AGENT_LAB_TARGET_URL`, read by the aigw adapter) | None in code |
| Build artifacts | Worktree `dist/` is imported by the live extension (`../dist/*.js`) | Rebuild only via procedure 01-10; the live check uses the snapshot's own `dist/` |

## Common Pitfalls

### Pitfall 1: Extension test harness rejects the new event
**What goes wrong:** `registered()` fails with `AssertionError: 'tool_execution_end' == 'session_start'`.
**How to avoid:** Extend the `on` stub to store the handlers in a map (test/extension.test.ts:30-34).

### Pitfall 2: Refused connection classified as "bad reply"
**Why:** aigw wraps it as `Ошибка измерения внешнего агента: ConnectError…`.
**How to avoid:** Test `refused` patterns first, using the verbatim reproduced string.

### Pitfall 3: Gate after the confirm
**What goes wrong:** The user approves spend for a dead agent. **How to avoid:** The gate call must sit above `ctx.ui.confirm` in both build (309) and run (559). A test stubs `confirm` and asserts it was never called when the check fails.

### Pitfall 4: 180-second ping
**What goes wrong:** aigw's `timeoutMs: 180000` makes a hung service block the chat for 3 minutes. **How to avoid:** Cap the ping timeout (copy the target with a smaller `timeoutMs`), and show «Проверяю связь…» via `onUpdate`.

### Pitfall 5: Discovery picks service logs or the wrong venv
**What goes wrong:** `local/logs/app.log`/`events.log` look like "logs". Baseline has no `.venv`.
**How to avoid:** Use the skill heuristics 3 and 6, and validate logs through the preflight action (count > 0).

### Pitfall 6: Concurrency with live runs
**What goes wrong:** The up-case ping hits the shared service during a 01-12/02-03 live run.
**How to avoid:** Preflight in the live script, and run the down case first (no contact).

### Pitfall 7: Merge conflicts with Phases 2–4
**What goes wrong:** 02-05, 02-08, 03-03 and 03-04 all edit `extensions/agent-lab.ts`, and 02-08 rewrites the same system-prompt sentence.
**How to avoid:** Phase 6 plans run last. Tasks must re-read the prompt and the line numbers, and use `grep` anchors, not line numbers.

### Pitfall 8: "Main path" test too strict
**What goes wrong:** `mode` enum literals or `agent_lab_prompt`'s own name trip the regex.
**How to avoid:** Scan only `description` strings; allow sentences that match `EXPLICIT`.

## Code Examples
See the `checkConnection`, widget lifecycle and test skeletons above. All identifiers come from files read this session:
- `openExternalTarget`, `preflightTarget`, `readPrompt` — `src/targets.ts`;
- `rememberedConnection`, `rememberConnection`, `readConnection`, `fingerprint` import pattern — `src/connection.ts:5,56-69`;
- `ExperimentStore.get` — `src/store.ts:97`;
- `readData` — used at `extensions/agent-lab.ts:272`.

`renderRows`, `GLYPH` and `Row` are Phase-4 contract names [CITED: 04-UI-SPEC.md:218-236]; the files do not exist yet.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Start widget as a 2-string array, hidden on the first message | Component-factory checklist, kept until the run starts | Phase 6 | No 10-line cap; state visible throughout |
| Doctor probe (3 requests, needs `probe`) as the only live check | One-turn `checkConnection` + gate; doctor kept | Phase 6 | Works on aigw's connection as is |
| Discover described in the main prompt | Explicit-only section | Phase 6 | The model stops offering it |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The 8 `idp/*.md` materials correspond to the 8 `idp.json` articles | START-01 | The skill hint about fixtures misleads; low |
| A2 | httpx 5xx message format and Linux Errno 111 | START-03 | A classification pattern misses; covered by the `unknown` fallback |
| A3 | Ping without a dialog for remembered targets and non-TUI modes; confirm only for a new target in TUI | START-03 | Security/consent policy; user may want a confirm always (adds friction) |
| A4 | Skip the ping if an `ok` check is younger than 2 minutes | START-03 | Stale "ok" if the mock dies in that window; the run then shows invalid trials |
| A5 | Ping timeout cap of 120 s | START-03 | A slow real agent is reported as `timeout` |
| A6 | Live check cost ≤ $1 on Codex subscription; json mode loads `-e`/`--skill` regardless of project trust | Live check | The run may cost more, or not load the skill; the check then becomes a human item |
| A7 | tmux-driven TUI capture works reliably | Live check | Falls back to a human screenshot |
| A8 | Checklist step rules (table) and wording | START-02 | Discretion area; only wording/order risk |
| A9 | `withoutDialogues` stays honored but is no longer offered | START-04 | The user may consider "без логов" part of the main path |
| A10 | `score` is treated as a non-offered branch (not in the locked list but not in the main path) | START-04 | The customer wants prod-dialogue scoring next; they may want it offered |
| A11 | Exact `World`/`CallContext` literal in the `checkConnection` sketch | START-03 | Typecheck failure; fixed at implementation |

## Open Questions

1. **Does a ping to aigw count as "free"?**
   - Known: it makes no Lab/OpenRouter call, but the mock proxies one real GigaChat call on the corp key.
   - Recommendation: call it «бесплатно для Lab» and mention «один короткий запрос к агенту» in the checklist text.
2. **Board `d` hint.** Phase 4 rewrites the board empty state. Recommendation: Phase 6 removes the hint text only if Phase 4 kept it, and grep-anchors the edit.
3. **CLI `evaluate --yes` gate.** It is out of the Pi-only scope. Recommendation: do not add it now (CI already gets invalid trials with exit code 2).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | all | ✓ | v22.22.3 | — |
| Pi bundle `dist/bundle/cli.js` | live check | ✓ (node_modules) | 0.85.1 | — |
| `pi` on PATH | — | ✗ | — | use the bundle path |
| tmux | widget capture | ✓ | 3.5a | human screenshot |
| aigw python venv | ping/live check | ✓ `aigw-local/.venv/bin/python` | 3.12.9 | — |
| aigw service :8080 / mock :8090 | up case | ✓ listening now | — | down case needs neither |
| Pi auth (`~/.pi/agent/auth.json`, default `openai-codex/gpt-5.6-sol`) | live check | ✓ file present | — | human item |

**Missing dependencies with no fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` via tsx 4.20 |
| Config file | none (`tsconfig.json`; script `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh`) |
| Quick run command | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh test/connection-check.test.ts test/progress.test.ts test/start-path.test.ts` |
| Full suite command | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh` (working tree: tsc + all tests + extension typecheck) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| START-01 | Skill has the start procedure (heuristics 1–7, found-list shape); preflight action validates dialogues count and material files without returning contents | unit | `snap-test.sh test/start-path.test.ts test/extension.test.ts` | ❌ Wave 0 (start-path) |
| START-01 | Lab finds prompt, adapter and logs on aigw and stops before spend | live (json mode) | `bash .planning/phases/06-legkiy-start/live-start-check.sh` | ❌ Wave 0 |
| START-02 | `preparationChecklist` truth table; rows at widths 40/48/60/80/120/160 without truncation; one `▸` | unit | `snap-test.sh test/progress.test.ts` | ❌ (Phase 4 creates the file; Phase 6 adds cases) |
| START-02 | Widget set on session_start, refreshed on `tool_execution_end`, not hidden by `before_agent_start`, removed after run start; content text includes checklist | unit (stub `ctx.ui.setWidget`) | `snap-test.sh test/extension.test.ts` | ✅ file, ❌ cases |
| START-02 | Widget visible in the real TUI | live (tmux capture) or human | `live-start-check.sh --widget` | ❌ Wave 0 |
| START-03 | Classification of the six reproduced strings + HTTP strings | unit | `snap-test.sh test/connection-check.test.ts` | ❌ Wave 0 |
| START-03 | `checkConnection` on missing command / early exit / timeout / non-JSON / refused (inline python/node targets) | unit | same | ❌ Wave 0 |
| START-03 | Gate: build validate and run return `connection_failed`, `confirm` never called, `lab.create`/`lab.start` never called | unit (stubbed ui, prototype spies as in extension.test.ts:152) | `snap-test.sh test/extension.test.ts` | ✅ file, ❌ cases |
| START-03 | aigw down (env override) → «отказ соединения» + next step before spend | live | `live-start-check.sh` (down case) | ❌ Wave 0 |
| START-04 | No side-branch offers in prompt, skill, descriptions; 11 tools registered | unit | `snap-test.sh test/start-path.test.ts test/skill.test.ts` | ❌ / ✅ (rewrite) |

### Sampling Rate
- **Per task commit:** the quick run command (three files).
- **Per wave merge:** the full suite command.
- **Phase gate:** full suite green, then `live-start-check.sh` (down case mandatory; up case and widget if the preflight allows), before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `test/connection-check.test.ts` — START-03 unit
- [ ] `test/start-path.test.ts` — START-04 (+ START-01 skill structure)
- [ ] checklist cases in `test/progress.test.ts` (file from Phase 4; if Phase 4 is cut, create it)
- [ ] `test/extension.test.ts` harness: accept `tool_execution_end`; stub `ctx.ui.setWidget`
- [ ] rewrite `test/skill.test.ts` and `test/extension.test.ts:45-63` for the moved discover text
- [ ] `.planning/phases/06-legkiy-start/live-start-check.sh` + a node assertion script over JSON lines (prints no dialogue content)

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | partial | The ping executes the connection's command. Native confirm for a new/changed target in TUI (A3); the remembered connection file stays 0600 |
| V5 Input Validation | yes | zod `connectionSchema`/`targetSchema`, `readData` limits, typebox params with `additionalProperties: false`; paths resolved with `resolve(ctx.cwd, …)` |
| V6 Cryptography | no | `fingerprint` (existing hash) only as an identity key |
| V7 Error handling / logging | yes | `safeText` + 300-char cap on the error detail; never echo the reply or log lines |
| V8 Data protection | yes | Bank dialogues: counts only; the live-check script prints no message content except grep results on the final assistant text |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Model-written connection runs an arbitrary command during the "free" check | Elevation / Tampering | Confirm for new targets in TUI; show the exact command; `preflightTarget` existence checks. (Pi's own bash tool is the baseline risk.) |
| Ping reply or stderr leaks bank data into the chat/session file | Information disclosure | Store only `ms`/`kind`; stderr tail ≤ 200 chars through `safeText`; no reply text |
| Terminal escape injection via adapter stderr in the widget | Tampering | `renderRows` applies `safeText` to every row |
| Live check touching production-like services | DoS | Env override for the down case; preflight for active runs; never stop the mock |

## Sources

### Primary (HIGH confidence)
- `extensions/agent-lab.ts` (full read), `skills/agent-builder/SKILL.md` (full), `src/targets.ts` (full), `src/connection.ts` (full), `src/store.ts:95-124`, `src/experiment.ts` preflight call sites, `src/contracts.ts:88-110`
- `test/extension.test.ts:20-70`, `test/skill.test.ts`, `snap-test.sh`
- `node_modules/@earendil-works/pi-coding-agent@0.85.1`: `dist/core/extensions/types.d.ts` (40-48, 94-100, 205-216, 600-629, 902), `dist/modes/interactive/interactive-mode.js:1695-1773`, `dist/core/agent-session.js:547-556`, `docs/usage.md`, `docs/json.md`; `pi-tui/dist/tui.d.ts`
- `aigw-local-baseline/local/agent_lab_target.py` (full), `LOCAL.md` (sections), directory listings; connection JSON files
- Reproduction run of error texts (scratchpad `probe.mts`), `visibleWidth` measurements, lsof/pgrep probes

### Secondary (MEDIUM confidence)
- `.planning/research/STACK.md`, `04-UI-SPEC.md`, `02-UI-SPEC.md`, `02-08-PLAN.md` (planned, not yet implemented)

### Tertiary (LOW confidence)
- Cost and behaviour of the live json-mode conversation (A6), tmux capture reliability (A7)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every API read in the installed typings/runtime.
- Architecture: MEDIUM-HIGH — seams verified. Checklist rules and consent policy are design choices.
- Pitfalls: HIGH — the harness assertion, error wrapping and line placements were read directly.
- Live check: MEDIUM — the command is grounded in `cli.ts` and the docs, but was not executed (read-only research, no paid calls).

**Research date:** 2026-09-17
**Valid until:** 2026-09-21 (demo). Line numbers are invalidated by Phases 2–4 edits; use grep anchors.
