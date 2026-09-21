# Phase 4: Экран результата в Pi - Research

**Researched:** 2026-09-17
**Domain:** Pi 0.85.1 terminal rendering (tool rows, custom session entries, overlay board, footer status), pure view functions over `ResultView`
**Confidence:** HIGH for the rendering hosts (installed code read, plus a live spike in a real Pi 0.85.1 process). MEDIUM for the board, comparison and progress design (they depend on phase 2/3 code that does not exist yet).

## Summary

The two rendering hosts behave exactly as CONTEXT assumes. This was checked live.
- **Session files.** I built a real Pi session file with an `agent_lab_run` tool call, its `toolResult` (`details: { view }`) and a `custom` entry `agent-lab-verdict`.
- **Reopen.** An offline Pi 0.85.1 in a pty, with no model and no network (`pi --session <file> -e spike-ext.ts`), drew both blocks from the saved data. The tool row was drawn by `renderResult` from `details`; the model-only `content` text was **not** shown.
- **Expand key.** `ctrl+o` (`app.tools.expand`) switched both blocks to the expanded form. `keyHint('app.tools.expand', 'подробнее')` rendered as `ctrl+o подробнее`.
- **Same block in both hosts.** A second spike ran our renderer through Pi's own `ToolExecutionComponent` and `CustomEntryComponent`, in the real `dark` and `light` themes, at widths 40/80/160. The block text was identical in both hosts, and no line was wider than the window.
- **Silent fallback.** If `renderResult` throws, Pi quietly shows the plain `content` text instead (`catch {}` in `tool-execution.js`). A broken renderer therefore looks like "the model's JSON". Tests must call the renderer directly so an exception is visible.

The board work splits cleanly:
- **Frame and tabs.** Split `extensions/cards.ts` into a frame (`LabBoard`: keys, tabs, scroll, header/footer) and pure tab renderers in `extensions/render/`.
- **Section ids.** Keep the existing ids (`'agent'` = Итог, `'cards'` = Ситуации, `'results'` = Диалоги) so the phase-2 (`y`/`e` on `'cards'`) and phase-3 (`y`/`n`/`s` on `'results'`) scopes keep working. Add `'failures'` and `'compare'`.
- **Tab sets depend on state.** A draft shows `1 Итог · 2 Ситуации`. A started or finished run shows `1 Итог · 2 Провалы · 3 Диалоги · 4 Сравнение`.
- **Tab and Shift+Tab reach the board.** `matchesKey` accepts `tab` and `shift+tab` (CSI Z and kitty). Shift+Tab is Pi's thinking-cycle key, but it is bound only on the editor.
- **Failure → dialogue jump.** A per-row `anchor` and `bg` on board rows, plus a scroll-to-anchor step after wrapping.

Two findings change the plan:
1. **`parallel` is not stored in the record.** It is only an option of `lab.start()`, so `progressView` must compute it with the same rule as `runParallel`, or receive it.
2. **The Сравнение tab must not reuse `compareRuns` card labels.** They use the strict all-rubric `cardOutcome` and the banned word «карточк…». The tab needs a new pure `situationChanges(before, after)` in `src/comparison.ts`, next to the stability functions. It uses the headline verdict (`cardVerdict`) and the embedded identity from the CR-01 fix. A flip counts as «нестабильно» when the agent did not change, and as «исправлено»/«сломано» when it did.

**Primary recommendation:** Build four pure modules and use them everywhere:
- `src/verdict.ts`: the verdict line and «Дальше»;
- `src/progress.ts`: `progressView`;
- `situationChanges`: added to `src/comparison.ts`;
- `extensions/render/theme.ts` (tokens, glyphs, `wrapRows`, `bar`, `pickTier`, `paint`) and `extensions/render/verdict-block.ts` (one component).

Draw the block from `details: { kind: 'agent-lab/verdict', version: 1, view }` in `renderResult`, and from `pi.appendEntry('agent-lab-verdict', …)` + `registerEntryRenderer` on the `/agent-lab` path. Anything else (legacy sessions, other tools) keeps today's JSON renderer as a fallback.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
(verbatim from `04-CONTEXT.md` `## Implementation Decisions`)

#### Блок-вердикт в чате (SCREEN-01, SCREEN-02)
- Первая строка — вердикт простым языком, по шаблону (модель его не пишет). Пороги по доле среди проверенных ситуаций:
  - ≥ 80% — «Агент справляется хорошо»;
  - 50–79% — «Агент справляется с ошибками»;
  - < 50% — «Агент справляется плохо».
- К вердикту добавляются число и оговорки:
  - «: N из M ситуаций»;
  - при M < 20 — «(мало данных)»;
  - если контроль не пройден, вместо вердикта: «Числу пока не верить: контроль не пройден».
  - Если M = 0: «Проверенных ситуаций нет».
- Дальше в блоке:
  - главное число (строки `ResultView`);
  - три главные причины в формате фазы 2 («Должен был / Сказал / Правило N»);
  - «не измерено» с причиной;
  - строка согласия (фаза 3);
  - одна строка «Дальше: …».
- «Дальше» выбирается по состоянию, в порядке приоритета:
  1. Контроль не пройден — «проверьте судью и связь».
  2. Есть непроверенные провалы — «откройте /agent-lab и отметьте согласие с провалами».
  3. Всё отмечено — «повторите прогон после исправления агента» или «выгрузите отчёт для заказчика».
- Два вида блока: свёрнутый (вердикт, число, три причины по одной строке-заголовку, «не измерено», «дальше») и развёрнутый (полные объяснения). Переключение — клавишей разворота Pi, подсказка через `keyHint`.
- Текст нигде не обрезается посередине слова: только перенос по словам.
- Один и тот же блок для прогона из разговора (`renderResult` инструмента по `details.view`) и из `/agent-lab` (`pi.appendEntry` + `pi.registerEntryRenderer`, запись не уходит в контекст модели). При переоткрытии сессии блок рисуется снова из сохранённых данных.
- Модель не пересказывает блок своими словами. В `content` инструмента идёт короткий текст для модели, а владелец видит блок.

#### Доска с вкладками (SCREEN-03, SCREEN-04)
- Вкладки: `1` Итог · `2` Провалы · `3` Диалоги · `4` Сравнение. `Tab`/`Shift+Tab` переключают по кругу.
- Раздел «Ситуации» (лист ожиданий черновика, фаза 2) остаётся доступным, пока прогон не запущен. Планировщик сводит номера вкладок черновика и результата без конфликта с реестром клавиш фаз 2–3.
- Вкладка «Провалы»:
  - список провалов в формате фазы 2;
  - у каждого провала отметка согласия (клавиши фазы 3);
  - сначала доказательство (реплика и правило), потом вердикт судьи;
  - `Enter` открывает диалог.
- Вкладка «Диалоги»:
  - полный диалог ситуации;
  - реплика, на которую сослался судья, подсвечена фоном выделения темы (`selectedBg`), и прокрутка сразу стоит на ней;
  - `Esc` возвращает к списку.
- Перед добавлением вкладок `extensions/cards.ts` делится на рамку и чистые функции строк для каждой вкладки (`extensions/render/*.ts`). Правки `extensions/agent-lab.ts` идут последовательно.
- Доска работает только в TUI (`ctx.mode === 'tui'`). В других режимах — текстовый блок.

#### Сравнение (SCREEN-05)
- Вкладка «Сравнение» показывает текущий прогон против исходного (повтор или переоценка). По каждой ситуации одна из пометок: «исправлено», «сломано», «нестабильно», «без изменений», «несравнимо — причина».
- Сверху итог словами: «Исправлено 2 · Сломано 1 · Нестабильно 1 из 13 сравнимых».
- Если исходного прогона нет, так и написано; сравнение не выдумывается.
- Данные: `compareRuns` и строки стабильности фазы 1.

#### Живой прогресс (SCREEN-06)
- Одна функция `progressView(record, now)` отдаёт:
  - пройдено / всего диалогов;
  - оценку оставшегося времени по среднему времени диалога с учётом параллельности;
  - потраченные деньги с пометкой «оценка · судья и симулятор» (стоимость самого агента не входит).
- Прогресс показывается в трёх местах:
  - строка инструмента: `onUpdate` примерно раз в секунду;
  - подвал Pi: `ctx.ui.setStatus`;
  - заголовок доски.

  Во всех трёх местах один и тот же текст, например «7 из 15 диалогов · ~4 мин · $0.84 (оценка)».
- Пока первый диалог не закончен, время показывается как «оцениваю…». Прогон не должен выглядеть зависшим: если есть активность, строка обновляется.
- После конца прогона статус в подвале очищается.

#### Единый вид (SCREEN-07)
- Общий модуль темы `extensions/render/theme.ts`:
  - только семантические токены `Theme`;
  - полосы, выравнивание, отступы и глифы — из контракта фаз 2–3.
- Ширины и перенос считаются только через `visibleWidth` / `truncateToWidth` / `wrapTextWithAnsi`. Никаких `.slice`/`padStart` по видимому тексту.
- Проверка:
  - тесты-«снимки» строк на ширинах 40/60/80/100/160 с длинной кириллицей, на светлой и тёмной подделке темы;
  - ни одна строка не шире окна;
  - символ `…` не появляется посреди слова.

#### Проверка фазы без человека
- Пользователь спит, поэтому живой экран Pi никто не смотрит. Нужен короткий спайк: как Pi 0.85.1 рисует `renderResult` и собственную запись, по его компонентам TUI в виртуальном терминале, если это возможно. Он проверяет, что блок рисуется и после переоткрытия.
- Скриншоты тем — пункт для человека.
- Живой прогресс проверяется тестами с поддельным временем и одним дешёвым живым прогоном одной ситуации на `aigw-local` (до ~$0.5): в нём ловятся события `onUpdate` и статуса.
- Деньги фазы: до ~$1.

### Claude's Discretion
- Способ спайка рендера Pi, структура `extensions/render/*`, точные тексты «дальше» и вердикта в пределах шаблона, частота обновления прогресса, номера вкладок черновика.

### Deferred Ideas (OUT OF SCOPE)
- Вкладка «Прод» — прод отложен.
- Демо за минуту на встроенном примере — v2 START-05.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SCREEN-01 | Блок-вердикт в чате: вердикт словами, главное число, три причины, «не измерено», следующий шаг; без жаргона и обрезки | Patterns 1, 2 and 7: `verdictLine`/`nextStep` in `src/verdict.ts`, collapsed/expanded rows, test vectors, jargon scan |
| SCREEN-02 | Блок остаётся в истории, рисуется при переоткрытии, одинаков для разговора и `/agent-lab` | Pattern 1 (host evidence plus the live pty spike), Pattern 3 (appendEntry once, dedupe), host-parity test |
| SCREEN-03 | Полноэкранная доска с вкладками Итог / Провалы / Диалоги / Сравнение, управление с клавиатуры | Pattern 4 (split plus the merged key map), pty board harness |
| SCREEN-04 | Enter на провале → диалог с подсвеченной репликой; доказательство раньше вердикта; согласие там же | Pattern 5 (anchor/bg rows, scroll-to-anchor, return stack), phase-3 F10 block reused in Провалы |
| SCREEN-05 | Вкладка «Сравнение»: исправлено / сломано / нестабильно по ситуациям | Pattern 6 (`situationChanges`, identity rule, reason codes, wording) |
| SCREEN-06 | Живой прогресс в строке инструмента, подвале и доске; время и деньги с пометкой «оценка» | Pattern 8 (`progressView`, `onUpdate` cadence, `setStatus` key/clear, board header), mock-timer tests, the cheap live check |
| SCREEN-07 | Единый визуальный язык, перенос без обрезки, кириллица, светлая и тёмная темы, 40–160 колонок | Pattern 9 (theme module, glyphs, bars, tiers), render matrix with real Pi themes |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Pi only. The HTML report is a file for forwarding. There is no web UI.
- TypeScript ESM, Node ≥ 22.19, `strict`, `noUncheckedIndexedAccess`. Allowed libraries: zod 4, typebox, Pi SDK / `pi-tui` 0.85.1. **No new runtime dependency without an explicit reason.** None is needed here.
- User-facing strings and docs are in Russian; code, identifiers and commands are in English.
- Old JSON records must open and be reassessed without migration. **Old Pi session files must also render**: see Pitfall 1.
- Truth comes from JSON records and events. What was not observed stays `unknown`, and the agent's words do not prove an action.
- Bank production dialogues stay local (`.agent-lab`, `0600`) and never enter the repo. See the Security section about Pi session files.
- `npm test` / `npm run build` delete `dist/`, which the live Pi imports. Run tests only from a snapshot (`snap-test.sh`) and check `git status` / `git log` before edits. Other sessions may be working in this worktree.
- Do not touch the `aigw-local` git repo during runs. A live run costs about $2 and 6–17 min for 15 situations. The default judge is `openai/gpt-5.6-sol` via OpenRouter.
- Conventions:
  - `.js` import extensions in `src`; `.ts` relative imports inside `extensions/` (existing: `from './cards.ts'`);
  - extensions import compiled code from `../dist/*.js`;
  - named exports; zod schemas; errors thrown as `throw new Error(...)` with Russian text;
  - no formatter; 2-space indent.
- Every phase ends with an observable result on the real acquiring agent, or on its stored runs.
- GSD workflow: edits only through GSD commands. This research writes only this file.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Verdict wording, «Дальше», three causes, not-measured, agreement rows | `src/` pure view layer (`result-view.ts`, `verdict.ts`) | — | One source of text for CLI, Pi and HTML (phase 5); screens count nothing |
| Comparison per situation | `src/comparison.ts` (`situationChanges`) | `src/result-view.ts` (wording map) | Needs the private `reconstructedIdentity` and the headline verdict rules |
| Progress numbers (done/planned/ETA/money) | `src/progress.ts` (pure, `now` injected) | — | Same text in three places; testable with fake time |
| Verdict block component (wrap, color, collapse) | `extensions/render/verdict-block.ts` | `extensions/render/theme.ts` | Terminal-only styling; both hosts call it |
| Tool row host | Pi `ToolExecutionComponent` via `renderResult` | `extensions/agent-lab.ts` | Pi owns the shell; we return a component |
| Custom-entry host | Pi `CustomEntryComponent` via `registerEntryRenderer` | `extensions/agent-lab.ts` (`pi.appendEntry`) | Stored in the session file, not sent to the model |
| Board frame, tabs, keys, scroll | `extensions/cards.ts` (`LabBoard`) | `extensions/render/tabs/*.ts` | Frame is stateful; tab rows are pure |
| Footer progress | Pi footer via `ctx.ui.setStatus` | `extensions/agent-lab.ts` | Pi joins all statuses into one truncated line |
| Persistence of results | `.agent-lab/{id}.json` (store) | Pi session JSONL (block snapshot only) | Records are the truth; the session holds a display copy |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@earendil-works/pi-coding-agent` | 0.85.1 (installed, `package.json` `"version": "0.85.1"`) | `ToolDefinition.renderResult`, `ExtensionAPI.appendEntry` / `registerEntryRenderer`, `ctx.ui.setStatus`, `ctx.ui.custom`, `keyHint`, `Theme`, `initTheme`, `ToolExecutionComponent`, `SessionManager` | Already the product runtime [VERIFIED: node_modules/@earendil-works/pi-coding-agent/package.json] |
| `@earendil-works/pi-tui` | 0.85.1 (top level; a second 0.85.1 copy is nested under pi-coding-agent) | `Component`, `Box`, `Text`, `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `matchesKey` | Only allowed width and wrap helpers [VERIFIED: `grep '"version"'` on both package.json files] |
| `node:test` + `tsx` | Node v22.22.3, tsx ^4.20 | Unit and render tests; `t.mock.timers` for fake time | Existing test runner [VERIFIED: `node -v`] |

### Supporting
| Tool | Version | Purpose | When to Use |
|------|---------|---------|-------------|
| `script(1)` | macOS `/usr/bin/script` | pty for the real-Pi reopen check and board key check | Phase verification scripts (no model, offline) |
| `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1` | Pi env | Isolate the spike Pi from `~/.pi/agent`; no network | Every pty check [CITED: node_modules/@earendil-works/pi-coding-agent/docs/environment-variables.md:81-84] |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `appendEntry` + `registerEntryRenderer` | `sendMessage({display:true})` + `registerMessageRenderer` | That puts the block into the model context (tokens, and the model restates it). Rejected by the locked decision. |
| `ScrollView` (pi-tui) for scroll-to-seq | Existing manual `scroll`/`maxScroll` in `LabBoard.render` | `ScrollView` needs the layout protocol, which phases 2/3 banned before the demo. Keep manual scroll. |
| `@xterm/headless` virtual terminal | Direct `component.render(width)` plus a pty with a real Pi | xterm is a pi-tui **devDependency** and is not installed [VERIFIED: `ls node_modules/@xterm` → absent]. Adding it is a new dependency. `render(width)` and the pty cover the need. |

**Installation:** none. No packages are added.

## Package Legitimacy Audit

No external packages are installed in this phase.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| — | — | — | — | — | — | — |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Evidence: how Pi 0.85.1 draws our blocks

### Host code (read this session)

1. **Tool row.** `ToolExecutionComponent.updateDisplay` calls the renderer with `details` and the flags:
   `resultRenderer({ content: this.result.content, details: this.result.details }, { expanded: this.expanded, isPartial: this.isPartial }, theme, this.getRenderContext(this.resultRendererComponent))`. On an exception, `catch { … this.createResultFallback() }` shows the plain content text. [VERIFIED: node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js:248-262]
2. **Live partial updates.** `case "tool_execution_update": … component.updateResult({ ...event.partialResult, isError: false }, true);` [VERIFIED: dist/modes/interactive/interactive-mode.js:2708-2713]. The agent loop forwards every `onUpdate(partialResult)` as that event [VERIFIED: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:464-473].
3. **Reopen.** `rebuildChatFromMessages()` → `this.renderSessionEntries(this.sessionManager.buildContextEntries())` [VERIFIED: interactive-mode.js:3193-3196]. `renderSessionEntries` keeps `entry.type === "custom"` entries and passes the rest through `sessionEntryToContextMessages` [VERIFIED: interactive-mode.js:3075-3086]. `renderSessionItems` then rebuilds each tool call with `new ToolExecutionComponent(...)` and `component.updateResult(message)` from the stored `toolResult` [VERIFIED: interactive-mode.js:3018-3059], and each custom entry with `this.addCustomEntryToChat(item)` [VERIFIED: interactive-mode.js:3004-3006]. `renderInitialMessages` uses the same path [VERIFIED: interactive-mode.js:3157-3162].
4. **Live append.** `appendEntry` → `sessionManager.appendCustomEntry(customType, data)` → `this._emit({ type: "entry_appended", entry })` [VERIFIED: dist/core/agent-session.js:2029-2035] → `case "entry_appended": if (event.entry.type === "custom") { this.addCustomEntryToChat(event.entry); ... }` [VERIFIED: interactive-mode.js:2590-2595].
5. **Entry host.** `CustomEntryComponent.rebuild()` calls `this.renderer(this.entry, { expanded: this._expanded }, theme)`, adds `Spacer(1)` and the component, and turns a throw into a red `renderer failed` box. `invalidate()` rebuilds, so theme changes redraw it [VERIFIED: dist/modes/interactive/components/custom-entry.js:28-50].
6. **Expand key.** `this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion())` [VERIFIED: interactive-mode.js:2295]. `setToolsExpanded` calls `child.setExpanded(expanded)` on every chat child [VERIFIED: interactive-mode.js:3463-3476]. Default key: `"app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" }` [VERIFIED: dist/core/keybindings.js:52].
7. **Compaction limit.** `buildContextEntries` keeps only entries from `firstKeptEntryId` onwards after a compaction [VERIFIED: dist/core/session-manager.js:198-229]. A block older than the last compaction is **not** redrawn. This is expected Pi behavior; record it as a limit, not a defect.
8. **Types.** `renderResult?: (result: AgentToolResult<TDetails>, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext<…>) => Component`; `ToolRenderResultOptions { expanded: boolean; isPartial: boolean }`; `EntryRenderer<T> = (entry: CustomEntry<T>, options: EntryRenderOptions, theme: Theme) => Component | undefined`; `EntryRenderOptions { expanded: boolean }`; `appendEntry<T = unknown>(customType: string, data?: T): void`; `setStatus(key: string, text: string | undefined): void` [VERIFIED: dist/core/extensions/types.d.ts:80, 308-313, 376, 887-890, 969, 985].
9. **Footer.** Statuses are sorted by key, sanitized (`.replace(/[\r\n\t]/g, " ")`), joined with `" "` and cut: `lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")))` [VERIFIED: dist/modes/interactive/components/footer.js:10-16, 210-217].
10. **Widget cap.** `InteractiveMode.MAX_WIDGET_LINES = 10` applies to string arrays only [VERIFIED: interactive-mode.js:1715-1720, 1773]. Phase 4 does not need a widget; this belongs to phase 6.
11. **`keyHint` global state.** It reads the global keybindings of the **nested** pi-tui copy and the global `theme`: `return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", \` ${description}\`);` with `keyText` → `getKeybindings().getKeys(keybinding)` [VERIFIED: dist/modes/interactive/components/keybinding-hints.js:24-33]. Outside a running Pi the key text is empty: the spike printed ` подробнее`.

### Live spike results (this session, scratch copy, no paid calls, no Pi left running)

- **Spike A: host components in a Node script.**
  - Setup: `spike-hosts.mts` in the session scratchpad, a `git archive HEAD` copy with a symlinked `node_modules`, built by `tsc` inside the scratch directory.
  - The renderer was run through the real `ToolExecutionComponent` and `CustomEntryComponent` (the latter deep-imported by file path), under `initTheme('dark'|'light')`.
  - Output lines:
    - `dark tool-final width=40 rows=13 over=0 ellipsis=0`, `… tool-reopen … over=0`, `… entry-reopen … over=0`;
    - the same for 80/160 and for light;
    - `same block text in both hosts: true`;
    - `renderResult expanded=false partial=true hasView=false` → `partial=false hasView=true` → `expanded=true`;
    - `throwing renderResult falls back to: ["Проверка агента","краткий текст для модели"]`.
- **Spike B: a real Pi process on a saved session.**
  - Command: `PI_CODING_AGENT_DIR=<scratch>/agentdir PI_OFFLINE=1 script -q pty.log sh -c "stty cols 100 rows 45; exec timeout -s TERM 12 node_modules/.bin/pi --session <file> -ne -e ./spike-ext.ts --no-skills -nc --no-prompt-templates --use-theme dark"`.
  - The stripped screen showed, in order:
    - `проверь агента`
    - `Проверка агента`
    - `BLOCK Агент справляется с ошибками: 9 из 13 ситуаций (мало данных)`
    - `Справился в 9 из 13 …`
    - `ctrl+o подробнее`
    - `Готово.`
    - `BLOCK ENTRY Агент справляется …`
    - `ctrl+o подробнее`
  - The model-only content `LLM-TEXT-ONLY` never appeared.
  - With `printf '\017'` (Ctrl+O) piped in and `--use-theme light`, both blocks switched to `РАЗВЁРНУТО`, and Pi printed `Tool output: expanded`.
- **Spike C: the real current board, driven by keys.**
  - Command: `(… printf '/agent-lab demo'; printf '\r'; printf 'r'; printf '\r'; printf '1'; printf '\t'; printf '\033[Z'; printf 'q') | script … pi --no-session -ne -e ./extensions/agent-lab.ts …`.
  - Screen: `ПРОВЕРЬТЕ КАРТОЧКИ · ДЕМО`, then `Запустить проверку?`, then `ИДУТ ДИАЛОГИ` with `────  0 / 3 диалогов · c Остановить`, then `ПРОВЕРЬТЕ РЕЗУЛЬТАТЫ`, then `Итог: Справился в 1 из 3 проверенных ситуаций — 33%.`
  - The demo needs no model. This is a free, repeatable key-driven check of the real board.
  - `pgrep` afterwards: `no pi left`.

## Architecture Patterns

### System Architecture Diagram

```
                         ┌──────────────── record (.agent-lab/{id}.json, live clone via lab.get) ───────────────┐
                         │                                                                                          │
 agent_lab_run (chat) ───┤ every 1 s: progressView(record, now) ─► onUpdate({content:[text], details:{kind:'agent-lab/progress', progress}})
                         │                                   └──► ctx.ui.setStatus('agent-lab-progress', text)  ── Pi footer (one joined line)
                         │ end: evidenceBundle(record) ─► view (ResultView + phase2 failures/topCauses + phase3 agreement + stability)
                         │      └► return { content:[short model text], details:{kind:'agent-lab/verdict', version:1, view} }
                         │                                   └► finally: setStatus('agent-lab-progress', undefined)
                         ▼
               Pi ToolExecutionComponent ──renderResult(result, {expanded,isPartial}, theme)──┐
                                                                                               ├─► VerdictBlock(view, expanded, theme)
 /agent-lab (board) ──► LabBoard(load every 750 ms) ─ header: progressView text + bar          │      rows = verdictBlockRows(view)  (src/verdict.ts + result-view rows)
        │                      │ onFinished(bundle) / on close when finished and not yet shown │      └► theme.renderRows(rows, width): wrapRows → paint
        │                      ▼                                                               │
        └──────────► pi.appendEntry('agent-lab-verdict', {kind, version, runId, resultKey, view})
                                   └► Pi CustomEntryComponent ─ registerEntryRenderer ─────────┘
 reopen session ─► buildContextEntries ─► same two hosts ─► same VerdictBlock (legacy details → legacy renderer)

 LabBoard tabs (record started):  1 Итог ─ 2 Провалы ─ 3 Диалоги ─ 4 Сравнение   (Tab / Shift+Tab cycle)
   Провалы: queue order (phase 3 F12) ─ detail = F10 block (evidence → judge → keys y/n/s → mark)
        └─ Enter ─► Диалоги(trialId, anchor seq) ─ rows with anchor/bg ─ scroll to anchor ─ Esc ─► back to Провалы
   Сравнение: situationChanges(before, record) + view.stability ─► rows (+ / - / * / blank / несравнимо — причина)
 LabBoard tabs (draft): 1 Итог ─ 2 Ситуации (phase-2 sheet, y/e)
```

### Recommended Project Structure
```
src/
├── verdict.ts          # NEW pure: verdictLine(view), nextStep(view), verdictBlockRows(view, {expanded}) → Row[] (plain text)
├── progress.ts         # NEW pure: progressView(record, now, {parallel?}), runParallel(record) (moved from agent-lab.ts)
├── comparison.ts       # + situationChanges(before, after) (uses private reconstructedIdentity)
└── result-view.ts      # + CHANGE_TEXT map, compareRows(changes); pointers renamed from «раздел N» to tab names
extensions/
├── agent-lab.ts        # hosts: renderResult dispatch, registerEntryRenderer, appendEntry, onUpdate/setStatus loops
├── cards.ts            # frame only: LabBoard (tabs, keys, scroll, header/footer), showBoard; re-exports for tests
└── render/
    ├── theme.ts        # Row type, tones, GLYPH, wrapRows (moved from cards.ts), paint, renderRows, bar, pickTier, roleTone
    ├── verdict-block.ts# VerdictBlock component + verdictEntryRenderer + renderVerdictResult
    └── tabs/
        ├── summary.ts  # Итог rows (today's verdictLines, reshaped)
        ├── situations.ts # phase-2 sheet rows (moved)
        ├── failures.ts # Провалы list entries + F10 detail rows
        ├── dialogues.ts# trialLines (moved) + anchors/highlight
        └── compare.ts  # Сравнение rows
```
- The typecheck script covers `extensions/*.ts`, and `tsc` follows imports into `extensions/render/**` [VERIFIED: package.json `"typecheck": "… tsc --noEmit … extensions/*.ts"`].
- New test files must sit directly in `test/`: the test script globs `test/*.test.ts` [VERIFIED: package.json `"test": "npm run build && tsx --test test/*.test.ts"`].

### Pattern 1: One verdict block, two hosts, versioned details
**What:** Both hosts draw the same component from the same `view`. The details carry a kind and version, so legacy sessions keep their old look.
```ts
// extensions/render/verdict-block.ts
import type { Theme } from '@earendil-works/pi-coding-agent';
import { Box, type Component } from '@earendil-works/pi-tui';
import { verdictBlockRows } from '../../dist/verdict.js';
import type { ResultView } from '../../dist/result-view.js';
import { renderRows, type PaintTheme } from './theme.ts';

export const VERDICT_KIND = 'agent-lab/verdict';
export interface VerdictDetails { kind: typeof VERDICT_KIND; version: 1; runId: string; resultKey: string; view: ResultView }
export const isVerdictDetails = (value: unknown): value is VerdictDetails =>
  !!value && typeof value === 'object' && (value as VerdictDetails).kind === VERDICT_KIND && (value as VerdictDetails).version === 1;

export class VerdictBlock implements Component {
  constructor(private view: ResultView, private expanded: boolean, private theme: PaintTheme, private hint: () => string) {}
  invalidate() {}
  render(width: number): string[] {
    const rows = verdictBlockRows(this.view, { expanded: this.expanded });
    return [...renderRows(rows, this.theme, width), ...(this.expanded ? [] : renderRows([{ text: this.hint() }], this.theme, width))];
  }
}
// Tool host: the shell already pads and paints; return the block itself.
// Entry host: Box(1, 1, s => theme.bg('customMessageBg', s)) around it (spike: identical inner text).
```
- `hint` is `() => keyHint('app.tools.expand', 'подробнее')` in Pi. Tests inject a fixed string, because `keyHint` returns an empty key outside Pi (evidence item 11).
- `renderResult` dispatch in `agent-lab.ts`:
  1. `isVerdictDetails(result.details)` → `VerdictBlock`;
  2. `options.isPartial && details.kind === 'agent-lab/progress'` → progress rows;
  3. otherwise → today's JSON renderer, renamed `legacyResult`, unchanged. This covers old sessions whose `details` is the whole summary output, and all other tools.
- `renderResult` must never throw. Wrap the body in `try/catch` and return `new Text(safeText(contentText))` on failure; Pi would fall back silently anyway (evidence item 1).

### Pattern 2: Verdict line and «Дальше» (pure, `src/verdict.ts`)
**Verdict line** (all inputs come from `ResultView`):
```ts
export function verdictLine(view: ResultView): string {
  const { passed, decided, accuracy } = view.headline;
  if (view.control.warning) return `Числу пока не верить: контроль ${controlWord(view)}`;   // see A3
  if (!decided || accuracy === null) return 'Проверенных ситуаций нет';
  const percent = Math.round(accuracy * 100);            // the SAME rounding the headline prints
  const word = percent >= 80 ? 'хорошо' : percent >= 50 ? 'с ошибками' : 'плохо';
  return `Агент справляется ${word}: ${passed} из ${decided} ${pluralForm(decided, ['ситуации', 'ситуаций', 'ситуаций'])}${decided < 20 ? ' (мало данных)' : ''}`;
}
```
- **Threshold rounding.** The thresholds use the rounded percent that the headline prints (`Math.round(accuracy * 100)` in `buildResultView`) [VERIFIED: src/result-view.ts:127 `— ${Math.round(accuracy * 100)}%.`]. Otherwise 39/49 = 79.6% would print «80%» next to «с ошибками».
- **Plural after «из».** The form follows the genitive after «из»: «1 из 1 ситуации», «9 из 13 ситуаций», «1 из 21 ситуации». This is `pluralForm(decided, ['ситуации','ситуаций','ситуаций'])`. The existing headline uses the same idea [VERIFIED: src/result-view.ts:127 `pluralForm(decided, ['проверенной ситуации', 'проверенных ситуаций', 'проверенных ситуаций'])`].
- **Small sample.** `20` is the phase-1 constant [VERIFIED: src/result-view.ts:15 `const SMALL_SAMPLE = 20;`]. Export it and reuse it rather than writing 20 again.
- **Control wording.** The control warning already distinguishes «не пройден» / «не измерен» / «не пройден или не измерен» [VERIFIED: src/result-view.ts (HEAD 56fed0b) `Контроль ${controlFailed && controlUnmeasured ? 'не пройден или не измерен' : controlFailed ? 'не пройден' : 'не измерен'} — числу пока не верить…`]. The verdict line should use the same word (A3).

**«Дальше»** (priority order; the first match wins):
| # | Condition (from `view`) | Text |
|---|-------------------------|------|
| 0 | `view.pending > 0` (run still going) | `Дальше: дождитесь конца прогона.` (discretion) |
| 1 | `view.control.warning !== null` | `Дальше: проверьте судью и связь с агентом.` |
| 2 | unmarked queue items > 0 (phase-3 queue: failures and sampled passes without a current agree/disagree mark) | `Дальше: откройте /agent-lab <id8> и отметьте согласие с провалами.` |
| 3 | `decided === 0` | `Дальше: разберите на доске /agent-lab <id8>, почему ситуации не измерены.` (discretion; CONTEXT has no rule for M = 0) |
| 4 | failures (`decided - passed`) > 0 | `Дальше: повторите прогон после исправления агента.` |
| 5 | otherwise | `Дальше: выгрузите отчёт для заказчика.` |

**Test vectors** (`test/verdict.test.ts`):
| passed/decided | control | queue unmarked | pending | verdict line | Дальше |
|----------------|---------|----------------|---------|--------------|--------|
| 12/15 | none | 0 | 0 | `Агент справляется хорошо: 12 из 15 ситуаций (мало данных)` | #4 |
| 39/49 (79.6% → 80) | none | 0 | 0 | `Агент справляется хорошо: 39 из 49 ситуаций` | #4 |
| 10/20 | none | 3 | 0 | `Агент справляется с ошибками: 10 из 20 ситуаций` | #2 |
| 9/13 | none | 0 | 0 | `Агент справляется с ошибками: 9 из 13 ситуаций (мало данных)` | #4 |
| 0/9 (fae4ee59 shape) | none | 9 | 0 | `Агент справляется плохо: 0 из 9 ситуаций (мало данных)` | #2 |
| 1/1 | none | 0 | 0 | `Агент справляется хорошо: 1 из 1 ситуации (мало данных)` | #5 |
| 21/21 | none | 0 | 0 | `Агент справляется хорошо: 21 из 21 ситуации` | #5 |
| 0/0 | none | 0 | 0 | `Проверенных ситуаций нет` | #3 |
| 0/10 (61521e0d shape) | not measured | 5 | 0 | `Числу пока не верить: контроль не измерен` | #1 |
| 5/7 | failed | 0 | 0 | `Числу пока не верить: контроль не пройден` | #1 |
| 3/4 | none | 2 | 11 | `Агент справляется с ошибками: 3 из 4 ситуаций (мало данных)` | #0 |

Also add a jargon scan over every output using the phase-2 and phase-3 forbidden lists.

**Collapsed rows** (`verdictBlockRows(view, { expanded: false })`), in this order:
1. verdict line (role `verdict`, bold; tone `error` when the control warned, otherwise `text`);
2. `resultViewRows(view)` with roles `lead | line` only (phase 2), which drops the per-situation `situation` rows and the `detail` rows; the agreement row and its tail rows (phase 3) are `line`/tail rows inside it;
3. a blank row;
4. when `causeSection(view)` is not null: the heading `SECTION_TEXT[kind].text` and only the `cause` rows (`1. <name> — C ситуаций`); for the `failures` kind (no clusters), only the `title` rows of the first three explanations;
5. a blank row;
6. the «Дальше» row.

**Expanded rows:** all `resultViewRows(view, { details: true })`, the full `causeSection` rows, `disagreementRows(view)` (phase 3 F7), `allFailuresPointer`, then «Дальше».

### Pattern 3: `/agent-lab` path appends the block once
- `BoardOptions.onFinished?: (bundle) => void`. `LabBoard.refresh()` calls it once, when the loaded record leaves `activePhases` after having been active in this board.
- In the loop:
  ```ts
  const shown = new Set(ctx.sessionManager.getEntries().filter(e => e.type === 'custom' && e.customType === 'agent-lab-verdict').map(e => (e.data as VerdictDetails)?.resultKey));
  const appendVerdict = (bundle) => {
    const key = `${bundle.record.id}:${resultHash(bundle.record)}`;
    if (shown.has(key) || !bundle.record.trials.length) return;
    shown.add(key);
    pi.appendEntry('agent-lab-verdict', { kind: VERDICT_KIND, version: 1, runId: bundle.record.id, resultKey: key, view: bundle.view });
  };
  ```
  - `ctx.sessionManager` is a `ReadonlySessionManager` that includes `getEntries` [VERIFIED: types.d.ts ReadonlySessionManager `Pick<SessionManager, … "getEntries" …>` (session-manager.d.ts:140)].
- **When to append.** Append after a board-started run finishes (`onFinished`), and after a quick mark or a finalize changes the result (a new `resultHash`), because the agreement row changed. Do **not** append on every open of an old run: that would clutter the history. Planner's choice; recommended: append only after state-changing actions (`run`, `repeat` then run, `agree`, `finalize`).
- **Chat-path parity.** `agent_lab_run`, the `validate` build run, `score` and `agent_lab_reassess` return `details: VerdictDetails`. `agent_lab_inspect` of a finished run also returns it (CONTEXT integration point).
- **Model text.** The model's `content` stays JSON (tests parse it: `JSON.parse(result.content…)` [VERIFIED: test/extension.test.ts:40-42]), plus one field: `shownToOwner: 'Блок-вердикт уже показан владельцу. Не пересказывайте число и причины; ответьте на вопрос или предложите следующий шаг.'`.
- **Instructions that must change.** Two places currently ask the model to restate the result and must be edited:
  - the system prompt ("then lead with one estimated card accuracy number…" [VERIFIED: extensions/agent-lab.ts:172]);
  - `skills/agent-builder/SKILL.md` ("After the run, report in this order: 1. estimated accuracy…" [VERIFIED: skills/agent-builder/SKILL.md:32-39]).
  - `test/skill.test.ts` only checks the discovery section [VERIFIED: test/skill.test.ts:8], so this edit does not break it.

### Pattern 4: Board split and merged key map
**Split first (one plan, no behavior change).**
- Move `trialLines`, `scenarioLines`, `verdictLines` and the phase-2 sheet rows into `extensions/render/tabs/*.ts`.
- Move `wrapRows` and `Line` into `extensions/render/theme.ts`.
- `cards.ts` keeps `LabBoard`, `showBoard`, `safeText`, `activePhases`, `reviewOrder` and re-exports `trialLines` / `wrapRows`: tests import them from `../extensions/cards.ts` [VERIFIED: test/cards.test.ts:4 `import { LabBoard, reviewOrder, safeText, type BoardAction, type BoardOptions } from '../extensions/cards.ts';`; extensions/agent-lab.ts:20 imports `activePhases, reviewOrder, safeText, showBoard, trialLines, type BoardAction, type BoardOptions, type Section`].
- Gate: the full snapshot suite and `pi-surface-check.mts` stay green with no expectation changes.

**Section ids.**
- Current type: `export type Section = 'agent' | 'cards' | 'results';` [VERIFIED: extensions/cards.ts:38].
- New: `'agent' | 'cards' | 'failures' | 'results' | 'compare'`. The labels are Итог, Ситуации, Провалы, Диалоги, Сравнение.
- The ids stay because the phase-2 plans scope `y`/`e` to `this.section === 'cards'` and phase 3 scopes `y`/`n`/`s` to section `results` (02-08 plan; 03-UI-SPEC key registry).

**Tab sets.**
| Record state | Tabs (number → section) | Default |
|--------------|-------------------------|---------|
| run list (no record) | — | — |
| draft (`review`/`preparing`, no trials) | `1` Итог → `agent`, `2` Ситуации → `cards` | today's rule |
| started or finished (`trials.length > 0` or an active phase after start) | `1` Итог, `2` Провалы → `failures`, `3` Диалоги → `results`, `4` Сравнение → `compare` | `agent` |
- Keys `3`/`4` on a draft do nothing.
- `Tab`/`Shift+Tab` cycle within the current set and wrap around. Both reset `selected`, `scroll`, `query` and `help`, as number keys do today [VERIFIED: extensions/cards.ts:366-367].

**Merged key registry (phase 4 changes only).**
| Key | Scope | Action | Note |
|-----|-------|--------|------|
| `1`–`4` | record open, not searching | tab by number within the current set | P4 (phase 2 reserved `4`, `tab`, `shift+tab` for phase 4) |
| `tab` / `shift+tab` | record open, not searching, help closed | next / previous tab | P4. Search mode ignores control chars today (`/[\x00-\x1f\x7f-\x9f]/`) [VERIFIED: cards.ts:351] |
| `y` `n` `s` | tab `failures` **or** `results`, reviewable, agreement block shown | phase-3 agreement | P3 scope widened to Провалы |
| `Enter` | tab `failures` | open the selected item in Диалоги, highlighted | P4 new |
| `Enter` | tabs `agent` / `results` / `cards` | expand/collapse (today) | unchanged |
| `Esc` | tab `results` opened by a jump | back to `failures` with the same selection (checked before the existing Esc chain) | P4 new |
| `u` | tab `failures` or `results` | only unmarked | P3 scope widened |
| `v` | tab `failures` or `results`, reviewable | rate one criterion | scope widened |
| `y` `e` | tab `cards` of a draft | phase 2, unchanged | — |
| `r` `x` `f` `c` `o` `a` `q` `?` `/` | unchanged | — | `/` also in `failures` |

Update the help text and footer tiers accordingly; the UI-SPEC step owns the exact strings.

**Text pointers that change with tab numbers.**
- Phase 2 `allFailuresPointer` → `… /agent-lab <id8>, раздел 1, Enter.` (02-04 plan).
- Phase 3 F8 → `… /agent-lab <id8>, раздел 3.` (03-UI-SPEC C-64).
- Today's board hints `3 — открыть диалог и основание оценки` [VERIFIED: extensions/cards.ts:208].
- All of these must name the tab: «вкладка «Провалы»».

### Pattern 5: Failure → dialogue jump with highlight and scroll-to-seq
```ts
// extensions/render/theme.ts
export interface Row { text: string; tone?: Tone; bold?: boolean; indent?: number; bg?: 'selectedBg'; anchor?: string; role?: string }
// dialogues.ts: each event row carries anchor `seq:<n>`; rows of the highlighted event get bg:'selectedBg'
//   and its header reads `#<seq>  АГЕНТ · на эту реплику сослался судья` (the word marker: color is never the only signal)
// LabBoard: private jump?: { from: 'failures'; selected: number; trialId: string; seq?: number; pending: boolean }
// render(): const wrapped = wrapRows(detail, inner);
//   if (this.jump?.pending) { const at = wrapped.findIndex(r => r.anchor === `seq:${this.jump.seq}`);
//     this.scroll = Math.max(0, Math.min(maxScroll, at - 1)); this.jump.pending = false; }
// paint(): bg rows → theme.bg('selectedBg', truncateToWidth(styled, inner, '', true))  // pad inside the bg; no .padEnd
```
- **Seq source.** Use the phase-2 explanation's `Сказал (реплика #<seq>)` seq: the cited reply, or the last reply when the judge cited none (C-05). With no reply (C-07), do not highlight; scroll stays at 0. The planner reads the exact field name from `src/explain.ts` after 02-04 lands (A5).
- **Entries.** The jump selects `results` entry index `entries().findIndex(e => e.id === trialId)` and clears `query` and `pendingOnly`. Otherwise a filtered list could hide the trial.
- **Row model.** `wrapRows` must copy `anchor` and `bg` onto every continuation row. Today `Line` carries only `{ text, color?, bold? }` [VERIFIED: extensions/cards.ts:65].
- **Theme type.** `BoardTheme = Pick<Theme, 'fg' | 'bold'>` [VERIFIED: extensions/cards.ts:64] becomes `Pick<Theme, 'fg' | 'bold' | 'bg'>`. The fake theme in tests needs `bg` [VERIFIED: test/cards.test.ts:13 `const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value };`].
- **Token.** `selectedBg` exists in both built-in themes: `dark.json` and `light.json` both map `selectedBg` → `"selectedBg"` var [VERIFIED: node -e over dist/modes/interactive/theme/{dark,light}.json]. `ThemeBg` includes it [VERIFIED: theme.d.ts `export type ThemeBg = "selectedBg" | … | "customMessageBg" | …`].

### Pattern 6: Сравнение data — `situationChanges(before, after)`
Why a new function:
- `compareRuns` labels use `cardOutcome` (the strict all-rubric result) [VERIFIED: src/comparison.ts:500-505, used at the fixed/regressed loop], while the headline uses `cardVerdict` → `goalCardOutcome` [VERIFIED: src/comparison.ts:576-578].
- Its headline says «карточек» and «Предварительно:» (banned or confusing wording) [VERIFIED: comparison.ts `…из ${compared} карточек.`].
- It never checks agent identity (target fingerprint and version). That check lives only in `stabilityBetweenRuns`, together with the CR-01 `reconstructedIdentity` [VERIFIED: src/comparison.ts:634-657, 617-626].

```ts
export type ChangeCode = 'fixed' | 'broken' | 'unstable' | 'same' | 'incomparable';
export type IncomparableCode = 'no_source' | 'source_unreadable' | 'runs_differ' | 'judge_changed' | 'situation_changed'
  | 'only_one_run' | 'not_measured_before' | 'not_measured_after';
export interface SituationChange { scenarioId: string; title: string; code: ChangeCode; before?: 'pass'|'fail'; after?: 'pass'|'fail'; reason?: IncomparableCode; unmeasured?: NotMeasuredCode }
export interface SituationChanges { basis: 'repeat' | 'reassess'; agentChanged: boolean; comparedWith: string; rows: SituationChange[]; counts: Record<ChangeCode, number> }
```

**Rules.**
1. **Basis.** `after.assessmentOf === before.id` → `reassess`; otherwise `repeat`.
2. **Whole-run gate.**
   - reassess: reuse the checks of `stabilityAfterReassess`; a changed judge → every row `judge_changed`;
   - repeat: `compareRuns(before, after).comparable`; false → every row `runs_differ`. The first note is available for the expanded view only; it contains jargon, so never show it collapsed.
   - `reconstructedIdentity(before, after) === null` → every row `no_source`.
3. **Agent changed.** Repeat only: `targetFingerprint`, `targetVersion` or `agentIdentity` differ, using the embedded identity when the source was rebuilt. This is the same test as `stabilityBetweenRuns` (lines 639-644).
4. **Per situation** (in `after.scenarios` order):
   - missing in `before` → `only_one_run`;
   - the card identity differs → `situation_changed` (use `identity.scenarios[id]` for a rebuilt source, as `stabilityAfterReassess` does);
   - `cardVerdict(observedRecord(run), card)` on both sides; an unknown side → `not_measured_before`/`not_measured_after`, with `unmeasured` = that side's reason;
   - equal → `same`;
   - different → `agentChanged ? (after === 'pass' ? 'fixed' : 'broken') : 'unstable'`.
5. **Controls.** Positive controls are excluded, as they are from stability [VERIFIED: result-view.ts:101 filters controls from `unstable`].
6. **Parity test.** Where both apply, `unstable` must equal `view.stability.unstable`.

**Where it lives.** Add `ResultView.changes?: SituationChanges`, built in `buildResultView` when `before` is given. The board reads it from `bundle.view`, and phase 5 HTML reuses it. `evidenceBundle` already passes `before` [VERIFIED: src/artifacts.ts `bundle.view = buildResultView(snapshot, { before: bundle.before });`].

**No source.**
- `bundle.before` undefined and no parent → one row: `Сравнивать не с чем: у прогона нет исходного.`
- A resolve warning (unreadable source) → `Исходный прогон не прочитан — сравнение не выполнено.` The warning texts come from `resolveSource` [VERIFIED: src/artifacts.ts resolveSource].

**Wording** (final strings belong to the UI-SPEC step; glyphs must be single-width ASCII, because `≠` was rejected for ambiguous width in phase 3):
| Code | Row | Tone |
|------|-----|------|
| fixed | `+ <title> — исправлено: было «не справился», стало «справился»` | success |
| broken | `- <title> — сломано: было «справился», стало «не справился»` | error |
| unstable | `* <title> — нестабильно: было «…», стало «…» (агент тот же)` | warning |
| same | `  <title> — без изменений: <справился|не справился>` | muted |
| incomparable | `/ <title> — несравнимо: <reason words>` | muted |

- **Summary line:** `Исправлено <a> · Сломано <b> · Нестабильно <c> из <n> сравнимых`, followed by a basis line: `Повтор прогона <id8>: агент <тот же|изменился>.` / `Переоценка прогона <id8>: те же ответы, судья тот же.`
- **Reason words:**
  - `judge_changed` → `судья с тех пор изменился` (phase-2 C-50);
  - `situation_changed` → `ожидание ситуации изменилось`;
  - `only_one_run` → `ситуации нет в исходном прогоне`;
  - `not_measured_*` → `не измерено в <исходном|этом> прогоне — <NOT_MEASURED_TEXT>`;
  - `runs_differ` → `прогоны проверяли в разных условиях`;
  - `no_source` → `исходный прогон недоступен`.
- **Live data.** On `61521e0d` vs `fae4ee59` (repeat, same agent) phase 1 measured `comparable = true`, 8 unchanged, 5 incomparable, 0 unstable [CITED: 01-10-SUMMARY.md]. The live tab should read about `Исправлено 0 · Сломано 0 · Нестабильно 0 из 8 сравнимых`, with 5 «несравнимо» rows. Fixed, broken and unstable are covered by unit fixtures only; no live flip exists (Open Question 2).

### Pattern 7: Theme module (`extensions/render/theme.ts`)
- **Tones.** Only `text | muted | dim | accent | success | warning | error | borderMuted` for foreground, `selectedBg` for highlight, and `customMessageBg` for the entry host box. These are exactly the tokens the phase-2 width check allows (`accent, borderMuted, dim, error, muted, success, text, warning`) [CITED: 02-06-PLAN.md board-width-check], plus the two backgrounds.
- **Glyphs.** Put one `GLYPH` const in this module, taken from the 02/03 registries: `✗ ✓ ? ▸ ● ◆ · — « » = ! ~ → ━ ─`. Add the phase-4 comparison glyphs `+ - * /`.
  - Do not reuse `?` (not measured) or `~` (unsure) with a new meaning.
  - `→` is East Asian Ambiguous width, but phase 3 already uses it. Keep it, and test it at width 40.
- **`wrapRows(rows, width)`.**
  - Phase 2 creates it in `cards.ts` (02-05). Phase 4 moves it here and keeps it re-exported from `cards.ts`.
  - The hanging indent is `indent + 2`. `anchor`, `bg`, `tone` and `bold` copy onto continuation rows.
  - Width is measured only with `visibleWidth`.
- **`renderRows(rows, theme, width)`.**
  - It runs `wrapRows`, then `paint`.
  - It asserts `visibleWidth(line) <= width` in development builds; tests check this on every line.
- **`bar(done, total, cells, theme)`.**
  - Fill `━` in `accent`, track `─` in `borderMuted`. The existing bar is 20 cells [VERIFIED: extensions/cards.ts:446-447 `Math.min(20, Math.round(record.trials.length / planned * 20))` and `'━'.repeat(filled)}${'─'.repeat(20 - filled)`].
  - `cells = Math.min(20, width)`. The bar goes on its own row, with the progress text on the next row, so nothing is cut at 40 columns.
- **`pickTier(texts, inner)`.** Returns the first text whose `visibleWidth` fits `inner`. This is the phase-3 footer and header tier rule.
- **`roleTone(role)`.** One map for the phase-2 (`title`, `expected`, `said`, `rule`, …) and phase-3 (`agree-head`, `judge-fail`, …) row roles. This replaces per-surface guessing.
- **Escaping.** Apply `safeText` inside `renderRows` for every row text, so no caller can forget it. `safeText` is already defined in `cards.ts` [VERIFIED: extensions/cards.ts:11-14]; move it to `theme.ts` and re-export it.

### Pattern 8: Progress (`src/progress.ts`)
```ts
export interface ProgressView { done: number; planned: number; etaMs: number | null; costUsd: number | null; text: string; stage: string; active: boolean }
export function progressView(record: Experiment, now: number, options: { parallel?: number } = {}): ProgressView
```
- **Done and planned.**
  - Done: `record.trials.length`. Trials are pushed as dialogues finish, and `lab.get` returns a clone of the active record [VERIFIED: src/experiment.ts:237-238 `return this.active?.record.id === id ? structuredClone(this.active.record) : this.store.get(id);`; :1066 `record.trials.push(trial);`].
  - Planned: `plannedTrials(record)` [VERIFIED: src/comparison.ts:462].
- **Parallelism.**
  - It is **not** in `settings`. `start()` takes it as an option: `async start(id, options: { approved; reviewer?; expectedHash?; parallel?: number })` [VERIFIED: src/experiment.ts:895-897].
  - Move `runParallel` into `src/progress.ts`: `record.target.kind === 'sandbox' ? 1 : Math.max(1, Math.min(8, record.scenarios.length * record.settings.userModes.length * record.settings.repeats))` [VERIFIED: extensions/agent-lab.ts:147-149]. `agent_lab_run`, the board and `progressView` then share it.
  - Reassess and score run sequentially: pass `parallel: 1` (A6).
- **ETA.** `avg = mean(trial.elapsedMs over done)`, `remaining = planned - done`, `etaMs = done ? remaining * avg / Math.max(1, Math.min(parallel, remaining)) : null`.
  - `elapsedMs` is per trial [VERIFIED: src/contracts.ts:790 `elapsedMs: z.number().finite().nonnegative()`].
  - `now` is used only for liveness: the elapsed time since `reviewedAt`, which `start()` sets to the start time [VERIFIED: src/experiment.ts:913 `record.reviewedAt = new Date().toISOString();`]. It is shown as a second row, e.g. «идёт 3:12», so the row changes every second while the run is active.
- **Money.** `record.usage.costUsd`, which `addUsage` updates live [VERIFIED: src/experiment.ts:965-968]. `null` → `стоимость неизвестна`. Demo → `без оплаты`. The agent's own cost is in `trial.externalUsage` and is excluded [VERIFIED: contracts.ts:793 `externalUsage: usageSchema.optional()`].
- **Text** (one string, shared by the three places):
  - `${done} из ${planned} ${pluralForm(planned,['диалога','диалогов','диалогов'])} · ${eta} · ${money}`;
  - `eta`: `оцениваю…`, `<1 мин`, `~N мин`, or `~H ч M мин`;
  - `money`: `$0.84 (оценка)`, with two decimals.
  - Explanation row, shown once on the tool row and the board header, not in the footer: `Оценка: судья и симулятор; стоимость самого агента не входит.`
  - Stage row: `safeText(record.message)`, which changes at every dialogue stage [VERIFIED: src/experiment.ts:1053-1063 `record.message = …`].
- **Tool loop** (in `agent_lab_run`, and in the build/score progress closures):
  - `setInterval(1000)`; `onUpdate` only when the text or stage changed (dedupe);
  - `details: { kind: 'agent-lab/progress', version: 1, progress }`;
  - `ctx.ui.setStatus('agent-lab-progress', text)` only when `ctx.hasUI && ctx.mode === 'tui'`;
  - `finally { setStatus('agent-lab-progress', undefined) }`.
  - Use a **separate key** from today's `returnToBoard` pointer (`'agent-lab'` [VERIFIED: extensions/agent-lab.ts:43-46]): the pointer is not progress, and a test can assert that the last call for `agent-lab-progress` is `undefined`.
  - The footer joins keys in sorted order and cuts the line with `...` (evidence item 9), so keep the footer text at 45 columns or less.
- **Board header.** While the phase is active: the bar row, the text row and the stage row. It refreshes on the existing 750 ms `load` timer [VERIFIED: extensions/cards.ts:288-290]. Inject `now: () => number` into `BoardOptions` for tests.
- **Fake time.** Node's `t.mock.timers.enable({ apis: ['setInterval', 'Date'] })` works on Node 22.22.3, but one `tick(3000)` fired the interval three times with `Date.now()` already at the final value: observed `[1003000,1003000,1003000]`. Tests must tick in 1000 ms steps. The pure `progressView` test passes `now` explicitly and needs no mocking. Avoid `performance.now()` in progress code: MockTimers does not cover it.

### Anti-Patterns to Avoid
- **Parsing JSON out of `content` for new blocks.** It ties the model text to the UI. Keep that only in the legacy fallback.
- **Putting the whole summary output into `details`.** Today `details: output` includes `proofs` and more [VERIFIED: extensions/agent-lab.ts:575-578]. Details are written to the session file, which is 0644 (Security). Store only `VerdictDetails`.
- **Appending the entry from both paths for one run.** A chat run already shows the tool block; append the entry only on the board path, with the `resultKey` dedupe.
- **Re-numbering section ids.** That breaks the phase-2/3 key scopes and every `section: 'results'` in the loop.
- **Using `compareRuns().fixed/regressed` for the tab.** It uses a different verdict rule from the headline and no agent-identity check.
- **Hard-coding `20`/`80`/`50` in the extension.** Put the thresholds in `src/verdict.ts`, next to `SMALL_SAMPLE`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Width, wrap, cut | `.length`, `.slice`, `padStart` | `visibleWidth`, `wrapTextWithAnsi`, `truncateToWidth(…, '', true)` for padding | Cyrillic, ANSI and wide characters (PITFALLS 12) |
| Key display in hints | Literal `ctrl+o` | `keyHint('app.tools.expand', …)` | Respects user rebinding (evidence items 6 and 11) |
| Chat history persistence | Our own file of shown blocks | `pi.appendEntry` + `ctx.sessionManager.getEntries()` | Pi owns the session and redraws on reopen |
| Expand/collapse state | Own toggle key in chat | Pi `expanded` flag on both hosts | Ctrl+O already drives it (spike B) |
| Virtual terminal for tests | xterm emulation | `component.render(width)`, plus a pty with the real Pi for the end-to-end check | No new dependency |
| Stability and identity | New identity logic | `reconstructedIdentity` / the agent check in `comparison.ts` | CR-01 fix already covers rebuilt sources |
| Plurals | `n === 1 ? …` | `pluralForm` (phase 2 moves it to `src/plural.ts`) | Russian has three forms |

**Key insight:** Pi already stores, redraws and expands both host types. Phase 4 needs no infrastructure, only one pure row builder and one component that every host calls.

## Common Pitfalls

### Pitfall 1: Old sessions hold a different `details` shape
**What goes wrong:** Current `agent_lab_run`/`build`/`review` return `details: output`, which already contains `view` (the phase-1 `ResultView`, without phase-2/3 fields) [VERIFIED: extensions/agent-lab.ts:83 `...(block ? { view: block, viewLines: resultViewLines(block) } : {})` and :578 `details: output`]. A new renderer that sees `details.view` would draw an old view that lacks `failures` or `agreement`, and could throw. Pi then quietly shows raw JSON.
**How to avoid:** Dispatch only on `details.kind === 'agent-lab/verdict' && version === 1`; everything else goes to `legacyResult`. Guard optional phase-2/3 fields with `?? []`.
**Warning signs:** A reopened old session shows JSON instead of the old compact text.

### Pitfall 2: A throwing renderer is invisible
**What goes wrong:** `ToolExecutionComponent` catches renderer errors and shows content text (evidence item 1). `CustomEntryComponent` shows a red «renderer failed» box instead (evidence item 5).
**How to avoid:** Wrap renderer bodies in try/catch. Test the renderer functions directly, and also through `ToolExecutionComponent`, asserting that no content JSON text is visible.

### Pitfall 3: Tab numbers move, and old pointers lie
**What goes wrong:** «раздел 1/3» strings (phase-2 `allFailuresPointer`, phase-3 F8, today's `3 — открыть диалог`) point at the wrong tab after the renumbering.
**How to avoid:** One pass in the tab plan that renames every pointer to the tab name, plus a test that greps rendered text for `раздел \d`.

### Pitfall 4: The footer cuts the status line
**What goes wrong:** Pi joins every extension status into one line and cuts it with `...` (evidence item 9). A long progress text is cut mid-word by Pi, not by us.
**How to avoid:** Keep the footer text short (≤ 45 columns). The explanation row goes only on the tool row and the board.

### Pitfall 5: Duplicate blocks in history
**What goes wrong:** Appending on every board close or reopen floods the chat.
**How to avoid:** Use a `resultKey` (`runId:resultHash`) set, seeded from `ctx.sessionManager.getEntries()`, and append only after state changes.

### Pitfall 6: Verdict word contradicts the printed percent
**What goes wrong:** The threshold is applied to the raw fraction while the headline prints a rounded percent.
**How to avoid:** Apply the thresholds to `Math.round(accuracy * 100)`. Test vector 39/49.

### Pitfall 7: Fake time with MockTimers
**What goes wrong:** A large `tick` fires queued intervals with the final `Date.now()` (observed in this session).
**How to avoid:** Tick in 1000 ms steps. Keep `progressView` pure, with `now` injected.

### Pitfall 8: `keyHint` differs between tests and Pi
**What goes wrong:** Outside Pi the key part is empty because of the nested pi-tui keybindings global (evidence item 11). A snapshot that includes the hint breaks in one of the two environments.
**How to avoid:** Inject the hint function; in Pi it is `() => keyHint('app.tools.expand', 'подробнее')`.

### Pitfall 9: The live `dist/` and the running Pi
**What goes wrong:** New renderers import `../dist/verdict.js`. A live Pi that loaded the old `dist` does not see new modules until restart. Rebuilding `dist/` in the worktree breaks a running Pi (CLAUDE.md).
**How to avoid:** Run every test from a snapshot. Swap `dist` only after `pgrep` shows no Pi and `.agent-lab/.lock` is absent, as 01-10 did [CITED: 01-10-SUMMARY.md «dist swap by rename … after pgrep and lock checks»].

### Pitfall 10: Two pi-tui copies
**What goes wrong:** `extensions/*` import the top-level `@earendil-works/pi-tui`, while Pi's hosts use their nested copy. `instanceof Box` checks inside Pi (`renderContainer instanceof Box`) apply only to Pi's own containers. Our components are duck-typed through `render(width)`, so they work (spike B).
**How to avoid:** Never rely on `instanceof` across the two copies. Do not call nested pi-tui globals such as `setKeybindings` from tests and expect Pi's `keyHint` to change.

### Pitfall 11: Collapsed block too tall for the demo
**What goes wrong:** Phase-2 `resultViewRows` adds one `?` row per unmeasured situation (up to 20).
**How to avoid:** The collapsed block keeps only `lead`/`line` rows; the `?` rows appear only when expanded. Check that the collapsed block of `fae4ee59`, `a92fd6ae` and `61521e0d` at 100 columns is ≤ 20 rows.

## Code Examples

### Hosts in `agent-lab.ts`
```ts
// Source: installed types.d.ts (renderResult, registerEntryRenderer, appendEntry) + spike B
pi.registerEntryRenderer<VerdictDetails>('agent-lab-verdict', (entry, options, theme) => {
  if (!isVerdictDetails(entry.data)) return undefined;             // unknown/old data: draw nothing
  try {
    const box = new Box(1, 1, s => theme.bg('customMessageBg', s));
    box.addChild(new VerdictBlock(entry.data.view, options.expanded, theme, () => keyHint('app.tools.expand', 'подробнее')));
    return box;
  } catch (error) { return new Text(theme.fg('error', safeText(`Блок не нарисован: ${error instanceof Error ? error.message : error}`)), 0, 0); }
});
const toolDisplay: Pick<ToolDefinition, 'renderCall' | 'renderResult'> = {
  renderCall: (_args, theme) => new Text(theme.fg('accent', 'Проверка агента'), 0, 0),
  renderResult: (result, options, theme) => {
    try {
      const details = result.details as unknown;
      if (isVerdictDetails(details)) return new VerdictBlock(details.view, options.expanded, theme, () => keyHint('app.tools.expand', 'подробнее'));
      if (options.isPartial && isProgressDetails(details)) return progressComponent(details.progress, theme);
      return legacyResult(result, options, theme);                  // today's JSON renderer, unchanged
    } catch { return new Text(safeText(textOf(result)), 0, 0); }
  },
};
```

### Host-parity test (proves the same block from both paths, with real Pi themes)
```ts
// test/verdict-block.test.ts — public API only, except the entry host deep import (optional)
import { initTheme, ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
for (const name of ['dark', 'light']) {
  initTheme(name, false);
  for (const width of [40, 60, 80, 100, 160]) {
    let captured: Theme | undefined;
    const tool = { ...agentRunDefinition, renderResult: (r, o, t) => { captured = t; return toolDisplay.renderResult!(r, o, t, ctx) } };
    const row = new ToolExecutionComponent('agent_lab_run', 'c1', {}, {}, tool, { requestRender() {} } as never, '/tmp');
    row.updateResult({ content: [{ type: 'text', text: '{"shownToOwner":"…"}' }], details: verdictDetails, isError: false } as never);
    const toolLines = row.render(width);
    const entryLines = entryRenderer({ type: 'custom', customType: 'agent-lab-verdict', data: verdictDetails, id: 'e', parentId: null, timestamp: '' }, { expanded: false }, captured!)!.render(width);
    const text = (ls: string[]) => ls.map(l => stripTerminalSequences(l).trim()).filter(l => l && l !== 'Проверка агента');
    assert.deepEqual(text(toolLines), text(entryLines));
    for (const l of [...toolLines, ...entryLines]) assert.ok(visibleWidth(l) <= width);
    assert.ok(!text(toolLines).some(l => l.includes('shownToOwner')));   // renderer did not fall back
  }
}
```

### Cheap live progress check (≤ $0.5; run once, by the executor, after budget GO)
**Method:** a script loads `extensions/agent-lab.ts` **from a snapshot** that has its own built `dist`. It registers the tools with a fake `pi`, and calls `agent_lab_repeat` then `agent_lab_run` with a fake TUI `ctx` whose `cwd` is the worktree, so data goes to the real `.agent-lab`. It records every `onUpdate` and `setStatus` call with timestamps.
```bash
# 0. preconditions (abort on any hit): no Pi, no lock, mock server up, git of aigw-local untouched
pgrep -fl "pi-coding-agent|node_modules/.bin/pi" ; test ! -e .agent-lab/.lock
node .planning/phases/01-odno-chestnoe-chislo/live-check.mjs budget --reference 800c713c-… --ledger ~/agent-lab-evidence/phase-04/ledger.txt --next run --cap 1
# 1. snapshot with dist
SNAP=$(bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh --keep test/progress.test.ts | sed -n 's/^SNAP=//p')
# 2. run the capture (script written in plan; prints counts/texts only, no dialogue text)
(cd "$SNAP" && npx tsx .planning/phases/04-ekran-rezultata-v-pi/live-progress-check.mts \
   --cwd /Users/kikov/conductor/workspaces/conductor-playground/lyon --source 61521e0d-… --case <scenarioId> --cap-usd 0.5 \
   --out ~/agent-lab-evidence/phase-04/live-progress.json)
node .planning/phases/01-odno-chestnoe-chislo/live-check.mjs spent --ledger ~/agent-lab-evidence/phase-04/ledger.txt --cap 1
pgrep -fl "live-progress-check" || echo "nothing left"
```
The script body:
1. `const reg = registered()` (same fake `pi` as `test/extension.test.ts:20-39`), plus `appendEntry` and `registerEntryRenderer` stubs.
2. `ctx = { cwd, hasUI: true, mode: 'tui', signal: controller.signal, model: undefined, sessionManager: { getEntries: () => [] }, ui: { confirm: async () => true, setStatus: (k, t) => log.push({ at: Date.now(), k, t }), notify() {}, select: async () => undefined, editor: async () => undefined } }`.
3. `repeat = await tools.get('agent_lab_repeat').execute('c0', { id: source, scenarioIds: [caseId] }, undefined, undefined, ctx)`.
4. `run = await tools.get('agent_lab_run').execute('c1', { id: repeat.details.id, expectedHash: repeat.details.draftHash }, controller.signal, u => updates.push({ at: Date.now(), text: u.content[0].text, details: u.details }), ctx)`.
   - A watchdog aborts `controller` when a progress update shows `costUsd > capUsd`.
   - Phase 2's `requireAccepted` path accepts the expectations through the same `confirm` stub.
5. Assert and print:
   - at least 3 distinct progress texts;
   - the first contains `оцениваю…`;
   - every one contains `(оценка)` or `стоимость неизвестна`;
   - the median gap between updates is ≤ 1.5 s while active;
   - the last `setStatus` for `agent-lab-progress` is `undefined`;
   - `run.details.kind === 'agent-lab/verdict'`;
   - spent ≤ $0.5.

Cost basis: the phase-1 single-situation control runs cost $0.1663 and $0.1653, with 11 and 10 calls [CITED: 01-10-SUMMARY.md evidence table]. Pick the situation from a stored run with `live-check.mjs record` (A7).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `renderResult` parses JSON out of `content` | `renderResult` reads `details` (Pi passes `details` for partial and final results and persists them) | Pi 0.85.1 (installed) | The model text and the UI are decoupled |
| Command path shows no chat block (only a `setStatus` pointer) | `appendEntry` + `registerEntryRenderer` | Pi 0.85.1 | The block stays in history, is not in the model context, and is redrawn on reopen |
| 3 board sections, key `3` = dialogues | Tabbed board with state-dependent tab sets | Phase 4 | Pointer strings must follow |

**Deprecated/outdated:**
- `toolDisplay.renderResult` JSON parsing: kept only as the legacy fallback.
- Board text «ЧТО ТРЕБУЕТ ВНИМАНИЯ»: removed in phase 2 (02-05).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Phase 2 exposes `resultViewRows` roles `lead \| line \| situation \| detail`, `causeSection` rows with a `cause` role, `SECTION_TEXT`, `allFailuresPointer`, and `ResultView.failures` / `topCauses` exactly as the 02-04 plan says [ASSUMED: from the plan text, the code is not written yet] | Patterns 1, 2 | Collapsed-row filter and cause lines need renaming |
| A2 | Phase 3 exposes `view.agreement` with enough fields to count unmarked queue items (Q_fail, S and marked counts) [ASSUMED: 03-RESEARCH Pattern 4 lists `failures`, `passes`, `sampledPasses`, but not Q_fail directly] | Pattern 2 rule #2 | «Дальше» rule 2 needs an extra field (`queue.unmarked`) in phase 3 or phase 4 |
| A3 | When the control is *unmeasured*, the verdict line should say «Числу пока не верить: контроль не измерен», not «не пройден» [ASSUMED: CONTEXT names only «не пройден»; 56fed0b made the warning distinguish the two] | Pattern 2 | Wording mismatch between the verdict line and the warning row |
| A4 | Rules 0 (running) and 3 (M = 0) of «Дальше» and their texts [ASSUMED: CONTEXT gives no rule for these states] | Pattern 2 | Owner confirmation of wording |
| A5 | The phase-2 explanation carries the cited reply seq in a readable field (e.g. `said.seq`) and the trial id [ASSUMED: plan text shows `Сказал (реплика #<seq>)`; the field name is unknown] | Pattern 5 | Jump implementation reads the field under another name |
| A6 | Reassess and score run trials sequentially (parallel 1) [ASSUMED: the reassess loop at src/experiment.ts:826-851 looks sequential; not traced fully] | Pattern 8 | ETA is off by the parallel factor for reassess |
| A7 | The situation for the live progress check can be any situation of a stored acquiring run; phase 1 suggests the only passed situation in `a92fd6ae` [ASSUMED] | Code Examples | Only cost/time differ |
| A8 | Comparison glyphs `+ - * /` and wording [ASSUMED: design proposal for the UI-SPEC step] | Pattern 6 | UI-SPEC may pick others |
| A9 | Append the entry only after state-changing board actions, not on every open [ASSUMED: CONTEXT does not say] | Pattern 3 | Owner may expect a block on every open |
| A10 | Draft tabs `1 Итог · 2 Ситуации`, run tabs `1–4`; keys `3/4` inert on drafts [ASSUMED: discretion per CONTEXT] | Pattern 4 | Minor |

## Open Questions (RESOLVED)

1. **RESOLVED — Does phase 3 publish an «unmarked queue» count in `ResultView`?**
   - Resolution: the counts are derived from the published `JudgeAgreement` fields (`unmarked`, `queueFailures`, `sampledPasses`, `marks`) inside `src/verdict.ts` (plan 04-01, Task 2); `src/agreement.ts` is not changed.
   - What we know: F11 counts x/Q_fail and y/S, and `judgeAgreement` holds the groups.
   - What's unclear: whether Q_fail and S live in `view.agreement`.
   - Original recommendation (superseded by the resolution): add `agreement.queue` in `src/agreement.ts` if phase 3 did not publish the counts.
2. **RESOLVED — A live «исправлено / сломано / нестабильно» example.**
   - Resolution: the only live comparable pair (`fae4ee59` → `61521e0d`, same agent) has 0 flips. «Исправлено», «сломано» and «нестабильно» are proven by unit fixtures only (plans 04-04, 04-05); the live check (04-09) shows «без изменений» / «несравнимо» and records any flip as a note; no paid run is made to create one.
   - What we know: the only comparable live pair (`fae4ee59` → `61521e0d`) has 0 flips and the same agent. Out of scope: «Исправленная версия агента для «до и после»».
   - What's unclear: whether the demo needs a visible flip.
   - Recommendation: unit fixtures cover all five codes. The live check verifies «без изменений» / «несравнимо». Record a flip only if a later repeat produces one; do not buy one.
3. **RESOLVED — Which old runs does the phase-2 protocol change make incomparable?**
   - Resolution: measured, not assumed. Plan 04-04 (Task 2) records the `situationChanges` counts and the K1 row of the stored pair after phase 2 lands, and `render-matrix.mts` (04-09) prints the comparison counts again; whatever they show is written to the SUMMARY.
   - What we know: `compareRuns` compares the recorded judge identities of both records, so `fae4ee59` → `61521e0d` (both v10) stays comparable [VERIFIED: comparison.ts `judgeIdentities` read from each record's trials].
   - Recommendation: the render-matrix script prints the comparison counts for that pair after phase 2 lands.
4. **RESOLVED — Session file permissions (0644) hold block quotes.**
   - Resolution (orchestrator decision, revision 1; CLAUDE.md «Data»): session `details` and entries hold only `{ kind, version, runId, resultKey }`, with no text. Both renderers take the view from an in-memory cache or rebuild it synchronously from the 0600 record in `.agent-lab` (same guards as `store.get`); a missing or unreadable record shows a short honest row (plans 04-01, 04-03). The `details` recommendation in Pattern 1 and Pattern 3 above is superseded by this, and so is the V8 row of the Security section below.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | tests, scripts | ✓ | v22.22.3 | — |
| npm | snapshot build | ✓ | 10.9.8 | — |
| Pi CLI (`node_modules/.bin/pi`) | pty reopen and board checks | ✓ | 0.85.1 | Component-level spike (A) only |
| `script(1)` | pty harness | ✓ | macOS `/usr/bin/script` | — |
| `timeout` | bounded pty runs | ✓ (used this session) | coreutils | `perl -e alarm` |
| `aigw-local` mock server | cheap live progress run | not probed (must not touch its repo) | — | Skip the live check; mock-timer tests only (the verifier marks it human_needed) |
| OpenRouter balance | live check (~$0.17) | not probed | — | Same as above |
| `@xterm/headless` | — | ✗ (not installed) | — | Not needed |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** the live `aigw-local` run, which must be confirmed up before the paid step.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node test runner via `tsx --test` (tsx ^4.20), TypeScript 5.9.3 |
| Config file | none (`package.json` scripts) |
| Quick run command | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh <test files>`: working-tree snapshot, `tsc`, then `tsx --test` [VERIFIED: snap-test.sh] |
| Full suite command | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh --full`: `git archive HEAD`, `npm test && npm run typecheck` |
| Never | `npm test` / `npm run build` in the worktree |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SCREEN-01 | Verdict and «Дальше» vectors; collapsed rows order; no jargon; no `…`; words preserved | unit | `snap-test.sh test/verdict.test.ts` | ❌ Wave 0 |
| SCREEN-01 | Block rows from stored-run views (`fae4ee59`, `a92fd6ae`, `61521e0d`) ≤ 20 rows collapsed at 100 columns | read-only script | `npx tsx .planning/phases/04-ekran-rezultata-v-pi/render-matrix.mts --id … ` (from snapshot) | ❌ Wave 0 |
| SCREEN-02 | Same block text through `ToolExecutionComponent` and the entry renderer; legacy `details` → legacy renderer; renderer never throws; `resultKey` dedupe; `appendEntry` once after a board run | unit + integration | `snap-test.sh test/verdict-block.test.ts test/extension.test.ts` | ❌ / ✅ extend |
| SCREEN-02 | Real Pi reopen: crafted session with real `VerdictDetails` from a stored run → both blocks visible; Ctrl+O expands both; light and dark | pty script (free, offline) | `bash .planning/phases/04-ekran-rezultata-v-pi/pi-reopen-check.sh` | ❌ Wave 0 |
| SCREEN-03 | Tab sets per state; `1–4`, Tab and Shift+Tab cycle; draft `2` = Ситуации with `y`/`e` intact; phase-3 `y`/`n`/`s` in Провалы and Диалоги | unit | `snap-test.sh test/cards.test.ts` | ✅ extend |
| SCREEN-03 | Real board keys: `/agent-lab demo` → `r` → Enter → `1` `2` `3` `4` Tab Shift+Tab → screens show the tab labels | pty script (free) | `bash .planning/phases/04-ekran-rezultata-v-pi/board-pty-check.sh` | ❌ Wave 0 |
| SCREEN-04 | Enter on a failure → Диалоги, same trial, `selectedBg` exactly on the cited reply rows (recording theme), the anchor row visible at height 20, Esc → back to Провалы with the same selection; F10 order evidence → judge | unit | `snap-test.sh test/cards.test.ts` | ✅ extend |
| SCREEN-05 | `situationChanges` over all codes (fixed, broken, unstable, same, 8 incomparable reasons, rebuilt source with and without identity, controls excluded); `unstable` equals `view.stability.unstable`; no source → words | unit | `snap-test.sh test/comparison.test.ts test/result-view.test.ts` | ✅ extend |
| SCREEN-06 | `progressView` vectors with explicit `now` (0 done → «оцениваю…», avg and parallel math, null cost, demo, 1 h+); tool loop with `t.mock.timers` ticking 1 s: dedupe, ≥ 1 update per active second, `setStatus` cleared in `finally` even on error or abort | unit | `snap-test.sh test/progress.test.ts test/extension.test.ts` | ❌ / ✅ extend |
| SCREEN-06 | One live single-situation run on `aigw-local` ≤ $0.5 capturing updates and status | live (paid, once) | `live-progress-check.mts` (Code Examples) | ❌ Wave 0 |
| SCREEN-07 | Render matrix: block, all tabs, progress header × widths 40/60/80/100/160 × fake light/dark themes (distinct ANSI) with 600-char Cyrillic quotes: no line wider than width, no `…` produced (except the sidebar), words preserved, only allowed tokens; lint test that `extensions/render/**` has no `.slice(`/`padStart(`/`padEnd(` on text | unit | `snap-test.sh test/theme.test.ts test/verdict-block.test.ts test/cards.test.ts` | ❌ / ✅ |
| SCREEN-07 | Real Pi themes (`initTheme('dark' \| 'light')`) through `ToolExecutionComponent` at the same widths | unit | `snap-test.sh test/verdict-block.test.ts` | ❌ Wave 0 |
| SCREEN-07 | Human: screenshots in one light and one dark theme at projector size | manual | — | human item |

### Sampling Rate
- **Per task commit:** `snap-test.sh <3–5 touched test files>`.
- **Per wave merge:** `snap-test.sh` with no arguments (all tests plus the extension typecheck), then `snap-test.sh --full` after committing.
- **Phase gate:** the full suite is green, plus:
  - `pi-surface-check.mts` `OK` on the stored runs; update it deliberately so it skips the new first verdict row when comparing block lines;
  - `pi-reopen-check.sh` and `board-pty-check.sh` pass with no Pi left running;
  - `render-matrix.mts` prints `over=0 ellipsis=0`;
  - the live progress check is done or marked human_needed.

### Wave 0 Gaps
- [ ] `test/verdict.test.ts`: covers SCREEN-01.
- [ ] `test/verdict-block.test.ts`: covers SCREEN-02 and SCREEN-07 (real themes, host parity).
- [ ] `test/progress.test.ts`: covers SCREEN-06.
- [ ] `test/theme.test.ts`: covers SCREEN-07 (wrapRows with anchor/bg, bar, pickTier, lint).
- [ ] `.planning/phases/04-ekran-rezultata-v-pi/pi-reopen-check.sh`: builds a session file from a stored run's `evidenceBundle` view (print ids and counts only), runs the real Pi in `script` with `PI_CODING_AGENT_DIR=<tmp>`, `PI_OFFLINE=1`, `-ne -e extensions/agent-lab.ts --no-skills -nc --no-prompt-templates`, greps the stripped output for the verdict line twice, sends `\017`, greps for an expanded-only row, and ends with a `pgrep` check. It must run from a snapshot with its own `dist`, and the session file must go into a `mktemp -d` that is deleted afterwards (it contains bank quotes).
- [ ] `.planning/phases/04-ekran-rezultata-v-pi/board-pty-check.sh`: the demo board key walk (spike C recipe) in a `mktemp -d` cwd.
- [ ] `.planning/phases/04-ekran-rezultata-v-pi/render-matrix.mts`: stored runs at the widths and themes above; prints counts only.
- [ ] `.planning/phases/04-ekran-rezultata-v-pi/live-progress-check.mts`: the paid, capped live check.
- Framework install: none.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no (Pi session files are chat history, not auth sessions) | — |
| V4 Access Control | yes | Agreement marks only from board keys (phase 3). The model has no tool that writes marks or appends verdict entries; `appendEntry` is called only by code paths after state changes. |
| V5 Input Validation | yes | Every record, model and human text goes through `safeText` inside `renderRows`. `details` are type-guarded (`isVerdictDetails`) before rendering; unknown shapes are never trusted. |
| V6 Cryptography | no | `resultHash` / `fingerprint` exist already (not security use) |
| V7 Error Handling and Logging | yes | Renderer errors are shown in words, not raw stacks; the progress `setStatus` is cleared in `finally` |
| V8 Data Protection | yes | (Revised per Open Question 4, RESOLVED: `VerdictDetails` hold only `{ kind, version, runId, resultKey }`; the view is rebuilt from the 0600 record.) Original note: `VerdictDetails` held the view (verdict, counts, cause titles, cited quotes), with no transcripts, `proofs` or trace. Pi writes session files as 0644 (observed: `-rw-r--r--` on the spike session file); `appendFileSync` is used without a mode [VERIFIED: dist/core/session-manager.js:745,766]. Today's `details: output` already stores more than that. Phase-4 verification scripts must write session files only under `mktemp -d` and delete them. |

### Known Threat Patterns for Pi extension rendering

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Terminal escape injection via quotes, reasons or titles | Tampering | `safeText` (strips ANSI and bidi controls) [VERIFIED: extensions/cards.ts:11-14] at the single render boundary |
| Forged or old `details` shaped like a verdict | Spoofing | `kind` + `version` guard; the legacy renderer for everything else |
| Bank quotes leaking via session files, pty logs or evidence copies | Information disclosure | Minimal details; verification scripts print ids and counts only; temp dirs deleted; evidence under `~/agent-lab-evidence/phase-04/` with 0700/0600 |
| The model restating or altering the verdict | Repudiation / integrity | The block is drawn from data; the model gets `shownToOwner`; system prompt and skill updated not to restate |
| Runaway paid live check | Denial of wallet | `live-check.mjs budget` GO before the run; a watchdog abort at $0.5; `spent` after |

## Sources

### Primary (HIGH confidence)
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`: `renderResult`, `ToolRenderResultOptions`, `EntryRenderer`, `appendEntry`, `setStatus`, `setWidget`, `custom`.
- `…/dist/modes/interactive/components/tool-execution.js`, `custom-entry.js`, `footer.js`, `keybinding-hints.js`.
- `…/dist/modes/interactive/interactive-mode.js`: `entry_appended`, `tool_execution_update`, `renderSessionEntries`/`Items`, `setToolsExpanded`, `MAX_WIDGET_LINES`.
- `…/dist/core/session-manager.js` (`buildContextEntries`, `appendCustomEntry`); `…/dist/core/agent-session.js` (`appendEntry` → `entry_appended`); `…/dist/core/keybindings.js`.
- `…/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` (`onUpdate` → `tool_execution_update`).
- `node_modules/@earendil-works/pi-tui/dist/index.d.ts`, `utils.d.ts`, `terminal.d.ts`, `components/scroll-view.d.ts`; `matchesKey` checked live.
- Repo: `extensions/cards.ts`, `extensions/agent-lab.ts`, `src/result-view.ts`, `src/comparison.ts`, `src/artifacts.ts`, `src/experiment.ts`, `src/contracts.ts`, `test/cards.test.ts`, `test/extension.test.ts`, `test/skill.test.ts`, `skills/agent-builder/SKILL.md`, `package.json`.
- Live spikes A, B and C (this session, scratch copy, offline, no paid calls).

### Secondary (MEDIUM confidence)
- `.planning/phases/02-*/02-UI-SPEC.md`, `02-04/05/08-PLAN.md` (interfaces not yet in code).
- `.planning/phases/03-*/03-UI-SPEC.md`, `03-RESEARCH.md`, `03-CONTEXT.md`.
- `.planning/phases/01-*/01-10-SUMMARY.md`, `01-REVIEW.md`, `01-REVIEW-FIX.md`.
- `.planning/research/STACK.md`, `ARCHITECTURE.md` (partly superseded: ARCHITECTURE suggested `sendMessage` + `registerMessageRenderer`; CONTEXT and STACK chose `appendEntry`), `PITFALLS.md`.
- `node_modules/@earendil-works/pi-coding-agent/docs/environment-variables.md`.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Rendering hosts and reopen: HIGH. Installed code was read, and two live spikes, one of them a real Pi process, confirmed it.
- Board split, keys and jump: MEDIUM-HIGH. The current code was read; the phase-2/3 changes are planned but not written.
- Comparison design: MEDIUM. It depends on how `compareRuns` and the stability code evolve after the phase-2 protocol change.
- Progress: HIGH for the data sources, MEDIUM for the ETA formula (a design choice).
- Pitfalls: HIGH. Most were observed this session.

**Research date:** 2026-09-17
**Valid until:** 2026-09-21 (demo). Pi is pinned at 0.85.1.
