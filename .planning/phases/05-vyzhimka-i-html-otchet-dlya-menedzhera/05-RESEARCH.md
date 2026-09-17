# Phase 5: Выжимка и HTML-отчёт для менеджера - Research

**Researched:** 2026-09-17
**Domain:** Plain-text and single-file HTML renderers over `ResultView`, a deterministic PII redactor, and delivery through the clipboard and files in Pi 0.85.1
**Confidence:** HIGH for code facts, Pi API and measurements. MEDIUM for the size estimate of the new report (arithmetic from measured maxima) and for redactor false-positive rates (small real sample).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Выжимка (SHARE-01)
- Одна команда в Pi (`/agent-lab share <id>` или действие на доске) и CLI `agent-lab share --id RUN` выдают выжимку до ~15 строк и ~900 символов. Состав:
  - вердикт (шаблон фазы 4);
  - число и оговорка о малой выборке;
  - «Не измерено: K — причина»;
  - три главные причины, по одной строке: «должен был X — правило N»;
  - согласие владельца «N из M»;
  - «Контроль: …»;
  - дата, версия агента, судья;
  - строка «Подробности — в HTML-отчёте».
- Нет ANSI, псевдографики и эмодзи. Можно только ✓ и ✗ — их нормально показывают мессенджеры.
- Доставка: всегда пишется файл `<id>.summary.txt` (права `0600`, папка `.agent-lab/exports/`). В Pi текст ещё копируется в буфер обмена (`copyToClipboard` в try/catch); если буфер недоступен, текст показывается в `ctx.ui.editor` для ручного копирования. CLI печатает текст и путь к файлу.
- В выжимке «для заказчика» нет цитат клиента. Реплика агента («сказал Y») тоже не цитируется: причина описывается через ожидание и правило владельца. Цитата правила владельца допустима: это материал владельца, не данные клиента. Всё прогоняется через маскировщик.

#### HTML-отчёт для менеджера (SHARE-02)
- Одна команда (`agent-lab export --id RUN --format manager` и то же действие в Pi) создаёт **один файл**:
  - размер до 200 КБ;
  - без JavaScript, без внешних ресурсов (ни одного `http(s)://` в `src`/`href` ресурсов);
  - строгая CSP;
  - встроенный CSS; полосы — встроенный SVG или CSS;
  - раскрытие подробностей через `<details>`;
  - `prefers-color-scheme` и `@media print`;
  - шрифты — системный стек, кириллица проверяется в Segoe UI.
- Первый экран: вердикт, число с оговоркой, «не измерено», три причины, согласие, контроль. Ниже:
  - все провалы в виде «должен был X → правило N» — без сырой реплики клиента; реплика агента только замаскированная, в свёрнутом `<details>`;
  - сравнение с прошлым прогоном, если оно есть;
  - «как считали» (одним абзацем простыми словами);
  - шапка: дата и время по МСК, версия агента, размер набора, судья, стоимость (оценка).
- Жаргона нет: никаких id метрик, «рубрики», «протокола», «unknown».
- Существующий `htmlReport` остаётся полным аудиторским отчётом (SHARE-04).

#### Маскирование и профиль «для заказчика» (SHARE-03)
- Детерминированный маскировщик `src/redact.ts`. Что заменяется:
  - номера карт (13–19 цифр, проверка Луна) → «•••• 1234»;
  - 20-значные счета;
  - ИНН (10/12 цифр);
  - телефоны РФ;
  - e-mail;
  - внутренние адреса и хосты (`*.local`, `*.corp`, `10.x`, `192.168.x`, `http(s)://` на внутренние домены);
  - длинные последовательности цифр от 8 знаков.
- Маскировщик применяется ко **всему** тексту выжимки и отчёта «для заказчика», включая названия ситуаций, ожидания и цитаты правил.
- Сырые реплики клиента (события `user`) в профиль «для заказчика» не попадают никогда. Названия ситуаций и ожидания пишутся по мотивам диалога, поэтому тоже маскируются.
- Тест на сохранённых прогонах эквайринга. В выжимке и HTML нет:
  - ни одной подстроки длиной от 20 символов из реплик клиента;
  - ни одного совпадения шаблонов персональных данных.

#### Полный отчёт для аудита (SHARE-04)
- Полный отчёт (текущий `htmlReport` / markdown / json) остаётся доступен владельцу. На первом экране у него крупная плашка «Не пересылать: внутри реплики клиентов и полные ответы агента».
- Имена файлов разные: `<id>.manager.html` для заказчика и `<id>.audit.html` для аудита. В Pi при выгрузке по умолчанию предлагается файл для заказчика.

#### Проверка фазы без человека
- Рендер на сохранённых прогонах: `fae4ee59`, демо-прогон после фазы 2 и прогон с согласием (копия) — без платных вызовов. Проверки:
  - размер файла;
  - отсутствие `<script`, `http(s)://` ресурсов и жаргона;
  - маскирование;
  - время по МСК;
  - одинаковость числа с `ResultView`.
- Внешний вид в браузере и при печати — пункт для человека. Проверить автоматически можно открытие файла в headless-браузере, если он есть локально. Если нет — пункт для человека.

### Claude's Discretion
- Точная вёрстка HTML, формулировки абзаца «как считали», имена команд и флагов, структура `src/render/html.ts` и `src/render/text.ts`.

### Deferred Ideas (OUT OF SCOPE)
- Раздел «Прод рядом с тестом» — прод отложен.
- Ссылки на хостинг и веб-приложение — вне продукта.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SHARE-01 | Выжимка до ~15 строк: вердикт, число, три причины, «не измерено», согласие; буфер обмена и файл | Pattern 1 (`shareText`), Pattern 4 (delivery, `copyToClipboard` behaviour), Pitfalls 3, 4 |
| SHARE-02 | Один HTML до 200 КБ, без Pi, интернета и JS, аккуратно на экране и при печати, с датой, версией, размером набора и судьёй | Pattern 2 (`managerReport`), size measurements, MSK formatter, font stack, headless Chromium check |
| SHARE-03 | Нет сырых реплик клиента; карты, счета, ИНН, телефоны, почта, внутренние адреса замаскированы | Pattern 3 (`redact` + overlap guard), measured title leaks, leak test design |
| SHARE-04 | Полный отчёт для аудита доступен и помечен «не пересылать» | Pattern 5 (banner, file names, Pi default) |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Everything happens inside Pi. The HTML report is only a file to forward: no server, no hosting links.
- The demo is on Monday 2026-09-21. Work in customer-visible order.
- Every phase ends with an observable result on the real acquiring agent. For this phase that means rendering stored acquiring runs; no paid calls are needed.
- Stack: TypeScript ESM, Node >= 22.19, `strict`, zod 4, typebox, Pi SDK and `pi-tui` 0.85.1. **No new runtime dependency without an explicit reason.** None is needed here.
- User-facing strings and docs are in Russian. Code, identifiers and commands are in English.
- Old JSON records must open and re-render without migration. The manager report must work on `fae4ee59`, `a92fd6ae` and `61521e0d` as they are.
- Source of truth: JSON records and events. The renderers compute nothing new; they word `ResultView`.
- Bank dialogues stay local (`.agent-lab`, mode `0600`) and never enter the repo, commits, web searches or test fixtures. Tests over stored runs print ids and counts only.
- Never run `npm test` or `npm run build` in the worktree: they delete `dist/`, which the live Pi extension imports. Use `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh`. Check `git status` and `git log` before editing, because other sessions share this worktree.
- Don't touch `aigw-local` git during runs.
- Conventions: `.js` import extensions; pure functions return raw text and escaping happens at the output boundary; plain `Error` with Russian user messages; tests in `test/<module>.test.ts`; `pluralForm` for every count.

## Summary

Both customer materials are **pure renderers of the finished `ResultView`**. By the time phase 5 runs, that view has the headline (phase 1), `failures` and `topCauses` (phase 2), `agreement` (phase 3), and `verdictLine`/`nextStep` plus `changes` (phase 4). Phase 5 adds three pure modules and wires them in:
- `src/redact.ts`: a PII masker plus a guard that removes overlap with client turns;
- `src/render/text.ts`: `shareText(view, meta, guard)`;
- `src/render/html.ts`: `managerReport(bundle)`.

On top of that, phase 5 wires `share` / `export --format manager` into the CLI, and a share/export choice on the board's existing `x` key. `htmlReport` becomes the audit report. It gets a «Не пересылать» banner and the file name `<id>.audit.html`.

The most important measurement is this: **masking alone does not satisfy SHARE-03.** Scenario titles on the stored acquiring runs contain verbatim 20+ character stretches of client turns:
- `fae4ee59`: 6 of 13 titles;
- `a92fd6ae`: 13 of 15;
- `61521e0d`: 7 of 13.

These titles still leak after owner-material text is allowlisted and after quoted «…» parts are stripped. Cause names and descriptions leak in `61521e0d` (3 of 12), and judge rationales leak too (3/52 and 8/56). By contrast, `successCriteria` (the «Должен был» text) and owner rule quotes leak in **0** cases. The PII patterns found **no** hits in client turns: the pilot data is already masked. Every digit-run and 13–19-digit hit in today's HTML comes from our own UUIDs and hashes, so the redactor must use letter/digit boundaries and must never run over ids.

So the customer profile needs two passes on every string drawn from the record:
1. `redact()` masks PII.
2. `guard.cut()` replaces any 20-character window shared with a client turn by «…», ignoring windows that also occur in owner sources. A title with fewer than 25 characters left falls back to `Ситуация <n>`.

Today's full report is 387–598 KB on the stored runs (30–46 KB per dialogue). The new report, built from measured field maxima, comes to about 60 KB typical and at most ~100 KB for 15 situations and 60 dialogues, because it shows one explanation per situation, not every dialogue. `copyToClipboard` is exported from the package root of the installed Pi 0.85.1. It tries a native addon, then pbcopy/clip/wl-copy/xclip, then OSC 52, and throws only when all of them fail. The local Playwright `chrome-headless-shell` 151 can print the report to PDF offline and reports CSP violations on stderr, so the open/print check can be automated.

**Primary recommendation:** Build `redact.ts` (with a customer-text guard) first, then `shareText` and `managerReport` as pure functions of `EvidenceBundle.view` that run every record-derived string through the guard. Then wire `share`, `export --format manager` and the `x` choice. Prove the result with a stored-run script: size, no `<script`, no resource URLs, no jargon, no PII, no 20-character client overlap, MSK time, and a number equal to `ResultView`. Finish with a headless Chromium print.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Result numbers, causes, agreement, comparison | Domain (`src/result-view.ts`, `explain.ts`, `agreement.ts`, `comparison.ts`) | — | Already computed upstream; phase 5 must not recount |
| PII masking and client-overlap guard | Domain utility (`src/redact.ts`) | — | Pure and deterministic; shared by text, HTML and tests |
| Text summary wording | Renderer (`src/render/text.ts`) | — | Pure; used by CLI and Pi alike |
| Manager HTML | Renderer (`src/render/html.ts`) | — | Pure string template; escaping at its own boundary |
| Audit HTML with banner | Renderer (`src/report.ts`) | — | Existing full report |
| File writing (`0600`, atomic replace) | Storage/IO (`src/artifacts.ts`) | — | The one place that writes `exports/` |
| Clipboard, editor fallback, notify, open | Pi extension (`extensions/agent-lab.ts`) | — | Only Pi has `copyToClipboard` and `ctx.ui` |
| `share`, `export --format manager` | CLI (`src/cli.ts`) | — | Non-interactive path; prints text and path |

## Standard Stack

### Core (all already installed; no new packages)
| Library / API | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `copyToClipboard(text): Promise<void>` from `@earendil-works/pi-coding-agent` | 0.85.1 | Copies the summary in Pi | Root export: `dist/index.d.ts:30` `export { copyToClipboard } from "./utils/clipboard.ts";` [VERIFIED: node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts:30]. The package `exports` has only `"."`, so import from the root, never from `dist/utils/...` [VERIFIED: package.json exports `{".":{"types":"./dist/index.d.ts","import":"./dist/index.js"}, …}`] |
| `ctx.ui.editor(title: string, prefill?: string): Promise<string \| undefined>` | 0.85.1 | Fallback when the clipboard fails | [VERIFIED: dist/core/extensions/types.d.ts:135] |
| `ctx.ui.select(title: string, options: string[], opts?)` | 0.85.1 | Choice on `x`: manager (first, default) / summary only / audit | [VERIFIED: types.d.ts:70] |
| `ctx.ui.notify(message, type?: "info" \| "warning" \| "error")` | 0.85.1 | «Выжимка скопирована…» | [VERIFIED: types.d.ts:76] |
| `Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', … })` | Node 22.22.3, ICU 78.2 | MSK time | Measured output: `16 сентября 2026 г. в 18:40` for `2026-09-16T15:40Z` [VERIFIED: local node run] |
| `escape()` / `plain()` in `src/report.ts` | repo | HTML escaping and stripping of control/bidi characters | `const escape = (value: unknown) => plain(value).replace(/[&<>"']/g, …)`; `plain` strips VT codes and `[\u202a-\u202e\u2066-\u2069]` [VERIFIED: src/report.ts:9-10]. Export them (or move them to `src/render/escape.ts`) and reuse them |
| `pluralForm` | repo | Russian plurals | [VERIFIED: src/result-view.ts:28-31]; phase 2 moves it to `src/plural.ts` and re-exports it |

### Supporting
| API | Purpose | When to Use |
|---------|---------|-------------|
| `node:fs/promises` `writeFile(tmp, content, { mode: 0o600, flag: 'wx' })` + `rename(tmp, final)` | Stable file names that are replaced atomically | `<id>.summary.txt`, `<id>.manager.html`, `<id>.audit.html` |
| `node:zlib` `gzipSync` | Tests only: shows how much a file compresses (optional) | — |
| Playwright `chrome-headless-shell` 151.0.7922.34 (already on disk, not a dependency) | Automated open/print check | Verification script only; optional if the file is absent |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `copyToClipboard` | `clipboardy` | Same behaviour, new dependency. Rejected (CLAUDE.md). |
| String templates | Handlebars/Eta/React SSR | New dependency, no gain for one static page. Rejected. |
| Inline SVG bars | CSS width bars (today's `.bar span{width:%}`) | Both work without JS. SVG prints reliably (backgrounds are often dropped in print unless `print-color-adjust: exact`), so **use SVG `<rect>`**. |
| A ported `details` opener script | `details::details-content` CSS in `@media print` | No script is allowed. The CSS renders the contents in Chromium 151 (verified by screenshot). |

**Installation:** none.

## Package Legitimacy Audit

This phase installs no external packages. `copyToClipboard` comes from the already pinned `@earendil-works/pi-coding-agent@0.85.1`. The headless browser is a Playwright cache binary already on this machine. It is used only in a verification script and is not added to `package.json`.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| — | — | — | — | — | — | No installs |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Measurements (stored acquiring runs, scratch snapshot of HEAD `1574210`)

Method:
- `git archive HEAD` into the session scratchpad;
- symlinked `node_modules`, then `tsc`;
- a read-only `ExperimentStore` over `lyon/.agent-lab`;
- `evidenceBundle` + `htmlReport` rendered in memory.

Only ids and counts were printed. [VERIFIED: scratch run 2026-09-17]

| Run | Phase | Situations | Dialogues | Owner rules / sources | `htmlReport` bytes | per dialogue | gzip | markdown | `<script` | resource `src/href=http` |
|-----|-------|-----------|-----------|------------------|-------------------|-------------|------|----------|-----------|-----|
| fae4ee59 | results_review | 13 | 13 | 44 / 10 (2 prompt) | 387 096 | 29 777 | 40 836 | 144 998 | 1 | 0 |
| a92fd6ae | results_review | 15 | 15 | 44 / 10 | 456 845 | 30 456 | 43 837 | 162 797 | 1 | 0 |
| 61521e0d | results_review | 13 | 13 | 44 / 10 | 598 299 | 46 023 | 58 610 | 146 760 | 1 | 0 |

Older exports without the phase 1 changes reached 3.26 MB (`exports/29dd5210….report.html`, from `ls -la`).

**Client-overlap (≥20 chars, whitespace-collapsed, lowercase) against `user` events plus `record.dialogues` user messages:**

| Run | full HTML | titles | `successCriteria` | `user.goal` | `user.facts` | judge rationales | failure modes (name+desc) | requirement quotes |
|-----|-----------|--------|-------------------|-------------|--------------|-----------|------------|------|
| fae4ee59 | yes | **6/13** | 0/13 | 6/13 | 8/13 | 3/52 | 0/12 | 0/44 |
| a92fd6ae | yes | **13/15** | 0/15 | 13/15 | 10/15 | 8/56 | 0/12 | 0/44 |
| 61521e0d | yes | **7/13** | 0/13 | 7/13 | 9/13 | 0/52 | **3/12** | 1/44 → **0** once owner-source windows are allowlisted |

- The title leak count is unchanged after owner-source windows are allowlisted (6/13/7), and after «…»/"…" segments are stripped (6/12/7). Only 2 titles per run contain quote marks.
- If overlapping 20-character windows are cut out, titles keep 82%, 66% and 83% of their characters. Titles left with fewer than 25 characters: 0/13, 3/15, 1/13.

**PII patterns (counts; candidate regexes in Pattern 3):**
- Client turns: **0** hits in every category on all three runs.
- Agent turns: 1 URL in fae4ee59 and 61521e0d.
- Titles, criteria, rationales, requirement quotes, source names: 0.
- Full HTML: 8+ digit runs 406 / 88 / 453, and 13–19-digit runs that fail Luhn 28 / 0 / 56. **All** of them disappear once UUIDs and hex hashes (≥16 hex) are removed. Private-IP URLs: 4 in a92fd6ae, from connection/error text. Public URLs: 2 / 4 / 4.
- None of the three runs has `targetVersion`, so `view.scope.target` falls back to `targetFingerprint.slice(0, 12)`. Judge model: 1 distinct per run. `usage.costUsd`: about $1.88 / $2.08 / $1.84.

**Estimated manager report size.** Cyrillic takes 2 bytes per character in UTF-8. Per failure the report shows:
- the title (≤160 chars measured);
- «Должен был» (≤494, average 290–381);
- two rule rows (quote ≤301 + source name ≈ 40 each);
- one masked agent reply in `<details>` (average 107–129, maximum 819);
- markup ≈ 500 B.

Per failure that is ≈ (160 + 494 + 682 + 819) × 2 + 500 ≈ **4.8 KB worst case**. The rest of the page:
- 15 failures ≈ 72 KB;
- a situation list of 15 × ~0.5 KB ≈ 7.5 KB;
- comparison 15 × ~0.4 KB ≈ 6 KB;
- CSS ≈ 7 KB;
- header, first screen and «как считали» ≈ 4 KB.

**Worst case ≈ 100 KB, typical ≈ 50–60 KB**, under the 150 KB target and the 200 KB hard limit. Sixty dialogues do not multiply this, because the explanation is per situation. An optional per-dialogue list would add about 60 × 0.3 KB = 18 KB. [MEDIUM: arithmetic from measured maxima; the test fixes it]

## Architecture Patterns

### System Architecture Diagram

```
 .agent-lab/<id>.json ──► ExperimentStore.get ──► evidenceBundle(record, store, beforeId)
                                                        │  (receipts verified, source resolved,
                                                        │   bundle.view = buildResultView(..., {before}))
                                                        ▼
                                   ┌──────────── EvidenceBundle.view (ResultView) ────────────┐
                                   │ headline · notMeasured · control · failures · topCauses │
                                   │ agreement · changes · scope                             │
                                   └───────────────┬───────────────────────┬──────────────────┘
       customerGuard(record) ◄─ user events,       │                       │
       dialogues, owner sources                    ▼                       ▼
         (redact + cut overlap) ──────────► shareText(view, meta, g)  managerReport(bundle, g)
                                                   │                       │  escape() at boundary
                                                   ▼                       ▼
                                        writeExport(<id>.summary.txt)  writeExport(<id>.manager.html)
                                                   │                       │
                         ┌─────────────────────────┼───────────┐           │
                         ▼                         ▼           ▼           ▼
                 Pi: copyToClipboard ──fail──► ctx.ui.editor   CLI: stdout + path   o → open file
                                                                           
 htmlReport(bundle) + banner ──► writeExport(<id>.audit.html) (+ .audit.md, .snapshot.json)   [owner only]
```

### Recommended Project Structure
```
src/
├── redact.ts            # redact(text), customerGuard(record) → { text(s), title(s, n) }, PII_PATTERNS
├── render/
│   ├── escape.ts        # plain(), escape() moved out of report.ts (report.ts re-imports them)
│   ├── time.ts          # mskDateTime(iso) → «16 сентября 2026, 18:40 МСК»
│   ├── text.ts          # shareText(view, meta, guard): string
│   └── html.ts          # managerReport(bundle): string (+ MANAGER_CSS, bar SVG)
├── report.ts            # htmlReport / markdownReport / jsonReport + «Не пересылать» banner
├── artifacts.ts         # exportArtifacts → + manager, summary; writeExport() atomic 0600
└── cli.ts               # share --id; export --format manager
extensions/agent-lab.ts  # x → select; /agent-lab share <id>; clipboard + editor fallback
test/redact.test.ts, test/share.test.ts, test/manager-report.test.ts
.planning/phases/05-…/verify-share.mjs   # stored-run checks, ids and counts only
```

### Pattern 1: `shareText` (SHARE-01)

**What:** a pure function that returns ≤ 15 lines and ≤ 900 characters of plain UTF-8, with no ANSI, box drawing or emoji (only ✓ ✗).

**Shape (line budget, in order):**

| # | Line | Source |
|---|------|--------|
| 1 | `Агент Lab · <agent name or «проверка агента»> · <MSK date, time>` | `record.revisions`/`task`-free name → guard; `mskDateTime(record.createdAt)` |
| 2 | V1 verbatim (`verdictLine(view)`) | phase 4 `src/verdict.ts` (do not reword, 04-UI-SPEC `[P4]`) |
| 3 | `view.headline.text` | phase 1 |
| 4 | `view.headline.smallSample` (if any) | phase 1 |
| 5 | `Не измерено: K — <label>.` (the same wording as `resultViewLines`) | phase 1 |
| 6 | `Главные причины:` | — |
| 7–9 | `<n>. Должен был: <X, shortened> — правило <N>` | `view.topCauses[i].example` (phase 2): X = `successCriteria` → guard → shorten at a word boundary to ≤ 110 chars; N = the first `rules[].number` or the `violated` number; without a rule: `— правило не указано` |
| 10 | agreement: `Владелец согласен с судьёй в N из M проверенных провалов.` (phase 3 F6 wording, reused verbatim) | `view.agreement` |
| 11 | control line (`controlLine` wording, already uses ✓/✗) | phase 1 |
| 12 | `Сравнение: исправлено a · сломано b · нестабильно c` (only when `view.changes`) | phase 4 |
| 13 | `Версия агента: <v> · ситуаций: <n>, диалогов: <m> · судья: <model>` | `view.scope` |
| 14 | `Подробности — в HTML-отчёте <id8>.manager.html` | — |

- **Budget enforcement:** drop lines in this order until ≤ 900 characters: 12, then 4, then the third cause, then the second. Test with `99/99` worst-case vectors.
- **Shortening:** cut at the last space before the limit and add `…`. The phase-2 ban on `…` inside quotes does not apply, because X is not quoted here. The rule is **not** quoted in the summary, only numbered. This also answers the PITFALLS note that verbatim owner rules are bank IP. The HTML may quote them (CONTEXT).
- **Causes:** never use `said` (the agent quote), never `rationale`, never `failureModes.description` without the guard.
- **Numbers:** they come only from `view`. The test asserts that `shareText` contains `view.headline.text` verbatim.

### Pattern 2: `managerReport(bundle)` (SHARE-02)

**Document skeleton:**
```html
<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>Проверка агента · <escaped verdict></title>
<style>/* MANAGER_CSS */</style></head>
<body><main>
<header> Agent Lab · <MSK date> · версия агента · N ситуаций, M диалогов · судья · стоимость ≈ $X </header>
<section class="first">  V1 (h1) · headline + smallSample · SVG bar · Не измерено · Контроль · Согласие </section>
<section> Главные причины (3) </section>
<section> Все провалы: <article> Ситуация n: title → Должен был X → Правило N · источник: «цитата»
          <details><summary>Ответ агента (скрыты личные данные)</summary><p>redacted+guarded reply</p></details></article> </section>
<section> Сравнение с прошлым прогоном (view.changes) </section>
<section> Как считали — one paragraph </section>
<footer> Файл для пересылки: без реплик клиентов. Полный отчёт хранится у владельца. </footer>
</main></body></html>
```

- **CSP:** the policy above, with no `script-src` at all. `default-src 'none'` blocks scripts, fonts, images other than `data:`, frames and connections. It was verified in Chromium 151: an `<img src=https://…>` in a test page was blocked with `violates the following Content Security Policy directive: "img-src data:"` on stderr. [VERIFIED: local headless run]
- **Font stack:** `font: 15px/1.55 "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif`. Name Segoe UI explicitly before `system-ui`. Segoe UI ships with Windows Vista through 11 and supports Cyrillic (script tag `Cyrl`, code page 1251) [CITED: learn.microsoft.com/en-us/typography/font-list/segoe-ui]. Use weights 400/600/700, which Segoe UI has (Semibold is 600). Monospace (`ui-monospace, Consolas, "Courier New", monospace`) is used only for the id.
- **Dark mode:** reuse today's variables: `:root{color-scheme:light dark;--bg…}` + `@media(prefers-color-scheme:dark){…}` [VERIFIED: src/report.ts:187-188].
- **Print:**
  ```css
  @media print{:root{--bg:#fff;--surface:#fff;--text:#000;--muted:#444;--line:#bbb}
  body{font-size:11pt}main{max-width:none;padding:0}
  section,article{break-inside:avoid}h2{break-after:avoid}
  details::details-content{content-visibility:visible;display:block}
  details>summary{list-style:none}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  @page{size:A4;margin:14mm}
  ```
  In Chromium 151, `details::details-content{content-visibility:visible;display:block}` shows the closed content (verified by screenshot). Firefox/Safari support is [ASSUMED]. The first screen never depends on `<details>`, so a closed block in print loses nothing important.
- **Bars:** a server-computed `<svg viewBox="0 0 100 8" width="100%" height="8" role="img" aria-label="69%"><rect width="100" height="8" class="track"/><rect width="${pct}" height="8" class="fill"/></svg>`, where `pct = Number.isFinite(x) ? clamp(Math.round(x*100),0,100) : 0`. Colors come from a `fill: var(--accent)` CSS class, which also works in dark mode.
- **Ids/anchors:** only our own ids: `id="fail-${index}"`. Never build an id from text.
- **Jargon ban:**
  - apply the phase-2, phase-3 and phase-4 forbidden lists;
  - add a manager list: `goal_attainment|prompt_compliance|user_fidelity|unknown|рубрик|протокол|кластер|метрик|judge|seq|карточк|RAG|токен|хеш|details|view`;
  - allow the judge model name, `Agent Lab`, `МСК`, `HTML`.
- **Wording:** the text comes from `view` and its phase 2–4 renderers. Phase 5 adds only the section titles and the «Как считали» paragraph (Claude's discretion). Suggested paragraph: «Агента проверили на N ситуациях из реальных диалогов. Для каждой ситуации смоделированный клиент вёл разговор по мотивам настоящего, а отдельная модель-судья сверяла ответы агента с правилами владельца. Ситуация засчитана, если агент добился цели клиента, не нарушив правил. Ситуации, где проверка не удалась, в число не входят и перечислены отдельно.»
- **Header facts:**
  - date: `mskDateTime(record.createdAt)` + « МСК»;
  - version: `record.targetVersion ?? record.targetRelease ?? 'не названа'`, followed by ` (отпечаток <first 8 of targetFingerprint>)` when there is no version, because none of the stored runs has one;
  - size: `view.scope.cards` situations, `view.scope.dialogues` dialogues;
  - judge: `view.scope.judgeModel ?? 'не записан'`;
  - cost: `≈ $${costUsd.toFixed(2)}` or «не записана».

### Pattern 3: `src/redact.ts` + customer guard (SHARE-03)

**Order matters.** Apply the patterns in this order, each over the text already produced by the previous step. Every digit rule uses `(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`, so digits inside UUIDs and hashes stay untouched. The customer surfaces should not contain those ids anyway.

| # | Kind | Pattern (flags `gu`) | Check | Replacement | False-positive risk |
|---|------|---------|-------|-------------|------|
| 1 | URL | `https?:\/\/[^\s"'<>«»]+` | host is `localhost`, has no dot, ends in `.local .corp .internal .intra .lan .localdomain`, or is a private IP | `[внутренний адрес скрыт]`; public URLs are kept as **text** (never a link) | Public bank URLs stay, which is intended |
| 2 | e-mail | `[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}` | — | `[почта скрыта]` | Low |
| 3 | internal host | `\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local\|corp\|internal\|intra\|lan\|localdomain)\b` (i) | — | `[внутренний адрес скрыт]` | Words like «file.local» in rules; acceptable |
| 4 | private IP | `(?<![\d.])(?:10(?:\.\d{1,3}){3}\|192\.168(?:\.\d{1,3}){2}\|172\.(?:1[6-9]\|2\d\|3[01])(?:\.\d{1,3}){2}\|127(?:\.\d{1,3}){3})(?![\d.])` | — | `[внутренний адрес скрыт]` | Version strings like `10.2.3.4`; rare in text |
| 5 | card | `\d(?:[ -]?\d){12,18}` with boundaries | Luhn over digits | `•••• <last4>` | Luhn passes 10% of random numbers; any still-unmasked long run is caught by rule 9 anyway |
| 6 | account | `\d{5}[ ]?\d{3}[ ]?\d[ ]?\d{4}[ ]?\d{7}` (20 digits) with boundaries | — | `счёт •••• <last4>` | Low |
| 7 | RU phone | `(?<![\p{N}+])(?:\+7\|8)[\s\u00a0(-]*\d{3}[\s\u00a0)-]*\d{3}[\s\u00a0-]*\d{2}[\s\u00a0-]*\d{2}(?!\p{N})` | — | `[телефон скрыт]` | 11-digit ids starting with 8; masking them is harmless |
| 8 | INN | `\d{12}\|\d{10}` with boundaries | checksum (weights 2,4,10,3,5,9,4,6,8 / 7,2,4,10,3,5,9,4,6,8 + 3,7,2,4,10,3,5,9,4,6,8, mod 11 mod 10) | `[ИНН скрыт]` | A checksum failure falls through to rule 9, so the text is still masked |
| 9 | long digits | `\d{8,}` with boundaries | — | `[номер скрыт]` | Terminal ids, order numbers, unseparated amounts ≥ 8 digits are masked. This errs on the safe side. Dates `11.03.2024`, times `14:00`, `4321`, `A103`, `202-7` are **not** matched |

**Customer guard** (`customerGuard(record)`):
- `clientWindows`: every 20-character window of the whitespace-collapsed, lower-cased `user` event texts in `record.trials` **and** `record.dialogues[].messages` with role `user`. Also include `record.sourceEvidence?.trials` user events, because a derived run embeds the source dialogues.
- **Minus** windows that occur in `record.sources[].content` (owner material is not client data; measured: this clears the 1/44 rule-quote hit).
- `text(s)`: `redact(s)`, then mark every character covered by a shared window. Replace each marked run by `…` and collapse repeated `…`.
- `title(s, n)`: `text(s)`. If it changed and fewer than 25 non-space characters are left outside `…`, return `Ситуация ${n}`.
- Apply `text` to: expectations X, rule quotes and source names, cause names, agent replies, not-measured labels (constants, cheap), comparison and agreement titles, the agent name. Apply `title` to situation titles. Never render: `user.goal`, `user.facts`, `opening/script`, judge `rationale`, `record.task`, `target` (command line), `warnings` raw text (these can hold private-IP URLs; see measurements), `limitations`, `failureModes.description` (only the guarded name).

**Leak test (independent of the guard, run on the rendered output):**
1. Get the visible text. For HTML: drop `<style>…</style>`, strip tags, decode `&amp; &lt; &gt; &quot; &#39;`, collapse whitespace, lowercase.
2. Assert that no 20-character window is in `clientWindows` (with the same owner-source allowlist).
3. Assert that `PII_PATTERNS` find 0 matches in the visible text. Run the digit rules with letter/digit boundaries.
4. HTML only:
   - `/<script/i` → 0;
   - `/\s(?:src|href|action|formaction|poster|data)\s*=\s*["']?\s*(?:https?:)?\/\//i` → 0;
   - `/url\(\s*["']?(?:https?:)?\/\//i` → 0;
   - `/@import/i` → 0;
   - `/\son[a-z]+\s*=/i` → 0;
   - `<link`, `<iframe`, `<object`, `<embed`, `<img` → 0 (the design uses none).

### Pattern 4: Delivery (Pi and CLI)

**Pi (`extensions/agent-lab.ts`):**
```ts
import { copyToClipboard } from '@earendil-works/pi-coding-agent';   // value import, root only
// inject for tests: const copy = deps.copy ?? copyToClipboard;
async function deliverSummary(ctx: ExtensionContext, text: string, path: string) {
  try { await copy(text); ctx.ui.notify(`Выжимка скопирована. Файл: ${path}`, 'info'); }
  catch { const _ = await ctx.ui.editor('Скопируйте выжимку вручную (буфер обмена недоступен)', text); ctx.ui.notify(`Файл: ${path}`, 'info'); }
}
```
- **Behaviour of `copyToClipboard`** [VERIFIED: dist/utils/clipboard.js:58-160]:
  1. On non-Linux, a native addon (`@mariozechner/clipboard`, loaded lazily in `clipboard-native.js`; `null` when missing or when Linux has no display).
  2. If that fails: `pbcopy` (darwin), `clip` (win32), or Termux → `wl-copy` → `xclip`/`xsel` (Linux). Calls are synchronous with a 5 s timeout.
  3. In SSH/mosh sessions, or when nothing worked, it writes OSC 52 (`\x1b]52;c;<base64>\x07`) to stdout, up to 100 000 base64 characters.
  4. It throws `Failed to copy to clipboard` only when every path failed.
  - **Caveat:** OSC 52 counts as success even when the terminal ignores it. Word the notice so it doesn't overclaim, e.g. «Выжимка скопирована (если терминал разрешает буфер обмена). Файл: …». Always show the path.
- **Command:** `/agent-lab share <id>`. Parse `args` **before** the TUI guard: `const [verb, ...rest] = args.trim().split(/\s+/)`; if `verb === 'share'`, run the share flow and return.
  - The share flow needs no board. Without UI, it writes the file and notifies. With `ctx.hasUI`, it also copies.
  - `share` cannot collide with a run id: ids are `randomUUID()` [VERIFIED: src/experiment.ts:83 `id: randomUUID()`], and the existing special words are `new`, `demo`, and paths starting with `/` or `~` [VERIFIED: extensions/agent-lab.ts:720].
  - Accept an 8-character id prefix through the same resolver phase 4 adds for `/agent-lab <id8>`. `ExperimentStore.get` only takes the full id (`idPattern`, `open(this.path(id))`) [VERIFIED: src/store.ts:7, 97-104], so a unique-prefix lookup over `lab.list()` is required.
- **Board:** keep **`x`** and don't add a key. Every free-looking letter is taken or planned:
  - existing: `q a p n r v f x o c u d j k 1-3 / ? enter esc` [VERIFIED: extensions/cards.ts:357-392];
  - phase 3: `y n s`;
  - phase 2: `y e`;
  - phase 4: `4 tab shift+tab`.

  `x` → `ctx.ui.select('Выгрузить', ['Для заказчика: HTML-отчёт и выжимка в буфер', 'Только выжимка в буфер обмена', 'Полный отчёт для аудита — не пересылать'])`. The first option is the default (CONTEXT). After the manager export, `reportPath` points to `<id>.manager.html`, so `o` opens the customer file. The footer text `x Экспортировать` and its measured widths stay unchanged, so no phase-3/4 tier needs re-measuring.
- **LLM tools:** `exportArtifacts` return values keep today's keys (`evidence`, `traceJournal`, `report`, `htmlReport`, `snapshot`, `agent`), because tests and tool payloads read them [VERIFIED: test/extension.test.ts:474,544,609,611,629,682; test/artifacts.test.ts:47,63]. Add `managerReport` and `summary`. `htmlReport` now points at the audit file.

**CLI (`src/cli.ts`):**
- `agent-lab share --id RUN [--before RUN]`: build `evidenceBundle`, write `exports/<id>.summary.txt`, print the text, a blank line and `Файл: <path>`. `share` does not collide with any existing command (`status suites doctor summary export diff discover discover-resume discover-build evaluate prompt-propose prompt-apply accept score reassess save-suite demo prepare build repeat run`) [VERIFIED: src/cli.ts:78-383].
- `agent-lab export --id RUN --format manager [--output f]`: extend the format list `['json','html','markdown']` [VERIFIED: src/cli.ts:114] with `manager`.
  - Without `--output`, write `exports/<id>.manager.html` and print the path. Printing HTML to stdout does not help a manager.
  - `--format html` stays the audit report, now with the banner.
  - Update the help line [VERIFIED: src/cli.ts:76].
- **File writes:** today `--output` uses `writeFile(values.output, content, { mode: 0o600 })` without `wx` [VERIFIED: src/cli.ts:117]. On an existing file, `mode` is ignored and the old permissions stay. Use one helper: `writeExport(path, content)` → `writeFile(tmp, …, { mode: 0o600, flag: 'wx' })` + `rename(tmp, path)`. The `exports/` directory is created with `0o700` [VERIFIED: src/artifacts.ts:148].

### Pattern 5: Audit report (SHARE-04)

- **Banner.** First child of `<main>` in `htmlReport`: `<div class="do-not-forward" role="alert"><strong>Не пересылать.</strong> Внутри реплики клиентов и полные ответы агента. Для заказчика используйте файл <code><id>.manager.html</code>.</div>`. Style it large, with a warning border and background, and keep it visible in print.
- **Other formats.** `markdownReport` starts with `> **Не пересылать:** внутри реплики клиентов и полные ответы агента.` `jsonReport` gets a top-level `"doNotForward": "…"` string (an additive key; old consumers ignore it).
- **File names** (in `exports/`):
  - `<id>.manager.html` (customer);
  - `<id>.summary.txt` (customer);
  - `<id>.audit.html`, `<id>.audit.md`, `<id>.snapshot.json` (owner).

  Today's names are `${id}.${uuid8}.report.*` [VERIFIED: src/artifacts.ts:150-157]. Stable names plus atomic replace make «последний отчёт» unambiguous. The `wx` protection against clobbering is kept through the temp file.
- **Header time.** The audit header shows UTC today: `record.createdAt.slice(0, 16).replace('T', ' ')} UTC` [VERIFIED: src/report.ts:193]. Switch it to `mskDateTime` for consistency. This is optional; update the test that pins it, if any.
- **Script.** The audit report keeps its hashed navigation script [VERIFIED: src/report.ts:15-16, 185]. The no-script rule applies to the manager file only.

### Anti-Patterns to Avoid
- **Redacting the whole rendered HTML.** It corrupts ids, hashes, CSS and escaped entities. Redact each text value before escaping.
- **Relying on `redact()` for SHARE-03.** Measured: titles leak client text with no PII in them. The overlap guard is required.
- **Showing `view.scope.target` raw as «версия».** For the stored runs it is a 12-character hex fingerprint.
- **Showing `bundle.warnings` in the manager report.** They contain ids, paths and private URLs. Use a fixed Russian sentence («Часть проверок не подтверждена — подробности у владельца»).
- **`<a href="file://…">` or any link to the audit file.** Name it as text only.
- **Re-wording V1/V2, F1, F6 texts.** Phase 4 locks them as `[P4]`, and the numbers must match the board.
- **Using `system-ui` first.** On some Windows locales it resolves to fonts other than Segoe UI. Name Segoe UI first.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Clipboard | pbcopy/xclip/OSC 52 plumbing | `copyToClipboard` (Pi 0.85.1) | Already handles platforms, SSH and Wayland |
| Time zones | offset math `+3h` | `Intl.DateTimeFormat(…, { timeZone: 'Europe/Moscow' })` | ICU is present (78.2). Tests must not depend on the machine TZ (this machine is already Europe/Moscow, so run the test with `TZ=UTC` too) |
| HTML escaping | a new escaper | `escape()`/`plain()` from `report.ts` | Tested; strips bidi and VT codes |
| Counts, verdicts, causes | recounting in the renderer | `ResultView` fields | One number on every surface |
| Russian plurals | `n === 1 ? …` | `pluralForm` | Already used everywhere |
| Charts | Chart.js/Vega | inline SVG `<rect>` | No JS allowed |

**Key insight:** every risk in this phase sits at a boundary: text that leaves the machine, bytes that enter a browser, and bytes that reach the clipboard. Keep the renderers dumb and put all the safety into one guard that a test checks independently.

## Common Pitfalls

### Pitfall 1: Client wording leaks through situation titles
**What goes wrong:** Titles are generated from the opening turn and copy it verbatim (6/13, 13/15 and 7/13 on the stored runs).
**How to avoid:** Run `guard.title()` on every title. Use the `Ситуация N` fallback.
**Warning signs:** The leak test flags a title, or a title contains «…» in more than half of the situations. If that happens, show `Ситуация N` plus the expectation for every situation.

### Pitfall 2: False PII hits from our own ids
**What goes wrong:** UUIDs and hashes produced 406–453 8+ digit hits and up to 56 non-Luhn 13–19-digit hits in today's HTML.
**How to avoid:** Use letter/digit boundaries in patterns. Keep UUIDs and hashes out of customer files; the run id may appear only as an 8-character hex prefix, which boundaries protect.

### Pitfall 3: The clipboard claims success it didn't have
**What goes wrong:** OSC 52 counts as success even when the terminal ignores it.
**How to avoid:** Always print the file path. Use hedged wording. The editor fallback appears only when the function throws.

### Pitfall 4: The summary exceeds 900 characters in real data
**What goes wrong:** `successCriteria` averages 290–381 characters and reaches 494.
**How to avoid:** Shorten X to 110 characters at a word boundary. Apply the line drop order from Pattern 1. Test with the longest stored expectation length (494) and 99/99 counts.

### Pitfall 5: Details hidden in print
**What goes wrong:** Closed `<details>` contents are not printed.
**How to avoid:** Use `details::details-content` in `@media print` (works in Chromium). The essential content never goes inside `details`.

### Pitfall 6: Time shows in the machine's zone
**What goes wrong:** Tests pass on this Moscow-zone machine even when the time zone is missing.
**How to avoid:** Always pass `timeZone: 'Europe/Moscow'`. Run the test under `TZ=UTC` (`process.env.TZ` is set before the first `Date` use, or via the command prefix).

### Pitfall 7: `writeFile(mode)` on an existing file
**What goes wrong:** The permissions are not changed.
**How to avoid:** Write a temp file with `wx` and `0600`, then rename it.

### Pitfall 8: Value import of the Pi package in tests
**What goes wrong:** `test/extension.test.ts` loads the extension. A root value import loads all of `pi-coding-agent`, including the lazy clipboard addon. It works, because `src/pi.ts` already does this, but a test must not touch the real clipboard.
**How to avoid:** Inject `copy` through the extension's test seam and assert the editor fallback with a throwing stub.

### Pitfall 9: A derived run leaks source dialogues
**What goes wrong:** `record.sourceEvidence.trials` carries the parent run's user events.
**How to avoid:** Include them in `clientWindows`.

## Code Examples

### MSK formatter
```ts
// Verified output on Node 22.22.3 / ICU 78.2: «16 сентября 2026 г. в 18:40»
const MSK = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const mskDateTime = (iso: string) => `${MSK.format(new Date(iso)).replace(' г. в ', ', ')} МСК`; // «16 сентября 2026, 18:40 МСК»
```
The `' г. в '` separator is ICU-version dependent [ASSUMED stable for ICU 78]. Prefer `formatToParts` and assemble `day month year, HH:MM` from the parts.

### Luhn and INN checks
```ts
const luhn = (d: string) => { let s = 0; for (let i = d.length - 1, alt = false; i >= 0; i--, alt = !alt) { let n = +d[i]!; if (alt && (n *= 2) > 9) n -= 9; s += n; } return s % 10 === 0; };
const innOk = (d: string) => {
  const c = (w: number[], at: number) => (w.reduce((a, k, i) => a + k * +d[i]!, 0) % 11) % 10 === +d[at]!;
  return d.length === 10 ? c([2, 4, 10, 3, 5, 9, 4, 6, 8], 9)
    : d.length === 12 && c([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 10) && c([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 11);
};
```
Test vectors should be **generated** in the test (build a checksum-valid number from random digits) rather than copied from the web. The weights are [ASSUMED] from general knowledge, and a generated/validated pair keeps the test self-consistent.

### Headless open/print check (optional, verification script only)
```bash
H="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell"
[ -x "$H" ] || { echo "no headless chromium — human check"; exit 0; }
"$H" --disable-gpu --host-resolver-rules="MAP * ~NOTFOUND" --no-pdf-header-footer \
     --print-to-pdf="$OUT/report.pdf" "file://$FILE" 2>"$OUT/chrome.err"
! grep -q "Content Security Policy" "$OUT/chrome.err"          # nothing was blocked, so nothing was requested
"$H" --disable-gpu --host-resolver-rules="MAP * ~NOTFOUND" --window-size=1024,1400 --screenshot="$OUT/screen.png" "file://$FILE"
```
All of these were verified on 2026-09-17 with Chrome for Testing 151.0.7922.34: PDF written, screenshot written, CSP violations logged on stderr. Write `$OUT` outside the repo (session scratchpad) with mode `0700`, because the PDF contains the rendered report. The PDF of a real run is still a customer-profile file, so it is safe, but keep it local.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| One HTML with a navigation script for everyone | Audit HTML (script, banner) plus a script-free manager HTML | This phase | Forwardable file |
| JS `details` opener for print | `details::details-content` CSS | Chromium 131+ (in 151 locally) [ASSUMED version] | No script needed |
| UTC timestamps | `Intl` with `Europe/Moscow` | This phase | Manager reads local time |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `details::details-content` printing works in Firefox/Safari as well as Chromium | Pattern 2 | Closed details don't print in those browsers; the first screen still does |
| A2 | The INN checksum weights listed are correct | Code Examples | Some valid INNs fall through to the generic `[номер скрыт]`; still masked |
| A3 | `' г. в '` separator in ICU output is stable | Code Examples | Wrong date string; use `formatToParts` to avoid it |
| A4 | Windows `system-ui` may resolve to a non-Segoe font on some locales | Anti-Patterns | None if Segoe UI is named first |
| A5 | Size estimate ≤ 100 KB for 15/60 | Measurements | The fixture test catches it |
| A6 | A 20-character window is the right leak threshold (CONTEXT fixes 20) and the 25-character title fallback is reasonable | Pattern 3 | Too many «Ситуация N» titles; tune after the first render |
| A7 | «Demo run after phase 2» and «run with agreement (copy)» will exist by execution time; today only fae4ee59, a92fd6ae, 61521e0d exist | Validation | Use `test/helpers/demo-record.ts` plus a synthetic agreement fixture instead |

## Open Questions

1. **Which date to show: run start or result review?**
   - What we know: `createdAt` is the start; `reviewedAt` exists for reviewed runs.
   - Recommendation: `Прогон от <createdAt MSK>`. Add `, разбор <reviewedAt MSK>` when it is set.
2. **Should public URLs from agent replies stay as text?**
   - What we know: CONTEXT masks only internal ones. 1 public URL appears in agent turns.
   - Recommendation: keep them as plain escaped text, never as `<a>`. The resource test targets attributes, not text.
3. **The upstream field names (`topCauses`, `agreement`, `changes`, `verdictLine`) are still in plans, not code.**
   - Recommendation: the planner re-reads `src/result-view.ts` and `src/verdict.ts` at execution. Phase 5 tasks depend on phases 2–4 being merged. If a field is missing, render its section as absent (`?? []`), as 04-UI-SPEC does for v1 views.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node + full ICU | MSK time | ✓ | 22.22.3, ICU 78.2 | — |
| `@earendil-works/pi-coding-agent` `copyToClipboard` | Pi summary | ✓ | 0.85.1 | editor fallback |
| pbcopy (macOS) | clipboard | ✓ (system) | — | native addon / OSC 52 |
| Chrome for Testing headless shell | automated open/print | ✓ | 151.0.7922.34 at `~/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell` | human check |
| Google Chrome / Chromium app | — | ✗ | — | headless shell above; Firefox.app and Safari.app are installed for the manual check |
| Segoe UI | Windows rendering check | ✗ locally (macOS) | — | human check on Windows, or accept the Microsoft doc (Cyrillic supported) |
| Stored runs fae4ee59, a92fd6ae, 61521e0d | stored-run verification | ✓ | — | — |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** Segoe UI rendering (human check); Chrome app (headless shell).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` via `tsx --test` (tsx ^4.20), TypeScript 5.9.3 |
| Config file | none (`package.json` scripts) |
| Quick run command | `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh test/redact.test.ts test/share.test.ts test/manager-report.test.ts test/artifacts.test.ts` |
| Full suite command | `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh --full` |
| Stored-run check | `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh --keep` → `node .planning/phases/05-vyzhimka-i-html-otchet-dlya-menedzhera/verify-share.mjs --dist "$SNAP/dist" --data .agent-lab --id fae4ee59-d6da-4cbf-83b5-574e34405877 --id a92fd6ae-8eaa-42ea-8ba0-d804096ce1d4 --id 61521e0d-b5a9-45e6-b13a-3e04349a6482` (prints ids and counts only; output files go to a `mktemp -d` directory, never the repo) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SHARE-01 | ≤ 15 lines, ≤ 900 chars, no ANSI/box/emoji (only ✓ ✗), contains `view.headline.text` and V1 verbatim, 3 causes «Должен был … — правило N», no `said`/rationale | unit | `snap-test.sh test/share.test.ts` | ❌ Wave 0 |
| SHARE-01 | file `exports/<id>.summary.txt` mode 0600, replaced atomically; CLI prints text + path | unit/integration | `snap-test.sh test/artifacts.test.ts` | ✅ extend |
| SHARE-01 | Pi: copy succeeds → notify; copy throws → `ctx.ui.editor` gets the text; `/agent-lab share <id8>` resolves the prefix | unit (fake ctx, injected copy) | `snap-test.sh test/extension.test.ts` | ✅ extend |
| SHARE-02 | < 200 000 bytes on a 15-situation / 60-dialogue fixture with 494-char expectations and 819-char replies; no `<script`, no resource URLs, CSP meta present, `@media print` and `prefers-color-scheme` present, `lang="ru"`, `charset utf-8` | unit | `snap-test.sh test/manager-report.test.ts` | ❌ Wave 0 |
| SHARE-02 | header has MSK date (under `TZ=UTC`), version, set size, judge; no jargon words | unit | same | ❌ Wave 0 |
| SHARE-02 | same number as `ResultView` on stored runs; size, script, URL and jargon checks | stored-run | `verify-share.mjs` | ❌ Wave 0 |
| SHARE-02 | opens offline and prints; no CSP violations | smoke (optional) | headless command in Code Examples | ❌ Wave 0 (script) |
| SHARE-03 | redact vectors: Luhn card, non-Luhn 16 digits, 20-digit account, generated valid INN 10/12, phones `+7 (495) 123-45-67` / `8 916 123 45 67`, e-mail, `aigw.corp`, `10.0.0.5`, `http://payments.internal/x`; negatives: `11.03.2024`, `14:00`, `4321`, `A103`, `202-7`, UUID, 40-char hex | unit | `snap-test.sh test/redact.test.ts` | ❌ Wave 0 |
| SHARE-03 | guard: a title copying a user turn is cut or replaced; owner-source text is not cut; `sourceEvidence` user turns count | unit | same | ❌ Wave 0 |
| SHARE-03 | stored runs: 0 client 20-char windows and 0 PII hits in summary and manager HTML visible text | stored-run | `verify-share.mjs` | ❌ Wave 0 |
| SHARE-04 | audit HTML and markdown start with «Не пересылать»; JSON has `doNotForward`; file names `.audit.html` / `.manager.html`; `x` default is the manager file; `o` opens the manager file | unit | `snap-test.sh test/artifacts.test.ts test/cards.test.ts test/extension.test.ts` | ✅ extend |

### Sampling Rate
- **Per task commit:** the quick run command on the touched test files.
- **Per wave merge:** `snap-test.sh --full`.
- **Phase gate:** full suite green, `verify-share.mjs` clean on the three stored runs (plus the phase-2 demo run and the agreement copy if they exist), and the headless print produced. Human check: the file opened on Windows (Segoe UI Cyrillic) and printed on A4.

### Wave 0 Gaps
- [ ] `test/redact.test.ts`: patterns, boundaries, guard.
- [ ] `test/share.test.ts`: `shareText` budget and content.
- [ ] `test/manager-report.test.ts`: structure, size fixture, jargon, TZ, leak test helper (`visibleText(html)`).
- [ ] A shared test helper `customerLeaks(text, record)` used by the unit tests and `verify-share.mjs`.
- [ ] `.planning/phases/05-…/verify-share.mjs`: stored-run checks (model it on `01-…/verify-stored-runs.mjs`: `--dist`, `--data`, prints ids and counts only).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | yes (local files) | `0600` files, `0700` `exports/`, data only under `.agent-lab` |
| V5 Input Validation / Output Encoding | yes | `escape()` for every text node and quoted attribute; ids only from our own counters; no data in `<style>`/URL contexts (OWASP XSS rules) [CITED: cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html] |
| V6 Cryptography | no | — |
| V8 Data Protection | yes | `redact` + overlap guard; customer profile excludes turns, rationales, task, target, warnings |
| V14 Configuration | yes | CSP `default-src 'none'` without `script-src`; `referrer` no-referrer |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Client text or PII in a forwarded file | Information disclosure | Guard + redactor + leak test on the rendered output |
| HTML/script injection from dialogue or judge text | Tampering | `escape()`, no script allowed by CSP, quoted attributes |
| The file contacts a third party when opened (tracking pixel, font) | Information disclosure | CSP `default-src 'none'`, static attribute test, headless CSP log check |
| Bidi or terminal control characters in the text summary | Spoofing | `plain()` on every line |
| The audit file is forwarded by mistake | Information disclosure | Banner, distinct file names, Pi default = manager file |
| Clipboard data captured by the terminal (OSC 52) | Information disclosure | The summary contains no client data by construction |

## Sources

### Primary (HIGH confidence)
- `node_modules/@earendil-works/pi-coding-agent@0.85.1`: `dist/index.d.ts:30`, `dist/utils/clipboard.js`, `dist/utils/clipboard-native.js`, `dist/core/extensions/types.d.ts:70,76,135`, `package.json` exports.
- Repo: `src/report.ts` (lines 9-16, 167-193), `src/artifacts.ts` (1-169), `src/result-view.ts` (1-212), `src/store.ts` (7, 97-104), `src/cli.ts` (60-135), `extensions/agent-lab.ts` (1-30, 716-860), `extensions/cards.ts` (340-400), `test/artifacts.test.ts`, `test/extension.test.ts`.
- Planning: 05-CONTEXT, REQUIREMENTS SHARE-01…04, research/STACK.md §4, research/PITFALLS.md §9, 02-04-PLAN, 02-UI-SPEC F1 and forbidden list, 03-03-PLAN, 03-UI-SPEC keys, 04-RESEARCH Pattern 6, 04-UI-SPEC V1/V2/keys.
- Local measurements: scratch snapshot render of three stored runs (counts only); headless Chromium 151 PDF, screenshot and CSP log; Node Intl output.
- Microsoft Learn, Segoe UI font family (Cyrillic, code page 1251, Windows Vista–11).

### Secondary (MEDIUM confidence)
- OWASP XSS Prevention Cheat Sheet (via research/STACK.md).

### Tertiary (LOW confidence)
- Browser support for `::details-content` outside Chromium; INN weights (training knowledge).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH. Every API was read in the installed package.
- Architecture: HIGH for today's code. MEDIUM for upstream field names, which exist only in the phase 2–4 plans.
- Pitfalls: HIGH. Leak and false-positive findings are measured on real stored runs.
- Size budget: MEDIUM. Arithmetic from measured maxima; a fixture test enforces it.

**Research date:** 2026-09-17
**Valid until:** 2026-09-24 (code is moving fast in phases 1–4)
