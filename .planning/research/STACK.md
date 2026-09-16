# Stack Research

**Domain:** Terminal-native UI for an AI-agent evaluation product (Agent Lab, a Pi package): inline verdict block, full-screen board, onboarding checklist, live progress, text summary, single-file HTML report
**Researched:** 2026-09-16
**Confidence:** HIGH for Pi / pi-tui APIs (every name checked in the installed 0.85.1 typings and runtime JS). MEDIUM for the HTML size budget and the text-summary format (these are design choices, not API facts).

> Scope: this covers only what the four target features need. The base stack (TypeScript ESM, Node >=22.19, zod 4, typebox, Pi SDK and pi-tui 0.85.1, node:test via tsx) is already described in `.planning/codebase/STACK.md`.
>
> **Verdict:** no new runtime dependency is needed. Everything can be built from what `@earendil-works/pi-coding-agent@0.85.1` and `@earendil-works/pi-tui@0.85.1` already export, plus plain string templates for HTML and text.

---

## Recommended Stack

### Core Technologies (already installed — use these exact APIs)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `ToolDefinition.renderResult` / `renderCall` (+ `ToolRenderContext`) | pi-coding-agent 0.85.1 | Verdict block in the chat after an LLM-initiated run, and live progress while the tool runs | This is the native slot for a tool row. It receives `result.details` for **both** partial (`onUpdate`) and final results, plus `{ expanded, isPartial }`. Verified in `dist/modes/interactive/components/tool-execution.js` (`updateResult(result, isPartial)` → `resultRenderer({content, details}, {expanded, isPartial}, theme, ctx)`). `details` is saved in the session (`ToolResultMessage.details`, `pi-ai/dist/types.d.ts:330`), so the block renders again when the session is reopened. |
| `pi.appendEntry(customType, data)` + `pi.registerEntryRenderer(customType, renderer)` | pi-coding-agent 0.85.1 | The same verdict block when the run starts from `/agent-lab` or the board (so there is no tool row) | Custom entries are saved, rendered in the chat as soon as they are appended (`interactive-mode.js`, `entry_appended` → `addCustomEntryToChat`), and **not sent to the LLM**. `CustomEntryComponent` rebuilds on `invalidate()`, so theme changes work. `types.d.ts:890, 969, 985`. |
| `ctx.ui.custom<T>(factory, { overlay: true, overlayOptions })` | pi-coding-agent 0.85.1 | Full-screen board with tabs, drill-down and one-key verdicts | Already used by `extensions/cards.ts` (`showBoard`). The factory gets `(tui, theme, keybindings, done)`, and the component owns `handleInput`. `types.d.ts:117-127`; `OverlayOptions` in `pi-tui/dist/tui.d.ts:134`. Keep `width: '100%', maxHeight: '100%', anchor: 'top-left', margin: 0`. |
| `ctx.ui.setWidget(key, factory \| string[], { placement })` | pi-coding-agent 0.85.1 | Onboarding checklist (agent → requirements → logs → connection → budget → run) | The only persistent area above or below the editor. **A string array is cut to 10 lines** (`InteractiveMode.MAX_WIDGET_LINES = 10`, `interactive-mode.js:1773`). A component factory is **not** cut, so use a factory `(tui, theme) => Component & { dispose? }`. `types.d.ts:96-100`. |
| `ctx.ui.setStatus(key, text)` | pi-coding-agent 0.85.1 | One-line live progress in the footer (`12/15 · ~2 мин · $0.84`) that stays visible after the tool row scrolls away | Already used (`returnToBoard`). Cleared with `undefined`. `types.d.ts:80`. |
| `ctx.ui.setWorkingMessage(msg?)` | pi-coding-agent 0.85.1 | Replaces the streaming spinner label while a run is in progress | Cheap, and restored with no argument. `types.d.ts:82`. |
| `Theme.fg(ThemeColor, s)` / `Theme.bg(ThemeBg, s)` / `bold` / `italic` / `underline` / `inverse` / `strikethrough` | pi-coding-agent 0.85.1 | The single visual language: colors, bars, highlighted turn | `dist/modes/interactive/theme/theme.d.ts`. Use semantic colors only: `success`, `error`, `warning`, `accent`, `muted`, `dim`, `text`, `border*`, and the backgrounds `selectedBg`, `customMessageBg`, `toolSuccessBg`, `toolErrorBg`, `toolPendingBg`. These adapt to light/dark themes and to 256-color terminals. |
| pi-tui width helpers: `visibleWidth`, `truncateToWidth(text, w, ellipsis?, pad?)`, `wrapTextWithAnsi`, `sliceByColumn`, `stripTerminalSequences` | pi-tui 0.85.1 | Alignment, wrapping without cutting mid-word, column layout | Exported from `pi-tui/dist/index.d.ts`. **Rule:** no line from `render(width)` may be wider than `width`. `cards.ts` already enforces this as a final safety step. |
| pi-tui input: `matchesKey(data, KeyId)`, `Key.*` | pi-tui 0.85.1 | Tabs (`1`–`4`, `tab`, `shift+tab`), navigation, agree/disagree keys | `pi-tui/dist/keys.d.ts:42-52`. Already used in `cards.ts`. |
| `copyToClipboard(text)` | pi-coding-agent 0.85.1 (`dist/index.d.ts:30` → `utils/clipboard.d.ts`) | "Copy summary" key on the board and in the command | Uses a native addon, then pbcopy / wl-copy / xclip, then OSC 52 (≤100 KB encoded). No `clipboardy` needed. Exported but **not documented** for extensions, so wrap it in try/catch and fall back (see Patterns). |
| Node built-ins (`node:fs/promises`, `node:crypto`) + template strings | Node ≥22.19 | Single-file HTML report and `.summary.txt` | `src/report.ts` already builds HTML with `escape()`, a CSP meta tag and a hashed script. Extend that approach; no template engine. |

### Supporting pieces (already exported, use when needed)

| Library / API | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `Box(paddingX, paddingY, bgFn)` (pi-tui) | 0.85.1 | Tinted card behind the verdict block (`theme.bg('customMessageBg', …)`) | In `registerEntryRenderer`. Inside a tool row, the default shell already adds a Box and a background, so return `Text` / a custom component with padding 0 (Pi docs "Best Practices"). |
| `Text(text, px, py)` / `Container` / `Spacer` (pi-tui) | 0.85.1 | Simple multi-line blocks with automatic wrapping | For summary lines. Use a custom `Component` when you need bars aligned to the width. |
| `renderShell: 'self'` on the tool | 0.85.1 | Tool draws its own frame instead of the green/red tool background | Only if the default `toolSuccessBg` shell clashes with the block design. It is optional; start with the default. `types.d.ts:360`. |
| `keyHint(id, desc)` / `rawKeyHint(key, desc)` | 0.85.1 (`dist/index.d.ts:28`) | Key hints that respect user keybindings (e.g. `app.tools.expand` → "раскрыть") | In the inline block footer ("Ctrl+O — подробнее"). |
| `ctx.ui.getToolsExpanded()` / `setToolsExpanded()` | 0.85.1 | Read or toggle the expanded view of tool rows | Render a short block when collapsed and the full cause list when `options.expanded`. |
| `pi.registerShortcut(KeyId, { handler })` | 0.85.1 | Global key to open the board | Optional; `/agent-lab` already opens it. Check for conflicts in `docs/keybindings.md` first. |
| `ctx.ui.select / confirm / input / editor / notify` | 0.85.1 | Disagree reason (editor), budget confirmation (confirm), clipboard fallback (editor with the text prefilled) | Already used. `confirm/select` accept `{ timeout, signal }` (`ExtensionUIDialogOptions`). |
| `hyperlink(text, url)` (pi-tui `terminal-image.d.ts:111`) | 0.85.1 | Clickable `file://` link to the HTML report in the verdict block (OSC 8) | Ignored by terminals without OSC 8 support, so keep the printed path as well. |
| `DynamicBorder`, `BorderedLoader` (pi-coding-agent `dist/index.d.ts:28`) | 0.85.1 | Framed loader with cancel | Only for a short blocking step (e.g. connection check). Runs already have their own progress. |
| `HStack` / `VStack` / `ScrollView` / `MouseRegion` (pi-tui) | 0.85.1 | Flex layout, scrolling, mouse | **Do not adopt before the demo.** `ScrollView` depends on the viewport-TUI layout protocol (`updateLayout`, `LAYOUT_NODE`). The board's manual scrolling and sidebar already work. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `node:test` via `tsx --test` | Tests for the pure renderers (`verdictBlockLines`, `progressLine`, `shareText`, `managerReport`) | Pass a **fake theme** (`{ fg: (c, s) => \`<${c}>${s}</${c}>\`, bg: …, bold: s => s }`) so tests check structure and color roles without ANSI codes. Check with `visibleWidth(line) <= width` for widths 40/80/120. Built-in snapshot testing (`t.assert.snapshot`) still needs an experimental flag on Node 22, so compare against checked-in golden strings instead (MEDIUM confidence on the flag status). |
| Size assertion in tests | Enforce the HTML size budget | `Buffer.byteLength(managerReport(fixture)) < 200_000` on a 15-card / 60-dialogue fixture. |
| `PI_TUI_WRITE_LOG=/path` | Capture the raw ANSI stream while debugging rendering | From `docs/tui.md`. |
| Tests from a `git archive HEAD` snapshot | Avoid deleting `dist/` under a live Pi session | Project rule; `npm test` rebuilds `dist/`. |

## Installation

```bash
# Nothing to install. All required APIs ship in the pinned packages:
#   @earendil-works/pi-coding-agent@0.85.1
#   @earendil-works/pi-tui@0.85.1
# New value imports in extensions (no new package):
#   import { copyToClipboard, keyHint, type Theme, type ThemeColor } from '@earendil-works/pi-coding-agent';
#   import { Box, Text, Container, matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi, hyperlink, type Component } from '@earendil-works/pi-tui';
```

---

## Prescriptive build per feature

### 1. Inline verdict block in the chat (HIGH)

- **One pure view model:** `resultView(bundle | record): ResultView`, a small versioned JSON object (`{ v: 1, headline, denominator, bars: [{label, value, total, tone}], causes: [{should, said, rule, trialId, seq}], notMeasured, next, reportPath? }`), built from `qualitySummary`. It must stay a few KB and **must not contain whole dialogues**, because it is saved in the session file.
- **One pure renderer:** `verdictBlockLines(view, width, theme: Pick<Theme,'fg'|'bg'|'bold'>): string[]`, wrapped in a tiny `Component` (`render(width)` computes the lines, `invalidate()` clears the cache). Recomputing in `render()` means theme changes need no special handling (see `docs/tui.md` "Invalidation and Theme Changes").
- **Two hosts, one renderer:**
  - LLM tool path: return `{ content: [LLM text], details: { view } }`, and have `renderResult` read `result.details.view`. Stop parsing JSON back out of `content` as the current `toolDisplay` does: that is fragile, and it couples the LLM text to the UI.
  - Command/board path: `pi.appendEntry('agent-lab-verdict', view)` + `pi.registerEntryRenderer('agent-lab-verdict', …)` inside a `Box(1, 1, s => theme.bg('customMessageBg', s))`. If the LLM also needs the result, add a separate `pi.sendMessage({ customType: 'agent-lab-context', display: false, … })`, as the code already does.
- **Bars:** draw them yourself with eighth-block characters (`█▉▊▋▌▍▎▏` for the fill, `░` or `─` for the track). Color the fill with `success`/`error`/`warning` and the track with `dim`. Right-align the numbers with `visibleWidth`. Wrap cause text with `wrapTextWithAnsi` and a hanging indent. **Never** truncate a cause mid-word; truncation is a known "shameful first screen" defect.
- **Collapsed vs expanded:** use `options.expanded`. Collapsed: verdict line, bars, 3 causes, next step, hint via `keyHint('app.tools.expand', 'подробнее')`. Expanded: all causes and the "не измерено" breakdown.

### 2. Full-screen board with tabs (HIGH for the API, MEDIUM for key choices)

- Keep `LabBoard` + `showBoard` (`ctx.ui.custom`, overlay 100%). Change `Section` to `'summary' | 'failures' | 'dialogues' | 'comparison'`. Keys `1`–`4` plus `tab` / `shift+tab` (`matchesKey(data, 'shift+tab')`). Draw the tab bar as a line: active tab `theme.bold(theme.fg('accent', …))`, others `muted`.
- **Split `cards.ts` (529 lines) before adding tabs:** `board/frame.ts` (border, header, footer, width guard), `board/tabs/*.ts` (pure `Line[]` producers per tab), and the shared `ui/visual.ts` (bars, colors, wrap). The Summary tab reuses `verdictBlockLines`, so the block, the board and the progress indicator use one visual language.
- **Drill-down with a highlighted turn:** Failures → Enter → dialogue view scrolled to `seq`. Paint the cited event's lines with `theme.bg('selectedBg', truncateToWidth(line, inner, '', true))`. `pad=true` fills the row. `applyBackgroundToLine` exists in `utils.d.ts` but is **not exported** from `pi-tui/dist/index.d.ts`, so do not import it. Put `scroll` at the highlighted line's index in the wrapped content (the board already tracks `scroll`/`maxScroll`).
- **One-key agree/disagree:** the component calls `done({ type: 'verdict', agree: true|false, … })`, and `agent-lab.ts` saves the human review and reopens the board (existing "finish → act → re-show" loop; overlays are disposed on close, so always create a new one, as `docs/tui.md` "Overlay Lifecycle" says). The existing keys `p`/`n`/`v`/`x`/`d` are already taken; pick agree/disagree keys that do not clash (e.g. `y` agree / `n` disagree, and move "fail" under disagree). Show the agreement rate (goal ≥90%) in the header.
- The existing 750 ms `setInterval` + `load()` refresh stays the live-update method for the board.

### 3. Onboarding checklist + live progress (HIGH)

- **Checklist:** `ctx.ui.setWidget('agent-lab-setup', (tui, theme) => new SetupChecklist(state, theme), { placement: 'aboveEditor' })`. Use a factory, not `string[]`, because of the 10-line cap. Each step is one row: `✓` success / `●` accent (current) / `○` dim (pending) + label + short value (e.g. "логи · 212 диалогов"). Call `setWidget` again with a new state after each step, or keep the component and call `tui.requestRender()`. Clear it with `setWidget(key, undefined)` when the run starts. The existing code already clears `agent-lab-start` in `before_agent_start`, so follow the same lifecycle.
- **Progress:** one pure `progressLine(snapshot, now, width, theme)` with bar + `done/planned диалогов · ~N мин осталось · $X.XX`. Estimate time left as `elapsed / done × (planned − done)` (show "оцениваю…" until 2 dialogues finish). Money comes from `record.usage.costUsd`; show "стоимость неизвестна" when it is `null`. Show the same line in three places:
  1. tool row: `onUpdate({ content: [{type:'text', text: plain}], details: { progress } })`, then `renderResult` with `isPartial === true` draws the bar;
  2. footer: `ctx.ui.setStatus('agent-lab', plain)` (clear it at the end);
  3. board header (it already shows a `━─` bar; replace that with `progressLine`).
- Only send `onUpdate` when the text changes (the current code already does this with `lastProgress`). The 750 ms poll interval is fine.

### 4. Text summary + lightweight single-file HTML (MEDIUM-HIGH)

**Text summary**
- Pure `shareText(quality, options): string` in `src/` (so the CLI and Pi share it). Plain UTF-8, no Markdown tables, no ANSI, no emoji. Aim for ≤ 900 characters / ≤ 15 lines so it fits a Telegram/Slack preview and an email body: verdict with one denominator, 3 causes as `должен был … → сказал … → правило N`, "не измерено", run date / agent version, and the report file name.
- Run every quoted fragment through `plain()` + `shorten()` (existing helpers). Bank dialogue quotes leave the machine through this text, so keep "said Y" quotes short (≤120 chars) and never include customer identifiers.
- Deliver it three ways: `copyToClipboard` (try/catch) → `ctx.ui.notify('Скопировано')`. On failure, open `ctx.ui.editor('Скопируйте выжимку', text)`. Always write `exports/<stem>.summary.txt` (mode `0600`, flag `wx`, as `exportArtifacts` already does).

**Single-file HTML for a manager**
- Add a new `managerReport(bundle)` next to the existing `htmlReport`. Keep the full evidence export for auditors, and make the manager report the default "open" target.
- **Why the current file is ~3 MB:** `trialHTML` embeds `JSON.stringify(trial.judgeAudit)` and a full `JSON.stringify({events, initialState, finalState})` for every dialogue. The manager report omits both, along with the cards/profiles section and raw JSON.
- **Size budget:** aim for ≤ 150 KB, with a hard test limit of 200 KB for 15 cards / 60 dialogues. Include only: verdict, bars, top causes with should/said/rule, and each failure's cited turns ± 1 turn (not the whole dialogue) inside `<details>`.
- **No external assets:** system font stack (`-apple-system, "Segoe UI", Roboto, sans-serif`), all CSS in one `<style>`, charts as **server-generated inline SVG** (`<svg viewBox>` with `<rect>` widths computed in TS, numbers checked with `Number.isFinite` and clamped to 0–100), no web fonts, no images, no CDN.
- **No JavaScript:** `<details>/<summary>` handles drill-down, and `:target` handles anchors. CSP: `default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`. Without a script, the CSP hash is also unnecessary.
- **Looks right when opened, printed, or mailed:** `<meta charset="utf-8">`, `<meta name="viewport">`, `lang="ru"`, `@media (prefers-color-scheme: dark)`, `@media print` (open all `details` content, avoid page breaks inside cards), max-width ~820px.
- **Escaping:** reuse `escape()` from `report.ts` (strips terminal control codes and bidi overrides, encodes `& < > " '`) for every text node and attribute. Always quote attributes. Build `id` values only from our own ids (`trial-${record.id}-${trial.id}`), never from dialogue text. Never put untrusted data inside `<style>`, `<script>`, `on*` attributes or `href` (OWASP XSS Prevention rules 1–2). Write with mode `0600` + `wx`.

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `renderResult` reading `details.view` | Parse JSON from `result.content` (current `toolDisplay`) | Never for new code: it ties the LLM text to the UI and breaks when the LLM text changes. |
| `appendEntry` + `registerEntryRenderer` for command-path blocks | `pi.sendMessage({ display: true })` + `registerMessageRenderer` | When the block itself **should** be in LLM context. Here the LLM gets a separate hidden context message, so the display entry stays out of the token budget. |
| Component-factory widget for the checklist | `setWidget(key, string[])` | Only for ≤10 plain lines with no colors per state. |
| Hand-drawn bars with block characters + theme colors | ASCII-chart libraries (asciichart, cli-chart) | Never here: the bars are one-dimensional, and a library adds a dependency and its own colors that ignore the Pi theme. |
| Manual scroll/sidebar in `LabBoard` | `ScrollView` / `HStack` / `VStack` | After the demo, if the board is rewritten for fullscreen mouse support. |
| Template strings + `escape()` for HTML | Handlebars / Eta / lit-html SSR / React SSR | Never for a single static report: the existing escaping is tested and CSP-safe. |
| Inline SVG computed in TS | Chart.js / Vega embedded | Never: they need JS (breaks the no-script CSP) and add 200 KB+. |
| Built-in `copyToClipboard` + editor fallback | `clipboardy` package | Never: same behavior, plus a dependency. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| A local web server / browser UI for the board | Out of scope by product rule ("только Pi"); also a known hook defect with a background server | `ctx.ui.custom` board; the HTML report is only a file |
| Ink / blessed / neo-blessed / React-in-terminal | A second render loop fighting Pi's TUI; new runtime dependencies | pi-tui `Component` |
| chalk / kleur / picocolors / raw `\x1b[3xm` codes | Ignores the user's Pi theme and light/dark mode | `theme.fg/bg/bold` |
| `setWidget(key, string[])` for >10 lines | Silently cut to 10 lines + "... (widget truncated)" | Component factory |
| Importing `applyBackgroundToLine` from pi-tui | Not exported from the package index | `theme.bg(color, truncateToWidth(line, w, '', true))` |
| Putting whole dialogues or judge audits in `details` / entries | Saved in the Pi session file forever; bloats sessions; private bank data | Small `ResultView` with ids; the board loads the rest from `.agent-lab` |
| Pre-baking themed strings into cached child components | Colors do not update on theme change (`docs/tui.md`) | Compute in `render()` or rebuild in `invalidate()` |
| `ctx.ui.custom` without a `ctx.mode === 'tui'` guard | Returns `undefined` in RPC; component factories are no-ops in json/print | Guard, and fall back to `notify` + text |
| JS, CDN fonts, `<img src=http…>` in the report | Breaks the offline and no-script CSP; can leak to the network from a bank laptop | Inline CSS/SVG, `<details>` |
| External eval/report frameworks (promptfoo viewer, GEPA, LangWatch) | Rejected on 2026-09-16 | Own renderers |

## Stack Patterns by Variant

**If the run starts from the LLM tool (`agent_lab` tool):**
- Progress goes to `onUpdate` → `renderResult(isPartial)` + `setStatus`; the final block goes to `renderResult(details.view)`.
- Because the tool row is the native place for tool output, and it is saved together with `details`.

**If the run starts from `/agent-lab` or the board:**
- Progress goes to the board header (poll) + `setStatus`; the final block goes to `appendEntry('agent-lab-verdict', view)`.
- Because no tool row exists; entries render in the chat right away and stay out of LLM context.

**If `ctx.mode !== 'tui'` (RPC/json/print, CLI):**
- Use `shareText()` as the only output, and write the report files.
- Because custom components and widgets are no-ops there (`docs/extensions.md` "Mode Behavior").

**If the terminal is narrow (<80 cols):**
- Bars shrink to a minimum of 10 cells, the sidebar is hidden (already done at <110), and numbers go on their own line.
- Because each rendered line must fit `width`, or Pi's renderer breaks the layout.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `@earendil-works/pi-coding-agent@0.85.1` | `@earendil-works/pi-tui@0.85.1` | Keep both pinned to the same exact version; `Theme`, `Component` and `OverlayOptions` types cross the boundary. |
| `renderShell`, `ToolRenderContext` (`invalidate`, `state`, `lastComponent`) | pi-coding-agent 0.85.1 | Present in `types.d.ts:315-377`; older Pi versions may lack `context`, so use only when pinned. |
| `registerEntryRenderer` | pi-coding-agent 0.85.1 | Present (`types.d.ts:969`); older sessions without the entry type simply do not render it. |
| `copyToClipboard` | pi-coding-agent 0.85.1 | Exported from the package root but not a documented extension API. Wrap it and keep the editor fallback in case it moves. |
| Node 22.19+ | `node:test` | Snapshot assertions are experimental on 22.x; use golden strings. |

## Sources

- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` (ExtensionUIContext L68–192, ToolRenderContext/ToolDefinition L307–377, MessageRenderer/EntryRenderer L889–890, ExtensionAPI L906–985) — HIGH
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.d.ts` (ThemeColor, ThemeBg, Theme methods) — HIGH
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js` (partial results carry `details`; `renderShell`) — HIGH
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js` (L1697–1773 widget cap of 10 lines for string arrays; L2591 live custom-entry rendering) — HIGH
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js` (rebuild on invalidate, error box) — HIGH
- `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts` L28–30 (`keyHint`, `rawKeyHint`, `DynamicBorder`, `BorderedLoader`, `copyToClipboard`); `dist/utils/clipboard.js` (native → pbcopy/wl-copy/xclip → OSC 52, 100 KB) — HIGH
- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (Custom Rendering, Custom UI, Message and Entry Rendering, Mode Behavior) and `docs/tui.md` (Line Width, Overlays, Invalidation, Key Rules) — HIGH
- `node_modules/@earendil-works/pi-coding-agent/examples/extensions/entry-renderer.ts`, `widget-placement.ts` — HIGH
- `node_modules/@earendil-works/pi-tui/dist/index.d.ts`, `utils.d.ts` (`applyBackgroundToLine` not exported), `tui.d.ts` (Component, OverlayOptions, OverlayHandle, TUI), `keys.d.ts`, `components/*.d.ts`, `terminal-image.d.ts` (`hyperlink`) — HIGH
- `extensions/cards.ts`, `extensions/agent-lab.ts`, `src/report.ts`, `src/artifacts.ts`, `src/quality.ts` (current implementation; source of the 3 MB size: `judgeAudit` and full trace JSON for every trial) — HIGH
- [OWASP Cross Site Scripting Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html) — context-specific encoding, quoted attributes, never put untrusted data in script/style/URL contexts — HIGH
- HTML size budget (≤150 KB target / 200 KB test limit) and the text-summary length (≤900 chars) — design judgment, MEDIUM

---
*Stack research for: Agent Lab result UI, board, onboarding, and shareable report*
*Researched: 2026-09-16*
