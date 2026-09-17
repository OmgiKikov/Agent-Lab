# Phase 4: Экран результата в Pi - Pattern Map

**Mapped:** 2026-09-17
**Files analyzed:** 19 new/modified files (plus 4 verification scripts)
**Analogs found:** 21 / 23

**Read this first (anchor stability).**
- Line numbers below were read at HEAD `81bcea2`.
- Phase 1 gap plan 01-11 is still editing `src/comparison.ts`, `src/experiment.ts` and tests. Anchors there **may shift; re-read**. The `src/experiment.ts` anchors that 04-RESEARCH cites have already moved: `lab.get` clone is now at :247 (research said :237), `start()` at :912 (research :895), `record.reviewedAt = …` at :933 (research :913), `record.trials.push(trial)` at :459/:868.
- Phases 2 and 3 are planned, not executed. Phase 2 (02-05, 02-08) and phase 3 (03-04, 03-06) rewrite `extensions/cards.ts`, `extensions/agent-lab.ts`, `src/result-view.ts` and their tests. **Every anchor in those files may shift; re-read after 02/03 land.** Symbols that exist only in those plans are marked `[plan 0X-NN]` and must be taken from the landed code, not from this file.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/verdict.ts` (new) | utility (pure view) | transform | `src/result-view.ts` (`resultViewLines`, `controlLine`) | exact |
| `src/progress.ts` (new) | utility (pure view) | transform | `src/result-view.ts` + `runParallel` in `extensions/agent-lab.ts:147-149` | role-match |
| `src/comparison.ts` (+ `situationChanges`) | service (pure analysis) | transform | same file, `stabilityBetweenRuns` :638-663 / `stabilityAfterReassess` :665+ | exact |
| `src/result-view.ts` (+ `changes`, `compareRows`, `SMALL_SAMPLE` export, pointer renames) | utility (pure view) | transform | same file :95-162, :191-212 | exact |
| `src/agreement.ts` (+ `queue` counts, only if phase 3 omitted them) | utility | transform | `[plan 03-01]` `judgeAgreement` | plan-only |
| `extensions/render/theme.ts` (new) | utility (terminal paint) | transform | `extensions/cards.ts:10-14, 64-66, 409-415, 498` | role-match |
| `extensions/render/verdict-block.ts` (new) | component | request-response (render) | `extensions/cards.ts` `LabBoard implements Component` :263, :318, :401 | role-match |
| `extensions/render/tabs/summary.ts` (new, moved) | component rows | transform | `extensions/cards.ts` `verdictLines` :189-257 | exact (move) |
| `extensions/render/tabs/situations.ts` (new, moved) | component rows | transform | `extensions/cards.ts` `scenarioLines` :70-124 + `[plan 02-08]` sheet | exact (move) |
| `extensions/render/tabs/dialogues.ts` (new, moved) | component rows | transform | `extensions/cards.ts` `trialLines` :126-182 | exact (move) |
| `extensions/render/tabs/failures.ts` (new) | component rows | transform | `[plan 03-06]` F10 block + `trialLines` findings rows :128-132 | role-match |
| `extensions/render/tabs/compare.ts` (new) | component rows | transform | `resultViewLines` stability rows `src/result-view.ts:164-170, 208-210` | role-match |
| `extensions/cards.ts` (frame only) | component (stateful) | event-driven (keys, 750 ms load) | itself :263-528 | exact |
| `extensions/agent-lab.ts` (hosts, progress loop, appendEntry) | controller | request-response + streaming (`onUpdate`) | itself :22-41, :43-46, :549-580, :736-748 | exact |
| `skills/agent-builder/SKILL.md` (stop restating) | config/doc | — | itself :32-39 | exact |
| `test/verdict.test.ts` (new) | test | — | `test/result-view.test.ts:1-20` | exact |
| `test/progress.test.ts` (new) | test | — | `test/result-view.test.ts` (pure vectors) | role-match |
| `test/theme.test.ts` (new) | test | — | `test/cards.test.ts:1-13` (fake theme, `visibleWidth`) | role-match |
| `test/verdict-block.test.ts` (new) | test | — | `test/cards.test.ts` + RESEARCH «Host-parity test» | role-match |
| `test/cards.test.ts`, `test/extension.test.ts`, `test/comparison.test.ts`, `test/result-view.test.ts` (extend) | test | — | themselves | exact |
| `.planning/phases/04-*/render-matrix.mts` (new) | script (read-only) | batch | `.planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts` | exact |
| `.planning/phases/04-*/live-progress-check.mts` (new) | script (paid, capped) | streaming capture | `pi-surface-check.mts` + `live-check.mjs` + `test/extension.test.ts:20-43` | role-match |
| `.planning/phases/04-*/pi-reopen-check.sh`, `board-pty-check.sh` (new) | script (pty) | batch | none in repo (RESEARCH spikes B/C) | no analog |

All analog paths are git-tracked (`git ls-files` checked for `skills/agent-builder/SKILL.md` and `snap-test.sh`; the rest are tracked source).

## Pattern Assignments

### `src/verdict.ts` (utility, transform)

**Analog:** `src/result-view.ts`

**Module header / purity rule** (lines 5-11): pure, no I/O, no escaping; escaping is done at the surface. Copy that comment style. Imports use `.js` extensions:
```ts
import type { Experiment, Scenario, ValidationExclusion } from './contracts.js';
import { cardVerdict, judgeModel, NOT_MEASURED_CODES, stabilityAfterReassess, stabilityBetweenRuns, type NotMeasuredCode, type Stability, type StabilityRow } from './comparison.js';
```
- `SMALL_SAMPLE` is **private** today (line 15, `const SMALL_SAMPLE = 20;`). Export it from `result-view.ts` and import it; do not retype 20.
- `pluralForm` lives at `src/result-view.ts:27-31` today. `[plan 02-04]` moves it to `src/plural.ts` (no imports). Import from wherever it is after 02-04 lands.

**Control word** (lines 110-114). V1 rules 1-3 must reuse the same three-way choice:
```ts
const controlFailed = controlCards.some(card => card.outcome === 'fail');
const controlUnmeasured = controlCards.some(card => card.outcome === 'unknown' && card.reason !== 'in_progress');
... `Контроль ${controlFailed && controlUnmeasured ? 'не пройден или не измерен' : controlFailed ? 'не пройден' : 'не измерен'} — …`
```
`ResultView.control` holds only `cards` and `warning` (line 80). `verdictLine` needs the word, so either recompute it from `view.control.cards` using the same predicate, or add a `control.state` field in `buildResultView`. Do not parse the warning string.

**Percent rounding** (line 130): `Math.round(accuracy * 100)`. Apply the 80/50 thresholds to this rounded value (vector 39/49).

**Row-builder shape** to copy for `verdictBlockRows` (lines 190-212): `resultViewLines(view, options: { details?: boolean } = {}): string[]` pushes in a fixed order with `if` guards. Phase 4 builds on `[plan 02-04]` `resultViewRows(view, { details })` (roles `lead | line | situation | detail`), `causeSection(view)`, `SECTION_TEXT`, `allFailuresPointer`, and `[plan 03-03/03-06]` `disagreementRows(view)`. Filter the collapsed block by role; never by string content.

---

### `src/progress.ts` (utility, transform)

**Analogs:** `extensions/agent-lab.ts:147-149` (moved as-is), `src/comparison.ts:462` `plannedTrials`, `src/result-view.ts` for pure style.

**Move this function verbatim** (agent-lab.ts:146-149):
```ts
/** A real agent is independent per dialogue, so several run at once; the scripted sandbox keeps its deterministic order. */
function runParallel(record: Experiment): number {
  return record.target.kind === 'sandbox' ? 1 : Math.max(1, Math.min(8, record.scenarios.length * record.settings.userModes.length * record.settings.repeats));
}
```
Callers to repoint: `agent_lab_run` (agent-lab.ts:563) and the board `run` action (agent-lab.ts:800). Both pass `parallel: runParallel(…)` to `lab.start`.

**Cost text today** (cards.ts:487 and :137): `record.usage.costUsd === null ? 'неизвестна' : \`$${…toFixed(4)}\``. Phase 4 uses `toFixed(2)` and the words `цена неизвестна` / `без оплаты` (UI-SPEC P1). The demo check is `record.mode === 'demo'` (cards.ts:420).

**Data sources** (`src/experiment.ts`, may shift; re-read): `lab.get` returns `structuredClone(this.active.record)` (:247); `start(id, { …; parallel?: number })` (:912); `record.reviewedAt = new Date().toISOString()` inside `start` (:933), which gives the run start for «идёт M:SS»; `record.trials.push(trial)` (:868).
- `now` is injected. Do not use `performance.now()` (MockTimers does not cover it; RESEARCH Pitfall 7). Note that `LabBoard` uses `performance.now()` for review timing (cards.ts:279, :320). Leave that alone and inject a separate `now` in `BoardOptions`.

---

### `src/comparison.ts` — add `situationChanges(before, after)` (service, transform)

**Analog:** `stabilityBetweenRuns` in the same file, lines 638-663 (may shift; 01-11 is editing this file; re-read).

**Gate + identity + per-card loop to copy:**
```ts
const identity = reconstructedIdentity(before, after);
if (identity === null) return { ...result, skipped: SOURCE_UNAVAILABLE };          // → every row 'no_source'
if (!compareRuns(before, after).comparable) return { ...result, skipped: 'прогоны несравнимы' };  // → 'runs_differ'
const agent = identity ?? { ...before, agent: agentIdentity(before) };
if (agent.targetFingerprint !== after.targetFingerprint || agent.targetVersion !== after.targetVersion
  || agent.agent !== agentIdentity(after)) …                                         // → agentChanged = true (not a skip here)
const source = observedRecord(before), repeat = observedRecord(after);
for (const card of repeat.scenarios) {
  const sourceCard = source.scenarios.find(item => item.id === card.id);             // missing → 'only_one_run'
  if (fingerprint(normalizeScenarioIdentity(card, after.target.kind)) !== sourceCardIdentity(before, sourceCard, identity)) continue; // → 'situation_changed'
  const was = goalCardOutcome(source, sourceCard), now = goalCardOutcome(repeat, card);
```
- `reconstructedIdentity` (:622) and `sourceCardIdentity` (:628) are **private**. That is why `situationChanges` must live in this file.
- Use `cardVerdict(record, scenario)` (:576, returns `{ outcome, reason? }`) instead of `goalCardOutcome`, because the `not_measured_*` rows need the reason code.
- For the reassess basis, reuse the checks of `stabilityAfterReassess` (:665+). A changed judge gives `judge_changed` on every row.
- Types sit next to `StabilityRow`/`Stability` (:599-604). Use the same doc-comment style («Found instability only…»).
- Do **not** use `compareRuns().fixed/regressed` or its headline (strict `cardOutcome` :500, word «карточек»).
- Exclude positive controls exactly as `buildResultView` does (`src/result-view.ts:98, 101`).

---

### `src/result-view.ts` — `changes`, `compareRows`, exports (utility, transform)

**Analog:** itself.
- The optional field pattern (lines 84-85, 160): `stability?: Stability;` … `...(stability ? { stability } : {})`. Add `changes?: SituationChanges` the same way, built only when `options.before` is given (line 95 signature `buildResultView(input, options: { before?: Experiment } = {})`).
- The wording-map pattern (line 164): `const VERDICT_WORD: Record<StabilityRow['before'], string> = { pass: 'справился', fail: 'не справился' };`. Reuse it for the K rows. Add `CHANGE_TEXT` / reason-word maps next to `NOT_MEASURED_TEXT` (lines 33-52) as `Record<Code, string>`.
- `stabilityOf` (lines 89-93) shows how the basis is picked: `input.assessmentOf === before.id` → reassess.
- `evidenceBundle` already passes `before` (`src/artifacts.ts`: `bundle.view = buildResultView(snapshot, { before: bundle.before })`).
- Pointer renames R-01…R-04 happen in the phase-2/3 functions (`allFailuresPointer` `[plan 02-04]`, F8 `[plan 03-03]`) wherever they landed.

---

### `extensions/render/theme.ts` (utility, terminal paint)

**Analog:** `extensions/cards.ts` (whole file will be re-shaped by 02-05; re-read).

**Imports** (cards.ts:1-2). Extensions import pi-tui directly and use `.ts` for sibling extension files:
```ts
import type { ExtensionContext, Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
```
Compiled `src` code is imported as `'../dist/*.js'` (cards.ts:3-8). From `extensions/render/` it is `'../../dist/*.js'`, and from `render/tabs/` it is `'../../../dist/*.js'`.

**`safeText` to move** (cards.ts:10-14), then re-export it from `cards.ts` (tests import it from there, test/cards.test.ts:4):
```ts
export function safeText(value: unknown): string {
  return stripTerminalSequences(String(value ?? '')).replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    .replace(/[ ---‪-‮⁦-⁩]/g, '');
}
```
**Row + paint today** (cards.ts:64-66, 409-413, 498). Extend `Line` into `Row` (`tone`, `indent`, `bg`, `anchor`, `role`, `segments`) and `BoardTheme` into `Pick<Theme, 'fg' | 'bold' | 'bg'>`:
```ts
type BoardTheme = Pick<Theme, 'fg' | 'bold'>;
type Line = { text: string; color?: ThemeColor; bold?: boolean };
const line = (text: unknown, color?: ThemeColor, bold = false): Line => ({ text: safeText(text), color, bold });
…
const paint = (row: Line) => { let value = row.text; if (row.bold) value = this.theme.bold(value); return row.color ? this.theme.fg(row.color, value) : value; };
…
const content = detail.flatMap(row => wrapTextWithAnsi(row.text, inner).map(text => paint({ ...row, text })));
```
- `wrapRows` (hanging indent, `visibleWidth` only) is created by `[plan 02-05]` in `cards.ts`. Phase 4 moves it here and re-exports it. It must also copy `bg` and `anchor` onto continuation rows.
- **Bar to replace** (cards.ts:444-448). Its current single-tone row with `c Остановить` is removed by UI-SPEC P-board:
```ts
const filled = planned ? Math.min(20, Math.round(record.trials.length / planned * 20)) : 0;
header.push(line(`${'━'.repeat(filled)}${'─'.repeat(20 - filled)}  ${record.trials.length} / ${planned} диалогов · c Остановить`, 'accent'));
```
- `.repeat` for the bar glyphs is fine (not measuring displayed text). The lint test forbids `.slice(` / `padStart(` / `padEnd(` / `.length` on displayed text in `extensions/render/**`. Today's offenders to **not** copy: `humanFindingText(f).slice(0, 240)` (cards.ts:132, :226) and `.slice(0, 100)` on the query (:351).
- Frame safety net to keep in `cards.ts`, not in theme (cards.ts:414-415, 526): `truncateToWidth(content, …, '…', true)`.

---

### `extensions/render/verdict-block.ts` (component, render)

**Analog:** `LabBoard implements Component` (cards.ts:263, `invalidate() {}` :318, `render(width: number): string[]` :401), plus the current `renderCall` (agent-lab.ts:23):
```ts
renderCall: (_args, theme) => new Text(theme.fg('accent', 'Проверка агента'), 0, 0),
```
- Component skeleton, `isVerdictDetails` guard and `Box(1, 1, s => theme.bg('customMessageBg', s))`: copy from 04-RESEARCH Pattern 1 and «Hosts in `agent-lab.ts`» (no repo analog for `Box` or `registerEntryRenderer` yet).
- Error text on throw: `safeText(error instanceof Error ? error.message : error)` (the `inputError` helper at agent-lab.ts:47, and cards.ts:309).
- `hint` is injected as `() => string`; tests pass a fixed string.

---

### `extensions/render/tabs/*.ts` (component rows, transform)

**Analogs (move first, no behavior change):**
- `summary.ts` ← `verdictLines` (cards.ts:189-257) and `verdictHeadline` (:258-260). UI-SPEC T1 then removes `ЧТО ТРЕБУЕТ ВНИМАНИЯ` (:203-208), `3 — открыть диалог…` (:208, :227, :238) and the `a — обсудить…` row (:213). Phase 2 `[plan 02-05]` already rewrites this function; move whatever it became.
- `situations.ts` ← `scenarioLines` (:70-124) plus the `[plan 02-08]` sheet rows.
- `dialogues.ts` ← `trialLines` (:126-182). The event loop to annotate with `anchor: 'seq:<n>'` and `bg` (:164-173):
```ts
const roles = { user: 'ПОЛЬЗОВАТЕЛЬ', assistant: 'АГЕНТ', simulator: 'СИМУЛЯТОР', retrieval: 'RAG-КОНТЕКСТ', tool_call: 'ВЫЗОВ', tool_result: 'РЕЗУЛЬТАТ', error: 'ОШИБКА' };
for (const event of trial.events) {
  if (!expanded && !['user', 'assistant', 'error'].includes(event.type)) continue;
  transcript.push(line(`#${event.seq}  ${roles[event.type]}${event.tool ? ` · ${event.tool}` : ''}`, …, true));
  if (event.text !== undefined) transcript.push(line(event.text));
  …
  transcript.push(line(''));   // blank row after the event: NOT highlighted
}
```
  `retrieval` → `СПРАВКА ИЗ БАЗЫ` (C-145). `cards.ts` must keep re-exporting `trialLines` (imported at agent-lab.ts:20).
- `failures.ts`: list entry format ← the `results` entries at cards.ts:334-339 (`● ` prefix, label, title; drop `${t.userMode} #${t.repeat + 1}`, UI-SPEC D-25). The detail pane is the F10 block `[plan 03-06]` (`situationEvidence` in `src/explain.ts` `[plan 03-06]`, `failureExplanation` `[plan 02-04]`). The jump seq comes from the phase-2 explanation field behind `Сказал (реплика #<seq>)` `[plan 02-04]`; read the real name from `src/explain.ts` after it lands (A5).
- `compare.ts`: row style ← `resultViewLines` stability rows (result-view.ts:208-210): `\`  нестабильно: ${row.title} — было «${VERDICT_WORD[row.before]}», стало «${VERDICT_WORD[row.after]}»\``. Text comes from `compareRows(view.changes)` in `src/result-view.ts`; the tab only maps roles to tones.

---

### `extensions/cards.ts` — frame, tabs, jump, progress header (component, event-driven)

**Analog:** itself. **02-05/02-08/03-04/03-06 rewrite this file first; re-read everything.**

- **Section type** (:38): `export type Section = 'agent' | 'cards' | 'results';` → add `'failures' | 'compare'`. Keep the ids (phase-2 `y`/`e` scope on `cards`, phase-3 `y`/`n`/`s` on `results`).
- **Tab keys today** (:365-367). Extend to state-dependent tab sets, `4`, `tab`/`shift+tab`, and reset the jump there:
```ts
const section = key('1') ? 'agent' : key('2') ? 'cards' : key('3') ? 'results' : undefined;
if (section) { this.section = section; this.selected = 0; this.scroll = 0; this.query = ''; this.help = false; }
```
- **Search ignores control chars** (:351). `tab` is `\t`, so it never reaches the query. Digits still type into the query (:347-353 runs before tab logic).
- **Esc chain** (:355-359). Insert the jump-return check **before** `if (this.help)`.
- **Enter** (:395-398). Add the `failures` branch before the `this.expanded = !this.expanded` toggle.
- **Scope widening for `u`, `/`, reviewable** (:362, :368, :370-371): `['cards', 'results'].includes(this.section)` and `this.section === 'results'`. Add `'failures'` here.
- **Entries per section** (:330-343). Add a `failures` branch (the phase-3 queue order `[plan 03-04]`).
- **Tab row today** (:421-422). Replace it with `pickTier` tiers and segments:
```ts
header.push(line([['agent', '1 Обзор'], ['cards', `2 Карточки ${record.scenarios.length}`], ['results', `3 Диалоги ${record.trials.length}`]]
  .map(([id, label]) => this.section === id ? `[${label}]` : label).join('   '), 'muted'));
```
- **Header message row** (:432) uses `verdictHeadline`, which UI-SPEC D-28 removes. Active runs show `record.message` here; the P-board rows replace it.
- **Scroll / height budget** (:509-514). Add scroll-to-anchor right after `this.maxScroll` is computed:
```ts
const available = Math.max(1, height - header.length - footer.length - 4);
this.maxScroll = Math.max(0, content.length - available);
this.scroll = Math.min(this.scroll, this.maxScroll);
```
- **Load timer** (:288-290, :292-312). `refresh()` is the place for `onFinished` (it detects `!activePhases.has(record.phase)` at :306 and clears the timer). Add the injected `now` to `BoardOptions` (:47-63).
- **Footers** (:499-512). Replace with the UI-SPEC tier tables through `pickTier`. The `o` prefix pattern is at :508.
- **Help rows** (:497). Replace per UI-SPEC «Help».
- **Phase word** (:18): `review: 'ПРОВЕРЬТЕ КАРТОЧКИ'` → `'ПРОВЕРЬТЕ СИТУАЦИИ'`. Welcome rows :455-457 and the empty row :463 contain «Карточки»/«карточка» (R-07, R-08).
- **`BoardAction`** (:39-46): the agree action `[plan 03-04]` (`type: 'agree'`) carries `section: 'failures' | 'results'`. The notice kind is widened to `success | info | error` by `[plan 02-08]`.
- **`showBoard`** (:530-534) is unchanged.

---

### `extensions/agent-lab.ts` — hosts, progress loop, board entry (controller)

**Analog:** itself. **02-05, 02-07, 02-08 and 03-04 edit this file first; edits must be sequential; re-read.**

**Current `renderResult` → rename to `legacyResult`, keep its body unchanged** (:22-41). The dispatch goes in front of it: `isVerdictDetails` → `VerdictBlock`; `isPartial && kind === 'agent-lab/progress'` → progress rows; else legacy. The existing catch-all pattern is `catch { return new Text(safeText(raw), 0, 0); }` (:40).

**Status helper to mirror with a separate key** (:43-46):
```ts
const returnToBoard = (ctx: ExtensionContext, id: string) => {
  if (!ctx.hasUI || ctx.mode !== 'tui') return;
  ctx.ui?.setStatus?.('agent-lab', `Agent Lab · ${id.slice(0, 8)} · /agent-lab ${id} — детали`);
};
```
Progress uses key `'agent-lab-progress'`. Clear `'agent-lab'` when the run starts and set it again at the end (D-19).

**Progress loop to rewrite** (`agent_lab_run`, :563-579). Keep the `timer`/`polling`/`finally` skeleton; change the cadence to 1000 ms, dedupe on text, add `setStatus`, and clear it in `finally`:
```ts
const progress = async () => {
  const r = await lab.get(draft.id);
  onUpdate?.({ content: [{ type: 'text', text: safeText(`Проверено ${r.trials.length} из ${plannedTrials(r)} · ${r.message}`) }], details: { id: r.id, phase: r.phase } });
};
await progress();
timer = setInterval(() => { polling = polling.then(progress).catch(() => {}); }, 750);
await lab.waitForIdle(); await progress();
…
} finally { clearInterval(timer); signal.removeEventListener('abort', cancel); await polling; await close(); }
```
The same skeleton with text dedupe (`if (text !== lastProgress)`) is at :382-399 and :437-446 (build validate/score). Copy that dedupe.

**Result return to change** (:573-578). Today `details: output` stores the whole summary, including `proofs`; that is an anti-pattern (0644 session file). New: `details: { kind: 'agent-lab/verdict', version: 1, runId, resultKey, view: bundle.view }`. `content` stays the JSON plus `shownToOwner`. Tests parse `content` (test/extension.test.ts:41-43). The same `details: output` pattern is at :222, :266, :355, :415, :432, :445 (build), :475 (inspect: `details: { id }`) and :493/:538 (reassess etc.); switch only the result-producing tools listed in UI-SPEC S2a.

**`summary()` payload** (:74-86) already emits `view` and `viewLines`. Keep it for the model text and the legacy renderer.

**System prompt to edit** (:172): «…then lead with one estimated card accuracy number, grounded failure causes…» → tell the model the block is already shown.

**`/agent-lab` loop** (:736-748, :796-803, :821-826). `showBoard(ctx, { record, section, …, view: bundle?.view, load: async () => evidenceBundle(await lab.get(record.id), lab.store, beforeId) })`. Add `onFinished` and `now` here. The `resultKey` dedupe set is seeded from `ctx.sessionManager.getEntries()`; `resultHash` is already imported (:8). Board `run` sets `section = 'results'` (:800), which becomes `'agent'` or stays per UI-SPEC. `finalize` refusal sets `section = 'results'; pendingOnly = true` (:825), which becomes `'failures'` (UI-SPEC «Where the board reopens»).

**Registration.** Add `pi.registerEntryRenderer('agent-lab-verdict', …)` next to `pi.registerCommand('agent-lab', …)` (:716). The fake `pi` in `test/extension.test.ts:20-39` must gain `appendEntry` and `registerEntryRenderer` stubs, or `agentLab(...)` will throw on the missing method.

---

### `skills/agent-builder/SKILL.md` (doc)

**Lines 32-39:** «After the run, report in this order: 1. estimated accuracy…». Rewrite so the model does not restate the block. `test/skill.test.ts` checks only the discovery section (:8).

---

### Tests

**`test/verdict.test.ts`, `test/progress.test.ts`** ← `test/result-view.test.ts:1-20`: `node:assert/strict`, `node:test`, and imports from `'../src/*.js'` (tsx resolves them):
```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildResultView, NOT_MEASURED_TEXT, resultViewLines, wilson } from '../src/result-view.js';
```
Build views from fixture records as that file does. Use the vector tables in UI-SPEC V1/V2 and P1. Progress: pass `now` explicitly. For the tool loop, `t.mock.timers.enable({ apis: ['setInterval', 'Date'] })` with 1000 ms ticks only.

**`test/theme.test.ts`, `test/verdict-block.test.ts`** ← `test/cards.test.ts:1-13`:
```ts
import { visibleWidth, stripTerminalSequences } from '@earendil-works/pi-tui';
import { LabBoard, reviewOrder, safeText, type BoardAction, type BoardOptions } from '../extensions/cards.ts';
const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value };
```
The fake theme must gain `bg` and emit distinct markers per token (light/dark fakes). Host parity uses the real `initTheme` and `ToolExecutionComponent` (RESEARCH «Host-parity test»).

**`test/cards.test.ts`** (extend). Pattern at :15-31: build a `LabBoard({ record, section: 'results', … }, theme, value => { action = value; }, () => {})`, call `board.render(120)`, `board.handleInput('n')`, and assert on `action`. Use `handleInput('\t')`, `'\x1b[Z'`, `'\r'` and `'\x1b'` for the tab and jump keys. The phase-3 plan already changes the `p`/`n` flow (03-04); re-read.

**`test/extension.test.ts`** (extend). The fake `registered()` is at :20-39, and `output(result)` JSON parsing is at :41-43. Add stubs, a `setStatus` recorder and `getEntries` to the fake ctx.

**New test files must sit directly in `test/`** (`package.json` test glob is `test/*.test.ts`).

---

### Verification scripts (`.planning/phases/04-ekran-rezultata-v-pi/`)

**`render-matrix.mts`, `live-progress-check.mts`** ← `.planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts:1-25`:
- the header comment states «Read-only… Prints only ids and counts: never a line of the record (bank dialogues)»;
- `parseArgs` with `--cwd` / `--id` (multiple), usage message to stderr, and `process.exit(2)`;
- `root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')`, so a snapshot checks its own `dist/`;
- the extension is loaded with `(await import(pathToFileURL(resolve(root, 'extensions/agent-lab.ts')).href)).default`.

Budget gate and ledger: `live-check.mjs budget … --next run --cap 1` and `spent` (same directory). Run from a snapshot: `snap-test.sh --keep <tests>` prints `SNAP=<path>` as its last stdout line (snap-test.sh:5-9).

## Shared Patterns

### Escaping at one boundary
**Source:** `extensions/cards.ts:10-14` (`safeText`), `:66` (`line()` escapes on construction).
**Apply to:** `renderRows` in `theme.ts` (every row and segment), the entry-renderer error text, and progress `record.message` (P2). Pure `src/` modules return raw text (result-view.ts:5-8).

### Width only through pi-tui
**Source:** cards.ts:2 imports; :498 `wrapTextWithAnsi(row.text, inner)`; :526 `visibleWidth(row) > width ? truncateToWidth(row, width, '…') : row`.
**Apply to:** all of `extensions/render/**`. `truncateToWidth(styled, inner, '', true)` is used only to pad `selectedBg` rows.

### Pure views, surfaces count nothing
**Source:** result-view.ts:5-11 and the cards.ts:196 comment «the board never counts or picks a not-measured card itself».
**Apply to:** `verdict.ts`, `progress.ts`, `situationChanges`, and every tab file.

### Non-TUI guard
**Source:** agent-lab.ts:44 `if (!ctx.hasUI || ctx.mode !== 'tui') return;` (also :163, :226, :548).
**Apply to:** `setStatus` progress, `appendEntry`, and board opening.

### Timer + polling + finally cleanup
**Source:** agent-lab.ts:552-579 (`let timer`, `let polling = Promise.resolve()`, `polling = polling.then(progress).catch(() => {})`, `finally { clearInterval(timer); …; await polling; await close(); }`).
**Apply to:** the progress loops in `agent_lab_run`, the build validate/score paths and reassess. Add `setStatus('agent-lab-progress', undefined)` inside the same `finally`.

### Errors
`throw new Error('<русский текст>')` (agent-lab.ts:548, :558). Renderers never throw: catch and return `Text(safeText(...))`.

### Tests from a snapshot only
`bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh <test files>`; never `npm test` or `npm run build` in the worktree.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `.planning/phases/04-*/pi-reopen-check.sh` | pty script | batch | No pty harness exists in the repo; use the RESEARCH spike B command (`PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, `script -q`, `timeout`, `mktemp -d`, `pgrep` at the end) |
| `.planning/phases/04-*/board-pty-check.sh` | pty script | batch | Same; use the RESEARCH spike C key walk on `/agent-lab demo` |
| `Box` / `registerEntryRenderer` / `appendEntry` use | host glue | — | Not used anywhere in the repo yet; follow RESEARCH «Hosts in `agent-lab.ts`» and installed `types.d.ts` |
| `agreement.queue` counts | utility | transform | `src/agreement.ts` does not exist yet `[plan 03-01]`; add the counts only if 03 did not publish them (RESEARCH Open Question 1) |

## Metadata

**Analog search scope:** `extensions/`, `src/`, `test/`, `skills/agent-builder/`, `.planning/phases/01-*/` scripts, `02-0*-PLAN.md` / `03-0*-PLAN.md` (for symbol ownership only)
**Files scanned:** 14 source/test files + 16 plan files (grep only)
**Pattern extraction date:** 2026-09-17 (HEAD 81bcea2)
