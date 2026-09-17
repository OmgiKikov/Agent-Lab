# Phase 5: Выжимка и HTML-отчёт для менеджера - Pattern Map

**Mapped:** 2026-09-17
**Files analyzed:** 17 new/modified files (plus 1 verification script)
**Analogs found:** 17 / 18

**Read this first (anchor stability).**
- Line numbers below were read at HEAD `61011aa` (+ the phase-2 02-01/02-02 work in progress on 2026-09-17).
- Phases 2, 3 and 4 are planned and only partly executed. They rewrite `src/result-view.ts`, `src/cli.ts`, `extensions/cards.ts` (04-02 splits it into `extensions/render/*`), `extensions/agent-lab.ts` and their tests. **Every anchor in those files may shift; re-read before editing.** Symbols that exist only in those plans are marked `[plan 0X-NN]`; take them from the landed code, never from this file.
- `src/report.ts`, `src/artifacts.ts` and `src/store.ts` are not touched by any phase 2–4 plan (checked with grep over the 02/03/04 PLAN `files_modified` lists), so their anchors should hold, but re-read anyway.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/redact.ts` (new) | utility (pure) | transform | `src/report.ts:9-11` (`plain`/`escape`/`md` sanitizers) + `src/contracts.ts` `verbatimSpan` normalisation `[plan 02-04]` | role-match |
| `src/render/text.ts` (new: `shareText`, `mskDateTime`, `shareRefusal`, customer cause lines) | utility (pure view) | transform | `src/result-view.ts:190-212` (`resultViewLines`) | exact |
| `src/render/html.ts` (new: `managerReport`, `MANAGER_CSS`) | utility (pure view) | transform | `src/report.ts:166-213` (`htmlReport`) | exact |
| `src/render/escape.ts` (new, moved) | utility | transform | `src/report.ts:9-10` | exact (move) |
| `src/report.ts` (banner, MSK header, `doNotForward`) | utility (pure view) | transform | itself :183-213, :225-234, :243-248 | exact |
| `src/artifacts.ts` (`writeExport`, stable names, `exportCustomer`) | storage/IO | file-I/O | itself :146-169 + `src/store.ts:85-96` (atomic tmp + rename) | exact |
| `src/store.ts` (`resolveId` prefix lookup) | storage | file-I/O | itself :106-120 (`list`) and :7, :23-26 (`idPattern`, `path`) | exact |
| `src/result-view.ts` (optional `title` mapper on `compareRows` only if missing) | utility | transform | `[plan 04-04]` `compareRows` | plan-only |
| `src/cli.ts` (`share`, `export --format manager`, audit path line) | controller (CLI) | request-response | itself :90-117 (`summary`, `export`) | exact |
| `extensions/agent-lab.ts` (`/agent-lab share`, `x` select, `o` manager, clipboard) | controller (Pi) | request-response | itself :716-720, :737-739, :839-849 | exact |
| `extensions/cards.ts` (`o` whenever shareable, help row) | component | event-driven | itself :383-384, :497, :503-508 (moves in `[plan 04-02]`, footer tiers in `[plan 04-06]`) | exact |
| `test/redact.test.ts` (new) | test | — | `test/result-view.test.ts` pure vectors; `test/judge.test.ts` tamper-table style | role-match |
| `test/share.test.ts` (new) | test | — | `test/result-view.test.ts` CLI spawn test (phase 1) | exact |
| `test/manager-report.test.ts` (new) | test | — | `test/artifacts.test.ts:144-159` (HTML self-containment test) | exact |
| `test/helpers/customer-leaks.ts` (new) | test helper | transform | `test/helpers/copy-check.ts` `assertPlainCopy` `[plan 03-03]`; `test/helpers/demo-record.ts` | role-match |
| `test/artifacts.test.ts`, `test/extension.test.ts`, `test/cards.test.ts` (extend) | test | — | themselves | exact |
| `.planning/phases/05-*/verify-share.mjs` (new) | script (read-only) | batch | `.planning/phases/01-odno-chestnoe-chislo/verify-stored-runs.mjs` + `[plan 03-07]` `agreement-check.mts` (temp copy) | exact |
| headless Chromium print/screenshot step | script step | batch | none in repo (05-RESEARCH «Headless open/print check») | no analog |

## Pattern Assignments

### `src/redact.ts` (utility, transform)

**Analog:** `src/report.ts:9-11` — one-line sanitizers, raw text in, raw text out, no escaping mixed in:
```ts
const plain = (value: unknown) => stripVTControlCharacters(String(value ?? '')).replace(/[‪-‮⁦-⁩]/g, '');
const escape = (value: unknown) => plain(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', … })[c]!);
```
- Module header comment in the style of `src/result-view.ts:5-11` (pure, no I/O, no escaping, who may import it).
- Exported constant names UPPERCASE (`PII_PATTERNS`, `OVERLAP_WINDOW`, `TITLE_MIN`), functions camelCase (`redact`, `customerGuard`, `luhnValid`, `innValid`).
- Client text sources to read: `record.trials[].events` with `type === 'user'` (`TraceEvent`, `src/contracts.ts`), `record.sourceEvidence?.trials[].events` (`src/artifacts.ts:27-49` shows the shape), `record.dialogues[].messages` with `role === 'user'`. Owner sources: `record.sources[].content` (`src/report.ts:208` reads `record.sources`).

### `src/render/text.ts` (utility, pure view)

**Analog:** `src/result-view.ts:190-212` (`resultViewLines`): plain lines, one function, counts only from the view:
```ts
export function resultViewLines(view: ResultView, options: { details?: boolean } = {}): string[] {
  const { headline, notMeasured, control, coverage } = view;
  const lines = control.warning ? [control.warning, headline.text] : [headline.text];
  if (headline.smallSample) lines.push(headline.smallSample);
```
- Row sources (all verbatim, never re-worded):
  - `view.headline.text`, `view.headline.smallSample` (src/result-view.ts:76, :128-132);
  - the not-measured row and the control row: rows of `resultViewRows(view)` `[plan 02-04]` whose text starts with `Не измерено: ` / `Контроль:` (today `controlLine` is private at :173 and prints `Контроль: …`; the control *warning* row starts with `Контроль не пройден —`/`Контроль не измерен —` and has no colon after «Контроль», so the prefix test cannot pick it);
  - the agreement row: role `agreement` (tail rows `agreement-tail`) `[plan 03-06]`, text from `[plan 03-01]`;
  - V1: `verdictLine(view)` and `verdictLevel(view)` from `src/verdict.ts` `[plan 04-01]`;
  - comparison counts: `view.changes` `[plan 04-04]` (`counts`, `basis`, `agentChanged`), K1 text from the `change-summary` row of `compareRows(view)` `[plan 04-04]`;
  - causes: `view.topCauses[] { name; count; example: FailureExplanation }` and `view.failures[]` `[plan 02-04]`.
- `pluralForm` is imported from `./result-view.js` today (:28) and from `../plural.js` after `[plan 02-04]` (re-exported from result-view, so either import keeps working).
- Refusal texts: the active-phase set exists twice today — `src/artifacts.ts:139` (`['preparing', 'evaluating', 'baseline', 'improving', 'control']`) and `extensions/cards.ts:16` (`activePhases`). Use the same five phases.

### `src/render/html.ts` (utility, pure view)

**Analog:** `src/report.ts:166-213` (`htmlReport`): one template string, every value through `escape()`, CSS inline, CSP meta:
```ts
return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${navigationHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
```
- CSS variables and dark-mode block to copy from (:187-188): `:root{color-scheme:light dark;--bg:#f7f8f5;…}` / `@media(prefers-color-scheme:dark){…}`; print block at :190. The manager CSS itself is locked verbatim in `05-UI-SPEC.md` «MANAGER_CSS».
- The manager file has **no** `script-src` and no `<script>` (the audit file keeps its hashed script, :15-16, :185, :212).
- Section/list helper style: `list(values)` at :30 (`<ul>${values.map(v => `<li>${escape(v)}</li>`).join('')}</ul>`).
- Ids only from counters, like `trialId`/`eventId` (:19-20) but never built from record text.
- Failure rows come from `FailureExplanation.rows` `[plan 02-04]` (roles `title | example | expected | said | rule | more | violated | cut | unverified`); disagreement data from `view.agreement.disagreements` `[plan 03-01]` and the `dis-verdicts` rows of `disagreementRows(view)` `[plan 03-03]`; change rows from `compareRows(view)` `[plan 04-04]`.

### `src/render/escape.ts` (moved)

**Analog/source:** `src/report.ts:9-10` (copied above). Move `plain` and `escape` unchanged; `report.ts` imports them back (`import { escape, plain } from './render/escape.js';`). `md` (:11) stays in `report.ts` (only markdown uses it).

### `src/report.ts` (audit banner, MSK time, `doNotForward`)

**Analog:** itself.
- Header line to change (:192):
```ts
<header><span class="brand">AGENT LAB</span><span>${escape(record.createdAt.slice(0, 16).replace('T', ' '))} UTC · …
```
- `<title>` (:186): `<title>Agent Lab · ${escape(title(record))}</title>` → prefix `Не пересылать · `.
- `<main>` opens at :191 (after the skip link); the banner is its first child.
- `--warn` is already declared (:187 light `#a23f25`, :188 dark `#ffa68c`, :190 print `#7a351e`).
- Markdown rows start at :247-248 (`# Agent Lab · …`); the banner line goes before it.
- JSON object is built at :230 (`JSON.stringify({ experiment: …, …evidence, traceJournal, judgeAudits })`); add `doNotForward` as a top-level key there.

### `src/artifacts.ts` (IO: stable names, atomic 0600)

**Analog 1:** itself :146-169 (`exportArtifacts`):
```ts
const exportDir = resolve(directory, 'exports');
await mkdir(exportDir, { recursive: true, mode: 0o700 });
const stem = `${record.id}.${randomUUID().slice(0, 8)}`;
…
for (const [path, content] of files) { await writeFile(path, content, { mode: 0o600, flag: 'wx' }); created.push(path); }
```
- Return keys read by tests and tool payloads: `evidence`, `traceJournal`, `report`, `htmlReport`, `snapshot`, `agent` (test/artifacts.test.ts:47, :63; test/extension.test.ts:470-474, :544, :609-611, :629, :682). Keep them.

**Analog 2 (atomic replace):** `src/store.ts:85-96` (`save`):
```ts
const temporary = `${target}.${randomUUID()}.tmp`;
try {
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(validated, null, 2)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, target);
} finally { await unlink(temporary).catch(() => {}); }
```
Copy this shape for `writeExport(path, content)`.

**Analog 3 (bundle):** itself :126-143 (`evidenceBundle`); :139-141 is the active-run warning the manager file must never print raw.

### `src/store.ts` (`resolveId`)

**Analog:** itself :106-111 (`list` reads the directory and filters names with `idPattern`):
```ts
try { names = await readdir(this.directory); }
catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
const ids = names.filter(n => n.endsWith('.json') && idPattern.test(n.slice(0, -5))).map(n => n.slice(0, -5));
```
- `get(id)` (:97-105) takes only a full id; `path(id)` (:23-26) throws `Invalid experiment ID` on a bad pattern.
- Only file names are read (no parsing), so a prefix lookup stays cheap and lock-free.
- Before adding it, grep `resolveId|resolveRun|findRun|startsWith(` in `src/store.ts`, `src/experiment.ts`, `extensions/agent-lab.ts`: if phase 4 landed a prefix resolver, reuse it instead.

### `src/cli.ts` (`share`, `export --format manager`)

**Analog:** itself.
- Options (:60-69): `id`, `before`, `format` (default `'json'`), `output`, `data-dir` already exist; no new option is needed.
- Help lines (:72-76): one `process.stdout.write` per line; the `export` hint is inside :76.
- Read-only commands take no lock (:109-111): `const store = new ExperimentStore(directory);`.
- `export` today (:112-117):
```ts
if (!['json', 'html', 'markdown'].includes(values.format!)) throw new Error('Формат экспорта: json, html или markdown.');
const bundle = await evidenceBundle(await store.get(values.id), store, values.before);
const content = values.format === 'html' ? htmlReport(bundle) : …;
if (values.output) await writeFile(values.output, content, { mode: 0o600 }); else process.stdout.write(`${content}\n`);
```
- Line sanitizing for stdout: `safeText` / `safeLine` (:24-26).
- `summary` (:90-107) is the model for a read-only command that prints lines from the view.

### `extensions/agent-lab.ts` (Pi command, board actions, clipboard)

**Analog:** itself.
- Default export (:152): `export default function agentLab(pi: ExtensionAPI) {` — Pi calls `factory(load.api)` with one argument (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:462`), so an optional second `deps` parameter is safe.
- Command head (:716-720):
```ts
pi.registerCommand('agent-lab', {
  async handler(args, ctx) {
    if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Human review requires the native Pi terminal. …');
    const startRequest = args.trim() === 'new' || args.trim().startsWith('/') || args.trim().startsWith('~');
```
  `share` is parsed before this guard.
- Notice helper (:737-739): `inform(message, kind)` → `notice = { message: safeText(message), kind }`.
- Board export/open branches (:839-849):
```ts
} else if (action.type === 'export') {
  const artifacts = await exportArtifacts(await evidenceBundle(action.record, lab.store, beforeId), lab.store.directory);
  reportPath = artifacts.htmlReport;
  …
} else if (action.type === 'openReport' && reportPath) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', reportPath] : [reportPath];
  await promisify(execFile)(command, args, { timeout: 10000 });
```
- Finalize writes exports and sets `reportPath` (:835-837).
- Tool payload export sites (`artifacts: await exportArtifacts(...)`): :414, :430, :443, :472, :576, :647, :680 — they keep working with the unchanged return keys.
- Clipboard: `copyToClipboard(text: string): Promise<void>` is a root export (`node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts:30`); `ctx.ui.select/notify/editor` signatures at `dist/core/extensions/types.d.ts:70, :76, :135`.
- `[plan 04-03]` adds `appendVerdict` / entry registration and `[plan 04-05]` reopens on the acting tab in the same loop; re-read the loop before editing.

### `extensions/cards.ts` (`o`, footer prefix, help row)

**Analog:** itself (moves in `[plan 04-02]`; footer tiers and help rows rewritten in `[plan 04-06]`).
- Keys (:383-384): `: key('x') ? 'export'` / `: key('o') && this.options.reportPath ? 'openReport'`.
- Footer prefix (:508): `if (this.options.reportPath && record) footer[0] = \`o Открыть отчёт · ${footer[0]}\`;` (`[plan 04-06]` turns this into the `pickTier` prefix rule).
- Help row (:497): `line('x — экспортировать · c — остановить запуск · Esc — назад · q — закрыть')`.
- `BoardOptions` (:47-62) has `reportPath?: string`; `activePhases` (:16).
- Test pin: `test/cards.test.ts:128-137` asserts `o Открыть отчёт` is absent for a running record.

### `test/redact.test.ts`, `test/share.test.ts`, `test/manager-report.test.ts` (new)

**Analog:** `test/artifacts.test.ts:1-35` (imports from `../src/*.js`, `mkdtemp` + `t.after` cleanup, `ExperimentLab` with the demo runtime) and :144-159 (self-contained HTML assertions):
```ts
assert.doesNotMatch(html, /<iframe|<img|<link|<form|\[/i);
assert.match(html, /default-src 'none'/);
```
- Finished demo record: `test/helpers/demo-record.ts` `demoEvaluateRecord(prefix)` (returns `{ lab, directory, record }`; caller cleans up).
- CLI spawn pattern: the phase-1 spawn test in `test/result-view.test.ts` (spawns `dist/cli.js summary` from the snapshot; `snap-test.sh` runs `npx tsc` first so `dist/` exists there).
- Explanation fixtures with rules and cited replies: `test/explain.test.ts` `[plan 02-04]`; agreement fixtures: `test/agreement.test.ts` `[plan 03-01]`; change fixtures: `test/comparison.test.ts` / `test/result-view.test.ts` `[plan 04-04]`. Copy the minimal builders; do not import across test files.
- Jargon scan helper: `test/helpers/copy-check.ts` `assertPlainCopy` `[plan 03-03]`.

### `test/extension.test.ts` (extend)

**Analog:** itself :20-43 (`registered()` fake `pi`), :369-455 (board journey with `ctx.ui.custom` driving keys). The journey presses `x` at :448 and then reads the first `.html` in `exports/` (:450-452) expecting the audit comparison text `Оценка выросла у 1, снизилась у 0`; with the new `x` select, that test must answer the select and read `<id>.audit.html`.

### `.planning/phases/05-*/verify-share.mjs` (new)

**Analog:** `.planning/phases/01-odno-chestnoe-chislo/verify-stored-runs.mjs`:
```js
// Read-only counts over stored pilot runs through a built dist/. Prints ids and numbers only:
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({ options: { dist: { type: 'string', default: resolve(repo, 'dist') }, data: { type: 'string', default: resolve(repo, '.agent-lab') }, … } });
const load = name => import(pathToFileURL(resolve(values.dist, name)).href);
…
console.log(`${id.slice(0, 8)} cards=${view.cards.length} passed=${view.headline.passed} decided=${view.headline.decided} …`);
process.exitCode = mismatch ? 1 : 0;
```
- Temp-copy pattern for marks: `[plan 03-07]` `agreement-check.mts` steps 1-2 and 9 (sha256 of originals, `process.umask(0o077)`, `mkdtemp`, 0700/0600 copies, `rm -rf` in `finally`).
- Run it through `npx tsx` from a `snap-test.sh --keep` snapshot so it can import `test/helpers/customer-leaks.ts` from the same root (the `[plan 03-07]` check runs the same way).
- Snapshot runner: `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh` (`--keep` prints `SNAP=<dir>` as the last line; with test paths it runs `npx tsc && npx tsx --test …`).

### `dist/` swap (not tracked)

**Analog:** `01-10-PLAN.md` Task 1 step 4 and `[plan 03-07]` Task 2 step 2: `snap-test.sh --full --keep` → `SNAP=`; re-check `pgrep -fl 'dist/bundle/cli.js|pi-coding-agent|extensions/agent-lab.ts'` (empty) and `test ! -e .agent-lab/.lock`; copy `$SNAP/dist` to `.gsd/dist-stage-<ts>`; move `dist` to `.gsd/dist-before-05-<ts>` (kept); move the stage to `dist`; `rm -rf "$SNAP"`. `.gsd/` is git-ignored; openrsync has no `--delay-updates`, so rename.

## Shared Patterns

### Pure view, escape at the boundary
**Source:** `src/result-view.ts:5-11`; `src/report.ts:14, :166`.
**Apply to:** `src/redact.ts`, `src/render/text.ts`, `src/render/html.ts`. Text functions return raw strings; only `html.ts` escapes, and only right before a value enters the template.

### Russian user errors as plain `Error`
**Source:** `src/cli.ts:91, :113-114` (`throw new Error('Укажите --id RUN')`).
**Apply to:** refusals N6/N7, resolver N5a/N5b, unknown format.

### Files with bank data
**Source:** `src/artifacts.ts:148` (`mkdir … mode: 0o700`), `src/store.ts:85-96` (0600 + rename).
**Apply to:** every file written by phase 5 (`<id>.summary.txt`, `<id>.manager.html`, `<id>.audit.*`, verification outputs under `$HOME/agent-lab-evidence/phase-05`).

### Only ids and counts leave a stored-run script
**Source:** `verify-stored-runs.mjs:2-3`.
**Apply to:** `verify-share.mjs` (prints `id8`, byte counts, match counts, booleans).

## No Analog Found

| File / step | Role | Data Flow | Reason |
|---|---|---|---|
| headless Chromium print/screenshot inside `verify-share.mjs` | script step | batch | The repo has no browser check; use the exact command in 05-RESEARCH «Headless open/print check» (binary `~/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`, present on 2026-09-17) |

## Metadata

**Analog search scope:** `src/`, `extensions/`, `test/`, `.planning/phases/01-*`, `.planning/phases/02-*`…`04-*` PLAN files.
**Files scanned:** 14 source/test files, 22 plan files.
**Pattern extraction date:** 2026-09-17
